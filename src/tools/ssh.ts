import type { NodeName } from '../core/health';
import { truncate } from '../core/text';
import type { CommandRunner } from './commandRunner';

export const SSH_TIMEOUT_MS_DEFAULT = 8000;

export interface NodeTarget {
    node: NodeName;
    host: string;
    port: number;
}

/** Posición de tenant válida para direccionar 100.64.N.x (1..254). Cualquier otra cosa se rechaza. */
export function assertPosition(position: string): number {
    if (!/^\d{1,3}$/.test(position)) throw new Error(`Posición de tenant inválida: "${String(position).slice(0, 20)}"`);
    const n = Number(position);
    if (n < 1 || n > 254) throw new Error(`Posición de tenant fuera de rango: ${n}`);
    return n;
}

/** Topología canónica por tenant (xWorker): Proxmox .2:22, xManager .8:22, Multicast .2:8522, Streamer .2:8222. */
export function nodeTargets(position: string): NodeTarget[] {
    const n = assertPosition(position);
    return [
        { node: 'proxmox', host: `100.64.${n}.2`, port: 22 },
        { node: 'xmanager', host: `100.64.${n}.8`, port: 22 },
        { node: 'multicast', host: `100.64.${n}.2`, port: 8522 },
        { node: 'streamer', host: `100.64.${n}.2`, port: 8222 }
    ];
}

/** Catálogo cerrado de comandos remotos. El LLM nunca escribe comandos: solo se eligen estas variantes tipadas. */
export type SafeCommand =
    | { kind: 'health'; unit?: string }
    | { kind: 'service_status'; unit: string }
    | { kind: 'service_restart'; unit: string };

const UNIT_PATTERN = /^[A-Za-z0-9@._-]{1,64}$/;

export function assertUnit(unit: string): string {
    if (!UNIT_PATTERN.test(unit)) throw new Error(`Unidad systemd inválida: "${String(unit).slice(0, 30)}"`);
    return unit;
}

export function buildRemoteCommand(cmd: SafeCommand, user = 'root'): string {
    switch (cmd.kind) {
        case 'health':
            return `uptime; df -h /; free -m${cmd.unit ? `; systemctl is-active ${assertUnit(cmd.unit)}` : ''}`;
        case 'service_status':
            return `systemctl is-active ${assertUnit(cmd.unit)}`;
        case 'service_restart':
            return `${user === 'root' ? '' : 'sudo -n '}systemctl restart ${assertUnit(cmd.unit)}`;
    }
}

export interface SshResult {
    target: NodeTarget;
    ok: boolean;
    timedOut: boolean;
    code: number | null;
    /** stdout+stderr truncado a 4 000 chars. */
    output: string;
}

export interface SshToolOptions {
    runner: CommandRunner;
    user: string;
    keyPath: string;
    timeoutMs?: number;
}

export class SshTool {
    readonly timeoutMs: number;

    constructor(private readonly o: SshToolOptions) {
        this.timeoutMs = o.timeoutMs ?? SSH_TIMEOUT_MS_DEFAULT;
    }

    async exec(target: NodeTarget, cmd: SafeCommand): Promise<SshResult> {
        const remote = buildRemoteCommand(cmd, this.o.user);
        const args = [
            '-i', this.o.keyPath,
            '-p', String(target.port),
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', `ConnectTimeout=${Math.max(1, Math.floor(this.timeoutMs / 1000) - 1)}`,
            `${this.o.user}@${target.host}`,
            '--',
            remote
        ];
        const r = await this.o.runner('ssh', args, { timeoutMs: this.timeoutMs, maxOutputBytes: 256 * 1024 });
        const output = truncate([r.stdout, r.stderr, r.error ?? ''].filter(Boolean).join('\n').trim());
        return { target, ok: !r.timedOut && r.code === 0, timedOut: r.timedOut, code: r.code, output };
    }
}
