import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import type { SessionInfo } from '../types';

export function Login({ onLogin, notice }: { onLogin: (s: SessionInfo) => void; notice?: string | null }) {
    const [user, setUser] = useState('admin');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(e: FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            onLogin(await api.login(user.trim(), password));
        } catch (err) {
            setError(errorText(err));
            setPassword('');
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="login">
            <form className="login-card" onSubmit={submit} aria-describedby={error ? 'login-error' : undefined}>
                <div className="brand big">
                    <span className="brand-mark" aria-hidden="true">xR</span>
                    <div>
                        <strong>cpanel-roster</strong>
                        <span className="muted">War Room de agentes xRoster</span>
                    </div>
                </div>
                {notice && !error && <p className="login-note">{notice}</p>}
                <label>
                    Usuario
                    <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required maxLength={256} />
                </label>
                <label>
                    Contraseña
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={256} autoFocus />
                </label>
                {error && <p id="login-error" className="form-error" role="alert">{error}</p>}
                <button type="submit" className="btn primary block" disabled={busy || !password}>
                    {busy ? 'Ingresando…' : 'Ingresar'}
                </button>
            </form>
        </main>
    );
}
