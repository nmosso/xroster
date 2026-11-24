import { parseOwnerPhones } from './core/phone';

export type ClaudeProviderMode = 'cli' | 'api';

/** Configuración tipada de xRooster (REQ-2026-012 §5.3). 100% desde .env → portable a VM dedicada. */
export interface AppConfig {
    port: number;
    webhookSecret: string;
    commandGroupId: string;
    ownerPhones: Set<string>;
    evolutionApiUrl: string;
    evolutionApiKey: string;
    evolutionInstance: string;
    pgXroosterUrl: string;
    pgXserverRoUrl: string;
    redisUrl: string;
    sshKeyPath: string;
    sshUser: string;
    sshTimeoutMs: number;
    xplanningRepoUrl: string;
    xplanningBranch: 'main';
    xplanningGitToken: string | null;
    xplanningLocalDir: string;
    geminiApiKey: string | null;
    geminiModelFast: string;
    claudeProvider: ClaudeProviderMode;
    anthropicApiKey: string | null;
    claudeModel: string;
    sentinelPollMs: number;
    sentinelAlertCooldownMs: number;
    sentinelStormThreshold: number;
    tankServiceUnits: string | null;
}

export class ConfigError extends Error {
    constructor(readonly problems: string[]) {
        super(`Configuración inválida:\n- ${problems.join('\n- ')}`);
        this.name = 'ConfigError';
    }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AppConfig {
    const problems: string[] = [];
    const str = (k: string): string => (env[k] ?? '').trim();
    const opt = (k: string): string | null => str(k) || null;
    const req = (k: string): string => {
        const v = str(k);
        if (!v) problems.push(`${k} es obligatoria`);
        return v;
    };
    const int = (k: string, def: number, min: number): number => {
        const raw = str(k);
        if (!raw) return def;
        if (!/^\d+$/.test(raw) || Number(raw) < min) {
            problems.push(`${k} debe ser un entero >= ${min} (valor: "${raw}")`);
            return def;
        }
        return Number(raw);
    };

    const webhookSecret = req('XROOSTER_WEBHOOK_SECRET');
    if (webhookSecret && webhookSecret.length < 16) problems.push('XROOSTER_WEBHOOK_SECRET debe tener al menos 16 caracteres');

    const commandGroupId = req('WHATSAPP_COMMAND_GROUP_ID');
    if (commandGroupId && !/^[0-9]+(-[0-9]+)?@g\.us$/.test(commandGroupId)) problems.push('WHATSAPP_COMMAND_GROUP_ID debe ser un JID de grupo (…@g.us)');

    const ownersRaw = req('OWNER_WHATSAPP_PHONES');
    const ownerPhones = parseOwnerPhones(ownersRaw);
    if (ownersRaw && ownerPhones.size === 0) problems.push('OWNER_WHATSAPP_PHONES no contiene teléfonos E.164 válidos');

    const claudeRaw = str('CLAUDE_PROVIDER') || 'cli';
    if (claudeRaw !== 'cli' && claudeRaw !== 'api') problems.push(`CLAUDE_PROVIDER debe ser "cli" o "api" (valor: "${claudeRaw}")`);
    const claudeProvider: ClaudeProviderMode = claudeRaw === 'api' ? 'api' : 'cli';
    const anthropicApiKey = opt('ANTHROPIC_API_KEY');
    if (claudeProvider === 'api' && !anthropicApiKey) problems.push('ANTHROPIC_API_KEY es obligatoria con CLAUDE_PROVIDER=api');

    const branch = str('XPLANNING_BRANCH') || 'main';
    if (branch !== 'main') problems.push('XPLANNING_BRANCH debe ser "main" (Shikamaru solo sincroniza main)');

    const cfg: AppConfig = {
        port: int('PORT', 3900, 0),
        webhookSecret,
        commandGroupId,
        ownerPhones,
        evolutionApiUrl: req('EVOLUTION_API_URL'),
        evolutionApiKey: req('EVOLUTION_API_KEY'),
        evolutionInstance: req('EVOLUTION_INSTANCE_NAME'),
        pgXroosterUrl: req('PG_XROOSTER_URL'),
        pgXserverRoUrl: req('PG_XSERVER_RO_URL'),
        redisUrl: req('REDIS_URL'),
        sshKeyPath: str('SSH_KEY_PATH') || '/run/secrets/ssh_key',
        sshUser: str('SSH_USER') || 'root',
        sshTimeoutMs: int('SSH_TIMEOUT_MS', 8000, 1000),
        xplanningRepoUrl: str('XPLANNING_REPO_URL') || 'https://github.com/nmosso/xPlanning.git',
        xplanningBranch: 'main',
        xplanningGitToken: opt('XPLANNING_GIT_TOKEN'),
        xplanningLocalDir: str('XPLANNING_LOCAL_DIR') || '/data/xPlanning',
        geminiApiKey: opt('GEMINI_API_KEY'),
        geminiModelFast: str('GEMINI_MODEL_FAST') || 'gemini-2.5-flash',
        claudeProvider,
        anthropicApiKey,
        claudeModel: str('CLAUDE_MODEL') || 'claude-sonnet-4-5',
        sentinelPollMs: int('SENTINEL_POLL_MS', 60_000, 1000),
        sentinelAlertCooldownMs: int('SENTINEL_ALERT_COOLDOWN_MS', 1_800_000, 0),
        sentinelStormThreshold: int('SENTINEL_STORM_THRESHOLD', 3, 1),
        tankServiceUnits: opt('TANK_SERVICE_UNITS')
    };
    if (problems.length > 0) throw new ConfigError(problems);
    return cfg;
}
