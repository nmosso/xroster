import { spawn } from 'node:child_process';

export interface RunOptions {
    /** Timeout duro: al vencer se envía SIGKILL. */
    timeoutMs: number;
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Tope de bytes capturados por stream (default 1 MB). */
    maxOutputBytes?: number;
}

export interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: string;
}

/** Ejecuta un binario con argv explícito (nunca vía shell). Jamás lanza: devuelve el resultado tipado. */
export type CommandRunner = (cmd: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export const spawnRunner: CommandRunner = (cmd, args, opts) =>
    new Promise<RunResult>((resolve) => {
        const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const finish = (r: RunResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
        };

        const child = spawn(cmd, [...args], {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, opts.timeoutMs);

        child.stdout.setEncoding('utf8').on('data', (c: string) => {
            if (stdout.length < max) stdout = (stdout + c).slice(0, max);
        });
        child.stderr.setEncoding('utf8').on('data', (c: string) => {
            if (stderr.length < max) stderr = (stderr + c).slice(0, max);
        });
        child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, error: err.message }));
        child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));

        child.stdin.on('error', () => undefined);
        if (opts.input !== undefined) child.stdin.end(opts.input);
        else child.stdin.end();
    });
