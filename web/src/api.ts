// Cliente REST de cpanel-roster: fetch nativo, cookie HttpOnly (credentials same-origin), sin tokens en storage.
import type {
    AlertStateFilter, AlertsResponse, ApprovalActionResponse, ApprovalsResponse, AuditPage, AuditStatus,
    Overview, QuotaRange, QuotaReport, SessionInfo, SilenceResponse
} from './types';

export class ApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
        super(code);
    }
}

let onUnauthorized: () => void = () => undefined;

/** Registra el handler global para 401 (sesión ausente o expirada → Login). */
export function setUnauthorizedHandler(fn: () => void): void {
    onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PUT';

async function request<T>(method: Method, path: string, body?: unknown, opts: { skip401?: boolean } = {}): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (method !== 'GET') {
        // El backend exige application/json en toda ruta con body (incluso vacío).
        init.headers = { accept: 'application/json', 'content-type': 'application/json' };
        init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
        res = await fetch(path, init);
    } catch {
        throw new ApiError(0, 'network_error');
    }
    let data: unknown = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    if (!res.ok) {
        const code = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : `http_${res.status}`;
        if (res.status === 401 && !opts.skip401) onUnauthorized();
        throw new ApiError(res.status, code);
    }
    return data as T;
}

function qs(params: Record<string, string | number | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : '';
}

export const api = {
    me: () => request<SessionInfo>('GET', '/api/auth/me', undefined, { skip401: true }),
    login: (user: string, password: string) => request<SessionInfo>('POST', '/api/auth/login', { user, password }, { skip401: true }),
    logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),

    overview: () => request<Overview>('GET', '/api/overview'),
    setPaused: (paused: boolean) => request<{ paused: boolean }>('PUT', '/api/control/pause', { paused }),

    quotas: (range: QuotaRange) => request<QuotaReport>('GET', `/api/quotas${qs({ range })}`),

    alerts: (state: AlertStateFilter, search: string) => request<AlertsResponse>('GET', `/api/alerts${qs({ state, search })}`),
    silence: (target: string, minutes: number) => request<SilenceResponse>('POST', '/api/alerts/silence', { target, minutes }),

    approvals: (status: 'pending' | 'all', limit = 50) => request<ApprovalsResponse>('GET', `/api/approvals${qs({ status, limit })}`),
    decide: (code: string, action: 'confirm' | 'cancel') =>
        request<ApprovalActionResponse>('POST', `/api/approvals/${encodeURIComponent(code)}/${action}`),

    audit: (f: { agent?: string; status?: AuditStatus | ''; search?: string; limit: number; offset: number }) =>
        request<AuditPage>('GET', `/api/audit${qs({ agent: f.agent, status: f.status, search: f.search, limit: f.limit, offset: f.offset })}`)
};

const MESSAGES: Record<string, string> = {
    network_error: 'Sin conexión con xRoster. Revisá la red y reintentá.',
    invalid_credentials: 'Usuario o contraseña incorrectos.',
    too_many_attempts: 'Demasiados intentos fallidos. Esperá 15 minutos antes de reintentar.',
    web_auth_not_configured: 'El panel está deshabilitado: falta ROSTER_WEB_PASSWORD o ROSTER_SESSION_SECRET en el servidor.',
    approval_not_found: 'La solicitud ya no existe.',
    invalid_range: 'Rango de tiempo inválido.',
    invalid_minutes: 'Duración de silencio inválida.',
    forbidden_origin: 'Origen no permitido para esta acción.',
    unauthorized: 'La sesión expiró. Volvé a ingresar.'
};

export function errorText(err: unknown): string {
    if (err instanceof ApiError) return MESSAGES[err.code] ?? `Error ${err.status || ''} (${err.code}).`;
    return 'Error inesperado.';
}
