import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseWebhookPayload, type WebhookPayload } from './core/webhook';
import { errorMessage, silentLogger, type Logger } from './core/logger';

export const WEBHOOK_PATH = '/internal/whatsapp/webhook';
const DEFAULT_MAX_BODY = 256 * 1024;

export type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export interface ServerOptions {
    secret: string;
    /** Procesamiento asíncrono del mensaje; la respuesta HTTP no lo espera (xBackend tiene timeout de 3 s). */
    onMessage: (payload: WebhookPayload) => Promise<unknown>;
    /** API web de cpanel-roster (`/api/*`). Sin handler → 404. */
    api?: HttpHandler;
    /** Directorio del SPA compilado (`dist/web`). Sin directorio → 404 para rutas no-API. */
    staticDir?: string | null;
    logger?: Logger;
    maxBodyBytes?: number;
}

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json'
};
/** Archivos de la raíz de dist/web servibles. Allí también viven los módulos backend compilados (src/web → dist/web): nunca se sirven. */
const ROOT_PUBLIC_EXT = new Set(['.svg', '.png', '.ico', '.webp', '.txt', '.webmanifest']);

const SECURITY_HEADERS: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin'
};
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

async function isFile(p: string): Promise<boolean> {
    try {
        return (await stat(p)).isFile();
    } catch {
        return false;
    }
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, headers: Record<string, string>): void {
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', ...SECURITY_HEADERS, ...headers });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    const stream = createReadStream(file).on('error', () => res.destroy());
    res.on('close', () => stream.destroy()); // cliente que corta la conexión no debe dejar el descriptor abierto
    stream.pipe(res);
}

/** RF-07: estáticos del SPA + fallback a index.html (las rutas reservadas se filtran antes de llamar). */
async function serveSpa(req: http.IncomingMessage, res: http.ServerResponse, dir: string, path: string): Promise<void> {
    let decoded: string | null;
    try {
        decoded = decodeURIComponent(path);
    } catch {
        decoded = null;
    }
    const segments = decoded && !decoded.includes('\0') ? decoded.split('/').filter(Boolean) : [];
    const safe = decoded !== null && segments.every((s) => s !== '.' && s !== '..' && !s.includes('\\'));
    if (safe && segments.length > 0) {
        const isAsset = segments[0] === 'assets' && segments.length >= 2;
        const isRootPublic = segments.length === 1 && ROOT_PUBLIC_EXT.has(extname(segments[0]!).toLowerCase());
        if (isAsset || isRootPublic) {
            const file = join(dir, ...segments);
            if (await isFile(file)) {
                sendFile(req, res, file, { 'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
                return;
            }
            if (isAsset) {
                send(res, 404, { error: 'not_found' });
                return;
            }
        }
    }
    const index = join(dir, 'index.html');
    if (!(await isFile(index))) {
        send(res, 404, { error: 'not_found' });
        return;
    }
    sendFile(req, res, index, { 'cache-control': 'no-cache', 'content-security-policy': HTML_CSP });
}

function isReservedPath(path: string): boolean {
    return path === '/api' || path.startsWith('/api/') || path === '/internal' || path.startsWith('/internal/') || path === '/health';
}

function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
    if (typeof provided !== 'string' || !expected) return false;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

export function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)), ...headers });
    res.end(json);
}

export function createServer(opts: ServerOptions): http.Server {
    const logger = opts.logger ?? silentLogger;
    const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

    return http.createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';

        if (req.method === 'GET' && path === '/health') {
            send(res, 200, { status: 'ok', service: 'xroster' });
            return;
        }
        if (opts.api && (path === '/api' || path.startsWith('/api/'))) {
            opts.api(req, res).catch((err: unknown) => {
                logger.error('error en API web', { path, error: errorMessage(err) });
                if (!res.headersSent) send(res, 500, { error: 'internal' });
                else res.destroy();
            });
            return;
        }
        if (opts.staticDir && (req.method === 'GET' || req.method === 'HEAD') && !isReservedPath(path)) {
            const dir = opts.staticDir;
            serveSpa(req, res, dir, path).catch((err: unknown) => {
                logger.error('error sirviendo SPA', { path, error: errorMessage(err) });
                if (!res.headersSent) send(res, 500, { error: 'internal' });
            });
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
