import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL } from '../src/db/store';
import { Sentinel, type SentinelOptions } from '../src/agents/sentinel';
import type { Component } from '../src/core/health';
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

/** Modo previo al filtro de push: todos los componentes, reminders y sin gracia (cubre la máquina de estados base). */
const LEGACY: Partial<SentinelOptions> = {
    notifyComponents: ['proxmox', 'xmanager', 'multicast', 'streamer', 'ird'], notifyReminders: true, vmGraceMs: 0, irdGraceMs: 0
};

function setup(over: Partial<SentinelOptions> = LEGACY) {
    const store = new MemoryRosterStore();
    const c = fixedClock();
    const src = controllableSource(() => Math.floor(c.nowMs() / 1000));
    const sent: string[] = [];
    const sentinel = new Sentinel({
        store, source: src.source, clock: c.clock,
        notify: async (t) => { sent.push(t); },
        resolveName: async (pos) => `Tenant${pos}`,
        cooldownMs: 30 * MIN, stormThreshold: 3, pollMs: 60_000,
        ...over
    });
    return { store, src, sent, sentinel, advance: c.advance };
}

/** Fuente por componente: cualquier combinación de proxmox/xmanager/multicast/streamer/ird caída en el tenant 43. */
function componentSource(nowSec: () => number) {
    const down = new Set<Component>();
    const source: MonitoringSource = {
        async listSnapshots() {
            const hash: Record<string, string> = {};
            for (const n of ['proxmox', 'xmanager', 'multicast', 'streamer'] as const) {
                hash[`${n}_ts`] = String(nowSec() - (down.has(n) ? 900 : 10));
            }
            hash['ird_summary'] = JSON.stringify({ signal_status: down.has('ird') ? 'red' : 'green', bitrate_status: 'green' });
            return [{ position: '43', hash }];
        },
        async getSnapshot() { return null; }
    };
    return { source, down: (...c: Component[]) => c.forEach((x) => down.add(x)), up: (...c: Component[]) => c.forEach((x) => down.delete(x)) };
}

/** Sentinel con los defaults de producción (sin overrides de notificación). */
function prodSetup(over: Partial<SentinelOptions> = {}) {
    const store = new MemoryRosterStore();
    const c = fixedClock();
    const src = componentSource(() => Math.floor(c.nowMs() / 1000));
    const sent: string[] = [];
    const sentinel = new Sentinel({
        store, source: src.source, clock: c.clock, notify: async (t) => { sent.push(t); },
        cooldownMs: 30 * MIN, stormThreshold: 3, pollMs: 60_000, ...over
    });
    /** Avanza `ms` en pasos de 1 min con un tick por paso (polling real). */
    const run = async (ms: number) => {
        for (let t = 0; t < ms; t += MIN) { c.advance(MIN); await sentinel.tick(); }
    };
    return { store, src, sent, sentinel, advance: c.advance, run };
}

test('default notifyComponents=[proxmox]: xmanager/multicast/streamer/ird persisten en DB pero 0 mensajes WhatsApp', async () => {
    const t = prodSetup();
    await t.sentinel.tick();
    t.src.down('xmanager', 'multicast', 'streamer', 'ird');
    await t.sentinel.tick();
    await t.run(60 * MIN);
    for (const comp of ['xmanager', 'multicast', 'streamer', 'ird']) {
        const row = await t.store.getAlertState(`43:${comp}`);
        assert.equal(row?.state, 'down', comp);
        assert.equal(row?.last_notified_at, null, comp);
    }
    assert.equal(await t.sentinel.activeAlertCount(), 4, 'consulta on request los ve');
    assert.match(await t.sentinel.whatIsDown(), /xManager/);
    t.src.up('xmanager', 'multicast', 'streamer', 'ird');
    await t.sentinel.tick();
    assert.equal((await t.store.getAlertState('43:ird'))?.state, 'ok');
    assert.equal(t.sent.length, 0);
});

test('gracia proxmox: micro-corte < 2 min se registra y se recupera en silencio (0 mensajes)', async () => {
    const t = prodSetup();
    await t.sentinel.tick();
    t.src.down('proxmox');
    await t.sentinel.tick();
    const row = await t.store.getAlertState('43:proxmox');
    assert.equal(row?.state, 'down', 'persiste de inmediato');
    assert.equal(row?.last_notified_at, null);
    t.advance(MIN + 59_000);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 0, '1:59 sigue dentro de la gracia');
    t.src.up('proxmox');
    await t.sentinel.tick();
    assert.equal((await t.store.getAlertState('43:proxmox'))?.state, 'ok');
    assert.equal(t.sent.length, 0);
});

test('gracia proxmox: caída >= 2 min notifica 1 vez, sin reminders tras 30+ min, y RECUPERADO al volver', async () => {
    const t = prodSetup();
    await t.sentinel.tick();
    t.src.down('proxmox');
    await t.sentinel.tick();
    t.advance(2 * MIN);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]!, /CAÍDO · 43 · Proxmox/);
    assert.ok((await t.store.getAlertState('43:proxmox'))?.last_notified_at);

    await t.run(45 * MIN);
    assert.equal(t.sent.length, 1, 'notifyReminders=false: sin recordatorios');

    t.src.up('proxmox');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 2);
    assert.match(t.sent[1]!, /✅ RECUPERADO · 43 · Proxmox/);
});

test('gracia IRD (habilitado): < 10 min silencioso; >= 10 min notifica 1 vez, sin reminders, RECUPERADO', async () => {
    const micro = prodSetup({ notifyComponents: ['proxmox', 'ird'] });
    await micro.sentinel.tick();
    micro.src.down('ird');
    await micro.sentinel.tick();
    await micro.run(9 * MIN);
    micro.src.up('ird');
    await micro.sentinel.tick();
    assert.equal(micro.sent.length, 0, 'micro-corte IRD < 10 min');

    const t = prodSetup({ notifyComponents: ['proxmox', 'ird'] });
    await t.sentinel.tick();
    t.src.down('ird');
    await t.sentinel.tick();
    await t.run(9 * MIN);
    assert.equal(t.sent.length, 0, 'la gracia de 2 min de VM no aplica a IRD');
    await t.run(MIN);
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0]!, /IRD/);
    await t.run(40 * MIN);
    assert.equal(t.sent.length, 1);
    t.src.up('ird');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 2);
    assert.match(t.sent[1]!, /✅ RECUPERADO · 43 · IRD/);
});

test('gracia: cambio de severidad antes de notificar no adelanta el aviso; tras notificar emite changed', async () => {
    const t = prodSetup({ notifyComponents: ['multicast'] });
    const degraded = (on: boolean) => {
        const base = t.src.source.listSnapshots.bind(t.src.source);
        t.src.source.listSnapshots = async () => {
            const snaps = await base();
            if (on) snaps[0]!.hash['multicast_errors'] = JSON.stringify({ down_channels: 3, total_channels: 10 });
            return snaps;
        };
    };
    await t.sentinel.tick();
    degraded(true);
    await t.sentinel.tick();
    t.advance(MIN);
    t.src.down('multicast');
    await t.sentinel.tick();
    assert.equal(t.sent.length, 0, 'degraded -> down dentro de la gracia: sin aviso');
    t.advance(MIN);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 1, 'gracia contada desde first_seen_at');
    assert.match(t.sent[0]!, /CAÍDO/);
    t.src.up('multicast');
    t.advance(MIN);
    await t.sentinel.tick();
    assert.equal(t.sent.length, 2);
    assert.match(t.sent[1]!, /DEGRADADO/, 'down -> degraded tras notificar: changed');
});

test('notifyReminders=true conserva el recordatorio por cooldown', async () => {
    const t = prodSetup({ notifyReminders: true });
    await t.sentinel.tick();
    t.src.down('proxmox');
    await t.sentinel.tick();
    await t.run(2 * MIN);
    assert.equal(t.sent.length, 1);
    await t.run(30 * MIN);
    assert.equal(t.sent.length, 2);
    assert.match(t.sent[1]!, /Sigue/);
});

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
    const store = new MemoryRosterStore();
    const c = fixedClock();
    const src = controllableSource(() => Math.floor(c.nowMs() / 1000));
    let fail = true;
    const sent: string[] = [];
    const s = new Sentinel({
        store, source: src.source, clock: c.clock, cooldownMs: 30 * MIN, stormThreshold: 3, pollMs: 60_000, ...LEGACY,
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
