# Allegory micro-society v0.1

This vertical slice keeps AgentSociety 2 intact and adds Allegory's first
commercial, observer-ready society layer.

It contains:

- ten persistent `PersonAgent` residents;
- four households, an office, shop, cafe, park, paths, and a town square;
- budgets, product preferences, price sensitivity, relationships, and routines;
- deterministic movement, advertising, conversation, consideration, and
  purchase constraints in `AllegoryTownSpace`;
- an append-only domain event stream for living graphical observers;
- AgentSociety replay, trace, checkpoint, resume, memory, questionnaires, Ray
  batching, and model-provider support without removing or weakening them;
- a fixture replay at `/allegory-town` and a live SSE observer at
  `/allegory-live`;
- equivalent-start baseline and intervention orchestration in `run_futures.py`.

## Run the fixture observer

The checked-in fixture lets frontend development proceed without spending LLM
tokens:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173/allegory-town`.

The page replays `frontend/public/allegory/demo.json`. A completed AgentSociety
run exports the same contract to `tmp/run/allegory_observer.json`.

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

## Run the live observer

The backend reads persisted `AllegoryTownSpace` state and exposes a secure,
read-only snapshot, cursor endpoint, and Server-Sent Events stream.

Set the backend's allowed workspace root and start it:

```bash
export WORKSPACE_PATH="$(pwd)"
cd packages/agentsociety2
uv run python -m agentsociety2.backend.run
```

Start the frontend in another terminal:

```bash
cd frontend
VITE_API_BASE_URL="http://localhost:8001" npm run dev
```

Open the live route with the absolute configured workspace and a run directory
relative to that workspace:

```text
http://localhost:5173/allegory-live?workspace=/absolute/path/to/AgentSociety&run=examples/v2/allegory_micro_society/tmp/run
```

The browser subscribes to:

```text
GET /api/v1/allegory/observer/snapshot
GET /api/v1/allegory/observer/events
GET /api/v1/allegory/observer/stream
```

The API never mutates the simulation. `WORKSPACE_PATH` and the repository's path
security helpers prevent the observer from reading outside the configured root.

## Run alternative futures

Generate four equivalent-start branches:

- no-campaign baseline at $49;
- campaign at $49;
- campaign at $69;
- value-oriented campaign at $69.

```bash
uv run python examples/v2/allegory_micro_society/run_futures.py --stage config
```

Run all branches and produce `futures_summary.json`:

```bash
uv run python examples/v2/allegory_micro_society/run_futures.py \
  --stage all \
  --replicates 3
```

Run only selected branches:

```bash
uv run python examples/v2/allegory_micro_society/run_futures.py \
  --branches baseline_no_campaign campaign_price_49 \
  --replicates 2
```

Each branch receives the same population records, initial locations, budgets,
relationships, preferences, start time, and number of simulation ticks. Only
explicit scenario inputs differ.

This is currently **equivalent-start rerunning**, not checkpoint cloning. Also,
replicate numbers do not yet guarantee deterministic LLM sampling. The summary
therefore reports run-to-run ranges and does not present one run as a calibrated
human prediction.

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

## Verification

A dedicated GitHub Actions workflow checks:

- compilation of Allegory experiment runners;
- Ruff on the environment, observer backend, and tests;
- environment and observer unit tests;
- frontend production build;
- frontend ESLint.

The real LLM run remains an explicit manual/integration test because it requires
a configured model endpoint and incurs model cost.

## Current boundary

This is the first bounded society, not a claim that the platform already
predicts real consumers. The ten profiles are development fixtures. Human
interviews, population weighting, behavioural validation, checkpoint-level
counterfactual cloning, confidence estimation, customer tenancy, and production
authentication remain separate Allegory milestones.

Population size remains configuration-driven. Ten agents are used because every
memory, action, event, route, budget, and rendered state can be inspected during
the first correctness pass; AgentSociety 2 batching and persistence remain
intact for later 100, 1,000, and 10,000-agent tests.
