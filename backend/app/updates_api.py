"""Thin endpoints for the private engine updater."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .api_common import state

router = APIRouter(prefix="/engine-updates")


class InstallUpdates(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)
    check_id: str


@router.get("")
def status(request: Request):
    return state(request).updates.snapshot()


@router.post("/check")
async def check(request: Request):
    try:
        return await state(request).updates.check()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/install")
async def install(body: InstallUpdates, request: Request):
    try:
        return await state(request).updates.install(body.ids, body.check_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/restore")
async def restore(request: Request):
    try:
        return await state(request).updates.restore()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
