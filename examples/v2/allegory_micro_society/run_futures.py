#!/usr/bin/env python3
"""Run Allegory's first equivalent-start counterfactual futures.

This orchestrator keeps the same population, world, start time, tick schedule,
and agent configuration across branches while varying only declared scenario
inputs such as campaign presence, message, and product price.

It is deliberately honest about the current boundary: AgentSociety model calls
are not yet guaranteed deterministic from a numeric seed, so ``--replicates``
measures run-to-run variation but does not claim exact seeded reproducibility.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import yaml

from scenario import AGENTS, LOCATIONS, person_profile, products, town_agent_record

EXP_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT_ROOT = EXP_DIR / "tmp" / "futures"


@dataclass(frozen=True)
class BranchSpec:
    branch_id: str
    label: str
    product_price: float
    campaign_enabled: bool
    campaign_message: str | None = None


DEFAULT_BRANCHES = [
    BranchSpec(
        branch_id="baseline_no_campaign",
        label="Baseline: no campaign",
        product_price=49.0,
        campaign_enabled=False,
    ),
    BranchSpec(
        branch_id="campaign_price_49",
        label="Campaign at $49",
        product_price=49.0,
        campaign_enabled=True,
        campaign_message="A general awareness campaign for the Pulse Mini Speaker.",
    ),
    BranchSpec(
        branch_id="campaign_price_69",
        label="Campaign at $69",
        product_price=69.0,
        campaign_enabled=True,
        campaign_message="A general awareness campaign for the Pulse Mini Speaker.",
    ),
    BranchSpec(
        branch_id="value_message_price_69",
        label="Value message at $69",
        product_price=69.0,
        campaign_enabled=True,
        campaign_message=(
            "A campaign presents the Pulse Mini Speaker as a compact, durable "
            "speaker for everyday home and social use."
        ),
    ),
]


def _selected_agents(count: int) -> list[dict[str, Any]]:
    if count < 1 or count > len(AGENTS):
        raise ValueError(f"num_agents must be between 1 and {len(AGENTS)}")
    selected = [dict(agent) for agent in AGENTS[:count]]
    selected_ids = {int(agent["id"]) for agent in selected}
    for agent in selected:
        agent["relationships"] = {
            int(other_id): float(strength)
            for other_id, strength in agent["relationships"].items()
            if int(other_id) in selected_ids
        }
    return selected


def _agent_config(agent: dict[str, Any]) -> dict[str, Any]:
    return {
        "agent_id": int(agent["id"]),
        "agent_type": "PersonAgent",
        "kwargs": {
            **person_profile(agent),
            "max_react_turns": 7,
            "enable_todo_list": True,
            "enable_memory": True,
            "memory_context_max_chars": 5000,
            "recent_memory_limit": 10,
            "default_activated_skill_ids": ["built-in@daily-guidance"],
        },
    }


def _build_steps(
    branch: BranchSpec,
    *,
    start_t: str,
    tick_sec: int,
    selected_ids: list[int],
) -> dict[str, Any]:
    steps: list[dict[str, Any]] = [
        {"type": "run", "num_steps": 4, "tick": tick_sec}
    ]
    if branch.campaign_enabled:
        message = branch.campaign_message or "A general product awareness campaign."
        steps.append(
            {
                "type": "intervene",
                "instruction": (
                    f"Campaign branch {branch.branch_id} has started. {message} "
                    "The advertised product id is pulse_mini. Record exposure only "
                    "when plausible with expose_to_product. Residents remain free to "
                    "ignore, discuss, investigate, postpone, reject, or purchase based "
                    "on their profiles, budgets, relationships, routines, and memories."
                ),
            }
        )
    steps.extend(
        [
            {"type": "run", "num_steps": 12, "tick": tick_sec},
            {
                "type": "questionnaire",
                "questionnaire_id": f"{branch.branch_id}_post_simulation",
                "title": f"{branch.label} post-simulation check",
                "description": "Final resident state for one Allegory future.",
                "target_agent_ids": selected_ids,
                "questions": [
                    {
                        "id": "awareness",
                        "prompt": (
                            "Are you currently aware of the Pulse Mini Speaker? "
                            "Answer only from events in this simulation."
                        ),
                        "response_type": "choice",
                        "choices": ["yes", "no"],
                    },
                    {
                        "id": "purchase_intent",
                        "prompt": "What is your current position on the Pulse Mini Speaker?",
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
                        "prompt": "Briefly explain the main reason for your position.",
                        "response_type": "text",
                    },
                ],
            },
        ]
    )
    return {"start_t": start_t, "steps": steps}


def _build_config(branch: BranchSpec, selected: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "env_modules": [
            {
                "module_type": "AllegoryTownSpace",
                "kwargs": {
                    "locations": LOCATIONS,
                    "agents": [town_agent_record(agent) for agent in selected],
                    "products": products(branch.product_price),
                },
            }
        ],
        "agents": [_agent_config(agent) for agent in selected],
        "codegen_router": {"final_summary_enabled": False},
    }


def _write_branch_files(
    branch: BranchSpec,
    *,
    replicate: int,
    output_root: Path,
    selected: list[dict[str, Any]],
    start_t: str,
    tick_sec: int,
) -> tuple[Path, Path, Path]:
    branch_root = output_root / branch.branch_id / f"replicate_{replicate:03d}"
    config_dir = branch_root / "init"
    run_dir = branch_root / "run"
    config_dir.mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True, exist_ok=True)

    config_path = config_dir / "init_config.json"
    steps_path = config_dir / "steps.yaml"
    manifest_path = branch_root / "branch_manifest.json"
    config_path.write_text(
        json.dumps(_build_config(branch, selected), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    steps_path.write_text(
        yaml.safe_dump(
            _build_steps(
                branch,
                start_t=start_t,
                tick_sec=tick_sec,
                selected_ids=[int(agent["id"]) for agent in selected],
            ),
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "branch": asdict(branch),
                "replicate": replicate,
                "population_agent_ids": [int(agent["id"]) for agent in selected],
                "start_t": start_t,
                "tick_sec": tick_sec,
                "equivalence_contract": [
                    "same population records",
                    "same initial locations and budgets",
                    "same relationships and preferences",
                    "same simulation start time",
                    "same number and duration of run ticks",
                ],
                "known_limitations": [
                    "branches are equivalent-start reruns, not checkpoint clones yet",
                    "LLM provider sampling is not guaranteed deterministic by replicate id",
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return config_path, steps_path, run_dir


async def _run_one(
    branch: BranchSpec,
    *,
    replicate: int,
    config_path: Path,
    steps_path: Path,
    run_dir: Path,
    batch_size: int | None,
) -> None:
    from agentsociety2.society.cli import ExperimentRunner

    runner = ExperimentRunner(run_dir)
    await runner.run(
        config_path,
        steps_path,
        experiment_id=f"{branch.branch_id}_r{replicate:03d}",
        batch_size=batch_size,
    )


def _state_path(run_dir: Path) -> Path:
    return (
        run_dir
        / "env"
        / "AllegoryTownSpace"
        / "state"
        / "ALLEGORY_TOWN_STATE.json"
    )


def _summarize_run(branch: BranchSpec, replicate: int, run_dir: Path) -> dict[str, Any]:
    path = _state_path(run_dir)
    if not path.is_file():
        return {
            "branch_id": branch.branch_id,
            "replicate": replicate,
            "status": "missing_state",
        }
    state = json.loads(path.read_text(encoding="utf-8"))
    agents = state.get("agents", {})
    events = state.get("events", [])
    product_id = "pulse_mini"
    aware = sum(
        float(agent.get("awareness", {}).get(product_id, 0)) > 0
        for agent in agents.values()
    )
    purchased = sum(product_id in agent.get("purchased", []) for agent in agents.values())
    considered = sum(product_id in agent.get("consideration", {}) for agent in agents.values())
    rejected = sum(event.get("event_type") == "purchase_rejected" for event in events)
    conversations = sum(event.get("event_type") == "conversation" for event in events)
    exposures = sum(event.get("event_type") == "product_exposed" for event in events)
    return {
        "branch_id": branch.branch_id,
        "label": branch.label,
        "replicate": replicate,
        "status": "completed",
        "product_price": branch.product_price,
        "campaign_enabled": branch.campaign_enabled,
        "agent_count": len(agents),
        "aware_agents": aware,
        "considering_agents": considered,
        "purchasing_agents": purchased,
        "purchase_rejections": rejected,
        "conversations": conversations,
        "exposures": exposures,
        "event_count": len(events),
        "simulation_steps": int(state.get("step_counter", 0)),
    }


def _aggregate(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row["branch_id"]), []).append(row)
    aggregates: list[dict[str, Any]] = []
    for branch_id, branch_rows in groups.items():
        completed = [row for row in branch_rows if row.get("status") == "completed"]
        if not completed:
            aggregates.append({"branch_id": branch_id, "completed_replicates": 0})
            continue
        metrics = [
            "aware_agents",
            "considering_agents",
            "purchasing_agents",
            "purchase_rejections",
            "conversations",
            "exposures",
        ]
        aggregate: dict[str, Any] = {
            "branch_id": branch_id,
            "label": completed[0].get("label"),
            "completed_replicates": len(completed),
        }
        for metric in metrics:
            values = [float(row.get(metric, 0)) for row in completed]
            aggregate[f"{metric}_mean"] = round(sum(values) / len(values), 4)
            aggregate[f"{metric}_min"] = min(values)
            aggregate[f"{metric}_max"] = max(values)
        aggregates.append(aggregate)
    return aggregates


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stage",
        choices=["all", "config", "simulate", "summarize"],
        default="all",
    )
    parser.add_argument("--num-agents", type=int, default=10)
    parser.add_argument("--replicates", type=int, default=1)
    parser.add_argument("--tick-sec", type=int, default=1800)
    parser.add_argument("--start-t", default="2026-08-03T08:00:00")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument(
        "--branches",
        nargs="*",
        default=None,
        help="Optional branch ids; defaults to all built-in branches",
    )
    return parser.parse_args()


async def async_main(args: argparse.Namespace) -> None:
    if args.replicates < 1:
        raise ValueError("replicates must be at least 1")
    selected = _selected_agents(args.num_agents)
    selected_branch_ids = set(args.branches or [])
    branches = [
        branch
        for branch in DEFAULT_BRANCHES
        if not selected_branch_ids or branch.branch_id in selected_branch_ids
    ]
    unknown = selected_branch_ids - {branch.branch_id for branch in DEFAULT_BRANCHES}
    if unknown:
        raise ValueError(f"Unknown branch ids: {sorted(unknown)}")

    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    planned: list[tuple[BranchSpec, int, Path, Path, Path]] = []
    for branch in branches:
        for replicate in range(1, args.replicates + 1):
            config_path, steps_path, run_dir = _write_branch_files(
                branch,
                replicate=replicate,
                output_root=output_root,
                selected=selected,
                start_t=args.start_t,
                tick_sec=args.tick_sec,
            )
            planned.append((branch, replicate, config_path, steps_path, run_dir))

    if args.stage in {"all", "simulate"}:
        for branch, replicate, config_path, steps_path, run_dir in planned:
            print(f"Running {branch.branch_id} replicate {replicate}", flush=True)
            await _run_one(
                branch,
                replicate=replicate,
                config_path=config_path,
                steps_path=steps_path,
                run_dir=run_dir,
                batch_size=args.batch_size,
            )

    if args.stage in {"all", "summarize"}:
        rows = [
            _summarize_run(branch, replicate, run_dir)
            for branch, replicate, _config, _steps, run_dir in planned
        ]
        report = {
            "schema_version": 1,
            "comparison_type": "equivalent_start_counterfactuals",
            "rows": rows,
            "aggregates": _aggregate(rows),
            "warning": (
                "These are simulated outcomes. Replicate ids do not yet guarantee "
                "deterministic LLM sampling or human behavioural validity."
            ),
        }
        report_path = output_root / "futures_summary.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"Wrote {report_path}")


def main() -> None:
    asyncio.run(async_main(parse_args()))


if __name__ == "__main__":
    main()
