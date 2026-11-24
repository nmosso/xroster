import type { LlmCompletion, LlmRequest, ProviderAdapter } from './providerRouter';
import type { CommandRunner } from '../tools/commandRunner';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

class ClaudeCallError extends Error {
    constructor(message: string, readonly status: number | string) {
        super(message);
        this.name = 'ClaudeCallError';
    }
}

interface ClaudeUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
}

function mapUsage(u: ClaudeUsage | undefined): Omit<LlmCompletion, 'text'> {
    return {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cachedTokens: u?.cache_read_input_tokens ?? 0
    };
}

interface CliJson { is_error?: boolean; result?: string; usage?: ClaudeUsage }

function parseCliJson(stdout: string): CliJson | null {
    try {
        const v: unknown = JSON.parse(stdout);
        return typeof v === 'object' && v !== null ? (v as CliJson) : null;
    } catch {
        return null;
    }
}

export interface ClaudeCliOptions {
    runner: CommandRunner;
    model?: string;
    binary?: string;
    timeoutMs?: number;
}

/** Plan Claude Code: `claude -p --output-format json` con el prompt por stdin (evita límites de argv). */
export class ClaudeCliAdapter implements ProviderAdapter {
    readonly provider = 'claude' as const;
    readonly model: string;

    constructor(private readonly opts: ClaudeCliOptions) {
        this.model = opts.model || DEFAULT_CLAUDE_MODEL;
    }

    async complete(req: LlmRequest): Promise<LlmCompletion> {
        const args = ['-p', '--output-format', 'json', '--model', this.model];
        if (req.system) args.push('--append-system-prompt', req.system);
        const r = await this.opts.runner(this.opts.binary ?? 'claude', args, {
            timeoutMs: this.opts.timeoutMs ?? 180_000,
            input: req.prompt
        });
        if (r.timedOut) throw new ClaudeCallError('claude CLI excedió el timeout', 'timeout');
        if (r.code === null) throw new ClaudeCallError(`claude CLI no disponible: ${r.error ?? 'desconocido'}`, 'cli_unavailable');

        const parsed = parseCliJson(r.stdout);
        if (!parsed || parsed.is_error || r.code !== 0) {
            const detail = parsed?.result ?? (r.stderr || r.stdout || `exit ${r.code}`);
            throw new ClaudeCallError(`claude CLI error: ${detail.slice(0, 500)}`, r.code ?? 'error');
        }
        return { text: parsed.result ?? '', ...mapUsage(parsed.usage) };
    }
}

export interface ClaudeApiOptions {
    apiKey: string;
    model?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    baseUrl?: string;
}

/** Anthropic Messages API (CLAUDE_PROVIDER=api). */
export class ClaudeApiAdapter implements ProviderAdapter {
    readonly provider = 'claude' as const;
    readonly model: string;

    constructor(private readonly opts: ClaudeApiOptions) {
        this.model = opts.model || DEFAULT_CLAUDE_MODEL;
    }

    async complete(req: LlmRequest): Promise<LlmCompletion> {
        const f = this.opts.fetchImpl ?? fetch;
        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
            ...(req.system ? { system: req.system } : {}),
            messages: [{ role: 'user', content: req.prompt }]
        };
        const res = await f(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.opts.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000)
        });
        const raw = await res.text();
        if (!res.ok) throw new ClaudeCallError(`Anthropic API ${res.status}: ${raw.slice(0, 300)}`, res.status);
        const json = JSON.parse(raw) as { content?: { type: string; text?: string }[]; usage?: ClaudeUsage };
        const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        return { text, ...mapUsage(json.usage) };
    }
}
