"""Shared ComfyUI API graph helpers."""


def link(node_id: str, slot: int = 0) -> list:
    """Wire an output of `node_id` into an input (ComfyUI [node, slot] form)."""
    return [node_id, slot]
