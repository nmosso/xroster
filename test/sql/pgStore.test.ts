// npm run test:sql — aplica 001_init_xrosterdb.sql en una BD PostgreSQL EFÍMERA y corre el contrato de RosterStore.
// Requiere TEST_PG_URL con permisos de CREATE DATABASE (ej. postgres://postgres:postgres@localhost:5432/postgres).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { PgRosterStore, INIT_SQL_PATH } from '../../src/db/pgStore';
import { runStoreContract, approvalFixture } from '../storeContract';

const ADMIN_URL = process.env['TEST_PG_URL'];
const DB_NAME = `xroster_test_${randomBytes(4).toString('hex')}`;

function dbUrl(name: string): string {
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${name}`;
    return u.toString();
}

if (!ADMIN_URL) {
    test('test:sql requiere TEST_PG_URL', { skip: 'TEST_PG_URL no definido' }, () => {});
} else {
    const pools: Pool[] = [];

    before(async () => {
        const admin = new Client({ connectionString: ADMIN_URL });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${DB_NAME}`);
        await admin.end();
    });

    after(async () => {
        await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
        const admin = new Client({ connectionString: ADMIN_URL });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
        await admin.end();
    });

    async function freshStore(): Promise<PgRosterStore> {
        const pool = new Pool({ connectionString: dbUrl(DB_NAME), max: 2 });
        pools.push(pool);
        const store = new PgRosterStore(pool);
        await store.initSchema();
        await pool.query('TRUNCATE quota_usage_ledger, action_approvals, sentinel_alert_state, agent_audit_log, system_flags');
        // close() del contrato no debe cerrar el pool compartido del test.
        store.close = async () => {};
        return store;
    }

    test('DDL idempotente: se aplica dos veces sin error', async () => {
        const store = await freshStore();
        await store.initSchema();
        await store.initSchema();
    });

    test('DDL: 5 tablas, índices exactos de §5.1 y columnas JSONB', async () => {
        const store = await freshStore();
        const { rows: tables } = await store.pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
        );
        assert.deepEqual(tables.map((t) => t.table_name), ['action_approvals', 'agent_audit_log', 'quota_usage_ledger', 'sentinel_alert_state', 'system_flags']);

        const { rows: idx } = await store.pool.query<{ indexname: string; indexdef: string }>(
            `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`
        );
        const byName = new Map(idx.map((i) => [i.indexname, i.indexdef]));
        assert.match(byName.get('idx_quota_provider_created') ?? '', /\(provider, created_at DESC\)/);
        assert.match(byName.get('idx_quota_agent_created') ?? '', /\(agent_name, created_at DESC\)/);
        assert.match(byName.get('idx_approvals_status_expires') ?? '', /\(status, expires_at\)/);
        assert.match(byName.get('idx_sentinel_state_tenant') ?? '', /\(state, tenant_position\)/);
        assert.match(byName.get('idx_audit_created') ?? '', /\(created_at DESC\)/);
        assert.match(byName.get('idx_audit_metadata_gin') ?? '', /USING gin \(metadata\)/);

        const { rows: jsonb } = await store.pool.query<{ table_name: string; column_name: string }>(
            `SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND data_type = 'jsonb' ORDER BY table_name, column_name`
        );
        assert.deepEqual(jsonb.map((c) => `${c.table_name}.${c.column_name}`), [
            'action_approvals.payload', 'agent_audit_log.metadata', 'quota_usage_ledger.metadata', 'sentinel_alert_state.metrics'
        ]);
        const ddl = await readFile(INIT_SQL_PATH, 'utf8');
        assert.match(ddl, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    });

    test('TTL de approvals: expires_at = requested_at + 5 min y consulta de vencidas por índice', async () => {
        const store = await freshStore();
        const past = new Date(Date.now() - 10 * 60_000);
        await store.createApproval(approvalFixture('TK-777', past));
        const { rows } = await store.pool.query<{ ttl: number; expired: boolean }>(
            `SELECT EXTRACT(EPOCH FROM (expires_at - requested_at))::int AS ttl, expires_at < NOW() AS expired
               FROM action_approvals WHERE code = 'TK-777' AND status = 'pending'`
        );
        assert.equal(rows[0]?.ttl, 300);
        assert.equal(rows[0]?.expired, true);
    });

    runStoreContract('pg', freshStore);
}
