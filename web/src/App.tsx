import { useCallback, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import type { SessionInfo } from './types';
import { Login } from './views/Login';
import { Overview } from './views/Overview';
import { Quotas } from './views/Quotas';
import { Alerts } from './views/Alerts';
import { Approvals } from './views/Approvals';

export type ViewId = 'overview' | 'quotas' | 'alerts' | 'approvals';

const VIEWS: { id: ViewId; path: string; label: string; hint: string }[] = [
    { id: 'overview', path: '/', label: 'Overview', hint: 'Estado y kill-switch' },
    { id: 'quotas', path: '/cuotas', label: 'Cuotas IA', hint: 'Gemini y Claude' },
    { id: 'alerts', path: '/alertas', label: 'Alertas QoS', hint: 'Sentinel' },
    { id: 'approvals', path: '/aprobaciones', label: 'Aprobaciones L1', hint: 'Y auditoría' }
];

function viewFromPath(path: string): ViewId {
    return VIEWS.find((v) => v.path !== '/' && path.startsWith(v.path))?.id ?? 'overview';
}

type AuthState = { kind: 'checking' } | { kind: 'anon'; notice: string | null } | { kind: 'in'; session: SessionInfo };

export function App() {
    const [auth, setAuth] = useState<AuthState>({ kind: 'checking' });
    const [view, setView] = useState<ViewId>(() => viewFromPath(window.location.pathname));

    useEffect(() => {
        setUnauthorizedHandler(() => setAuth({ kind: 'anon', notice: 'La sesión expiró. Volvé a ingresar.' }));
        api.me()
            .then((session) => setAuth({ kind: 'in', session }))
            .catch(() => setAuth({ kind: 'anon', notice: null }));
        const onPop = () => setView(viewFromPath(window.location.pathname));
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const go = useCallback((id: ViewId) => {
        const target = VIEWS.find((v) => v.id === id);
        if (!target) return;
        if (window.location.pathname !== target.path) window.history.pushState(null, '', target.path);
        setView(id);
        window.scrollTo({ top: 0 });
    }, []);

    async function logout() {
        try {
            await api.logout();
        } finally {
            setAuth({ kind: 'anon', notice: 'Sesión cerrada.' });
        }
    }

    if (auth.kind === 'checking') return <div className="boot muted">Verificando sesión…</div>;
    if (auth.kind === 'anon') return <Login notice={auth.notice} onLogin={(session) => setAuth({ kind: 'in', session })} />;

    return (
        <div className="shell">
            <aside className="sidebar">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">xR</span>
                    <div>
                        <strong>cpanel-roster</strong>
                        <span className="muted">War Room xRoster</span>
                    </div>
                </div>
                <nav aria-label="Secciones">
                    {VIEWS.map((v) => (
                        <a key={v.id} href={v.path} aria-current={view === v.id ? 'page' : undefined}
                            onClick={(e) => { e.preventDefault(); go(v.id); }}>
                            <span>{v.label}</span>
                            <small>{v.hint}</small>
                        </a>
                    ))}
                </nav>
                <div className="sidebar-foot">
                    <span className="muted">Sesión: <strong>{auth.session.user}</strong></span>
                    <button type="button" className="btn ghost small" onClick={() => void logout()}>Cerrar sesión</button>
                </div>
            </aside>
            <main className="content">
                {view === 'overview' && <Overview go={go} />}
                {view === 'quotas' && <Quotas />}
                {view === 'alerts' && <Alerts />}
                {view === 'approvals' && <Approvals />}
            </main>
        </div>
    );
}
