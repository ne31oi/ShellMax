# ShellMax

Локальный видеоредактор поверх **собственного** ComfyUI с моделью MiniMax H3. Генерация повторяет воркфлоу
`MiniMax_H3_Singularity_DualSampling_The_AI_Brief_EN` один в один: те же ноды, связи и значения.
Со временем редактор вырастет в полноценный NLE.

## Запуск

```
scripts\start.bat
```

При первом запуске скрипт установит движок, соберёт интерфейс и откроет браузер на `http://127.0.0.1:8710`.

Движок можно установить или обновить отдельно:

```
powershell -ExecutionPolicy Bypass -File scripts\install_comfy.ps1 [-WithDebugNodes]
```

- ComfyUI v0.37.0, пин на коммит `b0f4b7b`, ставится в `comfy\` (portable, отдельно от других установок) и работает на порту 8288.
- Ставятся только нужные пакеты нод, на пиннутых коммитах: KJNodes, VideoHelperSuite, Minimax H3 Latent Upscaler.
- Модели **не копируются**: `extra_model_paths.yaml` указывает на `F:\ComfyUI_LTX\...\models`, а любую модель или LoRA можно задать абсолютным путём.
- `-WithDebugNodes` дополнительно ставит rgthree и Easy-Use, чтобы оригинальный воркфлоу открывался в интерфейсе движка.

## Как устроено

```
frontend/ (React)  ──REST/WS──►  backend/ (FastAPI :8710)  ──REST/WS──►  comfy/ (ComfyUI :8288)
                                   │  workflow/builder.py: параметры → API-граф (ID нод как в оригинале)
                                   │  jobs/queue.py: очередь, прогресс, черновик/финал, ошибки
                                   └  data/: SQLite, медиатека, загрузки
comfy_nodes/shellmax_nodes: загрузчики по абсолютному пути (делегируют стоковым нодам)
```

Отличия графа от оригинала сохраняют значения:

- загрузчики принимают абсолютный путь;
- rgthree Lora Stack заменён цепочкой LoRA-нод;
- easy float встроен в апскейлер;
- Set/Get-ноды развёрнуты в прямые связи.

Тест `backend/tests/test_builder.py` сверяет каждую связь и каждое значение с исходным JSON в `workflows/`.

## Разработка

```
cd backend && uv run pytest               # тесты
cd backend && uv run python -m app.main   # API на :8710
cd frontend && npm run dev                # интерфейс на :5173 с прокси на API
```

Диск F: отформатирован в exFAT: симлинки и junction не работают. Поэтому `shellmax_nodes` копируется в движок
перед каждым его запуском, а фронтенд ставится через npm, а не pnpm.
