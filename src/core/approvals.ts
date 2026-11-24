import type { ActionType, Approval, JsonObject, RoosterStore } from '../db/store';
import { errorMessage } from './logger';

/** RF-06: TTL de toda acción L1. */
export const APPROVAL_TTL_MS = 5 * 60_000;

export type ApprovalPrefix = 'TK' | 'SH';
export type ApprovalHandler = (approval: Approval) => Promise<string>;

export interface ApprovalRequest {
    prefix: ApprovalPrefix;
    agentName: string;
    actionType: ActionType;
    targetTenant: string | null;
    summaryText: string;
    payload: JsonObject;
}

export interface ApprovalManagerOptions {
    store: RoosterStore;
    clock?: () => Date;
    random?: () => number;
    ttlMs?: number;
}

const CODE_PATTERN = /^(TK|SH)-\d{3,5}$/;
const ATTEMPTS_PER_WIDTH = 25;

/** Gestor L1: nada se ejecuta sin `CONFIRMAR <código>` dentro del TTL; confirmaciones idempotentes (compare-and-set). */
export class ApprovalManager {
    private readonly handlers = new Map<string, ApprovalHandler>();
    private readonly clock: () => Date;
    private readonly random: () => number;
    private readonly ttlMs: number;

    constructor(private readonly opts: ApprovalManagerOptions) {
        this.clock = opts.clock ?? (() => new Date());
        this.random = opts.random ?? Math.random;
        this.ttlMs = opts.ttlMs ?? APPROVAL_TTL_MS;
    }

    register(actionType: ActionType, handler: ApprovalHandler): void {
        this.handlers.set(actionType, handler);
    }

    async request(req: ApprovalRequest): Promise<Approval> {
        if (!this.handlers.has(req.actionType)) throw new Error(`Acción L1 sin handler registrado: ${req.actionType}`);
        const requested_at = this.clock();
        const expires_at = new Date(requested_at.getTime() + this.ttlMs);
        // 3 dígitos (TK-482); si el espacio se satura, se amplía a 4 y 5 dígitos.
        for (const width of [3, 4, 5]) {
            const min = 10 ** (width - 1);
            for (let i = 0; i < ATTEMPTS_PER_WIDTH; i++) {
                const code = `${req.prefix}-${min + Math.floor(this.random() * 9 * min)}`;
                const created = await this.opts.store.createApproval({
                    code, agent_name: req.agentName, action_type: req.actionType, target_tenant: req.targetTenant,
                    summary_text: req.summaryText, payload: req.payload, requested_at, expires_at
                });
                if (created) {
                    return { code, agent_name: req.agentName, action_type: req.actionType, target_tenant: req.targetTenant,
                        summary_text: req.summaryText, payload: req.payload, status: 'pending', requested_at, expires_at,
                        decided_at: null, result_summary: null };
                }
            }
        }
        throw new Error('No se pudo generar un código de aprobación único');
    }

    async confirm(rawCode: string): Promise<string> {
        const code = normalizeCode(rawCode);
        if (!code) return invalidCode(rawCode);
        const a = await this.opts.store.getApproval(code);
        if (!a) return `❓ No existe la solicitud ${code}.`;
        if (a.status !== 'pending') return describeFinal(a);

        const now = this.clock();
        if (now.getTime() > a.expires_at.getTime()) {
            await this.opts.store.transitionApproval(code, 'pending', { status: 'expired', decided_at: now });
            return `⌛ La solicitud ${code} expiró (TTL 5 min). No se ejecutó nada; pedila de nuevo.`;
        }
        const won = await this.opts.store.transitionApproval(code, 'pending', { status: 'confirmed', decided_at: now });
        if (!won) {
            const current = await this.opts.store.getApproval(code);
            return current ? describeFinal(current) : `❓ No existe la solicitud ${code}.`;
        }

        const handler = this.handlers.get(a.action_type);
        if (!handler) {
            await this.opts.store.transitionApproval(code, 'confirmed', { status: 'failed', result_summary: 'sin handler registrado' });
            return `❌ ${code} falló: acción ${a.action_type} sin handler registrado.`;
        }
        try {
            const result = await handler(a);
            await this.opts.store.transitionApproval(code, 'confirmed', { status: 'executed', result_summary: result });
            return `✅ ${code} ejecutada.\n${result}`;
        } catch (err) {
            const detail = errorMessage(err);
            await this.opts.store.transitionApproval(code, 'confirmed', { status: 'failed', result_summary: detail });
            return `❌ ${code} falló: ${detail}`;
        }
    }

    async cancel(rawCode: string): Promise<string> {
        const code = normalizeCode(rawCode);
        if (!code) return invalidCode(rawCode);
        const a = await this.opts.store.getApproval(code);
        if (!a) return `❓ No existe la solicitud ${code}.`;
        if (a.status !== 'pending') return describeFinal(a);
        const now = this.clock();
        if (now.getTime() > a.expires_at.getTime()) {
            await this.opts.store.transitionApproval(code, 'pending', { status: 'expired', decided_at: now });
            return `⌛ La solicitud ${code} ya había expirado; no hay nada que cancelar.`;
        }
        const ok = await this.opts.store.transitionApproval(code, 'pending', { status: 'cancelled', decided_at: now });
        if (!ok) {
            const current = await this.opts.store.getApproval(code);
            return current ? describeFinal(current) : `❓ No existe la solicitud ${code}.`;
        }
        return `🚫 Solicitud ${code} cancelada. No se ejecutó nada.`;
    }
}

export function normalizeCode(raw: string): string | null {
    const code = String(raw ?? '').trim().toUpperCase();
    return CODE_PATTERN.test(code) ? code : null;
}

function invalidCode(raw: string): string {
    return `❓ Código inválido: "${String(raw ?? '').slice(0, 20)}". Formato esperado: TK-123 o SH-123.`;
}

function describeFinal(a: Approval): string {
    switch (a.status) {
        case 'executed':
            return `ℹ️ ${a.code} ya fue ejecutada${a.result_summary ? `: ${a.result_summary}` : '.'}`;
        case 'confirmed':
            return `⏳ ${a.code} ya está en ejecución.`;
        case 'cancelled':
            return `🚫 ${a.code} fue cancelada; no se ejecuta.`;
        case 'expired':
            return `⌛ ${a.code} expiró; no se ejecuta. Pedila de nuevo.`;
        case 'failed':
            return `❌ ${a.code} ya se intentó y falló${a.result_summary ? `: ${a.result_summary}` : '.'}`;
        case 'pending':
            return `⏳ ${a.code} sigue pendiente.`;
    }
}
