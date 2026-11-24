// Evaluación determinista (sin LLM) del hash Redis `monitoring:tenant:{position}` escrito por xBackend
// (controllers/monitoring.ts: `{node}_ts`, `{node}_errors`, `ird_summary`).
import type { AlertState, JsonObject } from '../db/store';

export const HEARTBEAT_TTL_SEC = 90;
export const NODES = ['proxmox', 'xmanager', 'multicast', 'streamer'] as const;
export type NodeName = (typeof NODES)[number];
export type Component = NodeName | 'ird';

export const COMPONENT_LABEL: Record<Component, string> = {
    proxmox: 'Proxmox',
    xmanager: 'xManager',
    multicast: 'Multicast',
    streamer: 'Streamer',
    ird: 'IRD'
};

export interface ComponentHealth {
    component: Component;
    state: AlertState;
    detail: string;
    metrics: JsonObject;
}

function parseJson(raw: string | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const v: unknown = JSON.parse(raw);
        return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

export function formatAge(sec: number): string {
    if (sec < 120) return `${sec} s`;
    if (sec < 7200) return `${Math.round(sec / 60)} min`;
    return `${Math.round(sec / 3600)} h`;
}

function evaluateNode(node: NodeName, hash: Record<string, string>, nowSec: number): ComponentHealth | null {
    const ts = parseInt(hash[`${node}_ts`] ?? '', 10);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const age = Math.max(0, nowSec - ts);
    if (age > HEARTBEAT_TTL_SEC) {
        return { component: node, state: 'down', detail: `sin heartbeat hace ${formatAge(age)}`, metrics: { age_sec: age } };
    }
    if (node === 'multicast' || node === 'streamer') {
        const tx = parseJson(hash[`${node}_errors`]);
        if (tx) {
            const down = Number(tx['down_channels'] ?? tx['down_streams'] ?? 0);
            const active = Number(tx['active_channels'] ?? tx['active_streams'] ?? 0);
            const total = Number(tx['total_channels'] ?? active + down);
            if (tx['status'] === 'red' || down > 0) {
                return { component: node, state: 'degraded', detail: `${down} canales caídos / ${total}`, metrics: { age_sec: age, down_channels: down, total_channels: total } };
            }
        }
    }
    return { component: node, state: 'ok', detail: 'online', metrics: { age_sec: age } };
}

function evaluateIrd(hash: Record<string, string>): ComponentHealth | null {
    const ird = parseJson(hash['ird_summary']);
    if (!ird) return null;
    const tuners = Array.isArray(ird['tuners']) ? (ird['tuners'] as Record<string, unknown>[]) : [];
    const locked = tuners.filter((t) => Number(t['lock']) === 1);

    let signal = typeof ird['signal_status'] === 'string' ? (ird['signal_status'] as string) : null;
    if (!signal) {
        if (tuners.length === 0) signal = 'gray';
        else if (locked.length < tuners.length) signal = 'red';
        else {
            const low = locked.some((t) => {
                const cn = Number(t['cn'] ?? t['c_n_100'] ?? 0);
                const q = Number(t['quality'] ?? 0);
                const ber = String(t['ber'] ?? '0.0E+00').trim();
                return cn < 8 || q < 40 || !['0.0E+00', '0', '0.0'].includes(ber);
            });
            signal = low ? 'yellow' : 'green';
        }
    }
    let output = typeof ird['bitrate_status'] === 'string' ? (ird['bitrate_status'] as string) : null;
    if (!output && tuners.length > 0) {
        const alarms = Number(ird['alarm_count'] ?? 0);
        const zero = tuners.some((t) => Number(t['bitrate_total'] ?? 0) <= 0 || (t['out_status'] !== undefined && Number(t['out_status']) !== 1));
        output = alarms > 0 || zero ? 'red' : 'green';
    }

    const metrics: JsonObject = { locked: locked.length, tuners: tuners.length, signal, output };
    if (signal === 'gray' && (!output || output === 'gray')) return null;
    if (signal === 'red') {
        const detail = tuners.length > 0 ? `sin lock ${tuners.length - locked.length}/${tuners.length} tuners` : 'señal en rojo';
        return { component: 'ird', state: 'down', detail, metrics };
    }
    if (signal === 'yellow') return { component: 'ird', state: 'degraded', detail: 'señal baja / BER', metrics };
    if (output === 'red') return { component: 'ird', state: 'degraded', detail: 'salida sin bitrate o con alarmas', metrics };
    return { component: 'ird', state: 'ok', detail: 'lock OK', metrics };
}

export function evaluateSnapshot(hash: Record<string, string>, nowSec: number): ComponentHealth[] {
    const out: ComponentHealth[] = [];
    for (const node of NODES) {
        const h = evaluateNode(node, hash, nowSec);
        if (h) out.push(h);
    }
    const ird = evaluateIrd(hash);
    if (ird) out.push(ird);
    return out;
}
