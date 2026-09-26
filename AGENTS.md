# AGENTS.md — руководство для ИИ-агентов

ShellMax — локальное веб-приложение (FastAPI + React), которое управляет **собственным** ComfyUI (`comfy/`, порт 8288)
и работает с моделью MiniMax H3. Каждый тип задачи обязан в точности повторять свой воркфлоу:

| Тип задачи (`Generation.kind`) | Воркфлоу | Сборщик графа | Тест сверки |
|---|---|---|---|
| `generate` — генерация видео | `workflows/MiniMax_H3_Singularity_DualSampling_The_AI_Brief_EN.json` | `workflow/builder.py` | `tests/test_builder.py` |
| `face` — улучшение лица на готовом клипе | `workflows/MiniMax_H3_FaceRefine_Best.json` | `workflow/builder_face.py` | `tests/test_builder_face.py` |

- **Сейчас:** готовы этапы 0–2 (движок, бэкенд, студия генерации) и улучшение лица.
- **Следующее:** этап 3 — NLE v1 (дорожки, обрезка, экспорт через ffmpeg).

Пользовательская документация — `README.md`. Язык интерфейса и общения с пользователем — русский.

---

## Инварианты (нарушать нельзя)

1. **Граф = воркфлоу.**
   - Каждый сборщик (`builder.py`, `builder_face.py`) строит API-граф с **теми же ID нод**, что в своём исходном JSON.
   - Допустимые отличия только сохраняющие значения, они перечислены в docstring сборщика.
   - Тесты сверки (`test_builder*.py`) проверяют каждую связь и каждое значение с исходным JSON и обязаны проходить.
   - Новый тип задачи = новый воркфлоу в `workflows/`, свой сборщик и свой тест сверки, `Pipeline` в `jobs/pipelines.py`, этапы в `frontend/src/lib/stages.ts`.
   - Намеренное изменение семантики — только по явной просьбе пользователя: тогда меняются тест и `config/defaults.json`, а в ответе пользователю объясняется, что и почему изменилось.
2. **Значения по умолчанию = значения воркфлоу.**
   - Они живут в `config/defaults.json` (модели, LoRA, пресет «Стандарт» = 0.5 МП × 1.5) и в `ExpertParams` (`params.py`).
   - Пресеты качества задают только `megapixels` и `scale`.
3. **Движок отдельный.**
   - Основная установка пользователя `F:\ComfyUI_LTX\...` — только источник моделей (read-only). Её нельзя изменять или останавливать: её ComfyUI работает на порту 8188.
   - Модели никогда не копируются: только абсолютные пути и `extra_model_paths.yaml`.
4. **UX: минимум настроек на экране.** Пользователь явно этого требует.
   - Панель генерации: референсы, промпт, 4 чипа (формат, длительность, качество, стиль), кнопка. Новые ручки туда не добавлять.
   - Новый параметр размещай по частоте изменения:
     - каждую генерацию — панель;
     - часто — чип;
     - иногда — меню кнопки «Создать»;
     - один раз — Настройки → Движок;
     - почти никогда — «Эксперт».
   - Где есть фиксированный набор вариантов — **выпадающий список** (`Select` из `components/ui.tsx`), а не текстовое поле. Варианты по возможности брать из движка (`/api/engine/options` ← `object_info`). Значение воркфлоу помечать и закреплять наверху.
   - Настройки, которые меняются по контексту, живут на объекте, к которому относятся. Пример: 🔊 на карточке видео-референса.
   - Значения запоминаются (sticky, `store/form.ts` → `/api/state/ui`).
   - Ошибки показываются человеческим текстом плюс действие-исправление (`humanize_error` → `ErrorView`).
   - Настройки сохраняются автоматически, кнопки «Сохранить» нет.
5. **Таймлайн меняется только командами** (`frontend/src/store/timeline.ts`, `commands.*`) — это даёт undo/redo. Модель данных уже рассчитана на NLE: `Project.timeline` → tracks → clips.
6. **Промпт хранится с токенами** `{{ref:<uid>}}` (`lib/refs.ts`). В `<Picture N>` / `<Video N>` / `<Audio N>` он превращается только при отправке (`toModelPrompt`). Нумерация идёт по типу, в порядке карточек, как в ноде 56.

## Карта кода

| Путь | Назначение |
|---|---|
| `scripts/install_comfy.ps1` | Идемпотентная установка движка: portable v0.37.0 → коммит `b0f4b7b`, пины пакетов нод и ускорителей, `extra_model_paths.yaml`, проверка sol-attn и `RequiredClasses` |
| `scripts/start.bat` | Запуск для пользователя: установка, сборка фронта, бэкенд |
| `comfy_nodes/shellmax_nodes/` | Ноды `ShellMax*ByPath`: вызывают стоковые загрузчики, подменяя только `folder_paths.get_full_path*` |
| `comfy_nodes/h3_native_audio_lock/` | Копия локального пакета «замок аудио» (нода 13 FaceRefine). Всё в `comfy_nodes/` копируется в движок перед стартом |
| `config/comfy.json` | Порт, хост, флаги запуска движка, `legacy_models_dir` |
| `config/defaults.json` | Профиль движка по умолчанию, пресеты качества, UI-дефолты, шаблон промпта |
| `backend/app/workflow/params.py` | `UIParams` (решения пользователя) → `EngineProfile` (рецепт) → `FullParams` (всё для графа); формулы кадров и разрешения — порты кода ComfyUI |
| `backend/app/workflow/presets.py` | `expand()`: UI + профиль + пресет + стили → `FullParams` |
| `backend/app/workflow/builder.py` | `FullParams` → API-граф; `STAGE_BY_NODE`, выходные ноды черновика (135) и финала (141) |
| `backend/app/workflow/builder_face.py` | `FaceFullParams` → граф улучшения лица; превью трекинга (26), отчёт трекера (28), финал (23) |
| `backend/app/workflow/face.py` | Улучшение лица: рецепт по умолчанию, шаблон промпта крупного плана, сетка кадров 17k+5, автодетекция лица для рамки `<Picture 2>` (YuNet → haar) |
| `backend/app/jobs/pipelines.py` | Для каждого типа задачи: этапы с весами, нода → этап, выходные ноды, нода отчёта |
| `backend/app/jobs/queue.py` | Очередь (одна задача за раз), WS-события ComfyUI → этапы, шаги, прогресс; сохранение черновика и финала; `humanize_error` |
| `backend/app/comfy/supervisor.py` | Процесс движка: лог в `data/engine.log`, PID в `data/engine.pid`, повторный подхват после рестарта бэкенда |
| `backend/app/comfy/client.py` | REST и WS клиента ComfyUI |
| `backend/app/api.py` | Все HTTP-роуты `/api/*` и WS `/api/ws` |
| `backend/app/services.py` | Бутстрап (проект и профиль при первом запуске), загрузки, создание генераций |
| `backend/app/db/models.py` | SQLModel/SQLite: Project, EngineProfileRow, StyleLora, Upload, MediaAsset, Generation, KV |
| `frontend/src/store/` | zustand: `library` (данные с сервера), `form` (панель генерации, sticky), `ui`, `timeline` (команды) |
| `frontend/src/lib/` | `actions` (общие действия), `live` (WS), `refs` (токены промпта), `stages`, `hotkeys`, `bus` (события между панелями) |
| `frontend/src/components/` | `generate/`, `face/` (диалог улучшения лица, редактор рамки), `library/`, `viewer/`, `timeline/`, `settings/`, `layout/`, `ui.tsx` (примитивы на Radix, в т.ч. `Select`) |

### Поток данных

```
UI (form store) ─POST /api/generations─► services.create_generations
  → presets.expand → FullParams (сохраняется вместе с UIParams)
  → queue: загрузка референсов в input движка → builder.build_prompt → POST /prompt
ComfyUI WS (executing / progress / executed / execution_*) → queue._on_ws
  → Generation (stage, progress) + live-поле step → hub → /api/ws → frontend lib/live.ts → store/library
```

**Этапы синхронизированы в трёх местах.** Меняй вместе:
- `STAGE_BY_NODE` в сборщике (`builder.py` / `builder_face.py`);
- `jobs/pipelines.py` (список и веса этапов для типа задачи);
- `frontend/src/lib/stages.ts` (`STAGES_BY_KIND`).

## Команды

```bash
cd backend  && uv run pytest              # обязательно после любых изменений бэкенда/графа
cd backend  && uv run python -m app.main  # API :8710 (раздаёт frontend/dist, поднимает/подхватывает движок)
cd frontend && npx tsc -p .               # проверка типов (strict, noUnused*)
cd frontend && npm run build              # типы + сборка в dist (бэкенд раздаёт именно её)
cd frontend && npm run dev                # :5173 с прокси /api → :8710
powershell -ExecutionPolicy Bypass -File scripts\install_comfy.ps1   # установка/проверка движка
```

## Подводные камни окружения

**Диск F: отформатирован в exFAT:**
- симлинки и junction не работают, поэтому все пакеты из `comfy_nodes/` **копируются** в движок перед каждым стартом (`sync_shellmax_nodes`) и установщиком;
- pnpm не работает — только **npm**;
- git требует `-c safe.directory=*`.

**Кодировки в Windows:**
- `.ps1` с кириллицей сохранять в **UTF-8 с BOM**, иначе Windows PowerShell 5.1 ломает текст;
- `.bat` — CRLF и `chcp 65001`;
- YAML для ComfyUI — UTF-8 **без** BOM.

**Процесс движка:**
- stdout движка **никогда не направлять в pipe** бэкенда. Когда бэкенд умирает, запись tqdm в закрытый pipe роняет сэмплер с `[Errno 22] Invalid argument`. Вывод идёт только в файл;
- на Windows `os.kill(pid, 0)` **убивает** процесс. Проверять жизнь процесса через `pid_alive` (ctypes), останавливать через `kill_tree` (`taskkill /T /F`).

**Формат ComfyUI API:**
- у Autogrow- и DynamicCombo-входов имена через точку: `ref_images.ref_image_0`, `values.a`, `mode.scale`, `selection.tau`;
- в своих ID нод не использовать `.` и `:` (у нас `118_0`, `ref_image_0`);
- спецификация combo в `object_info` бывает двух видов: `[[...]]` и `["COMBO", {"options": [...]}]` — см. `_combo_options`;
- нода 56 пропускает пустые слоты, поэтому референсы подключаются **подряд** с `_0`.

**Латентный апскейлер** ищет модель только в первой папке `latent_upscale_models` и игнорирует extra paths. `ShellMaxLatentUpscalerByPath` временно подменяет `get_models_dir`.

**Улучшение лица:**
- детекторы ищутся в папке моделей `ultralytics` (ключ в `extra_model_paths.yaml`), имена вида `bbox\face_yolov8m.pt`;
- insightface ищет `buffalo_l` жёстко в `models/insightface` самого движка — установщик копирует его туда;
- у ноды 9 в воркфлоу `ref_image_size = max` (в генерации — `match`); значения width/height/length у неё — устаревшие виджеты, реально входы подключены к выходам трекера;
- кадры клипа должны быть на сетке 17k+5: `face.source_frames` задаёт `frame_load_cap` (и `force_rate=24` для не-24 fps).

**SQLite: миграции только добавлением колонок.** `create_all` не меняет существующие таблицы. Новое поле добавляй в модель **и** в `_ADDED_COLUMNS` (`db/models.py`) — `init_db` сделает `ALTER TABLE`. Для чисто живых данных — поле вне БД (как `step`). Данные пользователя не сбрасывать.

**Порты:**
- 8710 — ShellMax;
- 8288 — наш движок;
- 5173 — Vite dev;
- 8188 — основной ComfyUI пользователя, его не трогать.

**GPU:** 16 ГБ VRAM, модели ~50 ГБ идут через выгрузку в RAM. Не запускать генерации в двух ComfyUI одновременно.

**Реальная генерация** длится ~6 минут (2 с, «Стандарт»), первая дольше из-за загрузки моделей. Повтор с тем же сидом близок (SSIM ≈ 0.96), но не бит-в-бит.

## Добавление пакета нод или новой ноды в граф

1. Пин по коммиту в `$NodePacks` (`install_comfy.ps1`); class_type добавить в `$RequiredClasses`.
2. Узел добавить в `builder.py` с ID из воркфлоу, дефолты — из воркфлоу.
3. Обновить `test_builder.py`: `ID_MAP` / `SUBST` / исключения.
4. Если нода даёт прогресс или является этапом, обновить три места со списком этапов (см. «Поток данных»).

## Стиль кода

- Комментарии и идентификаторы — на английском. Все пользовательские строки UI и ошибок — на русском.
- Python 3.12 (uv), type hints, pydantic v2. TypeScript strict, React 19, zustand, Radix, Tailwind v4. Токены темы — в `frontend/src/index.css` (`@theme`), тёмная тема.
- Запросы к API — только через `frontend/src/api/client.ts`; общие действия пользователя — через `lib/actions.ts`.
- Новые UI-зависимости — только при реальной необходимости. Сначала посмотри `components/ui.tsx`.
- Комментарии объясняют «почему», а не «что».

## Перед тем как сказать «готово»

- [ ] `uv run pytest` зелёный.
- [ ] `npx tsc -p .` без ошибок, `npm run build` проходит (бэкенд раздаёт `dist`: без сборки пользователь не увидит изменений).
- [ ] Изменения UI проверены в запущенном приложении, а не только по типам.
- [ ] Изменения графа, движка или очереди проверены реальной генерацией или хотя бы запуском движка и `/object_info`. Если это не сделано, так и сказать.
- [ ] Если менялся Python, бэкенд перезапущен. Движок перезапускать не нужно, он переживает рестарт.
- [ ] В git не попали `comfy/`, `data/`, `node_modules/`, `.venv/`, `frontend/dist/`. Коммиты — только по просьбе пользователя.
