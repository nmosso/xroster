// Runner portable (Linux/Windows) para node:test + tsx: lista *.test.ts de un directorio sin depender de globs del shell.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2] ?? 'test';
const files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort()
    .map((f) => join(dir, f));

if (files.length === 0) {
    console.error(`[run-tests] sin archivos *.test.ts en ${dir}`);
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
