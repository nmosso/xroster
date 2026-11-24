// Contratos de persistencia de xroosterdb (REQ-2026-012 §5.1). Implementaciones: PgRoosterStore y MemoryRoosterStore.

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

export interface RoosterStore {
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

    // system_flags
    getFlag(key: string): Promise<string | null>;
    setFlag(key: string, value: string): Promise<void>;
    deleteFlag(key: string): Promise<void>;
}

export const FLAG_PAUSED = 'paused';
export const FLAG_SILENCED_ALL_UNTIL = 'sentinel_silenced_all_until';
export const tenantSilenceFlag = (position: string): string => `sentinel_silenced_until:${position}`;
