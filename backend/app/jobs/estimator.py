"""Time estimates learned from this machine's finished generations."""

import statistics

from ..db.models import Generation, select, session

# rough prior before any history: ~3 min for the workflow default (1440x832, 53 frames)
DEFAULT_SEC_PER_UNIT = 180 / (1440 * 832 * 53)
FIXED_OVERHEAD_S = 20.0  # prompt encoding, VAE decode, muxing - roughly size independent


def estimate_seconds(units: float) -> float:
    with session() as s:
        rows = s.exec(
            select(Generation)
            .where(Generation.status == "done", Generation.elapsed_s.is_not(None), Generation.work_units.is_not(None))
            .order_by(Generation.id.desc())
            .limit(20)
        ).all()
    rates = [(g.elapsed_s - FIXED_OVERHEAD_S) / g.work_units for g in rows if g.work_units and g.elapsed_s > FIXED_OVERHEAD_S]
    rate = statistics.median(rates) if rates else DEFAULT_SEC_PER_UNIT
    return FIXED_OVERHEAD_S + rate * units
