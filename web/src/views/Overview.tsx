import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { Overview as OverviewData, ProviderUsage } from '../types';
import { fmtCompact, fmtDateTime, fmtDuration, fmtInt, providerLabel, useInterval, useNow } from '../format';
import { Badge, Banner, ConfirmDialog, Empty, PageHeader, StatusDot } from '../components/ui';
import type { ViewId } from '../App';

const HEALTH_LABEL: Record<string, string> = { xrosterdb: 'xrosterdb', redis: 'Redis monitoreo', evolution: 'Evolution API' };
const PROVIDERS = ['gemini', 'claude'];

function usageFor(list: ProviderUsage[], provider: string): ProviderUsage | undefined {
    return list.find((u) => u.provider === provider);
}

export function Overview({ go }: { go: (v: ViewId) => void }) {
    const [data, setData] = useState<OverviewData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmPause, setConfirmPause] = useState(false);
    const [busy, setBusy] = useState(false);
    const [offset, setOffset] = useState(0);
    const now = useNow(1000, offset);

    const load = useCallback(async () => {
        try {
            const d = await api.overview();
            setData(d);
            setOffset(new Date(d.generated_at).getTime() - Date.now());
            setError(null);
        } catch (err) {
            setError(errorText(err));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);
    useInterval(() => { void load(); }, 15_000);

    async function togglePause() {
        if (!data) return;
        setBusy(true);
        try {
            const r = await api.setPaused(!data.paused);
            setData({ ...data, paused: r.paused });
            setConfirmPause(false);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    if (!data) {
        return (
            <>
                <PageHeader title="Overview" />
                {error ? <Banner tone="error">{error}</Banner> : <p className="muted">Cargando estado…</p>}
            </>
        );
    }

    const silencedMs = data.sentinel_silenced_all_until ? new Date(data.sentinel_silenced_all_until).getTime() - now : 0;

    return (
        <>
            <PageHeader title="Overview" subtitle={`Actualizado ${fmtDateTime(data.generated_at)} · refresco cada 15 s`}>
                <button type="button" className="btn ghost" onClick={() => void load()}>Actualizar</button>
            </PageHeader>
            {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}

            <section className="overview-top">
                <div className={`switch-panel ${data.paused ? 'is-paused' : 'is-live'}`}>
                    <div className="switch-copy">
                        <h2>{data.paused ? 'Agentes en pausa' : 'Agentes operando'}</h2>
                        <p className="muted">
                            {data.paused
                                ? 'Jarvis no procesa comandos y Sentinel no envía alertas hasta reanudar.'
                                : 'Jarvis atiende el War Room y Sentinel vigila los tenants.'}
                        </p>
                    </div>
                    <button type="button" className="kill-switch" role="switch" aria-checked={!data.paused}
                        aria-label={data.paused ? 'Reanudar agentes' : 'Pausar agentes'} onClick={() => setConfirmPause(true)}>
                        <span className="kill-track"><span className="kill-knob" /></span>
                        <span className="kill-label">{data.paused ? 'Reanudar' : 'Pausar'}</span>
                    </button>
                </div>

                <div className="health-panel">
                    <h2>Salud</h2>
                    <ul className="health-list">
                        {(Object.keys(data.health) as (keyof OverviewData['health'])[]).map((k) => (
                            <li key={k}>
                                <StatusDot state={data.health[k]} label={data.health[k] === 'up' ? 'operativo' : 'caído'} />
                                <span>{HEALTH_LABEL[k] ?? k}</span>
                                <span className={data.health[k] === 'up' ? 'ok-text' : 'down-text'}>{data.health[k] === 'up' ? 'Operativo' : 'Caído'}</span>
                            </li>
                        ))}
                        <li>
                            <StatusDot state={silencedMs > 0 ? 'degraded' : 'idle'} label="silencio global" />
                            <span>Silencio global Sentinel</span>
                            <span className={silencedMs > 0 ? 'warn-text' : 'muted'}>{silencedMs > 0 ? `${fmtDuration(silencedMs)} restantes` : 'Inactivo'}</span>
                        </li>
                    </ul>
                </div>
            </section>

            <section className="stat-row">
                <button type="button" className={`stat ${data.alerts_active > 0 ? 'stat-alert' : ''}`} onClick={() => go('alerts')}>
                    <span className="stat-value">{fmtInt(data.alerts_active)}</span>
                    <span className="stat-label">Alertas QoS activas</span>
                </button>
                <button type="button" className={`stat ${data.approvals_pending > 0 ? 'stat-pending' : ''}`} onClick={() => go('approvals')}>
                    <span className="stat-value">{fmtInt(data.approvals_pending)}</span>
                    <span className="stat-label">Aprobaciones L1 pendientes</span>
                </button>
                {PROVIDERS.map((p) => {
                    const u5 = usageFor(data.quotas.last5h, p);
                    const u24 = usageFor(data.quotas.last24h, p);
                    return (
                        <button type="button" key={p} className={`stat stat-${p}`} onClick={() => go('quotas')}>
                            <span className="stat-value">{fmtCompact(u5?.requests ?? 0)}<small> / {fmtCompact(u24?.requests ?? 0)}</small></span>
                            <span className="stat-label">{providerLabel(p)} · requests 5h / 24h{(u24?.rate_limited ?? 0) > 0 ? ` · ${u24?.rate_limited} × 429` : ''}</span>
                        </button>
                    );
                })}
            </section>

            <section className="two-col">
                <div className="panel">
                    <h2>Roster de agentes</h2>
                    <ul className="roster">
                        {data.agents.map((a) => (
                            <li key={a.name} className={a.active ? '' : 'inactive'}>
                                <span className="avatar" aria-hidden="true">{a.name.slice(0, 2)}</span>
                                <div>
                                    <strong>{a.name}</strong>
                                    <span className="muted">{a.role}</span>
                                </div>
                                {a.active
                                    ? <Badge tone={data.paused ? 'warn' : 'ok'}>{data.paused ? 'En pausa' : 'Activo'}</Badge>
                                    : <Badge tone="muted">Próximamente ({a.phase})</Badge>}
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="panel">
                    <div className="panel-head">
                        <h2>Esperando tu decisión</h2>
                        <button type="button" className="link" onClick={() => go('approvals')}>Ver aprobaciones</button>
                    </div>
                    {data.pending_approvals.length === 0
                        ? <Empty>No hay solicitudes L1 pendientes.</Empty>
                        : (
                            <ul className="pending-mini">
                                {data.pending_approvals.map((a) => {
                                    const left = new Date(a.expires_at).getTime() - now;
                                    return (
                                        <li key={a.code}>
                                            <code>{a.code}</code>
                                            <span className="clip">{a.summary_text}</span>
                                            <span className={left < 60_000 ? 'down-text' : 'warn-text'}>{left > 0 ? fmtDuration(left) : 'Expirada'}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                </div>
            </section>

            <ConfirmDialog
                open={confirmPause}
                title={data.paused ? 'Reanudar agentes' : 'Pausar agentes'}
                body={data.paused
                    ? 'Jarvis vuelve a procesar comandos del War Room y Sentinel retoma las alertas.'
                    : 'Jarvis dejará de procesar comandos y Sentinel dejará de alertar hasta que reanudes. El cambio también se refleja en STATUS de WhatsApp.'}
                confirmLabel={data.paused ? 'Reanudar' : 'Pausar'}
                tone={data.paused ? 'primary' : 'danger'}
                busy={busy}
                onConfirm={() => void togglePause()}
                onClose={() => setConfirmPause(false)}
            />
        </>
    );
}
