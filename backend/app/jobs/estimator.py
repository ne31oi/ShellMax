"""Time estimates from this machine's real, finished jobs.

Every finished job stores its exact wall time (elapsed_s, start of the job -> file ready)
and per-stage seconds (info.stage_seconds). An estimate is:
  * exact  - the average of recent jobs with the same kind and size (work units);
  * scaled - no identical job yet: the median seconds-per-unit of this kind, scaled;
  * prior  - nothing finished yet: a rough constant.
Cold starts (models loaded from disk) are left out whenever warm samples exist.
"""

import statistics

from ..db.models import Generation, select, session

DEFAULT_SEC_PER_UNIT = {
    "generate": 180 / (1440 * 832 * 53),
    "face": 150 / (768 * 768 * 56),
    # SeedVR2 1-step restore ≈ 2–4 min for a short 720p×2 clip on 16 GB
    "enhance": 180 / (1280 * 720 * 48 * 4),
}
FIXED_OVERHEAD_S = 20.0  # prompt encoding, decode, muxing - roughly size independent
EXACT_SAMPLES = 10


def _warm(rows: list[Generation]) -> list[Generation]:
    warm = [g for g in rows if not (g.info or {}).get("cold")]
    return warm or rows


def estimate(units: float, kind: str = "generate") -> dict:
    """{seconds, basis: exact|scaled|prior, samples}"""
    with session() as s:
        rows = s.exec(
            select(Generation)
            .where(Generation.kind == kind, Generation.status == "done",
                   Generation.elapsed_s.is_not(None), Generation.work_units.is_not(None))
            .order_by(Generation.id.desc())
            .limit(100)
        ).all()
    same = _warm([g for g in rows if g.work_units and abs(g.work_units - units) < 1])[:EXACT_SAMPLES]
    if same:
        return {"seconds": statistics.fmean(g.elapsed_s for g in same), "basis": "exact", "samples": len(same)}
    rated = [g for g in _warm(rows) if g.work_units and g.elapsed_s > FIXED_OVERHEAD_S]
    if rated:
        rate = statistics.median((g.elapsed_s - FIXED_OVERHEAD_S) / g.work_units for g in rated)
        return {"seconds": FIXED_OVERHEAD_S + rate * units, "basis": "scaled", "samples": len(rated)}
    rate = DEFAULT_SEC_PER_UNIT.get(kind, DEFAULT_SEC_PER_UNIT["generate"])
    return {"seconds": FIXED_OVERHEAD_S + rate * units, "basis": "prior", "samples": 0}


def estimate_seconds(units: float, kind: str = "generate") -> float:
    return estimate(units, kind)["seconds"]
