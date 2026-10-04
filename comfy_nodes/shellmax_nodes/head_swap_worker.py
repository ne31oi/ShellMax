"""Isolated upstream MatAnyone 2 / ProPainter inference; no automatic downloads."""
import argparse
from pathlib import Path
import sys

import numpy as np
import torch
import torch.nn.functional as F



def dilate(mask, radius):
    size = radius * 2 + 1
    if mask.device.type == "cpu":
        import cv2

        kernel = np.ones((size, size), np.uint8)
        return torch.from_numpy(np.stack([cv2.dilate(frame.numpy(), kernel) for frame in mask]))
    horizontal = F.max_pool2d(mask[:, None], (1, size), 1, (0, radius))
    return F.max_pool2d(horizontal, (size, 1), 1, (radius, 0))[:, 0]


def alpha_video(images, seed, network, device, label):
    from matanyone2 import InferenceCore

    processor = InferenceCore(network, device=device)
    frame = images[0].permute(2, 0, 1).to(device)
    processor.step(frame, seed.to(device) * 255, objects=[1])
    for _ in range(10):
        processor.step(frame, first_frame_pred=True)
    mattes = []
    for i, image in enumerate(images):
        prediction = processor.step(image.permute(2, 0, 1).to(device), first_frame_pred=i == 0,
                                    end=i == len(images) - 1)
        mattes.append(processor.output_prob_to_mask(prediction).float().cpu().clamp(0, 1))
        if i % 12 == 0:
            print(f"{label}: {i + 1}/{len(images)}", flush=True)
    return torch.stack(mattes)


def load_matter(runtime, weights, device):
    from hydra import compose, initialize_config_dir
    from omegaconf import open_dict
    from matanyone2 import MatAnyone2

    with initialize_config_dir(version_base="1.3", config_dir=str(runtime / "matanyone2/matanyone2/config")):
        cfg = compose(config_name="eval_matanyone_config")
    with open_dict(cfg):
        # The complete checkpoint already contains the encoders: never fetch ImageNet weights.
        cfg.model.pretrained_resnet = False
    network = MatAnyone2(cfg, single_object=True).eval()
    state = torch.load(weights / "matanyone2.pth", map_location="cpu", weights_only=True)
    network.load_state_dict(state, strict=True)
    return network.to(device)


def inpaint_video(images, hole, runtime, weights, device, max_resolution=512):
    """Use the author's flow completion, propagation and overlapping transformer windows."""
    from model.modules.flow_comp_raft import RAFT_bi
    from model.recurrent_flow_completion import RecurrentFlowCompleteNet
    from model.propainter import InpaintGenerator

    count, height, width, _ = images.shape
    if count == 1:
        return inpaint_video(images.repeat(2, 1, 1, 1), hole.repeat(2, 1, 1), runtime, weights, device,max_resolution)[:1]
    # Only the hidden background is reconstructed at this scale; head pixels stay full resolution.
    scale = min(1, max_resolution / max(height, width))
    h, w = max(8, int(height * scale) // 8 * 8), max(8, int(width * scale) // 8 * 8)
    frames = F.interpolate(images.permute(0, 3, 1, 2), (h, w), mode="area")[None].to(device) * 2 - 1
    masks = F.interpolate(hole[:, None], (h, w), mode="nearest")[None].to(device)
    raft = RAFT_bi(str(weights / "raft-things.pth"), device).eval()
    flow_net = RecurrentFlowCompleteNet(str(weights / "recurrent_flow_completion.pth")).to(device).eval()
    painter = InpaintGenerator(model_path=str(weights / "ProPainter.pth")).to(device).eval()
    forward, backward = [], []
    for start in range(0, count, 8):
        lo = max(0, start - 1)
        hi = min(count, start + 8)
        if hi - lo < 2:
            continue
        f, b = raft(frames[:, lo:hi], iters=20)
        forward.append(f)
        backward.append(b)
        print(f"Background flow: {hi}/{count}", flush=True)
    flows = torch.cat(forward, 1), torch.cat(backward, 1)
    del raft
    torch.cuda.empty_cache()
    # The author's fp16 inference mode keeps a 99-frame shot within 16 GB VRAM.
    frames, masks = frames.half(), masks.half()
    flows = tuple(flow.half() for flow in flows)
    flow_net, painter = flow_net.half(), painter.half()
    # Limit recurrent flow windows, with the same five-frame overlaps as upstream.
    completed = [[], []]
    for start in range(0, count - 1, 40):
        lo, hi = max(0, start - 5), min(count - 1, start + 45)
        raw = flows[0][:, lo:hi], flows[1][:, lo:hi]
        predicted, _ = flow_net.forward_bidirect_flow(raw, masks[:, lo:hi + 1])
        predicted = flow_net.combine_flow(raw, predicted, masks[:, lo:hi + 1])
        end = min(count - 1, start + 40)
        for direction in range(2):
            completed[direction].append(predicted[direction][:, start - lo:end - lo])
    flows = torch.cat(completed[0], 1), torch.cat(completed[1], 1)
    del flow_net, completed
    torch.cuda.empty_cache()
    propagated, remaining = [], []
    for start in range(0, count, 40):
        lo, hi = max(0, start - 10), min(count, start + 50)
        end = min(count, start + 40)
        part = frames[:, lo:hi]
        mask = masks[:, lo:hi]
        predicted, unfilled = painter.img_propagation(part * (1 - mask),
            (flows[0][:, lo:hi - 1], flows[1][:, lo:hi - 1]), mask, "nearest")
        updated = part * (1 - mask) + predicted.view_as(part) * mask
        propagated.append(updated[:, start - lo:end - lo])
        remaining.append(unfilled[:, start - lo:end - lo])
    updated = torch.cat(propagated, 1)
    unknown = torch.cat(remaining, 1)
    output = torch.zeros_like(frames, device="cpu")
    visits = torch.zeros(count)
    for center in range(0, count, 5):
        neighbours = list(range(max(0, center - 5), min(count, center + 6)))
        refs = [i for i in range(0, count, 10) if i not in neighbours]
        indices = neighbours + refs
        predicted = painter(updated[:, indices],
            (flows[0][:, neighbours[:-1]], flows[1][:, neighbours[:-1]]),
            masks[:, indices], unknown[:, indices], len(neighbours))
        predicted = predicted.view(-1, 3, h, w).float().cpu()
        output[0, neighbours] += predicted
        visits[neighbours] += 1
        print(f"Background reconstruction: {min(count, center + 6)}/{count}", flush=True)
    output = (output[0] / visits[:, None, None, None] + 1) / 2
    output = F.interpolate(output, (height, width), mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
    return torch.where(hole[..., None] > 0, output.clamp(0, 1), images)


@torch.inference_mode()
def run(args):
    runtime, weights = Path(args.runtime).resolve(), Path(args.weights).resolve()
    sys.path.insert(0, str(runtime / "matanyone2"))
    sys.path.insert(0, str(runtime / "propainter"))
    device = torch.device("cuda")
    arrays = np.load(args.input)
    images = torch.from_numpy(arrays["source"])
    donor = torch.from_numpy(arrays["donor"])
    old_mask = torch.from_numpy(arrays["old"])
    new_mask = torch.from_numpy(arrays["new"])
    foreground = torch.from_numpy(arrays["foreground"])
    person_seed = torch.from_numpy(arrays["person"][0])
    network = load_matter(runtime, weights, device)
    head_alpha = alpha_video(donor, new_mask[0], network, device, "Replacement hair alpha")
    person_alpha = alpha_video(donor, person_seed, network, device, "Replacement person alpha")
    old_alpha = alpha_video(images, old_mask[0], network, device, "Original hair alpha")
    # Matte follows the head, while SAM limits any accidental spread into other body parts.
    support = dilate(new_mask, 24)
    old_alpha *= dilate(old_mask, 24)
    # Within the old head silhouette keep the new neck/collar, rather than inventing
    # background over the body. Outside it, only the new head may enter the paste.
    rows = torch.arange(images.shape[1])[None, :, None]
    occupied = new_mask.any(2)
    top = torch.where(occupied, rows[:, :, 0], images.shape[1]).amin(1)
    bottom = torch.where(occupied, rows[:, :, 0], 0).amax(1)
    neck_start = (top + (bottom - top) * 0.8)[:, None, None]
    neck_band = ((rows - neck_start) / 12).clamp(0, 1)
    # A semi-transparent person matte can include faint echoes of the old hair.
    # Use it only for opaque neck/clothing; fine hair comes from the head matte.
    body_alpha = (person_alpha > 0.995).float() * (old_alpha > 0.001).float() * neck_band
    new_alpha = torch.maximum(head_alpha * support, body_alpha)
    del network
    torch.cuda.empty_cache()
    # A clean plate contains background underneath the whole head. Neck/collar are
    # covered by the opaque body transition instead of being invented by the painter.
    hole = dilate((old_alpha > 0.001).float(), 12) * (1 - foreground)
    reconstructed = inpaint_video(images, hole, runtime, weights, device)
    plate = torch.where(hole[..., None] > 0, reconstructed, images)
    composite = donor * new_alpha[..., None] + plate * (1 - new_alpha[..., None])
    composite = torch.where(foreground[..., None] > 0, images, composite)
    np.savez(args.output, composite=composite.numpy(), alpha=new_alpha.numpy(), plate=plate.numpy(),
             old_alpha=old_alpha.numpy())
    print("Temporal composite complete", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("input", "output", "runtime", "weights"):
        parser.add_argument("--" + name, required=True)
    run(parser.parse_args())
