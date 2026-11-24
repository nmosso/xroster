// API REST de cpanel-roster (REQ-2026-013 §3.1). Todas las rutas exigen sesión salvo POST /api/auth/login;
// sin credenciales configuradas la API entera responde 503 (fail-closed, RF-01).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AlertStateFilter, AuditStatus, ProviderUsage, RosterStore } from '../db/store';
import {
    FLAG_PAUSED, FLAG_SILENCED_ALL_UNTIL, QUOTA_RANGES, clampLimit, clampOffset, isQuotaRange, tenantSilenceFlag
} from '../db/store';
import type { ApprovalManager } from '../core/approvals';
import { normalizeCode } from '../core/approvals';
import { SIGNATURES, type SentinelControl } from '../core/jarvis';
import { errorMessage, silentLogger, type Logger } from '../core/logger';
import { LOGIN_WINDOW_MS, clientIp, type Session, type WebAuth } from './auth';

export type HealthState = 'up' | 'down';
export type Probe = () => Promise<boolean>;

export interface ApiDeps {
    auth: WebAuth;
    store: RosterStore;
    approvals: Pick<ApprovalManager, 'confirm' | 'cancel'>;
    sentinel: SentinelControl;
    /** Aviso al War Room (EvolutionClient con guardrail de destino). */
    notify: (text: string) => Promise<void>;
    probes?: { redis?: Probe; evolution?: Probe };
    probeTimeoutMs?: number;
    clock?: () => Date;
    logger?: Logger;
    maxBodyBytes?: number;
}

export interface AgentInfo {
    name: string;
    role: string;
    phase: 'F1' | 'F2' | 'F3';
    active: boolean;
}

/** Roster visual (RFC-2026-003 §3): F1 activos; F2/F3 "Próximamente". */
export const AGENT_ROSTER: readonly AgentInfo[] = [
    { name: 'Jarvis', role: 'Orquestador del War Room', phase: 'F1', active: true },
    { name: 'Sentinel', role: 'QoS y alertas proactivas', phase: 'F1', active: true },
    { name: 'Tank', role: 'Infraestructura y hardware', phase: 'F1', active: true },
    { name: 'Shikamaru', role: 'Planificación SDD', phase: 'F1', active: true },
    { name: 'Axelrod', role: 'Cuotas, capacidad y modelos', phase: 'F2', active: false },
    { name: 'Atlas', role: 'PM y operaciones', phase: 'F2', active: false },
    { name: 'Skipper', role: 'Despliegues y releases', phase: 'F3', active: false }
];

export const MAX_SILENCE_MINUTES_WEB = 10_080; // 7 días
const ALERT_STATES: readonly AlertStateFilter[] = ['all', 'down', 'degraded', 'ok'];
const AUDIT_STATUSES: readonly AuditStatus[] = ['processing', 'ok', 'ignored', 'error', 'unauthorized'];
const DEFAULT_MAX_BODY = 16 * 1024;
const MAX_FIELD = 256;
const MAX_SEARCH = 100;
const HOUR_MS = 3600_000;
const PENDING_PREVIEW = 5;

class HttpError extends Error {
    constructor(readonly status: number, readonly code: string, readonly headers: Record<string, string> = {}) {
        super(code);
    }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(json)),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers
    });
    res.end(json);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.startsWith('application/json')) {
        req.resume();
        throw new HttpError(415, 'unsupported_media_type');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const c = chunk as Buffer;
        size += c.length;
        if (size > maxBytes) throw new HttpError(413, 'payload_too_large');
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new HttpError(400, 'invalid_json');
    }
}

function asObject(v: unknown): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'invalid_body');
    return v as Record<string, unknown>;
}

/** Defensa CSRF complementaria a SameSite=Lax: si hay Origin, debe coincidir con Host. */
function assertSameOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin) return;
    let host: string;
    try {
        host = new URL(origin).host;
    } catch {
        throw new HttpError(403, 'forbidden_origin');
    }
    if (host !== req.headers.host) throw new HttpError(403, 'forbidden_origin');
}

function intParam(v: string | null, def: number): number {
    if (v === null || v.trim() === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function searchParam(v: string | null): string | undefined {
    const s = (v ?? '').trim().slice(0, MAX_SEARCH);
    return s || undefined;
}

async function withTimeout(p: Probe | undefined, ms: number): Promise<HealthState> {
    if (!p) return 'down';
    let timer: NodeJS.Timeout | undefined;
    try {
        const ok = await Promise.race([
            p(),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })
        ]);
        return ok ? 'up' : 'down';
    } catch {
        return 'down';
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function parseFutureDate(v: string | null, now: Date): string | null {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) || d.getTime() <= now.getTime() ? null : d.toISOString();
}

type Route = (ctx: { req: IncomingMessage; res: ServerResponse; url: URL; session: Session; params: string[] }) => Promise<void>;

export function createApiRouter(d: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const clock = d.clock ?? (() => new Date());
    const logger = d.logger ?? silentLogger;
    const maxBody = d.maxBodyBytes ?? DEFAULT_MAX_BODY;
    const probeTimeout = d.probeTimeoutMs ?? 3000;
    const s = d.store;

    /** Tolerancia a fallos por sección del dashboard (L3): una dependencia caída no rompe la respuesta. */
    async function safe<T>(label: string, fn: () => Promise<T>, fallback: T, failed?: { value: boolean }): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            if (failed) failed.value = true;
            logger.warn(`overview: ${label} no disponible`, { error: errorMessage(err) });
            return fallback;
        }
    }

    const routes: { method: string; pattern: RegExp; handler: Route }[] = [];
    const on = (method: string, pattern: RegExp, handler: Route): void => { routes.push({ method, pattern, handler }); };

    // ---------------- Auth ----------------
    on('GET', /^\/api\/auth\/me$/, async ({ res, session }) => {
        sendJson(res, 200, { user: session.user, expires_at: new Date(session.exp * 1000).toISOString() });
    });
    on('POST', /^\/api\/auth\/logout$/, async ({ req, res }) => {
        await readJson(req, maxBody);
        sendJson(res, 200, { ok: true }, { 'set-cookie': d.auth.logoutCookie() });
    });

    // ---------------- Overview / control ----------------
    on('GET', /^\/api\/overview$/, async ({ res }) => {
        const now = clock();
        const dbFailed = { value: false };
        const empty: ProviderUsage[] = [];
        const [redis, evolution, paused, silencedAll, alertsActive, approvalsPending, pending, last5h, last24h] = await Promise.all([
            withTimeout(d.probes?.redis, probeTimeout),
            withTimeout(d.probes?.evolution, probeTimeout),
            safe('paused', () => s.getFlag(FLAG_PAUSED), null, dbFailed),
            safe('silence', () => s.getFlag(FLAG_SILENCED_ALL_UNTIL), null, dbFailed),
            safe('alerts', () => d.sentinel.activeAlertCount(), 0, dbFailed),
            safe('approvals', () => s.countApprovals('pending'), 0, dbFailed),
            safe('pending', () => s.listApprovals({ status: 'pending', limit: PENDING_PREVIEW }), [], dbFailed),
            safe('quota5h', () => s.aggregateQuota(new Date(now.getTime() - 5 * HOUR_MS)), empty, dbFailed),
            safe('quota24h', () => s.aggregateQuota(new Date(now.getTime() - 24 * HOUR_MS)), empty, dbFailed)
        ]);
        sendJson(res, 200, {
            generated_at: now.toISOString(),
            health: { xrosterdb: dbFailed.value ? 'down' : 'up', redis, evolution },
            paused: paused === 'true',
            sentinel_silenced_all_until: parseFutureDate(silencedAll, now),
            agents: AGENT_ROSTER,
            alerts_active: alertsActive,
            approvals_pending: approvalsPending,
            pending_approvals: pending,
            quotas: { last5h, last24h }
        });
    });

    on('PUT', /^\/api\/control\/pause$/, async ({ req, res, session }) => {
        const body = asObject(await readJson(req, maxBody));
        if (typeof body['paused'] !== 'boolean') throw new HttpError(400, 'paused_must_be_boolean');
        await s.setFlag(FLAG_PAUSED, body['paused'] ? 'true' : 'false');
        logger.info('cpanel-roster: pausa', { paused: body['paused'], user: session.user });
        sendJson(res, 200, { paused: body['paused'] });
    });

    // ---------------- Cuotas ----------------
    on('GET', /^\/api\/quotas$/, async ({ res, url }) => {
        const range = url.searchParams.get('range');
        if (!isQuotaRange(range)) throw new HttpError(400, 'invalid_range');
        const { ms, bucket } = QUOTA_RANGES[range];
        const now = clock();
        const since = new Date(now.getTime() - ms);
        const report = await s.quotaReport(since, bucket);
        sendJson(res, 200, { range, bucket, since: since.toISOString(), generated_at: now.toISOString(), ...report });
    });

    // ---------------- Alertas ----------------
    on('GET', /^\/api\/alerts$/, async ({ res, url }) => {
        const state = (url.searchParams.get('state') ?? 'all') as AlertStateFilter;
        if (!ALERT_STATES.includes(state)) throw new HttpError(400, 'invalid_state');
        const search = searchParam(url.searchParams.get('search'));
        const now = clock();
        const [alerts, silencedAll] = await Promise.all([
            s.listAlerts({ state, ...(search ? { search } : {}) }),
            s.getFlag(FLAG_SILENCED_ALL_UNTIL)
        ]);
        sendJson(res, 200, { server_time: now.toISOString(), silenced_all_until: parseFutureDate(silencedAll, now), alerts });
    });

    on('POST', /^\/api\/alerts\/silence$/, async ({ req, res, session }) => {
        const body = asObject(await readJson(req, maxBody));
        const target = body['target'];
        const minutes = body['minutes'];
        if (typeof target !== 'string' || !(target === 'all' || /^\d{1,6}$/.test(target))) throw new HttpError(400, 'invalid_target');
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SILENCE_MINUTES_WEB) {
            throw new HttpError(400, 'invalid_minutes');
        }
        let until: string | null = null;
        let message: string;
        if (minutes === 0) {
            if (target === 'all') {
                await s.deleteFlag(FLAG_SILENCED_ALL_UNTIL);
                message = '🔔 Silencio global retirado.';
            } else {
                await s.deleteFlag(tenantSilenceFlag(target));
                await s.setTenantSilence(target, null);
                message = `🔔 Silencio del tenant ${target} retirado.`;
            }
        } else {
            message = await d.sentinel.silence(target, minutes);
            until = new Date(clock().getTime() + minutes * 60_000).toISOString();
        }
        logger.info('cpanel-roster: silencio', { target, minutes, user: session.user });
        sendJson(res, 200, { target, minutes, until, message });
    });

    // ---------------- Approvals ----------------
    on('GET', /^\/api\/approvals$/, async ({ res, url }) => {
        const status = url.searchParams.get('status') ?? 'pending';
        if (status !== 'pending' && status !== 'all') throw new HttpError(400, 'invalid_status');
        const limit = clampLimit(intParam(url.searchParams.get('limit'), 50));
        const approvals = await s.listApprovals({ status, limit });
        sendJson(res, 200, { server_time: clock().toISOString(), status, limit, approvals });
    });

    on('POST', /^\/api\/approvals\/([^/]+)\/(confirm|cancel)$/, async ({ req, res, session, params }) => {
        await readJson(req, maxBody);
        let raw: string;
        try {
            raw = decodeURIComponent(params[0] ?? '');
        } catch {
            throw new HttpError(400, 'invalid_code');
        }
        const code = normalizeCode(raw);
        if (!code) throw new HttpError(400, 'invalid_code');
        const before = await s.getApproval(code);
        if (!before) throw new HttpError(404, 'approval_not_found');

        const action = params[1] === 'confirm' ? 'confirm' : 'cancel';
        // Mismo ApprovalManager que WhatsApp: compare-and-set idempotente + TTL 5 min.
        const message = action === 'confirm' ? await d.approvals.confirm(code) : await d.approvals.cancel(code);
        const after = await s.getApproval(code);
        const status = after?.status ?? before.status;
        const resolved = before.status === 'pending' && status !== 'pending';

        let notified = false;
        if (resolved) {
            const verb = action === 'confirm' ? 'CONFIRMAR' : 'CANCELAR';
            try {
                await d.notify(`${SIGNATURES.jarvis}\n🖥️ ${verb} ${code} desde cpanel-roster (${session.user}):\n${message}`);
                notified = true;
            } catch (err) {
                // L3: la acción ya se resolvió; el fallo de Evolution no la revierte ni devuelve 500.
                logger.warn('cpanel-roster: no se pudo avisar al War Room', { code, error: errorMessage(err) });
            }
        }
        logger.info('cpanel-roster: approval', { code, action, status, user: session.user });
        sendJson(res, 200, { code, action, status, resolved, notified, message });
    });

    // ---------------- Auditoría ----------------
    on('GET', /^\/api\/audit$/, async ({ res, url }) => {
        const statusRaw = (url.searchParams.get('status') ?? '').trim();
        if (statusRaw && !AUDIT_STATUSES.includes(statusRaw as AuditStatus)) throw new HttpError(400, 'invalid_status');
        const agent = (url.searchParams.get('agent') ?? '').trim().slice(0, 40).toLowerCase();
        const search = searchParam(url.searchParams.get('search'));
        const limit = clampLimit(intParam(url.searchParams.get('limit'), 50));
        const offset = clampOffset(intParam(url.searchParams.get('offset'), 0));
        const page = await s.listAudit({
            limit, offset,
            ...(agent ? { agent } : {}),
            ...(statusRaw ? { status: statusRaw as AuditStatus } : {}),
            ...(search ? { search } : {})
        });
        sendJson(res, 200, { total: page.total, limit, offset, rows: page.rows });
    });

    async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = asObject(await readJson(req, maxBody));
        const user = body['user'];
        const password = body['password'];
        if (typeof user !== 'string' || typeof password !== 'string' || user.length > MAX_FIELD || password.length > MAX_FIELD) {
            throw new HttpError(400, 'invalid_credentials_format');
        }
        const ip = clientIp({ remoteAddress: req.socket.remoteAddress, headers: req.headers });
        const r = d.auth.login(ip, user, password);
        if (r.ok) {
            logger.info('cpanel-roster: login', { user: r.session.user, ip });
            sendJson(res, 200, { user: r.session.user, expires_at: new Date(r.session.exp * 1000).toISOString() }, { 'set-cookie': r.cookie });
            return;
        }
        if (r.reason === 'rate_limited') {
            logger.warn('cpanel-roster: login bloqueado por rate-limit', { ip });
            throw new HttpError(429, 'too_many_attempts', { 'retry-after': String(LOGIN_WINDOW_MS / 1000) });
        }
        logger.warn('cpanel-roster: login inválido', { ip });
        throw new HttpError(401, 'invalid_credentials');
    }

    return async (req, res) => {
        try {
            if (!d.auth.configured) throw new HttpError(503, 'web_auth_not_configured');
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.replace(/\/+$/, '') || '/';
            const method = req.method ?? 'GET';
            if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

            if (path === '/api/auth/login') {
                if (method !== 'POST') throw new HttpError(405, 'method_not_allowed');
                await login(req, res);
                return;
            }
            const session = d.auth.sessionFromCookie(req.headers.cookie);
            if (!session) throw new HttpError(401, 'unauthorized');

            let pathMatched = false;
            for (const r of routes) {
                const m = r.pattern.exec(path);
                if (!m) continue;
                pathMatched = true;
                if (r.method !== method) continue;
                await r.handler({ req, res, url, session, params: m.slice(1) });
                return;
            }
            throw pathMatched ? new HttpError(405, 'method_not_allowed') : new HttpError(404, 'not_found');
        } catch (err) {
            if (err instanceof HttpError) {
                if (!req.readableEnded) req.resume();
                sendJson(res, err.status, { error: err.code }, err.headers);
                return;
            }
            throw err;
        }
    };
}
