from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from agentsociety2.backend.routers.allegory import (
    _build_observer_payload,
    _events_after,
    _resolve_run_dir,
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _build_live_run(root: Path) -> Path:
    run_dir = root / "runs" / "demo"
    _write_json(
        run_dir / "SOCIETY.json",
        {
            "env_kwargs": {
                "AllegoryTownSpace": {
                    "locations": [
                        {
                            "id": "home_1",
                            "name": "Home 1",
                            "kind": "home",
                            "x": 10,
                            "y": 20,
                            "neighbors": ["shop"],
                        },
                        {
                            "id": "shop",
                            "name": "Shop",
                            "kind": "shop",
                            "x": 60,
                            "y": 20,
                            "neighbors": ["home_1"],
                        },
                    ],
                    "products": [
                        {
                            "id": "pulse_mini",
                            "name": "Pulse Mini",
                            "category": "audio",
                            "price": 49,
                            "store_id": "shop",
                        }
                    ],
                    "agents": [
                        {
                            "id": 1,
                            "name": "Alice",
                            "home_id": "home_1",
                            "work_id": None,
                            "location_id": "home_1",
                            "budget": 100,
                        }
                    ],
                }
            }
        },
    )
    _write_json(
        run_dir
        / "env"
        / "AllegoryTownSpace"
        / "state"
        / "ALLEGORY_TOWN_STATE.json",
        {
            "scenario_id": "demo",
            "branch_id": "price_49",
            "step_counter": 2,
            "event_sequence": 2,
            "agents": {
                "1": {
                    "location_id": "shop",
                    "activity": "shopping",
                    "budget": 51,
                    "awareness": {"pulse_mini": 0.75},
                    "consideration": {"pulse_mini": 0.7},
                    "purchased": ["pulse_mini"],
                }
            },
            "events": [
                {
                    "sequence": 1,
                    "event_type": "movement_completed",
                    "simulation_time": "2026-08-03T08:30:00",
                    "actor_id": 1,
                    "location_id": "shop",
                    "payload": {"destination_id": "shop"},
                },
                {
                    "sequence": 2,
                    "event_type": "product_purchased",
                    "simulation_time": "2026-08-03T08:30:00",
                    "actor_id": 1,
                    "location_id": "shop",
                    "payload": {
                        "product_id": "pulse_mini",
                        "remaining_budget": 51,
                    },
                },
            ],
        },
    )
    return run_dir


def test_build_observer_payload_merges_static_and_dynamic_state(tmp_path: Path) -> None:
    run_dir = _build_live_run(tmp_path)

    payload = _build_observer_payload(run_dir)

    assert payload["scenario_id"] == "demo"
    assert payload["branch_id"] == "price_49"
    assert payload["last_sequence"] == 2
    assert payload["simulation_steps"] == 2
    assert payload["agents"] == [
        {
            "id": 1,
            "name": "Alice",
            "home_id": "home_1",
            "work_id": None,
            "location_id": "shop",
            "activity": "shopping",
            "budget": 51,
            "awareness": {"pulse_mini": 0.75},
            "consideration": {"pulse_mini": 0.7},
            "purchased": ["pulse_mini"],
        }
    ]


def test_events_after_is_cursor_based_and_limited(tmp_path: Path) -> None:
    payload = _build_observer_payload(_build_live_run(tmp_path))

    events = _events_after(payload, after_sequence=1, limit=1)

    assert [event["sequence"] for event in events] == [2]


def test_resolve_run_dir_rejects_path_escape(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("WORKSPACE_PATH", str(tmp_path))
    (tmp_path / "runs" / "demo").mkdir(parents=True)

    with pytest.raises(HTTPException) as caught:
        _resolve_run_dir(str(tmp_path), "../outside")

    assert caught.value.status_code == 400


def test_exported_fixture_is_supported_as_fallback(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    _write_json(
        run_dir / "allegory_observer.json",
        {
            "schema_version": 1,
            "scenario_id": "fixture",
            "locations": [],
            "products": [],
            "agents": [],
            "events": [],
            "last_sequence": 0,
            "simulation_steps": 0,
        },
    )

    payload = _build_observer_payload(run_dir)

    assert payload["scenario_id"] == "fixture"
