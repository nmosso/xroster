// Contratos de persistencia de xrosterdb (REQ-2026-012 §5.1). Implementaciones: PgRosterStore y MemoryRosterStore.

export type AgentName = 'jarvis' | 'sentinel' | 'tank' | 'shikamaru';
export type ProviderName = 'gemini' | 'claude';
export type TaskType = 'route' | 'summary' | 'diagnose' | 'planning';
export type LedgerStatus = 'ok' | 'error' | 'rate_limited';
export type JsonObject = Record<string, unknown>;

export interface QuotaUsageEntry {
    agent_name: string;
    provider: string;
    model: string;
    task_type: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    latency_ms: number;
    status: LedgerStatus;
    rate_limited: boolean;
    error_code: string | null;
    metadata: JsonObject;
    /** Opcional: por defecto NOW(). */
    created_at?: Date;
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
export type ActionType = 'restart_service' | 'git_push_draft';

export interface Approval {
    code: string;
    agent_name: string;
    action_type: string;
    target_tenant: string | null;
    summary_text: string;
    payload: JsonObject;
    status: ApprovalStatus;
    requested_at: Date;
    expires_at: Date;
    decided_at: Date | null;
    result_summary: string | null;
}

export type NewApproval = Omit<Approval, 'status' | 'decided_at' | 'result_summary'>;

export interface ApprovalPatch {
    status: ApprovalStatus;
    decided_at?: Date | null;
    result_summary?: string | null;
}

export type AlertState = 'ok' | 'degraded' | 'down';

export interface AlertStateRow {
    alert_key: string;
    tenant_position: string;
    tenant_name: string | null;
    component: string;
    state: AlertState;
    first_seen_at: Date;
    last_notified_at: Date | null;
    silenced_until: Date | null;
    last_detail: string | null;
    metrics: JsonObject;
}

export type AuditStatus = 'processing' | 'ok' | 'ignored' | 'error' | 'unauthorized';

export interface AuditClaim {
    message_id: string;
    sender_phone: string | null;
    input_text: string | null;
}

export interface AuditCompletion {
    agent_name: string | null;
    output_text: string | null;
    duration_ms: number;
    status: Exclude<AuditStatus, 'processing'>;
    metadata: JsonObject;
}

export interface AuditEntry extends AuditClaim {
    created_at: Date;
    agent_name: string | null;
    output_text: string | null;
    duration_ms: number | null;
    status: AuditStatus;
    metadata: JsonObject;
}

// ---------------- Consultas de lectura / analítica (REQ-2026-013 · cpanel-roster) ----------------

export type QuotaRange = '5h' | '24h' | '7d' | '30d';
export type QuotaBucket = 'hour' | 'day';

/** Ventanas de `/api/quotas`: duración y granularidad de la serie temporal. */
export const QUOTA_RANGES: Record<QuotaRange, { ms: number; bucket: QuotaBucket }> = {
    '5h': { ms: 5 * 3600_000, bucket: 'hour' },
    '24h': { ms: 24 * 3600_000, bucket: 'hour' },
    '7d': { ms: 7 * 86_400_000, bucket: 'day' },
    '30d': { ms: 30 * 86_400_000, bucket: 'day' }
};

export function isQuotaRange(v: unknown): v is QuotaRange {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(QUOTA_RANGES, v);
}

export interface ProviderTotals extends ProviderUsage {
    avg_latency_ms: number;
}

export interface AgentModelUsage extends ProviderTotals {
    agent_name: string;
    model: string;
}

export interface QuotaSeriesPoint {
    /** Inicio del bucket (UTC, truncado a hora o día). */
    bucket: Date;
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    rate_limited: number;
}

export interface RateLimitEvent {
    created_at: Date;
    agent_name: string;
    provider: string;
    model: string;
    error_code: string | null;
}

export interface QuotaReport {
    /** Ordenado por provider. */
    totals: ProviderTotals[];
    /** Ordenado por agent_name, provider, model. */
    by_agent_model: AgentModelUsage[];
    /** Ordenado por bucket, provider. */
    series: QuotaSeriesPoint[];
    /** Eventos 429 más recientes primero (máx. RATE_LIMIT_EVENTS_MAX). */
    rate_limit_events: RateLimitEvent[];
}

export const RATE_LIMIT_EVENTS_MAX = 50;

export type AlertStateFilter = 'all' | AlertState;
export interface AlertListFilter {
    state: AlertStateFilter;
    search?: string;
}

export interface ApprovalListFilter {
    status: 'pending' | 'all';
    limit: number;
}

export interface AuditListFilter {
    agent?: string;
    status?: AuditStatus;
    search?: string;
    limit: number;
    offset: number;
}

export interface AuditPage {
    total: number;
    rows: AuditEntry[];
}

export const LIST_LIMIT_MAX = 200;

/** Acota `limit` a 1..200 (valores no finitos → 50). */
export function clampLimit(n: number, def = 50): number {
    if (!Number.isFinite(n)) return def;
    return Math.min(LIST_LIMIT_MAX, Math.max(1, Math.trunc(n)));
}

/** Acota `offset` a un entero >= 0. */
export function clampOffset(n: number): number {
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export interface RosterStore {
    initSchema(): Promise<void>;
    close(): Promise<void>;

    // quota_usage_ledger
    insertQuotaUsage(entry: QuotaUsageEntry): Promise<void>;
    aggregateQuota(since: Date): Promise<ProviderUsage[]>;

    // action_approvals
    /** false si el código ya existe (no sobrescribe). */
    createApproval(approval: NewApproval): Promise<boolean>;
    getApproval(code: string): Promise<Approval | null>;
    /** Compare-and-set: aplica el patch solo si el estado actual es `from`. */
    transitionApproval(code: string, from: ApprovalStatus, patch: ApprovalPatch): Promise<boolean>;
    countApprovals(status: ApprovalStatus): Promise<number>;

    // sentinel_alert_state
    getAlertState(alertKey: string): Promise<AlertStateRow | null>;
    upsertAlertState(row: AlertStateRow): Promise<void>;
    listAlertStates(filter?: { nonOkOnly?: boolean }): Promise<AlertStateRow[]>;
    /** Aplica silenced_until a todas las filas del tenant; devuelve filas afectadas. */
    setTenantSilence(tenantPosition: string, until: Date | null): Promise<number>;

    // agent_audit_log
    /** Inserta el registro inicial; false si message_id ya existía (deduplicación). */
    claimMessage(claim: AuditClaim): Promise<boolean>;
    completeMessage(messageId: string, completion: AuditCompletion): Promise<void>;
    getAudit(messageId: string): Promise<AuditEntry | null>;

    // Lectura / analítica (cpanel-roster)
    /** Agregados de quota_usage_ledger desde `since`, con serie temporal truncada (UTC) a `bucket`. */
    quotaReport(since: Date, bucket: QuotaBucket): Promise<QuotaReport>;
    /** sentinel_alert_state filtrado por estado y búsqueda literal (case-insensitive); orden alert_key. */
    listAlerts(filter: AlertListFilter): Promise<AlertStateRow[]>;
    /** action_approvals más recientes primero; limit acotado 1..200. */
    listApprovals(filter: ApprovalListFilter): Promise<Approval[]>;
    /** agent_audit_log paginado (created_at DESC, message_id DESC); limit 1..200, offset >= 0. */
    listAudit(filter: AuditListFilter): Promise<AuditPage>;

    // system_flags
    getFlag(key: string): Promise<string | null>;
    setFlag(key: string, value: string): Promise<void>;
    deleteFlag(key: string): Promise<void>;
}

export const FLAG_PAUSED = 'paused';
export const FLAG_SILENCED_ALL_UNTIL = 'sentinel_silenced_all_until';
export const tenantSilenceFlag = (position: string): string => `sentinel_silenced_until:${position}`;
