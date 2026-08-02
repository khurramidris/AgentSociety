import {
    PauseCircleOutlined,
    PlayCircleOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import {
    Alert,
    Button,
    Card,
    Col,
    Flex,
    Row,
    Segmented,
    Space,
    Spin,
    Statistic,
    Tag,
    Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

const { Paragraph, Text, Title } = Typography;

type LocationKind =
    | 'home'
    | 'workplace'
    | 'shop'
    | 'park'
    | 'cafe'
    | 'street'
    | 'other';

type TownLocation = {
    id: string;
    name: string;
    kind: LocationKind;
    x: number;
    y: number;
    neighbors: string[];
};

type TownAgent = {
    id: number;
    name: string;
    home_id: string;
    work_id?: string | null;
    location_id: string;
    activity: string;
    budget: number;
    awareness: Record<string, number>;
    consideration: Record<string, number>;
    purchased: string[];
};

type TownEvent = {
    sequence: number;
    event_type: string;
    simulation_time: string;
    actor_id?: number | null;
    target_id?: number | null;
    location_id?: string | null;
    payload: Record<string, unknown>;
};

type ObserverData = {
    schema_version: number;
    scenario_id: string;
    locations: TownLocation[];
    products: Array<{
        id: string;
        name: string;
        category: string;
        price: number;
        store_id: string;
    }>;
    agents: TownAgent[];
    events: TownEvent[];
    last_sequence: number;
    simulation_steps: number;
};

type AgentView = TownAgent & {
    flash?: 'exposure' | 'purchase' | 'conversation';
};

const buildingStyle = (kind: LocationKind): React.CSSProperties => {
    const base: React.CSSProperties = {
        position: 'absolute',
        width: kind === 'street' ? 12 : 112,
        height: kind === 'street' ? 12 : 72,
        transform: 'translate(-50%, -50%)',
        borderRadius: kind === 'street' ? '50%' : 16,
        border: '1px solid rgba(30, 41, 59, 0.16)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: 12,
        fontWeight: 650,
        boxShadow:
            kind === 'street'
                ? 'none'
                : '0 10px 24px rgba(15, 23, 42, 0.08)',
        zIndex: kind === 'street' ? 1 : 2,
    };
    const backgrounds: Record<LocationKind, string> = {
        home: '#fff7ed',
        workplace: '#eef2ff',
        shop: '#fdf2f8',
        park: '#ecfdf5',
        cafe: '#fffbeb',
        street: '#94a3b8',
        other: '#f8fafc',
    };
    return { ...base, background: backgrounds[kind] };
};

const initials = (name: string) =>
    name
        .split(' ')
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

const numberPayload = (event: TownEvent, key: string): number | undefined => {
    const value = event.payload[key];
    return typeof value === 'number' ? value : undefined;
};

const stringPayload = (event: TownEvent, key: string): string | undefined => {
    const value = event.payload[key];
    return typeof value === 'string' ? value : undefined;
};

const eventLabel = (
    event: TownEvent,
    agents: Map<number, TownAgent>,
    products: Map<string, string>,
) => {
    const actor = event.actor_id ? agents.get(event.actor_id)?.name : undefined;
    const target = event.target_id ? agents.get(event.target_id)?.name : undefined;
    const productId = stringPayload(event, 'product_id');
    const product = productId ? products.get(productId) ?? productId : undefined;

    switch (event.event_type) {
        case 'simulation_started':
            return 'The Allegory town simulation started.';
        case 'movement_started':
            return `${actor ?? 'An agent'} started moving toward ${stringPayload(event, 'destination_id') ?? 'a destination'}.`;
        case 'movement_completed':
            return `${actor ?? 'An agent'} arrived at ${stringPayload(event, 'destination_id') ?? event.location_id}.`;
        case 'activity_changed':
            return `${actor ?? 'An agent'} is now ${stringPayload(event, 'activity') ?? 'active'}.`;
        case 'product_exposed':
            return `${actor ?? 'An agent'} encountered an advertisement for ${product ?? 'a product'}.`;
        case 'conversation':
            return `${actor ?? 'An agent'} discussed ${product ?? stringPayload(event, 'topic') ?? 'something'} with ${target ?? 'another resident'}.`;
        case 'product_considered':
            return `${actor ?? 'An agent'} considered ${product ?? 'the product'} with a score of ${numberPayload(event, 'score')?.toFixed(2) ?? '—'}.`;
        case 'product_purchased':
            return `${actor ?? 'An agent'} purchased ${product ?? 'the product'}.`;
        case 'purchase_rejected':
            return `${actor ?? 'An agent'} did not purchase ${product ?? 'the product'}: ${stringPayload(event, 'reason') ?? 'no reason recorded'}.`;
        default:
            return event.event_type.replaceAll('_', ' ');
    }
};

const AllegoryTown = () => {
    const [data, setData] = useState<ObserverData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [agents, setAgents] = useState<Map<number, AgentView>>(new Map());
    const [eventIndex, setEventIndex] = useState(-1);
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch('/allegory/demo.json')
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Observer fixture returned ${response.status}`);
                }
                return (await response.json()) as ObserverData;
            })
            .then((fixture) => {
                if (cancelled) return;
                setData(fixture);
                setAgents(
                    new Map(
                        fixture.agents.map((agent) => [
                            agent.id,
                            { ...agent, awareness: {}, consideration: {}, purchased: [] },
                        ]),
                    ),
                );
            })
            .catch((caught: unknown) => {
                if (!cancelled) {
                    setError(caught instanceof Error ? caught.message : String(caught));
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const locationMap = useMemo(
        () => new Map(data?.locations.map((location) => [location.id, location]) ?? []),
        [data],
    );
    const sourceAgentMap = useMemo(
        () => new Map(data?.agents.map((agent) => [agent.id, agent]) ?? []),
        [data],
    );
    const productMap = useMemo(
        () => new Map(data?.products.map((product) => [product.id, product.name]) ?? []),
        [data],
    );

    const reset = useCallback(() => {
        if (!data) return;
        setPlaying(false);
        setEventIndex(-1);
        setAgents(
            new Map(
                data.agents.map((agent) => [
                    agent.id,
                    { ...agent, awareness: {}, consideration: {}, purchased: [] },
                ]),
            ),
        );
        setSelectedAgentId(null);
    }, [data]);

    const applyEvent = useCallback((event: TownEvent) => {
        setAgents((previous) => {
            const next = new Map(
                Array.from(previous.entries()).map(([id, agent]) => [
                    id,
                    { ...agent, flash: undefined },
                ]),
            );
            if (!event.actor_id) return next;
            const actor = next.get(event.actor_id);
            if (!actor) return next;

            if (event.event_type === 'movement_completed') {
                const destination = stringPayload(event, 'destination_id');
                if (destination) actor.location_id = destination;
                actor.activity = 'idle';
            } else if (event.event_type === 'movement_started') {
                actor.activity = 'walking';
            } else if (event.event_type === 'activity_changed') {
                actor.activity = stringPayload(event, 'activity') ?? actor.activity;
            } else if (event.event_type === 'product_exposed') {
                const productId = stringPayload(event, 'product_id');
                const awareness = numberPayload(event, 'awareness_after');
                if (productId && awareness !== undefined) {
                    actor.awareness = { ...actor.awareness, [productId]: awareness };
                }
                actor.flash = 'exposure';
            } else if (event.event_type === 'product_considered') {
                const productId = stringPayload(event, 'product_id');
                const score = numberPayload(event, 'score');
                if (productId && score !== undefined) {
                    actor.consideration = {
                        ...actor.consideration,
                        [productId]: score,
                    };
                }
            } else if (event.event_type === 'product_purchased') {
                const productId = stringPayload(event, 'product_id');
                if (productId && !actor.purchased.includes(productId)) {
                    actor.purchased = [...actor.purchased, productId];
                }
                const budget = numberPayload(event, 'remaining_budget');
                if (budget !== undefined) actor.budget = budget;
                actor.flash = 'purchase';
            } else if (event.event_type === 'conversation') {
                actor.flash = 'conversation';
                if (event.target_id) {
                    const target = next.get(event.target_id);
                    if (target) target.flash = 'conversation';
                }
            }
            next.set(actor.id, { ...actor });
            return next;
        });
    }, []);

    useEffect(() => {
        if (!playing || !data) return;
        if (eventIndex >= data.events.length - 1) {
            setPlaying(false);
            return;
        }
        const timer = window.setTimeout(() => {
            const nextIndex = eventIndex + 1;
            applyEvent(data.events[nextIndex]);
            setEventIndex(nextIndex);
        }, 1100 / speed);
        return () => window.clearTimeout(timer);
    }, [applyEvent, data, eventIndex, playing, speed]);

    const currentEvent =
        data && eventIndex >= 0 ? data.events[eventIndex] : undefined;
    const selectedAgent = selectedAgentId ? agents.get(selectedAgentId) : undefined;
    const recentEvents = data
        ? data.events.slice(Math.max(0, eventIndex - 9), eventIndex + 1).reverse()
        : [];
    const awareCount = Array.from(agents.values()).filter(
        (agent) => Object.keys(agent.awareness).length > 0,
    ).length;
    const purchaseCount = Array.from(agents.values()).reduce(
        (total, agent) => total + agent.purchased.length,
        0,
    );

    if (error) {
        return (
            <div style={{ padding: 32 }}>
                <Alert type="error" showIcon message="Unable to load Allegory observer" description={error} />
            </div>
        );
    }
    if (!data) {
        return (
            <Flex align="center" justify="center" style={{ minHeight: 600 }}>
                <Spin size="large" />
            </Flex>
        );
    }

    return (
        <div style={{ padding: 20, background: '#f8fafc', minHeight: '100%' }}>
            <Flex align="center" justify="space-between" wrap="wrap" gap={12}>
                <div>
                    <Space size={10}>
                        <Title level={3} style={{ margin: 0 }}>Allegory Observer</Title>
                        <Tag color="purple">micro-society v0.1</Tag>
                    </Space>
                    <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                        A living view driven by the same append-only event contract emitted by AllegoryTownSpace.
                    </Paragraph>
                </div>
                <Space wrap>
                    <Button
                        icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        type="primary"
                        onClick={() => setPlaying((value) => !value)}
                    >
                        {playing ? 'Pause' : eventIndex < 0 ? 'Play' : 'Resume'}
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={reset}>Reset</Button>
                    <Segmented
                        value={speed}
                        options={[
                            { label: '1×', value: 1 },
                            { label: '2×', value: 2 },
                            { label: '5×', value: 5 },
                        ]}
                        onChange={(value) => setSpeed(Number(value))}
                    />
                </Space>
            </Flex>

            <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
                <Col xs={12} md={6}>
                    <Card size="small"><Statistic title="Residents" value={agents.size} /></Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small"><Statistic title="Aware" value={awareCount} suffix={`/ ${agents.size}`} /></Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small"><Statistic title="Purchases" value={purchaseCount} /></Card>
                </Col>
                <Col xs={12} md={6}>
                    <Card size="small"><Statistic title="Event" value={Math.max(0, eventIndex + 1)} suffix={`/ ${data.events.length}`} /></Card>
                </Col>
            </Row>

            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
                <Col xs={24} xl={17}>
                    <Card styles={{ body: { padding: 0 } }}>
                        <div
                            style={{
                                position: 'relative',
                                minHeight: 650,
                                overflow: 'hidden',
                                borderRadius: 16,
                                background:
                                    'radial-gradient(circle at 50% 45%, #ffffff 0, #f0fdf4 46%, #e2e8f0 100%)',
                            }}
                        >
                            <svg
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                            >
                                {data.locations.flatMap((location) =>
                                    location.neighbors
                                        .filter((neighbor) => location.id < neighbor)
                                        .map((neighbor) => {
                                            const other = locationMap.get(neighbor);
                                            if (!other) return null;
                                            return (
                                                <line
                                                    key={`${location.id}-${neighbor}`}
                                                    x1={location.x}
                                                    y1={location.y}
                                                    x2={other.x}
                                                    y2={other.y}
                                                    stroke="#cbd5e1"
                                                    strokeWidth="1.2"
                                                    strokeDasharray="2 1"
                                                />
                                            );
                                        }),
                                )}
                            </svg>

                            {data.locations.map((location) => (
                                <div
                                    key={location.id}
                                    style={{
                                        ...buildingStyle(location.kind),
                                        left: `${location.x}%`,
                                        top: `${location.y}%`,
                                    }}
                                >
                                    {location.kind !== 'street' && (
                                        <div>
                                            <div>{location.name}</div>
                                            <Text type="secondary" style={{ fontSize: 10 }}>{location.kind}</Text>
                                        </div>
                                    )}
                                </div>
                            ))}

                            {Array.from(agents.values()).map((agent, index) => {
                                const location = locationMap.get(agent.location_id);
                                if (!location) return null;
                                const offsetX = ((index % 3) - 1) * 2.4;
                                const offsetY = (Math.floor(index / 3) % 2) * 3 - 1.5;
                                const isSelected = selectedAgentId === agent.id;
                                const conversation =
                                    currentEvent?.event_type === 'conversation' &&
                                    (currentEvent.actor_id === agent.id || currentEvent.target_id === agent.id);
                                return (
                                    <div
                                        key={agent.id}
                                        onClick={() => setSelectedAgentId(agent.id)}
                                        title={`${agent.name} — ${agent.activity}`}
                                        style={{
                                            position: 'absolute',
                                            left: `calc(${location.x}% + ${offsetX}px)`,
                                            top: `calc(${location.y}% + ${offsetY}px)`,
                                            transform: 'translate(-50%, -50%)',
                                            transition: 'left 900ms ease, top 900ms ease, transform 180ms ease',
                                            zIndex: 8,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {conversation && (
                                            <div
                                                style={{
                                                    position: 'absolute',
                                                    bottom: 38,
                                                    left: '50%',
                                                    transform: 'translateX(-50%)',
                                                    width: 150,
                                                    padding: '7px 9px',
                                                    borderRadius: 10,
                                                    background: '#ffffff',
                                                    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
                                                    fontSize: 11,
                                                    textAlign: 'center',
                                                }}
                                            >
                                                {stringPayload(currentEvent, 'content') ?? 'Talking…'}
                                            </div>
                                        )}
                                        <div
                                            style={{
                                                width: 34,
                                                height: 34,
                                                borderRadius: '50%',
                                                display: 'grid',
                                                placeItems: 'center',
                                                fontSize: 11,
                                                fontWeight: 750,
                                                color: '#ffffff',
                                                background:
                                                    agent.flash === 'purchase'
                                                        ? '#16a34a'
                                                        : agent.flash === 'exposure'
                                                          ? '#d97706'
                                                          : agent.flash === 'conversation'
                                                            ? '#7c3aed'
                                                            : '#334155',
                                                border: isSelected ? '4px solid #38bdf8' : '3px solid #ffffff',
                                                boxShadow: '0 7px 16px rgba(15, 23, 42, 0.25)',
                                            }}
                                        >
                                            {initials(agent.name)}
                                        </div>
                                        <div
                                            style={{
                                                position: 'absolute',
                                                top: 37,
                                                left: '50%',
                                                transform: 'translateX(-50%)',
                                                whiteSpace: 'nowrap',
                                                fontSize: 10,
                                                fontWeight: 650,
                                                padding: '2px 5px',
                                                borderRadius: 5,
                                                background: 'rgba(255,255,255,0.88)',
                                            }}
                                        >
                                            {agent.activity}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Card>
                </Col>

                <Col xs={24} xl={7}>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Card size="small" title="Live event">
                            {currentEvent ? (
                                <>
                                    <Text strong>#{currentEvent.sequence}</Text>
                                    <Paragraph style={{ margin: '6px 0' }}>
                                        {eventLabel(currentEvent, sourceAgentMap, productMap)}
                                    </Paragraph>
                                    <Text type="secondary">
                                        {new Date(currentEvent.simulation_time).toLocaleString()}
                                    </Text>
                                </>
                            ) : (
                                <Text type="secondary">Press play to begin the replay.</Text>
                            )}
                        </Card>

                        <Card size="small" title="Resident inspector">
                            {selectedAgent ? (
                                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                    <Title level={5} style={{ margin: 0 }}>{selectedAgent.name}</Title>
                                    <Text>Location: {locationMap.get(selectedAgent.location_id)?.name}</Text>
                                    <Text>Activity: {selectedAgent.activity}</Text>
                                    <Text>Budget: ${selectedAgent.budget.toFixed(2)}</Text>
                                    <Text>Awareness: {Object.keys(selectedAgent.awareness).length ? 'yes' : 'none'}</Text>
                                    <Text>Consideration: {Object.values(selectedAgent.consideration)[0]?.toFixed(2) ?? '—'}</Text>
                                    <Text>Purchased: {selectedAgent.purchased.length ? 'yes' : 'no'}</Text>
                                </Space>
                            ) : (
                                <Text type="secondary">Click a resident in the town.</Text>
                            )}
                        </Card>

                        <Card size="small" title="Recent events" styles={{ body: { maxHeight: 295, overflowY: 'auto' } }}>
                            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                                {recentEvents.map((event) => (
                                    <div key={event.sequence}>
                                        <Text strong style={{ fontSize: 11 }}>#{event.sequence}</Text>
                                        <div style={{ fontSize: 12 }}>
                                            {eventLabel(event, sourceAgentMap, productMap)}
                                        </div>
                                    </div>
                                ))}
                            </Space>
                        </Card>
                    </Space>
                </Col>
            </Row>
        </div>
    );
};

export default AllegoryTown;
