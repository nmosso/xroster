import type {
    AlertStateRow, Approval, ApprovalPatch, ApprovalStatus, AuditClaim, AuditCompletion, AuditEntry, NewApproval,
    ProviderUsage, QuotaUsageEntry, RoosterStore
} from './store';

/** Copia profunda para evitar aliasing con el estado interno (fiel a la semántica de una BD real). */
function clone<T>(value: T): T {
    return structuredClone(value);
}

/** Implementación in-memory fiel al contrato de PgRoosterStore, para tests unitarios rápidos. */
export class MemoryRoosterStore implements RoosterStore {
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
