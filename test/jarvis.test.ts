import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { FLAG_PAUSED } from '../src/db/store';
import { ApprovalManager } from '../src/core/approvals';
import { Jarvis, parseCommand, detectMention, type SpecialistAgent, type SentinelControl, type SpecialistName } from '../src/core/jarvis';
import type { WebhookPayload } from '../src/core/webhook';
import { ProviderRouter, ProviderError } from '../src/providers/providerRouter';
import { GROUP, OWNER, fakeMessenger, fakeAdapter, completion, fixedClock } from './helpers';

function agent(name: SpecialistName, impl?: (text: string) => Promise<string>): SpecialistAgent & { calls: string[] } {
    const calls: string[] = [];
    return {
        name, calls,
        async handle(req) {
            calls.push(req.text);
            return impl ? impl(req.text) : `respuesta de ${name}`;
        }
    };
}

function setup(opts: { classify?: string } = {}) {
    const store = new MemoryRosterStore();
    const messenger = fakeMessenger();
    const { clock, advance } = fixedClock();
    const approvals = new ApprovalManager({ store, clock });
    const gemini = fakeAdapter('gemini', () => completion(opts.classify ?? 'ninguno'));
    const router = new ProviderRouter({ store, adapters: { gemini }, clock });
    const agents = { sentinel: agent('sentinel'), tank: agent('tank'), shikamaru: agent('shikamaru') };
    const silences: [string, number][] = [];
    const sentinelControl: SentinelControl = {
        async silence(target, minutes) { silences.push([target, minutes]); return `silenciado ${target} ${minutes}`; },
        async activeAlertCount() { return 2; }
    };
    const jarvis = new Jarvis({
        commandGroupId: GROUP, ownerPhones: new Set([OWNER]), store, messenger, approvals, router, agents, sentinelControl, clock
    });
    return { store, messenger, approvals, gemini, router, agents, silences, jarvis, advance };
}

let seq = 0;
function msg(text: string, over: Partial<WebhookPayload> = {}): WebhookPayload {
    return { message_id: `M${++seq}`, group_id: GROUP, sender_phone: OWNER, sender_name: 'Op', from_me: false, text, timestamp: 1763980000, ...over };
}

// ---------------- Auth / guardrails ----------------

test('auth E.164: remitente fuera de whitelist -> unauthorized en audit, cero agentes, cero mensajes', async () => {
    const t = setup();
    const m = msg('@Tank reiniciá todo', { sender_phone: '5491199999999' });
    const out = await t.jarvis.handle(m);
    assert.equal(out.status, 'unauthorized');
    assert.equal((await t.store.getAudit(m.message_id))?.status, 'unauthorized');
    assert.equal(t.agents.tank.calls.length, 0);
    assert.equal(t.messenger.sent.length, 0);
});

test('auth E.164: 54 sin 9 se normaliza a 549 y queda autorizado (igual que xBackend)', async () => {
    const t = setup();
    const out = await t.jarvis.handle(msg('AYUDA', { sender_phone: '541122334455' }));
    assert.equal(out.status, 'ok');
    assert.equal(t.messenger.sent.length, 1);
});

test('dedup por message_id: el segundo webhook igual no se procesa', async () => {
    const t = setup();
    const m = msg('@Tank estado server 43');
    assert.equal((await t.jarvis.handle(m)).status, 'ok');
    assert.equal((await t.jarvis.handle({ ...m })).status, 'duplicate');
    assert.equal(t.agents.tank.calls.length, 1);
});

test('group_id distinto del War Room -> ignored sin respuesta', async () => {
    const t = setup();
    const out = await t.jarvis.handle(msg('STATUS', { group_id: '120363099999999999@g.us' }));
    assert.equal(out.status, 'ignored');
    assert.equal(t.messenger.sent.length, 0);
});

test('from_me: true -> ignorado silenciosamente (sin audit ni respuesta)', async () => {
    const t = setup();
    const m = msg('🛡️ *Sentinel* alerta', { from_me: true });
    assert.equal((await t.jarvis.handle(m)).status, 'ignored');
    assert.equal(await t.store.getAudit(m.message_id), null);
    assert.equal(t.messenger.sent.length, 0);
});

test('todas las respuestas salen solo al War Room', async () => {
    const t = setup();
    await t.jarvis.handle(msg('AYUDA'));
    await t.jarvis.handle(msg('@Tank hola'));
    assert.ok(t.messenger.sent.every((s) => s.target === GROUP));
});

// ---------------- Comandos deterministas ----------------

test('parseCommand: reconoce comandos con acentos/minúsculas y valida argumentos', () => {
    assert.deepEqual(parseCommand('status'), { type: 'status' });
    assert.deepEqual(parseCommand(' PAUSAR '), { type: 'pause' });
    assert.deepEqual(parseCommand('Reanudar'), { type: 'resume' });
    assert.deepEqual(parseCommand('SILENCIAR 43 30'), { type: 'silence', target: '43', minutes: 30 });
    assert.deepEqual(parseCommand('silenciar ALL 60'), { type: 'silence', target: 'all', minutes: 60 });
    assert.equal(parseCommand('SILENCIAR 43')?.type, 'invalid');
    assert.equal(parseCommand('SILENCIAR 43 0')?.type, 'invalid');
    assert.equal(parseCommand('SILENCIAR 43 99999')?.type, 'invalid');
    assert.deepEqual(parseCommand('confirmar tk-482'), { type: 'confirm', code: 'TK-482' });
    assert.deepEqual(parseCommand('CANCELAR SH-109'), { type: 'cancel', code: 'SH-109' });
    assert.equal(parseCommand('CONFIRMAR')?.type, 'invalid');
    assert.deepEqual(parseCommand('ayuda'), { type: 'help' });
    assert.equal(parseCommand('@Tank revisá el server 43'), null);
});

test('STATUS: determinista (sin LLM) con pausa, alertas, aprobaciones y cuotas 5h/24h', async () => {
    const t = setup();
    const out = await t.jarvis.handle(msg('STATUS'));
    assert.equal(out.status, 'ok');
    assert.equal(t.gemini.seen.length, 0);
    const text = t.messenger.sent[0]!.text;
    assert.match(text, /🤖 \*Jarvis\*/);
    assert.match(text, /activo/i);
    assert.match(text, /Alertas activas: 2/);
    assert.match(text, /Aprobaciones pendientes: 0/);
    assert.match(text, /5h/);
    assert.match(text, /24h/);
});

test('PAUSAR / REANUDAR: cambian system_flags.paused sin LLM', async () => {
    const t = setup();
    await t.jarvis.handle(msg('PAUSAR'));
    assert.equal(await t.store.getFlag(FLAG_PAUSED), 'true');
    await t.jarvis.handle(msg('STATUS'));
    assert.match(t.messenger.sent.at(-1)!.text, /PAUSADO/);
    await t.jarvis.handle(msg('REANUDAR'));
    assert.equal(await t.store.getFlag(FLAG_PAUSED), 'false');
    assert.equal(t.gemini.seen.length, 0);
});

test('SILENCIAR <tenant|all> <minutos>: delega en Sentinel; inválido muestra uso', async () => {
    const t = setup();
    await t.jarvis.handle(msg('SILENCIAR 43 30'));
    await t.jarvis.handle(msg('SILENCIAR all 15'));
    assert.deepEqual(t.silences, [['43', 30], ['all', 15]]);
    await t.jarvis.handle(msg('SILENCIAR 43 nunca'));
    assert.match(t.messenger.sent.at(-1)!.text, /SILENCIAR <tenant\|all> <minutos>/);
});

test('AYUDA: lista comandos', async () => {
    const t = setup();
    await t.jarvis.handle(msg('AYUDA'));
    const text = t.messenger.sent[0]!.text;
    for (const c of ['STATUS', 'PAUSAR', 'REANUDAR', 'SILENCIAR', 'CONFIRMAR', 'CANCELAR', 'Tank', 'Sentinel', 'Shikamaru']) {
        assert.match(text, new RegExp(c));
    }
});

// ---------------- Flujo L1 completo ----------------

test('flujo L1: agente pide approval -> CONFIRMAR ejecuta; segunda vez idempotente; expirada rechaza', async () => {
    const t = setup();
    let executions = 0;
    t.approvals.register('restart_service', async () => { executions++; return 'reiniciado · post-check: active'; });
    let code = '';
    t.agents.tank.handle = async () => {
        const a = await t.approvals.request({
            prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '43', summaryText: 'Reiniciar streamer', payload: {}
        });
        code = a.code;
        return `Respondé CONFIRMAR ${a.code}`;
    };
    await t.jarvis.handle(msg('@Tank reiniciá streamer del 43'));
    assert.match(t.messenger.sent.at(-1)!.text, /🔧 \*Tank\*/);
    assert.equal(executions, 0);

    await t.jarvis.handle(msg(`CONFIRMAR ${code}`));
    assert.equal(executions, 1);
    assert.match(t.messenger.sent.at(-1)!.text, /post-check: active/);

    await t.jarvis.handle(msg(`CONFIRMAR ${code}`));
    assert.equal(executions, 1);
    assert.match(t.messenger.sent.at(-1)!.text, /ya fue ejecutad/i);

    await t.jarvis.handle(msg('@Tank reiniciá streamer del 43'));
    const code2 = code;
    t.advance(5 * 60_000 + 1);
    await t.jarvis.handle(msg(`CONFIRMAR ${code2}`));
    assert.equal(executions, 1);
    assert.match(t.messenger.sent.at(-1)!.text, /expir/i);
});

test('CANCELAR <código>: cancela la solicitud pendiente', async () => {
    const t = setup();
    t.approvals.register('restart_service', async () => 'x');
    const a = await t.approvals.request({ prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: '1', summaryText: 's', payload: {} });
    await t.jarvis.handle(msg(`CANCELAR ${a.code}`));
    assert.equal((await t.store.getApproval(a.code))?.status, 'cancelled');
});

// ---------------- Router de intenciones ----------------

test('detectMention: @Tank / Tank / Sentinel / Shikamaru (case-insensitive)', () => {
    assert.equal(detectMention('@Tank revisá el server 43')?.agent, 'tank');
    assert.equal(detectMention('tank, estado del 12')?.agent, 'tank');
    assert.equal(detectMention('Sentinel qué pasa')?.agent, 'sentinel');
    assert.equal(detectMention('che @shikamaru armá un borrador')?.agent, 'shikamaru');
    assert.equal(detectMention('revisá el server 43'), null);
    assert.equal(detectMention('@Tank revisá el server 43')?.rest, 'revisá el server 43');
});

test('mención explícita: enruta sin LLM y firma con el agente', async () => {
    const t = setup();
    await t.jarvis.handle(msg('@Tank revisá el server 43'));
    await t.jarvis.handle(msg('Shikamaru qué dice el REQ-2026-012'));
    await t.jarvis.handle(msg('Sentinel resumen'));
    assert.deepEqual(t.agents.tank.calls, ['revisá el server 43']);
    assert.equal(t.agents.shikamaru.calls.length, 1);
    assert.equal(t.agents.sentinel.calls.length, 1);
    assert.equal(t.gemini.seen.length, 0);
    const texts = t.messenger.sent.map((s) => s.text);
    assert.match(texts[0]!, /^🔧 \*Tank\*/);
    assert.match(texts[1]!, /^🧠 \*Shikamaru\*/);
    assert.match(texts[2]!, /^🛡️ \*Sentinel\*/);
});

test('"¿qué está caído?" va a Sentinel de forma determinista (sin LLM)', async () => {
    const t = setup();
    await t.jarvis.handle(msg('¿qué está caído?'));
    assert.equal(t.agents.sentinel.calls.length, 1);
    assert.equal(t.gemini.seen.length, 0);
});

test('mensaje ambiguo: clasifica con Gemini Flash (task route, ledger) y enruta', async () => {
    const t = setup({ classify: 'Shikamaru' });
    await t.jarvis.handle(msg('cómo venimos con la planificación del trimestre'));
    assert.equal(t.gemini.seen.length, 1);
    assert.equal(t.gemini.seen[0]!.taskType, 'route');
    assert.equal(t.agents.shikamaru.calls.length, 1);
    assert.equal(t.store.ledger[0]!.task_type, 'route');
    assert.equal(t.store.ledger[0]!.agent_name, 'jarvis');
});

test('clasificación sin agente claro: Jarvis responde con ayuda breve', async () => {
    const t = setup({ classify: 'no sé' });
    await t.jarvis.handle(msg('hola'));
    assert.equal(t.agents.tank.calls.length + t.agents.sentinel.calls.length + t.agents.shikamaru.calls.length, 0);
    assert.match(t.messenger.sent[0]!.text, /🤖 \*Jarvis\*/);
    assert.match(t.messenger.sent[0]!.text, /AYUDA/);
});

// ---------------- L3: 429 ----------------

test('L3 429: Jarvis avisa claramente qué plan alcanzó el límite y audita error', async () => {
    const t = setup();
    t.agents.shikamaru.handle = async () => { throw new ProviderError('claude', '429', true, 'usage limit'); };
    const m = msg('@Shikamaru resumí el INDEX');
    const out = await t.jarvis.handle(m);
    assert.equal(out.status, 'error');
    const text = t.messenger.sent.at(-1)!.text;
    assert.match(text, /Claude Code/);
    assert.match(text, /límite/);
    assert.match(text, /429/);
    assert.equal((await t.store.getAudit(m.message_id))?.status, 'error');
});

test('error inesperado de un agente: respuesta controlada, no se propaga', async () => {
    const t = setup();
    t.agents.tank.handle = async () => { throw new Error('kaboom'); };
    const out = await t.jarvis.handle(msg('@Tank x'));
    assert.equal(out.status, 'error');
    assert.match(t.messenger.sent.at(-1)!.text, /⚠️/);
});

test('audit ok: registra agente, salida y duración', async () => {
    const t = setup();
    const m = msg('@Tank hola');
    await t.jarvis.handle(m);
    const row = await t.store.getAudit(m.message_id);
    assert.equal(row?.status, 'ok');
    assert.equal(row?.agent_name, 'tank');
    assert.match(row?.output_text ?? '', /respuesta de tank/);
});
