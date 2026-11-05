-- =============================================================================
-- Migration: 002_multi_project_schema.sql
-- Description: Multi-project GitHub management and guild permission bindings
-- Tables: projects, guild_project_permissions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Projects Table
-- Stores registered GitHub repositories and their Projects v2 board numbers
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  project_number INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_repo ON projects(github_owner, github_repo);

-- -----------------------------------------------------------------------------
-- 2. Guild Project Permissions Table
-- Maps Discord Guilds (Server IDs) to allowed projects & default notification channels
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_project_permissions (
  guild_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  notification_channel_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (guild_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_project_permissions_guild ON guild_project_permissions(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_project_permissions_project ON guild_project_permissions(project_id);

-- -----------------------------------------------------------------------------
-- 3. Automatic Seeding for Existing Active Server & Project
-- Preserves current active Eva Ecosystem deployment without disruption
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO projects (id, name, github_owner, github_repo, project_number, description)
VALUES ('eva-ecosystem', 'Eva Ecosystem', 'Nexa-Code-Studio', 'eva-ecosystem', 2, 'Main Eva Ecosystem Repository & Project Board');

INSERT OR IGNORE INTO guild_project_permissions (guild_id, project_id, notification_channel_id, is_default)
VALUES ('1374691978230366240', 'eva-ecosystem', '1567466308789076048', 1);
