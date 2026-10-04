"""Named upload families and reverse use across the active project state."""

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app import reference_library, services
from app.db.models import Generation, Project, Upload


@pytest.fixture
def db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(reference_library, "session", lambda: Session(engine, expire_on_commit=False))
    monkeypatch.setattr(services, "session", lambda: Session(engine, expire_on_commit=False))
    with Session(engine) as s:
        s.add_all([
            Upload(id="root", kind="image", orig_name="hero.png", path="hero.png"),
            Upload(id="edit", kind="image", orig_name="hero crop.png", path="crop.png", source_id="root"),
            Project(id=1, name="Клип", timeline={"tracks": [{"plans": [{"id": "shot1", "name": "Вход", "refs": [{"uploadId": "edit"}]}]}]}),
            Generation(id=10, project_id=1, ui_params={"refs": [{"upload_id": "root"}]}, seed=1),
        ])
        s.commit()
    return engine


def test_rename_applies_to_edits_and_usage_resolves_family(db):
    updated = reference_library.update_reference("edit", reference_library.ReferenceDetails(
        name="  Главный герой  ", category="character", description="Портрет",
    ))
    assert updated.id == "root" and updated.name == "Главный герой"
    with Session(db) as s:
        edit = s.get(Upload, "edit")
        assert (edit.name, edit.category, edit.description) == ("Главный герой", "character", "Портрет")
        s.add(Upload(id="other", kind="image", orig_name="hero.png", path="other.png", name="Другой герой"))
        s.commit()
    assert {u.id for u in services.list_uploads(used_only=False) if u.name} == {"root", "other"}
    uses = reference_library.reference_usage("root")
    assert {(u["kind"], u["label"]) for u in uses} == {("plan", "Вход"), ("generation", "Генерация #10")}


def test_body_swap_photos_remain_in_library_and_project_usage(db):
    with Session(db) as s:
        s.add_all([
            Upload(id="body-front", kind="image", orig_name="front.png", path="front.png"),
            Upload(id="body-side", kind="image", orig_name="side.png", path="side.png"),
            Generation(id=11, project_id=1, kind="body_swap", seed=42,
                       ui_params={"front_upload_id": "body-front", "side_upload_id": "body-side"}),
        ])
        s.commit()
    assert {u.id for u in services.list_uploads()} >= {"body-front", "body-side"}
    for uid in ("body-front", "body-side"):
        assert reference_library.reference_usage(uid) == [
            {"project_id": 1, "project": "Клип", "kind": "generation", "label": "Генерация #11"},
        ]
