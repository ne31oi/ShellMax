"""Local assistant models - mirrors Minimax Studio V6 (src/lib/models-config.ts, llm-sampling.ts).

Default is Ternary Bonsai 2 27B on the PrismML llama.cpp fork (its ternary PQ2_0/PTQ1_0
quants only load there). The same llama-server also runs the studio's alternative
models (Gemma 4 12B, Qwen3.5 9B); the studio runs those through llama-cpp-python -
same files and sampling, one engine here.
"""

from dataclasses import dataclass
from pathlib import Path

from .. import settings

LLM_DIR = settings.ROOT / "llm"
BONSAI_DIR = LLM_DIR / "Bonsai_2_27B"  # studio: <project>/Bonsai_2_27B
MODELS_DIR = LLM_DIR / "models"  # studio: ComfyUI/models/llm/

GB = 1024 ** 3
MB = 1024 ** 2


@dataclass(frozen=True)
class FileDef:
    id: str
    label: str
    url: str
    dest: Path  # file, or directory for zip archives
    size: int
    extract: tuple[str, ...] = ()  # zip: only these members, flattened into dest

    @property
    def is_zip(self) -> bool:
        return bool(self.extract)

    def ready(self) -> bool:
        if self.is_zip:
            return all((self.dest / name).exists() for name in self.extract)
        # studio: a model counts as present above 90% of the expected size
        return self.dest.exists() and self.dest.stat().st_size >= self.size * 0.9


_PRISM = "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a"
_BONSAI_HF = "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main"
_GEMMA_HF = "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main"
_QWEN_HF = "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main"

FILES: dict[str, FileDef] = {f.id: f for f in [
    FileDef("bonsai_engine_bin", "Движок llama-server (PrismML b10709)",
            f"{_PRISM}/llama-prism-b10709-9a9394a-bin-win-cuda-12.4-x64.zip", BONSAI_DIR / "llama.cpp", 242 * MB,
            ("llama-server.exe", "llama-server-impl.dll", "llama-common.dll", "llama.dll", "mtmd.dll", "ggml.dll",
             "ggml-base.dll", "ggml-cpu.dll", "ggml-cuda.dll", "ggml-rpc.dll")),
    FileDef("bonsai_engine_cudart", "Движок — CUDA DLL (cublas/cudart 12.4)",
            f"{_PRISM}/cudart-llama-bin-win-cuda-12.4-x64.zip", BONSAI_DIR / "llama.cpp", 373 * MB,
            ("cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll")),
    FileDef("bonsai_model", "Bonsai 2 27B (PQ2_0, тернарная, vision)",
            f"{_BONSAI_HF}/Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true",
            BONSAI_DIR / "models" / "Ternary-Bonsai-2-27B-PQ2_0.gguf", 7206168928),
    FileDef("bonsai_model_light", "Bonsai 2 27B (PTQ1_0, самая лёгкая)",
            f"{_BONSAI_HF}/Ternary-Bonsai-2-27B-PTQ1_0.gguf?download=true",
            BONSAI_DIR / "models" / "Ternary-Bonsai-2-27B-PTQ1_0.gguf", round(5.95 * GB)),
    FileDef("bonsai_mmproj", "Bonsai 2 27B — зрение (mmproj Q8_0)",
            f"{_BONSAI_HF}/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf?download=true",
            BONSAI_DIR / "models" / "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", 629246976),
    FileDef("gemma_q4", "Gemma 4 12B (Q4_K_M)", f"{_GEMMA_HF}/gemma-4-12b-it-Q4_K_M.gguf?download=true",
            MODELS_DIR / "gemma-4-12b-it-Q4_K_M.gguf", round(7.12 * GB)),
    FileDef("gemma_q3", "Gemma 4 12B (Q3_K_M)", f"{_GEMMA_HF}/gemma-4-12b-it-Q3_K_M.gguf?download=true",
            MODELS_DIR / "gemma-4-12b-it-Q3_K_M.gguf", round(5.6 * GB)),
    FileDef("gemma_q5", "Gemma 4 12B (Q5_K_M)", f"{_GEMMA_HF}/gemma-4-12b-it-Q5_K_M.gguf?download=true",
            MODELS_DIR / "gemma-4-12b-it-Q5_K_M.gguf", round(8.6 * GB)),
    FileDef("gemma_mmproj", "Gemma 4 12B — зрение (mmproj BF16)", f"{_GEMMA_HF}/mmproj-BF16.gguf?download=true",
            MODELS_DIR / "mmproj-BF16.gguf", 175 * MB),
    FileDef("qwen_q4", "Qwen3.5 9B (Q4_K_M)", f"{_QWEN_HF}/Qwen3.5-9B-Q4_K_M.gguf?download=true",
            MODELS_DIR / "qwen3.5-9b" / "Qwen3.5-9B-Q4_K_M.gguf", round(5.68 * GB)),
    FileDef("qwen_mmproj", "Qwen3.5 9B — зрение (mmproj F16)", f"{_QWEN_HF}/mmproj-F16.gguf?download=true",
            MODELS_DIR / "qwen3.5-9b" / "mmproj-F16.gguf", 918 * MB),
]}

ENGINE = ("bonsai_engine_bin", "bonsai_engine_cudart")


@dataclass(frozen=True)
class Sampling:
    temperature: float
    top_p: float
    top_k: int
    min_p: float
    presence_penalty: float
    frequency_penalty: float
    repeat_penalty: float


# studio llm-sampling.ts: instruct profiles, stability over creativity
QWEN_FAMILY = Sampling(0.7, 0.8, 20, 0.0, 1.5, 0.0, 1.0)  # Bonsai and Qwen3.5
GEMMA = Sampling(0.7, 0.95, 64, 0.0, 0.0, 0.0, 1.05)


@dataclass(frozen=True)
class ModelChoice:
    id: str
    label: str
    hint: str
    model: str  # FileDef id
    mmproj: str | None
    sampling: Sampling

    def all_files(self) -> tuple[str, ...]:
        return ENGINE + (self.model,) + ((self.mmproj,) if self.mmproj else ())


CHOICES: dict[str, ModelChoice] = {c.id: c for c in [
    ModelChoice("bonsai", "Bonsai 2 27B", "По умолчанию. Лучшая модель на гигабайт видеопамяти, видит картинки · ~8 ГБ",
                "bonsai_model", "bonsai_mmproj", QWEN_FAMILY),
    ModelChoice("bonsai_light", "Bonsai 2 27B лёгкая", "Квант PTQ1_0 для карт до 8 ГБ · ~6,6 ГБ",
                "bonsai_model_light", "bonsai_mmproj", QWEN_FAMILY),
    ModelChoice("gemma_q4", "Gemma 4 12B (Q4)", "Альтернатива, видит картинки · ~7,3 ГБ", "gemma_q4", "gemma_mmproj", GEMMA),
    ModelChoice("gemma_q3", "Gemma 4 12B (Q3)", "Лёгкая, ~8 ГБ видеопамяти · ~5,8 ГБ", "gemma_q3", "gemma_mmproj", GEMMA),
    ModelChoice("gemma_q5", "Gemma 4 12B (Q5)", "Качество, ~12 ГБ видеопамяти · ~8,8 ГБ", "gemma_q5", "gemma_mmproj", GEMMA),
    ModelChoice("qwen", "Qwen3.5 9B", "Лёгкая по видеопамяти, видит картинки · ~6,6 ГБ", "qwen_q4", "qwen_mmproj", QWEN_FAMILY),
]}
DEFAULT_CHOICE = "bonsai"
