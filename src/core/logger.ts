export interface Logger {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}

function line(level: string, msg: string, meta?: Record<string, unknown>): string {
    return JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ?? {}) });
}

/** Logger JSON-lines a stdout/stderr (consumible por `docker logs`). */
export const consoleLogger: Logger = {
    info: (m, meta) => console.log(line('info', m, meta)),
    warn: (m, meta) => console.warn(line('warn', m, meta)),
    error: (m, meta) => console.error(line('error', m, meta))
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
