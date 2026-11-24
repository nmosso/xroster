import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionClient, ForbiddenTargetError, EvolutionHttpError } from '../src/core/evolutionClient';

const GROUP = '120363000000000001@g.us';
const FORBIDDEN = ['as', 'tra'].join('');

function spyFetch(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return new Response('{"key":{"id":"X"}}', { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch) {
    return new EvolutionClient({ baseUrl: 'http://evo:8080/', apiKey: 'KEY', instance: 'xiptv', commandGroupId: GROUP, fetchImpl });
}

test('guardrail: destino @s.whatsapp.net -> ForbiddenTargetError sin disparar HTTP', async () => {
    const { calls, fetchImpl } = spyFetch();
    await assert.rejects(client(fetchImpl).sendText('5491100000000@s.whatsapp.net', 'hola'), ForbiddenTargetError);
    assert.equal(calls.length, 0);
});

test('guardrail: otro grupo @g.us de cliente -> ForbiddenTargetError sin disparar HTTP', async () => {
    const { calls, fetchImpl } = spyFetch();
    for (const target of ['120363099999999999@g.us', `${GROUP} `, GROUP.toUpperCase(), '', `${GROUP}.evil`]) {
        await assert.rejects(client(fetchImpl).sendText(target, 'hola'), ForbiddenTargetError, `target=${target}`);
    }
    assert.equal(calls.length, 0);
});

test('envío válido: POST /message/sendText/{instance} con apikey y body {number,text}', async () => {
    const { calls, fetchImpl } = spyFetch();
    await client(fetchImpl).sendText(GROUP, 'hola War Room');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://evo:8080/message/sendText/xiptv');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['apikey'], 'KEY');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { number: GROUP, text: 'hola War Room' });
});

test('No-Astra: el texto saliente se neutraliza como última barrera', async () => {
    const { calls, fetchImpl } = spyFetch();
    await client(fetchImpl).sendText(GROUP, `servicio ${FORBIDDEN} caído`);
    assert.doesNotMatch(String(calls[0]!.init.body), new RegExp(FORBIDDEN, 'i'));
});

test('HTTP no-2xx -> EvolutionHttpError', async () => {
    const { fetchImpl } = spyFetch(500);
    await assert.rejects(client(fetchImpl).sendText(GROUP, 'x'), EvolutionHttpError);
});

test('constructor exige commandGroupId terminado en @g.us', () => {
    const { fetchImpl } = spyFetch();
    assert.throws(() => new EvolutionClient({ baseUrl: 'http://e', apiKey: 'k', instance: 'i', commandGroupId: '549110@s.whatsapp.net', fetchImpl }));
});
