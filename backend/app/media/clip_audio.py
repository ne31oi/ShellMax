"""CPU-only, cancellable music analysis; all stored times refer to the source file."""

import hashlib
import json
import threading
import uuid
from pathlib import Path

import numpy as np

from .. import settings
from ..clip_schema import AudioAnalysis, Section, Word
from . import library

VERSION = 2
SPEECH_WINDOW = 12.0
SPEECH_CONTEXT = 1.0
MODEL_DIR = settings.ROOT / "llm" / "audio" / "medium"


def model_ready() -> bool:
    return all((MODEL_DIR / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json"))


def download_model() -> None:
    from faster_whisper.utils import download_model as download

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    download("medium", output_dir=str(MODEL_DIR))


def _recognize_words(model, audio: np.ndarray, source_start: float, keep_start: float,
                     keep_end: float, language: str | None, check) -> tuple[list[Word], str | None]:
    # Speech VAD can discard an entire sung track. Only skip actual digital silence;
    # musical gaps still need Whisper's own no-speech decision.
    if np.max(np.abs(audio), initial=0) <= 1e-5:
        return [], language
    segments, info = model.transcribe(audio, word_timestamps=True, condition_on_previous_text=False,
                                      vad_filter=False, beam_size=5, language=language)
    if language is None and info is not None and info.language_probability >= 0.8:
        language = info.language
    words = []
    for segment in segments:
        check()
        for word in segment.words or []:
            a, b = source_start + word.start, source_start + word.end
            # Context is decoded twice, but each word belongs to exactly one time
            # interval. Never deduplicate by text: repeated lyrics are intentional.
            if keep_start <= (a + b) / 2 < keep_end and b > a and word.word.strip():
                words.append(Word(start=max(keep_start, a), end=min(keep_end, b),
                                  word=word.word, probability=word.probability))
    return words, language


def analyze(path: Path, start: float, end: float, cancel: threading.Event, progress) -> dict:
    import librosa
    import subprocess
    import tempfile
    from faster_whisper import WhisperModel

    def check():
        if cancel.is_set():
            raise InterruptedError("Анализ остановлен")

    if not model_ready():
        raise ValueError("Скачайте модель распознавания: Настройки → Ассистент → Анализ аудио")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            check()
            digest.update(chunk)
    fingerprint = digest.hexdigest()
    key = hashlib.sha256(f"{fingerprint}:{start:.9f}:{end:.9f}:{VERSION}".encode()).hexdigest()
    cache = settings.DATA_DIR / "clip_analysis" / f"{key}.json"
    if cache.is_file():
        return AudioAnalysis.model_validate_json(cache.read_text(encoding="utf-8")).model_dump()
    out = AudioAnalysis(version=VERSION, fingerprint=fingerprint, start=start, end=end)
    ffmpeg = library.ffmpeg_bin("ffmpeg")
    if not ffmpeg:
        raise ValueError("Установите ffmpeg и перезапустите ShellMax")
    # Windows remain bounded in memory, but no part of a long track is silently discarded.
    window = 120.0
    feature_rows, feature_times = [], []
    with tempfile.TemporaryDirectory(prefix="clip_audio_", dir=settings.DATA_DIR) as tmp:
        for offset in np.arange(start, end, window):
            check()
            length = min(window, end - offset)
            wav = Path(tmp) / "window.wav"
            subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(path), "-ss", str(offset),
                            "-t", str(length), "-vn", "-ac", "1", "-ar", "22050", str(wav)],
                           check=True, capture_output=True, timeout=180)
            y, sr = librosa.load(wav, sr=22050, mono=True)
            hop = 512
            rms = librosa.feature.rms(y=y, hop_length=hop)[0]
            flux = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
            if np.max(np.abs(y), initial=0) > 0.001:
                _, beat_frames = librosa.beat.beat_track(onset_envelope=flux, sr=sr, hop_length=hop)
                out.beats.extend(float(offset + t) for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop))
            times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop) + offset
            stride = max(1, round(sr / hop / 4))
            out.energy.extend([[round(float(t), 4), round(float(e), 6)] for t, e in zip(times[::stride], rms[::stride]) if t < end])
            out.changes.extend([[round(float(offset + i * hop / sr), 4), round(float(flux[i]), 4)]
                                for i in range(0, len(flux), stride) if offset + i * hop / sr < end])
            chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop)
            mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
            # One descriptor per second is sufficient for section/repetition proposals.
            step = max(1, round(sr / hop))
            for i in range(0, min(chroma.shape[1], mfcc.shape[1]), step):
                t = float(offset + i * hop / sr)
                if t < end:
                    feature_rows.append(np.r_[chroma[:, i:i + step].mean(axis=1), mfcc[:, i:i + step].mean(axis=1)])
                    feature_times.append(t)
            progress(0.4 * (offset + length - start) / (end - start), "Разбираю ритм и структуру")
        check()
        if len(feature_rows) >= 4:
            features = np.asarray(feature_rows).T
            features = (features - features.mean(axis=1, keepdims=True)) / (features.std(axis=1, keepdims=True) + 1e-6)
            k = min(len(feature_rows) // 2, max(1, round((end - start) / 24)))
            bounds = librosa.segment.agglomerative(features, k=k)
            starts = [feature_times[int(i)] for i in bounds]
            for i, (a, b) in enumerate(zip(starts, starts[1:] + [end])):
                out.sections.append(Section(start=a, end=b, label=f"Часть {i + 1}"))
            # Compare sections, not individual frames, to keep memory linear for long tracks.
            vectors = [features[:, (np.asarray(feature_times) >= s.start) & (np.asarray(feature_times) < s.end)].mean(axis=1)
                       for s in out.sections]
            for i, a in enumerate(vectors):
                for j in range(i):
                    b = vectors[j]
                    similarity = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
                    if similarity > 0.8:
                        out.repetitions.append([out.sections[j].start, out.sections[i].start, round(similarity, 3)])
        if not out.sections:
            out.sections = [Section(start=start, end=end, label="Часть 1")]
        pause_start = None
        for t, energy in [*out.energy, [end, 1.0]]:
            if energy < 0.003 and pause_start is None:
                pause_start = t
            elif energy >= 0.003 and pause_start is not None:
                if t - pause_start >= 0.5:
                    out.pauses.append([pause_start, t])
                pause_start = None
        progress(0.45, "Распознаю слова на CPU")
        model = WhisperModel(str(MODEL_DIR), device="cpu", compute_type="int8", cpu_threads=4)
        language = None
        for offset in np.arange(start, end, SPEECH_WINDOW):
            check()
            wav = Path(tmp) / "speech.wav"
            keep_end = min(end, offset + SPEECH_WINDOW)
            source_start = max(start, offset - SPEECH_CONTEXT)
            source_end = min(end, keep_end + SPEECH_CONTEXT)
            subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", str(source_start), "-i", str(path),
                            "-t", str(source_end - source_start), "-vn", "-ac", "1", "-ar", "16000", str(wav)],
                           check=True, capture_output=True, timeout=180)
            audio, _ = librosa.load(wav, sr=16000, mono=True)
            words, language = _recognize_words(model, audio, source_start, offset, keep_end, language, check)
            out.words.extend(words)
            progress(0.45 + 0.5 * (keep_end - start) / (end - start), "Распознаю слова на CPU")
        del model
    check()
    out.lyrics = "".join(w.word for w in out.words).strip()
    out.beats = sorted(set(round(t, 4) for t in out.beats if start <= t < end))
    out.warnings = ["Границы частей и слова предложены автоматически. Проверьте их по треку.",
                    "Таймкоды распознанного пения не являются проверкой липсинка."]
    if not out.words:
        out.warnings.append("Слова не удалось распознать. Это не означает, что вокала нет: можно вставить текст песни вручную.")
    cache.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache.with_suffix(f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(out.model_dump(), ensure_ascii=False), encoding="utf-8")
    temporary.replace(cache)
    return out.model_dump()
