import { useEffect, useRef, type ReactNode } from 'react';

export function StatusDot({ state, label }: { state: 'up' | 'down' | 'ok' | 'degraded' | 'idle'; label?: string }) {
    return <span className={`dot dot-${state}`} role="img" aria-label={label ?? state} />;
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'down' | 'info' | 'muted' | 'violet'; children: ReactNode }) {
    return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Banner({ tone, children, onClose }: { tone: 'error' | 'ok' | 'info'; children: ReactNode; onClose?: () => void }) {
    return (
        <div className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
            <span>{children}</span>
            {onClose && <button type="button" className="link" onClick={onClose} aria-label="Cerrar aviso">Cerrar</button>}
        </div>
    );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
    return (
        <header className="page-head">
            <div>
                <h1>{title}</h1>
                {subtitle && <p className="muted">{subtitle}</p>}
            </div>
            {children && <div className="page-actions">{children}</div>}
        </header>
    );
}

export function Empty({ children }: { children: ReactNode }) {
    return <div className="empty">{children}</div>;
}

interface ConfirmProps {
    open: boolean;
    title: string;
    body: ReactNode;
    confirmLabel: string;
    tone?: 'primary' | 'danger';
    busy?: boolean;
    onConfirm: () => void;
    onClose: () => void;
}

/** Diálogo modal nativo (<dialog>): foco atrapado y Esc para cerrar sin dependencias. */
export function ConfirmDialog({ open, title, body, confirmLabel, tone = 'primary', busy, onConfirm, onClose }: ConfirmProps) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);
    return (
        <dialog ref={ref} className="dialog" onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault(); }}>
            <h2>{title}</h2>
            <div className="dialog-body">{body}</div>
            <div className="dialog-actions">
                <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Volver</button>
                <button type="button" className={`btn ${tone}`} onClick={onConfirm} disabled={busy} autoFocus>
                    {busy ? 'Procesando…' : confirmLabel}
                </button>
            </div>
        </dialog>
    );
}
