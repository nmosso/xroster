import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAdapter, type GeminiClientLike } from '../src/providers/geminiAdapter';
import { ClaudeCliAdapter, ClaudeApiAdapter } from '../src/providers/claudeAdapter';
import { classifyProviderError } from '../src/providers/providerRouter';
import type { CommandRunner, RunOptions } from '../src/tools/commandRunner';

test('GeminiAdapter: default gemini-2.5-flash, mapea texto y usageMetadata', async () => {
    let params: unknown;
    const client: GeminiClientLike = {
        models: {
            async generateContent(p) {
                params = p;
                return { text: 'sentinel', usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2, cachedContentTokenCount: 5 } };
            }
        }
    };
    const a = new GeminiAdapter({ client });
    assert.equal(a.model, 'gemini-2.5-flash');
    const r = await a.complete({ agent: 'jarvis', taskType: 'route', prompt: 'p', system: 's', maxOutputTokens: 50 });
    assert.deepEqual(r, { text: 'sentinel', inputTokens: 20, outputTokens: 2, cachedTokens: 5 });
    assert.deepEqual(params, {
        model: 'gemini-2.5-flash', contents: 'p', config: { systemInstruction: 's', maxOutputTokens: 50 }
    });
});

test('GeminiAdapter: error 429 del SDK se propaga y clasifica como rate limit', async () => {
    const client: GeminiClientLike = { models: { async generateContent() { throw Object.assign(new Error('quota'), { status: 429 }); } } };
    const a = new GeminiAdapter({ client, model: 'gemini-x' });
    await assert.rejects(a.complete({ agent: 'jarvis', taskType: 'route', prompt: 'p' }), (e: unknown) => classifyProviderError(e).rateLimited);
});

function fakeRunner(result: { code: number | null; stdout: string; stderr?: string; timedOut?: boolean }) {
    const calls: { cmd: string; args: readonly string[]; opts: RunOptions }[] = [];
    const runner: CommandRunner = async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? '', timedOut: result.timedOut ?? false };
    };
    return { runner, calls };
}

test('ClaudeCliAdapter: invoca `claude -p` con JSON, prompt por stdin y mapea usage', async () => {
    const out = JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result: 'respuesta',
        usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 11 }
    });
    const { runner, calls } = fakeRunner({ code: 0, stdout: out });
    const a = new ClaudeCliAdapter({ runner, model: 'claude-sonnet-4-5' });
    const r = await a.complete({ agent: 'shikamaru', taskType: 'planning', prompt: 'contexto grande', system: 'sistema' });
    assert.deepEqual(r, { text: 'respuesta', inputTokens: 30, outputTokens: 7, cachedTokens: 11 });
    const c = calls[0]!;
    assert.equal(c.cmd, 'claude');
    assert.deepEqual(c.args.slice(0, 5), ['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-5']);
    assert.ok(c.args.includes('--append-system-prompt'));
    assert.equal(c.opts.input, 'contexto grande');
    assert.ok(!c.args.includes('contexto grande'));
});

test('ClaudeCliAdapter: límite de uso del plan -> error rate limit', async () => {
    const out = JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1763990000' });
    const { runner } = fakeRunner({ code: 1, stdout: out });
    const a = new ClaudeCliAdapter({ runner, model: 'm' });
    await assert.rejects(a.complete({ agent: 'shikamaru', taskType: 'planning', prompt: 'p' }), (e: unknown) => classifyProviderError(e).rateLimited);
});

test('ClaudeCliAdapter: timeout -> error no rate limit', async () => {
    const { runner } = fakeRunner({ code: null, stdout: '', timedOut: true });
    const a = new ClaudeCliAdapter({ runner, model: 'm' });
    await assert.rejects(a.complete({ agent: 'shikamaru', taskType: 'planning', prompt: 'p' }), (e: unknown) => {
        const c = classifyProviderError(e);
        return c.code === 'timeout' && !c.rateLimited;
    });
});

test('ClaudeApiAdapter: POST /v1/messages con headers y mapea usage', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return new Response(JSON.stringify({
            content: [{ type: 'text', text: 'hola' }, { type: 'text', text: ' mundo' }],
            usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const a = new ClaudeApiAdapter({ apiKey: 'sk-test', model: 'claude-sonnet-4-5', fetchImpl });
    const r = await a.complete({ agent: 'shikamaru', taskType: 'planning', prompt: 'p', system: 's', maxOutputTokens: 100 });
    assert.deepEqual(r, { text: 'hola mundo', inputTokens: 9, outputTokens: 4, cachedTokens: 2 });
    assert.equal(captured!.url, 'https://api.anthropic.com/v1/messages');
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(String(captured!.init.body));
    assert.deepEqual(body, { model: 'claude-sonnet-4-5', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'p' }] });
});

test('ClaudeApiAdapter: HTTP 429 -> error rate limit', async () => {
    const fetchImpl = (async () => new Response('{"type":"error","error":{"type":"rate_limit_error"}}', { status: 429 })) as typeof fetch;
    const a = new ClaudeApiAdapter({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(a.complete({ agent: 'shikamaru', taskType: 'planning', prompt: 'p' }), (e: unknown) => classifyProviderError(e).rateLimited);
});
