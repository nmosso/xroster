// Gráfico de barras agrupadas en SVG propio (sin librerías): requests por bucket y proveedor.
import { useMemo, useState } from 'react';
import type { QuotaBucket, QuotaSeriesPoint } from '../types';
import { fmtCompact, fmtDay, fmtInt, fmtTime, providerLabel } from '../format';

export const PROVIDER_COLORS: Record<string, string> = { gemini: 'var(--gemini)', claude: 'var(--claude)' };
const FALLBACK_COLOR = 'var(--muted)';

type Metric = 'requests' | 'tokens';

interface Props {
    series: QuotaSeriesPoint[];
    bucket: QuotaBucket;
    since: string;
    until: string;
    providers: string[];
}

const W = 860;
const H = 240;
const PAD = { top: 14, right: 12, bottom: 28, left: 48 };

function truncateTo(d: Date, bucket: QuotaBucket): Date {
    const t = new Date(d);
    t.setUTCMinutes(0, 0, 0);
    if (bucket === 'day') t.setUTCHours(0);
    return t;
}

function niceMax(v: number): number {
    if (v <= 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(v));
    const n = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
}

export function UsageChart({ series, bucket, since, until, providers }: Props) {
    const [metric, setMetric] = useState<Metric>('requests');
    const [hover, setHover] = useState<number | null>(null);

    const { buckets, values } = useMemo(() => {
        const stepMs = bucket === 'hour' ? 3600_000 : 86_400_000;
        const start = truncateTo(new Date(since), bucket).getTime();
        const end = truncateTo(new Date(until), bucket).getTime();
        const list: number[] = [];
        for (let t = start; t <= end && list.length < 800; t += stepMs) list.push(t);
        const map = new Map<string, number>();
        for (const p of series) {
            const key = `${truncateTo(new Date(p.bucket), bucket).getTime()}|${p.provider}`;
            const v = metric === 'requests' ? p.requests : p.input_tokens + p.output_tokens;
            map.set(key, (map.get(key) ?? 0) + v);
        }
        return { buckets: list, values: list.map((t) => providers.map((pr) => map.get(`${t}|${pr}`) ?? 0)) };
    }, [series, bucket, since, until, providers, metric]);

    const max = niceMax(Math.max(0, ...values.flat()));
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const slot = innerW / Math.max(1, buckets.length);
    const groupW = Math.max(2, slot * 0.72);
    const barW = groupW / Math.max(1, providers.length);
    const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 10));
    const label = (t: number) => (bucket === 'hour' ? fmtTime(new Date(t)) : fmtDay(new Date(t)));
    const empty = values.every((row) => row.every((v) => v === 0));
    const hovered = hover !== null ? buckets[hover] : undefined;

    return (
        <div className="chart">
            <div className="chart-head">
                <div className="legend">
                    {providers.map((p) => (
                        <span key={p} className="legend-item">
                            <i style={{ background: PROVIDER_COLORS[p] ?? FALLBACK_COLOR }} />
                            {providerLabel(p)}
                        </span>
                    ))}
                </div>
                <div className="segmented small" role="group" aria-label="Métrica del gráfico">
                    <button type="button" aria-pressed={metric === 'requests'} onClick={() => setMetric('requests')}>Requests</button>
                    <button type="button" aria-pressed={metric === 'tokens'} onClick={() => setMetric('tokens')}>Tokens</button>
                </div>
            </div>
            <div className="chart-body">
                <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Uso por ${bucket === 'hour' ? 'hora' : 'día'}`} onMouseLeave={() => setHover(null)}>
                    {ticks.map((t) => (
                        <g key={t}>
                            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
                            <text x={PAD.left - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">{fmtCompact(Math.round(t))}</text>
                        </g>
                    ))}
                    {buckets.map((t, i) => {
                        const x0 = PAD.left + i * slot + (slot - groupW) / 2;
                        return (
                            <g key={t} onMouseEnter={() => setHover(i)}>
                                <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={innerH} className={hover === i ? 'hover-band on' : 'hover-band'} />
                                {(values[i] ?? []).map((v, j) => (
                                    v > 0 ? (
                                        <rect key={j} x={x0 + j * barW} y={y(v)} width={Math.max(1, barW - 1)} height={PAD.top + innerH - y(v)}
                                            rx={Math.min(2, barW / 3)} fill={PROVIDER_COLORS[providers[j] ?? ''] ?? FALLBACK_COLOR} />
                                    ) : null
                                ))}
                                {i % labelEvery === 0 && (
                                    <text x={PAD.left + i * slot + slot / 2} y={H - 8} className="axis" textAnchor="middle">{label(t)}</text>
                                )}
                            </g>
                        );
                    })}
                    {empty && (
                        <text x={W / 2} y={H / 2} className="axis empty-label" textAnchor="middle">Sin consumo registrado en este rango</text>
                    )}
                </svg>
                {hovered !== undefined && hover !== null && !empty && (
                    <div className="chart-tip" style={{ left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%` }}>
                        <strong>{bucket === 'hour' ? `${fmtDay(new Date(hovered))} ${fmtTime(new Date(hovered))}` : fmtDay(new Date(hovered))}</strong>
                        {providers.map((p, j) => (
                            <span key={p}><i style={{ background: PROVIDER_COLORS[p] ?? FALLBACK_COLOR }} />{providerLabel(p)}: {fmtInt(values[hover]?.[j] ?? 0)}</span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
