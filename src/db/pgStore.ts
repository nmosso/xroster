import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type {
    AlertStateRow, Approval, ApprovalPatch, ApprovalStatus, AuditClaim, AuditCompletion, AuditEntry, JsonObject, NewApproval,
    ProviderUsage, QuotaUsageEntry, RosterStore
} from './store';

/** Ruta al DDL idempotente; válida tanto desde src/db (tsx) como desde dist/db (build). */
export const INIT_SQL_PATH = join(__dirname, '..', '..', 'sql', '001_init_xrosterdb.sql');

const APPROVAL_COLS = 'code, agent_name, action_type, target_tenant, summary_text, payload, status, requested_at, expires_at, decided_at, result_summary';
const ALERT_COLS = 'alert_key, tenant_position, tenant_name, component, state, first_seen_at, last_notified_at, silenced_until, last_detail, metrics';

/** Implementación PostgreSQL (`pg.Pool`) sobre xrosterdb (PG_XROSTER_URL). */
export class PgRosterStore implements RosterStore {
    readonly pool: Pool;

    constructor(connectionStringOrPool: string | Pool, extra: PoolConfig = {}) {
        this.pool = typeof connectionStringOrPool === 'string'
            ? new Pool({ connectionString: connectionStringOrPool, max: 5, ...extra })
            : connectionStringOrPool;
    }

    async initSchema(): Promise<void> {
        const ddl = await readFile(INIT_SQL_PATH, 'utf8');
        await this.pool.query(ddl);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    async insertQuotaUsage(e: QuotaUsageEntry): Promise<void> {
        await this.pool.query(
            `INSERT INTO public.quota_usage_ledger
               (created_at, agent_name, provider, model, task_type, input_tokens, output_tokens, cached_tokens,
                latency_ms, status, rate_limited, error_code, metadata)
             VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
            [
                e.created_at ?? null, e.agent_name, e.provider, e.model, e.task_type,
                Math.round(e.input_tokens), Math.round(e.output_tokens), Math.round(e.cached_tokens), Math.round(e.latency_ms),
                e.status, e.rate_limited, e.error_code, JSON.stringify(e.metadata ?? {})
            ]
        );
    }

    async aggregateQuota(since: Date): Promise<ProviderUsage[]> {
        const { rows } = await this.pool.query<Record<string, string>>(
            `SELECT provider,
                    COUNT(*)::bigint                                   AS requests,
                    COALESCE(SUM(input_tokens), 0)::bigint            AS input_tokens,
                    COALESCE(SUM(output_tokens), 0)::bigint           AS output_tokens,
                    COALESCE(SUM(cached_tokens), 0)::bigint           AS cached_tokens,
                    COUNT(*) FILTER (WHERE rate_limited)::bigint      AS rate_limited,
                    COUNT(*) FILTER (WHERE status = 'error')::bigint  AS errors
               FROM public.quota_usage_ledger
              WHERE created_at >= $1
              GROUP BY provider
              ORDER BY provider`,
            [since]
        );
        return rows.map((r) => ({
            provider: String(r['provider']),
            requests: Number(r['requests']),
            input_tokens: Number(r['input_tokens']),
            output_tokens: Number(r['output_tokens']),
            cached_tokens: Number(r['cached_tokens']),
            rate_limited: Number(r['rate_limited']),
            errors: Number(r['errors'])
        }));
    }

    async createApproval(a: NewApproval): Promise<boolean> {
        const res = await this.pool.query(
            `INSERT INTO public.action_approvals
               (code, agent_name, action_type, target_tenant, summary_text, payload, status, requested_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7, $8)
             ON CONFLICT (code) DO NOTHING`,
            [a.code, a.agent_name, a.action_type, a.target_tenant, a.summary_text, JSON.stringify(a.payload ?? {}), a.requested_at, a.expires_at]
        );
        return (res.rowCount ?? 0) === 1;
    }

    async getApproval(code: string): Promise<Approval | null> {
        const { rows } = await this.pool.query<Approval>(`SELECT ${APPROVAL_COLS} FROM public.action_approvals WHERE code = $1`, [code]);
        return rows[0] ?? null;
    }

    async transitionApproval(code: string, from: ApprovalStatus, patch: ApprovalPatch): Promise<boolean> {
        const res = await this.pool.query(
            `UPDATE public.action_approvals
                SET status = $3,
                    decided_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE decided_at END,
                    result_summary = CASE WHEN $6::boolean THEN $7::text ELSE result_summary END
              WHERE code = $1 AND status = $2`,
            [
                code, from, patch.status,
                patch.decided_at !== undefined, patch.decided_at ?? null,
                patch.result_summary !== undefined, patch.result_summary ?? null
            ]
        );
        return (res.rowCount ?? 0) === 1;
    }

    async countApprovals(status: ApprovalStatus): Promise<number> {
        const { rows } = await this.pool.query<{ n: string }>(`SELECT COUNT(*)::bigint AS n FROM public.action_approvals WHERE status = $1`, [status]);
        return Number(rows[0]?.n ?? 0);
    }

    async getAlertState(alertKey: string): Promise<AlertStateRow | null> {
        const { rows } = await this.pool.query<AlertStateRow>(`SELECT ${ALERT_COLS} FROM public.sentinel_alert_state WHERE alert_key = $1`, [alertKey]);
        return rows[0] ?? null;
    }

    async upsertAlertState(r: AlertStateRow): Promise<void> {
        await this.pool.query(
            `INSERT INTO public.sentinel_alert_state (${ALERT_COLS})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
             ON CONFLICT (alert_key) DO UPDATE SET
                tenant_position = EXCLUDED.tenant_position,
                tenant_name = EXCLUDED.tenant_name,
                component = EXCLUDED.component,
                state = EXCLUDED.state,
                first_seen_at = EXCLUDED.first_seen_at,
                last_notified_at = EXCLUDED.last_notified_at,
                silenced_until = EXCLUDED.silenced_until,
                last_detail = EXCLUDED.last_detail,
                metrics = EXCLUDED.metrics`,
            [
                r.alert_key, r.tenant_position, r.tenant_name, r.component, r.state, r.first_seen_at,
                r.last_notified_at, r.silenced_until, r.last_detail, JSON.stringify(r.metrics ?? {})
            ]
        );
    }

    async listAlertStates(filter: { nonOkOnly?: boolean } = {}): Promise<AlertStateRow[]> {
        const where = filter.nonOkOnly ? `WHERE state <> 'ok'` : '';
        const { rows } = await this.pool.query<AlertStateRow>(`SELECT ${ALERT_COLS} FROM public.sentinel_alert_state ${where} ORDER BY alert_key`);
        return rows;
    }

    async setTenantSilence(tenantPosition: string, until: Date | null): Promise<number> {
        const res = await this.pool.query(`UPDATE public.sentinel_alert_state SET silenced_until = $2 WHERE tenant_position = $1`, [tenantPosition, until]);
        return res.rowCount ?? 0;
    }

    async claimMessage(c: AuditClaim): Promise<boolean> {
        const res = await this.pool.query(
            `INSERT INTO public.agent_audit_log (message_id, sender_phone, input_text, status)
             VALUES ($1, $2, $3, 'processing')
             ON CONFLICT (message_id) DO NOTHING`,
            [c.message_id, c.sender_phone, c.input_text]
        );
        return (res.rowCount ?? 0) === 1;
    }

    async completeMessage(messageId: string, c: AuditCompletion): Promise<void> {
        await this.pool.query(
            `UPDATE public.agent_audit_log
                SET agent_name = $2, output_text = $3, duration_ms = $4, status = $5, metadata = $6::jsonb
              WHERE message_id = $1`,
            [messageId, c.agent_name, c.output_text, Math.round(c.duration_ms), c.status, JSON.stringify(c.metadata ?? {})]
        );
    }

    async getAudit(messageId: string): Promise<AuditEntry | null> {
        const { rows } = await this.pool.query<AuditEntry & { metadata: JsonObject }>(
            `SELECT message_id, sender_phone, input_text, created_at, agent_name, output_text, duration_ms, status, metadata
               FROM public.agent_audit_log WHERE message_id = $1`,
            [messageId]
        );
        return rows[0] ?? null;
    }

    async getFlag(key: string): Promise<string | null> {
        const { rows } = await this.pool.query<{ value: string }>(`SELECT value FROM public.system_flags WHERE key = $1`, [key]);
        return rows[0]?.value ?? null;
    }

    async setFlag(key: string, value: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO public.system_flags (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value]
        );
    }

    async deleteFlag(key: string): Promise<void> {
        await this.pool.query(`DELETE FROM public.system_flags WHERE key = $1`, [key]);
    }
}
