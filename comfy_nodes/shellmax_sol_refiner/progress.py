"""Map nested codec progress into the refiner's overall range."""
from contextlib import contextmanager


@contextmanager
def stage_progress(utils, bar, start, end):
    previous = utils.PROGRESS_BAR_HOOK

    def update(value, total, preview=None, node_id=None):
        fraction = min(1, max(0, value / max(1, total)))
        bar.update_absolute(round(start + (end - start) * fraction), 100)

    utils.set_progress_bar_global_hook(update)
    try:
        yield
    finally:
        utils.set_progress_bar_global_hook(previous)
