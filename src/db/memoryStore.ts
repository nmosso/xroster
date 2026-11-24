import type {
    AgentModelUsage, AlertListFilter, AlertStateRow, Approval, ApprovalListFilter, ApprovalPatch, ApprovalStatus, AuditClaim,
    AuditCompletion, AuditEntry, AuditListFilter, AuditPage, NewApproval, ProviderTotals, ProviderUsage, QuotaBucket, QuotaReport,
    QuotaSeriesPoint, QuotaUsageEntry, RosterStore
} from './store';
import { RATE_LIMIT_EVENTS_MAX, clampLimit, clampOffset } from './store';

/** Copia profunda para evitar aliasing con el estado interno (fiel a la semántica de una BD real). */
function clone<T>(value: T): T {
    return structuredClone(value);
}

/** Equivalente a `date_trunc(bucket, ts AT TIME ZONE 'UTC')`. */
function truncUtc(d: Date, bucket: QuotaBucket): Date {
    const t = new Date(d);
    t.setUTCMinutes(0, 0, 0);
    if (bucket === 'day') t.setUTCHours(0);
    return t;
}

/** Búsqueda literal case-insensitive (equivalente a ILIKE con comodines escapados). */
function matches(needle: string | undefined, ...fields: (string | null | undefined)[]): boolean {
    const q = (needle ?? '').trim().toLowerCase();
    if (!q) return true;
    return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

type Totals = ProviderTotals & { latency_sum: number };

function emptyTotals(provider: string): Totals {
    return { provider, requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, rate_limited: 0, errors: 0, avg_latency_ms: 0, latency_sum: 0 };
}

function addEntry(t: Totals, e: Required<QuotaUsageEntry>): void {
    t.requests += 1;
    t.input_tokens += e.input_tokens;
    t.output_tokens += e.output_tokens;
    t.cached_tokens += e.cached_tokens;
    t.latency_sum += e.latency_ms;
    if (e.rate_limited) t.rate_limited += 1;
    if (e.status === 'error') t.errors += 1;
}

function finish(t: Totals): ProviderTotals {
    const { latency_sum, ...rest } = t;
    return { ...rest, avg_latency_ms: t.requests ? Math.round(latency_sum / t.requests) : 0 };
}

/** Implementación in-memory fiel al contrato de PgRosterStore, para tests unitarios rápidos. */
export class MemoryRosterStore implements RosterStore {
    readonly ledger: Required<QuotaUsageEntry>[] = [];
    private readonly approvals = new Map<string, Approval>();
    private readonly alerts = new Map<string, AlertStateRow>();
    private readonly audit = new Map<string, AuditEntry>();
    private readonly flags = new Map<string, string>();

    async initSchema(): Promise<void> {}
    async close(): Promise<void> {}

    async insertQuotaUsage(entry: QuotaUsageEntry): Promise<void> {
        this.ledger.push(clone({ ...entry, created_at: entry.created_at ?? new Date() }));
    }

    async aggregateQuota(since: Date): Promise<ProviderUsage[]> {
        const byProvider = new Map<string, ProviderUsage>();
        for (const e of this.ledger) {
            if (e.created_at.getTime() < since.getTime()) continue;
            const u = byProvider.get(e.provider) ?? {
                provider: e.provider, requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, rate_limited: 0, errors: 0
            };
            u.requests += 1;
            u.input_tokens += e.input_tokens;
            u.output_tokens += e.output_tokens;
            u.cached_tokens += e.cached_tokens;
            if (e.rate_limited) u.rate_limited += 1;
            if (e.status === 'error') u.errors += 1;
            byProvider.set(e.provider, u);
        }
        return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
    }

    async createApproval(approval: NewApproval): Promise<boolean> {
        if (this.approvals.has(approval.code)) return false;
        this.approvals.set(approval.code, clone({ ...approval, status: 'pending', decided_at: null, result_summary: null }));
        return true;
    }

    async getApproval(code: string): Promise<Approval | null> {
        const a = this.approvals.get(code);
        return a ? clone(a) : null;
    }

    async transitionApproval(code: string, from: ApprovalStatus, patch: ApprovalPatch): Promise<boolean> {
        const a = this.approvals.get(code);
        if (!a || a.status !== from) return false;
        a.status = patch.status;
        if (patch.decided_at !== undefined) a.decided_at = patch.decided_at ? new Date(patch.decided_at) : null;
        if (patch.result_summary !== undefined) a.result_summary = patch.result_summary;
        return true;
    }

    async countApprovals(status: ApprovalStatus): Promise<number> {
        return [...this.approvals.values()].filter((a) => a.status === status).length;
    }

    async getAlertState(alertKey: string): Promise<AlertStateRow | null> {
        const r = this.alerts.get(alertKey);
        return r ? clone(r) : null;
    }

    async upsertAlertState(row: AlertStateRow): Promise<void> {
        this.alerts.set(row.alert_key, clone(row));
    }

    async listAlertStates(filter: { nonOkOnly?: boolean } = {}): Promise<AlertStateRow[]> {
        return [...this.alerts.values()]
            .filter((r) => !filter.nonOkOnly || r.state !== 'ok')
            .sort((a, b) => a.alert_key.localeCompare(b.alert_key))
            .map(clone);
    }

    async setTenantSilence(tenantPosition: string, until: Date | null): Promise<number> {
        let n = 0;
        for (const r of this.alerts.values()) {
            if (r.tenant_position !== tenantPosition) continue;
            r.silenced_until = until ? new Date(until) : null;
            n++;
        }
        return n;
    }

    async claimMessage(claim: AuditClaim): Promise<boolean> {
        if (this.audit.has(claim.message_id)) return false;
        this.audit.set(claim.message_id, {
            ...claim, created_at: new Date(), agent_name: null, output_text: null, duration_ms: null, status: 'processing', metadata: {}
        });
        return true;
    }

    async completeMessage(messageId: string, completion: AuditCompletion): Promise<void> {
        const row = this.audit.get(messageId);
        if (!row) return;
        Object.assign(row, clone(completion));
    }

    async getAudit(messageId: string): Promise<AuditEntry | null> {
        const r = this.audit.get(messageId);
        return r ? clone(r) : null;
    }

    async quotaReport(since: Date, bucket: QuotaBucket): Promise<QuotaReport> {
        const rows = this.ledger.filter((e) => e.created_at.getTime() >= since.getTime());
        const totals = new Map<string, Totals>();
        const byAgent = new Map<string, Totals & { agent_name: string; model: string }>();
        const series = new Map<string, QuotaSeriesPoint>();
        for (const e of rows) {
            const t = totals.get(e.provider) ?? emptyTotals(e.provider);
            addEntry(t, e);
            totals.set(e.provider, t);

            const ak = JSON.stringify([e.agent_name, e.provider, e.model]);
            const a = byAgent.get(ak) ?? { ...emptyTotals(e.provider), agent_name: e.agent_name, model: e.model };
            addEntry(a, e);
            byAgent.set(ak, a);

            const b = truncUtc(e.created_at, bucket);
            const sk = `${b.toISOString()}|${e.provider}`;
            const p = series.get(sk) ?? { bucket: b, provider: e.provider, requests: 0, input_tokens: 0, output_tokens: 0, rate_limited: 0 };
            p.requests += 1;
            p.input_tokens += e.input_tokens;
            p.output_tokens += e.output_tokens;
            if (e.rate_limited) p.rate_limited += 1;
            series.set(sk, p);
        }
        const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
        return {
            totals: [...totals.values()].map(finish).sort((a, b) => cmp(a.provider, b.provider)),
            by_agent_model: [...byAgent.values()]
                .map((a): AgentModelUsage => ({ ...finish(a), agent_name: a.agent_name, model: a.model }))
                .sort((a, b) => cmp(a.agent_name, b.agent_name) || cmp(a.provider, b.provider) || cmp(a.model, b.model)),
            series: [...series.values()].sort((a, b) => a.bucket.getTime() - b.bucket.getTime() || cmp(a.provider, b.provider)),
            rate_limit_events: rows
                .filter((e) => e.rate_limited)
                .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
                .slice(0, RATE_LIMIT_EVENTS_MAX)
                .map((e) => ({ created_at: new Date(e.created_at), agent_name: e.agent_name, provider: e.provider, model: e.model, error_code: e.error_code }))
        };
    }

    async listAlerts(filter: AlertListFilter): Promise<AlertStateRow[]> {
        return [...this.alerts.values()]
            .filter((r) => filter.state === 'all' || r.state === filter.state)
            .filter((r) => matches(filter.search, r.alert_key, r.tenant_position, r.tenant_name, r.component, r.last_detail))
            .sort((a, b) => a.alert_key.localeCompare(b.alert_key))
            .map(clone);
    }

    async listApprovals(filter: ApprovalListFilter): Promise<Approval[]> {
        return [...this.approvals.values()]
            .filter((a) => filter.status === 'all' || a.status === 'pending')
            .sort((a, b) => b.requested_at.getTime() - a.requested_at.getTime() || b.code.localeCompare(a.code))
            .slice(0, clampLimit(filter.limit))
            .map(clone);
    }

    async listAudit(filter: AuditListFilter): Promise<AuditPage> {
        const all = [...this.audit.values()]
            .filter((r) => !filter.agent || r.agent_name === filter.agent)
            .filter((r) => !filter.status || r.status === filter.status)
            .filter((r) => matches(filter.search, r.message_id, r.sender_phone, r.input_text, r.output_text))
            .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.message_id < b.message_id ? 1 : a.message_id > b.message_id ? -1 : 0));
        const offset = clampOffset(filter.offset);
        return { total: all.length, rows: all.slice(offset, offset + clampLimit(filter.limit)).map(clone) };
    }

    async getFlag(key: string): Promise<string | null> {
        return this.flags.get(key) ?? null;
    }

    async setFlag(key: string, value: string): Promise<void> {
        this.flags.set(key, value);
    }

    async deleteFlag(key: string): Promise<void> {
        this.flags.delete(key);
    }
}
