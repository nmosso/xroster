import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { truncate } from '../core/text';
import type { CommandRunner, RunResult } from './commandRunner';

export const DRAFTS_DIR = 'Cross_System/01_Borradores';
export const APPROVED_DIR = 'Cross_System/02_Aprobados';
export const UNSYNCED_WARNING = '⚠️ copia local sin sincronizar';

const DRAFT_BRANCH = /^draft\/shikamaru-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const DRAFT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;

export class PlanningUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanningUnavailableError';
    }
}

/** Solo ramas `draft/shikamaru-<slug>`; `main` (y cualquier otra) se bloquea en código. */
export function assertDraftBranch(branch: string): string {
    if (!DRAFT_BRANCH.test(String(branch))) {
        throw new Error(`Rama no permitida para Shikamaru: "${String(branch).slice(0, 60)}"`);
    }
    return branch;
}

/** Última barrera antes de `git push`: sin force/mirror/delete/all y destino exclusivamente refs/heads/draft/shikamaru-*. */
export function assertSafePushArgs(args: readonly string[]): void {
    const i = args.indexOf('push');
    if (i < 0) throw new Error('assertSafePushArgs: no es un push');
    const rest = args.slice(i + 1);
    if (rest.some((a) => a.startsWith('-'))) throw new Error(`push con flags no permitidos: ${rest.filter((a) => a.startsWith('-')).join(' ')}`);
    const refspecs = rest.slice(1);
    if (refspecs.length !== 1) throw new Error('push debe tener exactamente un refspec');
    const [src, dst] = refspecs[0]!.split(':');
    const strip = (r: string | undefined): string => String(r ?? '').replace(/^refs\/heads\//, '');
    assertDraftBranch(strip(dst ?? src));
    assertDraftBranch(strip(src));
}

export function slugify(title: string): string {
    const s = title
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-+$/g, '');
    return s || 'borrador';
}

export interface PlanningRepoOptions {
    runner: CommandRunner;
    localDir: string;
    repoUrl: string;
    branch?: string;
    token?: string;
    timeoutMs?: number;
    authorName?: string;
    authorEmail?: string;
}

export interface SyncResult {
    synced: boolean;
    warning?: string;
}

export interface DraftPublication {
    branch: string;
    fileName: string;
    content: string;
    commitMessage: string;
}

/** Clone local de xPlanning (`main`), sincronizado solo con fast-forward. */
export class PlanningRepo {
    readonly branch: string;
    private readonly root: string;

    constructor(private readonly o: PlanningRepoOptions) {
        this.branch = o.branch ?? 'main';
        this.root = resolve(o.localDir);
        if (this.branch !== 'main') throw new Error('XPLANNING_BRANCH debe ser main (Shikamaru solo lee main)');
    }

    hasLocalCopy(): boolean {
        return existsSync(join(this.root, '.git'));
    }

    private env(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (this.o.token) {
            const basic = Buffer.from(`x-access-token:${this.o.token}`).toString('base64');
            env['GIT_CONFIG_COUNT'] = '1';
            env['GIT_CONFIG_KEY_0'] = 'http.extraHeader';
            env['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${basic}`;
        }
        return env;
    }

    private git(args: string[], inRepo = true): Promise<RunResult> {
        return this.o.runner('git', inRepo ? ['-C', this.root, ...args] : args, { timeoutMs: this.o.timeoutMs ?? 60_000, env: this.env() });
    }

    private async gitOrThrow(args: string[]): Promise<RunResult> {
        const r = await this.git(args);
        if (r.timedOut || r.code !== 0) throw new Error(`git ${args[0]} falló: ${(r.stderr || r.error || `exit ${r.code}`).trim().slice(0, 200)}`);
        return r;
    }

    async sync(): Promise<SyncResult> {
        if (!this.hasLocalCopy()) {
            await mkdir(dirname(this.root), { recursive: true });
            const r = await this.git(['clone', '--branch', this.branch, '--single-branch', this.o.repoUrl, this.root], false);
            if (r.timedOut || r.code !== 0) {
                throw new PlanningUnavailableError(`Sin copia local de xPlanning y el clone falló: ${(r.stderr || r.error || '').trim().slice(0, 200)}`);
            }
            return { synced: true };
        }
        const co = await this.git(['checkout', this.branch]);
        const pull = co.code === 0 ? await this.git(['pull', '--ff-only', 'origin', this.branch]) : co;
        if (pull.timedOut || pull.code !== 0) return { synced: false, warning: UNSYNCED_WARNING };
        return { synced: true };
    }

    private safePath(rel: string): string | null {
        const p = resolve(this.root, rel);
        return p === this.root || p.startsWith(this.root + sep) ? p : null;
    }

    async readText(rel: string, maxChars = 12_000): Promise<string | null> {
        const p = this.safePath(rel);
        if (!p) return null;
        try {
            return truncate(await readFile(p, 'utf8'), maxChars);
        } catch {
            return null;
        }
    }

    async listMarkdown(rel: string): Promise<string[]> {
        const p = this.safePath(rel);
        if (!p) return [];
        try {
            return (await readdir(p)).filter((f) => f.endsWith('.md')).sort();
        } catch {
            return [];
        }
    }

    /** Crea rama draft, escribe en 01_Borradores, commit y push SOLO de esa rama. Siempre vuelve a main. */
    async publishDraft(d: DraftPublication): Promise<{ branch: string; path: string; commit: string }> {
        assertDraftBranch(d.branch);
        if (!DRAFT_FILE.test(d.fileName)) throw new Error(`Nombre de archivo de borrador inválido: "${d.fileName.slice(0, 60)}"`);
        const rel = `${DRAFTS_DIR}/${d.fileName}`;
        const abs = this.safePath(rel);
        if (!abs) throw new Error('Ruta de borrador inválida');

        try {
            await this.gitOrThrow(['checkout', this.branch]);
            await this.git(['pull', '--ff-only', 'origin', this.branch]);
            if (existsSync(abs)) throw new Error(`El borrador ${rel} ya existe en main`);
            await this.gitOrThrow(['checkout', '-B', d.branch]);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, d.content, 'utf8');
            await this.gitOrThrow(['add', '--', rel]);
            await this.gitOrThrow([
                '-c', `user.name=${this.o.authorName ?? 'Shikamaru (xRooster)'}`,
                '-c', `user.email=${this.o.authorEmail ?? 'shikamaru@xrooster.local'}`,
                'commit', '-m', d.commitMessage
            ]);
            const commit = (await this.git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
            const pushArgs = ['push', 'origin', `refs/heads/${d.branch}:refs/heads/${d.branch}`];
            assertSafePushArgs(pushArgs);
            await this.gitOrThrow(pushArgs);
            return { branch: d.branch, path: rel, commit };
        } finally {
            await this.git(['checkout', this.branch]);
        }
    }
}
