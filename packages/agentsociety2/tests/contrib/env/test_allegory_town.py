from __future__ import annotations

from datetime import datetime, timezone

import pytest

from agentsociety2.contrib.env.allegory_town import AllegoryTownSpace


def _locations() -> list[dict]:
    return [
        {
            "id": "home_a",
            "name": "Home A",
            "kind": "home",
            "x": 0,
            "y": 0,
            "neighbors": ["junction"],
        },
        {
            "id": "home_b",
            "name": "Home B",
            "kind": "home",
            "x": 0,
            "y": 2,
            "neighbors": ["junction"],
        },
        {
            "id": "junction",
            "name": "Town Junction",
            "kind": "street",
            "x": 2,
            "y": 1,
            "neighbors": ["home_a", "home_b", "office", "shop", "park"],
        },
        {
            "id": "office",
            "name": "Office",
            "kind": "workplace",
            "x": 4,
            "y": 0,
            "neighbors": ["junction"],
        },
        {
            "id": "shop",
            "name": "Corner Shop",
            "kind": "shop",
            "x": 4,
            "y": 2,
            "neighbors": ["junction"],
        },
        {
            "id": "park",
            "name": "Pocket Park",
            "kind": "park",
            "x": 2,
            "y": 3,
            "neighbors": ["junction"],
        },
    ]


def _agents() -> list[dict]:
    return [
        {
            "id": 1,
            "name": "Alice",
            "location_id": "home_a",
            "home_id": "home_a",
            "work_id": "office",
            "budget": 200,
            "sociability": 0.8,
            "price_sensitivity": 0.3,
            "preferences": {"audio": 0.9},
            "relationships": {2: 0.8},
        },
        {
            "id": 2,
            "name": "Bob",
            "location_id": "home_b",
            "home_id": "home_b",
            "work_id": "office",
            "budget": 120,
            "sociability": 0.6,
            "price_sensitivity": 0.7,
            "preferences": {"audio": 0.55},
            "relationships": {1: 0.9},
        },
    ]


def _products() -> list[dict]:
    return [
        {
            "id": "product_alpha",
            "name": "Pocket Speaker",
            "category": "audio",
            "price": 50,
            "store_id": "shop",
        }
    ]


def _town() -> AllegoryTownSpace:
    return AllegoryTownSpace(
        locations=_locations(),
        agents=_agents(),
        products=_products(),
    )


@pytest.mark.asyncio
async def test_route_exposure_consideration_and_purchase() -> None:
    town = _town()
    await town.init(datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc))

    movement = await town.move_to(1, "shop")
    exposure = await town.expose_to_product(1, "product_alpha")
    consideration = await town.consider_product(1, "product_alpha")
    purchase = await town.purchase_product(1, "product_alpha")

    assert movement.path == ["home_a", "junction", "shop"]
    assert exposure.awareness_after == pytest.approx(0.75)
    assert consideration.score >= 0.45
    assert purchase.purchased is True
    assert purchase.remaining_budget == pytest.approx(150)

    statistics = await town.get_town_statistics()
    assert statistics.purchases_by_product == {"product_alpha": 1}
    assert statistics.awareness_by_product == {"product_alpha": 1}

    event_batch = await town.get_recent_events()
    event_types = [event.event_type for event in event_batch.events]
    assert event_types == [
        "simulation_started",
        "movement_started",
        "movement_completed",
        "product_exposed",
        "product_considered",
        "product_purchased",
    ]


@pytest.mark.asyncio
async def test_conversation_propagates_awareness_only_when_colocated() -> None:
    town = _town()
    await town.init(datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc))
    await town.expose_to_product(1, "product_alpha")

    with pytest.raises(ValueError, match="same location"):
        await town.talk_to(
            1,
            2,
            topic="product_alpha",
            content="This speaker looks useful.",
        )

    await town.move_to(1, "park")
    await town.move_to(2, "park")
    conversation = await town.talk_to(
        1,
        2,
        topic="product_alpha",
        content="This speaker looks useful.",
    )

    bob = await town.observe_agent(2)
    assert conversation.awareness_transferred > 0
    assert bob.awareness["product_alpha"] > 0
    assert any(event.event_type == "conversation" for event in bob.recent_events)


@pytest.mark.asyncio
async def test_purchase_constraints_are_recorded_as_events() -> None:
    town = _town()
    await town.init(datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc))
    await town.expose_to_product(2, "product_alpha")

    rejected = await town.purchase_product(2, "product_alpha")

    assert rejected.purchased is False
    assert rejected.reason == "agent_is_not_at_the_store"
    events = await town.get_recent_events()
    assert events.events[-1].event_type == "purchase_rejected"
    assert events.events[-1].payload["reason"] == "agent_is_not_at_the_store"


@pytest.mark.asyncio
async def test_workspace_round_trip_preserves_state_and_event_cursor(tmp_path) -> None:
    town = _town()
    start = datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc)
    await town.init(start)
    await town.move_to(1, "shop")
    await town.expose_to_product(1, "product_alpha")
    await town.to_workspace(tmp_path)

    restored = _town()
    assert await restored.restore(tmp_path) is True

    alice = await restored.observe_agent(1)
    events = await restored.get_recent_events()
    assert alice.location.id == "shop"
    assert alice.awareness["product_alpha"] == pytest.approx(0.75)
    assert events.next_sequence == 4

    next_batch = await restored.get_recent_events(after_sequence=2)
    assert [event.sequence for event in next_batch.events] == [3, 4]
