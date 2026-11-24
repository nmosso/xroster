// Suite de contrato de RosterStore: la ejecutan MemoryRosterStore (npm test) y PgRosterStore (npm run test:sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RosterStore, NewApproval, AlertStateRow } from '../src/db/store';

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

export function runStoreContract(label: string, factory: () => Promise<RosterStore>): void {
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

    test(`[${label}] quotaReport: totales por proveedor, desglose agente/modelo, serie horaria y eventos 429`, async () => {
        const s = await factory();
        const base = {
            task_type: 'route', cached_tokens: 0, error_code: null, metadata: {}, status: 'ok', rate_limited: false
        } as const;
        await s.insertQuotaUsage({ ...base, agent_name: 'jarvis', provider: 'gemini', model: 'flash', input_tokens: 10, output_tokens: 5, latency_ms: 100, created_at: new Date('2026-11-24T10:05:00Z') });
        await s.insertQuotaUsage({ ...base, agent_name: 'jarvis', provider: 'gemini', model: 'flash', input_tokens: 20, output_tokens: 5, latency_ms: 300, created_at: new Date('2026-11-24T10:40:00Z') });
        await s.insertQuotaUsage({ ...base, agent_name: 'tank', provider: 'gemini', model: 'flash', input_tokens: 0, output_tokens: 0, latency_ms: 50, status: 'rate_limited', rate_limited: true, error_code: '429', created_at: new Date('2026-11-24T11:10:00Z') });
        await s.insertQuotaUsage({ ...base, agent_name: 'shikamaru', provider: 'claude', model: 'sonnet', input_tokens: 100, output_tokens: 50, cached_tokens: 7, latency_ms: 2000, created_at: new Date('2026-11-24T11:20:00Z') });
        // Fuera de rango: no debe contarse.
        await s.insertQuotaUsage({ ...base, agent_name: 'jarvis', provider: 'claude', model: 'sonnet', input_tokens: 999, output_tokens: 999, latency_ms: 1, created_at: new Date('2026-11-23T01:00:00Z') });

        const r = await s.quotaReport(new Date('2026-11-24T09:00:00Z'), 'hour');
        assert.deepEqual(r.totals, [
            { provider: 'claude', requests: 1, input_tokens: 100, output_tokens: 50, cached_tokens: 7, rate_limited: 0, errors: 0, avg_latency_ms: 2000 },
            { provider: 'gemini', requests: 3, input_tokens: 30, output_tokens: 10, cached_tokens: 0, rate_limited: 1, errors: 0, avg_latency_ms: 150 }
        ]);
        assert.deepEqual(r.by_agent_model, [
            { agent_name: 'jarvis', provider: 'gemini', model: 'flash', requests: 2, input_tokens: 30, output_tokens: 10, cached_tokens: 0, rate_limited: 0, errors: 0, avg_latency_ms: 200 },
            { agent_name: 'shikamaru', provider: 'claude', model: 'sonnet', requests: 1, input_tokens: 100, output_tokens: 50, cached_tokens: 7, rate_limited: 0, errors: 0, avg_latency_ms: 2000 },
            { agent_name: 'tank', provider: 'gemini', model: 'flash', requests: 1, input_tokens: 0, output_tokens: 0, cached_tokens: 0, rate_limited: 1, errors: 0, avg_latency_ms: 50 }
        ]);
        assert.deepEqual(r.series.map((p) => ({ ...p, bucket: p.bucket.toISOString() })), [
            { bucket: '2026-11-24T10:00:00.000Z', provider: 'gemini', requests: 2, input_tokens: 30, output_tokens: 10, rate_limited: 0 },
            { bucket: '2026-11-24T11:00:00.000Z', provider: 'claude', requests: 1, input_tokens: 100, output_tokens: 50, rate_limited: 0 },
            { bucket: '2026-11-24T11:00:00.000Z', provider: 'gemini', requests: 1, input_tokens: 0, output_tokens: 0, rate_limited: 1 }
        ]);
        assert.equal(r.rate_limit_events.length, 1);
        assert.deepEqual({ ...r.rate_limit_events[0]!, created_at: r.rate_limit_events[0]!.created_at.toISOString() }, {
            created_at: '2026-11-24T11:10:00.000Z', agent_name: 'tank', provider: 'gemini', model: 'flash', error_code: '429'
        });

        const daily = await s.quotaReport(new Date('2026-11-20T00:00:00Z'), 'day');
        assert.deepEqual(daily.series.map((p) => `${p.bucket.toISOString().slice(0, 10)}:${p.provider}:${p.requests}`), [
            '2026-11-23:claude:1', '2026-11-24:claude:1', '2026-11-24:gemini:3'
        ]);
        await s.close();
    });

    test(`[${label}] listAlerts: filtro por estado y búsqueda (tenant, nombre, componente, detalle)`, async () => {
        const s = await factory();
        await s.upsertAlertState(alertFixture('43:xmanager'));
        await s.upsertAlertState(alertFixture('43:ird', { state: 'degraded', last_detail: 'señal baja / BER' }));
        await s.upsertAlertState(alertFixture('44:proxmox', { state: 'ok', tenant_name: 'Cable Norte' }));

        assert.deepEqual((await s.listAlerts({ state: 'all' })).map((r) => r.alert_key), ['43:ird', '43:xmanager', '44:proxmox']);
        assert.deepEqual((await s.listAlerts({ state: 'down' })).map((r) => r.alert_key), ['43:xmanager']);
        assert.deepEqual((await s.listAlerts({ state: 'degraded' })).map((r) => r.alert_key), ['43:ird']);
        assert.deepEqual((await s.listAlerts({ state: 'ok' })).map((r) => r.alert_key), ['44:proxmox']);
        assert.deepEqual((await s.listAlerts({ state: 'all', search: 'norte' })).map((r) => r.alert_key), ['44:proxmox']);
        assert.deepEqual((await s.listAlerts({ state: 'all', search: 'BER' })).map((r) => r.alert_key), ['43:ird']);
        assert.deepEqual((await s.listAlerts({ state: 'all', search: 'xman' })).map((r) => r.alert_key), ['43:xmanager']);
        assert.deepEqual((await s.listAlerts({ state: 'down', search: '44' })).map((r) => r.alert_key), []);
        // Comodines SQL tratados como literales.
        assert.deepEqual(await s.listAlerts({ state: 'all', search: '%' }), []);
        await s.close();
    });

    test(`[${label}] listApprovals: pending vs all, orden más reciente primero y limit acotado 1..200`, async () => {
        const s = await factory();
        const t0 = new Date('2026-11-24T12:00:00Z');
        await s.createApproval(approvalFixture('TK-101', t0));
        await s.createApproval(approvalFixture('TK-102', new Date(t0.getTime() + MIN)));
        await s.createApproval(approvalFixture('SH-103', new Date(t0.getTime() + 2 * MIN), { agent_name: 'shikamaru', action_type: 'git_push_draft' }));
        await s.transitionApproval('TK-102', 'pending', { status: 'cancelled', decided_at: t0 });

        assert.deepEqual((await s.listApprovals({ status: 'pending', limit: 50 })).map((a) => a.code), ['SH-103', 'TK-101']);
        assert.deepEqual((await s.listApprovals({ status: 'all', limit: 50 })).map((a) => a.code), ['SH-103', 'TK-102', 'TK-101']);
        assert.deepEqual((await s.listApprovals({ status: 'all', limit: 1 })).map((a) => a.code), ['SH-103']);
        assert.equal((await s.listApprovals({ status: 'all', limit: 0 })).length, 1);
        assert.equal((await s.listApprovals({ status: 'all', limit: 5000 })).length, 3);
        await s.close();
    });

    test(`[${label}] listAudit: filtros agent/status/search, paginación limit/offset y total`, async () => {
        const s = await factory();
        const msgs = [
            { id: 'A1', agent: 'jarvis', status: 'ok', input: 'STATUS', output: 'todo ok' },
            { id: 'A2', agent: 'tank', status: 'ok', input: '@Tank revisá el 43', output: 'streamer activo' },
            { id: 'A3', agent: 'tank', status: 'error', input: '@Tank reiniciá', output: 'falló ssh' },
            { id: 'A4', agent: 'sentinel', status: 'ok', input: 'alertas?', output: 'sin alertas' }
        ] as const;
        for (const m of msgs) {
            await s.claimMessage({ message_id: m.id, sender_phone: '5491100000000', input_text: m.input });
            await s.completeMessage(m.id, { agent_name: m.agent, output_text: m.output, duration_ms: 5, status: m.status, metadata: {} });
        }
        await s.claimMessage({ message_id: 'A5', sender_phone: '5491199999999', input_text: 'hola' });

        const all = await s.listAudit({ limit: 50, offset: 0 });
        assert.equal(all.total, 5);
        assert.deepEqual(all.rows.map((r) => r.message_id).sort(), ['A1', 'A2', 'A3', 'A4', 'A5']);

        const tank = await s.listAudit({ agent: 'tank', limit: 50, offset: 0 });
        assert.equal(tank.total, 2);
        assert.deepEqual(tank.rows.map((r) => r.message_id).sort(), ['A2', 'A3']);

        assert.deepEqual((await s.listAudit({ status: 'error', limit: 50, offset: 0 })).rows.map((r) => r.message_id), ['A3']);
        assert.deepEqual((await s.listAudit({ search: 'STREAMER', limit: 50, offset: 0 })).rows.map((r) => r.message_id), ['A2']);
        assert.deepEqual((await s.listAudit({ search: '99999', limit: 50, offset: 0 })).rows.map((r) => r.message_id), ['A5']);
        assert.deepEqual((await s.listAudit({ agent: 'tank', status: 'ok', search: 'revisá', limit: 50, offset: 0 })).rows.map((r) => r.message_id), ['A2']);

        const p1 = await s.listAudit({ limit: 2, offset: 0 });
        const p2 = await s.listAudit({ limit: 2, offset: 2 });
        const p3 = await s.listAudit({ limit: 2, offset: 4 });
        assert.equal(p1.total, 5);
        assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length], [2, 2, 1]);
        assert.equal(new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.message_id)).size, 5);
        assert.equal((await s.listAudit({ limit: 5000, offset: -3 })).rows.length, 5);
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
