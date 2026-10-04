"""Backport the H3 attention override fix to the pinned KJNodes, without importing CUDA.

Upstream: https://github.com/kijai/ComfyUI-KJNodes/issues/750
This module is also run directly by the portable engine installer.
"""

import ast
import sys
from pathlib import Path


OLD_FORWARD = '''def minimax_block_lowmem_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={}):
    # DiTBlock.forward, but hands h to attn in a list so attn can free it after the qkv GEMM
    shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(t_emb)
    h = [_mod_scale_shift(self.norm1(x), shift_msa, scale_msa, mod_segments)]
    x = _mod_gate(x, gate_msa, self.attn(h, rope_freqs=rope_freqs, transformer_options=transformer_options), mod_segments)
    h = _mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments)
    return _mod_gate(x, gate_mlp, self.mlp(h), mod_segments)'''

NEW_FORWARD = '''def minimax_block_lowmem_forward(self, x, t_emb, mod_segments, rope_freqs, transformer_options={}, attention=None):
    # Transfer h only to the low-memory attention; core overrides expect a tensor.
    shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = self.adaln_proj(t_emb)
    h = _mod_scale_shift(self.norm1(x), shift_msa, scale_msa, mod_segments)
    if attention is None:
        attention = self.attn
        h = [h]
    x = _mod_gate(x, gate_msa, attention(h, rope_freqs=rope_freqs, transformer_options=transformer_options), mod_segments)
    h = _mod_scale_shift(self.norm2(x), shift_mlp, scale_mlp, mod_segments)
    return _mod_gate(x, gate_mlp, self.mlp(h), mod_segments)'''


def patch_kj_attention(custom_nodes: Path) -> bool:
    """Patch only the known incompatible function; fail before overwriting unknown code."""
    path = custom_nodes / "ComfyUI-KJNodes" / "nodes" / "minimax_nodes.py"
    source = path.read_bytes().decode("utf-8")
    tree = ast.parse(source)
    function = next((node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "minimax_block_lowmem_forward"), None)
    if function is None:
        raise RuntimeError("KJNodes: не найдена функция MiniMax Low VRAM Attention")
    if "attention" in {arg.arg for arg in function.args.args + function.args.kwonlyargs}:
        return False
    original = ast.get_source_segment(source, function)
    if ast.dump(ast.parse(original)) != ast.dump(ast.parse(OLD_FORWARD)):
        raise RuntimeError("KJNodes: неизвестная версия MiniMax Low VRAM Attention; файл не изменён")
    newline = "\r\n" if "\r\n" in source else "\n"
    patched = source.replace(original, NEW_FORWARD.replace("\n", newline), 1)
    compile(patched, str(path), "exec")
    path.write_bytes(patched.encode("utf-8"))
    return True


if __name__ == "__main__":
    changed = patch_kj_attention(Path(sys.argv[1]))
    print("KJNodes H3 attention compatibility: " + ("patched" if changed else "already compatible"))
