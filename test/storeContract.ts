// Suite de contrato de RoosterStore: la ejecutan MemoryRoosterStore (npm test) y PgRoosterStore (npm run test:sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoosterStore, NewApproval, AlertStateRow } from '../src/db/store';

const MIN = 60_000;

export function approvalFixture(code: string, now: Date, overrides: Partial<NewApproval> = {}): NewApproval {
    return {
        code,
        agent_name: 'tank',
        action_type: 'restart_service',
        target_tenant: '43',
        summary_text: 'Reiniciar streamer en 43',
        payload: { service: 'streamer', position: '43' },
        requested_at: now,
        expires_at: new Date(now.getTime() + 5 * MIN),
        ...overrides
    };
}

function alertFixture(key: string, overrides: Partial<AlertStateRow> = {}): AlertStateRow {
    const [pos, component] = key.split(':') as [string, string];
    return {
        alert_key: key,
        tenant_position: pos,
        tenant_name: `Tenant ${pos}`,
        component,
        state: 'down',
        first_seen_at: new Date('2026-11-24T10:00:00Z'),
        last_notified_at: null,
        silenced_until: null,
        last_detail: 'sin heartbeat',
        metrics: { age_sec: 300 },
        ...overrides
    };
}

export function runStoreContract(label: string, factory: () => Promise<RoosterStore>): void {
    test(`[${label}] ledger: inserta y agrega por proveedor desde una fecha`, async () => {
        const s = await factory();
        const now = new Date();
        const base = {
            agent_name: 'jarvis', model: 'm', task_type: 'route', cached_tokens: 0, latency_ms: 10,
            error_code: null, metadata: { k: 1 }
        } as const;
        await s.insertQuotaUsage({ ...base, provider: 'gemini', input_tokens: 10, output_tokens: 5, cached_tokens: 2, status: 'ok', rate_limited: false, created_at: now });
        await s.insertQuotaUsage({ ...base, provider: 'gemini', input_tokens: 0, output_tokens: 0, status: 'rate_limited', rate_limited: true, error_code: '429', created_at: now });
        await s.insertQuotaUsage({ ...base, provider: 'claude', input_tokens: 100, output_tokens: 50, status: 'error', rate_limited: false, error_code: 'E', created_at: now });
        await s.insertQuotaUsage({ ...base, provider: 'claude', input_tokens: 999, output_tokens: 999, status: 'ok', rate_limited: false, created_at: new Date(now.getTime() - 30 * 60 * MIN) });

        const usage = await s.aggregateQuota(new Date(now.getTime() - 5 * 60 * MIN));
        const gem = usage.find((u) => u.provider === 'gemini');
        const cla = usage.find((u) => u.provider === 'claude');
        assert.deepEqual(gem, { provider: 'gemini', requests: 2, input_tokens: 10, output_tokens: 5, cached_tokens: 2, rate_limited: 1, errors: 0 });
        assert.deepEqual(cla, { provider: 'claude', requests: 1, input_tokens: 100, output_tokens: 50, cached_tokens: 0, rate_limited: 0, errors: 1 });
        await s.close();
    });

    test(`[${label}] approvals: create/get, código duplicado rechazado y TTL 5 min persistido`, async () => {
        const s = await factory();
        const now = new Date('2026-11-24T12:00:00Z');
        assert.equal(await s.createApproval(approvalFixture('TK-482', now)), true);
        assert.equal(await s.createApproval(approvalFixture('TK-482', now)), false);
        const a = await s.getApproval('TK-482');
        assert.ok(a);
        assert.equal(a.status, 'pending');
        assert.equal(a.expires_at.getTime() - a.requested_at.getTime(), 5 * MIN);
        assert.deepEqual(a.payload, { service: 'streamer', position: '43' });
        assert.equal(await s.getApproval('TK-999'), null);
        assert.equal(await s.countApprovals('pending'), 1);
        await s.close();
    });

    test(`[${label}] approvals: transición compare-and-set (solo desde el estado esperado)`, async () => {
        const s = await factory();
        const now = new Date('2026-11-24T12:00:00Z');
        await s.createApproval(approvalFixture('SH-101', now, { agent_name: 'shikamaru', action_type: 'git_push_draft' }));
        assert.equal(await s.transitionApproval('SH-101', 'pending', { status: 'confirmed', decided_at: now }), true);
        assert.equal(await s.transitionApproval('SH-101', 'pending', { status: 'confirmed', decided_at: now }), false);
        assert.equal(await s.transitionApproval('SH-101', 'confirmed', { status: 'executed', result_summary: 'ok' }), true);
        const a = await s.getApproval('SH-101');
        assert.equal(a?.status, 'executed');
        assert.equal(a?.result_summary, 'ok');
        assert.equal(a?.decided_at?.getTime(), now.getTime());
        await s.close();
    });

    test(`[${label}] sentinel_alert_state: upsert, get, listado no-ok y silencio por tenant`, async () => {
        const s = await factory();
        await s.upsertAlertState(alertFixture('43:xmanager'));
        await s.upsertAlertState(alertFixture('43:ird', { state: 'degraded' }));
        await s.upsertAlertState(alertFixture('44:proxmox', { state: 'ok' }));
        await s.upsertAlertState(alertFixture('43:xmanager', { last_detail: 'actualizado' }));

        assert.equal((await s.getAlertState('43:xmanager'))?.last_detail, 'actualizado');
        assert.deepEqual((await s.getAlertState('43:ird'))?.metrics, { age_sec: 300 });
        const active = await s.listAlertStates({ nonOkOnly: true });
        assert.deepEqual(active.map((r) => r.alert_key).sort(), ['43:ird', '43:xmanager']);

        const until = new Date('2026-11-24T13:00:00Z');
        assert.equal(await s.setTenantSilence('43', until), 2);
        assert.equal((await s.getAlertState('43:ird'))?.silenced_until?.getTime(), until.getTime());
        assert.equal((await s.getAlertState('44:proxmox'))?.silenced_until, null);
        await s.close();
    });

    test(`[${label}] agent_audit_log: claim deduplica por message_id y complete actualiza`, async () => {
        const s = await factory();
        assert.equal(await s.claimMessage({ message_id: 'M1', sender_phone: '5491100000000', input_text: 'STATUS' }), true);
        assert.equal(await s.claimMessage({ message_id: 'M1', sender_phone: '5491100000000', input_text: 'STATUS' }), false);
        await s.completeMessage('M1', { agent_name: 'jarvis', output_text: 'ok', duration_ms: 12, status: 'ok', metadata: { command: 'STATUS' } });
        const row = await s.getAudit('M1');
        assert.equal(row?.status, 'ok');
        assert.equal(row?.agent_name, 'jarvis');
        assert.deepEqual(row?.metadata, { command: 'STATUS' });
        await s.close();
    });

    test(`[${label}] system_flags: get/set/delete`, async () => {
        const s = await factory();
        assert.equal(await s.getFlag('paused'), null);
        await s.setFlag('paused', 'true');
        await s.setFlag('paused', 'false');
        assert.equal(await s.getFlag('paused'), 'false');
        await s.deleteFlag('paused');
        assert.equal(await s.getFlag('paused'), null);
        await s.close();
    });
}
