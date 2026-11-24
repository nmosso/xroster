import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRosterStore } from '../src/db/memoryStore';
import { runStoreContract } from './storeContract';

runStoreContract('memory', async () => {
    const s = new MemoryRosterStore();
    await s.initSchema();
    return s;
});

test('[memory] los objetos devueltos son copias (sin aliasing con el estado interno)', async () => {
    const s = new MemoryRosterStore();
    await s.createApproval({
        code: 'TK-100', agent_name: 'tank', action_type: 'restart_service', target_tenant: '1', summary_text: 'x',
        payload: { a: 1 }, requested_at: new Date(0), expires_at: new Date(300_000)
    });
    const a = await s.getApproval('TK-100');
    a!.payload['a'] = 2;
    a!.status = 'executed';
    const b = await s.getApproval('TK-100');
    assert.deepEqual(b!.payload, { a: 1 });
    assert.equal(b!.status, 'pending');
});
