import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import type { AppConfig } from './config';
import type { RoosterStore } from './db/store';
import { PgRoosterStore } from './db/pgStore';
import { TenantsRepo, createReadOnlyPool, type Queryable } from './db/tenantsRepo';
import { ApprovalManager } from './core/approvals';
import { EvolutionClient } from './core/evolutionClient';
import { Jarvis } from './core/jarvis';
import { errorMessage, silentLogger, type Logger } from './core/logger';
import { ProviderRouter, type ProviderAdapter } from './providers/providerRouter';
import { GeminiAdapter, type GeminiClientLike } from './providers/geminiAdapter';
import { ClaudeApiAdapter, ClaudeCliAdapter } from './providers/claudeAdapter';
import { spawnRunner, type CommandRunner } from './tools/commandRunner';
import { RedisMonitoringSource, type RedisLike } from './tools/monitoringSource';
import { SshTool } from './tools/ssh';
import { PlanningRepo } from './tools/planningRepo';
import { Sentinel } from './agents/sentinel';
import { Tank, parseServiceUnits } from './agents/tank';
import { Shikamaru } from './agents/shikamaru';
import { createServer } from './server';

/** Dependencias externas inyectables (tests L2); por defecto se crean desde la configuración. */
export interface AppDeps {
    store?: RoosterStore;
    redis?: RedisLike & { quit(): Promise<unknown> };
    tenantsDb?: Queryable & { end(): Promise<void> };
    runner?: CommandRunner;
    fetchImpl?: typeof fetch;
    geminiClient?: GeminiClientLike;
    logger?: Logger;
}

export interface App {
    readonly jarvis: Jarvis;
    readonly sentinel: Sentinel;
    readonly server: Server;
    /** initSchema + HTTP + polling de Sentinel. Devuelve el puerto efectivo. */
    start(): Promise<number>;
    /** Graceful shutdown idempotente. */
    stop(): Promise<void>;
}

const NAME_CACHE_TTL_MS = 10 * 60_000;

export function createApp(cfg: AppConfig, deps: AppDeps = {}): App {
    const logger = deps.logger ?? silentLogger;
    const runner = deps.runner ?? spawnRunner;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const store = deps.store ?? new PgRoosterStore(cfg.pgXroosterUrl);
    const redis = deps.redis ?? toRedisLike(new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false }), logger);
    const tenantsDb = deps.tenantsDb ?? createReadOnlyPool(cfg.pgXserverRoUrl);
    const tenants = new TenantsRepo(tenantsDb);

    const adapters: Partial<Record<'gemini' | 'claude', ProviderAdapter>> = {};
    if (cfg.geminiApiKey || deps.geminiClient) {
        adapters.gemini = new GeminiAdapter({
            model: cfg.geminiModelFast,
            ...(cfg.geminiApiKey ? { apiKey: cfg.geminiApiKey } : {}),
            ...(deps.geminiClient ? { client: deps.geminiClient } : {})
        });
    }
    adapters.claude = cfg.claudeProvider === 'api'
        ? new ClaudeApiAdapter({ apiKey: cfg.anthropicApiKey ?? '', model: cfg.claudeModel, fetchImpl })
        : new ClaudeCliAdapter({ runner, model: cfg.claudeModel });
    const router = new ProviderRouter({ store, adapters, logger });

    const messenger = new EvolutionClient({
        baseUrl: cfg.evolutionApiUrl, apiKey: cfg.evolutionApiKey, instance: cfg.evolutionInstance, commandGroupId: cfg.commandGroupId, fetchImpl
    });
    const approvals = new ApprovalManager({ store });
    const monitoring = new RedisMonitoringSource(redis);

    const names = new Map<string, { name: string | null; at: number }>();
    const resolveName = async (position: string): Promise<string | null> => {
        const hit = names.get(position);
        if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.name;
        const t = await tenants.findByPosition(position);
        names.set(position, { name: t?.name ?? null, at: Date.now() });
        return t?.name ?? null;
    };

    const sentinel = new Sentinel({
        store, source: monitoring, logger, resolveName,
        notify: (text) => messenger.sendText(cfg.commandGroupId, text),
        pollMs: cfg.sentinelPollMs, cooldownMs: cfg.sentinelAlertCooldownMs, stormThreshold: cfg.sentinelStormThreshold
    });
    const tank = new Tank({
        tenants, monitoring, approvals, router, fetchImpl, logger,
        ssh: new SshTool({ runner, user: cfg.sshUser, keyPath: cfg.sshKeyPath, timeoutMs: cfg.sshTimeoutMs }),
        serviceUnits: parseServiceUnits(cfg.tankServiceUnits ?? undefined)
    });
    const shikamaru = new Shikamaru({
        router, approvals, logger,
        repo: new PlanningRepo({
            runner, localDir: cfg.xplanningLocalDir, repoUrl: cfg.xplanningRepoUrl, branch: cfg.xplanningBranch,
            ...(cfg.xplanningGitToken ? { token: cfg.xplanningGitToken } : {})
        })
    });
    const jarvis = new Jarvis({
        commandGroupId: cfg.commandGroupId, ownerPhones: cfg.ownerPhones, store, messenger, approvals, router,
        agents: { sentinel, tank, shikamaru }, sentinelControl: sentinel, logger
    });
    const server = createServer({ secret: cfg.webhookSecret, onMessage: (p) => jarvis.handle(p), logger });

    let stopping: Promise<void> | null = null;

    return {
        jarvis, sentinel, server,
        async start() {
            await store.initSchema();
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(cfg.port, () => { server.off('error', reject); resolve(); });
            });
            sentinel.start();
            const port = (server.address() as AddressInfo).port;
            logger.info('xRooster iniciado', { port, sentinel_poll_ms: cfg.sentinelPollMs, claude_provider: cfg.claudeProvider, gemini: Boolean(adapters.gemini) });
            return port;
        },
        stop() {
            stopping ??= (async () => {
                await sentinel.stop();
                if (server.listening) await new Promise<void>((r) => server.close(() => r()));
                const close = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
                    try { await fn(); } catch (err) { logger.warn(`shutdown: ${label}`, { error: errorMessage(err) }); }
                };
                await close('store', () => store.close());
                await close('redis', () => redis.quit());
                await close('tenantsDb', () => tenantsDb.end());
                logger.info('xRooster detenido');
            })();
            return stopping;
        }
    };
}

function toRedisLike(r: Redis, logger: Logger): RedisLike & { quit(): Promise<unknown> } {
    r.on('error', (err: Error) => logger.warn('redis', { error: err.message }));
    return {
        scan: (cursor, match, pattern, count, n) => r.scan(cursor, match, pattern, count, n),
        hgetall: (key) => r.hgetall(key),
        quit: () => r.quit()
    };
}
