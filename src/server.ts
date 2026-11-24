import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseWebhookPayload, type WebhookPayload } from './core/webhook';
import { errorMessage, silentLogger, type Logger } from './core/logger';

export const WEBHOOK_PATH = '/internal/whatsapp/webhook';
const DEFAULT_MAX_BODY = 256 * 1024;

export interface ServerOptions {
    secret: string;
    /** Procesamiento asíncrono del mensaje; la respuesta HTTP no lo espera (xBackend tiene timeout de 3 s). */
    onMessage: (payload: WebhookPayload) => Promise<unknown>;
    logger?: Logger;
    maxBodyBytes?: number;
}

function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
    if (typeof provided !== 'string' || !expected) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
    res.end(json);
}

export function createServer(opts: ServerOptions): http.Server {
    const logger = opts.logger ?? silentLogger;
    const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

    return http.createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];

        if (req.method === 'GET' && path === '/health') {
            send(res, 200, { status: 'ok', service: 'xroster' });
            return;
        }
        if (req.method !== 'POST' || path !== WEBHOOK_PATH) {
            send(res, 404, { error: 'not_found' });
            return;
        }
        if (!secretMatches(req.headers['x-internal-secret'], opts.secret)) {
            req.resume();
            send(res, 401, { error: 'unauthorized' });
            return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBody) tooLarge = true;
            else chunks.push(c);
        });
        req.on('error', () => undefined);
        req.on('end', () => {
            if (tooLarge) {
                send(res, 413, { error: 'payload_too_large' });
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                send(res, 400, { error: 'invalid_json' });
                return;
            }
            const payload = parseWebhookPayload(parsed);
            if (!payload) {
                send(res, 400, { error: 'invalid_payload' });
                return;
            }
            send(res, 200, { accepted: true });
            setImmediate(() => {
                opts.onMessage(payload).catch((err: unknown) =>
                    logger.error('error procesando webhook', { message_id: payload.message_id, error: errorMessage(err) })
                );
            });
        });
    });
}
