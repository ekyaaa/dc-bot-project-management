-- =============================================================================
-- Migration: 001_initial_schema.sql
-- Description: Core tables and indexes for Discord Project Management Bot
-- Tables: identity_links, oauth_states, outbox_deliveries, audit_logs, schedule_leases
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Identity Links Table
-- Maps Discord User ID to verified GitHub Numeric User ID with encrypted OAuth token
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_links (
  discord_user_id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL UNIQUE,
  github_username TEXT NOT NULL,
  application_role TEXT NOT NULL DEFAULT 'Developer',
  encrypted_token TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  token_scopes TEXT,
  linked_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_links_github_user_id ON identity_links(github_user_id);
CREATE INDEX IF NOT EXISTS idx_identity_links_role ON identity_links(application_role);
CREATE INDEX IF NOT EXISTS idx_identity_links_username ON identity_links(github_username);

-- -----------------------------------------------------------------------------
-- 2. OAuth States Table
-- Stores temporary nonce tokens, PKCE verifiers, and expiration for CSRF protection
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state_nonce TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  code_verifier TEXT,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_discord_user ON oauth_states(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_active ON oauth_states(state_nonce, consumed, expires_at);

-- -----------------------------------------------------------------------------
-- 3. Outbox Deliveries Table
-- Durable queue & deduplication store for GitHub webhook deliveries (X-GitHub-Delivery)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  processed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_deliveries_delivery_id ON outbox_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_status ON outbox_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_pending ON outbox_deliveries(status, id ASC);
CREATE INDEX IF NOT EXISTS idx_outbox_deliveries_created_at ON outbox_deliveries(created_at);

-- -----------------------------------------------------------------------------
-- 4. Audit Logs Table
-- Mutation history for actions modifying GitHub state (actor, diff, outcome)
-- Never contains tokens, credentials, or private keys
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_discord_id TEXT NOT NULL,
  actor_github_id INTEGER,
  actor_github_login TEXT,
  action TEXT NOT NULL,
  target_issue_number INTEGER,
  before_state TEXT,
  after_state TEXT,
  outcome TEXT NOT NULL,
  error_reason TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_discord ON audit_logs(actor_discord_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_issue ON audit_logs(target_issue_number);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- -----------------------------------------------------------------------------
-- 5. Schedule Leases Table
-- Distributed locking and daily digest execution idempotency across restarts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_leases (
  lease_key TEXT PRIMARY KEY,
  job_key TEXT,
  date_str TEXT,
  holder TEXT,
  acquired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_schedule_leases_expires_at ON schedule_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_schedule_leases_job_date ON schedule_leases(job_key, date_str);
