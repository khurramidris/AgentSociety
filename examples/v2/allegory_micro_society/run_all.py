#!/usr/bin/env python3
"""Run the Allegory micro-society and export its observer-ready event stream."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

EXP_DIR = Path(__file__).resolve().parent
REPO_ROOT = EXP_DIR.parents[2]
CONFIG_SCRIPT = EXP_DIR / "init" / "config_params.py"
DEFAULT_INIT_DIR = EXP_DIR / "tmp" / "init"
DEFAULT_RUN_DIR = EXP_DIR / "tmp" / "run"


def _run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=REPO_ROOT, env=env, check=True)


def _config_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    env["ALLEGORY_NUM_AGENTS"] = str(args.num_agents)
    env["ALLEGORY_PRODUCT_PRICE"] = str(args.product_price)
    env["ALLEGORY_TICK_SEC"] = str(args.tick_sec)
    env["ALLEGORY_START_T"] = args.start_t
    env["ALLEGORY_RUN_DIR"] = str(args.run_dir.resolve())
    return env


def generate_config(args: argparse.Namespace) -> tuple[Path, Path]:
    _run([sys.executable, str(CONFIG_SCRIPT)], env=_config_env(args))
    config_path = args.config or (DEFAULT_INIT_DIR / "init_config.json")
    steps_path = args.steps or (DEFAULT_INIT_DIR / "steps.yaml")
    return config_path.resolve(), steps_path.resolve()


async def run_simulation(
    args: argparse.Namespace,
    config_path: Path,
    steps_path: Path,
) -> None:
    from agentsociety2.society.cli import ExperimentRunner

    args.run_dir.mkdir(parents=True, exist_ok=True)
    runner = ExperimentRunner(args.run_dir)
    await runner.run(
        config_path,
        steps_path,
        experiment_id="allegory_micro_society_v0_1",
        batch_size=args.batch_size,
        resume=args.resume,
    )


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def export_observer_fixture(
    config_path: Path,
    run_dir: Path,
    output_path: Path | None = None,
) -> Path:
    """Convert persisted environment state into the public observer contract."""
    config = _read_json(config_path)
    town_module = next(
        module
        for module in config["env_modules"]
        if module["module_type"] == "AllegoryTownSpace"
    )
    state_path = (
        run_dir
        / "env"
        / "AllegoryTownSpace"
        / "state"
        / "ALLEGORY_TOWN_STATE.json"
    )
    if not state_path.is_file():
        raise FileNotFoundError(
            "AllegoryTownSpace did not produce persisted state at " f"{state_path}"
        )
    state = _read_json(state_path)
    kwargs = town_module["kwargs"]
    dynamic_agents = state.get("agents", {})
    agents = []
    for agent in kwargs["agents"]:
        dynamic = dynamic_agents.get(str(agent["id"]), {})
        agents.append(
            {
                "id": agent["id"],
                "name": agent["name"],
                "home_id": agent["home_id"],
                "work_id": agent.get("work_id"),
                "location_id": dynamic.get("location_id", agent["location_id"]),
                "activity": dynamic.get("activity", "idle"),
                "budget": dynamic.get("budget", agent["budget"]),
                "awareness": dynamic.get("awareness", {}),
                "consideration": dynamic.get("consideration", {}),
                "purchased": dynamic.get("purchased", []),
            }
        )

    payload = {
        "schema_version": 1,
        "scenario_id": "allegory_micro_society_v0_1",
        "locations": kwargs["locations"],
        "products": kwargs["products"],
        "agents": agents,
        "events": state.get("events", []),
        "last_sequence": state.get("event_sequence", 0),
        "simulation_steps": state.get("step_counter", 0),
    }
    destination = output_path or (run_dir / "allegory_observer.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Observer fixture written to {destination}")
    return destination


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stage",
        choices=["all", "config", "simulate", "export"],
        default="all",
    )
    parser.add_argument("--num-agents", type=int, default=10)
    parser.add_argument("--product-price", type=float, default=49.0)
    parser.add_argument("--tick-sec", type=int, default=1800)
    parser.add_argument("--start-t", default="2026-08-03T08:00:00")
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--steps", type=Path, default=None)
    parser.add_argument("--run-dir", type=Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--observer-output", type=Path, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.stage in {"all", "config"}:
        config_path, steps_path = generate_config(args)
    else:
        config_path = (
            args.config or (DEFAULT_INIT_DIR / "init_config.json")
        ).resolve()
        steps_path = (args.steps or (DEFAULT_INIT_DIR / "steps.yaml")).resolve()

    if args.stage in {"all", "simulate"}:
        asyncio.run(run_simulation(args, config_path, steps_path))

    if args.stage in {"all", "export"}:
        export_observer_fixture(
            config_path,
            args.run_dir.resolve(),
            args.observer_output,
        )


if __name__ == "__main__":
    main()
