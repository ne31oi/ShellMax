"""Motion-prefix conditioning and AV output trimming for H3 continuation."""


class ShellMaxH3ContinuationPrefix:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"positive": ("CONDITIONING",), "latent": ("LATENT",),
                             "vae": ("VAE",), "audio_vae": ("VAE",), "images": ("IMAGE",),
                             "context_frames": ("INT", {"default": 22, "min": 5, "max": 39})},
                "optional": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    FUNCTION = "apply"
    CATEGORY = "ShellMax/continuation"

    def apply(self, positive, latent, vae, audio_vae, images, context_frames, audio=None):
        import torch
        from comfy.nested_tensor import NestedTensor
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide

        if images.shape[0] < context_frames:
            raise ValueError("Не удалось прочитать последние кадры клипа — выберите более длинный исходник")
        samples = latent["samples"]
        if not samples.is_nested or len(samples.tensors) != 2:
            raise ValueError("Продолжение требует совместный видео/аудио латент H3")
        conditioned = MiniMaxH3AddGuide.execute(
            positive, latent, 0, vae=vae, audio_vae=audio_vae,
            image=images[-context_frames:], audio=audio)[0]
        keyframe = conditioned[0][1]["minimax_keyframes"][-1]
        video, sound = [stream.clone() for stream in samples.tensors]
        clean = keyframe["latent"].to(video)
        if clean.shape[2] >= video.shape[2]:
            raise ValueError("Контекст занимает весь клип — увеличьте длительность продолжения")
        video[:, :, :clean.shape[2]] = clean
        vm, am = torch.ones_like(video), torch.ones_like(sound)
        vm[:, :, :clean.shape[2]] = 0
        if audio is not None:
            clean_audio = keyframe["audio_latent"].to(sound)
            # Audio VAE padding must never lock future samples beyond the motion context.
            count = min(clean_audio.shape[-1], sound.shape[-1], int(context_frames * 40 / 24))
            sound[..., :count] = clean_audio[..., :count]
            am[..., :count] = 0
        result = {**latent, "samples": NestedTensor((video, sound)), "noise_mask": NestedTensor((vm, am))}
        return conditioned, result


class ShellMaxContinuationOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "audio": ("AUDIO",),
                             "context_frames": ("INT", {"default": 22, "min": 5, "max": 39}),
                             "added_frames": ("INT", {"default": 51, "min": 17, "max": 3600})}}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    FUNCTION = "trim"
    CATEGORY = "ShellMax/continuation"

    def trim(self, images, audio, context_frames, added_frames):
        if images.shape[0] < context_frames + added_frames:
            raise ValueError("H3 вернул меньше кадров, чем запрошено для продолжения")
        start = round(context_frames * audio["sample_rate"] / 24)
        end = round((context_frames + added_frames) * audio["sample_rate"] / 24)
        return (images[context_frames:context_frames + added_frames],
                {**audio, "waveform": audio["waveform"][..., start:end]})


NODE_CLASS_MAPPINGS = {"ShellMaxH3ContinuationPrefix": ShellMaxH3ContinuationPrefix,
                       "ShellMaxContinuationOutput": ShellMaxContinuationOutput}
