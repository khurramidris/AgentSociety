#!/usr/bin/env python3
"""Generate AgentSociety 2 config for Allegory's first micro-society.

Environment variables:
- ALLEGORY_NUM_AGENTS: 1..10, default 10
- ALLEGORY_PRODUCT_PRICE: default 49
- ALLEGORY_START_T: ISO datetime, default 2026-08-03T08:00:00
- ALLEGORY_TICK_SEC: default 1800
- ALLEGORY_RUN_DIR: output run directory
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
EXP_DIR = SCRIPT_DIR.parent
TMP_INIT_DIR = EXP_DIR / "tmp" / "init"
TMP_RUN_DIR = EXP_DIR / "tmp" / "run"

if str(EXP_DIR) not in sys.path:
    sys.path.insert(0, str(EXP_DIR))

from scenario import (  # noqa: E402
    AGENTS,
    LOCATIONS,
    person_profile,
    products,
    town_agent_record,
)


def _selected_agents() -> list[dict]:
    requested = int(os.environ.get("ALLEGORY_NUM_AGENTS", "10"))
    if requested < 1 or requested > len(AGENTS):
        raise ValueError(f"ALLEGORY_NUM_AGENTS must be between 1 and {len(AGENTS)}")
    selected = [dict(agent) for agent in AGENTS[:requested]]
    selected_ids = {int(agent["id"]) for agent in selected}
    for agent in selected:
        agent["relationships"] = {
            int(other_id): float(strength)
            for other_id, strength in agent["relationships"].items()
            if int(other_id) in selected_ids
        }
    return selected


def _agent_config(agent: dict) -> dict:
    kwargs = {
        **person_profile(agent),
        "max_react_turns": 7,
        "enable_todo_list": True,
        "enable_memory": True,
        "memory_context_max_chars": 5000,
        "recent_memory_limit": 10,
        "default_activated_skill_ids": ["built-in@daily-guidance"],
    }
    return {
        "agent_id": int(agent["id"]),
        "agent_type": "PersonAgent",
        "kwargs": kwargs,
    }


def _steps(start_t: str, tick: int, selected_ids: list[int]) -> dict:
    return {
        "start_t": start_t,
        "steps": [
            {
                "type": "run",
                "num_steps": 4,
                "tick": tick,
            },
            {
                "type": "intervene",
                "instruction": (
                    "A town-wide advertising campaign for the Pulse Mini Speaker "
                    "(product id pulse_mini) has started. Residents may encounter "
                    "the campaign in ordinary places. When an exposure is plausible, "
                    "record it with expose_to_product. Continue behaving as ordinary "
                    "residents: people may ignore the ad, discuss it only when "
                    "co-located, visit the shop, consider the product, buy it, reject "
                    "it, or postpone the decision according to their own profile, "
                    "budget, relationships, routines, and memories."
                ),
            },
            {
                "type": "run",
                "num_steps": 12,
                "tick": tick,
            },
            {
                "type": "questionnaire",
                "questionnaire_id": "pulse_mini_post_simulation",
                "title": "Pulse Mini post-simulation check",
                "description": (
                    "Captures each resident's final state after the shared-world run."
                ),
                "target_agent_ids": selected_ids,
                "questions": [
                    {
                        "id": "awareness",
                        "prompt": (
                            "Are you currently aware of the Pulse Mini Speaker? "
                            "Answer yes or no based only on what happened in the "
                            "simulation."
                        ),
                        "response_type": "choice",
                        "choices": ["yes", "no"],
                    },
                    {
                        "id": "purchase_intent",
                        "prompt": (
                            "Which best describes your current position on the Pulse "
                            "Mini Speaker?"
                        ),
                        "response_type": "choice",
                        "choices": [
                            "purchased",
                            "likely_to_buy",
                            "uncertain",
                            "unlikely_to_buy",
                            "not_aware",
                        ],
                    },
                    {
                        "id": "reason",
                        "prompt": (
                            "Briefly explain the main reason for your current position, "
                            "using your own experience and constraints."
                        ),
                        "response_type": "text",
                    },
                ],
            },
        ],
    }


def main() -> None:
    selected = _selected_agents()
    selected_ids = [int(agent["id"]) for agent in selected]
    price = float(os.environ.get("ALLEGORY_PRODUCT_PRICE", "49"))
    tick = int(os.environ.get("ALLEGORY_TICK_SEC", "1800"))
    start_t = os.environ.get("ALLEGORY_START_T", "2026-08-03T08:00:00")
    run_dir = Path(
        os.environ.get("ALLEGORY_RUN_DIR", str(TMP_RUN_DIR))
    ).resolve()

    init_config = {
        "env_modules": [
            {
                "module_type": "AllegoryTownSpace",
                "kwargs": {
                    "locations": LOCATIONS,
                    "agents": [town_agent_record(agent) for agent in selected],
                    "products": products(price),
                },
            }
        ],
        "agents": [_agent_config(agent) for agent in selected],
        "codegen_router": {"final_summary_enabled": False},
    }
    steps = _steps(start_t, tick, selected_ids)

    TMP_INIT_DIR.mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True, exist_ok=True)
    config_path = TMP_INIT_DIR / "init_config.json"
    steps_path = TMP_INIT_DIR / "steps.yaml"
    config_path.write_text(
        json.dumps(init_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    steps_path.write_text(
        yaml.safe_dump(steps, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    print(f"Wrote {config_path}")
    print(f"Wrote {steps_path}")
    print(
        f"agents={len(selected)} price={price:.2f} tick={tick} "
        f"run_dir={run_dir}"
    )


if __name__ == "__main__":
    main()
