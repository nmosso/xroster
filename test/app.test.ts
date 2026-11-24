// L2: ensamblado completo (createApp) con dobles de PG/Redis/Evolution/SSH — webhook HTTP real de punta a punta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { FLAG_PAUSED } from '../src/db/store';
import { scriptedRunner, VALID_ENV } from './helpers';

const GROUP = VALID_ENV['WHATSAPP_COMMAND_GROUP_ID']!;
const SECRET = VALID_ENV['XROSTER_WEBHOOK_SECRET']!;

function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'xroster-app-'));
    const cfg = loadConfig({ ...VALID_ENV, PORT: '0', XPLANNING_LOCAL_DIR: join(dir, 'xPlanning'), SENTINEL_POLL_MS: '3600000' });
    const store = new MemoryRosterStore();
    let initCalls = 0;
    store.initSchema = async () => { initCalls++; };
    const evolution: { url: string; body: { number: string; text: string } }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        evolution.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
    let redisClosed = false;
    let pgClosed = false;
    const app = createApp(cfg, {
        store,
        redis: {
            async scan() { return ['0', []]; },
            async hgetall() { return {}; },
            async quit() { redisClosed = true; return 'OK'; }
        },
        tenantsDb: { async query() { return { rows: [] }; }, async end() { pgClosed = true; } },
        runner: scriptedRunner(() => ({ code: 0 })),
        fetchImpl
    });
    return { app, store, evolution, dir, initCalls: () => initCalls, closed: () => ({ redisClosed, pgClosed }) };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timeout esperando condición');
        await new Promise((r) => setTimeout(r, 10));
    }
}

test('createApp: initSchema, /health, webhook STATUS -> respuesta al War Room vía Evolution, shutdown limpio', async () => {
    const h = harness();
    const port = await h.app.start();
    try {
        assert.equal(h.initCalls(), 1);
        const base = `http://127.0.0.1:${port}`;
        assert.equal((await fetch(`${base}/health`)).status, 200);

        const res = await fetch(`${base}/internal/whatsapp/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
            body: JSON.stringify({ message_id: 'E2E-1', group_id: GROUP, sender_phone: '541122334455', from_me: false, text: 'STATUS' })
        });
        assert.equal(res.status, 200);
        await waitFor(() => h.evolution.length === 1);
        assert.equal(h.evolution[0]!.url, 'http://evo:8080/message/sendText/xiptv');
        assert.equal(h.evolution[0]!.body.number, GROUP);
        assert.match(h.evolution[0]!.body.text, /STATUS/);
        assert.equal((await h.store.getAudit('E2E-1'))?.status, 'ok');

        await fetch(`${base}/internal/whatsapp/webhook`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
            body: JSON.stringify({ message_id: 'E2E-2', group_id: GROUP, sender_phone: '541122334455', from_me: false, text: 'PAUSAR' })
        });
        await waitFor(() => h.evolution.length === 2);
        assert.equal(await h.store.getFlag(FLAG_PAUSED), 'true');
    } finally {
        await h.app.stop();
        rmSync(h.dir, { recursive: true, force: true });
    }
    assert.deepEqual(h.closed(), { redisClosed: true, pgClosed: true });
});

test('createApp: cpanel-roster — login, overview con sondas reales, confirmación L1 notificada y SPA servido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xroster-app-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>cpanel-roster</title>');
    const cfg = loadConfig({
        ...VALID_ENV, PORT: '0', XPLANNING_LOCAL_DIR: join(dir, 'xPlanning'), SENTINEL_POLL_MS: '3600000',
        ROSTER_WEB_PASSWORD: 'pw-123456', ROSTER_SESSION_SECRET: 'z'.repeat(64)
    });
    const store = new MemoryRosterStore();
    const evolution: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
        evolution.push(String(url));
        return new Response('{"instance":{"state":"open"}}', { status: 200 });
    }) as typeof fetch;
    let scans = 0;
    const app = createApp(cfg, {
        store,
        redis: { async scan() { scans++; return ['0', []]; }, async hgetall() { return {}; }, async quit() { return 'OK'; } },
        tenantsDb: { async query() { return { rows: [] }; }, async end() {} },
        runner: scriptedRunner(() => ({ code: 0, stdout: 'active' })),
        fetchImpl,
        webStaticDir: dir
    });
    const port = await app.start();
    const base = `http://127.0.0.1:${port}`;
    try {
        const spa = await fetch(`${base}/alertas`);
        assert.equal(spa.status, 200);
        assert.match(await spa.text(), /cpanel-roster/);

        const login = await fetch(`${base}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'admin', password: 'pw-123456' })
        });
        assert.equal(login.status, 200);
        const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

        const ov = await fetch(`${base}/api/overview`, { headers: { cookie } });
        assert.equal(ov.status, 200);
        assert.deepEqual(((await ov.json()) as { health: unknown }).health, { xrosterdb: 'up', redis: 'up', evolution: 'up' });
        assert.ok(scans >= 1);
        assert.ok(evolution.some((u) => u.endsWith('/instance/connectionState/xiptv')));

        const tank = await app.jarvis.handle({ message_id: 'W1', group_id: GROUP, sender_phone: '541122334455', from_me: false, text: '@Tank reiniciá streamer en 43' });
        const code = /TK-\d+/.exec(tank.reply ?? '')?.[0];
        if (code) {
            const before = evolution.length;
            const res = await fetch(`${base}/api/approvals/${code}/cancel`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
            assert.equal(res.status, 200);
            assert.equal(((await res.json()) as { status: string }).status, 'cancelled');
            assert.ok(evolution.slice(before).some((u) => u.endsWith('/message/sendText/xiptv')));
        }
    } finally {
        await app.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('createApp: sin ROSTER_WEB_PASSWORD la API web queda cerrada (503) y /health sigue OK', async () => {
    const h = harness();
    const port = await h.app.start();
    try {
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`)).status, 503);
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
        await h.app.stop();
        rmSync(h.dir, { recursive: true, force: true });
    }
});

test('createApp: Sentinel recibe SENTINEL_NOTIFY_COMPONENTS y gracias desde la config', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 900);
    const build = (env: Record<string, string>) => {
        const evolution: string[] = [];
        const store = new MemoryRosterStore();
        const app = createApp(loadConfig({ ...VALID_ENV, PORT: '0', ...env }), {
            store,
            redis: {
                async scan() { return ['0', ['monitoring:tenant:43']]; },
                async hgetall() { return { proxmox_ts: stale, xmanager_ts: stale }; },
                async quit() { return 'OK'; }
            },
            tenantsDb: { async query() { return { rows: [] }; }, async end() {} },
            runner: scriptedRunner(() => ({ code: 0 })),
            fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
                evolution.push(String((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text));
                return new Response('{}', { status: 200 });
            }) as typeof fetch,
            webStaticDir: null
        });
        return { app, store, evolution };
    };

    const graced = build({});
    await graced.app.sentinel.tick();
    assert.equal(graced.evolution.length, 0, 'default: gracia de 2 min antes de avisar');
    assert.equal((await graced.store.getAlertState('43:proxmox'))?.state, 'down');
    await graced.app.stop();

    const noGrace = build({ SENTINEL_VM_GRACE_MS: '0' });
    await noGrace.app.sentinel.tick();
    assert.equal(noGrace.evolution.length, 1);
    assert.match(noGrace.evolution[0]!, /Proxmox/);
    assert.doesNotMatch(noGrace.evolution[0]!, /xManager/, 'xmanager fuera de SENTINEL_NOTIFY_COMPONENTS');
    assert.equal((await noGrace.store.getAlertState('43:xmanager'))?.state, 'down');
    await noGrace.app.stop();
});

test('createApp: stop() es idempotente', async () => {
    const h = harness();
    await h.app.start();
    await h.app.stop();
    await h.app.stop();
    rmSync(h.dir, { recursive: true, force: true });
});
