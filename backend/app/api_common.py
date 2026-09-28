"""Shared helpers for /api routers."""

from fastapi import HTTPException, Request


def state(request: Request):
    return request.app.state


def not_found():
    raise HTTPException(404, "не найдено")
