"""Time estimates come from real finished jobs: exact size match, then scaled, then the prior."""

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.db.models import Generation
from app.jobs import estimator


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(estimator, "session", lambda: Session(engine, expire_on_commit=False))

    def add(units, elapsed, kind="generate", cold=False, status="done"):
        with Session(engine) as s:
            s.add(Generation(project_id=1, kind=kind, status=status, ui_params={}, seed=1,
                             work_units=units, elapsed_s=elapsed, info={"cold": cold}))
            s.commit()
    return add


def test_prior_without_history(db):
    e = estimator.estimate(1000, "generate")
    assert e["basis"] == "prior" and e["samples"] == 0


def test_exact_average_of_same_size(db):
    db(1000, 300)
    db(1000, 320)
    db(2000, 900)
    e = estimator.estimate(1000)
    assert e == {"seconds": 310, "basis": "exact", "samples": 2}


def test_cold_starts_ignored_when_warm_exist(db):
    db(1000, 600, cold=True)
    db(1000, 300)
    assert estimator.estimate(1000)["seconds"] == 300
    # only cold samples: still better than nothing
    db(5000, 900, cold=True)
    assert estimator.estimate(5000)["seconds"] == 900


def test_scaled_from_other_sizes(db):
    db(1000, 120)  # 100 s of work per 1000 units + fixed overhead
    e = estimator.estimate(2000)
    assert e["basis"] == "scaled"
    assert e["seconds"] == pytest.approx(estimator.FIXED_OVERHEAD_S + 200)


def test_kinds_and_failed_jobs_are_separate(db):
    db(1000, 300, kind="face")
    db(1000, 50, status="error")
    assert estimator.estimate(1000, "generate")["basis"] == "prior"
    assert estimator.estimate(1000, "face")["basis"] == "exact"
