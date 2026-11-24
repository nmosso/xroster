import { neutralize } from './text';

/** Canal de salida de xRoster. La única implementación productiva es EvolutionClient (guardrail RF-03). */
export interface Messenger {
    sendText(target: string, text: string): Promise<void>;
}

export class ForbiddenTargetError extends Error {
    constructor(readonly target: string) {
        super(`Destino prohibido: xRoster solo puede enviar al grupo War Room (intento: "${target}")`);
        this.name = 'ForbiddenTargetError';
    }
}

export class EvolutionHttpError extends Error {
    constructor(readonly status: number, body: string) {
        super(`Evolution API respondió ${status}: ${body.slice(0, 200)}`);
        this.name = 'EvolutionHttpError';
    }
}

export interface EvolutionClientOptions {
    baseUrl: string;
    apiKey: string;
    instance: string;
    commandGroupId: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/** Cliente Evolution API v2 con guardrail duro: cualquier destino distinto de WHATSAPP_COMMAND_GROUP_ID aborta ANTES de HTTP. */
export class EvolutionClient implements Messenger {
    private readonly baseUrl: string;

    constructor(private readonly opts: EvolutionClientOptions) {
        if (!/^[0-9]+(-[0-9]+)?@g\.us$/.test(opts.commandGroupId)) {
            throw new Error('WHATSAPP_COMMAND_GROUP_ID debe ser un JID de grupo (…@g.us)');
        }
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    }

    async sendText(target: string, text: string): Promise<void> {
        if (target !== this.opts.commandGroupId) throw new ForbiddenTargetError(target);
        const f = this.opts.fetchImpl ?? fetch;
        const res = await f(`${this.baseUrl}/message/sendText/${encodeURIComponent(this.opts.instance)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', apikey: this.opts.apiKey },
            body: JSON.stringify({ number: target, text: neutralize(text) }),
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
        });
        if (!res.ok) throw new EvolutionHttpError(res.status, await res.text().catch(() => ''));
    }
}
