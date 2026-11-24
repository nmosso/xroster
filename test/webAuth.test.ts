import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LoginRateLimiter, SESSION_COOKIE, SESSION_TTL_SEC, WebAuth, clientIp, parseCookies, signSession, verifySession
} from '../src/web/auth';
import { fixedClock } from './helpers';

const SECRET = 'x'.repeat(64);
const CFG = { user: 'admin', password: 'S3cret-pass!', sessionSecret: SECRET, cookieSecure: true };
const MIN = 60_000;

function cookieValue(setCookie: string): string {
    const m = new RegExp(`^${SESSION_COOKIE}=([^;]*)`).exec(setCookie);
    assert.ok(m, `Set-Cookie inesperado: ${setCookie}`);
    return m[1]!;
}

test('WebAuth.configured: fail-closed si falta password o secret', () => {
    assert.equal(new WebAuth(CFG).configured, true);
    assert.equal(new WebAuth({ ...CFG, password: null }).configured, false);
    assert.equal(new WebAuth({ ...CFG, sessionSecret: null }).configured, false);
    assert.equal(new WebAuth({ ...CFG, password: '' }).configured, false);
});

test('signSession/verifySession: roundtrip válido y expiración', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const token = signSession({ user: 'admin', exp: Math.floor(now / 1000) + 60 }, SECRET);
    assert.deepEqual(verifySession(token, SECRET, now), { user: 'admin', exp: Math.floor(now / 1000) + 60 });
    assert.equal(verifySession(token, SECRET, now + 61_000), null);
});

test('verifySession: firma adulterada, payload adulterado, otro secret o basura -> null', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const token = signSession({ user: 'admin', exp: Math.floor(now / 1000) + 3600 }, SECRET);
    const [payload, sig] = token.split('.') as [string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ user: 'root', exp: 9_999_999_999 })).toString('base64url');
    assert.equal(verifySession(`${forgedPayload}.${sig}`, SECRET, now), null);
    assert.equal(verifySession(`${payload}.${sig.slice(0, -2)}AA`, SECRET, now), null);
    assert.equal(verifySession(token, 'y'.repeat(64), now), null);
    for (const junk of [undefined, '', 'abc', '.', 'a.b.c', `${payload}.`]) assert.equal(verifySession(junk, SECRET, now), null);
});

test('parseCookies: múltiples cookies, espacios y valores url-encoded', () => {
    assert.deepEqual(parseCookies('a=1; xroster_session=abc.def;  b=%20x'), { a: '1', xroster_session: 'abc.def', b: ' x' });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies('malformed'), {});
});

test('login OK: cookie xroster_session HttpOnly; SameSite=Lax; Path=/; Max-Age=43200; Secure', () => {
    const c = fixedClock();
    const auth = new WebAuth(CFG, { clock: c.clock });
    const r = auth.login('1.2.3.4', 'admin', 'S3cret-pass!');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const parts = r.cookie.split('; ');
    assert.ok(parts.includes('HttpOnly'));
    assert.ok(parts.includes('SameSite=Lax'));
    assert.ok(parts.includes('Path=/'));
    assert.ok(parts.includes(`Max-Age=${SESSION_TTL_SEC}`));
    assert.ok(parts.includes('Secure'));
    assert.equal(SESSION_TTL_SEC, 43_200);
    const session = auth.sessionFromCookie(`${SESSION_COOKIE}=${cookieValue(r.cookie)}`);
    assert.equal(session?.user, 'admin');
    assert.equal(session?.exp, Math.floor(c.nowMs() / 1000) + SESSION_TTL_SEC);
});

test('login: sin Secure cuando cookieSecure=false', () => {
    const r = new WebAuth({ ...CFG, cookieSecure: false }).login('1.2.3.4', 'admin', 'S3cret-pass!');
    assert.ok(r.ok && !r.cookie.split('; ').includes('Secure'));
});

test('login: usuario o password incorrectos -> invalid; sin configurar -> disabled', () => {
    const auth = new WebAuth(CFG);
    assert.deepEqual(auth.login('1.1.1.1', 'admin', 'nope'), { ok: false, reason: 'invalid' });
    assert.deepEqual(auth.login('1.1.1.2', 'Admin', 'S3cret-pass!'), { ok: false, reason: 'invalid' });
    assert.deepEqual(auth.login('1.1.1.3', 'admin', ''), { ok: false, reason: 'invalid' });
    assert.deepEqual(new WebAuth({ ...CFG, password: null }).login('1.1.1.4', 'admin', ''), { ok: false, reason: 'disabled' });
});

test('sesión expirada tras 12 h -> null', () => {
    const c = fixedClock();
    const auth = new WebAuth(CFG, { clock: c.clock });
    const r = auth.login('1.2.3.4', 'admin', 'S3cret-pass!');
    assert.ok(r.ok);
    const cookie = `${SESSION_COOKIE}=${cookieValue(r.cookie)}`;
    c.advance(SESSION_TTL_SEC * 1000 - 1000);
    assert.ok(auth.sessionFromCookie(cookie));
    c.advance(2000);
    assert.equal(auth.sessionFromCookie(cookie), null);
});

test('rate-limit: 5 fallos por IP en 15 min -> 6to intento rate_limited (aun con clave correcta); otra IP no afectada', () => {
    const c = fixedClock();
    const auth = new WebAuth(CFG, { clock: c.clock });
    for (let i = 0; i < 5; i++) assert.deepEqual(auth.login('9.9.9.9', 'admin', `bad-${i}`), { ok: false, reason: 'invalid' });
    assert.deepEqual(auth.login('9.9.9.9', 'admin', 'S3cret-pass!'), { ok: false, reason: 'rate_limited' });
    assert.equal(auth.login('8.8.8.8', 'admin', 'S3cret-pass!').ok, true);
    c.advance(15 * MIN + 1);
    assert.equal(auth.login('9.9.9.9', 'admin', 'S3cret-pass!').ok, true);
});

test('rate-limit: un login exitoso reinicia el contador de fallos', () => {
    const c = fixedClock();
    const auth = new WebAuth(CFG, { clock: c.clock });
    for (let i = 0; i < 4; i++) auth.login('7.7.7.7', 'admin', 'bad');
    assert.equal(auth.login('7.7.7.7', 'admin', 'S3cret-pass!').ok, true);
    for (let i = 0; i < 4; i++) assert.equal(auth.login('7.7.7.7', 'admin', 'bad').ok, false);
    assert.equal(auth.login('7.7.7.7', 'admin', 'S3cret-pass!').ok, true);
});

test('LoginRateLimiter: ventana deslizante y poda de entradas vencidas', () => {
    const c = fixedClock();
    const rl = new LoginRateLimiter({ maxFailures: 2, windowMs: 10 * MIN, clock: () => c.nowMs() });
    rl.fail('a');
    c.advance(6 * MIN);
    rl.fail('a');
    assert.equal(rl.isBlocked('a'), true);
    c.advance(5 * MIN); // el primer fallo salió de la ventana
    assert.equal(rl.isBlocked('a'), false);
    c.advance(10 * MIN);
    assert.equal(rl.size(), 0);
});

test('logoutCookie: borra la cookie (Max-Age=0) con los mismos atributos', () => {
    const parts = new WebAuth(CFG).logoutCookie().split('; ');
    assert.equal(parts[0], `${SESSION_COOKIE}=`);
    assert.ok(parts.includes('Max-Age=0') && parts.includes('HttpOnly') && parts.includes('Path=/') && parts.includes('SameSite=Lax'));
});

test('clientIp: X-Real-IP solo se confía desde loopback o red privada (Nginx local / bridge Docker)', () => {
    const real = { 'x-real-ip': '203.0.113.7' };
    assert.equal(clientIp({ remoteAddress: '127.0.0.1', headers: real }), '203.0.113.7');
    assert.equal(clientIp({ remoteAddress: '::ffff:127.0.0.1', headers: real }), '203.0.113.7');
    assert.equal(clientIp({ remoteAddress: '::1', headers: real }), '203.0.113.7');
    assert.equal(clientIp({ remoteAddress: '172.17.0.1', headers: real }), '203.0.113.7');
    assert.equal(clientIp({ remoteAddress: '198.51.100.9', headers: real }), '198.51.100.9');
    assert.equal(clientIp({ remoteAddress: '172.32.0.1', headers: real }), '172.32.0.1');
    assert.equal(clientIp({ remoteAddress: '127.0.0.1', headers: {} }), '127.0.0.1');
    assert.equal(clientIp({ remoteAddress: '127.0.0.1', headers: { 'x-real-ip': 'no es ip; DROP' } }), '127.0.0.1');
    assert.equal(clientIp({ remoteAddress: undefined, headers: {} }), 'unknown');
});
