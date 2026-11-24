import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSnapshot, HEARTBEAT_TTL_SEC } from '../src/core/health';
import { RedisMonitoringSource, type RedisLike } from '../src/tools/monitoringSource';

const NOW = 1_763_980_000;

function byComponent(hash: Record<string, string>) {
    return Object.fromEntries(evaluateSnapshot(hash, NOW).map((h) => [h.component, h]));
}

test('heartbeat <= 90 s -> ok; > 90 s -> down; sin ts -> componente no monitoreado', () => {
    assert.equal(HEARTBEAT_TTL_SEC, 90);
    const h = byComponent({
        proxmox_ts: String(NOW - 30),
        xmanager_ts: String(NOW - 600),
        streamer_ts: String(NOW - 90)
    });
    assert.equal(h['proxmox']?.state, 'ok');
    assert.equal(h['xmanager']?.state, 'down');
    assert.match(h['xmanager']?.detail ?? '', /sin heartbeat/);
    assert.equal(h['streamer']?.state, 'ok');
    assert.equal(h['multicast'], undefined);
});

test('multicast/streamer online con canales caídos -> degraded', () => {
    const h = byComponent({
        multicast_ts: String(NOW - 10),
        multicast_errors: JSON.stringify({ active_channels: 40, down_channels: 3, total_channels: 43 }),
        streamer_ts: String(NOW - 10),
        streamer_errors: JSON.stringify({ active_channels: 10, down_channels: 0, cc_error_channels: 2 })
    });
    assert.equal(h['multicast']?.state, 'degraded');
    assert.match(h['multicast']?.detail ?? '', /3 canales caídos/);
    assert.equal(h['streamer']?.state, 'ok');
});

test('IRD: tuner sin lock -> down; señal baja -> degraded; sin datos -> no monitoreado', () => {
    const down = byComponent({ ird_summary: JSON.stringify({ tuners: [{ lock: 1, cn: 12, quality: 80, bitrate_total: 30 }, { lock: 0, cn: 0 }] }) });
    assert.equal(down['ird']?.state, 'down');
    const low = byComponent({ ird_summary: JSON.stringify({ tuners: [{ lock: 1, cn: 5, quality: 80, bitrate_total: 30 }] }) });
    assert.equal(low['ird']?.state, 'degraded');
    const ok = byComponent({ ird_summary: JSON.stringify({ tuners: [{ lock: 1, cn: 12, quality: 80, bitrate_total: 30, ber: '0.0E+00' }] }) });
    assert.equal(ok['ird']?.state, 'ok');
    assert.equal(byComponent({})['ird'], undefined);
    assert.equal(byComponent({ ird_summary: '{roto' })['ird'], undefined);
});

test('IRD: respeta signal_status explícito de xBackend', () => {
    assert.equal(byComponent({ ird_summary: JSON.stringify({ signal_status: 'red' }) })['ird']?.state, 'down');
    assert.equal(byComponent({ ird_summary: JSON.stringify({ signal_status: 'gray' }) })['ird'], undefined);
});

test('RedisMonitoringSource: SCAN monitoring:tenant:* paginado + HGETALL', async () => {
    const data: Record<string, Record<string, string>> = {
        'monitoring:tenant:43': { proxmox_ts: '1' },
        'monitoring:tenant:44': { xmanager_ts: '2' },
        'monitoring:tenant:abc': { proxmox_ts: '3' }
    };
    const scans: string[][] = [];
    const redis: RedisLike = {
        async scan(cursor, _m, pattern, _c, _n) {
            scans.push([cursor, pattern]);
            return cursor === '0' ? ['7', ['monitoring:tenant:43', 'monitoring:tenant:abc']] : ['0', ['monitoring:tenant:44']];
        },
        async hgetall(key) { return data[key] ?? {}; }
    };
    const src = new RedisMonitoringSource(redis);
    const snaps = await src.listSnapshots();
    assert.deepEqual(snaps.map((s) => s.position), ['43', '44']);
    assert.deepEqual(scans, [['0', 'monitoring:tenant:*'], ['7', 'monitoring:tenant:*']]);
    assert.deepEqual((await src.getSnapshot('43'))?.hash, { proxmox_ts: '1' });
    assert.equal(await src.getSnapshot('99'), null);
});
