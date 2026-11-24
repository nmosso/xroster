import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
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

test('parseWebhookPayload: contrato estricto §5.2', () => {
    assert.deepEqual(parseWebhookPayload(BODY), BODY);
    assert.equal(parseWebhookPayload({ ...BODY, from_me: 'false' }), null);
    assert.equal(parseWebhookPayload({ ...BODY, text: 3 }), null);
    assert.equal(parseWebhookPayload(null), null);
    assert.equal(parseWebhookPayload({ ...BODY, sender_name: undefined })?.sender_name, undefined);
});
