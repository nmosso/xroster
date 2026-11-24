import type { AlertStateRow, RosterStore } from '../db/store';
import { FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL, tenantSilenceFlag } from '../db/store';
import { normalizeTenantRef } from '../db/tenantsRepo';
import { COMPONENT_LABEL, evaluateSnapshot, formatAge, type Component } from '../core/health';
import { errorMessage, silentLogger, type Logger } from '../core/logger';
import type { AgentRequest, SentinelControl, SpecialistAgent } from '../core/jarvis';
import { SIGNATURES } from '../core/jarvis';
import type { MonitoringSource } from '../tools/monitoringSource';

export interface SentinelOptions {
    store: RosterStore;
    source: MonitoringSource;
    notify: (text: string) => Promise<void>;
    /** Nombre legible del tenant (cacheado por el ensamblador). */
    resolveName?: (position: string) => Promise<string | null>;
    clock?: () => Date;
    logger?: Logger;
    pollMs: number;
    cooldownMs: number;
    stormThreshold: number;
}

type EventKind = 'new' | 'changed' | 'reminder' | 'recovered';

interface SentinelEvent {
    kind: EventKind;
    row: AlertStateRow;
    downSinceMs?: number;
}

export interface TickResult {
    skipped?: 'paused';
    error?: string;
    events: number;
    messages: number;
}

const MAX_LINES = 25;

/** RF-07: monitor proactivo determinista sobre Redis `monitoring:tenant:*`. */
export class Sentinel implements SpecialistAgent, SentinelControl {
    readonly name = 'sentinel' as const;
    private readonly clock: () => Date;
    private readonly logger: Logger;
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<TickResult> | null = null;

    constructor(private readonly o: SentinelOptions) {
        this.clock = o.clock ?? (() => new Date());
        this.logger = o.logger ?? silentLogger;
    }

    // ---------------- Ciclo de polling ----------------

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.running) return; // sin solapamiento de ticks
            this.running = this.tick().finally(() => { this.running = null; });
        }, this.o.pollMs);
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.running) await this.running.catch(() => undefined);
    }

    async tick(): Promise<TickResult> {
        try {
            if ((await this.o.store.getFlag(FLAG_PAUSED)) === 'true') return { skipped: 'paused', events: 0, messages: 0 };
            const now = this.clock();
            const nowSec = Math.floor(now.getTime() / 1000);
            const globalUntil = parseDate(await this.o.store.getFlag(FLAG_SILENCED_ALL_UNTIL));
            const snapshots = await this.o.source.listSnapshots();

            const events: SentinelEvent[] = [];
            for (const snap of snapshots) {
                const tenantUntil = parseDate(await this.o.store.getFlag(tenantSilenceFlag(snap.position)));
                for (const h of evaluateSnapshot(snap.hash, nowSec)) {
                    const ev = await this.apply(snap.position, h.component, h.state, h.detail, h.metrics, now, [globalUntil, tenantUntil]);
                    if (ev) events.push(ev);
                }
            }
            if (events.length === 0) return { events: 0, messages: 0 };

            const messages = this.render(events, now);
            try {
                for (const m of messages) await this.o.notify(m);
            } catch (err) {
                this.logger.error('Sentinel: no se pudo notificar al War Room', { error: errorMessage(err) });
                return { error: errorMessage(err), events: events.length, messages: 0 };
            }
            for (const ev of events) {
                if (ev.kind !== 'recovered') await this.o.store.upsertAlertState({ ...ev.row, last_notified_at: now });
            }
            return { events: events.length, messages: messages.length };
        } catch (err) {
            this.logger.error('Sentinel: tick fallido', { error: errorMessage(err) });
            return { error: errorMessage(err), events: 0, messages: 0 };
        }
    }

    /** Máquina de estados ok | degraded | down por `{position}:{component}`. */
    private async apply(
        position: string, component: Component, state: AlertStateRow['state'], detail: string,
        metrics: AlertStateRow['metrics'], now: Date, silences: (Date | null)[]
    ): Promise<SentinelEvent | null> {
        const key = `${position}:${component}`;
        const prev = await this.o.store.getAlertState(key);
        const silenced = [...silences, prev?.silenced_until ?? null].some((d) => d !== null && d.getTime() > now.getTime());

        if (state === 'ok') {
            if (!prev || prev.state === 'ok') return null;
            const row: AlertStateRow = { ...prev, state: 'ok', last_detail: detail, metrics };
            await this.o.store.upsertAlertState(row);
            if (prev.last_notified_at === null || silenced) return null;
            return { kind: 'recovered', row, downSinceMs: prev.first_seen_at.getTime() };
        }

        let kind: EventKind | null;
        let row: AlertStateRow;
        if (!prev || prev.state === 'ok') {
            kind = 'new';
            row = {
                alert_key: key, tenant_position: position, tenant_name: await this.tenantName(position), component, state,
                first_seen_at: now, last_notified_at: null, silenced_until: prev?.silenced_until ?? null, last_detail: detail, metrics
            };
        } else if (prev.state !== state) {
            kind = 'changed';
            row = { ...prev, state, last_detail: detail, metrics };
        } else {
            const due = prev.last_notified_at === null || now.getTime() - prev.last_notified_at.getTime() >= this.o.cooldownMs;
            kind = due ? (prev.last_notified_at === null ? 'new' : 'reminder') : null;
            row = { ...prev, last_detail: detail, metrics };
        }
        await this.o.store.upsertAlertState(row);
        return kind && !silenced ? { kind, row } : null;
    }

    private async tenantName(position: string): Promise<string | null> {
        if (!this.o.resolveName) return null;
        try {
            return await this.o.resolveName(position);
        } catch {
            return null;
        }
    }

    // ---------------- Render (anti-tormenta) ----------------

    private line(ev: SentinelEvent, now: Date): string {
        const r = ev.row;
        const who = `${r.tenant_position}${r.tenant_name ? ` ${r.tenant_name}` : ''} · ${COMPONENT_LABEL[r.component as Component] ?? r.component}`;
        if (ev.kind === 'recovered') {
            const mins = ev.downSinceMs ? ` (incidente de ${formatAge(Math.round((now.getTime() - ev.downSinceMs) / 1000))})` : '';
            return `✅ RECUPERADO · ${who}${mins}`;
        }
        const icon = r.state === 'down' ? '🔴 CAÍDO' : '🟠 DEGRADADO';
        const prefix = ev.kind === 'reminder' ? '🔁 Sigue ' : '';
        return `${prefix}${icon} · ${who} — ${r.last_detail ?? ''}`.trim();
    }

    private render(events: SentinelEvent[], now: Date): string[] {
        if (events.length <= this.o.stormThreshold) {
            return events.map((ev) => `${SIGNATURES.sentinel}\n${this.line(ev, now)}`);
        }
        const alerts = events.filter((e) => e.kind !== 'recovered');
        const recovered = events.filter((e) => e.kind === 'recovered');
        const lines: string[] = [`${SIGNATURES.sentinel}`, `🚨 ${events.length} incidencias en este ciclo (${alerts.length} alertas, ${recovered.length} recuperadas):`];
        const all = [...alerts, ...recovered].map((e) => this.line(e, now));
        lines.push(...all.slice(0, MAX_LINES));
        if (all.length > MAX_LINES) lines.push(`… y ${all.length - MAX_LINES} más. Escribí "Sentinel qué está caído" para el detalle.`);
        return [lines.join('\n')];
    }

    // ---------------- Consultas y control ----------------

    async handle(_req: AgentRequest): Promise<string> {
        return this.whatIsDown();
    }

    async whatIsDown(): Promise<string> {
        const active = await this.o.store.listAlertStates({ nonOkOnly: true });
        if (active.length === 0) return '✅ Todo operativo: sin incidencias activas.';
        const lines = active
            .sort((a, b) => (a.state === b.state ? a.alert_key.localeCompare(b.alert_key) : a.state === 'down' ? -1 : 1))
            .map((r) => {
                const icon = r.state === 'down' ? '🔴' : '🟠';
                const who = `${r.tenant_position}${r.tenant_name ? ` ${r.tenant_name}` : ''} · ${COMPONENT_LABEL[r.component as Component] ?? r.component}`;
                return `${icon} ${who} — ${r.last_detail ?? ''} (desde ${r.first_seen_at.toISOString().slice(11, 16)} UTC)`;
            });
        return [`${active.length} incidencia(s) activa(s):`, ...lines.slice(0, MAX_LINES)].join('\n');
    }

    async activeAlertCount(): Promise<number> {
        return (await this.o.store.listAlertStates({ nonOkOnly: true })).length;
    }

    async silence(target: string, minutes: number): Promise<string> {
        const until = new Date(this.clock().getTime() + minutes * 60_000);
        if (target === 'all') {
            await this.o.store.setFlag(FLAG_SILENCED_ALL_UNTIL, until.toISOString());
            return `🔕 Alertas silenciadas para todos los tenants por ${minutes} min.`;
        }
        const pos = normalizeTenantRef(target);
        if (!pos || !/^\d+$/.test(pos)) return `❓ Tenant inválido "${target.slice(0, 20)}". Usá la posición numérica (ej. SILENCIAR 43 30) o "all".`;
        await this.o.store.setFlag(tenantSilenceFlag(pos), until.toISOString());
        await this.o.store.setTenantSilence(pos, until);
        return `🔕 Alertas del tenant ${pos} silenciadas por ${minutes} min.`;
    }
}

function parseDate(v: string | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}
