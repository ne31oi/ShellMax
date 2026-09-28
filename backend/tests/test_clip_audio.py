"""Real DSP over complete files; ASR fixtures isolate music timing from model downloads."""

import threading
import wave
from types import SimpleNamespace

import numpy as np
import pytest

from app.media import clip_audio


def audio_file(path, duration):
    sr = 22050
    t = np.arange(round(sr * duration)) / sr
    # Tempo changes at 250 s; a genuine pause is followed by audible music beyond 480 s.
    phase = np.where(t < 250, t * 1.5, (t - 250) * 2.2)
    envelope = np.exp(-np.mod(phase, 1) * 35)
    sound = np.sin(2 * np.pi * 220 * t) * envelope * 0.5
    sound[(t >= 300) & (t < 302)] = 0
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((sound * 32767).astype("int16").tobytes())


def test_music_analysis_long_file(tmp_path, monkeypatch):
    import faster_whisper
    monkeypatch.setattr(clip_audio.settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(clip_audio, "model_ready", lambda: True)
    calls = []
    class Speech:
        def __init__(self, *args, **kwargs):
            assert kwargs["device"] == "cpu" and kwargs["compute_type"] == "int8"
        def transcribe(self, path, **kwargs):
            calls.append(path)
            assert kwargs["vad_filter"] is False
            return iter([SimpleNamespace(end=2.0, words=[SimpleNamespace(start=1.1, end=1.9, word=" слово", probability=0.4)])]), None
    monkeypatch.setattr(faster_whisper, "WhisperModel", Speech)
    path = tmp_path / "long.wav"
    audio_file(path, 490)
    progress = []
    result = clip_audio.analyze(path, 2, 489, threading.Event(), lambda p, s: progress.append(p))
    assert result["start"] == 2 and result["end"] == 489
    assert result["energy"][-1][0] > 488 and max(result["beats"]) > 480
    assert result["sections"][0]["start"] == 2 and result["sections"][-1]["end"] == 489
    assert result["version"] == clip_audio.VERSION
    assert result["words"][0]["start"] == pytest.approx(3.1)
    assert result["words"][-1]["start"] > 480
    assert result["words"][0]["probability"] < 0.7
    assert result["pauses"]
    count = len(calls)
    assert clip_audio.analyze(path, 2, 489, threading.Event(), lambda *args: None) == result
    assert len(calls) == count
    cancelled = threading.Event(); cancelled.set()
    with pytest.raises(InterruptedError):
        clip_audio.analyze(path, 2, 489, cancelled, lambda *args: None)


def test_silence_has_no_beats_and_range_cache_is_distinct(tmp_path, monkeypatch):
    import faster_whisper
    monkeypatch.setattr(clip_audio.settings, "DATA_DIR", tmp_path)
    monkeypatch.setattr(clip_audio, "model_ready", lambda: True)
    class Speech:
        def __init__(self, *args, **kwargs): pass
        def transcribe(self, *args, **kwargs): return iter([]), None
    monkeypatch.setattr(faster_whisper, "WhisperModel", Speech)
    path = tmp_path / "silence.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
        w.writeframes(bytes(22050 * 4 * 2))
    for start, end in ((0, 4), (1, 3)):
        result = clip_audio.analyze(path, start, end, threading.Event(), lambda *args: None)
        assert result["beats"] == [] and result["words"] == []
        assert result["pauses"] == [[start, end]]
        assert result["sections"][0]["start"] == start
        assert result["sections"][-1]["end"] == end
    assert len(list((tmp_path / "clip_analysis").glob("*.json"))) == 2


def test_singing_keeps_refrains_but_excludes_overlap_and_locks_language():
    calls = []
    class Speech:
        def transcribe(self, audio, **kwargs):
            calls.append(kwargs)
            assert not kwargs["vad_filter"]
            assert kwargs["word_timestamps"]
            words = [SimpleNamespace(start=a, end=b, word=" снова", probability=0.8)
                     for a, b in [(0.1, 0.5), (0.8, 1.4), (5, 6), (12.7, 13.1), (13.2, 13.8)]]
            return iter([SimpleNamespace(words=words)]), SimpleNamespace(language="ru", language_probability=0.99)
    model = Speech()
    audio = np.full(14 * 16000, 0.1, dtype=np.float32)
    words, language = clip_audio._recognize_words(model, audio, 111, 112, 124, None, lambda: None)
    assert language == "ru"
    assert [(w.start, w.end) for w in words] == [(112, 112.4), (116, 117), (123.7, 124)]
    assert len(words) == 3  # Equal lyrics at different times must survive.
    clip_audio._recognize_words(model, audio, 123, 124, 136, language, lambda: None)
    assert calls[0]["language"] is None and calls[1]["language"] == "ru"


def test_music_recognition_does_not_hallucinate_on_digital_silence():
    class Speech:
        def transcribe(self, *args, **kwargs):
            pytest.fail("Digital silence must not reach Whisper")
    assert clip_audio._recognize_words(Speech(), np.zeros(16000), 0, 0, 1, None, lambda: None) == ([], None)


def test_music_recognition_checks_cancellation_while_consuming_segments():
    class Speech:
        def transcribe(self, *args, **kwargs):
            return iter([SimpleNamespace(words=[])]), None
    def cancelled():
        raise InterruptedError()
    with pytest.raises(InterruptedError):
        clip_audio._recognize_words(Speech(), np.ones(16000), 0, 0, 1, None, cancelled)
