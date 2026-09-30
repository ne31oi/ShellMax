"""ShellMax adapters; all encoding, mask math and compositing stay upstream."""

import importlib
import json

import nodes


def upstream(module):
    cls = nodes.NODE_CLASS_MAPPINGS.get("MiniMaxH3FantasticRefModTextEncode")
    if cls is None:
        raise RuntimeError("Установите Fantastic H3 через установщик ShellMax и перезапустите движок")
    package = cls.__module__.rsplit(".", 1)[0]
    return importlib.import_module(package + "." + module)


class ShellMaxH3ReferenceBundle:
    RETURN_TYPES = ("H3_REFS",)
    FUNCTION = "bundle"
    CATEGORY = "ShellMax"

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for stem, count, kind in (("image", 9, "IMAGE"), ("video", 3, "IMAGE"),
                                  ("video_audio", 3, "AUDIO"), ("audio", 3, "AUDIO")):
            optional.update({f"ref_{stem}_{i}": (kind,) for i in range(count)})
        return {"required": {}, "optional": optional}

    def bundle(self, **kwargs):
        values = lambda stem: [kwargs[f"ref_{stem}_{i}"] for i in range(9 if stem == "image" else 3)
                               if f"ref_{stem}_{i}" in kwargs]
        videos = values("video")
        return ({"pictures": values("image"), "videos": videos,
                 "video_audios": [kwargs.get(f"ref_video_audio_{i}") for i in range(len(videos))],
                 "audios": values("audio")},)


class ShellMaxH3MaskEditBundle:
    RETURN_TYPES = ("H3_REFS", "AUDIO")
    FUNCTION = "bundle"
    CATEGORY = "ShellMax"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source": ("STRING",), "layers": ("STRING",),
            "start": ("FLOAT", {"default": 0, "min": 0}),
            "end": ("FLOAT", {"default": 2, "min": 0.2}),
            "grow": ("INT", {"default": 16, "min": 0, "max": 64}),
            "feather": ("INT", {"default": 12, "min": 0, "max": 64}),
            "invert": ("BOOLEAN", {"default": False}),
            "crop_to_mask": ("BOOLEAN", {"default": False}),
            "keep_audio": ("BOOLEAN", {"default": True}),
            "has_audio": ("BOOLEAN", {"default": True}),
            "references": ("H3_REFS",)}}

    def bundle(self, source, layers, start, end, grow, feather, invert, crop_to_mask,
               keep_audio, has_audio, references):
        # Uploaded media names stay confined to Comfy's input directory.
        mask = upstream("object_mask").compose_layers(source, json.loads(layers), start, end)
        result = dict(references or {})
        result["edit"] = {"name": source, "file": source, "trim": {"start": start, "end": end},
                          "mask": mask["file"], "grow": grow, "feather": feather,
                          "invert": invert, "context": 1.75 if crop_to_mask and not invert else 0,
                          "keep_audio": keep_audio, "has_audio": has_audio}
        audio = upstream("media_io").extract_audio(source, start=start, end=end) if keep_audio and has_audio else None
        return (result, audio)


class ShellMaxH3ObjectMask:
    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "ShellMax"

    @classmethod
    def INPUT_TYPES(cls):
        return upstream("object_mask").MiniMaxH3FantasticObjectMask.INPUT_TYPES()

    def run(self, **inputs):
        from .sam_compat import run_object_mask
        return run_object_mask(upstream("object_mask"), **inputs)


NODE_CLASS_MAPPINGS = {c.__name__: c for c in (ShellMaxH3ReferenceBundle, ShellMaxH3MaskEditBundle, ShellMaxH3ObjectMask)}
