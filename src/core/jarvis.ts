import type { ProviderName, RosterStore } from '../db/store';
import { FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL } from '../db/store';
import { ProviderError, formatQuotaSummary, type ProviderRouter } from '../providers/providerRouter';
import type { ApprovalManager } from './approvals';
import { normalizeCode } from './approvals';
import type { Messenger } from './evolutionClient';
import { errorMessage, silentLogger, type Logger } from './logger';
import { normalizePhone } from './phone';
import type { WebhookPayload } from './webhook';

export type SpecialistName = 'sentinel' | 'tank' | 'shikamaru';

export const SIGNATURES: Record<SpecialistName | 'jarvis', string> = {
    jarvis: '🤖 *Jarvis*',
    sentinel: '🛡️ *Sentinel*',
    tank: '🔧 *Tank*',
    shikamaru: '🧠 *Shikamaru*'
};

export interface AgentRequest {
    text: string;
    senderPhone: string;
    messageId: string;
}

export interface SpecialistAgent {
    readonly name: SpecialistName;
    handle(req: AgentRequest): Promise<string>;
}

/** Superficie de Sentinel que usa Jarvis para SILENCIAR y STATUS. */
export interface SentinelControl {
    silence(target: string, minutes: number): Promise<string>;
    activeAlertCount(): Promise<number>;
}

// ---------------- Comandos deterministas (RF-04) ----------------

export type Command =
    | { type: 'status' }
    | { type: 'pause' }
    | { type: 'resume' }
    | { type: 'help' }
    | { type: 'silence'; target: string; minutes: number }
    | { type: 'confirm'; code: string }
    | { type: 'cancel'; code: string }
    | { type: 'invalid'; usage: string };

export const MAX_SILENCE_MINUTES = 1440;
const SILENCE_USAGE = 'Uso: SILENCIAR <tenant|all> <minutos> (1–1440). Ej: SILENCIAR 43 30';

const stripAccents = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function parseCommand(text: string): Command | null {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const head = stripAccents(tokens[0] ?? '').toUpperCase();
    const args = tokens.slice(1);
    switch (head) {
        case 'STATUS':
        case 'ESTADO':
            return { type: 'status' };
        case 'PAUSAR':
            return { type: 'pause' };
        case 'REANUDAR':
            return { type: 'resume' };
        case 'AYUDA':
        case 'HELP':
            return { type: 'help' };
        case 'SILENCIAR': {
            const [target, rawMin] = args;
            const minutes = Number(rawMin);
            if (!target || !/^\d+$/.test(rawMin ?? '') || minutes < 1 || minutes > MAX_SILENCE_MINUTES) {
                return { type: 'invalid', usage: SILENCE_USAGE };
            }
            return { type: 'silence', target: target.toLowerCase() === 'all' ? 'all' : target, minutes };
        }
        case 'CONFIRMAR':
        case 'CANCELAR': {
            const verb = head === 'CONFIRMAR' ? 'confirm' : 'cancel';
            if (!args[0]) return { type: 'invalid', usage: `Uso: ${head} <código> (ej. ${head} TK-482)` };
            return { type: verb, code: args[0].toUpperCase() };
        }
        default:
            return null;
    }
}

// ---------------- Router de intenciones (RF-05) ----------------

const MENTION = /(^|[\s,;:¡¿(])@?(tank|sentinel|shikamaru)\b[\s,:;.!?]*/i;
const SENTINEL_HINT = /\b(ca[ií]d[oa]s?|down|alertas?|qos)\b/i;

export function detectMention(text: string): { agent: SpecialistName; rest: string } | null {
    const m = MENTION.exec(text);
    if (!m) return null;
    const start = m.index + (m[1] ?? '').length;
    const rest = `${text.slice(0, start)} ${text.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ').trim();
    return { agent: m[2]!.toLowerCase() as SpecialistName, rest };
}

const CLASSIFIER_SYSTEM = [
    'Sos el enrutador de un War Room de operaciones IPTV. Clasificá el mensaje del operador en UNA palabra:',
    'sentinel = estado/alertas/caídas/calidad de servicio;',
    'tank = infraestructura, servidores, hardware, VMs, SSH, IRD, reinicios;',
    'shikamaru = planificación, specs, arquitectura, documentación, borradores;',
    'ninguno = saludo u otra cosa. Respondé solo la palabra.'
].join(' ');

const HELP_TEXT = [
    `${SIGNATURES.jarvis} — Comandos`,
    '• STATUS — estado general y cuotas IA (5h/24h)',
    '• PAUSAR / REANUDAR — pausa/reanuda alertas proactivas',
    '• SILENCIAR <tenant|all> <minutos>',
    '• CONFIRMAR <código> / CANCELAR <código> — acciones L1',
    '• AYUDA',
    'Agentes: @Tank (infra/hardware), @Sentinel (QoS/caídas), @Shikamaru (planificación SDD).'
].join('\n');

const PLAN_LABEL: Record<ProviderName, string> = { gemini: 'Gemini', claude: 'Claude Code' };

// ---------------- Jarvis ----------------

export type HandleStatus = 'ok' | 'ignored' | 'unauthorized' | 'duplicate' | 'error';

export interface JarvisDeps {
    commandGroupId: string;
    ownerPhones: Set<string>;
    store: RosterStore;
    messenger: Messenger;
    approvals: ApprovalManager;
    router: ProviderRouter;
    agents: Record<SpecialistName, SpecialistAgent>;
    sentinelControl: SentinelControl;
    clock?: () => Date;
    logger?: Logger;
}

interface Dispatch {
    agent: SpecialistName | 'jarvis';
    reply: string;
    meta: Record<string, unknown>;
}

export class Jarvis {
    private readonly clock: () => Date;
    private readonly logger: Logger;

    constructor(private readonly d: JarvisDeps) {
        this.clock = d.clock ?? (() => new Date());
        this.logger = d.logger ?? silentLogger;
    }

    /** Envía al War Room (el Messenger aplica además el guardrail de destino). */
    async notify(text: string): Promise<void> {
        await this.d.messenger.sendText(this.d.commandGroupId, text);
    }

    async handle(p: WebhookPayload): Promise<{ status: HandleStatus; reply?: string }> {
        if (p.from_me) return { status: 'ignored' };
        if (p.group_id !== this.d.commandGroupId) {
            this.logger.warn('webhook de grupo ajeno al War Room ignorado', { group_id: p.group_id });
            return { status: 'ignored' };
        }
        const sender = normalizePhone(p.sender_phone);
        const claimed = await this.d.store.claimMessage({ message_id: p.message_id, sender_phone: sender, input_text: p.text });
        if (!claimed) return { status: 'duplicate' };

        const t0 = this.clock().getTime();
        const elapsed = (): number => Math.max(0, this.clock().getTime() - t0);

        if (!this.d.ownerPhones.has(sender)) {
            this.logger.warn('remitente no autorizado en War Room', { sender, message_id: p.message_id });
            await this.d.store.completeMessage(p.message_id, {
                agent_name: null, output_text: null, duration_ms: elapsed(), status: 'unauthorized', metadata: { sender_name: p.sender_name ?? null }
            });
            return { status: 'unauthorized' };
        }
        if (!p.text.trim()) {
            await this.d.store.completeMessage(p.message_id, { agent_name: null, output_text: null, duration_ms: elapsed(), status: 'ignored', metadata: { reason: 'empty_text' } });
            return { status: 'ignored' };
        }

        let status: HandleStatus = 'ok';
        let result: Dispatch;
        try {
            result = await this.dispatch(p, sender);
        } catch (err) {
            status = 'error';
            result = { agent: 'jarvis', reply: this.errorReply(err), meta: { error: errorMessage(err) } };
            this.logger.error('error despachando mensaje', { message_id: p.message_id, error: errorMessage(err) });
        }

        try {
            await this.notify(result.reply);
        } catch (err) {
            status = 'error';
            result.meta['send_error'] = errorMessage(err);
            this.logger.error('no se pudo responder al War Room', { error: errorMessage(err) });
        }

        await this.d.store.completeMessage(p.message_id, {
            agent_name: result.agent, output_text: result.reply, duration_ms: elapsed(), status, metadata: result.meta
        });
        return { status, reply: result.reply };
    }

    private async dispatch(p: WebhookPayload, sender: string): Promise<Dispatch> {
        const cmd = parseCommand(p.text);
        if (cmd) return { agent: 'jarvis', reply: await this.runCommand(cmd), meta: { command: cmd.type } };

        const mention = detectMention(p.text);
        let target: SpecialistName | null = mention?.agent ?? null;
        let route = 'mention';
        if (!target && SENTINEL_HINT.test(p.text)) {
            target = 'sentinel';
            route = 'keyword';
        }
        if (!target) {
            target = await this.classify(p);
            route = 'llm';
        }
        if (!target) {
            return { agent: 'jarvis', reply: `${SIGNATURES.jarvis}\nNo identifiqué a qué agente va dirigido. Mencioná @Tank, @Sentinel o @Shikamaru, o escribí AYUDA.`, meta: { route } };
        }
        const body = await this.d.agents[target].handle({ text: mention?.rest ?? p.text.trim(), senderPhone: sender, messageId: p.message_id });
        return { agent: target, reply: `${SIGNATURES[target]}\n${body}`, meta: { route } };
    }

    private async classify(p: WebhookPayload): Promise<SpecialistName | null> {
        if (!this.d.router.has('gemini')) return null;
        const res = await this.d.router.complete('gemini', {
            agent: 'jarvis', taskType: 'route', system: CLASSIFIER_SYSTEM, prompt: p.text.slice(0, 1000), maxOutputTokens: 10,
            metadata: { message_id: p.message_id }
        });
        const word = /\b(sentinel|tank|shikamaru)\b/i.exec(res.text)?.[1]?.toLowerCase();
        return (word as SpecialistName | undefined) ?? null;
    }

    private async runCommand(cmd: Command): Promise<string> {
        const s = this.d.store;
        switch (cmd.type) {
            case 'help':
                return HELP_TEXT;
            case 'invalid':
                return `${SIGNATURES.jarvis}\n${cmd.usage}`;
            case 'pause':
                await s.setFlag(FLAG_PAUSED, 'true');
                return `${SIGNATURES.jarvis}\n⏸️ Alertas proactivas PAUSADAS. Escribí REANUDAR para volver.`;
            case 'resume':
                await s.setFlag(FLAG_PAUSED, 'false');
                return `${SIGNATURES.jarvis}\n▶️ Alertas proactivas reanudadas.`;
            case 'silence':
                return `${SIGNATURES.jarvis}\n${await this.d.sentinelControl.silence(cmd.target, cmd.minutes)}`;
            case 'confirm':
                return `${SIGNATURES.jarvis}\n${await this.d.approvals.confirm(cmd.code)}`;
            case 'cancel':
                return `${SIGNATURES.jarvis}\n${await this.d.approvals.cancel(normalizeCode(cmd.code) ?? cmd.code)}`;
            case 'status':
                return this.statusReport();
        }
    }

    private async statusReport(): Promise<string> {
        const s = this.d.store;
        const [paused, silencedAll, alerts, pending, quota] = await Promise.all([
            s.getFlag(FLAG_PAUSED),
            s.getFlag(FLAG_SILENCED_ALL_UNTIL),
            this.d.sentinelControl.activeAlertCount(),
            s.countApprovals('pending'),
            this.d.router.getQuotaSummary()
        ]);
        const now = this.clock();
        const silenceUntil = silencedAll ? new Date(silencedAll) : null;
        const silenceTxt = silenceUntil && silenceUntil.getTime() > now.getTime() ? `hasta ${silenceUntil.toISOString().slice(11, 16)} UTC` : 'no';
        return [
            `${SIGNATURES.jarvis} — STATUS`,
            `• Estado: ${paused === 'true' ? '⏸️ PAUSADO' : '▶️ activo'}`,
            `• Silencio global: ${silenceTxt}`,
            `• Alertas activas: ${alerts}`,
            `• Aprobaciones pendientes: ${pending}`,
            formatQuotaSummary(quota)
        ].join('\n');
    }

    private errorReply(err: unknown): string {
        if (err instanceof ProviderError && err.rateLimited) {
            return `${SIGNATURES.jarvis}\n⚠️ El plan ${PLAN_LABEL[err.provider]} alcanzó su límite de uso (429). Reintentá más tarde; quedó registrado en el ledger de cuotas.`;
        }
        if (err instanceof ProviderError) {
            return `${SIGNATURES.jarvis}\n⚠️ El motor ${PLAN_LABEL[err.provider]} no respondió (${err.code}). Probá de nuevo en unos minutos.`;
        }
        return `${SIGNATURES.jarvis}\n⚠️ Error interno procesando el pedido: ${errorMessage(err).slice(0, 200)}`;
    }
}
