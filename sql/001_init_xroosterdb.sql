-- xroosterdb — esquema inicial (REQ-2026-012 §5.1). Idempotente: se puede aplicar N veces.
-- Base dedicada y aislada (rol xrooster_user). Cero tablas en xServerSQL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.quota_usage_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    agent_name TEXT NOT NULL,            -- 'jarvis' | 'sentinel' | 'tank' | 'shikamaru'
    provider TEXT NOT NULL,              -- 'gemini' | 'claude'
    model TEXT NOT NULL,
    task_type TEXT NOT NULL,             -- 'route' | 'summary' | 'diagnose' | 'planning'
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,                -- 'ok' | 'error' | 'rate_limited'
    rate_limited BOOLEAN NOT NULL DEFAULT FALSE,
    error_code TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_quota_provider_created
    ON public.quota_usage_ledger (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quota_agent_created
    ON public.quota_usage_ledger (agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS public.action_approvals (
    code TEXT PRIMARY KEY,               -- ej. 'TK-482', 'SH-109'
    agent_name TEXT NOT NULL,
    action_type TEXT NOT NULL,           -- 'restart_service' | 'git_push_draft'
    target_tenant TEXT,
    summary_text TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed' | 'failed'
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    result_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_expires
    ON public.action_approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS public.sentinel_alert_state (
    alert_key TEXT PRIMARY KEY,          -- '{position}:{component}' ej. '43:xmanager', '43:ird'
    tenant_position TEXT NOT NULL,
    tenant_name TEXT,
    component TEXT NOT NULL,
    state TEXT NOT NULL,                 -- 'ok' | 'degraded' | 'down'
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_notified_at TIMESTAMPTZ,
    silenced_until TIMESTAMPTZ,
    last_detail TEXT,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sentinel_state_tenant
    ON public.sentinel_alert_state (state, tenant_position);

CREATE TABLE IF NOT EXISTS public.agent_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_id TEXT UNIQUE,
    sender_phone TEXT,
    agent_name TEXT,
    input_text TEXT,
    output_text TEXT,
    duration_ms INTEGER,
    status TEXT NOT NULL,                -- 'ok' | 'ignored' | 'error' | 'unauthorized' ('processing' transitorio durante el despacho)
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_audit_created
    ON public.agent_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin
    ON public.agent_audit_log USING GIN (metadata);

CREATE TABLE IF NOT EXISTS public.system_flags (
    key TEXT PRIMARY KEY,                -- 'paused' | 'sentinel_silenced_all_until' | 'sentinel_silenced_until:{position}'
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
