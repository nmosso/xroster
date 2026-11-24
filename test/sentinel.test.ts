import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRoosterStore } from '../src/db/memoryStore';
import { FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL } from '../src/db/store';
import { Sentinel } from '../src/agents/sentinel';
import type { MonitoringSource, TenantSnapshot } from '../src/tools/monitoringSource';
import { fixedClock } from './helpers';

const MIN = 60_000;

/** Fuente controlable: estado por tenant -> hash con timestamps relativos al reloj. */
function controllableSource(nowSec: () => number) {
    const down = new Set<string>();
    const tenants = new Set<string>();
    let fail = false;
    const snapshot = (pos: string): TenantSnapshot => ({
        position: pos,
        hash: {
            proxmox_ts: String(nowSec() - 10),
            xmanager_ts: String(nowSec() - (down.has(pos) ? 900 : 10))
        }
    });
    const source: MonitoringSource = {
        async listSnapshots() {
            if (fail) throw new Error('ECONNREFUSED redis');
            return [...tenants].map(snapshot);
        },
        async getSnapshot(pos) { return tenants.has(pos) ? snapshot(pos) : null; }
    };
    return {
        source,
        add: (...pos: string[]) => pos.forEach((p) => tenants.add(p)),
        down: (...pos: string[]) => pos.forEach((p) => down.add(p)),
        up: (...pos: string[]) => pos.forEach((p) => down.delete(p)),
        setFail: (v: boolean) => { fail = v; }
    };
}

function setup() {
    const store = new MemoryRoosterStore();
    const c = fixedClock();
    const src = controllableSource(() => Math.floor(c.nowMs() / 1000));
    const sent: string[] = [];
    const sentinel = new Sentinel({
        store, source: src.source, clock: c.clock,
        notify: async (t) => { sent.push(t); },
        resolveName: async (pos) => `Tenant${pos}`,
        cooldownMs: 30 * MIN, stormThreshold: 3, pollMs: 60_000
    });
    return { store, src, sent, sentinel, advance: c.advance };
}

test('transición caída -> alerta -> cooldown -> recordatorio -> recuperación', async () => {
    const t = setup();
    t.src.add('43');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 0, 'todo ok no alerta');

    t.src.down('43');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]!, /^🛡️ \*Sentinel\*/);
    assert.match(t.sent[0]!, /CAÍDO/);
    assert.match(t.sent[0]!, /43 Tenant43/);
    assert.match(t.sent[0]!, /xManager/);
    const row = await t.store.getAlertState('43:xmanager');
    assert.equal(row?.state, 'down');
    assert.ok(row?.last_notified_at);

    t.advance(10 * MIN);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1, 'dentro del cooldown no re-alerta');

    t.advance(21 * MIN);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 2, 'pasado el cooldown re-alerta');
    assert.match(t.sent[1]!, /sigue/i);

    t.src.up('43');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 3);
    assert.match(t.sent[2]!, /✅ RECUPERADO/);
    assert.equal((await t.store.getAlertState('43:xmanager'))?.state, 'ok');
});

test('anti-tormenta: 10 cabeceras caen en el mismo tick -> 1 solo mensaje consolidado', async () => {
    const t = setup();
    const ids = Array.from({ length: 10 }, (_, i) => String(40 + i));
    t.src.add(...ids);
    t.src.down(...ids);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]!, /10 incidencias/);
    for (const id of ids) assert.match(t.sent[0]!, new RegExp(`${id} Tenant${id}`));
    assert.equal((await t.store.listAlertStates({ nonOkOnly: true })).length, 10);

    t.src.up(...ids);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 2, 'recuperación masiva también consolidada');
    assert.match(t.sent[1]!, /RECUPERADO/);
});

test('umbral: 3 eventos -> 3 mensajes; 4 eventos -> 1 consolidado', async () => {
    const a = setup();
    a.src.add('1', '2', '3');
    a.src.down('1', '2', '3');
    await a.sentinel.tick();
    assert.equal(a.sent.length, 3);

    const b = setup();
    b.src.add('1', '2', '3', '4');
    b.src.down('1', '2', '3', '4');
    await b.sentinel.tick();
    assert.equal(b.sent.length, 1);
});

test('PAUSAR: con paused=true el tick no lee Redis ni alerta', async () => {
    const t = setup();
    t.src.add('43');
    t.src.down('43');
    await t.store.setFlag(FLAG_PAUSED, 'true');
    const r = await t.sentinel.tick();
    assert.equal(r.skipped, 'paused');
    assert.equal(t.sent.length, 0);
    await t.store.setFlag(FLAG_PAUSED, 'false');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
});

test('SILENCIAR tenant: registra estado sin avisar; al vencer el silencio alerta', async () => {
    const t = setup();
    t.src.add('43', '44');
    assert.match(await t.sentinel.silence('43', 30), /43/);
    t.src.down('43', '44');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]!, /44/);
    assert.equal((await t.store.getAlertState('43:xmanager'))?.state, 'down');

    t.advance(31 * MIN);
    await t.sentinel.tick();
    assert.ok(t.sent.some((m) => /43 Tenant43/.test(m)), 'vencido el silencio, alerta 43');
});

test('SILENCIAR all: silencia todo; recuperación de algo nunca notificado no genera RECUPERADO', async () => {
    const t = setup();
    t.src.add('43');
    assert.match(await t.sentinel.silence('all', 15), /todos/i);
    assert.ok(await t.store.getFlag(FLAG_SILENCED_ALL_UNTIL));
    t.src.down('43');
    await t.sentinel.tick();
    t.src.up('43');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 0);
});

test('SILENCIAR: target inválido devuelve uso', async () => {
    const t = setup();
    assert.match(await t.sentinel.silence('rm -rf', 10), /inválido/i);
});

test('consulta bajo demanda "¿qué está caído?" lista incidencias activas', async () => {
    const t = setup();
    assert.match(await t.sentinel.handle({ text: '¿qué está caído?', senderPhone: '', messageId: 'x' }), /Todo operativo/);
    t.src.add('43');
    t.src.down('43');
    await t.sentinel.tick();
    const txt = await t.sentinel.handle({ text: '¿qué está caído?', senderPhone: '', messageId: 'y' });
    assert.match(txt, /43 Tenant43/);
    assert.match(txt, /xManager/);
    assert.equal(await t.sentinel.activeAlertCount(), 1);
});

test('L3: Redis caído -> tick no lanza, registra error y el loop sigue', async () => {
    const t = setup();
    t.src.setFail(true);
    const r = await t.sentinel.tick();
    assert.match(r.error ?? '', /ECONNREFUSED/);
    t.src.setFail(false);
    t.src.add('43');
    t.src.down('43');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
});

test('fallo al notificar: no marca last_notified_at para reintentar en el próximo tick', async () => {
    const store = new MemoryRoosterStore();
    const c = fixedClock();
    const src = controllableSource(() => Math.floor(c.nowMs() / 1000));
    let fail = true;
    const sent: string[] = [];
    const s = new Sentinel({
        store, source: src.source, clock: c.clock, cooldownMs: 30 * MIN, stormThreshold: 3, pollMs: 60_000,
        notify: async (m) => { if (fail) throw new Error('evolution caído'); sent.push(m); }
    });
    src.add('43');
    src.down('43');
    await s.tick();
    assert.equal((await store.getAlertState('43:xmanager'))?.last_notified_at, null);
    fail = false;
    c.advance(MIN);
    await s.tick();
    assert.equal(sent.length, 1);
});

test('start/stop: polling periódico sin solapamiento', async () => {
    const t = setup();
    let ticks = 0;
    const s = new Sentinel({
        store: t.store, source: { async listSnapshots() { ticks++; await new Promise((r) => setTimeout(r, 30)); return []; }, async getSnapshot() { return null; } },
        notify: async () => {}, cooldownMs: 1, stormThreshold: 3, pollMs: 10
    });
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    await s.stop();
    const after = ticks;
    assert.ok(after >= 2 && after <= 5, `ticks=${after}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ticks, after, 'stop detiene el polling');
});
