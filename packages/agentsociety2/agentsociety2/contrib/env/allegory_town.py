"""Allegory's first bounded, replayable society environment.

The module intentionally keeps the world mechanics deterministic while leaving
interpretation and choice to AgentSociety ``PersonAgent`` instances.  It models
locations, movement, relationships, product awareness, conversation,
consideration, purchases, and an append-only domain event stream suitable for a
Smallville-style observer.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from agentsociety2.env import EnvBase, tool
from agentsociety2.storage import ColumnDef
from agentsociety2.storage.workspace_state import atomic_write_text

_STATE_REL = "state/ALLEGORY_TOWN_STATE.json"


class LocationSpec(BaseModel):
    """A logical location and its position in the visual town."""

    id: str
    name: str
    kind: Literal[
        "home", "workplace", "shop", "park", "cafe", "street", "other"
    ] = "other"
    x: float
    y: float
    neighbors: list[str] = Field(default_factory=list)


class ProductSpec(BaseModel):
    """A product available at one town location."""

    id: str
    name: str
    category: str
    price: float = Field(ge=0)
    store_id: str


class TownAgentSpec(BaseModel):
    """Stable attributes used by the deterministic society mechanics."""

    id: int
    name: str
    location_id: str
    home_id: str
    work_id: str | None = None
    budget: float = Field(ge=0)
    sociability: float = Field(default=0.5, ge=0, le=1)
    price_sensitivity: float = Field(default=0.5, ge=0, le=1)
    preferences: dict[str, float] = Field(default_factory=dict)
    relationships: dict[int, float] = Field(default_factory=dict)


class TownAgentState(BaseModel):
    """Mutable state persisted between simulation ticks."""

    location_id: str
    activity: str = "idle"
    budget: float
    awareness: dict[str, float] = Field(default_factory=dict)
    consideration: dict[str, float] = Field(default_factory=dict)
    purchased: list[str] = Field(default_factory=list)


class TownEvent(BaseModel):
    """Version-one domain event consumed by Allegory's visual observer."""

    sequence: int
    event_type: str
    simulation_time: datetime
    actor_id: int | None = None
    target_id: int | None = None
    location_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AgentObservation(BaseModel):
    """Agent-facing view of the town and its local social context."""

    agent_id: int
    name: str
    location: LocationSpec
    activity: str
    budget: float
    colocated_agents: list[dict[str, Any]]
    available_products: list[ProductSpec]
    awareness: dict[str, float]
    consideration: dict[str, float]
    purchased: list[str]
    recent_events: list[TownEvent]


class MoveResponse(BaseModel):
    agent_id: int
    origin_id: str
    destination_id: str
    path: list[str]
    duration_minutes: int


class ActivityResponse(BaseModel):
    agent_id: int
    activity: str
    location_id: str


class ExposureResponse(BaseModel):
    agent_id: int
    product_id: str
    awareness_before: float
    awareness_after: float
    source: str


class ConversationResponse(BaseModel):
    sender_id: int
    receiver_id: int
    topic: str
    location_id: str
    awareness_transferred: float


class ConsiderationResponse(BaseModel):
    agent_id: int
    product_id: str
    score: float
    recommendation: Literal[
        "unlikely", "possible_interest", "strong_interest"
    ]


class PurchaseResponse(BaseModel):
    agent_id: int
    product_id: str
    purchased: bool
    reason: str
    remaining_budget: float


class EventBatch(BaseModel):
    after_sequence: int
    next_sequence: int
    events: list[TownEvent]


class TownStatistics(BaseModel):
    simulation_step: int
    agent_count: int
    event_count: int
    conversations: int
    ad_exposures: int
    purchases_by_product: dict[str, int]
    awareness_by_product: dict[str, int]


class AllegoryTownSpace(EnvBase):
    """A bounded social world for Allegory's first commercial simulation."""

    _agent_state_columns: ClassVar[list[ColumnDef]] = [
        ColumnDef("location_id", "VARCHAR"),
        ColumnDef("activity", "VARCHAR"),
        ColumnDef("budget", "DOUBLE"),
        ColumnDef("aware_products", "INTEGER"),
        ColumnDef("purchased_products", "INTEGER"),
    ]
    _env_state_columns: ClassVar[list[ColumnDef]] = [
        ColumnDef("event_count", "INTEGER"),
        ColumnDef("conversation_count", "INTEGER"),
        ColumnDef("ad_exposure_count", "INTEGER"),
        ColumnDef("purchase_count", "INTEGER"),
    ]

    def __init__(
        self,
        locations: list[dict[str, Any]],
        agents: list[dict[str, Any]],
        products: list[dict[str, Any]],
    ) -> None:
        super().__init__()
        location_specs = [LocationSpec.model_validate(item) for item in locations]
        agent_specs = [TownAgentSpec.model_validate(item) for item in agents]
        product_specs = [ProductSpec.model_validate(item) for item in products]

        self._locations = self._unique_by_id(location_specs, "location")
        self._agent_specs = self._unique_by_id(agent_specs, "agent")
        self._products = self._unique_by_id(product_specs, "product")
        self._validate_references()

        self._agents: dict[int, TownAgentState] = {
            agent_id: TownAgentState(
                location_id=spec.location_id,
                budget=spec.budget,
            )
            for agent_id, spec in self._agent_specs.items()
        }
        self._events: list[TownEvent] = []
        self._event_sequence = 0
        self._step_counter = 0
        self._conversation_count = 0
        self._ad_exposure_count = 0
        self._purchase_count = 0
        self._lock = asyncio.Lock()

    @staticmethod
    def _unique_by_id(items: list[BaseModel], label: str) -> dict[Any, Any]:
        result: dict[Any, Any] = {}
        for item in items:
            item_id = getattr(item, "id")
            if item_id in result:
                raise ValueError(f"Duplicate {label} id: {item_id!r}")
            result[item_id] = item
        if not result:
            raise ValueError(f"At least one {label} is required")
        return result

    def _validate_references(self) -> None:
        location_ids = set(self._locations)
        agent_ids = set(self._agent_specs)

        for location in self._locations.values():
            unknown = set(location.neighbors) - location_ids
            if unknown:
                raise ValueError(
                    f"Location {location.id!r} has unknown neighbors: {sorted(unknown)}"
                )

        for agent in self._agent_specs.values():
            referenced_locations = {
                agent.location_id,
                agent.home_id,
                *([agent.work_id] if agent.work_id else []),
            }
            unknown_locations = referenced_locations - location_ids
            if unknown_locations:
                raise ValueError(
                    f"Agent {agent.id} references unknown locations: "
                    f"{sorted(unknown_locations)}"
                )
            unknown_agents = set(agent.relationships) - agent_ids
            if unknown_agents:
                raise ValueError(
                    f"Agent {agent.id} references unknown agents: "
                    f"{sorted(unknown_agents)}"
                )

        for product in self._products.values():
            if product.store_id not in location_ids:
                raise ValueError(
                    f"Product {product.id!r} references unknown store "
                    f"{product.store_id!r}"
                )

    @classmethod
    def description(cls) -> str:
        return (
            "A persistent micro-society with locations, movement, social influence, "
            "product awareness, consideration, purchases, and observer-ready events."
        )

    @classmethod
    def init_description(cls) -> str:
        return """AllegoryTownSpace: bounded society environment for product-launch experiments.

Initialization parameters:
- locations: list of {id, name, kind, x, y, neighbors}
- agents: list of {id, name, location_id, home_id, work_id, budget,
  sociability, price_sensitivity, preferences, relationships}
- products: list of {id, name, category, price, store_id}

The module exposes observation, movement, activity, advertising, conversation,
consideration, purchase, statistics, and append-only event-stream tools.
"""

    async def init(self, start_datetime: datetime) -> None:
        await super().init(start_datetime)
        if not self._events:
            self._record_event(
                "simulation_started",
                payload={
                    "agent_count": len(self._agents),
                    "location_count": len(self._locations),
                    "product_count": len(self._products),
                },
            )

    async def step(self, tick: int, t: datetime) -> None:
        """Advance time and export one complete observer snapshot."""
        self.t = t
        self._step_counter += 1
        records = [
            {
                "agent_id": agent_id,
                "location_id": state.location_id,
                "activity": state.activity,
                "budget": state.budget,
                "aware_products": len(state.awareness),
                "purchased_products": len(state.purchased),
            }
            for agent_id, state in sorted(self._agents.items())
        ]
        await self._write_agent_state_batch(self._step_counter, t, records)
        await self._write_env_state(
            self._step_counter,
            t,
            event_count=len(self._events),
            conversation_count=self._conversation_count,
            ad_exposure_count=self._ad_exposure_count,
            purchase_count=self._purchase_count,
        )

    @tool(readonly=True, kind="observe")
    async def observe_agent(self, agent_id: int) -> AgentObservation:
        """Observe an agent's local world, finances, products, and recent events."""
        async with self._lock:
            spec = self._require_agent_spec(agent_id)
            state = self._require_agent_state(agent_id)
            colocated = [
                {
                    "id": other_id,
                    "name": self._agent_specs[other_id].name,
                    "activity": other_state.activity,
                    "relationship_strength": spec.relationships.get(other_id, 0.0),
                }
                for other_id, other_state in sorted(self._agents.items())
                if other_id != agent_id
                and other_state.location_id == state.location_id
            ]
            products = [
                product
                for product in self._products.values()
                if product.store_id == state.location_id
            ]
            relevant_events = [
                event
                for event in self._events[-30:]
                if event.actor_id == agent_id
                or event.target_id == agent_id
                or event.location_id == state.location_id
            ][-10:]
            return AgentObservation(
                agent_id=agent_id,
                name=spec.name,
                location=self._locations[state.location_id],
                activity=state.activity,
                budget=state.budget,
                colocated_agents=colocated,
                available_products=products,
                awareness=dict(state.awareness),
                consideration=dict(state.consideration),
                purchased=list(state.purchased),
                recent_events=relevant_events,
            )

    @tool(readonly=True, kind="statistics")
    async def get_town_statistics(self) -> TownStatistics:
        """Return aggregate, non-narrative metrics for the current society."""
        async with self._lock:
            purchases_by_product = {
                product_id: sum(
                    product_id in state.purchased for state in self._agents.values()
                )
                for product_id in self._products
            }
            awareness_by_product = {
                product_id: sum(
                    state.awareness.get(product_id, 0.0) > 0
                    for state in self._agents.values()
                )
                for product_id in self._products
            }
            return TownStatistics(
                simulation_step=self._step_counter,
                agent_count=len(self._agents),
                event_count=len(self._events),
                conversations=self._conversation_count,
                ad_exposures=self._ad_exposure_count,
                purchases_by_product=purchases_by_product,
                awareness_by_product=awareness_by_product,
            )

    @tool(readonly=True)
    async def get_recent_events(
        self, after_sequence: int = 0, limit: int = 100
    ) -> EventBatch:
        """Read observer events after a cursor without mutating the simulation."""
        safe_limit = min(max(int(limit), 1), 1000)
        async with self._lock:
            events = [
                event for event in self._events if event.sequence > after_sequence
            ][:safe_limit]
            next_sequence = events[-1].sequence if events else after_sequence
            return EventBatch(
                after_sequence=after_sequence,
                next_sequence=next_sequence,
                events=events,
            )

    @tool(readonly=False)
    async def move_to(self, agent_id: int, destination_id: str) -> MoveResponse:
        """Move an agent through the logical navigation graph."""
        async with self._lock:
            state = self._require_agent_state(agent_id)
            if destination_id not in self._locations:
                raise ValueError(f"Unknown destination: {destination_id!r}")
            origin_id = state.location_id
            path = self._shortest_path(origin_id, destination_id)
            duration_minutes = max(1, (len(path) - 1) * 5)
            visual_path = [
                {
                    "location_id": location_id,
                    "x": self._locations[location_id].x,
                    "y": self._locations[location_id].y,
                }
                for location_id in path
            ]
            self._record_event(
                "movement_started",
                actor_id=agent_id,
                location_id=origin_id,
                payload={
                    "origin_id": origin_id,
                    "destination_id": destination_id,
                    "path": path,
                    "visual_path": visual_path,
                    "duration_minutes": duration_minutes,
                },
            )
            state.activity = "walking"
            state.location_id = destination_id
            state.activity = "idle"
            self._record_event(
                "movement_completed",
                actor_id=agent_id,
                location_id=destination_id,
                payload={
                    "origin_id": origin_id,
                    "destination_id": destination_id,
                    "path": path,
                    "duration_minutes": duration_minutes,
                },
            )
            return MoveResponse(
                agent_id=agent_id,
                origin_id=origin_id,
                destination_id=destination_id,
                path=path,
                duration_minutes=duration_minutes,
            )

    @tool(readonly=False)
    async def set_activity(self, agent_id: int, activity: str) -> ActivityResponse:
        """Set the visible activity performed by an agent at its current location."""
        cleaned = activity.strip()
        if not cleaned:
            raise ValueError("activity cannot be empty")
        async with self._lock:
            state = self._require_agent_state(agent_id)
            previous = state.activity
            state.activity = cleaned
            self._record_event(
                "activity_changed",
                actor_id=agent_id,
                location_id=state.location_id,
                payload={"previous": previous, "activity": cleaned},
            )
            return ActivityResponse(
                agent_id=agent_id,
                activity=cleaned,
                location_id=state.location_id,
            )

    @tool(readonly=False)
    async def expose_to_product(
        self,
        agent_id: int,
        product_id: str,
        source: str = "advertisement",
    ) -> ExposureResponse:
        """Expose an agent to a product through advertising, media, or a person."""
        async with self._lock:
            state = self._require_agent_state(agent_id)
            self._require_product(product_id)
            before = state.awareness.get(product_id, 0.0)
            exposure_strength = 0.75 if source == "advertisement" else 0.55
            after = max(before, exposure_strength)
            state.awareness[product_id] = after
            self._ad_exposure_count += 1
            self._record_event(
                "product_exposed",
                actor_id=agent_id,
                location_id=state.location_id,
                payload={
                    "product_id": product_id,
                    "source": source,
                    "awareness_before": before,
                    "awareness_after": after,
                },
            )
            return ExposureResponse(
                agent_id=agent_id,
                product_id=product_id,
                awareness_before=before,
                awareness_after=after,
                source=source,
            )

    @tool(readonly=False)
    async def talk_to(
        self,
        sender_id: int,
        receiver_id: int,
        topic: str,
        content: str,
    ) -> ConversationResponse:
        """Hold a co-located conversation and propagate product awareness."""
        if sender_id == receiver_id:
            raise ValueError("An agent cannot talk to itself")
        if not content.strip():
            raise ValueError("content cannot be empty")
        async with self._lock:
            sender = self._require_agent_state(sender_id)
            receiver = self._require_agent_state(receiver_id)
            if sender.location_id != receiver.location_id:
                raise ValueError("Agents must be at the same location to talk")

            transferred = 0.0
            if topic in self._products:
                sender_awareness = sender.awareness.get(topic, 0.0)
                trust = self._agent_specs[receiver_id].relationships.get(
                    sender_id, 0.15
                )
                before = receiver.awareness.get(topic, 0.0)
                transferred = sender_awareness * (0.35 + 0.55 * trust)
                receiver.awareness[topic] = max(before, min(1.0, transferred))
                if topic in sender.purchased:
                    receiver.consideration[topic] = min(
                        1.0,
                        receiver.consideration.get(topic, 0.0) + 0.2 * trust,
                    )

            self._conversation_count += 1
            self._record_event(
                "conversation",
                actor_id=sender_id,
                target_id=receiver_id,
                location_id=sender.location_id,
                payload={
                    "topic": topic,
                    "content": content,
                    "awareness_transferred": transferred,
                },
            )
            return ConversationResponse(
                sender_id=sender_id,
                receiver_id=receiver_id,
                topic=topic,
                location_id=sender.location_id,
                awareness_transferred=transferred,
            )

    @tool(readonly=False)
    async def consider_product(
        self, agent_id: int, product_id: str
    ) -> ConsiderationResponse:
        """Evaluate interest using awareness, preference, affordability, and price."""
        async with self._lock:
            state = self._require_agent_state(agent_id)
            product = self._require_product(product_id)
            score = self._consideration_score(agent_id, product)
            state.consideration[product_id] = score
            if score >= 0.7:
                recommendation = "strong_interest"
            elif score >= 0.45:
                recommendation = "possible_interest"
            else:
                recommendation = "unlikely"
            self._record_event(
                "product_considered",
                actor_id=agent_id,
                location_id=state.location_id,
                payload={
                    "product_id": product_id,
                    "score": score,
                    "recommendation": recommendation,
                },
            )
            return ConsiderationResponse(
                agent_id=agent_id,
                product_id=product_id,
                score=score,
                recommendation=recommendation,
            )

    @tool(readonly=False)
    async def purchase_product(
        self, agent_id: int, product_id: str
    ) -> PurchaseResponse:
        """Attempt a constrained purchase and record either outcome."""
        async with self._lock:
            state = self._require_agent_state(agent_id)
            product = self._require_product(product_id)
            reason = "purchased"
            purchased = False

            if state.location_id != product.store_id:
                reason = "agent_is_not_at_the_store"
            elif product_id in state.purchased:
                reason = "already_purchased"
            elif state.budget < product.price:
                reason = "insufficient_budget"
            elif state.awareness.get(product_id, 0.0) <= 0:
                reason = "not_aware_of_product"
            else:
                score = state.consideration.get(product_id)
                if score is None:
                    score = self._consideration_score(agent_id, product)
                    state.consideration[product_id] = score
                if score < 0.45:
                    reason = "interest_below_purchase_threshold"
                else:
                    state.budget = round(state.budget - product.price, 2)
                    state.purchased.append(product_id)
                    purchased = True
                    self._purchase_count += 1

            self._record_event(
                "product_purchased" if purchased else "purchase_rejected",
                actor_id=agent_id,
                location_id=state.location_id,
                payload={
                    "product_id": product_id,
                    "price": product.price,
                    "reason": reason,
                    "remaining_budget": state.budget,
                },
            )
            return PurchaseResponse(
                agent_id=agent_id,
                product_id=product_id,
                purchased=purchased,
                reason=reason,
                remaining_budget=state.budget,
            )

    def _consideration_score(self, agent_id: int, product: ProductSpec) -> float:
        spec = self._agent_specs[agent_id]
        state = self._agents[agent_id]
        awareness = state.awareness.get(product.id, 0.0)
        preference = min(max(spec.preferences.get(product.category, 0.5), 0.0), 1.0)
        affordability = min(1.0, state.budget / max(product.price, 0.01))
        price_burden = min(1.0, product.price / max(state.budget, product.price, 0.01))
        price_fit = max(0.0, 1.0 - spec.price_sensitivity * price_burden)
        prior_social_signal = state.consideration.get(product.id, 0.0)
        score = (
            0.35 * awareness
            + 0.30 * preference
            + 0.20 * affordability
            + 0.10 * price_fit
            + 0.05 * prior_social_signal
        )
        return round(min(max(score, 0.0), 1.0), 4)

    def _shortest_path(self, origin_id: str, destination_id: str) -> list[str]:
        if origin_id == destination_id:
            return [origin_id]
        queue: deque[list[str]] = deque([[origin_id]])
        visited = {origin_id}
        while queue:
            path = queue.popleft()
            for neighbor in self._locations[path[-1]].neighbors:
                if neighbor in visited:
                    continue
                next_path = [*path, neighbor]
                if neighbor == destination_id:
                    return next_path
                visited.add(neighbor)
                queue.append(next_path)
        raise ValueError(
            f"No route exists between {origin_id!r} and {destination_id!r}"
        )

    def _record_event(
        self,
        event_type: str,
        *,
        actor_id: int | None = None,
        target_id: int | None = None,
        location_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> TownEvent:
        self._event_sequence += 1
        event = TownEvent(
            sequence=self._event_sequence,
            event_type=event_type,
            simulation_time=self.t,
            actor_id=actor_id,
            target_id=target_id,
            location_id=location_id,
            payload=payload or {},
        )
        self._events.append(event)
        return event

    def _require_agent_spec(self, agent_id: int) -> TownAgentSpec:
        try:
            return self._agent_specs[int(agent_id)]
        except KeyError as exc:
            raise ValueError(f"Unknown agent id: {agent_id}") from exc

    def _require_agent_state(self, agent_id: int) -> TownAgentState:
        try:
            return self._agents[int(agent_id)]
        except KeyError as exc:
            raise ValueError(f"Unknown agent id: {agent_id}") from exc

    def _require_product(self, product_id: str) -> ProductSpec:
        try:
            return self._products[product_id]
        except KeyError as exc:
            raise ValueError(f"Unknown product id: {product_id!r}") from exc

    async def to_workspace(self, workspace_path: Path | None = None) -> None:
        if workspace_path is not None:
            self._bind_workspace(workspace_path)
        if self._workspace_root is None:
            raise RuntimeError("AllegoryTownSpace workspace is not bound")
        payload = {
            "step_counter": self._step_counter,
            "event_sequence": self._event_sequence,
            "conversation_count": self._conversation_count,
            "ad_exposure_count": self._ad_exposure_count,
            "purchase_count": self._purchase_count,
            "agents": {
                str(agent_id): state.model_dump(mode="json")
                for agent_id, state in self._agents.items()
            },
            "events": [event.model_dump(mode="json") for event in self._events],
        }
        atomic_write_text(
            self._workspace_root / _STATE_REL,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )

    async def restore(self, workspace_path: Path) -> bool:
        self._bind_workspace(workspace_path)
        state_path = self._workspace_root / _STATE_REL
        if not state_path.is_file():
            return False
        payload = json.loads(state_path.read_text(encoding="utf-8"))
        self._step_counter = int(payload.get("step_counter", 0))
        self._event_sequence = int(payload.get("event_sequence", 0))
        self._conversation_count = int(payload.get("conversation_count", 0))
        self._ad_exposure_count = int(payload.get("ad_exposure_count", 0))
        self._purchase_count = int(payload.get("purchase_count", 0))
        self._agents = {
            int(agent_id): TownAgentState.model_validate(state)
            for agent_id, state in payload.get("agents", {}).items()
        }
        self._events = [
            TownEvent.model_validate(event) for event in payload.get("events", [])
        ]
        return True
