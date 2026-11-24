// L1/L2 HTTP de la API de cpanel-roster (REQ-2026-013 §6): servidor real en puerto efímero + MemoryRosterStore.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../src/server';
import { createApiRouter, AGENT_ROSTER, type ApiDeps } from '../src/web/apiRouter';
import { WebAuth, SESSION_COOKIE } from '../src/web/auth';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL, tenantSilenceFlag, type AlertStateRow } from '../src/db/store';
import { ApprovalManager } from '../src/core/approvals';
import { Sentinel } from '../src/agents/sentinel';
import type { WebConfig } from '../src/config';
import { fixedClock } from './helpers';

const PASSWORD = 'S3cret-pass!';
const WEB: WebConfig = { user: 'admin', password: PASSWORD, sessionSecret: 'k'.repeat(64), cookieSecure: false };
const MIN = 60_000;
const servers: Server[] = [];
after(async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))); });

interface Harness {
    base: string;
    store: MemoryRosterStore;
    approvals: ApprovalManager;
    notified: string[];
    executed: string[];
    clock: ReturnType<typeof fixedClock>;
    warnings: string[];
}

async function harness(over: Partial<ApiDeps> & { web?: WebConfig; notifyFails?: boolean } = {}): Promise<Harness> {
    const clock = fixedClock();
    const store = new MemoryRosterStore();
    const approvals = new ApprovalManager({ store, clock: clock.clock });
    const executed: string[] = [];
    approvals.register('restart_service', async (a) => {
        executed.push(a.code);
        await new Promise((r) => setTimeout(r, 10));
        return 'streamer reiniciado (active)';
    });
    const notified: string[] = [];
    const warnings: string[] = [];
    const sentinel = new Sentinel({
        store, clock: clock.clock, notify: async () => {}, pollMs: 60_000, cooldownMs: 0, stormThreshold: 3,
        source: { async listSnapshots() { return []; }, async getSnapshot() { return null; } }
    });
    const deps: ApiDeps = {
        auth: new WebAuth(over.web ?? WEB, { clock: clock.clock }),
        store, approvals, sentinel, clock: clock.clock,
        notify: async (text) => {
            if (over.notifyFails) throw new Error('Evolution API respondió 500');
            notified.push(text);
        },
        probes: { redis: async () => true, evolution: async () => true },
        logger: { info: () => {}, error: () => {}, warn: (m) => { warnings.push(m); } },
        ...over
    };
    const server = createServer({ secret: 'webhook-secret-long', onMessage: async () => {}, api: createApiRouter(deps) });
    servers.push(server);
    const base = await new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });
    return { base, store, approvals, notified, executed, clock, warnings };
}

async function login(h: Harness): Promise<string> {
    const res = await fetch(`${h.base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: PASSWORD })
    });
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie') ?? '';
    return set.split(';')[0]!;
}

function api(h: Harness, cookie: string | null, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (cookie) headers['cookie'] = cookie;
    if (init.body !== undefined) headers['content-type'] ??= 'application/json';
    return fetch(`${h.base}${path}`, {
        method: init.method ?? 'GET', headers,
        ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {})
    });
}

const json = async <T = Record<string, unknown>>(res: Response): Promise<T> => (await res.json()) as T;

function alert(key: string, over: Partial<AlertStateRow> = {}): AlertStateRow {
    const [pos, component] = key.split(':') as [string, string];
    return {
        alert_key: key, tenant_position: pos, tenant_name: `Tenant ${pos}`, component, state: 'down',
        first_seen_at: new Date('2026-11-24T11:00:00Z'), last_notified_at: null, silenced_until: null,
        last_detail: 'sin heartbeat', metrics: {}, ...over
    };
}

// ---------------- RF-01 / RF-02 / RF-03 ----------------

test('RF-01 fail-closed: sin ROSTER_WEB_PASSWORD /api/* -> 503 (incluido login); /health y webhook intactos', async () => {
    const h = await harness({ web: { ...WEB, password: null } });
    assert.equal((await api(h, null, '/api/overview')).status, 503);
    assert.equal((await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 'admin', password: '' } })).status, 503);
    assert.equal((await fetch(`${h.base}/health`)).status, 200);
    const wh = await fetch(`${h.base}/internal/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(wh.status, 401); // sigue protegido por X-Internal-Secret, no por la web
});

test('RF-03: sin sesión o con cookie adulterada -> 401; login inválido -> 401; válido -> cookie + /me', async () => {
    const h = await harness();
    assert.equal((await api(h, null, '/api/overview')).status, 401);
    assert.equal((await api(h, null, '/api/auth/me')).status, 401);
    assert.equal((await api(h, `${SESSION_COOKIE}=forged.value`, '/api/overview')).status, 401);
    const bad = await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 'admin', password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);

    const res = await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 'admin', password: PASSWORD } });
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie') ?? '';
    assert.match(set, /^xroster_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=43200$/);
    const cookie = set.split(';')[0]!;
    const me = await api(h, cookie, '/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal((await json(me))['user'], 'admin');

    const [name, value] = cookie.split('=') as [string, string];
    const tampered = `${name}=${value.slice(0, -3)}${value.endsWith('A') ? 'B' : 'A'}xx`;
    assert.equal((await api(h, tampered, '/api/auth/me')).status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('RF-02 rate-limit: 5 logins inválidos -> el 6to devuelve 429 con Retry-After', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) {
        assert.equal((await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 'admin', password: `bad${i}` } })).status, 401);
    }
    const res = await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 'admin', password: PASSWORD } });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '900');
});

test('login: body inválido -> 400; content-type no JSON -> 415', async () => {
    const h = await harness();
    assert.equal((await api(h, null, '/api/auth/login', { method: 'POST', body: '{no-json' })).status, 400);
    assert.equal((await api(h, null, '/api/auth/login', { method: 'POST', body: { user: 1, password: [] } })).status, 400);
    assert.equal((await api(h, null, '/api/auth/login', { method: 'POST', body: 'user=admin', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
});

test('logout: borra cookie (Max-Age=0); requiere sesión', async () => {
    const h = await harness();
    assert.equal((await api(h, null, '/api/auth/logout', { method: 'POST', body: {} })).status, 401);
    const cookie = await login(h);
    const res = await api(h, cookie, '/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /^xroster_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0/);
});

test('CSRF: mutación con Origin de otro host -> 403', async () => {
    const h = await harness();
    const cookie = await login(h);
    const res = await api(h, cookie, '/api/control/pause', { method: 'PUT', body: { paused: true }, headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(await h.store.getFlag(FLAG_PAUSED), null);
    const same = await api(h, cookie, '/api/control/pause', { method: 'PUT', body: { paused: true }, headers: { origin: h.base } });
    assert.equal(same.status, 200);
});

test('ruta /api desconocida -> 404; método no permitido -> 405', async () => {
    const h = await harness();
    const cookie = await login(h);
    assert.equal((await api(h, cookie, '/api/nope')).status, 404);
    assert.equal((await api(h, cookie, '/api/overview', { method: 'DELETE' })).status, 405);
});

// ---------------- Overview / control ----------------

test('GET /api/overview: salud, flags, roster de 7 agentes, conteos y cuotas 5h/24h', async () => {
    const h = await harness();
    const cookie = await login(h);
    const now = h.clock.clock();
    await h.store.setFlag(FLAG_PAUSED, 'true');
    await h.store.setFlag(FLAG_SILENCED_ALL_UNTIL, new Date(now.getTime() + 30 * MIN).toISOString());
    await h.store.upsertAlertState(alert('43:xmanager'));
    await h.store.upsertAlertState(alert('44:ird', { state: 'ok' }));
    await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'Reiniciar streamer', payload: {} });
    await h.store.insertQuotaUsage({
        agent_name: 'jarvis', provider: 'gemini', model: 'flash', task_type: 'route', input_tokens: 10, output_tokens: 2, cached_tokens: 0,
        latency_ms: 50, status: 'ok', rate_limited: false, error_code: null, metadata: {}, created_at: new Date(now.getTime() - 10 * 3600_000)
    });

    const res = await api(h, cookie, '/api/overview');
    assert.equal(res.status, 200);
    const body = await json<{
        health: Record<string, string>; paused: boolean; sentinel_silenced_all_until: string | null;
        agents: { name: string; phase: string; active: boolean }[]; alerts_active: number; approvals_pending: number;
        pending_approvals: { code: string }[]; quotas: { last5h: unknown[]; last24h: { provider: string; requests: number }[] };
    }>(res);
    assert.deepEqual(body.health, { xrosterdb: 'up', redis: 'up', evolution: 'up' });
    assert.equal(body.paused, true);
    assert.equal(body.sentinel_silenced_all_until, new Date(now.getTime() + 30 * MIN).toISOString());
    assert.equal(body.agents.length, 7);
    assert.deepEqual(body.agents.filter((a) => a.active).map((a) => a.name), ['Jarvis', 'Sentinel', 'Tank', 'Shikamaru']);
    assert.deepEqual(body.agents.filter((a) => !a.active).map((a) => `${a.name}:${a.phase}`), ['Axelrod:F2', 'Atlas:F2', 'Skipper:F3']);
    assert.equal(AGENT_ROSTER.length, 7);
    assert.equal(body.alerts_active, 1);
    assert.equal(body.approvals_pending, 1);
    assert.equal(body.pending_approvals.length, 1);
    assert.deepEqual(body.quotas.last5h, []);
    assert.deepEqual(body.quotas.last24h.map((u) => `${u.provider}:${u.requests}`), ['gemini:1']);
});

test('L3 overview: Redis/Evolution caídos o colgados -> 200 con "down" (sin romper el dashboard)', async () => {
    const h = await harness({
        probes: { redis: async () => { throw new Error('ECONNREFUSED'); }, evolution: () => new Promise<boolean>(() => {}) },
        probeTimeoutMs: 50
    });
    const cookie = await login(h);
    const res = await api(h, cookie, '/api/overview');
    assert.equal(res.status, 200);
    assert.deepEqual((await json<{ health: unknown }>(res)).health, { xrosterdb: 'up', redis: 'down', evolution: 'down' });
});

test('L3 overview: xrosterdb caída -> 200 con xrosterdb "down" y valores neutros', async () => {
    const h = await harness();
    const cookie = await login(h);
    h.store.getFlag = async () => { throw new Error('pg down'); };
    const res = await api(h, cookie, '/api/overview');
    assert.equal(res.status, 200);
    const body = await json<{ health: Record<string, string>; paused: boolean }>(res);
    assert.equal(body.health['xrosterdb'], 'down');
    assert.equal(body.paused, false);
});

test('PUT /api/control/pause: persiste system_flags.paused; body inválido -> 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    const r1 = await api(h, cookie, '/api/control/pause', { method: 'PUT', body: { paused: true } });
    assert.equal(r1.status, 200);
    assert.deepEqual(await json(r1), { paused: true });
    assert.equal(await h.store.getFlag(FLAG_PAUSED), 'true');
    await api(h, cookie, '/api/control/pause', { method: 'PUT', body: { paused: false } });
    assert.equal(await h.store.getFlag(FLAG_PAUSED), 'false');
    assert.equal((await api(h, cookie, '/api/control/pause', { method: 'PUT', body: { paused: 'yes' } })).status, 400);
    assert.equal((await api(h, cookie, '/api/control/pause', { method: 'PUT', body: [] })).status, 400);
});

// ---------------- Cuotas ----------------

test('GET /api/quotas: rango válido -> reporte con bucket; inválido o ausente -> 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    const now = h.clock.clock();
    await h.store.insertQuotaUsage({
        agent_name: 'tank', provider: 'claude', model: 'sonnet', task_type: 'diagnose', input_tokens: 100, output_tokens: 20, cached_tokens: 0,
        latency_ms: 900, status: 'rate_limited', rate_limited: true, error_code: '429', metadata: {}, created_at: new Date(now.getTime() - 2 * 3600_000)
    });
    for (const [range, bucket] of [['5h', 'hour'], ['24h', 'hour'], ['7d', 'day'], ['30d', 'day']] as const) {
        const res = await api(h, cookie, `/api/quotas?range=${range}`);
        assert.equal(res.status, 200, range);
        const body = await json<{ range: string; bucket: string; totals: { provider: string }[]; series: unknown[]; rate_limit_events: unknown[]; by_agent_model: unknown[] }>(res);
        assert.equal(body.range, range);
        assert.equal(body.bucket, bucket);
        assert.deepEqual(body.totals.map((t) => t.provider), ['claude']);
        assert.equal(body.series.length, 1);
        assert.equal(body.rate_limit_events.length, 1);
        assert.equal(body.by_agent_model.length, 1);
    }
    assert.equal((await api(h, cookie, '/api/quotas?range=invalid')).status, 400);
    assert.equal((await api(h, cookie, '/api/quotas')).status, 400);
});

// ---------------- Alertas ----------------

test('GET /api/alerts: filtro state/search; state inválido -> 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    await h.store.upsertAlertState(alert('43:xmanager'));
    await h.store.upsertAlertState(alert('44:ird', { state: 'degraded', tenant_name: 'Cable Sur' }));
    const all = await json<{ alerts: { alert_key: string }[] }>(await api(h, cookie, '/api/alerts'));
    assert.deepEqual(all.alerts.map((a) => a.alert_key), ['43:xmanager', '44:ird']);
    const deg = await json<{ alerts: { alert_key: string }[] }>(await api(h, cookie, '/api/alerts?state=degraded'));
    assert.deepEqual(deg.alerts.map((a) => a.alert_key), ['44:ird']);
    const s = await json<{ alerts: { alert_key: string }[] }>(await api(h, cookie, '/api/alerts?state=all&search=sur'));
    assert.deepEqual(s.alerts.map((a) => a.alert_key), ['44:ird']);
    assert.equal((await api(h, cookie, '/api/alerts?state=red')).status, 400);
});

test('POST /api/alerts/silence: tenant y global; 0 quita silencio; validaciones 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    const now = h.clock.clock();
    await h.store.upsertAlertState(alert('43:xmanager'));

    const r1 = await api(h, cookie, '/api/alerts/silence', { method: 'POST', body: { target: '43', minutes: 30 } });
    assert.equal(r1.status, 200);
    const until = new Date(now.getTime() + 30 * MIN).toISOString();
    assert.equal((await json(r1))['until'], until);
    assert.equal(await h.store.getFlag(tenantSilenceFlag('43')), until);
    assert.equal((await h.store.getAlertState('43:xmanager'))?.silenced_until?.toISOString(), until);

    const r2 = await api(h, cookie, '/api/alerts/silence', { method: 'POST', body: { target: '43', minutes: 0 } });
    assert.equal(r2.status, 200);
    assert.equal((await json(r2))['until'], null);
    assert.equal(await h.store.getFlag(tenantSilenceFlag('43')), null);
    assert.equal((await h.store.getAlertState('43:xmanager'))?.silenced_until, null);

    await api(h, cookie, '/api/alerts/silence', { method: 'POST', body: { target: 'all', minutes: 10080 } });
    assert.equal(await h.store.getFlag(FLAG_SILENCED_ALL_UNTIL), new Date(now.getTime() + 10080 * MIN).toISOString());
    await api(h, cookie, '/api/alerts/silence', { method: 'POST', body: { target: 'all', minutes: 0 } });
    assert.equal(await h.store.getFlag(FLAG_SILENCED_ALL_UNTIL), null);

    for (const body of [
        { target: '43', minutes: -5 }, { target: '43', minutes: 99999 }, { target: '43', minutes: 1.5 }, { target: '43', minutes: '30' },
        { target: 'drop table', minutes: 30 }, { target: '', minutes: 30 }, { minutes: 30 }
    ]) {
        assert.equal((await api(h, cookie, '/api/alerts/silence', { method: 'POST', body })).status, 400, JSON.stringify(body));
    }
});

// ---------------- Approvals ----------------

test('GET /api/approvals: pending por defecto, all, limit acotado a 200; status inválido -> 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    const a = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'x', payload: {} });
    const b = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '44', summaryText: 'y', payload: {} });
    await h.approvals.cancel(b.code);
    const pending = await json<{ approvals: { code: string }[]; server_time: string }>(await api(h, cookie, '/api/approvals'));
    assert.deepEqual(pending.approvals.map((x) => x.code), [a.code]);
    assert.equal(pending.server_time, h.clock.clock().toISOString());
    const all = await json<{ approvals: unknown[]; limit: number }>(await api(h, cookie, '/api/approvals?status=all&limit=5000'));
    assert.equal(all.approvals.length, 2);
    assert.equal(all.limit, 200);
    assert.equal((await api(h, cookie, '/api/approvals?status=done')).status, 400);
});

test('RF-04: confirm ejecuta el handler UNA vez (aun concurrente) y notifica al War Room; repetir no re-ejecuta', async () => {
    const h = await harness();
    const cookie = await login(h);
    const a = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'Reiniciar streamer', payload: {} });
    const [r1, r2] = await Promise.all([
        api(h, cookie, `/api/approvals/${a.code}/confirm`, { method: 'POST', body: {} }),
        api(h, cookie, `/api/approvals/${a.code.toLowerCase()}/confirm`, { method: 'POST', body: {} })
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(h.executed, [a.code]);
    assert.equal(h.notified.length, 1);
    assert.match(h.notified[0]!, /cpanel-roster/);
    assert.match(h.notified[0]!, new RegExp(a.code));

    const again = await json<{ status: string; resolved: boolean }>(await api(h, cookie, `/api/approvals/${a.code}/confirm`, { method: 'POST', body: {} }));
    assert.equal(again.status, 'executed');
    assert.equal(again.resolved, false);
    assert.deepEqual(h.executed, [a.code]);
    assert.equal(h.notified.length, 1);
});

test('RF-04: confirmar expirado (>5 min) no ejecuta; cancel pending -> cancelled', async () => {
    const h = await harness();
    const cookie = await login(h);
    const a = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'x', payload: {} });
    const b = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '44', summaryText: 'y', payload: {} });
    const cancel = await json<{ status: string; resolved: boolean; message: string }>(await api(h, cookie, `/api/approvals/${b.code}/cancel`, { method: 'POST', body: {} }));
    assert.equal(cancel.status, 'cancelled');
    assert.equal(cancel.resolved, true);
    h.clock.advance(5 * MIN + 1000);
    const expired = await json<{ status: string }>(await api(h, cookie, `/api/approvals/${a.code}/confirm`, { method: 'POST', body: {} }));
    assert.equal(expired.status, 'expired');
    assert.deepEqual(h.executed, []);
});

test('RF-04: código inválido -> 400; inexistente -> 404; acción desconocida -> 404', async () => {
    const h = await harness();
    const cookie = await login(h);
    assert.equal((await api(h, cookie, '/api/approvals/XX-1/confirm', { method: 'POST', body: {} })).status, 400);
    assert.equal((await api(h, cookie, '/api/approvals/TK-999/confirm', { method: 'POST', body: {} })).status, 404);
    assert.equal((await api(h, cookie, '/api/approvals/TK-999/delete', { method: 'POST', body: {} })).status, 404);
});

test('L3: si Evolution falla al notificar, la aprobación ejecutada devuelve 200 (no 500) y loguea warning', async () => {
    const h = await harness({ notifyFails: true });
    const cookie = await login(h);
    const a = await h.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'x', payload: {} });
    const res = await api(h, cookie, `/api/approvals/${a.code}/confirm`, { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    const body = await json<{ status: string; notified: boolean; message: string }>(res);
    assert.equal(body.status, 'executed');
    assert.equal(body.notified, false);
    assert.match(body.message, /streamer reiniciado/);
    assert.equal(h.warnings.length, 1);
});

// ---------------- Auditoría ----------------

test('GET /api/audit: filtros, paginación, limit acotado y status inválido -> 400', async () => {
    const h = await harness();
    const cookie = await login(h);
    for (let i = 0; i < 7; i++) {
        await h.store.claimMessage({ message_id: `M${i}`, sender_phone: '5491100000000', input_text: i % 2 ? '@Tank revisá' : 'STATUS' });
        await h.store.completeMessage(`M${i}`, { agent_name: i % 2 ? 'tank' : 'jarvis', output_text: 'ok', duration_ms: 3, status: 'ok', metadata: {} });
    }
    const p = await json<{ total: number; rows: unknown[]; limit: number; offset: number }>(await api(h, cookie, '/api/audit?limit=3&offset=3'));
    assert.deepEqual([p.total, p.rows.length, p.limit, p.offset], [7, 3, 3, 3]);
    const t = await json<{ total: number }>(await api(h, cookie, '/api/audit?agent=tank&status=ok&search=revis'));
    assert.equal(t.total, 3);
    const big = await json<{ limit: number; offset: number }>(await api(h, cookie, '/api/audit?limit=5000&offset=-1'));
    assert.deepEqual([big.limit, big.offset], [200, 0]);
    assert.equal((await api(h, cookie, '/api/audit?status=weird')).status, 400);
});
