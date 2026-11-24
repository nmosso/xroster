import type { Approval } from '../db/store';
import type { TenantRecord, TenantsLookup } from '../db/tenantsRepo';
import type { ApprovalManager } from '../core/approvals';
import { COMPONENT_LABEL, evaluateSnapshot, type NodeName } from '../core/health';
import type { AgentRequest, SpecialistAgent } from '../core/jarvis';
import { errorMessage, silentLogger, type Logger } from '../core/logger';
import { MAX_TOOL_OUTPUT_CHARS, truncate } from '../core/text';
import { ProviderError, type ProviderRouter } from '../providers/providerRouter';
import { readIrd, type IrdReading } from '../tools/ird';
import type { MonitoringSource } from '../tools/monitoringSource';
import { assertPosition, assertUnit, nodeTargets, type SshResult, type SshTool } from '../tools/ssh';

/** Catálogo cerrado L1 (RF-08). Nada fuera de esta lista puede reiniciarse. */
export const ALLOWED_RESTART_SERVICES = ['xmanager', 'multicast', 'streamer'] as const;
export type RestartService = (typeof ALLOWED_RESTART_SERVICES)[number];
const isAllowedService = (s: string): s is RestartService => (ALLOWED_RESTART_SERVICES as readonly string[]).includes(s);

export type ServiceUnits = Record<RestartService, string>;
const DEFAULT_UNITS: ServiceUnits = { xmanager: 'xmanager', multicast: 'multicast', streamer: 'streamer' };

/** TANK_SERVICE_UNITS opcional: "streamer=unidad,multicast=unidad" (solo servicios del catálogo). */
export function parseServiceUnits(csv: string | undefined): ServiceUnits {
    const units: ServiceUnits = { ...DEFAULT_UNITS };
    for (const pair of String(csv ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
        const [svc, unit] = pair.split('=').map((s) => s.trim());
        if (!svc || !unit || !isAllowedService(svc)) throw new Error(`TANK_SERVICE_UNITS: servicio fuera de catálogo "${svc ?? ''}"`);
        units[svc] = assertUnit(unit);
    }
    return units;
}

// Cualquier intento de comando libre se rechaza antes de crear approval o tocar SSH.
// Límites de palabra Unicode-aware (\b de JS trata "á" como separador: "catálogo" no debe matchear "cat").
const SHELL_ATTEMPT = /[;&|`$<>\\]|(?<![\p{L}\d_])(rm|sudo|sh|bash|zsh|curl|wget|dd|mkfs|chmod|chown|kill|pkill|killall|reboot|shutdown|halt|poweroff|systemctl|apt|scp|nc|python|perl|cat|ejecut\p{L}*|corr[eé]\p{L}*|run)(?![\p{L}\d_])/iu;
const RESTART_INTENT = /\b(reinici\w*|restart\w*)/i;
const STOPWORDS = new Set([
    'el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'que', 'qué', 'como', 'cómo', 'esta', 'está', 'estado', 'revisa', 'revisá',
    'revisar', 'chequea', 'chequeá', 'fijate', 'mirá', 'mira', 'server', 'servidor', 'cabecera', 'tenant', 'cliente', 'por', 'favor',
    'hola', 'che', 'anda', 'todo', 'bien', 'salud', 'diagnostico', 'diagnóstico', 'servicio', 'service', 'al', 'con', 'para', 'me', 'decime'
]);

const NODE_UNIT: Record<NodeName, RestartService | null> = { proxmox: null, xmanager: 'xmanager', multicast: 'multicast', streamer: 'streamer' };

const DIAGNOSE_SYSTEM = [
    'Sos Tank, ingeniero de infraestructura de una plataforma IPTV. Con la evidencia (Redis heartbeats, SSH read-only, IRD)',
    'escribí un diagnóstico breve en español (máx. 6 líneas): estado, causa probable y próximo paso seguro.',
    'No inventes datos ni propongas comandos destructivos. Usá términos neutros: "Servidor de Streaming" para el streamer.'
].join(' ');

export interface TankOptions {
    tenants: TenantsLookup;
    monitoring: MonitoringSource;
    ssh: SshTool;
    approvals: ApprovalManager;
    router?: ProviderRouter;
    fetchImpl?: typeof fetch;
    serviceUnits?: ServiceUnits;
    clock?: () => Date;
    logger?: Logger;
}

type Resolution = { tenant: TenantRecord } | { message: string };

export class Tank implements SpecialistAgent {
    readonly name = 'tank' as const;
    private readonly units: ServiceUnits;
    private readonly logger: Logger;

    constructor(private readonly o: TankOptions) {
        this.units = o.serviceUnits ?? DEFAULT_UNITS;
        this.logger = o.logger ?? silentLogger;
        o.approvals.register('restart_service', (a) => this.executeRestart(a));
    }

    async handle(req: AgentRequest): Promise<string> {
        const text = req.text.trim();
        if (SHELL_ATTEMPT.test(text)) {
            return '🚫 Rechazado: Tank no ejecuta comandos libres. Solo diagnóstico read-only y reinicio de servicios del catálogo (xmanager, multicast, streamer) con CONFIRMAR.';
        }
        if (RESTART_INTENT.test(text)) return this.requestRestart(text);
        return this.diagnose(text);
    }

    // ---------------- Resolución de tenant ----------------

    private async resolveTenant(text: string): Promise<Resolution> {
        const num = /\b(?:server|servidor|cabecera|tenant|pos|cliente)?\s*#?(\d{1,4})\b/i.exec(text)?.[1];
        const candidates = num
            ? [num]
            : [
                text.replace(/[¿?¡!.,:]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase())).join(' '),
                ...text.replace(/[¿?¡!.,:]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase())).sort((a, b) => b.length - a.length)
            ].filter((c, i, arr) => c && arr.indexOf(c) === i).slice(0, 3);

        for (const ref of candidates) {
            const found = await this.o.tenants.find(ref);
            if (found.length === 1) return { tenant: found[0]! };
            if (found.length > 1) {
                const list = found.slice(0, 5).map((t) => `• ${t.position} · ${t.name ?? t.tenantid} (${t.tenantid})`).join('\n');
                return { message: `Encontré varios tenants para "${ref}":\n${list}\nIndicá la posición exacta.` };
            }
        }
        const shown = candidates[0] ?? '';
        return { message: `🔎 No encontré un tenant${shown ? ` para "${shown.slice(0, 40)}"` : ''}. Indicá el tenant por posición, tenantid o nombre (ej. "revisá el server 43").` };
    }

    // ---------------- L0: diagnóstico ----------------

    private async diagnose(text: string): Promise<string> {
        const r = await this.resolveTenant(text);
        if ('message' in r) return r.message;
        const t = r.tenant;
        try {
            assertPosition(t.position);
        } catch (err) {
            return `⚠️ ${errorMessage(err)} para ${t.tenantid}.`;
        }

        const nowSec = Math.floor((this.o.clock?.() ?? new Date()).getTime() / 1000);
        const [snapshot, sshResults, ird] = await Promise.all([
            this.o.monitoring.getSnapshot(t.position).catch(() => null),
            Promise.all(nodeTargets(t.position).map((target) => {
                const svc = NODE_UNIT[target.node];
                return this.o.ssh.exec(target, { kind: 'health', ...(svc ? { unit: this.units[svc] } : {}) });
            })),
            readIrd(t.position, this.o.fetchImpl)
        ]);

        const lines: string[] = [`*${t.position} · ${t.name ?? t.tenantid}* (${t.tenantid})`, 'Redis (heartbeats):'];
        const health = snapshot ? evaluateSnapshot(snapshot.hash, nowSec) : [];
        if (health.length === 0) lines.push('• sin datos de monitoreo en Redis');
        for (const h of health) {
            const icon = h.state === 'ok' ? '✅' : h.state === 'down' ? '🔴' : '🟠';
            lines.push(`• ${COMPONENT_LABEL[h.component]} ${icon} ${h.detail}`);
        }
        lines.push('SSH (read-only):');
        for (const s of sshResults) lines.push(`• ${COMPONENT_LABEL[s.target.node]} ${this.describeSsh(s)}`);
        lines.push(`• IRD ${ird.ok ? '✅ responde' : '⚠️ no responde'} (${ird.url})`);
        const report = lines.join('\n');

        const synthesis = await this.synthesize(report, sshResults, ird);
        return synthesis ? `${report}\n\n${synthesis}` : report;
    }

    private describeSsh(s: SshResult): string {
        const addr = `${s.target.host}:${s.target.port}`;
        if (s.timedOut) return `⏱️ timeout SSH (${Math.round(this.o.ssh.timeoutMs / 1000)} s) — ${addr}`;
        if (s.code === null) return `❌ ssh no disponible — ${s.output.split('\n')[0] ?? ''}`;
        if (s.code === 255) return `❌ conexión SSH fallida — ${addr}: ${(s.output.split('\n')[0] ?? '').slice(0, 120)}`;
        return `${s.ok ? '✅' : '⚠️'} ${summarizeHealth(s.output)}`;
    }

    private async synthesize(report: string, ssh: SshResult[], ird: IrdReading): Promise<string | null> {
        if (!this.o.router?.has('gemini')) return null;
        const evidence = truncate(
            [report, ...ssh.map((s) => `--- ${s.target.node} ${s.target.host}:${s.target.port}\n${s.output}`), `--- IRD\n${ird.text}`].join('\n'),
            MAX_TOOL_OUTPUT_CHARS
        );
        try {
            const res = await this.o.router.complete('gemini', { agent: 'tank', taskType: 'diagnose', system: DIAGNOSE_SYSTEM, prompt: evidence, maxOutputTokens: 400 });
            return `🧠 ${res.text.trim()}`;
        } catch (err) {
            if (err instanceof ProviderError && err.rateLimited) return '⚠️ Plan Gemini en límite de uso (429): diagnóstico sin síntesis IA.';
            this.logger.warn('Tank: síntesis IA no disponible', { error: errorMessage(err) });
            return '⚠️ Síntesis IA no disponible; se muestra el diagnóstico determinista.';
        }
    }

    // ---------------- L1: reinicio con aprobación ----------------

    private async requestRestart(text: string): Promise<string> {
        const words = text.toLowerCase().split(/[\s,.:¿?¡!]+/).filter(Boolean);
        let service: string | undefined = words.find(isAllowedService);
        if (!service) {
            const after = text.slice((RESTART_INTENT.exec(text)?.index ?? 0)).split(/\s+/).slice(1)
                .find((w) => !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
            if (!after) return '❓ ¿Qué servicio querés reiniciar? Catálogo permitido: xmanager, multicast, streamer.';
            return `🚫 Servicio "${after.slice(0, 30)}" fuera de whitelist. Catálogo permitido: xmanager, multicast, streamer.`;
        }
        if (!isAllowedService(service)) return '🚫 Servicio fuera de whitelist.';

        const r = await this.resolveTenant(text.replace(new RegExp(`\\b${service}\\b`, 'i'), ' ').replace(RESTART_INTENT, ' '));
        if ('message' in r) return r.message;
        const t = r.tenant;
        try {
            assertPosition(t.position);
        } catch (err) {
            return `⚠️ ${errorMessage(err)}`;
        }
        const target = nodeTargets(t.position).find((n) => n.node === service)!;
        const unit = this.units[service];
        const a = await this.o.approvals.request({
            prefix: 'TK', agentName: 'tank', actionType: 'restart_service', targetTenant: t.position,
            summaryText: `Reiniciar ${service} (${unit}) en ${t.position} · ${t.name ?? t.tenantid} [${target.host}:${target.port}]`,
            payload: { service, position: t.position, tenantid: t.tenantid, unit }
        });
        return [
            `🔐 Acción L1 propuesta: reiniciar *${service}* en ${t.position} · ${t.name ?? t.tenantid} [${target.host}:${target.port}].`,
            `Respondé *CONFIRMAR ${a.code}* (vence en 5 min) o CANCELAR ${a.code}.`
        ].join('\n');
    }

    /** Handler `restart_service`: revalida catálogo y destino (defensa en profundidad), reinicia y hace post-check. */
    async executeRestart(a: Approval): Promise<string> {
        const service = String(a.payload['service'] ?? '');
        const position = String(a.payload['position'] ?? '');
        if (!isAllowedService(service)) throw new Error(`servicio fuera de whitelist: ${service.slice(0, 30)}`);
        assertPosition(position);
        const unit = this.units[service];
        const target = nodeTargets(position).find((n) => n.node === service)!;

        const restart = await this.o.ssh.exec(target, { kind: 'service_restart', unit });
        if (!restart.ok) {
            throw new Error(restart.timedOut ? `timeout SSH reiniciando ${service}` : `reinicio de ${service} falló (exit ${restart.code}): ${restart.output.slice(0, 200)}`);
        }
        const check = await this.o.ssh.exec(target, { kind: 'service_status', unit });
        const state = check.timedOut ? 'timeout' : (check.output.trim().split('\n').pop() ?? 'desconocido');
        return `🔄 ${service} reiniciado en ${position} [${target.host}:${target.port}] · post-check: ${state}`;
    }
}

/** Resume la salida de `uptime; df -h /; free -m; systemctl is-active` en una línea. */
export function summarizeHealth(output: string): string {
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    const parts: string[] = [];
    const up = lines.find((l) => /load average/.test(l));
    if (up) parts.push(up.replace(/\s+/g, ' ').replace(/^\d{2}:\d{2}:\d{2}\s+/, ''));
    const disk = lines.find((l) => /\s\/$/.test(l));
    const diskPct = disk?.split(/\s+/).find((c) => /^\d+%$/.test(c));
    if (diskPct) parts.push(`disco / ${diskPct}`);
    const mem = lines.find((l) => /^Mem:/.test(l))?.split(/\s+/);
    if (mem && mem.length >= 3) parts.push(`RAM ${mem[2]}/${mem[1]} MB`);
    const svc = lines.at(-1);
    if (svc && /^(active|inactive|failed|activating|deactivating|unknown)$/.test(svc)) parts.push(`servicio: ${svc}`);
    return parts.length > 0 ? parts.join(' | ') : truncate(lines.join(' '), 200);
}
