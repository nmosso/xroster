import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { ApprovalManager, APPROVAL_TTL_MS } from '../src/core/approvals';

function setup(start = Date.parse('2026-11-24T12:00:00Z')) {
    let now = start;
    const store = new MemoryRosterStore();
    const executed: string[] = [];
    const mgr = new ApprovalManager({ store, clock: () => new Date(now) });
    mgr.register('restart_service', async (a) => {
        executed.push(a.code);
        return `servicio ${String(a.payload['service'])} reiniciado · post-check: active`;
    });
    return { store, mgr, executed, advance: (ms: number) => { now += ms; } };
}

const REQ = {
    prefix: 'TK' as const, agentName: 'tank', actionType: 'restart_service' as const, targetTenant: '43',
    summaryText: 'Reiniciar streamer en 43 (Frentones)', payload: { service: 'streamer', position: '43' }
};

test('request: código TK-XXX, TTL 5 min, persistido pending', async () => {
    const { mgr, store } = setup();
    const a = await mgr.request(REQ);
    assert.match(a.code, /^TK-\d{3}$/);
    assert.equal(APPROVAL_TTL_MS, 5 * 60_000);
    assert.equal(a.expires_at.getTime() - a.requested_at.getTime(), APPROVAL_TTL_MS);
    assert.equal((await store.getApproval(a.code))?.status, 'pending');
});

test('request: acción sin handler registrado se rechaza antes de crear approval', async () => {
    const { mgr, store } = setup();
    await assert.rejects(mgr.request({ ...REQ, actionType: 'git_push_draft', prefix: 'SH' }));
    assert.equal(await store.countApprovals('pending'), 0);
});

test('confirm dentro del TTL: ejecuta handler y marca executed con result_summary', async () => {
    const { mgr, store, executed, advance } = setup();
    const a = await mgr.request(REQ);
    advance(60_000);
    const msg = await mgr.confirm(a.code);
    assert.deepEqual(executed, [a.code]);
    assert.match(msg, /✅/);
    assert.match(msg, /post-check: active/);
    const row = await store.getApproval(a.code);
    assert.equal(row?.status, 'executed');
    assert.match(row?.result_summary ?? '', /reiniciado/);
    assert.ok(row?.decided_at);
});

test('L1: CONFIRMAR después de 5 min -> expired y NO ejecuta', async () => {
    const { mgr, store, executed, advance } = setup();
    const a = await mgr.request(REQ);
    advance(APPROVAL_TTL_MS + 1);
    const msg = await mgr.confirm(a.code);
    assert.match(msg, /expir/i);
    assert.deepEqual(executed, []);
    assert.equal((await store.getApproval(a.code))?.status, 'expired');
});

test('L1: CONFIRMAR enviado dos veces -> idempotente, la segunda informa que ya fue ejecutado', async () => {
    const { mgr, executed } = setup();
    const a = await mgr.request(REQ);
    await mgr.confirm(a.code);
    const second = await mgr.confirm(a.code);
    assert.match(second, /ya fue ejecutad/i);
    assert.equal(executed.length, 1);
});

test('confirm concurrente: solo una ejecución', async () => {
    const { mgr, executed } = setup();
    const a = await mgr.request(REQ);
    await Promise.all([mgr.confirm(a.code), mgr.confirm(a.code), mgr.confirm(a.code)]);
    assert.equal(executed.length, 1);
});

test('cancel: pending -> cancelled; confirmar luego se rechaza', async () => {
    const { mgr, executed, store } = setup();
    const a = await mgr.request(REQ);
    assert.match(await mgr.cancel(a.code), /cancelad/i);
    assert.equal((await store.getApproval(a.code))?.status, 'cancelled');
    assert.match(await mgr.confirm(a.code), /cancelad/i);
    assert.deepEqual(executed, []);
});

test('código inexistente o mal formado: mensaje claro sin ejecutar', async () => {
    const { mgr } = setup();
    assert.match(await mgr.confirm('TK-000'), /no existe/i);
    assert.match(await mgr.confirm('rm -rf'), /inválido/i);
    assert.match(await mgr.cancel('XX-1'), /inválido/i);
});

test('código en minúsculas se normaliza', async () => {
    const { mgr, executed } = setup();
    const a = await mgr.request(REQ);
    await mgr.confirm(a.code.toLowerCase());
    assert.equal(executed.length, 1);
});

test('handler que falla -> status failed con detalle', async () => {
    const store = new MemoryRosterStore();
    const mgr = new ApprovalManager({ store });
    mgr.register('restart_service', async () => { throw new Error('ssh timeout'); });
    const a = await mgr.request(REQ);
    const msg = await mgr.confirm(a.code);
    assert.match(msg, /❌/);
    assert.match(msg, /ssh timeout/);
    assert.equal((await store.getApproval(a.code))?.status, 'failed');
});

test('colisión de código: reintenta con otro aleatorio', async () => {
    const store = new MemoryRosterStore();
    const seq = [0.5, 0.5, 0.1];
    const mgr = new ApprovalManager({ store, random: () => seq.shift() ?? 0.9 });
    mgr.register('restart_service', async () => 'ok');
    const a = await mgr.request(REQ);
    const b = await mgr.request(REQ);
    assert.notEqual(a.code, b.code);
});
