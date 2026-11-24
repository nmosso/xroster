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

test('.env.example documenta todas las variables de §5.3', () => {
    const example = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
    for (const k of [
        'PORT', 'XROSTER_WEBHOOK_SECRET', 'WHATSAPP_COMMAND_GROUP_ID', 'OWNER_WHATSAPP_PHONES', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY',
        'EVOLUTION_INSTANCE_NAME', 'PG_XROSTER_URL', 'PG_XSERVER_RO_URL', 'REDIS_URL', 'SSH_KEY_PATH', 'SSH_USER', 'SSH_TIMEOUT_MS',
        'XPLANNING_REPO_URL', 'XPLANNING_BRANCH', 'XPLANNING_GIT_TOKEN', 'XPLANNING_LOCAL_DIR', 'GEMINI_API_KEY', 'GEMINI_MODEL_FAST',
        'CLAUDE_PROVIDER', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'SENTINEL_POLL_MS', 'SENTINEL_ALERT_COOLDOWN_MS', 'SENTINEL_STORM_THRESHOLD'
    ]) {
        assert.match(example, new RegExp(`^${k}=`, 'm'), k);
    }
});
