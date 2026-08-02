"""Read-only Allegory observer APIs.

The simulation remains authoritative. These endpoints only read the persisted
``AllegoryTownSpace`` workspace and expose a stable observer contract for the
living-town frontend.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from agentsociety2.backend.path_security import (
    resolve_under_root,
    resolve_workspace_relative,
    resolve_workspace_root,
)

router = APIRouter(prefix="/allegory", tags=["allegory"])

_STATE_RELATIVE_PATH = (
    "env/AllegoryTownSpace/state/ALLEGORY_TOWN_STATE.json"
)
_OBSERVER_FILE = "allegory_observer.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"File not found: {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Observer state is being written or is invalid: {path.name}",
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail=f"Expected JSON object: {path.name}")
    return payload


def _resolve_run_dir(workspace_path: str, run_dir: str) -> Path:
    root = resolve_workspace_root(workspace_path)
    target = resolve_workspace_relative(root, run_dir)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Allegory run directory not found")
    return target


def _town_kwargs_from_checkpoint(run_path: Path) -> dict[str, Any] | None:
    checkpoint_path = resolve_under_root(run_path, "SOCIETY.json")
    if not checkpoint_path.is_file():
        return None
    checkpoint = _read_json(checkpoint_path)
    env_kwargs = checkpoint.get("env_kwargs") or checkpoint.get("_env_kwargs") or {}
    if not isinstance(env_kwargs, dict):
        return None
    town_kwargs = env_kwargs.get("AllegoryTownSpace")
    return town_kwargs if isinstance(town_kwargs, dict) else None


def _build_observer_payload(run_path: Path) -> dict[str, Any]:
    """Build a snapshot from the live environment workspace.

    Falls back to the exported observer file for older/incomplete runs.
    """

    state_path = resolve_under_root(run_path, _STATE_RELATIVE_PATH)
    town_kwargs = _town_kwargs_from_checkpoint(run_path)
    if not state_path.is_file() or town_kwargs is None:
        observer_path = resolve_under_root(run_path, _OBSERVER_FILE)
        if observer_path.is_file():
            return _read_json(observer_path)
        missing = "state" if not state_path.is_file() else "town metadata"
        raise HTTPException(status_code=404, detail=f"Allegory observer {missing} not found")

    state = _read_json(state_path)
    static_agents = town_kwargs.get("agents") or []
    dynamic_agents = state.get("agents") or {}
    agents: list[dict[str, Any]] = []
    for static in static_agents:
        if not isinstance(static, dict) or "id" not in static:
            continue
        agent_id = int(static["id"])
        dynamic = dynamic_agents.get(str(agent_id), {})
        if not isinstance(dynamic, dict):
            dynamic = {}
        agents.append(
            {
                "id": agent_id,
                "name": static.get("name") or f"Agent {agent_id}",
                "home_id": static.get("home_id"),
                "work_id": static.get("work_id"),
                "location_id": dynamic.get("location_id", static.get("location_id")),
                "activity": dynamic.get("activity", "idle"),
                "budget": dynamic.get("budget", static.get("budget", 0)),
                "awareness": dynamic.get("awareness", {}),
                "consideration": dynamic.get("consideration", {}),
                "purchased": dynamic.get("purchased", []),
            }
        )

    events = state.get("events") or []
    if not isinstance(events, list):
        events = []
    return {
        "schema_version": 1,
        "scenario_id": state.get("scenario_id", "allegory_micro_society_v0_1"),
        "branch_id": state.get("branch_id", "default"),
        "locations": town_kwargs.get("locations") or [],
        "products": town_kwargs.get("products") or [],
        "agents": agents,
        "events": events,
        "last_sequence": int(state.get("event_sequence", 0)),
        "simulation_steps": int(state.get("step_counter", 0)),
        "status": "live",
    }


def _events_after(payload: dict[str, Any], after_sequence: int, limit: int) -> list[dict[str, Any]]:
    safe_limit = min(max(int(limit), 1), 1000)
    events = payload.get("events") or []
    return [
        event
        for event in events
        if isinstance(event, dict) and int(event.get("sequence", 0)) > after_sequence
    ][:safe_limit]


def _sse(event: str, data: Any, *, event_id: int | None = None) -> str:
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {encoded}")
    return "\n".join(lines) + "\n\n"


@router.get("/observer/snapshot")
async def observer_snapshot(
    workspace_path: str = Query(..., description="Configured AgentSociety workspace root"),
    run_dir: str = Query(..., description="Run directory relative to WORKSPACE_PATH"),
) -> dict[str, Any]:
    """Return the latest observer snapshot for one Allegory run."""

    return _build_observer_payload(_resolve_run_dir(workspace_path, run_dir))


@router.get("/observer/events")
async def observer_events(
    workspace_path: str = Query(...),
    run_dir: str = Query(...),
    after_sequence: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
) -> dict[str, Any]:
    """Return append-only events after an observer cursor."""

    payload = _build_observer_payload(_resolve_run_dir(workspace_path, run_dir))
    events = _events_after(payload, after_sequence, limit)
    next_sequence = int(events[-1]["sequence"]) if events else after_sequence
    return {
        "after_sequence": after_sequence,
        "next_sequence": next_sequence,
        "last_sequence": int(payload.get("last_sequence", next_sequence)),
        "events": events,
    }


@router.get("/observer/stream")
async def observer_stream(
    request: Request,
    workspace_path: str = Query(...),
    run_dir: str = Query(...),
    after_sequence: int = Query(0, ge=0),
    poll_interval: float = Query(0.75, ge=0.25, le=10.0),
) -> StreamingResponse:
    """Stream persisted Allegory events with Server-Sent Events.

    The stream is cursor-based and safe to reconnect using ``after_sequence``.
    A metadata snapshot is sent first, followed by ``town_event`` messages.
    """

    run_path = _resolve_run_dir(workspace_path, run_dir)

    async def generate() -> AsyncIterator[str]:
        cursor = after_sequence
        last_heartbeat = 0
        while True:
            if await request.is_disconnected():
                return
            try:
                payload = _build_observer_payload(run_path)
                if cursor == after_sequence:
                    metadata = dict(payload)
                    metadata["events"] = []
                    yield _sse("snapshot", metadata)
                events = _events_after(payload, cursor, 1000)
                for event in events:
                    cursor = int(event.get("sequence", cursor))
                    yield _sse("town_event", event, event_id=cursor)
                last_heartbeat += 1
                if not events and last_heartbeat >= 20:
                    yield _sse(
                        "heartbeat",
                        {
                            "cursor": cursor,
                            "last_sequence": int(payload.get("last_sequence", cursor)),
                            "simulation_steps": int(payload.get("simulation_steps", 0)),
                        },
                    )
                    last_heartbeat = 0
            except HTTPException as exc:
                yield _sse("observer_error", {"status": exc.status_code, "detail": exc.detail})
            await asyncio.sleep(poll_interval)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
