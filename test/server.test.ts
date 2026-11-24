import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server';
import { parseWebhookPayload, type WebhookPayload } from '../src/core/webhook';
import { GROUP } from './helpers';

const SECRET = 'top-secret';
const received: WebhookPayload[] = [];
const server = createServer({
    secret: SECRET,
    onMessage: async (p) => { received.push(p); }
});
const ready = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
});
after(() => new Promise<void>((r) => server.close(() => r())));

const BODY = {
    message_id: '3EB0A1B2C3', group_id: GROUP, sender_phone: '54911XXXXXXXX', sender_name: 'Operador',
    from_me: false, text: '@Tank revisá el server 43', timestamp: 1763980000
};

async function post(body: unknown, headers: Record<string, string> = { 'x-internal-secret': SECRET }) {
    const base = await ready;
    return fetch(`${base}/internal/whatsapp/webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

test('GET /health -> 200 {status:ok}', async () => {
    const res = await fetch(`${await ready}/health`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, 'ok');
});

test('webhook sin X-Internal-Secret o inválido -> 401 sin procesar', async () => {
    const before = received.length;
    assert.equal((await post(BODY, {})).status, 401);
    assert.equal((await post(BODY, { 'x-internal-secret': 'nope' })).status, 401);
    assert.equal(received.length, before);
});

test('webhook payload incompleto o JSON inválido -> 400', async () => {
    assert.equal((await post({ ...BODY, message_id: '' })).status, 400);
    assert.equal((await post({ group_id: GROUP })).status, 400);
    assert.equal((await post('{no-json')).status, 400);
});

test('webhook válido -> 200 {accepted:true} y despacha el payload', async () => {
    const res = await post(BODY);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { accepted: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received.at(-1), BODY);
});

test('ruta desconocida -> 404; body gigante -> 413', async () => {
    assert.equal((await fetch(`${await ready}/nope`)).status, 404);
    const res = await post({ ...BODY, text: 'x'.repeat(300 * 1024) });
    assert.equal(res.status, 413);
});

// ---------------- RF-07: serving SPA (dist/web) ----------------

async function spaServer(api?: Parameters<typeof createServer>[0]['api']) {
    const dir = mkdtempSync(join(tmpdir(), 'xroster-spa-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>cpanel-roster</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{}');
    writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
    // Módulos backend compilados conviven en dist/web: jamás deben servirse.
    writeFileSync(join(dir, 'auth.js'), 'module.exports = "backend"');
    writeFileSync(join(dir, 'auth.js.map'), '{}');
    const s = createServer({ secret: SECRET, onMessage: async () => {}, staticDir: dir, ...(api ? { api } : {}) });
    const base = await new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
    return {
        base,
        close: async () => {
            await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
            await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
        }
    };
}

test('SPA: / e index.html con no-cache; assets con content-type e immutable; favicon', async () => {
    const spa = await spaServer();
    try {
        const root = await fetch(`${spa.base}/`);
        assert.equal(root.status, 200);
        assert.match(root.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(root.headers.get('cache-control'), 'no-cache');
        assert.match(await root.text(), /cpanel-roster/);
        assert.match(root.headers.get('content-security-policy') ?? '', /default-src 'self'/);
        assert.equal(root.headers.get('x-frame-options'), 'DENY');

        const js = await fetch(`${spa.base}/assets/index-abc123.js`);
        assert.equal(js.status, 200);
        assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
        assert.match(js.headers.get('cache-control') ?? '', /immutable/);
        assert.equal(await js.text(), 'console.log(1)');
        const css = await fetch(`${spa.base}/assets/index-abc123.css`);
        assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
        await css.text();
        const icon = await fetch(`${spa.base}/favicon.svg`);
        assert.match(icon.headers.get('content-type') ?? '', /^image\/svg\+xml/);
        await icon.text();
    } finally {
        await spa.close();
    }
});

test('SPA: fallback a index.html para rutas cliente; nunca sirve módulos backend ni hace traversal', async () => {
    const spa = await spaServer();
    try {
        for (const p of ['/cuotas', '/alertas?state=down', '/auth.js', '/auth.js.map', '/assets/../auth.js', '/%2e%2e/package.json', '/..%2fpackage.json']) {
            const res = await fetch(`${spa.base}${p}`);
            assert.equal(res.status, 200, p);
            assert.match(await res.text(), /cpanel-roster/, p);
        }
        assert.equal((await fetch(`${spa.base}/assets/nope.js`)).status, 404);
    } finally {
        await spa.close();
    }
});

test('SPA: sin fallback para /api/*, /internal/*, /health ni métodos distintos de GET/HEAD', async () => {
    const spa = await spaServer();
    try {
        assert.equal((await fetch(`${spa.base}/api/overview`)).status, 404);
        assert.equal((await fetch(`${spa.base}/internal/otra`)).status, 404);
        const health = await fetch(`${spa.base}/health`);
        assert.deepEqual(await health.json(), { status: 'ok', service: 'xroster' });
        assert.equal((await fetch(`${spa.base}/cuotas`, { method: 'POST' })).status, 404);
        assert.equal((await fetch(`${spa.base}/`, { method: 'HEAD' })).status, 200);
    } finally {
        await spa.close();
    }
});

test('/api/* se delega al handler de la API (incluido /api exacto)', async () => {
    const seen: string[] = [];
    const spa = await spaServer(async (req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(204).end();
    });
    try {
        assert.equal((await fetch(`${spa.base}/api/overview?x=1`)).status, 204);
        assert.equal((await fetch(`${spa.base}/api`, { method: 'PUT' })).status, 204);
        assert.deepEqual(seen, ['GET /api/overview?x=1', 'PUT /api']);
    } finally {
        await spa.close();
    }
});

test('parseWebhookPayload: contrato estricto §5.2', () => {
    assert.deepEqual(parseWebhookPayload(BODY), BODY);
    assert.equal(parseWebhookPayload({ ...BODY, from_me: 'false' }), null);
    assert.equal(parseWebhookPayload({ ...BODY, text: 3 }), null);
    assert.equal(parseWebhookPayload(null), null);
    assert.equal(parseWebhookPayload({ ...BODY, sender_name: undefined })?.sender_name, undefined);
});
