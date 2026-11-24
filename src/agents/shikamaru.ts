import type { Approval } from '../db/store';
import type { ApprovalManager } from '../core/approvals';
import type { AgentRequest, SpecialistAgent } from '../core/jarvis';
import { silentLogger, type Logger } from '../core/logger';
import { truncate } from '../core/text';
import type { ProviderRouter } from '../providers/providerRouter';
import {
    APPROVED_DIR, DRAFTS_DIR, PlanningUnavailableError, assertDraftBranch, slugify, type PlanningRepo
} from '../tools/planningRepo';

const DRAFT_INTENT = /(?<![\p{L}])(cre[aá]\p{L}*|gener[aá]\p{L}*|redact[aá]\p{L}*|arm[aá]\p{L}*|escrib[ií]\p{L}*|propon[eé]\p{L}*)(?![\p{L}])[\s\S]*\b(borrador|draft)\b/iu;
const DOC_ID = /\b((?:REQ|RFC|ADR)-\d{4}-\d{3})\b/gi;
const MAX_REPLY = 3500;

const ANSWER_SYSTEM = [
    'Sos Shikamaru, arquitecto y planificador SDD del ecosistema xIPTV.',
    'Respondé en español, conciso (máx. 15 líneas), citando los documentos del contexto (ID y carpeta).',
    'Si el contexto no alcanza, decilo; no inventes. Aplicá los filtros doctrinales (simplicidad, contratos estrictos, resiliencia).',
    'Terminología neutra obligatoria: usá "Servidor de Streaming" o "Encoder" para software de transmisión de terceros.'
].join(' ');

const DRAFT_SYSTEM = [
    'Generá un BORRADOR SDD en Markdown para la carpeta Cross_System/01_Borradores de xPlanning.',
    'La primera línea DEBE ser "# <Título>". Seguí la estructura de los REQ aprobados: metadatos, resumen, filtro doctrinal,',
    'alcance, requerimientos EARS, contratos, pruebas L1/L2/L3 y tareas atómicas. Estado: 01_Borrador.',
    'Terminología neutra obligatoria: "Servidor de Streaming" / "Encoder" para software de transmisión de terceros. Solo devolvé el Markdown.'
].join(' ');

export interface ShikamaruOptions {
    repo: PlanningRepo;
    router: ProviderRouter;
    approvals: ApprovalManager;
    clock?: () => Date;
    logger?: Logger;
}

export class Shikamaru implements SpecialistAgent {
    readonly name = 'shikamaru' as const;
    private readonly clock: () => Date;
    private readonly logger: Logger;

    constructor(private readonly o: ShikamaruOptions) {
        this.clock = o.clock ?? (() => new Date());
        this.logger = o.logger ?? silentLogger;
        o.approvals.register('git_push_draft', (a) => this.executeDraft(a));
    }

    async handle(req: AgentRequest): Promise<string> {
        let warning: string | undefined;
        try {
            warning = (await this.o.repo.sync()).warning;
        } catch (err) {
            if (err instanceof PlanningUnavailableError) return `⚠️ No hay copia local de xPlanning y no se pudo clonar el repositorio. ${err.message}`;
            throw err;
        }
        if (warning) this.logger.warn('Shikamaru: git pull falló, usando copia local');
        const body = DRAFT_INTENT.test(req.text) ? await this.proposeDraft(req) : await this.answer(req);
        return warning ? `${warning}\n${body}` : body;
    }

    // ---------------- Contexto del repositorio ----------------

    private async buildContext(text: string): Promise<string> {
        const parts: string[] = [];
        const index = await this.o.repo.readText('Memory/INDEX.md', 8000);
        if (index) parts.push(`## Memory/INDEX.md\n${index}`);

        const tenant = /\b(?:server|servidor|tenant|cabecera|pos)?\s*#?(\d{1,4})\b/i.exec(text.replace(DOC_ID, ' '))?.[1];
        if (tenant) {
            const rel = `Memory/xBackend/Tenants/server${tenant}/MEMORY.md`;
            const mem = await this.o.repo.readText(rel, 8000);
            parts.push(mem ? `## ${rel}\n${mem}` : `## ${rel}\n(sin bitácora para este tenant)`);
        }

        const drafts = await this.o.repo.listMarkdown(DRAFTS_DIR);
        const approved = await this.o.repo.listMarkdown(APPROVED_DIR);
        parts.push(`## ${DRAFTS_DIR}/\n${drafts.map((f) => `- ${f}`).join('\n') || '(vacío)'}`);
        parts.push(`## ${APPROVED_DIR}/\n${approved.map((f) => `- ${f}`).join('\n') || '(vacío)'}`);

        const ids = [...new Set([...text.matchAll(DOC_ID)].map((m) => m[1]!.toUpperCase()))].slice(0, 3);
        for (const id of ids) {
            for (const [dir, files] of [[APPROVED_DIR, approved], [DRAFTS_DIR, drafts]] as const) {
                const f = files.find((name) => name.toUpperCase().startsWith(id));
                if (!f) continue;
                const content = await this.o.repo.readText(`${dir}/${f}`, 15_000);
                if (content) parts.push(`## ${dir}/${f}\n${content}`);
            }
        }
        return parts.join('\n\n');
    }

    // ---------------- L0: consulta ----------------

    private async answer(req: AgentRequest): Promise<string> {
        const context = await this.buildContext(req.text);
        const res = await this.o.router.complete('claude', {
            agent: 'shikamaru', taskType: 'planning', system: ANSWER_SYSTEM,
            prompt: `Consulta del operador: ${req.text}\n\n# Contexto (xPlanning@main)\n${context}`,
            metadata: { message_id: req.messageId }
        });
        return truncate(res.text.trim(), MAX_REPLY);
    }

    // ---------------- L1: borrador con aprobación ----------------

    private async proposeDraft(req: AgentRequest): Promise<string> {
        const context = await this.buildContext(req.text);
        const res = await this.o.router.complete('claude', {
            agent: 'shikamaru', taskType: 'planning', system: DRAFT_SYSTEM,
            prompt: `Pedido del operador: ${req.text}\n\n# Contexto (xPlanning@main)\n${context}`,
            maxOutputTokens: 8000, metadata: { message_id: req.messageId, intent: 'draft' }
        });
        const content = res.text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1');
        const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? 'Borrador';
        const slug = slugify(title);
        const branch = assertDraftBranch(`draft/shikamaru-${slug}`);
        const fileName = `${this.clock().toISOString().slice(0, 10)}_${slug}.md`;

        const a = await this.o.approvals.request({
            prefix: 'SH', agentName: 'shikamaru', actionType: 'git_push_draft', targetTenant: null,
            summaryText: `Publicar borrador "${title}" en ${branch}`,
            payload: { branch, fileName, title, content }
        });
        return [
            `📝 Borrador propuesto: *${title}*`,
            `Rama: ${branch}`,
            `Archivo: ${DRAFTS_DIR}/${fileName}`,
            '',
            'Vista previa:',
            truncate(content, 900),
            '',
            `Respondé *CONFIRMAR ${a.code}* (vence en 5 min) o CANCELAR ${a.code}. Nunca se publica en main.`
        ].join('\n');
    }

    /** Handler `git_push_draft`: valida rama/archivo en código antes de cualquier git. */
    async executeDraft(a: Approval): Promise<string> {
        const branch = assertDraftBranch(String(a.payload['branch'] ?? ''));
        const fileName = String(a.payload['fileName'] ?? '');
        const content = String(a.payload['content'] ?? '');
        const title = String(a.payload['title'] ?? fileName);
        const r = await this.o.repo.publishDraft({
            branch, fileName, content, commitMessage: `docs(draft): ${title} [${a.code}]\n\nGenerado por Shikamaru (xRoster) con aprobación L1.`
        });
        return `📤 Rama ${r.branch} publicada (commit ${r.commit || 'n/d'}) con ${r.path}. Abrí un PR hacia main para revisión.`;
    }
}
