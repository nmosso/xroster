import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { ApprovalManager } from '../src/core/approvals';
import { ProviderRouter } from '../src/providers/providerRouter';
import { MAX_TOOL_OUTPUT_CHARS } from '../src/core/text';
import { SshTool, nodeTargets, buildRemoteCommand, SSH_TIMEOUT_MS_DEFAULT } from '../src/tools/ssh';
import { Tank, ALLOWED_RESTART_SERVICES, parseServiceUnits } from '../src/agents/tank';
import type { TenantRecord, TenantsLookup } from '../src/db/tenantsRepo';
import type { MonitoringSource } from '../src/tools/monitoringSource';
import { scriptedRunner, fakeAdapter, completion, fixedClock, type RunnerCall } from './helpers';

const T43: TenantRecord = { tenantid: 'server43', name: 'Frentones', position: '43', status: 'enabled', options: {} };
const T44: TenantRecord = { tenantid: 'server44', name: 'Frentones Norte', position: '44', status: 'enabled', options: {} };

function tenants(list: TenantRecord[] = [T43, T44]): TenantsLookup {
    return {
        async find(ref) {
            const r = ref.trim().toLowerCase();
            const exact = list.filter((t) => t.position === r || t.tenantid === r || t.tenantid === `server${r}`);
            return exact.length ? exact : list.filter((t) => (t.name ?? '').toLowerCase().includes(r));
        },
        async findByPosition(p) { return list.find((t) => t.position === p) ?? null; }
    };
}

const HEALTHY_OUT = [
    ' 12:00:00 up 10 days,  2:03,  0 users,  load average: 0.10, 0.20, 0.30',
    'Filesystem      Size  Used Avail Use% Mounted on',
    '/dev/sda1        50G   20G   30G  40% /',
    '               total        used        free      shared  buff/cache   available',
    'Mem:            7976        2000        3000         100        2976        5600',
    'active'
].join('\n');

function hostOf(call: RunnerCall): string {
    return call.args.find((a) => a.includes('@100.64.')) ?? '';
}
function portOf(call: RunnerCall): string {
    return call.args[call.args.indexOf('-p') + 1] ?? '';
}

function monitoring(nowSec: number): MonitoringSource {
    return {
        async listSnapshots() { return []; },
        async getSnapshot(pos) {
            return pos === '43'
                ? { position: '43', hash: { proxmox_ts: String(nowSec - 5), xmanager_ts: String(nowSec - 600), multicast_ts: String(nowSec - 5), streamer_ts: String(nowSec - 5) } }
                : null;
        }
    };
}

function setup(opts: { runner?: ReturnType<typeof scriptedRunner>; withLlm?: boolean; irdOk?: boolean } = {}) {
    const store = new MemoryRosterStore();
    const { clock, nowMs } = fixedClock();
    const runner = opts.runner ?? scriptedRunner(() => ({ code: 0, stdout: HEALTHY_OUT }));
    const ssh = new SshTool({ runner, user: 'root', keyPath: '/run/secrets/ssh_key' });
    const approvals = new ApprovalManager({ store, clock });
    const gemini = fakeAdapter('gemini', () => completion('Diagnóstico: xManager sin heartbeat; revisar VM .8'));
    const router = opts.withLlm ? new ProviderRouter({ store, adapters: { gemini }, clock }) : undefined;
    const fetchImpl = (async () => {
        if (opts.irdOk === false) throw new Error('ECONNREFUSED');
        return new Response('<html><body><b>Tuner 1</b> LOCK</body></html>', { status: 200 });
    }) as typeof fetch;
    const tank = new Tank({
        tenants: tenants(), monitoring: monitoring(Math.floor(nowMs() / 1000)), ssh, approvals, fetchImpl,
        ...(router ? { router } : {}), clock
    });
    return { store, runner, tank, approvals, gemini };
}

const req = (text: string) => ({ text, senderPhone: '5491122334455', messageId: `M-${text}` });

// ---------------- Herramienta SSH tipada ----------------

test('nodeTargets: los 4 nodos del tenant con IP/puerto canónicos', () => {
    assert.deepEqual(nodeTargets('43'), [
        { node: 'proxmox', host: '100.64.43.2', port: 22 },
        { node: 'xmanager', host: '100.64.43.8', port: 22 },
        { node: 'multicast', host: '100.64.43.2', port: 8522 },
        { node: 'streamer', host: '100.64.43.2', port: 8222 }
    ]);
    for (const bad of ['43; rm -rf /', '0', '255', 'abc', '']) assert.throws(() => nodeTargets(bad), `pos=${bad}`);
});

test('buildRemoteCommand: solo plantillas fijas; unidad inválida se rechaza', () => {
    assert.equal(buildRemoteCommand({ kind: 'health' }), 'uptime; df -h /; free -m');
    assert.equal(buildRemoteCommand({ kind: 'health', unit: 'xmanager' }), 'uptime; df -h /; free -m; systemctl is-active xmanager');
    assert.equal(buildRemoteCommand({ kind: 'service_status', unit: 'streamer' }), 'systemctl is-active streamer');
    assert.equal(buildRemoteCommand({ kind: 'service_restart', unit: 'streamer' }), 'systemctl restart streamer');
    assert.equal(buildRemoteCommand({ kind: 'service_restart', unit: 'streamer' }, 'ops'), 'sudo -n systemctl restart streamer');
    assert.throws(() => buildRemoteCommand({ kind: 'service_status', unit: 'x; rm -rf /' }));
});

test('SshTool: argv sin shell local, BatchMode, timeout 8 s por defecto', async () => {
    const runner = scriptedRunner(() => ({ code: 0, stdout: 'ok' }));
    const ssh = new SshTool({ runner, user: 'root', keyPath: '/k' });
    await ssh.exec({ node: 'streamer', host: '100.64.43.2', port: 8222 }, { kind: 'health' });
    const c = runner.calls[0]!;
    assert.equal(SSH_TIMEOUT_MS_DEFAULT, 8000);
    assert.equal(c.cmd, 'ssh');
    assert.equal(c.opts.timeoutMs, 8000);
    assert.ok(c.args.includes('BatchMode=yes'));
    assert.equal(portOf(c), '8222');
    assert.equal(hostOf(c), 'root@100.64.43.2');
    assert.equal(c.args.at(-1), 'uptime; df -h /; free -m');
});

test('L1 truncado SSH: salida de 50 KB queda en <= 4000 chars', async () => {
    const runner = scriptedRunner(() => ({ code: 0, stdout: 'A'.repeat(50 * 1024) }));
    const ssh = new SshTool({ runner, user: 'root', keyPath: '/k' });
    const r = await ssh.exec({ node: 'proxmox', host: '100.64.43.2', port: 22 }, { kind: 'health' });
    assert.ok(r.output.length <= MAX_TOOL_OUTPUT_CHARS, `len=${r.output.length}`);
});

// ---------------- L0: diagnóstico ----------------

test('diagnóstico L0: resuelve tenant por posición, Redis + SSH de los 4 nodos + IRD', async () => {
    const t = setup();
    const out = await t.tank.handle(req('revisá el server 43'));
    assert.match(out, /43 · Frentones/);
    assert.match(out, /xManager.*sin heartbeat/);
    assert.match(out, /load average: 0\.10/);
    assert.match(out, /IRD.*responde/);
    assert.equal(t.runner.calls.length, 4);
    const targets = t.runner.calls.map((c) => `${hostOf(c)}:${portOf(c)}`).sort();
    assert.deepEqual(targets, ['root@100.64.43.2:22', 'root@100.64.43.2:8222', 'root@100.64.43.2:8522', 'root@100.64.43.8:22']);
    assert.equal(t.store.ledger.length, 0, 'sin router configurado no consume LLM');
});

test('diagnóstico: resuelve tenant por nombre parcial y por tenantid', async () => {
    const t = setup();
    assert.match(await t.tank.handle(req('cómo está server44')), /44 · Frentones Norte/);
    const ambiguous = await t.tank.handle(req('cómo está Frentones'));
    assert.match(ambiguous, /varios tenants/i);
    assert.match(ambiguous, /43/);
    assert.match(ambiguous, /44/);
});

test('diagnóstico: tenant inexistente o sin referencia -> mensaje claro sin SSH', async () => {
    const t = setup();
    assert.match(await t.tank.handle(req('revisá el server 99')), /no encontré/i);
    assert.match(await t.tank.handle(req('hola')), /indicá el tenant/i);
    assert.equal(t.runner.calls.length, 0);
});

test('L3 cabecera sin red: timeout SSH en .8 -> estado parcial de Redis + aviso claro, sin colgar', async () => {
    const runner = scriptedRunner((c) => (hostOf(c).endsWith('100.64.43.8') ? { code: null, timedOut: true } : { code: 0, stdout: HEALTHY_OUT }));
    const t = setup({ runner, irdOk: false });
    const out = await t.tank.handle(req('@Tank revisá el server 43'));
    assert.match(out, /xManager.*timeout SSH \(8 s\)/);
    assert.match(out, /Proxmox.*load average/);
    assert.match(out, /Redis/);
    assert.match(out, /IRD.*no responde/);
});

test('síntesis IA: evidencia truncada a <= 4000 chars antes del LLM y registrada en ledger (diagnose)', async () => {
    const runner = scriptedRunner(() => ({ code: 0, stdout: 'Z'.repeat(50 * 1024) }));
    const t = setup({ runner, withLlm: true });
    const out = await t.tank.handle(req('revisá el 43'));
    assert.match(out, /Diagnóstico:/);
    assert.ok(t.gemini.seen[0]!.prompt.length <= MAX_TOOL_OUTPUT_CHARS, `prompt=${t.gemini.seen[0]!.prompt.length}`);
    assert.equal(t.store.ledger[0]!.agent_name, 'tank');
    assert.equal(t.store.ledger[0]!.task_type, 'diagnose');
});

test('síntesis IA con 429: Tank igual entrega el diagnóstico determinista con aviso', async () => {
    const t = setup({ withLlm: true });
    t.gemini.complete = async () => { throw Object.assign(new Error('quota'), { status: 429 }); };
    const out = await t.tank.handle(req('revisá el 43'));
    assert.match(out, /43 · Frentones/);
    assert.match(out, /Gemini.*límite.*429/);
});

// ---------------- L1: reinicios con whitelist ----------------

test('catálogo cerrado: ALLOWED_RESTART_SERVICES = xmanager | multicast | streamer', () => {
    assert.deepEqual([...ALLOWED_RESTART_SERVICES], ['xmanager', 'multicast', 'streamer']);
});

test('reinicio permitido: crea approval TK-XXX pendiente sin tocar SSH', async () => {
    const t = setup();
    const out = await t.tank.handle(req('reiniciá streamer del 43'));
    const code = /TK-\d{3}/.exec(out)?.[0];
    assert.ok(code, out);
    assert.match(out, /CONFIRMAR TK-\d{3}/);
    assert.match(out, /5 min/);
    assert.equal(t.runner.calls.length, 0);
    const a = await t.store.getApproval(code);
    assert.equal(a?.status, 'pending');
    assert.equal(a?.action_type, 'restart_service');
    assert.deepEqual(a?.payload, { service: 'streamer', position: '43', tenantid: 'server43', unit: 'streamer' });
});

test('L1 whitelist: servicio desconocido se rechaza ANTES de crear approval', async () => {
    const t = setup();
    const out = await t.tank.handle(req('reiniciá nginx del 43'));
    assert.match(out, /🚫/);
    assert.match(out, /xmanager, multicast, streamer/);
    assert.equal(await t.store.countApprovals('pending'), 0);
    assert.equal(t.runner.calls.length, 0);
});

test('L1 whitelist: shell arbitrario (rm -rf /, encadenados) se rechaza sin approval ni SSH', async () => {
    const t = setup();
    for (const text of ['ejecutá rm -rf / en el 43', 'reiniciá streamer del 43; rm -rf /', 'reiniciá streamer && reboot 43', 'corré `cat /etc/shadow` en 43', 'sudo systemctl stop xmanager 43']) {
        const out = await t.tank.handle(req(text));
        assert.match(out, /🚫/, text);
    }
    assert.equal(await t.store.countApprovals('pending'), 0);
    assert.equal(t.runner.calls.length, 0);
});

test('detector de shell no da falsos positivos en español (catálogo, su estado)', async () => {
    const t = setup();
    assert.doesNotMatch(await t.tank.handle(req('revisá su estado y el catálogo del 43')), /🚫/);
});

test('CONFIRMAR TK-XXX: reinicia vía SSH tipado en el nodo correcto y devuelve post-check', async () => {
    const runner = scriptedRunner((c) => ({ code: 0, stdout: c.args.at(-1)!.includes('is-active') ? 'active\n' : '' }));
    const t = setup({ runner });
    const out = await t.tank.handle(req('reiniciá multicast del 43'));
    const code = /TK-\d{3}/.exec(out)![0];
    const msg = await t.approvals.confirm(code);
    assert.match(msg, /✅/);
    assert.match(msg, /post-check: active/);
    assert.deepEqual(runner.calls.map((c) => [hostOf(c), portOf(c), c.args.at(-1)]), [
        ['root@100.64.43.2', '8522', 'systemctl restart multicast'],
        ['root@100.64.43.2', '8522', 'systemctl is-active multicast']
    ]);
});

test('defensa en profundidad: approval con payload adulterado no ejecuta nada', async () => {
    const t = setup();
    await t.store.createApproval({
        code: 'TK-123', agent_name: 'tank', action_type: 'restart_service', target_tenant: '43', summary_text: 'x',
        payload: { service: 'bash', position: '43', unit: 'bash' }, requested_at: new Date('2026-11-24T12:00:00Z'), expires_at: new Date('2026-11-24T12:05:00Z')
    });
    const msg = await t.approvals.confirm('TK-123');
    assert.match(msg, /❌/);
    assert.equal(t.runner.calls.length, 0);
});

test('reinicio fallido -> approval failed con detalle', async () => {
    const runner = scriptedRunner(() => ({ code: 5, stderr: 'Failed to restart streamer.service' }));
    const t = setup({ runner });
    const code = /TK-\d{3}/.exec(await t.tank.handle(req('reiniciá streamer del 43')))![0];
    const msg = await t.approvals.confirm(code);
    assert.match(msg, /❌/);
    assert.equal((await t.store.getApproval(code))?.status, 'failed');
});

test('parseServiceUnits: override opcional de unidades systemd validado', () => {
    assert.deepEqual(parseServiceUnits('streamer=xstreamer, multicast=mcast'), { xmanager: 'xmanager', multicast: 'mcast', streamer: 'xstreamer' });
    assert.throws(() => parseServiceUnits('nginx=nginx'));
    assert.throws(() => parseServiceUnits('streamer=a;b'));
    assert.deepEqual(parseServiceUnits(undefined), { xmanager: 'xmanager', multicast: 'multicast', streamer: 'streamer' });
});
