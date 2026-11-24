// Contratos JSON de /api/* (espejo de src/web/apiRouter.ts y src/db/store.ts; fechas serializadas ISO).

export type HealthState = 'up' | 'down';

export interface AgentInfo {
    name: string;
    role: string;
    phase: 'F1' | 'F2' | 'F3';
    active: boolean;
}

export interface ProviderUsage {
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    rate_limited: number;
    errors: number;
}

export type ApprovalStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed' | 'failed';

export interface Approval {
    code: string;
    agent_name: string;
    action_type: string;
    target_tenant: string | null;
    summary_text: string;
    payload: Record<string, unknown>;
    status: ApprovalStatus;
    requested_at: string;
    expires_at: string;
    decided_at: string | null;
    result_summary: string | null;
}

export interface Overview {
    generated_at: string;
    health: { xrosterdb: HealthState; redis: HealthState; evolution: HealthState };
    paused: boolean;
    sentinel_silenced_all_until: string | null;
    agents: AgentInfo[];
    alerts_active: number;
    approvals_pending: number;
    pending_approvals: Approval[];
    quotas: { last5h: ProviderUsage[]; last24h: ProviderUsage[] };
}

export type QuotaRange = '5h' | '24h' | '7d' | '30d';
export type QuotaBucket = 'hour' | 'day';

export interface ProviderTotals extends ProviderUsage {
    avg_latency_ms: number;
}

export interface AgentModelUsage extends ProviderTotals {
    agent_name: string;
    model: string;
}

export interface QuotaSeriesPoint {
    bucket: string;
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    rate_limited: number;
}

export interface RateLimitEvent {
    created_at: string;
    agent_name: string;
    provider: string;
    model: string;
    error_code: string | null;
}

export interface QuotaReport {
    range: QuotaRange;
    bucket: QuotaBucket;
    since: string;
    generated_at: string;
    totals: ProviderTotals[];
    by_agent_model: AgentModelUsage[];
    series: QuotaSeriesPoint[];
    rate_limit_events: RateLimitEvent[];
}

export type AlertState = 'ok' | 'degraded' | 'down';
export type AlertStateFilter = 'all' | AlertState;

export interface AlertRow {
    alert_key: string;
    tenant_position: string;
    tenant_name: string | null;
    component: string;
    state: AlertState;
    first_seen_at: string;
    last_notified_at: string | null;
    silenced_until: string | null;
    last_detail: string | null;
    metrics: Record<string, unknown>;
}

export interface AlertsResponse {
    server_time: string;
    silenced_all_until: string | null;
    alerts: AlertRow[];
}

export interface SilenceResponse {
    target: string;
    minutes: number;
    until: string | null;
    message: string;
}

export interface ApprovalsResponse {
    server_time: string;
    status: 'pending' | 'all';
    limit: number;
    approvals: Approval[];
}

export interface ApprovalActionResponse {
    code: string;
    action: 'confirm' | 'cancel';
    status: ApprovalStatus;
    resolved: boolean;
    notified: boolean;
    message: string;
}

export type AuditStatus = 'processing' | 'ok' | 'ignored' | 'error' | 'unauthorized';

export interface AuditEntry {
    message_id: string;
    sender_phone: string | null;
    input_text: string | null;
    created_at: string;
    agent_name: string | null;
    output_text: string | null;
    duration_ms: number | null;
    status: AuditStatus;
    metadata: Record<string, unknown>;
}

export interface AuditPage {
    total: number;
    limit: number;
    offset: number;
    rows: AuditEntry[];
}

export interface SessionInfo {
    user: string;
    expires_at: string;
}
