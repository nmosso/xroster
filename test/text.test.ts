import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { truncate, neutralize, MAX_TOOL_OUTPUT_CHARS } from '../src/core/text';

// El término prohibido se arma por partes para que este test no viole su propia regla.
const FORBIDDEN = ['as', 'tra'].join('');

test('truncate: salida de 50 KB queda en <= 4000 chars con marca de truncado', () => {
    const big = 'x'.repeat(50 * 1024);
    const out = truncate(big);
    assert.ok(out.length <= MAX_TOOL_OUTPUT_CHARS, `len=${out.length}`);
    assert.equal(MAX_TOOL_OUTPUT_CHARS, 4000);
    assert.match(out, /truncado/);
});

test('truncate: texto corto no se modifica', () => {
    assert.equal(truncate('hola'), 'hola');
    assert.equal(truncate('abcdef', 10), 'abcdef');
});

test('truncate: respeta límite custom', () => {
    assert.ok(truncate('y'.repeat(500), 100).length <= 100);
});

test('neutralize (No-Astra): reemplaza el término prohibido y su variante server por término neutro', () => {
    const raw = `systemctl status ${FORBIDDEN}; ${FORBIDDEN.toUpperCase()}SERVER ok; Cesbo ${FORBIDDEN[0]!.toUpperCase()}${FORBIDDEN.slice(1)}`;
    const out = neutralize(raw);
    assert.doesNotMatch(out, new RegExp(FORBIDDEN, 'i'));
    assert.match(out, /Servidor de Streaming/);
});

test('neutralize: texto limpio queda igual (no rompe palabras que contienen la secuencia)', () => {
    assert.equal(neutralize('Streamer activo'), 'Streamer activo');
    assert.equal(neutralize('arrastrar'), 'arrastrar');
});

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

test('Regla No-Astra: cero menciones del término prohibido en src/ y sql/', () => {
    const root = join(__dirname, '..');
    const files = [...walk(join(root, 'src')), ...walk(join(root, 'sql'))];
    const offenders = files.filter((f) => new RegExp(FORBIDDEN, 'i').test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
});

test('Regla No-Astra (RF-07): cero menciones del término prohibido en el frontend web/src/ e index.html', () => {
    const root = join(__dirname, '..');
    const webSrc = join(root, 'web', 'src');
    assert.ok(existsSync(webSrc), 'web/src/ debe existir (cpanel-roster)');
    const files = [...walk(webSrc), join(root, 'web', 'index.html')].filter((f) => existsSync(f));
    assert.ok(files.length > 0, 'web/src/ no puede estar vacío');
    const offenders = files.filter((f) => new RegExp(FORBIDDEN, 'i').test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
});
