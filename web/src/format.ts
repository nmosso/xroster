import { useEffect, useRef, useState } from 'react';

const nf = new Intl.NumberFormat('es-AR');
const compact = new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 });
const dtf = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit' });

export const fmtInt = (n: number): string => nf.format(n);
export const fmtCompact = (n: number): string => (Math.abs(n) < 10_000 ? nf.format(n) : compact.format(n));
export const fmtDateTime = (iso: string | null): string => (iso ? dtf.format(new Date(iso)) : '—');
export const fmtTime = (d: Date): string => tf.format(d);
export const fmtDay = (d: Date): string => df.format(d);
export const fmtMs = (ms: number | null): string => (ms === null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Diferencia legible: "4m 12s", "2h 05m". */
export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
}

/** Reloj que se actualiza cada `ms`, corregido por el desfase servidor-cliente. */
export function useNow(ms = 1000, serverOffsetMs = 0): number {
    const [now, setNow] = useState(() => Date.now() + serverOffsetMs);
    useEffect(() => {
        setNow(Date.now() + serverOffsetMs);
        const t = setInterval(() => setNow(Date.now() + serverOffsetMs), ms);
        return () => clearInterval(t);
    }, [ms, serverOffsetMs]);
    return now;
}

/** Ejecuta `fn` cada `ms` mientras la pestaña está visible. */
export function useInterval(fn: () => void, ms: number): void {
    const ref = useRef(fn);
    ref.current = fn;
    useEffect(() => {
        const t = setInterval(() => {
            if (document.visibilityState === 'visible') ref.current();
        }, ms);
        return () => clearInterval(t);
    }, [ms]);
}

export function useDebounced<T>(value: T, ms = 300): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

export const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', claude: 'Claude' };
export const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? p;
