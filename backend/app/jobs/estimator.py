"""Time estimates learned from this machine's finished jobs, per job kind."""

import statistics

from ..db.models import Generation, select, session

# rough priors before any history
DEFAULT_SEC_PER_UNIT = {
    "generate": 180 / (1440 * 832 * 53),  # ~3 min for the workflow default (1440x832, 56 frames)
    "face": 150 / (768 * 768 * 56),  # ~2.5 min for a 2 s clip on the 768 canvas
}
FIXED_OVERHEAD_S = 20.0  # prompt encoding, VAE decode, muxing - roughly size independent


def estimate_seconds(units: float, kind: str = "generate") -> float:
    with session() as s:
        rows = s.exec(
            select(Generation)
            .where(Generation.kind == kind, Generation.status == "done",
                   Generation.elapsed_s.is_not(None), Generation.work_units.is_not(None))
            .order_by(Generation.id.desc())
            .limit(20)
        ).all()
    rates = [(g.elapsed_s - FIXED_OVERHEAD_S) / g.work_units for g in rows if g.work_units and g.elapsed_s > FIXED_OVERHEAD_S]
    rate = statistics.median(rates) if rates else DEFAULT_SEC_PER_UNIT.get(kind, DEFAULT_SEC_PER_UNIT["generate"])
    return FIXED_OVERHEAD_S + rate * units
