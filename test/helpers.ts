// Dobles de prueba compartidos (no es un archivo *.test.ts).
import type { Messenger } from '../src/core/evolutionClient';
import type { LlmCompletion, LlmRequest, ProviderAdapter } from '../src/providers/providerRouter';
import type { CommandRunner, RunOptions, RunResult } from '../src/tools/commandRunner';

export const GROUP = '120363000000000001@g.us';
export const OWNER = '5491122334455';

/** Entorno mínimo válido para loadConfig (valores ficticios). */
export const VALID_ENV: Record<string, string> = {
    PORT: '3900',
    XROOSTER_WEBHOOK_SECRET: 'a-very-long-secret-value',
    WHATSAPP_COMMAND_GROUP_ID: GROUP,
    OWNER_WHATSAPP_PHONES: '+54 11 2233-4455, 14155550100',
    EVOLUTION_API_URL: 'http://evo:8080',
    EVOLUTION_API_KEY: 'k',
    EVOLUTION_INSTANCE_NAME: 'xiptv',
    PG_XROOSTER_URL: 'postgres://u:p@h:5432/xroosterdb',
    PG_XSERVER_RO_URL: 'postgres://ro:p@h:5432/xserver',
    REDIS_URL: 'redis://redis:6379'
};

export function fakeMessenger(): Messenger & { sent: { target: string; text: string }[] } {
    const sent: { target: string; text: string }[] = [];
    return {
        sent,
        async sendText(target: string, text: string) {
            sent.push({ target, text });
        }
    };
}

export function fakeAdapter(
    provider: 'gemini' | 'claude',
    impl: (req: LlmRequest) => Promise<LlmCompletion> | LlmCompletion
): ProviderAdapter & { seen: LlmRequest[] } {
    const seen: LlmRequest[] = [];
    return {
        provider,
        model: `${provider}-test`,
        seen,
        async complete(req) {
            seen.push(req);
            return impl(req);
        }
    };
}

export const completion = (text: string): LlmCompletion => ({ text, inputTokens: 10, outputTokens: 5, cachedTokens: 0 });

export interface RunnerCall { cmd: string; args: readonly string[]; opts: RunOptions }

/** Runner scriptable: la función decide el resultado según cmd/args. */
export function scriptedRunner(script: (call: RunnerCall) => Partial<RunResult> | Promise<Partial<RunResult>>): CommandRunner & { calls: RunnerCall[] } {
    const calls: RunnerCall[] = [];
    const fn = (async (cmd: string, args: readonly string[], opts: RunOptions) => {
        const call = { cmd, args, opts };
        calls.push(call);
        const r = await script(call);
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...r };
    }) as CommandRunner & { calls: RunnerCall[] };
    fn.calls = calls;
    return fn;
}

export function fixedClock(iso = '2026-11-24T12:00:00Z') {
    let now = Date.parse(iso);
    const clock = () => new Date(now);
    return { clock, advance: (ms: number) => { now += ms; }, nowMs: () => now };
}
