"""Backport preserves low-memory ownership and honours the core attention override."""

from types import SimpleNamespace

import pytest

from app.comfy.compat import NEW_FORWARD, OLD_FORWARD, patch_kj_attention


def node_file(tmp_path, source):
    path = tmp_path / "ComfyUI-KJNodes" / "nodes" / "minimax_nodes.py"
    path.parent.mkdir(parents=True)
    path.write_bytes(source.encode("utf-8"))
    return path


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_patch_is_idempotent_and_preserves_other_nodes(tmp_path, newline):
    source = ("# pinned node pack\n" + OLD_FORWARD + "\n\nOTHER_NODE = 42\n").replace("\n", newline)
    path = node_file(tmp_path, source)
    assert patch_kj_attention(tmp_path)
    patched = path.read_bytes()
    assert patched == ("# pinned node pack\n" + NEW_FORWARD + "\n\nOTHER_NODE = 42\n").replace("\n", newline).encode()
    assert not patch_kj_attention(tmp_path)
    assert path.read_bytes() == patched


def test_unknown_incompatible_version_is_not_overwritten(tmp_path):
    path = node_file(tmp_path, OLD_FORWARD.replace("self.mlp(h)", "self.other_mlp(h)"))
    before = path.read_bytes()
    with pytest.raises(RuntimeError, match="неизвестная версия"):
        patch_kj_attention(tmp_path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("override", [False, True])
def test_patched_forward_honours_attention_override_and_preserves_math(tmp_path, override):
    path = node_file(tmp_path, OLD_FORWARD)
    patch_kj_attention(tmp_path)
    namespace = {
        "_mod_scale_shift": lambda x, shift, scale, segments: x * (1 + scale) + shift,
        "_mod_gate": lambda x, gate, value, segments: x + gate * value,
    }
    exec(compile(path.read_bytes(), str(path), "exec"), namespace)
    seen = []

    def low_memory_attention(h, **kwargs):
        assert isinstance(h, list)
        seen.append(h.pop())
        return seen[-1] * 2

    def core_override(h, **kwargs):
        assert isinstance(h, int)
        seen.append(h)
        return h * 3

    block = SimpleNamespace(adaln_proj=lambda t: (1, 2, 3, 4, 5, 6), norm1=lambda x: x,
                            norm2=lambda x: x, attn=low_memory_attention, mlp=lambda x: x * 2)
    kwargs = {"attention": core_override} if override else {}
    result = namespace["minimax_block_lowmem_forward"](block, 2, None, None, None, **kwargs)
    h = 2 * 3 + 1
    x = 2 + 3 * h * (3 if override else 2)
    assert seen == [h]
    assert result == x + 6 * (x * 6 + 4) * 2
