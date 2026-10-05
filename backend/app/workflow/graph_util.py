"""Shared ComfyUI API graph helpers."""


def link(node_id: str, slot: int = 0) -> list:
    """Wire an output of `node_id` into an input (ComfyUI [node, slot] form)."""
    return [node_id, slot]


def reachable_nodes(graph: dict, outputs: tuple[str, ...]) -> dict:
    """Keep only dependencies of the requested outputs in an API graph."""
    needed: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in needed:
            return
        needed.add(node_id)
        for value in graph[node_id]["inputs"].values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] in graph:
                visit(value[0])

    for node_id in outputs:
        visit(node_id)
    return {key: value for key, value in graph.items() if key in needed}
