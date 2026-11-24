import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRoosterStore } from '../src/db/memoryStore';
import { ApprovalManager } from '../src/core/approvals';
import { ProviderRouter } from '../src/providers/providerRouter';
import {
    PlanningRepo, PlanningUnavailableError, assertDraftBranch, assertSafePushArgs, slugify, DRAFTS_DIR, UNSYNCED_WARNING
} from '../src/tools/planningRepo';
import { Shikamaru } from '../src/agents/shikamaru';
import { scriptedRunner, fakeAdapter, completion, fixedClock, type RunnerCall } from './helpers';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), 'xplanning-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'Memory', 'xBackend', 'Tenants', 'server43'), { recursive: true });
    mkdirSync(join(dir, 'Cross_System', '01_Borradores'), { recursive: true });
    mkdirSync(join(dir, 'Cross_System', '02_Aprobados'), { recursive: true });
    writeFileSync(join(dir, 'Memory', 'INDEX.md'), '# Índice de Memoria\n- Heartbeat_And_Monitoring_Architecture');
    writeFileSync(join(dir, 'Memory', 'xBackend', 'Tenants', 'server43', 'MEMORY.md'), '# server43\nModulador Atomic, IRD 4 tuners');
    writeFileSync(join(dir, 'Cross_System', '01_Borradores', 'REQ-2026-013_AXELROD.md'), '# REQ-2026-013 Axelrod borrador');
    writeFileSync(join(dir, 'Cross_System', '02_Aprobados', 'REQ-2026-012_XROOSTER_FASE1.md'), '# REQ-2026-012\nFase 1 de xRooster: Jarvis, Sentinel, Tank, Shikamaru');
    return dir;
}

const gitArgs = (c: RunnerCall): string => c.args.join(' ');

function setup(opts: { failPull?: boolean; failPush?: boolean; token?: string; dir?: string } = {}) {
    const dir = opts.dir ?? fakeCheckout();
    const runner = scriptedRunner((c) => {
        const a = gitArgs(c);
        if (opts.failPull && a.includes('pull')) return { code: 1, stderr: 'fatal: unable to access github.com: Could not resolve host' };
        if (opts.failPush && a.includes(' push ')) return { code: 128, stderr: 'remote rejected' };
        if (a.includes('rev-parse')) return { code: 0, stdout: 'abc1234\n' };
        return { code: 0 };
    });
    const repo = new PlanningRepo({
        runner, localDir: dir, repoUrl: 'https://github.com/nmosso/xPlanning.git', branch: 'main', ...(opts.token ? { token: opts.token } : {})
    });
    const store = new MemoryRoosterStore();
    const { clock } = fixedClock();
    const approvals = new ApprovalManager({ store, clock });
    const claude = fakeAdapter('claude', (req) =>
        completion(req.system?.includes('BORRADOR')
            ? '# Mejora de Alertas Sentinel — Fase 2\n\n## 1. Resumen\nPropuesta.'
            : 'Según REQ-2026-012, la Fase 1 incluye Jarvis, Sentinel, Tank y Shikamaru.')
    );
    const router = new ProviderRouter({ store, adapters: { claude }, clock });
    const shika = new Shikamaru({ repo, router, approvals, clock });
    return { dir, runner, repo, store, approvals, claude, shika };
}

const req = (text: string) => ({ text, senderPhone: '5491122334455', messageId: `M-${text}` });

// ---------------- Guardas ----------------

test('slugify: minúsculas, sin acentos ni símbolos, máx 50', () => {
    assert.equal(slugify('Mejora de Alertas Sentinel — Fase 2!'), 'mejora-de-alertas-sentinel-fase-2');
    assert.equal(slugify('Ñandú   Configuración'), 'nandu-configuracion');
    assert.ok(slugify('x'.repeat(200)).length <= 50);
    assert.equal(slugify('!!!'), 'borrador');
});

test('assertDraftBranch: solo draft/shikamaru-<slug>; main y variantes se bloquean', () => {
    assert.doesNotThrow(() => assertDraftBranch('draft/shikamaru-mejora-alertas'));
    for (const b of ['main', 'master', 'draft/shikamaru-', 'draft/shikamaru-../main', 'feature/x', 'draft/shikamaru-a:main', 'refs/heads/main']) {
        assert.throws(() => assertDraftBranch(b), `branch=${b}`);
    }
});

test('assertSafePushArgs: bloquea push a main, force, mirror, delete', () => {
    assert.doesNotThrow(() => assertSafePushArgs(['push', 'origin', 'refs/heads/draft/shikamaru-x:refs/heads/draft/shikamaru-x']));
    for (const args of [
        ['push', 'origin', 'main'], ['push', 'origin', 'HEAD:main'], ['push', 'origin', 'refs/heads/draft/shikamaru-x:refs/heads/main'],
        ['push', '--force', 'origin', 'refs/heads/draft/shikamaru-x:refs/heads/draft/shikamaru-x'], ['push', '-f', 'origin', 'x'],
        ['push', '--mirror', 'origin'], ['push', '--delete', 'origin', 'draft/shikamaru-x'], ['push', '--all', 'origin']
    ]) {
        assert.throws(() => assertSafePushArgs(args), args.join(' '));
    }
});

// ---------------- Sync L0 ----------------

test('sync: checkout main + git pull --ff-only origin main', async () => {
    const t = setup();
    const r = await t.repo.sync();
    assert.equal(r.synced, true);
    const calls = t.runner.calls.map(gitArgs);
    assert.ok(calls.some((a) => a.endsWith('checkout main')));
    assert.ok(calls.some((a) => a.endsWith('pull --ff-only origin main')));
    assert.ok(t.runner.calls.every((c) => c.cmd === 'git'));
});

test('L3 git sin conexión: pull falla -> usa copia local con advertencia', async () => {
    const t = setup({ failPull: true });
    const r = await t.repo.sync();
    assert.equal(r.synced, false);
    assert.equal(r.warning, UNSYNCED_WARNING);
    assert.equal(UNSYNCED_WARNING, '⚠️ copia local sin sincronizar');
});

test('sync sin copia local: clona; si el clone falla -> PlanningUnavailableError', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'xplanning-empty-'));
    dirs.push(empty);
    const target = join(empty, 'repo');
    const ok = setup({ dir: target });
    assert.equal((await ok.repo.sync()).synced, true);
    assert.match(gitArgs(ok.runner.calls[0]!), /^clone --branch main --single-branch https:\/\/github\.com\/nmosso\/xPlanning\.git /);

    const failing = new PlanningRepo({
        runner: scriptedRunner(() => ({ code: 128, stderr: 'network' })), localDir: join(empty, 'nada'), repoUrl: 'https://github.com/nmosso/xPlanning.git'
    });
    await assert.rejects(failing.sync(), PlanningUnavailableError);
});

test('token opcional: auth por variables de entorno, nunca en argv', async () => {
    const t = setup({ token: 'ghp_SECRET' });
    await t.repo.sync();
    const c = t.runner.calls[0]!;
    assert.ok(!c.args.join(' ').includes('ghp_SECRET'));
    assert.equal(c.opts.env?.['GIT_CONFIG_KEY_0'], 'http.extraHeader');
    assert.match(c.opts.env?.['GIT_CONFIG_VALUE_0'] ?? '', /^Authorization: Basic /);
    assert.equal(c.opts.env?.['GIT_TERMINAL_PROMPT'], '0');
});

test('readText: bloquea path traversal fuera del repo', async () => {
    const t = setup();
    assert.match((await t.repo.readText('Memory/INDEX.md')) ?? '', /Índice/);
    assert.equal(await t.repo.readText('../../etc/passwd'), null);
    assert.equal(await t.repo.readText('Memory/NO_EXISTE.md'), null);
});

// ---------------- Agente L0 ----------------

test('consulta L0: lee INDEX, MEMORY del tenant, borradores y aprobados, y responde con Claude (ledger planning)', async () => {
    const t = setup();
    const out = await t.shika.handle(req('qué sabemos del server 43 y del REQ-2026-012'));
    assert.match(out, /REQ-2026-012/);
    const prompt = t.claude.seen[0]!.prompt;
    assert.match(prompt, /Índice de Memoria/);
    assert.match(prompt, /Modulador Atomic/);
    assert.match(prompt, /REQ-2026-013_AXELROD\.md/);
    assert.match(prompt, /Fase 1 de xRooster/);
    assert.equal(t.store.ledger[0]!.provider, 'claude');
    assert.equal(t.store.ledger[0]!.agent_name, 'shikamaru');
    assert.equal(t.store.ledger[0]!.task_type, 'planning');
    assert.doesNotMatch(out, /copia local sin sincronizar/);
});

test('L3 consulta con git caído: responde con copia local y advertencia', async () => {
    const t = setup({ failPull: true });
    const out = await t.shika.handle(req('resumí el INDEX'));
    assert.match(out, /⚠️ copia local sin sincronizar/);
    assert.match(out, /Fase 1/);
});

// ---------------- Agente L1: borradores ----------------

test('pedido de borrador: genera contenido y crea approval SH-XXX sin commit ni push', async () => {
    const t = setup();
    const out = await t.shika.handle(req('creá un borrador para mejorar las alertas de Sentinel'));
    const code = /SH-\d{3}/.exec(out)?.[0];
    assert.ok(code, out);
    assert.match(out, /draft\/shikamaru-mejora-de-alertas-sentinel-fase-2/);
    assert.match(out, /CONFIRMAR SH-\d{3}/);
    const calls = t.runner.calls.map(gitArgs);
    assert.ok(!calls.some((a) => / (commit|push) /.test(` ${a} `)));
    const a = await t.store.getApproval(code);
    assert.equal(a?.action_type, 'git_push_draft');
    assert.equal(a?.payload['branch'], 'draft/shikamaru-mejora-de-alertas-sentinel-fase-2');
});

test('CONFIRMAR SH-XXX: rama draft, archivo en 01_Borradores, commit y push de la rama (nunca main)', async () => {
    const t = setup();
    const code = /SH-\d{3}/.exec(await t.shika.handle(req('generá un borrador para mejorar las alertas')))![0];
    const before = t.runner.calls.length;
    const msg = await t.approvals.confirm(code);
    assert.match(msg, /✅/);
    assert.match(msg, /draft\/shikamaru-mejora-de-alertas-sentinel-fase-2/);

    const calls = t.runner.calls.slice(before).map(gitArgs);
    const branch = 'draft/shikamaru-mejora-de-alertas-sentinel-fase-2';
    assert.ok(calls.some((a) => a.endsWith(`checkout -B ${branch}`)), calls.join('\n'));
    assert.ok(calls.some((a) => / add /.test(` ${a} `)));
    assert.ok(calls.some((a) => / commit /.test(` ${a} `)));
    const push = calls.find((a) => / push /.test(` ${a} `))!;
    assert.match(push, new RegExp(`push origin refs/heads/${branch}:refs/heads/${branch}$`));
    assert.ok(!calls.some((a) => /push.*\bmain\b/.test(a)), 'nunca push a main');
    assert.ok(calls.at(-1)!.endsWith('checkout main'), 'vuelve a main al terminar');

    const fileName = String((await t.store.getApproval(code))!.payload['fileName']);
    const written = readFileSync(join(t.dir, DRAFTS_DIR, fileName), 'utf8');
    assert.match(written, /Mejora de Alertas Sentinel/);
});

test('payload adulterado con rama main: se bloquea en código y no hay push', async () => {
    const t = setup();
    await t.store.createApproval({
        code: 'SH-666', agent_name: 'shikamaru', action_type: 'git_push_draft', target_tenant: null, summary_text: 'x',
        payload: { branch: 'main', fileName: 'x.md', content: '# x' }, requested_at: new Date('2026-11-24T12:00:00Z'), expires_at: new Date('2026-11-24T12:05:00Z')
    });
    const msg = await t.approvals.confirm('SH-666');
    assert.match(msg, /❌/);
    assert.ok(!t.runner.calls.some((c) => c.args.includes('push')));
    assert.ok(!existsSync(join(t.dir, DRAFTS_DIR, 'x.md')));
});

test('push rechazado: approval failed y el repo vuelve a main', async () => {
    const t = setup({ failPush: true });
    const code = /SH-\d{3}/.exec(await t.shika.handle(req('armá un borrador de prueba')))![0];
    const msg = await t.approvals.confirm(code);
    assert.match(msg, /❌/);
    assert.equal((await t.store.getApproval(code))?.status, 'failed');
    assert.ok(gitArgs(t.runner.calls.at(-1)!).endsWith('checkout main'));
});
