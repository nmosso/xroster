import 'dotenv/config';
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
    else consoleLogger.error('xRooster no pudo iniciar', { error: errorMessage(err) });
    process.exit(1);
});
