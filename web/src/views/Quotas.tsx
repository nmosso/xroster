import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api';
import type { ProviderTotals, QuotaRange, QuotaReport } from '../types';
import { fmtCompact, fmtDateTime, fmtInt, fmtMs, providerLabel, useInterval } from '../format';
import { Badge, Banner, Empty, PageHeader } from '../components/ui';
import { PROVIDER_COLORS, UsageChart } from '../components/UsageChart';

const RANGES: { id: QuotaRange; label: string }[] = [
    { id: '5h', label: '5 h' },
    { id: '24h', label: '24 h' },
    { id: '7d', label: '7 días' },
    { id: '30d', label: '30 días' }
];
const BASE_PROVIDERS = ['gemini', 'claude'];

function emptyTotals(provider: string): ProviderTotals {
    return { provider, requests: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, rate_limited: 0, errors: 0, avg_latency_ms: 0 };
}

export function Quotas() {
    const [range, setRange] = useState<QuotaRange>('24h');
    const [data, setData] = useState<QuotaReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (r: QuotaRange) => {
        setLoading(true);
        try {
            setData(await api.quotas(r));
            setError(null);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(range); }, [range, load]);
    useInterval(() => { void load(range); }, 60_000);

    const providers = useMemo(() => {
        const extra = (data?.totals ?? []).map((t) => t.provider).filter((p) => !BASE_PROVIDERS.includes(p));
        return [...BASE_PROVIDERS, ...extra];
    }, [data]);

    const total429 = (data?.totals ?? []).reduce((acc, t) => acc + t.rate_limited, 0);

    return (
        <>
            <PageHeader title="Cuotas IA" subtitle="Consumo de Gemini y Claude registrado por los agentes">
                <div className="segmented" role="group" aria-label="Rango de tiempo">
                    {RANGES.map((r) => (
                        <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
                    ))}
                </div>
            </PageHeader>
            {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
            {!data && !error && <p className="muted">Cargando métricas…</p>}

            {data && (
                <div className={`stack${loading ? ' is-loading' : ''}`}>
                    <section className="kpi-grid">
                        {providers.map((p) => {
                            const t = data.totals.find((x) => x.provider === p) ?? emptyTotals(p);
                            return (
                                <article key={p} className="kpi-card" style={{ ['--accent' as string]: PROVIDER_COLORS[p] ?? 'var(--muted)' }}>
                                    <header>
                                        <h2>{providerLabel(p)}</h2>
                                        {t.rate_limited > 0 ? <Badge tone="down">{fmtInt(t.rate_limited)} × 429</Badge> : <Badge tone="ok">Sin 429</Badge>}
                                    </header>
                                    <div className="kpi-main">
                                        <span className="kpi-value">{fmtCompact(t.requests)}</span>
                                        <span className="muted">requests</span>
                                    </div>
                                    <dl className="kpi-list">
                                        <div><dt>Tokens entrada</dt><dd>{fmtCompact(t.input_tokens)}</dd></div>
                                        <div><dt>Tokens salida</dt><dd>{fmtCompact(t.output_tokens)}</dd></div>
                                        <div><dt>Tokens en caché</dt><dd>{fmtCompact(t.cached_tokens)}</dd></div>
                                        <div><dt>Latencia promedio</dt><dd>{t.requests ? fmtMs(t.avg_latency_ms) : '—'}</dd></div>
                                        <div><dt>Errores</dt><dd className={t.errors ? 'down-text' : ''}>{fmtInt(t.errors)}</dd></div>
                                    </dl>
                                </article>
                            );
                        })}
                    </section>

                    <section className="panel">
                        <h2>Uso por {data.bucket === 'hour' ? 'hora' : 'día'}</h2>
                        <UsageChart series={data.series} bucket={data.bucket} since={data.since} until={data.generated_at} providers={providers} />
                    </section>

                    <section className="two-col wide-left">
                        <div className="panel">
                            <h2>Por agente y modelo</h2>
                            {data.by_agent_model.length === 0 ? <Empty>Sin consumo en este rango.</Empty> : (
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Agente</th><th>Proveedor</th><th>Modelo</th>
                                                <th className="num">Requests</th><th className="num">Tokens in</th><th className="num">Tokens out</th>
                                                <th className="num">Latencia</th><th className="num">429</th><th className="num">Errores</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.by_agent_model.map((r) => (
                                                <tr key={`${r.agent_name}|${r.provider}|${r.model}`}>
                                                    <td className="cap">{r.agent_name}</td>
                                                    <td><span className="swatch" style={{ background: PROVIDER_COLORS[r.provider] ?? 'var(--muted)' }} />{providerLabel(r.provider)}</td>
                                                    <td><code>{r.model}</code></td>
                                                    <td className="num">{fmtInt(r.requests)}</td>
                                                    <td className="num">{fmtCompact(r.input_tokens)}</td>
                                                    <td className="num">{fmtCompact(r.output_tokens)}</td>
                                                    <td className="num">{fmtMs(r.avg_latency_ms)}</td>
                                                    <td className={`num ${r.rate_limited ? 'down-text' : ''}`}>{fmtInt(r.rate_limited)}</td>
                                                    <td className={`num ${r.errors ? 'warn-text' : ''}`}>{fmtInt(r.errors)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                        <div className="panel">
                            <div className="panel-head">
                                <h2>Eventos 429 rate_limited</h2>
                                <Badge tone={total429 ? 'down' : 'ok'}>{fmtInt(total429)}</Badge>
                            </div>
                            {data.rate_limit_events.length === 0 ? <Empty>Ningún proveedor limitó requests en este rango.</Empty> : (
                                <ul className="event-list">
                                    {data.rate_limit_events.map((e, i) => (
                                        <li key={`${e.created_at}-${i}`}>
                                            <span className="muted">{fmtDateTime(e.created_at)}</span>
                                            <span><span className="cap">{e.agent_name}</span> · {providerLabel(e.provider)}</span>
                                            <code>{e.error_code ?? e.model}</code>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </section>
                </div>
            )}
        </>
    );
}
