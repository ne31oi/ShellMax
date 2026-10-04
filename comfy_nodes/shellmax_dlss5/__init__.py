"""Bridge a streamed DLSS video path to VHS metadata insertion and ShellMax output."""
import json
import sys
from pathlib import Path


class ShellMaxVideoPathToFilenames:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"video_path": ("STRING", {"forceInput": True}), "source_path": ("STRING",)},
                "hidden": {"prompt": "PROMPT"}}

    RETURN_TYPES = ("VHS_FILENAMES", "STRING", "STRING")
    RETURN_NAMES = ("filenames", "prompt_json", "extra_metadata_json")
    FUNCTION = "convert"
    CATEGORY = "video/ShellMax"

    def convert(self, video_path, source_path, prompt=None):
        path = Path(video_path)
        if not path.is_file():
            raise FileNotFoundError(f"ShellMax: Файл результата DLSS5 не найден: {path}")
        # Reuse the archive's reader so source provenance survives writing the new graph.
        import nodes
        loader = nodes.NODE_CLASS_MAPPINGS["VHS_LoadVideoFromFilenames"]
        metadata_pack = sys.modules[loader.__module__]
        metadata = metadata_pack._read_ffprobe_metadata(source_path)
        extra = {"shellmax_processing": "DLSS5"}
        for key in ("prompt", "workflow"):
            value = metadata_pack._find_tag_raw(metadata, key)
            if value:
                extra[f"shellmax_source_{key}"] = value
        return ((True, [str(path)]), json.dumps(prompt or {}, ensure_ascii=False), json.dumps(extra, ensure_ascii=False))


NODE_CLASS_MAPPINGS = {"ShellMaxVideoPathToFilenames": ShellMaxVideoPathToFilenames}
