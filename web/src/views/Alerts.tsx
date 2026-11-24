import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { AlertRow, AlertStateFilter, AlertsResponse } from '../types';
import { fmtDateTime, fmtDuration, useDebounced, useInterval, useNow } from '../format';
import { Badge, Banner, Empty, PageHeader, StatusDot } from '../components/ui';

const STATES: { id: AlertStateFilter; label: string }[] = [
    { id: 'all', label: 'Todas' },
    { id: 'down', label: 'Caídas' },
    { id: 'degraded', label: 'Degradadas' },
    { id: 'ok', label: 'Recuperadas' }
];
const STATE_LABEL: Record<AlertRow['state'], string> = { down: 'Caída', degraded: 'Degradada', ok: 'OK' };
const SILENCE_OPTIONS = [15, 30, 60];

function SilenceMenu({ target, silenced, busy, onSilence }: {
    target: string; silenced: boolean; busy: boolean; onSilence: (target: string, minutes: number) => void;
}) {
    return (
        <div className="silence-menu" role="group" aria-label={target === 'all' ? 'Silenciar todo' : `Silenciar tenant ${target}`}>
            {SILENCE_OPTIONS.map((m) => (
                <button key={m} type="button" className="chip" disabled={busy} onClick={() => onSilence(target, m)}>{m}m</button>
            ))}
            {silenced && <button type="button" className="chip chip-clear" disabled={busy} onClick={() => onSilence(target, 0)}>Quitar silencio</button>}
        </div>
    );
}

export function Alerts() {
    const [state, setState] = useState<AlertStateFilter>('all');
    const [search, setSearch] = useState('');
    const debounced = useDebounced(search.trim(), 300);
    const [data, setData] = useState<AlertsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [offset, setOffset] = useState(0);
    const now = useNow(1000, offset);

    const load = useCallback(async () => {
        try {
            const d = await api.alerts(state, debounced);
            setData(d);
            setOffset(new Date(d.server_time).getTime() - Date.now());
            setError(null);
        } catch (err) {
            setError(errorText(err));
        }
    }, [state, debounced]);

    useEffect(() => { void load(); }, [load]);
    useInterval(() => { void load(); }, 30_000);

    async function silence(target: string, minutes: number) {
        setBusy(true);
        try {
            const r = await api.silence(target, minutes);
            setNotice(r.message);
            await load();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    const globalLeft = data?.silenced_all_until ? new Date(data.silenced_all_until).getTime() - now : 0;

    return (
        <>
            <PageHeader title="Alertas QoS" subtitle="Estado de Sentinel por tenant y componente" />
            {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
            {notice && <Banner tone="ok" onClose={() => setNotice(null)}>{notice}</Banner>}

            <section className="panel global-silence">
                <div>
                    <h2>Silencio global</h2>
                    <p className="muted">
                        {globalLeft > 0
                            ? `Sentinel no envía alertas al War Room durante ${fmtDuration(globalLeft)} más.`
                            : 'Sentinel envía todas las alertas al War Room.'}
                    </p>
                </div>
                <SilenceMenu target="all" silenced={globalLeft > 0} busy={busy} onSilence={(t, m) => void silence(t, m)} />
            </section>

            <section className="panel">
                <div className="filters">
                    <div className="segmented" role="group" aria-label="Filtrar por estado">
                        {STATES.map((s) => (
                            <button key={s.id} type="button" aria-pressed={state === s.id} onClick={() => setState(s.id)}>{s.label}</button>
                        ))}
                    </div>
                    <input type="search" className="search" placeholder="Buscar tenant, componente o detalle" value={search}
                        onChange={(e) => setSearch(e.target.value)} maxLength={100} aria-label="Buscar alertas" />
                </div>

                {!data ? <p className="muted">Cargando alertas…</p> : data.alerts.length === 0 ? (
                    <Empty>{debounced || state !== 'all' ? 'Ninguna alerta coincide con el filtro.' : 'Sentinel no registró alertas.'}</Empty>
                ) : (
                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>Estado</th><th>Tenant</th><th>Componente</th><th>Detalle</th>
                                    <th>Desde</th><th>Último aviso</th><th>Silencio</th><th>Silenciar</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.alerts.map((a) => {
                                    const left = a.silenced_until ? new Date(a.silenced_until).getTime() - now : 0;
                                    return (
                                        <tr key={a.alert_key} className={`row-${a.state}`}>
                                            <td><StatusDot state={a.state} label={STATE_LABEL[a.state]} /> {STATE_LABEL[a.state]}</td>
                                            <td><strong>{a.tenant_name ?? '—'}</strong> <span className="muted">#{a.tenant_position}</span></td>
                                            <td><code>{a.component}</code></td>
                                            <td className="clip detail" title={a.last_detail ?? ''}>{a.last_detail ?? '—'}</td>
                                            <td className="nowrap">{fmtDateTime(a.first_seen_at)}</td>
                                            <td className="nowrap">{fmtDateTime(a.last_notified_at)}</td>
                                            <td className="nowrap">{left > 0 ? <Badge tone="violet">{fmtDuration(left)}</Badge> : <span className="muted">—</span>}</td>
                                            <td><SilenceMenu target={a.tenant_position} silenced={left > 0} busy={busy} onSilence={(t, m) => void silence(t, m)} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </>
    );
}
