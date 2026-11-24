// Autenticación de cpanel-roster (REQ-2026-013 RF-01/RF-02): cookie firmada HMAC-SHA256, comparación en
// tiempo constante, rate-limit de login en memoria y fail-closed si faltan credenciales.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { WebConfig } from '../config';

export const SESSION_COOKIE = 'xroster_session';
export const SESSION_TTL_SEC = 43_200; // 12 h
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

export interface Session {
    user: string;
    /** Epoch en segundos. */
    exp: number;
}

/** Igualdad en tiempo constante para strings de cualquier longitud (se comparan digests SHA-256). */
export function safeEqual(a: string, b: string): boolean {
    const da = createHash('sha256').update(a, 'utf8').digest();
    const db = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(da, db);
}

function hmac(payload: string, secret: string): Buffer {
    return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

/** Token `base64url(JSON).base64url(HMAC)`. */
export function signSession(s: Session, secret: string): string {
    const payload = Buffer.from(JSON.stringify({ user: s.user, exp: s.exp }), 'utf8').toString('base64url');
    return `${payload}.${hmac(payload, secret).toString('base64url')}`;
}

export function verifySession(token: string | undefined, secret: string, nowMs: number): Session | null {
    if (!token || !secret) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts as [string, string];
    if (!payload || !sig) return null;
    const expected = hmac(payload, secret);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let data: unknown;
    try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (typeof data !== 'object' || data === null) return null;
    const { user, exp } = data as Record<string, unknown>;
    if (typeof user !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (exp * 1000 <= nowMs) return null;
    return { user, exp };
}

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        const raw = part.slice(i + 1).trim();
        if (!k) continue;
        try {
            out[k] = decodeURIComponent(raw);
        } catch {
            out[k] = raw;
        }
    }
    return out;
}

export interface RateLimiterOptions {
    maxFailures?: number;
    windowMs?: number;
    /** Epoch ms. */
    clock?: () => number;
    /** Tope de IPs rastreadas (protección de memoria). */
    maxKeys?: number;
}

/** Ventana deslizante de fallos por clave (IP), en memoria. */
export class LoginRateLimiter {
    private readonly failures = new Map<string, number[]>();
    private readonly max: number;
    private readonly windowMs: number;
    private readonly clock: () => number;
    private readonly maxKeys: number;

    constructor(opts: RateLimiterOptions = {}) {
        this.max = opts.maxFailures ?? LOGIN_MAX_FAILURES;
        this.windowMs = opts.windowMs ?? LOGIN_WINDOW_MS;
        this.clock = opts.clock ?? Date.now;
        this.maxKeys = opts.maxKeys ?? 10_000;
    }

    private recent(key: string): number[] {
        const cutoff = this.clock() - this.windowMs;
        const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
        if (list.length === 0) this.failures.delete(key);
        else this.failures.set(key, list);
        return list;
    }

    isBlocked(key: string): boolean {
        return this.recent(key).length >= this.max;
    }

    fail(key: string): void {
        const list = this.recent(key);
        list.push(this.clock());
        this.failures.set(key, list);
        if (this.failures.size > this.maxKeys) {
            const oldest = this.failures.keys().next().value;
            if (oldest !== undefined) this.failures.delete(oldest);
        }
    }

    reset(key: string): void {
        this.failures.delete(key);
    }

    /** Claves con fallos vigentes (poda las vencidas). */
    size(): number {
        for (const k of [...this.failures.keys()]) this.recent(k);
        return this.failures.size;
    }
}

export type LoginResult =
    | { ok: true; cookie: string; session: Session }
    | { ok: false; reason: 'invalid' | 'rate_limited' | 'disabled' };

export interface WebAuthOptions {
    clock?: () => Date;
    limiter?: LoginRateLimiter;
}

export class WebAuth {
    private readonly clock: () => Date;
    private readonly limiter: LoginRateLimiter;

    constructor(private readonly cfg: WebConfig, opts: WebAuthOptions = {}) {
        this.clock = opts.clock ?? (() => new Date());
        this.limiter = opts.limiter ?? new LoginRateLimiter({ clock: () => this.clock().getTime() });
    }

    /** RF-01: sin password o secret la API web queda cerrada (503). */
    get configured(): boolean {
        return Boolean(this.cfg.password) && Boolean(this.cfg.sessionSecret);
    }

    login(ip: string, user: string, password: string): LoginResult {
        if (!this.configured) return { ok: false, reason: 'disabled' };
        if (this.limiter.isBlocked(ip)) return { ok: false, reason: 'rate_limited' };
        // Ambas comparaciones siempre se evalúan (sin cortocircuito) para no filtrar cuál falló por timing.
        const userOk = safeEqual(user, this.cfg.user);
        const passOk = safeEqual(password, this.cfg.password ?? '');
        if (!(userOk && passOk)) {
            this.limiter.fail(ip);
            return { ok: false, reason: 'invalid' };
        }
        this.limiter.reset(ip);
        const session: Session = { user: this.cfg.user, exp: Math.floor(this.clock().getTime() / 1000) + SESSION_TTL_SEC };
        const token = signSession(session, this.cfg.sessionSecret ?? '');
        return { ok: true, session, cookie: this.cookie(token, SESSION_TTL_SEC) };
    }

    sessionFromCookie(header: string | undefined): Session | null {
        if (!this.configured) return null;
        return verifySession(parseCookies(header)[SESSION_COOKIE], this.cfg.sessionSecret ?? '', this.clock().getTime());
    }

    logoutCookie(): string {
        return this.cookie('', 0);
    }

    private cookie(value: string, maxAge: number): string {
        const attrs = [`${SESSION_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
        if (this.cfg.cookieSecure) attrs.push('Secure');
        return attrs.join('; ');
    }
}

function isTrustedProxy(addr: string): boolean {
    const a = addr.replace(/^::ffff:/i, '');
    if (a === '::1' || /^127\./.test(a)) return true;
    if (/^10\./.test(a) || /^192\.168\./.test(a)) return true;
    const m = /^172\.(\d{1,3})\./.exec(a);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return /^f[cd][0-9a-f]{2}:/i.test(a);
}

/**
 * IP del cliente para el rate-limit. `X-Real-IP` (puesto por Nginx) solo se acepta si la conexión TCP viene
 * de loopback o red privada (Nginx del host / bridge Docker); desde cualquier otro origen sería falsificable.
 */
export function clientIp(req: { remoteAddress: string | undefined; headers: IncomingHttpHeaders }): string {
    const remote = req.remoteAddress;
    if (!remote) return 'unknown';
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && isTrustedProxy(remote) && isIP(real.trim())) return real.trim();
    return remote;
}
