import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnRunner } from '../src/tools/commandRunner';

const NODE = process.execPath;

test('spawnRunner: captura stdout/stderr y código de salida sin lanzar', async () => {
    const r = await spawnRunner(NODE, ['-e', 'process.stdout.write("hola"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 5000 });
    assert.equal(r.stdout, 'hola');
    assert.equal(r.stderr, 'err');
    assert.equal(r.code, 3);
    assert.equal(r.timedOut, false);
});

test('spawnRunner: envía input por stdin', async () => {
    const r = await spawnRunner(NODE, ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'], {
        timeoutMs: 5000, input: 'prompt largo'
    });
    assert.equal(r.stdout, 'PROMPT LARGO');
    assert.equal(r.code, 0);
});

test('spawnRunner: timeout duro mata el proceso y marca timedOut (L3, sin colgar)', async () => {
    const t0 = Date.now();
    const r = await spawnRunner(NODE, ['-e', 'setTimeout(()=>{}, 20000)'], { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000);
});

test('spawnRunner: binario inexistente -> code null + error, sin excepción', async () => {
    const r = await spawnRunner('binario-que-no-existe-xrooster', [], { timeoutMs: 2000 });
    assert.equal(r.code, null);
    assert.ok(r.error);
});

test('spawnRunner: limita bytes de salida capturados', async () => {
    const r = await spawnRunner(NODE, ['-e', 'process.stdout.write("z".repeat(200000))'], { timeoutMs: 5000, maxOutputBytes: 1000 });
    assert.ok(r.stdout.length <= 1000);
});
