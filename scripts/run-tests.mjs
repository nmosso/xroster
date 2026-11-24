// Runner portable (Linux/Windows) para node:test + tsx: lista *.test.ts de un directorio sin depender de globs del shell.
// Uso: node scripts/run-tests.mjs <dir> [filtro...] [--flag-de-node-test...]
//   filtro: substring del nombre de archivo (ej. `npm test -- auth --test-reporter=dot`).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [dir = 'test', ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const filters = rest.filter((a) => !a.startsWith('--'));
const files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
    .sort()
    .map((f) => join(dir, f));

if (files.length === 0) {
    console.error(`[run-tests] sin archivos *.test.ts en ${dir}${filters.length ? ` que coincidan con ${filters.join(', ')}` : ''}`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...flags, ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
