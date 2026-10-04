"""A live HTTP server must not hide a dead worker or trigger a duplicate engine."""

from unittest.mock import AsyncMock, Mock

import pytest

from app.comfy import supervisor
from app.comfy.health import WORKER_FAILED, worker_failed
from app.comfy.supervisor import EngineSupervisor
from app.jobs.errors import humanize_error
from app.jobs.queue import JobManager


@pytest.fixture
def engine(monkeypatch):
    client = Mock(alive=AsyncMock(return_value=True))
    engine = EngineSupervisor(client, AsyncMock())
    engine.pid, engine.state = 42, "ready"
    monkeypatch.setattr(supervisor, "pid_alive", lambda pid: pid == 42)
    monkeypatch.setattr(supervisor, "read_pid", lambda: 42)
    monkeypatch.setattr(engine, "log_tail", lambda *args: [])
    monkeypatch.setattr(supervisor.subprocess, "Popen", Mock(side_effect=AssertionError("must not spawn")))
    return engine


@pytest.mark.asyncio
async def test_dead_worker_marks_engine_unusable_and_blocks_submission(engine, monkeypatch):
    monkeypatch.setattr(engine, "log_tail", lambda *args: [
        "Exception in thread Thread-5 (prompt_worker):", "CUDA error: out of memory",
    ])
    await engine.check_health()
    assert engine.state == "error" and engine.detail == WORKER_FAILED
    engine._on_state.assert_awaited_once()
    # Once latched, later HTTP/log activity cannot make the dead worker ready.
    monkeypatch.setattr(engine, "log_tail", lambda *args: [])
    jobs = JobManager(engine.client, engine)
    assert await jobs._ensure_engine() == WORKER_FAILED
    supervisor.subprocess.Popen.assert_not_called()


@pytest.mark.asyncio
async def test_adopt_dead_worker_without_spawning(engine, monkeypatch):
    engine.state = "stopped"
    monkeypatch.setattr(engine, "log_tail", lambda *args: ["Exception in thread Thread-5 (prompt_worker):"])
    await engine.start()
    assert engine.state == "error"
    supervisor.subprocess.Popen.assert_not_called()


@pytest.mark.asyncio
async def test_existing_process_with_broken_cuda_does_not_spawn_second_engine(engine):
    engine.client.alive.return_value = False
    await engine.start()
    assert engine.state == "error"
    supervisor.subprocess.Popen.assert_not_called()


@pytest.mark.asyncio
async def test_gpu_stat_timeouts_cannot_misclassify_a_live_worker(engine):
    engine.client.alive.return_value = False
    for _ in range(4):
        await engine.check_health()
        assert engine.state == "ready"
    engine.client.alive.assert_not_awaited()


@pytest.mark.asyncio
async def test_processing_prompt_is_not_lost_when_engine_status_is_error(engine, monkeypatch):
    from app.jobs.queue import Running
    import app.jobs.queue as queue_module

    engine.state = "error"
    engine.client.queue_state = AsyncMock(return_value={"queue_running": [[1, "processing"]]})
    engine.client.prompt_in_queue = lambda q, pid: q["queue_running"][0][1] == pid
    jobs = JobManager(engine.client, engine)
    monkeypatch.setattr(jobs, "_reconcile_prompt", AsyncMock(return_value=False))
    r = Running(gen_id=1, prompt_id="processing")
    polls = 0

    async def timed_out(awaitable, timeout):
        nonlocal polls
        awaitable.close()
        polls += 1
        if polls == 8:
            r.done.set()
            return None
        raise TimeoutError

    monkeypatch.setattr(queue_module.asyncio, "wait_for", timed_out)
    await jobs._await_prompt(r)
    assert polls == 8 and r.error is None
    assert engine.client.queue_state.await_count == 7


def test_normal_job_error_is_not_a_dead_worker():
    assert not worker_failed(["Exception during processing", "CUDA out of memory"])
    assert not worker_failed(["Exception in thread Thread-1 (preview_worker):"])


@pytest.mark.asyncio
async def test_dead_worker_finishes_prompt_even_if_http_queue_retains_it(engine, monkeypatch):
    from app.jobs.queue import Running
    import app.jobs.queue as queue_module

    monkeypatch.setattr(engine, "log_tail", lambda *args: ["Exception in thread Thread-5 (prompt_worker):"])
    await engine.check_health()
    engine.client.queue_state = AsyncMock(return_value={"queue_running": [[1, "processing"]]})
    jobs = JobManager(engine.client, engine)
    monkeypatch.setattr(jobs, "_reconcile_prompt", AsyncMock(return_value=False))
    r = Running(gen_id=1, prompt_id="processing", draft_asset_id=123)

    async def timed_out(awaitable, timeout):
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr(queue_module.asyncio, "wait_for", timed_out)
    await jobs._await_prompt(r)
    assert r.done.is_set() and r.error == ("engine_down", WORKER_FAILED)
    assert r.draft_asset_id == 123
    engine.client.queue_state.assert_not_awaited()


@pytest.mark.parametrize("message", ["aimdo memory compile error", "hostbuf_file_reader_read failed"])
def test_memory_error_has_recovery_action(message):
    kind, text = humanize_error("RuntimeError", message, "SamplerCustomAdvanced")
    assert kind == "generic" and "Перезапустите движок" in text and "Экономию VRAM" in text


def test_low_vram_incompatibility_has_recovery_action():
    _, text = humanize_error("TypeError", "minimax_block_lowmem_forward() got an unexpected keyword argument 'attention'")
    assert "KJNodes" in text and "Перезапустите движок" in text
