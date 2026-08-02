import {
    ApiOutlined,
    DisconnectOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import {
    Alert,
    Button,
    Card,
    Col,
    Flex,
    Row,
    Space,
    Spin,
    Statistic,
    Tag,
    Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

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
    home_id?: string | null;
    work_id?: string | null;
    location_id: string;
    activity: string;
    budget: number;
    awareness: Record<string, number>;
    consideration: Record<string, number>;
    purchased: string[];
    flash?: 'exposure' | 'purchase' | 'conversation';
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
    branch_id?: string;
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
    status?: string;
};

type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const apiBase = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001').replace(
    /\/$/,
    '',
);

const stringPayload = (event: TownEvent, key: string): string | undefined => {
    const value = event.payload[key];
    return typeof value === 'string' ? value : undefined;
};

const numberPayload = (event: TownEvent, key: string): number | undefined => {
    const value = event.payload[key];
    return typeof value === 'number' ? value : undefined;
};

const initials = (name: string) =>
    name
        .split(' ')
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

const locationStyle = (kind: LocationKind): CSSProperties => {
    const backgrounds: Record<LocationKind, string> = {
        home: '#fff7ed',
        workplace: '#eef2ff',
        shop: '#fdf2f8',
        park: '#ecfdf5',
        cafe: '#fffbeb',
        street: '#94a3b8',
        other: '#f8fafc',
    };
    return {
        position: 'absolute',
        width: kind === 'street' ? 12 : 108,
        height: kind === 'street' ? 12 : 68,
        transform: 'translate(-50%, -50%)',
        borderRadius: kind === 'street' ? '50%' : 14,
        border: '1px solid rgba(30, 41, 59, 0.16)',
        background: backgrounds[kind],
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        fontSize: 12,
        fontWeight: 650,
        boxShadow: kind === 'street' ? 'none' : '0 10px 24px rgba(15, 23, 42, 0.08)',
        zIndex: kind === 'street' ? 1 : 2,
    };
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
            return 'The society simulation started.';
        case 'movement_started':
            return `${actor ?? 'A resident'} started moving.`;
        case 'movement_completed':
            return `${actor ?? 'A resident'} arrived at ${stringPayload(event, 'destination_id') ?? event.location_id ?? 'a destination'}.`;
        case 'activity_changed':
            return `${actor ?? 'A resident'} is now ${stringPayload(event, 'activity') ?? 'active'}.`;
        case 'product_exposed':
            return `${actor ?? 'A resident'} encountered ${product ?? 'the product'}.`;
        case 'conversation':
            return `${actor ?? 'A resident'} discussed ${product ?? stringPayload(event, 'topic') ?? 'a topic'} with ${target ?? 'another resident'}.`;
        case 'product_considered':
            return `${actor ?? 'A resident'} considered ${product ?? 'the product'} (${numberPayload(event, 'score')?.toFixed(2) ?? '—'}).`;
        case 'product_purchased':
            return `${actor ?? 'A resident'} purchased ${product ?? 'the product'}.`;
        case 'purchase_rejected':
            return `${actor ?? 'A resident'} did not purchase ${product ?? 'the product'}: ${stringPayload(event, 'reason') ?? 'reason unavailable'}.`;
        default:
            return event.event_type.replaceAll('_', ' ');
    }
};

const AllegoryLive = () => {
    const query = useMemo(() => new URLSearchParams(window.location.search), []);
    const workspacePath =
        query.get('workspace') || String(import.meta.env.VITE_ALLEGORY_WORKSPACE_PATH || '');
    const runDir = query.get('run') || String(import.meta.env.VITE_ALLEGORY_RUN_DIR || '');

    const [data, setData] = useState<ObserverData | null>(null);
    const [agents, setAgents] = useState<Map<number, TownAgent>>(new Map());
    const [events, setEvents] = useState<TownEvent[]>([]);
    const [cursor, setCursor] = useState(0);
    const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
    const [connection, setConnection] = useState<ConnectionState>('connecting');
    const [error, setError] = useState<string | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    const snapshotUrl = useMemo(() => {
        if (!workspacePath || !runDir) return null;
        const params = new URLSearchParams({ workspace_path: workspacePath, run_dir: runDir });
        return `${apiBase}/api/v1/allegory/observer/snapshot?${params.toString()}`;
    }, [runDir, workspacePath]);

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

            if (event.event_type === 'movement_started') {
                actor.activity = 'walking';
            } else if (event.event_type === 'movement_completed') {
                actor.location_id =
                    stringPayload(event, 'destination_id') ?? event.location_id ?? actor.location_id;
                actor.activity = 'idle';
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
                    actor.consideration = { ...actor.consideration, [productId]: score };
                }
            } else if (event.event_type === 'conversation') {
                actor.flash = 'conversation';
                if (event.target_id) {
                    const target = next.get(event.target_id);
                    if (target) next.set(target.id, { ...target, flash: 'conversation' });
                }
            } else if (event.event_type === 'product_purchased') {
                const productId = stringPayload(event, 'product_id');
                if (productId && !actor.purchased.includes(productId)) {
                    actor.purchased = [...actor.purchased, productId];
                }
                const budget = numberPayload(event, 'remaining_budget');
                if (budget !== undefined) actor.budget = budget;
                actor.flash = 'purchase';
            }
            next.set(actor.id, { ...actor });
            return next;
        });
    }, []);

    useEffect(() => {
        if (!snapshotUrl) {
            setConnection('offline');
            setError(
                'Live mode needs ?workspace=<absolute configured workspace>&run=<relative run directory>, or matching Vite environment variables.',
            );
            return;
        }
        let cancelled = false;
        let stream: EventSource | null = null;
        setConnection('connecting');
        setError(null);

        fetch(snapshotUrl)
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`Snapshot request failed with ${response.status}`);
                }
                return (await response.json()) as ObserverData;
            })
            .then((snapshot) => {
                if (cancelled) return;
                setData(snapshot);
                setAgents(new Map(snapshot.agents.map((agent) => [agent.id, { ...agent }])));
                setEvents(snapshot.events.slice(-100));
                setCursor(snapshot.last_sequence);

                const params = new URLSearchParams({
                    workspace_path: workspacePath,
                    run_dir: runDir,
                    after_sequence: String(snapshot.last_sequence),
                });
                stream = new EventSource(
                    `${apiBase}/api/v1/allegory/observer/stream?${params.toString()}`,
                );
                stream.addEventListener('open', () => {
                    if (!cancelled) setConnection('live');
                });
                stream.addEventListener('town_event', (message) => {
                    const event = JSON.parse((message as MessageEvent<string>).data) as TownEvent;
                    if (cancelled) return;
                    setCursor(event.sequence);
                    setEvents((previous) => [...previous.slice(-199), event]);
                    applyEvent(event);
                });
                stream.addEventListener('snapshot', (message) => {
                    const liveSnapshot = JSON.parse(
                        (message as MessageEvent<string>).data,
                    ) as ObserverData;
                    if (cancelled) return;
                    setData((previous) => ({
                        ...liveSnapshot,
                        events: previous?.events ?? [],
                    }));
                });
                stream.addEventListener('observer_error', (message) => {
                    const detail = JSON.parse((message as MessageEvent<string>).data) as {
                        detail?: string;
                    };
                    if (!cancelled) setError(detail.detail || 'Observer stream error');
                });
                stream.onerror = () => {
                    if (!cancelled) setConnection('reconnecting');
                };
            })
            .catch((caught: unknown) => {
                if (cancelled) return;
                setConnection('offline');
                setError(caught instanceof Error ? caught.message : String(caught));
            });

        return () => {
            cancelled = true;
            stream?.close();
        };
    }, [applyEvent, reloadKey, runDir, snapshotUrl, workspacePath]);

    const locationMap = useMemo(
        () => new Map(data?.locations.map((location) => [location.id, location]) ?? []),
        [data],
    );
    const productMap = useMemo(
        () => new Map(data?.products.map((product) => [product.id, product.name]) ?? []),
        [data],
    );
    const selectedAgent = selectedAgentId ? agents.get(selectedAgentId) : undefined;
    const awareCount = Array.from(agents.values()).filter(
        (agent) => Object.keys(agent.awareness).length > 0,
    ).length;
    const purchaseCount = Array.from(agents.values()).reduce(
        (total, agent) => total + agent.purchased.length,
        0,
    );

    if (!data && connection === 'connecting') {
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
                        <Title level={3} style={{ margin: 0 }}>Allegory Live</Title>
                        <Tag
                            icon={connection === 'offline' ? <DisconnectOutlined /> : <ApiOutlined />}
                            color={connection === 'live' ? 'green' : connection === 'offline' ? 'red' : 'gold'}
                        >
                            {connection}
                        </Tag>
                        {data?.branch_id && <Tag color="purple">{data.branch_id}</Tag>}
                    </Space>
                    <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                        Read-only live rendering of persisted AgentSociety events. The browser does not decide outcomes.
                    </Paragraph>
                </div>
                <Button icon={<ReloadOutlined />} onClick={() => setReloadKey((value) => value + 1)}>
                    Reconnect
                </Button>
            </Flex>

            {error && (
                <Alert
                    style={{ marginTop: 14 }}
                    type="warning"
                    showIcon
                    message="Live observer unavailable"
                    description={error}
                />
            )}

            <Row gutter={[12, 12]} style={{ marginTop: 16 }}>
                <Col xs={12} md={6}><Card size="small"><Statistic title="Residents" value={agents.size} /></Card></Col>
                <Col xs={12} md={6}><Card size="small"><Statistic title="Aware" value={awareCount} suffix={`/ ${agents.size}`} /></Card></Col>
                <Col xs={12} md={6}><Card size="small"><Statistic title="Purchases" value={purchaseCount} /></Card></Col>
                <Col xs={12} md={6}><Card size="small"><Statistic title="Event cursor" value={cursor} /></Card></Col>
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
                                background: 'radial-gradient(circle at 50% 45%, #fff 0, #f0fdf4 46%, #e2e8f0 100%)',
                            }}
                        >
                            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                {data?.locations.flatMap((location) =>
                                    location.neighbors
                                        .filter((neighbor) => location.id < neighbor)
                                        .map((neighbor) => {
                                            const other = locationMap.get(neighbor);
                                            return other ? (
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
                                            ) : null;
                                        }),
                                )}
                            </svg>
                            {data?.locations.map((location) => (
                                <div
                                    key={location.id}
                                    style={{
                                        ...locationStyle(location.kind),
                                        left: `${location.x}%`,
                                        top: `${location.y}%`,
                                    }}
                                >
                                    {location.kind !== 'street' && <div>{location.name}</div>}
                                </div>
                            ))}
                            {Array.from(agents.values()).map((agent, index) => {
                                const location = locationMap.get(agent.location_id);
                                if (!location) return null;
                                const offsetX = ((index % 3) - 1) * 4;
                                const offsetY = (Math.floor(index / 3) % 2) * 4 - 2;
                                return (
                                    <div
                                        key={agent.id}
                                        onClick={() => setSelectedAgentId(agent.id)}
                                        style={{
                                            position: 'absolute',
                                            left: `calc(${location.x}% + ${offsetX}px)`,
                                            top: `calc(${location.y}% + ${offsetY}px)`,
                                            transform: 'translate(-50%, -50%)',
                                            transition: 'left 900ms ease, top 900ms ease',
                                            zIndex: 8,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        <div
                                            style={{
                                                width: 35,
                                                height: 35,
                                                borderRadius: '50%',
                                                display: 'grid',
                                                placeItems: 'center',
                                                color: '#fff',
                                                fontSize: 11,
                                                fontWeight: 750,
                                                background:
                                                    agent.flash === 'purchase'
                                                        ? '#16a34a'
                                                        : agent.flash === 'exposure'
                                                          ? '#d97706'
                                                          : agent.flash === 'conversation'
                                                            ? '#7c3aed'
                                                            : '#334155',
                                                border: selectedAgentId === agent.id ? '4px solid #38bdf8' : '3px solid #fff',
                                                boxShadow: '0 7px 16px rgba(15,23,42,.25)',
                                            }}
                                        >
                                            {initials(agent.name)}
                                        </div>
                                        <div style={{ position: 'absolute', top: 38, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 650, padding: '2px 5px', borderRadius: 5, background: 'rgba(255,255,255,.9)' }}>
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
                        <Card size="small" title="Resident inspector">
                            {selectedAgent ? (
                                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                    <Title level={5} style={{ margin: 0 }}>{selectedAgent.name}</Title>
                                    <Text>Location: {locationMap.get(selectedAgent.location_id)?.name ?? selectedAgent.location_id}</Text>
                                    <Text>Activity: {selectedAgent.activity}</Text>
                                    <Text>Budget: ${Number(selectedAgent.budget).toFixed(2)}</Text>
                                    <Text>Awareness: {Object.keys(selectedAgent.awareness).length ? 'yes' : 'none'}</Text>
                                    <Text>Consideration: {Object.values(selectedAgent.consideration)[0]?.toFixed(2) ?? '—'}</Text>
                                    <Text>Purchased: {selectedAgent.purchased.length ? 'yes' : 'no'}</Text>
                                </Space>
                            ) : (
                                <Text type="secondary">Click a resident.</Text>
                            )}
                        </Card>
                        <Card size="small" title="Incoming events" styles={{ body: { maxHeight: 430, overflowY: 'auto' } }}>
                            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                                {events.slice().reverse().map((event) => (
                                    <div key={event.sequence}>
                                        <Text strong style={{ fontSize: 11 }}>#{event.sequence}</Text>
                                        <div style={{ fontSize: 12 }}>
                                            {eventLabel(event, agents, productMap)}
                                        </div>
                                    </div>
                                ))}
                                {!events.length && <Text type="secondary">Waiting for simulation events…</Text>}
                            </Space>
                        </Card>
                    </Space>
                </Col>
            </Row>
        </div>
    );
};

export default AllegoryLive;
