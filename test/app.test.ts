// L2: ensamblado completo (createApp) con dobles de PG/Redis/Evolution/SSH — webhook HTTP real de punta a punta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('createApp: stop() es idempotente', async () => {
    const h = harness();
    await h.app.start();
    await h.app.stop();
    await h.app.stop();
    rmSync(h.dir, { recursive: true, force: true });
});
