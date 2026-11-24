# MEMORY — `xRoster` (Fase 1)

| Metadato | Detalle |
| :--- | :--- |
| **Spec** | `REQ-2026-012` + `REQ-2026-013` (cpanel-roster) · RFC `RFC-2026-003` |
| **Estado** | REQ-012 T-02..T-08 · REQ-013 T-01..T-05 implementadas · tsc limpio (backend + web) · `npm test` verde |
| **Última actualización** | 2026-11-24 |
| **Pendiente fuera de este repo** | T-01 (forward en `xBackend`) · actualizar `Planning-X/Memory/INDEX.md` |

## 1. Qué es
Microservicio Docker (1.0 vCPU / 1536 MB) que conecta el grupo War Room de WhatsApp con 4 agentes:
**Jarvis** (orquestador), **Sentinel** (QoS), **Tank** (infra) y **Shikamaru** (planificación SDD).
Todo por `../.env.roster` (fuera del repo, `git pull` no lo pisa) → portable a VM dedicada sin cambios de código.

## 2. Mapa del código
```
src/
  index.ts            entrada: dotenv (XROSTER_ENV_FILE | ../.env.roster, sin override) → loadConfig → createApp → start; SIGINT/SIGTERM graceful (10 s)
  app.ts              ensamblado DI (createApp(cfg, deps)); deps inyectables para tests L2
  config.ts           AppConfig tipado + ConfigError (lista todos los problemas)
  server.ts           node:http: GET /health · POST /internal/whatsapp/webhook (401/400/413/200) · /api/* → apiRouter ·
                      SPA dist/web (solo index.html, /assets/*, públicos de raíz; fallback index.html fuera de /api,/internal,/health)
  web/auth.ts         cookie xroster_session HMAC-SHA256 (12 h), timingSafeEqual, rate-limit 5 fallos/IP/15 min, fail-closed 503
  web/apiRouter.ts    REST cpanel-roster: auth, overview, control/pause, quotas, alerts(+silence), approvals(confirm/cancel), audit
  core/
    jarvis.ts         auth E.164, dedup, comandos deterministas, router de intenciones, firma de agentes
    approvals.ts      L1: código TK-/SH-XXX, TTL 5 min, compare-and-set (idempotente)
    evolutionClient.ts guardrail ForbiddenTargetError ANTES de HTTP + neutralize()
    webhook.ts        contrato §5.2 estricto · phone.ts (54→549 igual xBackend)
    health.ts         evaluación determinista del hash Redis (heartbeat 90 s, canales, IRD)
    text.ts           truncate(4000) + neutralize() (regla No-Astra) · logger.ts JSON-lines
  db/
    store.ts          interfaz RosterStore + tipos de las 5 tablas
    pgStore.ts        pg.Pool → PG_XROSTER_URL; initSchema() aplica sql/001
    memoryStore.ts    implementación in-memory fiel (tests)
    tenantsRepo.ts    SELECT read-only parametrizado sobre public.tenants (pool con default_transaction_read_only)
  providers/
    providerRouter.ts ledger obligatorio, clasificación 429, getQuotaSummary() 5h/24h
    geminiAdapter.ts  @google/genai (gemini-2.5-flash) · claudeAdapter.ts (cli `claude -p` por stdin | api Messages)
  tools/
    commandRunner.ts  spawn sin shell, timeout SIGKILL, tope de salida
    ssh.ts            catálogo cerrado SafeCommand, timeout 8 s, truncado 4000
    ird.ts            GET http://100.64.N.2:20135/ → texto truncado
    monitoringSource.ts SCAN monitoring:tenant:* + HGETALL
    planningRepo.ts   clone/pull --ff-only, lectura segura, publishDraft (solo draft/shikamaru-*)
  agents/ sentinel.ts · tank.ts · shikamaru.ts
web/                         SPA cpanel-roster (Vite + React 18 + TS, sin libs de gráficos: SVG propio en components/UsageChart)
  src/api.ts                 fetch same-origin, 401 → Login global · views/{Login,Overview,Quotas,Alerts,Approvals}.tsx
deploy/nginx-roster.xisrv.xyz.conf  TLS + `location ^~ /internal/ { return 403; }` + proxy_pass 127.0.0.1:3900
sql/001_init_xrosterdb.sql   DDL idempotente (5 tablas, pgcrypto, JSONB, índices §5.1)
test/*.test.ts (npm test) · test/sql/*.test.ts (npm run test:sql, requiere TEST_PG_URL)
scripts/run-tests.mjs         runner portable (Linux/Windows, sin globs del shell)
```

## 3. Decisiones técnicas
- **Determinismo antes que LLM:** comandos, menciones (`@Tank`/`Tank`/`Sentinel`/`Shikamaru`) y la pista
  "caído/down/alertas" → Sentinel se resuelven sin LLM. Gemini solo clasifica lo ambiguo (`task_type=route`).
- **Dedup persistida:** `agent_audit_log.message_id UNIQUE`; `claimMessage()` inserta con estado
  transitorio `processing` y `completeMessage()` lo cierra en `ok|ignored|error|unauthorized`.
- **from_me / grupo ajeno:** se ignoran sin auditar (evita eco de mensajes propios).
- **Webhook responde 200 antes de procesar** (xBackend corta a 3 s); el despacho corre en `setImmediate`.
- **Approvals:** código de 3 dígitos; si hay colisiones repetidas amplía a 4/5 dígitos (no recicla códigos
  para preservar auditoría). Todo handler revalida su payload (defensa en profundidad).
- **Sentinel:** filas solo para componentes no-ok (sin bloat); silencio por tenant vía
  `system_flags['sentinel_silenced_until:{pos}']` + `silenced_until` en filas; global vía
  `sentinel_silenced_all_until`. Si falla el envío no marca `last_notified_at` → reintenta el próximo tick.
  `>SENTINEL_STORM_THRESHOLD` eventos en un tick → 1 mensaje consolidado (alertas + recuperaciones).
  RECUPERADO solo si la caída había sido notificada.
- **Sentinel — filtro de push WhatsApp:** todo componente se evalúa y persiste en `sentinel_alert_state`
  (cpanel-roster / "¿qué está caído?"), pero solo `SENTINEL_NOTIFY_COMPONENTS` (default `proxmox`) genera
  mensajes. Gracia desde `first_seen_at` antes del primer aviso: `SENTINEL_VM_GRACE_MS` (2 min, nodos) /
  `SENTINEL_IRD_GRACE_MS` (10 min, ird); recuperado antes de notificar → `ok` silencioso. Un cambio de severidad
  dentro de la gracia no reinicia ni adelanta el reloj. `SENTINEL_NOTIFY_REMINDERS=false` (default): sin
  "🔁 Sigue…"; solo `new`, `changed` (degraded↔down) y `✅ RECUPERADO`. Defaults espejados en `SentinelOptions`.
- **Tank:** rechaza cualquier intento de shell (metacaracteres, `rm`, `sudo`, `ejecutá`, …) con
  límites de palabra Unicode-aware (`\b` de JS rompe con acentos: "catálogo"). Restart =
  `systemctl restart <unit>` (`sudo -n` si `SSH_USER≠root`) + post-check `systemctl is-active`.
  Unidades override opcional `TANK_SERVICE_UNITS`. Síntesis IA opcional (Gemini) con evidencia ≤4000.
- **Shikamaru:** auth git por `GIT_CONFIG_*` (token nunca en argv); `assertSafePushArgs` bloquea
  `main`, `--force`, `--mirror`, `--delete`, `--all`; push con refspec explícito
  `refs/heads/draft/shikamaru-<slug>:refs/heads/draft/shikamaru-<slug>`; siempre vuelve a `main`.
- **Lookup de tenants:** `position::text = $1 OR tenantid = $1 OR tenantid = 'server'||$1 OR name ILIKE $2`
  (en `public.tenants` no existe columna `tag`; `tenantid` canónico es `server<position>`).
- **No-Astra:** `neutralize()` en ProviderRouter (prompts/salidas) y EvolutionClient (salida);
  test que escanea `src/`, `sql/` y `web/src/` + `web/index.html` exige cero menciones (ojo: es substring
  case-insensitive, palabras como "arr-astrar" también fallan).
- **cpanel-roster:** misma instancia `ApprovalManager` que WhatsApp (idempotente, TTL 5 min); fallo de Evolution
  al avisar al War Room no revierte ni devuelve 500. Overview tolera Redis/DB caídos (`down` por sección).
  CSRF: SameSite=Lax + chequeo `Origin == Host` en métodos no-GET. `X-Real-IP` solo se confía desde
  loopback/red privada (Nginx host / bridge Docker). Todo POST/PUT exige `content-type: application/json`.
- **Build web:** Vite emite `web/dist` (index.html + assets/); el Dockerfile (stage `web-builder`) lo copia a
  `/app/dist/web`, que convive con los módulos backend `dist/web/*.js` (nunca servidos: solo assets/ + index).
  Sin `dist/web/index.html` el servidor no sirve SPA (404) — en local: `cp -r web/dist/* dist/web/` o usar
  `cd web && npm run dev` (proxy `/api` → 127.0.0.1:3900).

## 4. Operación
- Entorno: `cp .env.example ../.env.roster` (hermano del repo, fuera de git). `docker-compose.yml` usa
  `env_file: ../.env.roster`; `src/index.ts` lo resuelve desde `cwd` (override `XROSTER_ENV_FILE`) sin pisar
  variables ya presentes en el entorno. Para interpolar `${PORT}`/`${XROSTER_BIND_ADDR}` en compose:
  `docker compose --env-file ../.env.roster up -d --build`.
- `npm run build && npm start` · `npm run dev` (tsx watch).
- La clave SSH se monta en `/run/secrets/ssh_key` (ro). Volúmenes: `/data/xPlanning`, `~/.claude` (login CLI).
- `CLAUDE_PROVIDER=cli` requiere `claude` autenticado dentro del contenedor (volumen `claude-home`).
- Redis/IRD/SSH vía red Tailscale `100.64.N.*`: el host Docker debe enrutar hacia esa red.
- `npm run test:sql`: `TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres` (crea y borra BD efímera).
- cpanel-roster: definir `ROSTER_WEB_USER/PASSWORD`, `ROSTER_SESSION_SECRET` (`openssl rand -hex 32`) y
  `ROSTER_COOKIE_SECURE` en `../.env.roster`. Nginx: copiar `deploy/nginx-roster.xisrv.xyz.conf` a
  `/etc/nginx/sites-available/roster.xisrv.xyz`, `certbot --nginx -d roster.xisrv.xyz`, `nginx -t && reload`.

## 5. Verificación (2026-11-24)
- `npx tsc --noEmit` → 0 errores. `npm test` → 200 tests, 200 pass, 0 fail (incluye auth/API web/store + No-Astra web
  + filtro de push/gracias de Sentinel).
- `npm run build` → OK. `cd web && npx tsc --noEmit && npm run build` → OK (~176 kB JS / 56 kB gzip).
- `npm run test:sql` → SKIP (sin `TEST_PG_URL` en el entorno de desarrollo).
- **No verificado aún:** `docker build`, `test:sql` contra PostgreSQL real y prueba visual del SPA contra API real.

## 6. Compromiso de completitud
- [ ] Ejecutar `npm run test:sql` contra PostgreSQL efímero y `docker build` (DoD §6.2).
- [ ] T-01 en `xBackend` (exclusión + forward firmado 3 s) — fuera de este repo.
- [ ] Crear rol `xroster_user` / BD `xrosterdb` y rol read-only para `PG_XSERVER_RO_URL`.
- [ ] Validar nombres reales de unidades systemd (xmanager/multicast/streamer) en una cabecera.
- [ ] Actualizar `Planning-X/Memory/INDEX.md` con este servicio.
- Regla: este archivo ≤150 líneas; consolidar en vez de acumular.
