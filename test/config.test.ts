import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config';
import { VALID_ENV } from './helpers';

test('loadConfig: env mínimo válido -> defaults de §5.3', () => {
    const c = loadConfig(VALID_ENV);
    assert.equal(c.port, 3900);
    assert.deepEqual([...c.ownerPhones].sort(), ['14155550100', '5491122334455']);
    assert.equal(c.sshTimeoutMs, 8000);
    assert.equal(c.sshUser, 'root');
    assert.equal(c.xplanningRepoUrl, 'https://github.com/nmosso/xPlanning.git');
    assert.equal(c.xplanningBranch, 'main');
    assert.equal(c.xplanningLocalDir, '/data/xPlanning');
    assert.equal(c.geminiModelFast, 'gemini-2.5-flash');
    assert.equal(c.claudeProvider, 'cli');
    assert.equal(c.claudeModel, 'claude-sonnet-4-5');
    assert.equal(c.sentinelPollMs, 60_000);
    assert.equal(c.sentinelAlertCooldownMs, 1_800_000);
    assert.equal(c.sentinelStormThreshold, 3);
    assert.equal(c.geminiApiKey, null);
});

test('loadConfig Sentinel push WhatsApp: defaults (solo proxmox, sin reminders, gracia 2 min VM / 10 min IRD)', () => {
    const c = loadConfig(VALID_ENV);
    assert.deepEqual(c.sentinelNotifyComponents, ['proxmox']);
    assert.equal(c.sentinelNotifyReminders, false);
    assert.equal(c.sentinelVmGraceMs, 120_000);
    assert.equal(c.sentinelIrdGraceMs, 600_000);
});

test('loadConfig Sentinel push WhatsApp: overrides explícitos', () => {
    const c = loadConfig({
        ...VALID_ENV,
        SENTINEL_NOTIFY_COMPONENTS: ' Proxmox, ird ,proxmox ',
        SENTINEL_NOTIFY_REMINDERS: 'true',
        SENTINEL_VM_GRACE_MS: '0',
        SENTINEL_IRD_GRACE_MS: '300000'
    });
    assert.deepEqual(c.sentinelNotifyComponents, ['proxmox', 'ird']);
    assert.equal(c.sentinelNotifyReminders, true);
    assert.equal(c.sentinelVmGraceMs, 0);
    assert.equal(c.sentinelIrdGraceMs, 300_000);
    assert.equal(loadConfig({ ...VALID_ENV, SENTINEL_NOTIFY_REMINDERS: 'false' }).sentinelNotifyReminders, false);
});

test('loadConfig Sentinel push WhatsApp: valores inválidos se reportan', () => {
    const bad = (over: Record<string, string>) => () => loadConfig({ ...VALID_ENV, ...over });
    assert.throws(bad({ SENTINEL_NOTIFY_COMPONENTS: 'proxmox,router' }), /SENTINEL_NOTIFY_COMPONENTS/);
    assert.throws(bad({ SENTINEL_NOTIFY_REMINDERS: 'si' }), /SENTINEL_NOTIFY_REMINDERS/);
    assert.throws(bad({ SENTINEL_VM_GRACE_MS: '-1' }), /SENTINEL_VM_GRACE_MS/);
    assert.throws(bad({ SENTINEL_IRD_GRACE_MS: 'diez' }), /SENTINEL_IRD_GRACE_MS/);
});

test('loadConfig: reporta TODAS las variables obligatorias faltantes', () => {
    assert.throws(() => loadConfig({}), (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        for (const k of ['XROSTER_WEBHOOK_SECRET', 'WHATSAPP_COMMAND_GROUP_ID', 'OWNER_WHATSAPP_PHONES', 'EVOLUTION_API_URL', 'PG_XROSTER_URL', 'PG_XSERVER_RO_URL', 'REDIS_URL']) {
            assert.match(e.message, new RegExp(k));
        }
        return true;
    });
});

test('loadConfig: validaciones de formato', () => {
    const bad = (over: Record<string, string>) => () => loadConfig({ ...VALID_ENV, ...over });
    assert.throws(bad({ WHATSAPP_COMMAND_GROUP_ID: '5491100000000@s.whatsapp.net' }), /WHATSAPP_COMMAND_GROUP_ID/);
    assert.throws(bad({ XROSTER_WEBHOOK_SECRET: 'corto' }), /XROSTER_WEBHOOK_SECRET/);
    assert.throws(bad({ CLAUDE_PROVIDER: 'otro' }), /CLAUDE_PROVIDER/);
    assert.throws(bad({ CLAUDE_PROVIDER: 'api' }), /ANTHROPIC_API_KEY/);
    assert.throws(bad({ SENTINEL_POLL_MS: 'abc' }), /SENTINEL_POLL_MS/);
    assert.throws(bad({ XPLANNING_BRANCH: 'develop' }), /XPLANNING_BRANCH/);
    assert.throws(bad({ OWNER_WHATSAPP_PHONES: ' , ' }), /OWNER_WHATSAPP_PHONES/);
});

test('loadConfig web (REQ-2026-013): opcional, defaults y ROSTER_COOKIE_SECURE', () => {
    const c = loadConfig(VALID_ENV);
    assert.deepEqual(c.web, { user: 'admin', password: null, sessionSecret: null, cookieSecure: false });

    const full = loadConfig({ ...VALID_ENV, ROSTER_WEB_USER: ' ops ', ROSTER_WEB_PASSWORD: 'pw', ROSTER_SESSION_SECRET: 's'.repeat(64) });
    assert.deepEqual(full.web, { user: 'ops', password: 'pw', sessionSecret: 's'.repeat(64), cookieSecure: false });

    assert.equal(loadConfig({ ...VALID_ENV, NODE_ENV: 'production' }).web.cookieSecure, true);
    assert.equal(loadConfig({ ...VALID_ENV, NODE_ENV: 'production', ROSTER_COOKIE_SECURE: 'false' }).web.cookieSecure, false);
    assert.equal(loadConfig({ ...VALID_ENV, ROSTER_COOKIE_SECURE: 'true' }).web.cookieSecure, true);
    assert.equal(loadConfig({ ...VALID_ENV, ROSTER_COOKIE_SECURE: 'false' }).web.cookieSecure, false);
});

test('.env.example documenta las variables de cpanel-roster (REQ-2026-013 §5.1)', () => {
    const example = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
    for (const k of ['ROSTER_WEB_USER', 'ROSTER_WEB_PASSWORD', 'ROSTER_SESSION_SECRET', 'ROSTER_COOKIE_SECURE']) {
        assert.match(example, new RegExp(`^${k}=`, 'm'), k);
    }
});

test('.env.example documenta todas las variables de §5.3', () => {
    const example = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
    for (const k of [
        'PORT', 'XROSTER_WEBHOOK_SECRET', 'WHATSAPP_COMMAND_GROUP_ID', 'OWNER_WHATSAPP_PHONES', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY',
        'EVOLUTION_INSTANCE_NAME', 'PG_XROSTER_URL', 'PG_XSERVER_RO_URL', 'REDIS_URL', 'SSH_KEY_PATH', 'SSH_USER', 'SSH_TIMEOUT_MS',
        'XPLANNING_REPO_URL', 'XPLANNING_BRANCH', 'XPLANNING_GIT_TOKEN', 'XPLANNING_LOCAL_DIR', 'GEMINI_API_KEY', 'GEMINI_MODEL_FAST',
        'CLAUDE_PROVIDER', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'SENTINEL_POLL_MS', 'SENTINEL_ALERT_COOLDOWN_MS', 'SENTINEL_STORM_THRESHOLD',
        'SENTINEL_NOTIFY_COMPONENTS', 'SENTINEL_NOTIFY_REMINDERS', 'SENTINEL_VM_GRACE_MS', 'SENTINEL_IRD_GRACE_MS'
    ]) {
        assert.match(example, new RegExp(`^${k}=`, 'm'), k);
    }
});
