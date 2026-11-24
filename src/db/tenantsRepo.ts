import { Pool } from 'pg';

/** Superficie mínima de consulta (compatible con pg.Pool) para poder inyectar dobles en tests. */
export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface TenantRecord {
    tenantid: string;
    name: string | null;
    position: string;
    status: string | null;
    options: Record<string, unknown>;
}

export interface TenantsLookup {
    find(ref: string): Promise<TenantRecord[]>;
    findByPosition(position: string): Promise<TenantRecord | null>;
}

/** "server43" / "#43" / "pos 43" -> "43"; nombre libre se conserva; vacío -> null. */
export function normalizeTenantRef(ref: string | null | undefined): string | null {
    const trimmed = String(ref ?? '').trim();
    if (!trimmed) return null;
    const m = /^(?:server|client|cliente|pos(?:ici[oó]n)?|#)\s*#?\s*(\d+)$/i.exec(trimmed);
    return m ? m[1]! : trimmed;
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Consulta read-only y 100% parametrizada sobre public.tenants (xBackend).
const FIND_SQL = `SELECT tenantid, name, position::text AS position, status, options,
       (position::text = $1 OR lower(tenantid) = lower($1) OR lower(tenantid) = lower('server' || $1)) AS exact
  FROM public.tenants
 WHERE position::text = $1
    OR lower(tenantid) = lower($1)
    OR lower(tenantid) = lower('server' || $1)
    OR name ILIKE $2
 ORDER BY exact DESC, position DESC
 LIMIT 10`;

interface Row extends TenantRecord { exact: boolean }

export class TenantsRepo implements TenantsLookup {
    constructor(private readonly db: Queryable) {}

    async find(ref: string): Promise<TenantRecord[]> {
        const key = normalizeTenantRef(ref);
        if (!key) return [];
        const { rows } = await this.db.query(FIND_SQL, [key, `%${escapeLike(key)}%`]);
        const all = rows as Row[];
        const exact = all.filter((r) => r.exact);
        return (exact.length > 0 ? exact : all).map(({ exact: _e, ...t }) => ({ ...t, options: t.options ?? {} }));
    }

    async findByPosition(position: string): Promise<TenantRecord | null> {
        const res = await this.find(position);
        return res.find((t) => t.position === String(position)) ?? null;
    }
}

/** Pool hacia PG_XSERVER_RO_URL forzando transacciones read-only a nivel de sesión (defensa en profundidad). */
export function createReadOnlyPool(connectionString: string): Pool {
    return new Pool({ connectionString, max: 3, options: '-c default_transaction_read_only=on' });
}
