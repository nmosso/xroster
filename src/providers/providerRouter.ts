import type { AgentName, JsonObject, ProviderName, ProviderUsage, QuotaUsageEntry, RosterStore, TaskType } from '../db/store';
import { neutralize } from '../core/text';
import { errorMessage, silentLogger, type Logger } from '../core/logger';

export interface LlmRequest {
    agent: AgentName;
    taskType: TaskType;
    prompt: string;
    system?: string;
    maxOutputTokens?: number;
    metadata?: JsonObject;
}

export interface LlmCompletion {
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
}

/** Adaptador desacoplado e inyectable de un proveedor IA. Lanza errores crudos; el router los clasifica. */
export interface ProviderAdapter {
    readonly provider: ProviderName;
    readonly model: string;
    complete(req: LlmRequest): Promise<LlmCompletion>;
}

export class ProviderError extends Error {
    constructor(
        readonly provider: ProviderName,
        readonly code: string,
        readonly rateLimited: boolean,
        message: string
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}

const RATE_LIMIT_TEXT = /\b429\b|rate[ _-]?limit|resource[ _-]?exhausted|quota|usage limit|too many requests/i;

export function classifyProviderError(err: unknown): { code: string; rateLimited: boolean; message: string } {
    const message = errorMessage(err);
    const anyErr = (typeof err === 'object' && err !== null ? err : {}) as { status?: unknown; code?: unknown };
    const status = anyErr.status ?? anyErr.code;
    if (status === 429 || status === '429' || RATE_LIMIT_TEXT.test(message)) {
        return { code: '429', rateLimited: true, message };
    }
    return { code: status !== undefined && status !== null ? String(status) : 'error', rateLimited: false, message };
}

export interface QuotaSummary {
    generated_at: Date;
    last5h: ProviderUsage[];
    last24h: ProviderUsage[];
}

const HOUR_MS = 3600_000;

export interface ProviderRouterOptions {
    store: RosterStore;
    adapters: Partial<Record<ProviderName, ProviderAdapter>>;
    clock?: () => Date;
    logger?: Logger;
}

/** Punto único de invocación IA: neutraliza terminología, mide latencia y registra SIEMPRE en quota_usage_ledger. */
export class ProviderRouter {
    private readonly clock: () => Date;
    private readonly logger: Logger;

    constructor(private readonly opts: ProviderRouterOptions) {
        this.clock = opts.clock ?? (() => new Date());
        this.logger = opts.logger ?? silentLogger;
    }

    has(provider: ProviderName): boolean {
        return Boolean(this.opts.adapters[provider]);
    }

    async complete(provider: ProviderName, req: LlmRequest): Promise<LlmCompletion> {
        const adapter = this.opts.adapters[provider];
        if (!adapter) throw new ProviderError(provider, 'not_configured', false, `Proveedor ${provider} no configurado`);

        const safeReq: LlmRequest = {
            ...req,
            prompt: neutralize(req.prompt),
            ...(req.system !== undefined ? { system: neutralize(req.system) } : {})
        };
        const started = this.clock().getTime();
        try {
            const res = await adapter.complete(safeReq);
            await this.record(adapter, req, started, {
                status: 'ok', rate_limited: false, error_code: null,
                input_tokens: res.inputTokens, output_tokens: res.outputTokens, cached_tokens: res.cachedTokens
            });
            return { ...res, text: neutralize(res.text) };
        } catch (err) {
            const c = classifyProviderError(err);
            await this.record(adapter, req, started, {
                status: c.rateLimited ? 'rate_limited' : 'error', rate_limited: c.rateLimited, error_code: c.code,
                input_tokens: 0, output_tokens: 0, cached_tokens: 0
            });
            throw new ProviderError(provider, c.code, c.rateLimited, c.message);
        }
    }

    async getQuotaSummary(): Promise<QuotaSummary> {
        const now = this.clock();
        const [last5h, last24h] = await Promise.all([
            this.opts.store.aggregateQuota(new Date(now.getTime() - 5 * HOUR_MS)),
            this.opts.store.aggregateQuota(new Date(now.getTime() - 24 * HOUR_MS))
        ]);
        return { generated_at: now, last5h, last24h };
    }

    private async record(
        adapter: ProviderAdapter,
        req: LlmRequest,
        startedMs: number,
        r: Pick<QuotaUsageEntry,'status' | 'rate_limited' | 'error_code' | 'input_tokens' | 'output_tokens' | 'cached_tokens'>
    ): Promise<void> {
        const latency = Math.max(0, this.clock().getTime() - startedMs);
        try {
            await this.opts.store.insertQuotaUsage({
                agent_name: req.agent, provider: adapter.provider, model: adapter.model, task_type: req.taskType,
                latency_ms: latency, metadata: req.metadata ?? {}, ...r
            });
        } catch (err) {
            this.logger.error('quota_usage_ledger: no se pudo registrar la invocación', { error: errorMessage(err), provider: adapter.provider });
        }
    }
}

function fmtWindow(label: string, rows: ProviderUsage[]): string {
    if (rows.length === 0) return `• ${label}: sin uso`;
    return rows
        .map((u) => `• ${label} ${u.provider}: ${u.requests} req · ${u.input_tokens}→${u.output_tokens} tok · 429: ${u.rate_limited}`)
        .join('\n');
}

export function formatQuotaSummary(s: QuotaSummary): string {
    return [`📊 Cuotas IA`, fmtWindow('5h', s.last5h), fmtWindow('24h', s.last24h)].join('\n');
}
