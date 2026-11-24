import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { Approval, ApprovalStatus, AuditPage, AuditStatus } from '../types';
import { fmtDateTime, fmtDuration, fmtInt, fmtMs, useDebounced, useInterval, useNow } from '../format';
import { Badge, Banner, ConfirmDialog, Empty, PageHeader } from '../components/ui';

const TTL_MS = 5 * 60_000;
const PAGE_SIZE = 25;
const AGENTS = ['jarvis', 'sentinel', 'tank', 'shikamaru'];
const AUDIT_STATUSES: AuditStatus[] = ['ok', 'error', 'ignored', 'unauthorized', 'processing'];
const ACTION_LABEL: Record<string, string> = { restart_service: 'Reiniciar servicio', git_push_draft: 'Push de borrador a xPlanning' };
const APPROVAL_TONE: Record<ApprovalStatus, 'ok' | 'warn' | 'down' | 'info' | 'muted'> = {
    pending: 'warn', confirmed: 'info', executed: 'ok', cancelled: 'muted', expired: 'muted', failed: 'down'
};
const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
    pending: 'Pendiente', confirmed: 'Confirmada', executed: 'Ejecutada', cancelled: 'Cancelada', expired: 'Expirada', failed: 'Falló'
};
const AUDIT_TONE: Record<AuditStatus, 'ok' | 'warn' | 'down' | 'info' | 'muted'> = {
    ok: 'ok', error: 'down', ignored: 'muted', unauthorized: 'warn', processing: 'info'
};

type Pending = { approval: Approval; action: 'confirm' | 'cancel' } | null;

function PendingCard({ a, now, onDecide }: { a: Approval; now: number; onDecide: (a: Approval, action: 'confirm' | 'cancel') => void }) {
    const left = new Date(a.expires_at).getTime() - now;
    const ttl = Math.max(1, new Date(a.expires_at).getTime() - new Date(a.requested_at).getTime() || TTL_MS);
    const pct = Math.max(0, Math.min(100, (left / ttl) * 100));
    const expired = left <= 0;
    return (
        <article className={`approval-card ${left < 60_000 ? 'urgent' : ''}`}>
            <header>
                <code className="approval-code">{a.code}</code>
                <span className={`countdown ${expired ? 'muted' : left < 60_000 ? 'down-text' : 'warn-text'}`} aria-live="off">
                    {expired ? 'Expirada' : `Expira en ${fmtDuration(left)}`}
                </span>
            </header>
            <div className="ttl-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
            <p className="approval-summary">{a.summary_text}</p>
            <dl className="approval-meta">
                <div><dt>Agente</dt><dd className="cap">{a.agent_name}</dd></div>
                <div><dt>Acción</dt><dd>{ACTION_LABEL[a.action_type] ?? a.action_type}</dd></div>
                <div><dt>Tenant</dt><dd>{a.target_tenant ?? '—'}</dd></div>
                <div><dt>Solicitada</dt><dd>{fmtDateTime(a.requested_at)}</dd></div>
            </dl>
            <div className="approval-actions">
                <button type="button" className="btn ghost" disabled={expired} onClick={() => onDecide(a, 'cancel')}>Cancelar</button>
                <button type="button" className="btn primary" disabled={expired} onClick={() => onDecide(a, 'confirm')}>Confirmar</button>
            </div>
        </article>
    );
}

export function Approvals() {
    const [pending, setPending] = useState<Approval[] | null>(null);
    const [history, setHistory] = useState<Approval[]>([]);
    const [offset, setOffset] = useState(0);
    const now = useNow(1000, offset);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ tone: 'ok' | 'info'; text: string } | null>(null);
    const [dialog, setDialog] = useState<Pending>(null);
    const [busy, setBusy] = useState(false);

    const [agent, setAgent] = useState('');
    const [status, setStatus] = useState<AuditStatus | ''>('');
    const [search, setSearch] = useState('');
    const debounced = useDebounced(search.trim(), 300);
    const [page, setPage] = useState(0);
    const [audit, setAudit] = useState<AuditPage | null>(null);

    const loadApprovals = useCallback(async () => {
        try {
            const [p, all] = await Promise.all([api.approvals('pending', 50), api.approvals('all', 20)]);
            setPending(p.approvals);
            setHistory(all.approvals.filter((a) => a.status !== 'pending'));
            setOffset(new Date(p.server_time).getTime() - Date.now());
        } catch (err) {
            setError(errorText(err));
        }
    }, []);

    const loadAudit = useCallback(async () => {
        try {
            setAudit(await api.audit({ agent, status, search: debounced, limit: PAGE_SIZE, offset: page * PAGE_SIZE }));
        } catch (err) {
            setError(errorText(err));
        }
    }, [agent, status, debounced, page]);

    useEffect(() => { void loadApprovals(); }, [loadApprovals]);
    useEffect(() => { void loadAudit(); }, [loadAudit]);
    useEffect(() => { setPage(0); }, [agent, status, debounced]);
    useInterval(() => { void loadApprovals(); }, 10_000);

    async function decide() {
        if (!dialog) return;
        setBusy(true);
        try {
            const r = await api.decide(dialog.approval.code, dialog.action);
            const suffix = r.resolved && !r.notified ? ' (no se pudo avisar al War Room)' : '';
            setNotice({ tone: r.resolved ? 'ok' : 'info', text: `${r.code}: ${r.message}${suffix}` });
            setDialog(null);
            await Promise.all([loadApprovals(), loadAudit()]);
        } catch (err) {
            setError(errorText(err));
            setDialog(null);
            await loadApprovals();
        } finally {
            setBusy(false);
        }
    }

    const totalPages = audit ? Math.max(1, Math.ceil(audit.total / PAGE_SIZE)) : 1;

    return (
        <>
            <PageHeader title="Aprobaciones L1 y auditoría" subtitle="Las decisiones pasan por el mismo circuito que CONFIRMAR / CANCELAR en WhatsApp" />
            {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
            {notice && <Banner tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Banner>}

            <section className="approvals-section">
                <h2>Pendientes{pending && pending.length > 0 ? ` (${pending.length})` : ''}</h2>
                {!pending ? <p className="muted">Cargando solicitudes…</p> : pending.length === 0 ? (
                    <Empty>No hay solicitudes esperando decisión. Cuando Tank o Shikamaru pidan una acción L1, aparece acá.</Empty>
                ) : (
                    <div className="approval-grid">
                        {pending.map((a) => (
                            <PendingCard key={a.code} a={a} now={now} onDecide={(approval, action) => setDialog({ approval, action })} />
                        ))}
                    </div>
                )}
            </section>

            {history.length > 0 && (
                <section className="panel">
                    <h2>Decisiones recientes</h2>
                    <div className="table-wrap">
                        <table>
                            <thead><tr><th>Código</th><th>Estado</th><th>Acción</th><th>Resumen</th><th>Decidida</th><th>Resultado</th></tr></thead>
                            <tbody>
                                {history.map((a) => (
                                    <tr key={a.code}>
                                        <td><code>{a.code}</code></td>
                                        <td><Badge tone={APPROVAL_TONE[a.status]}>{APPROVAL_LABEL[a.status]}</Badge></td>
                                        <td>{ACTION_LABEL[a.action_type] ?? a.action_type}</td>
                                        <td className="clip" title={a.summary_text}>{a.summary_text}</td>
                                        <td className="nowrap">{fmtDateTime(a.decided_at)}</td>
                                        <td className="clip" title={a.result_summary ?? ''}>{a.result_summary ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <section className="panel">
                <div className="panel-head">
                    <h2>Registro de auditoría</h2>
                    {audit && <span className="muted">{fmtInt(audit.total)} registros</span>}
                </div>
                <div className="filters">
                    <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filtrar por agente">
                        <option value="">Todos los agentes</option>
                        {AGENTS.map((a) => <option key={a} value={a}>{a[0]!.toUpperCase() + a.slice(1)}</option>)}
                    </select>
                    <select value={status} onChange={(e) => setStatus(e.target.value as AuditStatus | '')} aria-label="Filtrar por estado">
                        <option value="">Todos los estados</option>
                        {AUDIT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="search" className="search" placeholder="Buscar en mensajes y respuestas" value={search}
                        onChange={(e) => setSearch(e.target.value)} maxLength={100} aria-label="Buscar en auditoría" />
                </div>
                {!audit ? <p className="muted">Cargando auditoría…</p> : audit.rows.length === 0 ? (
                    <Empty>Ningún registro coincide con el filtro.</Empty>
                ) : (
                    <>
                        <div className="table-wrap">
                            <table className="audit">
                                <thead><tr><th>Fecha</th><th>Agente</th><th>Estado</th><th>Remitente</th><th>Mensaje</th><th>Respuesta</th><th className="num">Duración</th></tr></thead>
                                <tbody>
                                    {audit.rows.map((r) => (
                                        <tr key={r.message_id}>
                                            <td className="nowrap">{fmtDateTime(r.created_at)}</td>
                                            <td className="cap">{r.agent_name ?? '—'}</td>
                                            <td><Badge tone={AUDIT_TONE[r.status]}>{r.status}</Badge></td>
                                            <td className="nowrap">{r.sender_phone ?? '—'}</td>
                                            <td className="clip" title={r.input_text ?? ''}>{r.input_text ?? '—'}</td>
                                            <td className="clip" title={r.output_text ?? ''}>{r.output_text ?? '—'}</td>
                                            <td className="num">{fmtMs(r.duration_ms)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <nav className="pager" aria-label="Paginación de auditoría">
                            <button type="button" className="btn ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</button>
                            <span className="muted">Página {page + 1} de {totalPages}</span>
                            <button type="button" className="btn ghost" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Siguiente</button>
                        </nav>
                    </>
                )}
            </section>

            <ConfirmDialog
                open={dialog !== null}
                title={dialog?.action === 'confirm' ? `Confirmar ${dialog.approval.code}` : `Cancelar ${dialog?.approval.code ?? ''}`}
                body={dialog && (
                    <>
                        <p>{dialog.approval.summary_text}</p>
                        <p className="muted">
                            {dialog.action === 'confirm'
                                ? 'La acción se ejecuta ahora y se avisa al War Room de WhatsApp.'
                                : 'La solicitud se descarta sin ejecutar y se avisa al War Room de WhatsApp.'}
                        </p>
                    </>
                )}
                confirmLabel={dialog?.action === 'confirm' ? 'Confirmar y ejecutar' : 'Cancelar solicitud'}
                tone={dialog?.action === 'confirm' ? 'primary' : 'danger'}
                busy={busy}
                onConfirm={() => void decide()}
                onClose={() => { if (!busy) setDialog(null); }}
            />
        </>
    );
}
