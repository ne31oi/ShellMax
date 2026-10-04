# VHS Metadata Loader / Inserter (custom node for ComfyUI)

В ShellMax пакет адаптирован для текущего движка: чтение PCM WAV через стандартный модуль Python без зависимости от TorchCodec; явная UTF-8 при чтении ffprobe; запись длинных метаданных через временный ffmetadata-файл вместо аргументов командной строки Windows. Видео и звук при записи тегов не перекодируются.

Кастомные ноды для ComfyUI:

1. **Load Video (from VHS Filenames) + Metadata** (`VHS_LoadVideoFromFilenames`)
   Загружает видео двумя способами (что подключено/заполнено — тем и
   пользуется, приоритет у линка `filenames`):
   - **`video`** — выпадающий список файлов из `ComfyUI/input` + кнопка
     "choose video to upload" (как у штатной `VHS Load Video`) — выбор
     или загрузка видео прямо с компьютера;
   - **`filenames`** (опционально, линк `VHS_FILENAMES`) — принимает
     выход `Filenames` из ноды `VHS Video Combine` напрямую.

   Отдаёт:
   - `IMAGE` — кадры видео
   - `audio` — аудиодорожка (формат ядра ComfyUI)
   - `video_info` (`VHS_VIDEOINFO`) — как в VHS Load Video
   - `workflow_json`, `prompt_json` (`STRING`) — метаданные из тегов контейнера
     видео (конвенция ComfyUI для MP4/WebM)
   - `metadata_json` (`STRING`) — полный сырой дамп метаданных (ffprobe)
   - `metadata` (`METADATA`) — совместимо по типу с `Image Saver Metadata` /
     `Image Saver Video Metadata` из пакета `alexopus/ComfyUI-Image-Saver`

2. **Insert Metadata Into Video** (`VHS_InsertMetadataToVideo`)
   Принимает `filenames` (`VHS_FILENAMES`) и `workflow_json`/`prompt_json`/
   `extra_metadata_json`, записывает их в контейнер видеофайла через
   `ffmpeg -c copy` (без перекодирования).

## Установка

1. Распакуйте архив так, чтобы получилась папка
   `ComfyUI/custom_nodes/vhs_metadata_loader/` с файлом `__init__.py` внутри.
   (Просто скопируйте всю папку `vhs_metadata_loader` из архива в
   `ComfyUI/custom_nodes/`.)
2. Установите зависимости:
   ```
   pip install -r ComfyUI/custom_nodes/vhs_metadata_loader/requirements.txt
   ```
   (`torch`/`torchaudio` обычно уже есть в окружении ComfyUI — можно пропустить,
   если ставится конфликтующая версия.)
3. Убедитесь, что `ffmpeg`/`ffprobe` есть в PATH (обычно уже установлены,
   так как от них зависит сам VHS).
4. Перезапустите ComfyUI.

Ноды появятся в категории **video/VHS-extra**.
