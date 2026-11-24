import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import {
    ProviderRouter, ProviderError, classifyProviderError, formatQuotaSummary,
    type ProviderAdapter, type LlmRequest, type LlmCompletion
} from '../src/providers/providerRouter';

const FORBIDDEN = ['as', 'tra'].join('');

function fakeAdapter(provider: 'gemini' | 'claude', impl: (req: LlmRequest) => Promise<LlmCompletion>): ProviderAdapter & { seen: LlmRequest[] } {
    const seen: LlmRequest[] = [];
    return {
        provider, model: `${provider}-model`, seen,
        async complete(req) { seen.push(req); return impl(req); }
    };
}

function steppingClock(stepMs: number, start = Date.parse('2026-11-24T12:00:00Z')): () => Date {
    let t = start;
    return () => { const d = new Date(t); t += stepMs; return d; };
}

const REQ: LlmRequest = { agent: 'jarvis', taskType: 'route', prompt: 'hola' };

test('complete ok: registra provider/model/agent/task/tokens/latencia/status=ok en el ledger', async () => {
    const store = new MemoryRosterStore();
    const gem = fakeAdapter('gemini', async () => ({ text: 'tank', inputTokens: 12, outputTokens: 3, cachedTokens: 4 }));
    const router = new ProviderRouter({ store, adapters: { gemini: gem }, clock: steppingClock(150) });
    const res = await router.complete('gemini', { ...REQ, metadata: { message_id: 'M1' } });
    assert.equal(res.text, 'tank');
    assert.equal(store.ledger.length, 1);
    const row = store.ledger[0]!;
    assert.equal(row.provider, 'gemini');
    assert.equal(row.model, 'gemini-model');
    assert.equal(row.agent_name, 'jarvis');
    assert.equal(row.task_type, 'route');
    assert.equal(row.input_tokens, 12);
    assert.equal(row.output_tokens, 3);
    assert.equal(row.cached_tokens, 4);
    assert.equal(row.latency_ms, 150);
    assert.equal(row.status, 'ok');
    assert.equal(row.rate_limited, false);
    assert.equal(row.error_code, null);
    assert.deepEqual(row.metadata, { message_id: 'M1' });
});

test('complete 429: registra status=rate_limited + rate_limited=true y lanza ProviderError(rateLimited)', async () => {
    const store = new MemoryRosterStore();
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const router = new ProviderRouter({ store, adapters: { claude: fakeAdapter('claude', async () => { throw err; }) } });
    await assert.rejects(router.complete('claude', { ...REQ, agent: 'shikamaru', taskType: 'planning' }), (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.rateLimited, true);
        assert.equal(e.provider, 'claude');
        return true;
    });
    const row = store.ledger[0]!;
    assert.equal(row.status, 'rate_limited');
    assert.equal(row.rate_limited, true);
    assert.equal(row.error_code, '429');
    assert.equal(row.agent_name, 'shikamaru');
});

test('complete error genérico: registra status=error con error_code y relanza', async () => {
    const store = new MemoryRosterStore();
    const err = Object.assign(new Error('boom'), { status: 500 });
    const router = new ProviderRouter({ store, adapters: { gemini: fakeAdapter('gemini', async () => { throw err; }) } });
    await assert.rejects(router.complete('gemini', REQ), (e: unknown) => e instanceof ProviderError && !e.rateLimited);
    assert.equal(store.ledger[0]!.status, 'error');
    assert.equal(store.ledger[0]!.error_code, '500');
    assert.equal(store.ledger[0]!.rate_limited, false);
});

test('proveedor no configurado -> ProviderError not_configured', async () => {
    const router = new ProviderRouter({ store: new MemoryRosterStore(), adapters: {} });
    assert.equal(router.has('claude'), false);
    await assert.rejects(router.complete('claude', REQ), (e: unknown) => e instanceof ProviderError && e.code === 'not_configured');
});

test('falla del ledger no rompe la invocación (resiliencia)', async () => {
    const store = new MemoryRosterStore();
    store.insertQuotaUsage = async () => { throw new Error('pg caído'); };
    const router = new ProviderRouter({
        store, adapters: { gemini: fakeAdapter('gemini', async () => ({ text: 'ok', inputTokens: 1, outputTokens: 1, cachedTokens: 0 })) },
        logger: { warn: () => {}, error: () => {}, info: () => {} }
    });
    assert.equal((await router.complete('gemini', REQ)).text, 'ok');
});

test('No-Astra: prompt/system se neutralizan antes del proveedor y la salida también', async () => {
    const gem = fakeAdapter('gemini', async () => ({ text: `reiniciá ${FORBIDDEN}`, inputTokens: 0, outputTokens: 0, cachedTokens: 0 }));
    const router = new ProviderRouter({ store: new MemoryRosterStore(), adapters: { gemini: gem } });
    const res = await router.complete('gemini', { ...REQ, prompt: `log de ${FORBIDDEN}server`, system: `sos ${FORBIDDEN}` });
    const re = new RegExp(FORBIDDEN, 'i');
    assert.doesNotMatch(gem.seen[0]!.prompt, re);
    assert.doesNotMatch(gem.seen[0]!.system!, re);
    assert.doesNotMatch(res.text, re);
});

test('getQuotaSummary: acumula últimas 5h y 24h por proveedor (requests, tokens, rate_limits)', async () => {
    const store = new MemoryRosterStore();
    const now = new Date('2026-11-24T12:00:00Z');
    const h = 3600_000;
    const base = { agent_name: 'jarvis', model: 'm', task_type: 'route', cached_tokens: 0, latency_ms: 1, error_code: null, metadata: {} } as const;
    await store.insertQuotaUsage({ ...base, provider: 'gemini', input_tokens: 10, output_tokens: 1, status: 'ok', rate_limited: false, created_at: new Date(now.getTime() - 1 * h) });
    await store.insertQuotaUsage({ ...base, provider: 'gemini', input_tokens: 0, output_tokens: 0, status: 'rate_limited', rate_limited: true, created_at: new Date(now.getTime() - 10 * h) });
    await store.insertQuotaUsage({ ...base, provider: 'claude', input_tokens: 100, output_tokens: 20, status: 'ok', rate_limited: false, created_at: new Date(now.getTime() - 23 * h) });
    await store.insertQuotaUsage({ ...base, provider: 'claude', input_tokens: 5, output_tokens: 5, status: 'ok', rate_limited: false, created_at: new Date(now.getTime() - 30 * h) });

    const router = new ProviderRouter({ store, adapters: {}, clock: () => now });
    const s = await router.getQuotaSummary();
    assert.deepEqual(s.last5h.map((u) => [u.provider, u.requests, u.input_tokens]), [['gemini', 1, 10]]);
    assert.deepEqual(s.last24h.map((u) => [u.provider, u.requests, u.rate_limited]), [['claude', 1, 0], ['gemini', 2, 1]]);

    const txt = formatQuotaSummary(s);
    assert.match(txt, /5h/);
    assert.match(txt, /24h/);
    assert.match(txt, /gemini/i);
    assert.match(txt, /claude/i);
    assert.match(txt, /429: 1/);
});

test('classifyProviderError: detecta 429 por status, code o texto', () => {
    assert.equal(classifyProviderError(Object.assign(new Error('x'), { status: 429 })).rateLimited, true);
    assert.equal(classifyProviderError(new Error('RESOURCE_EXHAUSTED: quota exceeded')).rateLimited, true);
    assert.equal(classifyProviderError(new Error('Claude usage limit reached')).rateLimited, true);
    assert.equal(classifyProviderError(new Error('rate_limit_error')).rateLimited, true);
    const generic = classifyProviderError(Object.assign(new Error('bad'), { code: 'ECONNRESET' }));
    assert.equal(generic.rateLimited, false);
    assert.equal(generic.code, 'ECONNRESET');
});
