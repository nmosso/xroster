# MEMORY — `xRoster` (Fase 1)

| Metadato | Detalle |
| :--- | :--- |
| **Spec** | `REQ-2026-012` (02_Aprobado) · RFC `RFC-2026-003` |
| **Estado** | T-02..T-08 implementadas · `tsc --noEmit` limpio · `npm test` 143/143 verde |
| **Última actualización** | 2026-11-24 |
| **Pendiente fuera de este repo** | T-01 (forward en `xBackend`) · actualizar `Planning-X/Memory/INDEX.md` |

## 1. Qué es
Microservicio Docker (1.0 vCPU / 1536 MB) que conecta el grupo War Room de WhatsApp con 4 agentes:
**Jarvis** (orquestador), **Sentinel** (QoS), **Tank** (infra) y **Shikamaru** (planificación SDD).
Todo por `.env` → portable a VM dedicada sin cambios de código.

## 2. Mapa del código
```
src/
  index.ts            entrada: dotenv → loadConfig → createApp → start; SIGINT/SIGTERM graceful (10 s)
  app.ts              ensamblado DI (createApp(cfg, deps)); deps inyectables para tests L2
  config.ts           AppConfig tipado + ConfigError (lista todos los problemas)
  server.ts           node:http: GET /health · POST /internal/whatsapp/webhook (401/400/413/200)
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
  test que escanea `src/` y `sql/` exige cero menciones.

## 4. Operación
- `npm run build && npm start` · `npm run dev` (tsx watch) · `docker compose up -d --build`.
- La clave SSH se monta en `/run/secrets/ssh_key` (ro). Volúmenes: `/data/xPlanning`, `~/.claude` (login CLI).
- `CLAUDE_PROVIDER=cli` requiere `claude` autenticado dentro del contenedor (volumen `claude-home`).
- Redis/IRD/SSH vía red Tailscale `100.64.N.*`: el host Docker debe enrutar hacia esa red.
- `npm run test:sql`: `TEST_PG_URL=postgres://postgres:postgres@localhost:5432/postgres` (crea y borra BD efímera).

## 5. Verificación (2026-11-24)
- `npx tsc --noEmit` → 0 errores. `npm test` → 143 tests, 143 pass, 0 fail.
- `npm run build` → OK. `npm run test:sql` → SKIP (sin `TEST_PG_URL` en el entorno de desarrollo).
- **No verificado aún:** `docker build` y `test:sql` contra PostgreSQL real (no disponibles en la sesión).

## 6. Compromiso de completitud
- [ ] Ejecutar `npm run test:sql` contra PostgreSQL efímero y `docker build` (DoD §6.2).
- [ ] T-01 en `xBackend` (exclusión + forward firmado 3 s) — fuera de este repo.
- [ ] Crear rol `xroster_user` / BD `xrosterdb` y rol read-only para `PG_XSERVER_RO_URL`.
- [ ] Validar nombres reales de unidades systemd (xmanager/multicast/streamer) en una cabecera.
- [ ] Actualizar `Planning-X/Memory/INDEX.md` con este servicio.
- Regla: este archivo ≤150 líneas; consolidar en vez de acumular.
