import path from 'node:path';
import dotenv from 'dotenv';

// El archivo de entorno vive fuera del repo (../.env.roster) para que `git pull` no lo sobrescriba.
// dotenv no pisa variables ya presentes en process.env (las inyectadas por Docker/entorno ganan).
// Si el archivo no existe (p. ej. dentro del contenedor), se continúa con process.env tal cual.
dotenv.config({ path: process.env.XROSTER_ENV_FILE || path.resolve(process.cwd(), '../.env.roster') });

import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { consoleLogger, errorMessage } from './core/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
    const cfg = loadConfig(process.env);
    const app = createApp(cfg, { logger: consoleLogger });

    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        consoleLogger.info('señal recibida, cerrando', { signal });
        const force = setTimeout(() => {
            consoleLogger.error('shutdown excedió el timeout, forzando salida');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        force.unref();
        app.stop().then(() => process.exit(0), (err: unknown) => {
            consoleLogger.error('error en shutdown', { error: errorMessage(err) });
            process.exit(1);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('unhandledRejection', (reason) => consoleLogger.error('unhandledRejection', { error: errorMessage(reason) }));

    await app.start();
}

main().catch((err: unknown) => {
    if (err instanceof ConfigError) consoleLogger.error(err.message);
    else consoleLogger.error('xRoster no pudo iniciar', { error: errorMessage(err) });
    process.exit(1);
});
