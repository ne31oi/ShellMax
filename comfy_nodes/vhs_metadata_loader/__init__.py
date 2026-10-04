"""
VHS_LoadVideoFromFilenames
---------------------------
Кастомная нода для ComfyUI.

Принимает на вход именно выход "Filenames" (тип VHS_FILENAMES) из ноды
"VHS Video Combine" (а не строку), находит по нему путь к реально
сохранённому видеофайлу и:

  1) показывает превью видео (как это делает сам VHS Video Combine);
  2) декодирует кадры видео -> IMAGE;
  3) достаёт звуковую дорожку -> AUDIO (формат ядра ComfyUI:
     {"waveform": Tensor[1,C,N], "sample_rate": int});
  4) собирает VHS_VIDEOINFO (как в VHS Load Video);
  5) читает метаданные контейнера через ffprobe (то, что VHS пишет в
     сам видеофайл через -metadata comment=..., а не в кадры/пиксели)
     и отдаёт их отдельной строкой STRING (сырой JSON + попытка
     распарсить comment/workflow, если они там есть).

Зависимости: opencv-python (cv2), numpy, torch, torchaudio, ffmpeg/ffprobe
в PATH (обычно уже есть, т.к. от них зависит сам VHS).

Положите этот файл в ComfyUI/custom_nodes/ (в отдельную папку, например
custom_nodes/vhs_metadata_loader/__init__.py) и перезапустите ComfyUI.
"""

import os
import io
import json
import re
import subprocess
import tempfile
import wave

import numpy as np
import torch

import folder_paths

try:
    import cv2
except ImportError as e:
    raise ImportError(
        "Нужен opencv-python: pip install opencv-python"
    ) from e

try:
    import torchaudio
except ImportError:
    torchaudio = None  # аудио тогда будет пустым, с предупреждением


import shutil


def _get_ffmpeg_exe():
    """Путь к исполняемому ffmpeg. На типичной портативной Windows-сборке
    ComfyUI отдельного 'ffmpeg' в системном PATH обычно НЕТ — сама VHS
    использует бинарник из пакета imageio-ffmpeg (тот же, что уже стоит
    как зависимость ComfyUI). Берём его же, а не полагаемся на PATH."""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception as e:
        print(f"[vhs_metadata_loader] imageio_ffmpeg недоступен ({e}), "
              f"пробую 'ffmpeg' из PATH")
    found = shutil.which("ffmpeg")
    return found or "ffmpeg"


def _get_ffprobe_exe():
    """ffprobe в imageio-ffmpeg НЕ поставляется (там только ffmpeg).
    Пробуем: 1) 'ffprobe' в PATH, 2) ffprobe рядом с найденным ffmpeg
    (в некоторых сборках лежит там же). Если не нашли — None, тогда
    метаданные контейнера читаем упрощённо через 'ffmpeg -i' (см. ниже)."""
    found = shutil.which("ffprobe")
    if found:
        return found
    ffmpeg_exe = _get_ffmpeg_exe()
    if ffmpeg_exe and os.path.isfile(ffmpeg_exe):
        names = ("ffprobe.exe", "ffprobe") if os.name == "nt" else ("ffprobe",)
        for name in names:
            candidate = os.path.join(os.path.dirname(ffmpeg_exe), name)
            if os.path.isfile(candidate):
                return candidate
    return None


FFMPEG_EXE = _get_ffmpeg_exe()
FFPROBE_EXE = _get_ffprobe_exe()
print(f"[vhs_metadata_loader] ffmpeg: {FFMPEG_EXE}")
print(f"[vhs_metadata_loader] ffprobe: {FFPROBE_EXE or 'не найден — метаданные будут читаться упрощённо через ffmpeg -i'}")


from dataclasses import dataclass


@dataclass
class ImageSaverMetadata:
    """Точная копия полей датакласса Metadata из alexopus/ComfyUI-Image-Saver
    (nodes.py). Тип сокета совпадает по ИМЕНИ ("METADATA"), поэтому для
    подключения в графе достаточно, чтобы наш выход был объявлен тем же
    именем типа — а для работы принимающей ноды достаточно, чтобы у
    объекта были те же имена полей (Python duck typing)."""
    modelname: str = ""
    positive: str = "unknown"
    negative: str = "unknown"
    width: int = 512
    height: int = 512
    seed: int = 0
    steps: int = 20
    cfg: float = 7.0
    sampler_name: str = ""
    scheduler_name: str = "normal"
    denoise: float = 1.0
    clip_skip: int = 0
    custom: str = ""
    additional_hashes: str = ""
    ckpt_path: str = ""
    a111_params: str = ""
    final_hashes: str = ""


_A1111_FIELD_RE = re.compile(
    r"Steps:\s*(?P<steps>\d+),\s*Sampler:\s*(?P<sampler>[^,]+),\s*"
    r"CFG scale:\s*(?P<cfg>[\d.]+),\s*Seed:\s*(?P<seed>\d+),\s*"
    r"Size:\s*(?P<width>\d+)x(?P<height>\d+)"
    r"(?:.*?Model:\s*(?P<model>[^,]+))?",
    re.IGNORECASE | re.DOTALL,
)


def _find_a1111_tag_text(metadata):
    """Ищет среди тегов контейнера строку в стиле A1111/Civitai
    ("Steps: .., Sampler: .., CFG scale: .., Seed: .., Size: ..x..") —
    именно так ComfyUI-Image-Saver кладёт a111_params в PNG/видео."""
    candidates = []
    tags = metadata.get("tags", {}) or {}
    candidates.extend(tags.items())
    for st in (metadata.get("stream_tags", {}) or {}).values():
        candidates.extend(st.items())

    for _, value in candidates:
        if isinstance(value, str) and "Steps:" in value and "Seed:" in value:
            return value
    return ""


def _build_image_saver_metadata(metadata):
    """Собирает ImageSaverMetadata (тип METADATA) из того, что удалось
    прочитать в контейнере видео. Если находит a1111-style строку (как
    пишет сам ComfyUI-Image-Saver) — разбирает её на поля; иначе отдаёт
    объект с дефолтами и пустым a111_params."""
    a111_text = _find_a1111_tag_text(metadata)
    obj = ImageSaverMetadata()
    if not a111_text:
        return obj

    obj.a111_params = a111_text

    # "positive\nNegative prompt: negative\nSteps: ..." — формат A1111
    if "\nNegative prompt:" in a111_text:
        positive, rest = a111_text.split("\nNegative prompt:", 1)
    else:
        positive, rest = a111_text, a111_text
    obj.positive = positive.strip()

    m = _A1111_FIELD_RE.search(rest)
    if m:
        neg_part = rest[:m.start()]
        obj.negative = neg_part.strip()
        obj.steps = int(m.group("steps"))
        obj.sampler_name = m.group("sampler").strip()
        obj.cfg = float(m.group("cfg"))
        obj.seed = int(m.group("seed"))
        obj.width = int(m.group("width"))
        obj.height = int(m.group("height"))
        if m.group("model"):
            obj.modelname = m.group("model").strip()

    return obj


class _AnyType(str):
    """Тип-джокер: в редакторе ComfyUI совместим с ЛЮБЫМ входным сокетом,
    независимо от его объявленного типа. Оставлен на случай, если нужно
    подключить metadata_json к чему-то с ещё одним незнакомым типом."""
    def __ne__(self, __value: object) -> bool:
        return False


ANY_TYPE = _AnyType("*")


VIDEO_EXTENSIONS = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".gif")

FORMAT_BY_EXT = {
    ".mp4": "video/h264-mp4",
    ".mov": "video/h264-mp4",
    ".mkv": "video/h264-mkv",
    ".webm": "video/vp9-webm",
    ".avi": "video/h264-mp4",
    ".gif": "image/gif",
}


def _list_input_videos():
    """Список видеофайлов в ComfyUI/input (и на 1 уровень во вложенных
    папках, путь в формате 'подпапка/файл.mp4') — для выпадающего списка
    виджета video, как у штатной VHS Load Video."""
    input_dir = folder_paths.get_input_directory()
    result = []
    if os.path.isdir(input_dir):
        for root, _dirs, files in os.walk(input_dir):
            for f in files:
                if f.lower().endswith(VIDEO_EXTENSIONS):
                    rel = os.path.relpath(os.path.join(root, f), input_dir)
                    result.append(rel.replace(os.sep, "/"))
    result.sort()
    return result if result else [""]


def _resolve_video_path(filenames, video):
    """Определяет путь к видео: если подключён линк filenames
    (VHS_FILENAMES) — используем его (приоритет), иначе берём файл,
    выбранный/загруженный в виджете video (из папки input)."""
    if filenames is not None:
        return _extract_video_path(filenames)

    if not video or not video.strip():
        raise ValueError(
            "Не выбрано видео: подключите filenames (VHS_FILENAMES) "
            "или выберите/загрузите файл в поле video"
        )

    path = folder_paths.get_annotated_filepath(video)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Файл видео не найден: {path}")
    return path


def _extract_video_path(vhs_filenames):
    """
    VHS_FILENAMES = (save_output: bool, [str, str, ...])
    Берём последний путь, который похож на видеофайл (у VHS Combine
    в этом списке иногда лежат ещё и промежуточные файлы).
    """
    if not isinstance(vhs_filenames, (tuple, list)) or len(vhs_filenames) < 2:
        raise ValueError(
            "Ожидался выход типа VHS_FILENAMES (bool, [пути]) из ноды "
            "VHS Video Combine, получено: %r" % (vhs_filenames,)
        )

    paths = vhs_filenames[1]
    if not paths:
        raise ValueError("VHS_FILENAMES пришёл с пустым списком путей")

    candidates = [p for p in paths if p.lower().endswith(VIDEO_EXTENSIONS)]
    chosen = candidates[-1] if candidates else paths[-1]

    if not os.path.isfile(chosen):
        raise FileNotFoundError(f"Файл видео не найден по пути: {chosen}")

    return chosen


def _preview_payload(path):
    """Формируем ui-превью в том же формате, что использует сам VHS
    Video Combine (ключ 'gifs'), чтобы его же JS-виджет отрисовал плеер."""
    output_dir = folder_paths.get_output_directory()
    temp_dir = folder_paths.get_temp_directory()
    input_dir = folder_paths.get_input_directory()

    abspath = os.path.abspath(path)
    if abspath.startswith(os.path.abspath(output_dir)):
        base_dir, file_type = output_dir, "output"
    elif abspath.startswith(os.path.abspath(temp_dir)):
        base_dir, file_type = temp_dir, "temp"
    elif abspath.startswith(os.path.abspath(input_dir)):
        base_dir, file_type = input_dir, "input"
    else:
        base_dir, file_type = os.path.dirname(abspath), "output"

    subfolder = os.path.relpath(os.path.dirname(abspath), base_dir)
    if subfolder in (".", ""):
        subfolder = ""

    ext = os.path.splitext(path)[1].lower()
    return {
        "filename": os.path.basename(path),
        "subfolder": subfolder,
        "type": file_type,
        "format": FORMAT_BY_EXT.get(ext, "video/h264-mp4"),
    }


def _parse_ffmetadata(text):
    """Разбирает вывод 'ffmpeg -i IN -f ffmetadata -'
    (спецификация: https://ffmpeg.org/ffmpeg-formats.html#Metadata-1).
    В этом формате символы '\\', '=', ';', '#' и перенос строки внутри
    значения экранированы бэкслешем — поэтому разбираем посимвольно, а
    не построчно (иначе многострочные значения, например comment у
    ComfyUI-Image-Saver с 'Negative prompt: ...\\nSteps: ...', ломаются:
    так был устроен старый парсер человекочитаемого вывода 'ffmpeg -i',
    и именно поэтому такие теги выглядели "нечитаемыми"). Секции
    [STREAM]/[CHAPTER] идут в порядке следования потоков в файле."""
    logical_lines = []
    buf = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\" and i + 1 < n:
            buf.append(text[i + 1])  # экранированный символ (в т.ч. настоящий \n) — часть значения
            i += 2
            continue
        if c == "\n":
            logical_lines.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    if buf:
        logical_lines.append("".join(buf))

    global_tags = {}
    stream_tags_list = []
    current = global_tags
    for line in logical_lines:
        if not line or line.startswith(";") or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = {}
            if line[1:-1].upper() == "STREAM":
                stream_tags_list.append(current)
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            current[key] = value

    return global_tags, stream_tags_list


def _read_ffprobe_metadata(path):
    """Читаем метаданные КОНТЕЙНЕРА видео (format.tags), включая то, что
    сторонние ноды пишут через -metadata comment=/workflow=/prompt=...
    Предпочитаем ffprobe (структурированный JSON); если он не найден —
    используем сам ffmpeg с выходным муксером 'ffmetadata' (это НЕ
    человекочитаемый баннер 'ffmpeg -i', а машиночитаемый формат с
    корректным экранированием — надёжен для многострочных значений)."""
    tags, streams, stream_tags, raw_format = {}, [], {}, {}

    if FFPROBE_EXE:
        try:
            proc = subprocess.run(
                [
                    FFPROBE_EXE, "-v", "quiet",
                    "-print_format", "json",
                    "-show_format", "-show_streams",
                    path,
                ],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
            if proc.returncode != 0:
                print(f"[vhs_metadata_loader] ffprobe вернул код {proc.returncode} "
                      f"для {path}: {proc.stderr[:2000]}")
            else:
                raw = json.loads(proc.stdout)
                raw_format = raw.get("format", {})
                tags = raw_format.get("tags", {}) or {}
                streams = raw.get("streams", []) or []
                for i, s in enumerate(streams):
                    st = s.get("tags") or {}
                    if st:
                        stream_tags[f"stream_{i}"] = st
        except Exception as e:
            print(f"[vhs_metadata_loader] Ошибка запуска ffprobe для {path}: {e}")

    if not tags and not stream_tags:
        # ffprobe не нашли/не сработал — читаем метаданные через сам
        # ffmpeg в машиночитаемом формате ffmetadata (см. докстринг выше).
        try:
            proc = subprocess.run(
                [FFMPEG_EXE, "-y", "-i", path, "-f", "ffmetadata", "-"],
                capture_output=True, timeout=30,
            )
            stdout_text = proc.stdout.decode("utf-8", errors="replace")
            if proc.returncode != 0 or not stdout_text.strip():
                stderr_text = proc.stderr.decode(errors="ignore")
                print(f"[vhs_metadata_loader] ffmpeg -f ffmetadata вернул код "
                      f"{proc.returncode} для {path}: {stderr_text[-1500:]}")
            else:
                tags, stream_list = _parse_ffmetadata(stdout_text)
                stream_tags = {f"stream_{i}": st for i, st in enumerate(stream_list) if st}
                if not tags and not stream_tags:
                    print(f"[vhs_metadata_loader] Тегов метаданных в {path} не найдено")
        except Exception as e:
            print(f"[vhs_metadata_loader] Ошибка запуска ffmpeg -f ffmetadata для {path}: {e}")

    # Мы не знаем заранее точное имя тега, в который конкретная нода
    # ("Add Metadata to Video") пишет workflow/prompt, поэтому пытаемся
    # распарсить как JSON КАЖДЫЙ тег (и format, и streams) — что бы ни
    # распарсилось, кладём в parsed под тем же ключом. Это устойчиво
    # к любому имени тега (comment, workflow, comfy_workflow и т.п.).
    parsed_extra = {}

    def _try_parse_all(tag_dict, prefix=""):
        for key, value in tag_dict.items():
            if not isinstance(value, str):
                continue
            try:
                parsed_extra[prefix + key] = json.loads(value)
            except Exception:
                pass  # не JSON — оставляем как есть, значение уже есть в tags/stream_tags

    _try_parse_all(tags)
    for sname, st in stream_tags.items():
        _try_parse_all(st, prefix=f"{sname}.")

    result = {
        "format": raw_format,
        "streams": streams,
        "tags": tags,
        "stream_tags": stream_tags,
        "parsed": parsed_extra,  # теги, чьё значение успешно распарсилось как JSON
    }
    return result


def _extract_audio(path, duration_hint=0.0):
    """Достаём аудиодорожку в формат ядра ComfyUI: dict(waveform, sample_rate).
    Если аудиопотока действительно нет (или torchaudio недоступен) — НЕ
    отдаём тензор нулевой длины (некоторые ноды вроде VAEEncodeAudio
    падают на форме [*, *, 0]), а генерируем тишину длиной с видео
    (duration_hint), минимум 1 секунда."""
    sample_rate = 44100
    silence_len = max(int(round((duration_hint or 0.0) * sample_rate)), sample_rate)  # мин. 1 сек
    silent = {"waveform": torch.zeros((1, 1, silence_len)), "sample_rate": sample_rate}

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = os.path.join(tmp, "audio.wav")
        try:
            proc = subprocess.run(
                [FFMPEG_EXE, "-y", "-i", path, "-vn",
                 "-acodec", "pcm_s16le", "-ar", str(sample_rate), wav_path],
                capture_output=True, timeout=60,
            )
            if proc.returncode != 0 or not os.path.isfile(wav_path):
                stderr_text = proc.stderr.decode(errors="ignore") if isinstance(proc.stderr, bytes) else str(proc.stderr)
                print(f"[vhs_metadata_loader] Извлечь аудио из {path} не удалось "
                      f"(ffmpeg={FFMPEG_EXE}, код={proc.returncode}): {stderr_text[-1500:]}")
                return silent
            # ffmpeg produces PCM16 WAV; read it directly because torchaudio 2.9
            # requires a separate TorchCodec binary even for this basic format.
            with wave.open(wav_path, "rb") as wav:
                sr = wav.getframerate()
                channels = wav.getnchannels()
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").copy()
            waveform = torch.from_numpy(samples.reshape(-1, channels).T).float() / 32768.0
            if waveform.numel() == 0:
                print(f"[vhs_metadata_loader] ffmpeg отдал пустой аудиофайл для {path}")
                return silent  # на всякий случай — файл открылся, но пустой
            return {"waveform": waveform.unsqueeze(0), "sample_rate": sr}
        except FileNotFoundError as e:
            print(f"[vhs_metadata_loader] ffmpeg не найден ({FFMPEG_EXE}): {e}")
            return silent
        except Exception as e:
            print(f"[vhs_metadata_loader] Ошибка извлечения аудио из {path}: {e}")
            return silent


def _load_frames(path, force_rate=0, frame_load_cap=0, skip_first_frames=0):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise ValueError(f"Не удалось открыть видео: {path}")

    source_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    source_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    source_duration = (source_frame_count / source_fps) if source_fps else 0.0

    target_fps = force_rate if force_rate and force_rate > 0 else source_fps

    frames = []
    idx = 0
    kept = 0
    next_keep_at = 0.0
    step = (source_fps / target_fps) if target_fps else 1.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx < skip_first_frames:
            idx += 1
            continue

        keep = True
        if target_fps and source_fps and abs(target_fps - source_fps) > 1e-3:
            keep = idx >= next_keep_at
            if keep:
                next_keep_at += step

        if keep:
            frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frames.append(frame.astype(np.float32) / 255.0)
            kept += 1
            if frame_load_cap and kept >= frame_load_cap:
                break
        idx += 1

    cap.release()

    if not frames:
        raise ValueError("Не удалось прочитать ни одного кадра из видео")

    images = torch.from_numpy(np.stack(frames, axis=0))

    loaded_fps = target_fps or source_fps
    loaded_frame_count = len(frames)
    loaded_duration = (loaded_frame_count / loaded_fps) if loaded_fps else 0.0

    video_info = {
        "source_fps": source_fps,
        "source_frame_count": source_frame_count,
        "source_duration": source_duration,
        "source_width": width,
        "source_height": height,
        "loaded_fps": loaded_fps,
        "loaded_frame_count": loaded_frame_count,
        "loaded_duration": loaded_duration,
        "loaded_width": width,
        "loaded_height": height,
    }
    return images, video_info


def _find_tag_raw(metadata, name):
    """Ищет тег по имени (без учёта регистра) сначала в format.tags, потом
    в тегах каждого потока, и возвращает его СЫРОЕ строковое значение
    (как оно лежит в контейнере) — то есть готовую JSON-строку, если это
    workflow/prompt. Пустая строка, если тег не найден."""
    name_lower = name.lower()

    tags = metadata.get("tags", {}) or {}
    for k, v in tags.items():
        if k.lower() == name_lower:
            return v

    stream_tags = metadata.get("stream_tags", {}) or {}
    for st in stream_tags.values():
        for k, v in st.items():
            if k.lower() == name_lower:
                return v

    return ""


class VHS_LoadVideoFromFilenames:
    """Грузит видео по выходу Filenames из VHS Video Combine: кадры, аудио,
    video_info и метаданные, зашитые в сам видеофайл (не в кадры)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": (_list_input_videos(), {"video_upload": True}),
            },
            "optional": {
                # Альтернативный источник: подключить по линку VHS_FILENAMES
                # (например, прямо с выхода VHS Video Combine). Если линк
                # подключён — он имеет приоритет над виджетом video.
                "filenames": ("VHS_FILENAMES",),
                "force_rate": ("INT", {"default": 0, "min": 0, "max": 120, "step": 1}),
                "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
                "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "VHS_VIDEOINFO", "METADATA")
    RETURN_NAMES = ("IMAGE", "audio", "video_info", "metadata")
    FUNCTION = "load_video"
    CATEGORY = "video/VHS-extra"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, video="", filenames=None, **kwargs):
        # Линк с filenames меняется вместе с апстримной нодой — ComfyUI
        # сам отследит изменение по графу. Для виджета video отслеживаем
        # изменение содержимого файла по mtime+размеру (чтобы повторная
        # загрузка файла с тем же именем не бралась из кэша).
        if filenames is not None:
            return float("nan")
        if not video:
            return ""
        try:
            path = folder_paths.get_annotated_filepath(video)
            st = os.stat(path)
            return f"{path}:{st.st_mtime_ns}:{st.st_size}"
        except OSError:
            return ""

    @classmethod
    def VALIDATE_INPUTS(cls, video="", filenames=None, **kwargs):
        if filenames is not None:
            return True
        if not video or not video.strip():
            return "Выберите видео (video) или подключите filenames"
        try:
            path = folder_paths.get_annotated_filepath(video)
        except Exception as e:
            return f"Некорректный путь video: {e}"
        if not os.path.isfile(path):
            return f"Файл не найден: {path}"
        return True

    def load_video(self, video="", filenames=None, force_rate=0, frame_load_cap=0, skip_first_frames=0):
        path = _resolve_video_path(filenames, video)

        images, video_info = _load_frames(
            path,
            force_rate=force_rate,
            frame_load_cap=frame_load_cap,
            skip_first_frames=skip_first_frames,
        )
        audio = _extract_audio(path, duration_hint=video_info.get("source_duration", 0.0))
        metadata = _read_ffprobe_metadata(path)

        # 4-й выход: тип "METADATA" — тот же тип сокета, что у
        # Image Saver Metadata / Image Saver Video Metadata (ComfyUI-Image-Saver).
        # Разбираем a1111-style строку из тегов контейнера в объект с теми
        # же полями, что и их датакласс Metadata.
        image_saver_metadata = _build_image_saver_metadata(metadata)

        preview = _preview_payload(path)

        return {
            "ui": {"gifs": [preview], "video_info": [video_info]},
            "result": (images, audio, video_info, image_saver_metadata),
        }


class VHS_InsertMetadataToVideo:
    """Записывает workflow/prompt (и произвольные доп. теги) в контейнер
    ЦЕЛЕВОГО видеофайла — тем же способом, каким это делает сама ComfyUI /
    ComfyUI-Video-Saver для MP4/WebM: теги контейнера "workflow" и "prompt".

    Поток копируется без перекодирования (-c copy), метаданные добавляются
    отдельным быстрым проходом ffmpeg."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filenames": ("VHS_FILENAMES",),
            },
            "optional": {
                "workflow_json": ("STRING", {"default": "", "multiline": True}),
                "prompt_json": ("STRING", {"default": "", "multiline": True}),
                "extra_metadata_json": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": 'Доп. теги в виде JSON-объекта, напр. {"comment": "hello"}',
                }),
                "overwrite_original": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("VHS_FILENAMES", "STRING")
    RETURN_NAMES = ("filenames", "video_path")
    FUNCTION = "insert_metadata"
    CATEGORY = "video/VHS-extra"
    OUTPUT_NODE = True

    def insert_metadata(self, filenames, workflow_json="", prompt_json="",
                         extra_metadata_json="", overwrite_original=True):
        src_path = _extract_video_path(filenames)

        metadata_args = []
        if workflow_json.strip():
            metadata_args += ["-metadata", f"workflow={workflow_json}"]
        if prompt_json.strip():
            metadata_args += ["-metadata", f"prompt={prompt_json}"]
        if extra_metadata_json.strip():
            try:
                extra = json.loads(extra_metadata_json)
            except Exception as e:
                raise ValueError(f"extra_metadata_json не является корректным JSON: {e}")
            for k, v in extra.items():
                val = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                metadata_args += ["-metadata", f"{k}={val}"]

        if not metadata_args:
            raise ValueError(
                "Нечего вставлять: заполните workflow_json, prompt_json "
                "или extra_metadata_json"
            )

        ext = os.path.splitext(src_path)[1].lower()
        tmp_out = src_path + ".tmp_meta" + ext

        # Container graphs can exceed Windows' command-line limit. Transfer tags
        # through UTF-8 ffmetadata, retaining existing tags and source chapters.
        tags = dict(_read_ffprobe_metadata(src_path).get("tags", {}))
        for index in range(1, len(metadata_args), 2):
            key, value = metadata_args[index].split("=", 1)
            tags[key] = value

        def escape(value):
            return str(value).replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\r\n", "\n").replace("\n", "\\\n")

        cmd = [FFMPEG_EXE, "-y", "-i", src_path]
        # mp4/mov (muxer mov,mp4,m4a,3gp,3g2,mj2) молча отбрасывает
        # нестандартные ключи метаданных без этого флага.
        if ext in (".mp4", ".mov", ".m4v", ".3gp"):
            output_flags = ["-movflags", "use_metadata_tags"]
        else:
            output_flags = []
        with tempfile.TemporaryDirectory(prefix="shellmax_metadata_") as temp_dir:
            metadata_path = os.path.join(temp_dir, "tags.ffmeta")
            with open(metadata_path, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(";FFMETADATA1\n")
                for key, value in tags.items():
                    stream.write(f"{escape(key)}={escape(value)}\n")
            cmd += ["-f", "ffmetadata", "-i", metadata_path, "-map", "0", "-map_metadata", "1",
                    "-map_chapters", "0", "-c", "copy", *output_flags, tmp_out]
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        if proc.returncode != 0 or not os.path.isfile(tmp_out):
            raise RuntimeError(f"ffmpeg не смог записать метаданные: {proc.stderr[:800]}")

        if overwrite_original:
            os.replace(tmp_out, src_path)
            final_path = src_path
        else:
            base, orig_ext = os.path.splitext(src_path)
            final_path = f"{base}_meta{orig_ext}"
            os.replace(tmp_out, final_path)

        preview = _preview_payload(final_path)
        return {
            "ui": {"gifs": [preview]},
            "result": ((True, [final_path]), final_path),
        }


NODE_CLASS_MAPPINGS = {
    "VHS_LoadVideoFromFilenames": VHS_LoadVideoFromFilenames,
    "VHS_InsertMetadataToVideo": VHS_InsertMetadataToVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VHS_LoadVideoFromFilenames": "Load Video (from VHS Filenames) + Metadata",
    "VHS_InsertMetadataToVideo": "Insert Metadata Into Video",
}

# Папка web/ рядом с этим файлом содержит JS-расширение, добавляющее
# кнопку "choose video to upload" у виджета video (как в VHS Load Video).
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
