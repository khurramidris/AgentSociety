# Allegory micro-society v0.1

This vertical slice proves that Allegory can remain an AgentSociety 2-based
system while adding a commercial, observer-ready society layer.

It contains:

- ten persistent `PersonAgent` residents;
- four households, an office, shop, cafe, park, paths, and a town square;
- budgets, product preferences, price sensitivity, relationships, and routines;
- deterministic movement, advertising, conversation, consideration, and
  purchase constraints in `AllegoryTownSpace`;
- an append-only domain event stream for a living graphical observer;
- AgentSociety replay, trace, checkpoint, resume, memory, questionnaires, Ray
  batching, and model-provider support without removing or weakening them;
- a React observer at `/allegory-town` using the same event contract.

## Run the frontend observer

The first checked-in fixture lets frontend development proceed without spending
LLM tokens:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173/allegory-town`.

The page currently replays `frontend/public/allegory/demo.json`. A completed
AgentSociety run exports the same contract to
`tmp/run/allegory_observer.json`.

## Run the real AgentSociety simulation

Set an OpenAI-compatible model endpoint:

```bash
export AGENTSOCIETY_LLM_API_KEY="..."
export AGENTSOCIETY_LLM_API_BASE="https://api.openai.com/v1"
export AGENTSOCIETY_LLM_MODEL="gpt-5.5"
```

Then run:

```bash
uv run python examples/v2/allegory_micro_society/run_all.py
```

Useful options:

```bash
# Generate config only
uv run python examples/v2/allegory_micro_society/run_all.py --stage config

# Smaller correctness run
uv run python examples/v2/allegory_micro_society/run_all.py \
  --num-agents 3 \
  --product-price 49

# Resume an interrupted experiment
uv run python examples/v2/allegory_micro_society/run_all.py \
  --stage simulate \
  --resume

# Export observer JSON from an existing run
uv run python examples/v2/allegory_micro_society/run_all.py --stage export
```

## Event contract

Every visible outcome is derived from a structured event such as:

```json
{
  "sequence": 15,
  "event_type": "product_purchased",
  "simulation_time": "2026-08-03T17:15:00",
  "actor_id": 1,
  "target_id": null,
  "location_id": "shop",
  "payload": {
    "product_id": "pulse_mini",
    "price": 49,
    "reason": "purchased",
    "remaining_budget": 136
  }
}
```

The observer animates accepted simulation events. It does not decide where an
agent goes, what an agent believes, or whether a purchase succeeds.

## Current boundary

This is the first bounded society, not a claim that the platform already
predicts real consumers. The ten profiles are development fixtures. Human
interviews, population weighting, behavioural validation, counterfactual branch
management, repeated futures, confidence estimation, and customer tenancy are
separate Allegory milestones.

Population size remains configuration-driven. Ten agents are used because every
memory, action, event, route, budget, and rendered state can be inspected during
the first correctness pass; the AgentSociety 2 batching and persistence systems
remain intact for later 100, 1,000, and 10,000-agent tests.
