import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TenantsRepo, normalizeTenantRef, type Queryable } from '../src/db/tenantsRepo';

interface Row { tenantid: string; name: string | null; position: string; status: string | null; options: Record<string, unknown>; exact: boolean }

function fakeDb(rows: Row[]): Queryable & { calls: { sql: string; params: unknown[] }[] } {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        async query(sql: string, params: unknown[] = []) {
            calls.push({ sql, params });
            return { rows };
        }
    };
}

const T43: Row = { tenantid: 'server43', name: 'Frentones', position: '43', status: 'enabled', options: {}, exact: true };
const T143: Row = { tenantid: 'server143', name: 'Frentones Norte', position: '143', status: 'enabled', options: {}, exact: false };

test('normalizeTenantRef: server43 / #43 / pos 43 -> 43; nombre se conserva', () => {
    assert.equal(normalizeTenantRef('server43'), '43');
    assert.equal(normalizeTenantRef(' #43 '), '43');
    assert.equal(normalizeTenantRef('pos 43'), '43');
    assert.equal(normalizeTenantRef('Frentones'), 'Frentones');
    assert.equal(normalizeTenantRef('   '), null);
});

test('find: consulta estrictamente read-only y parametrizada (sin interpolar input)', async () => {
    const db = fakeDb([T43]);
    const repo = new TenantsRepo(db);
    await repo.find("43'; DROP TABLE tenants;--");
    assert.equal(db.calls.length, 1);
    const { sql, params } = db.calls[0]!;
    assert.match(sql, /^\s*SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
    assert.doesNotMatch(sql, /DROP TABLE tenants/);
    assert.match(sql, /public\.tenants/);
    assert.match(sql, /'server'\s*\|\|\s*\$1/);
    assert.match(sql, /name ILIKE \$2/);
    assert.equal(params[0], "43'; DROP TABLE tenants;--");
});

test('find: prioriza coincidencias exactas (position/tenantid) sobre ILIKE', async () => {
    const repo = new TenantsRepo(fakeDb([T43, T143]));
    const res = await repo.find('43');
    assert.deepEqual(res.map((t) => t.tenantid), ['server43']);
    assert.equal(Object.hasOwn(res[0]!, 'exact'), false);
});

test('find: sin exactas devuelve los parciales por nombre y escapa comodines LIKE', async () => {
    const db = fakeDb([{ ...T143, exact: false }]);
    const res = await new TenantsRepo(db).find('Fren%_');
    assert.equal(res.length, 1);
    assert.equal(db.calls[0]!.params[1], '%Fren\\%\\_%');
});

test('find: ref vacía no consulta la BD', async () => {
    const db = fakeDb([T43]);
    assert.deepEqual(await new TenantsRepo(db).find('  '), []);
    assert.equal(db.calls.length, 0);
});

test('findByPosition: devuelve solo el tenant con esa position', async () => {
    const repo = new TenantsRepo(fakeDb([T43]));
    assert.equal((await repo.findByPosition('43'))?.name, 'Frentones');
    assert.equal(await new TenantsRepo(fakeDb([])).findByPosition('99'), null);
});
