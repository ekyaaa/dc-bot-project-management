import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { DatabaseManager } from '../../src/infrastructure/persistence/database.js';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import {
  IdentityRepository,
  OAuthStateRepository,
  OutboxRepository,
  ScheduleRepository,
  AuditRepository,
} from '../../src/infrastructure/persistence/repositories/index.js';

describe('Persistence Layer: SQLite, Migrations, and Repositories', () => {
  let db: DatabaseInstance;

  beforeEach(() => {
    db = new Database(':memory:');
    const migrator = new Migrator(db);
    migrator.runMigrations();
  });

  afterEach(() => {
    if (db && db.open) {
      db.close();
    }
  });

  describe('DatabaseManager & Migrator', () => {
    it('initializes DatabaseManager and confirms healthy alive status', () => {
      const manager = new DatabaseManager({ databasePath: ':memory:' });
      expect(manager.healthCheck()).toBe(true);
      manager.close();
      expect(manager.healthCheck()).toBe(false);
    });

    it('creates all required schema tables and indexes on first migration', () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;")
        .all() as { name: string }[];
      const tableNames = rows.map((r) => r.name);

      expect(tableNames).toContain('_migrations');
      expect(tableNames).toContain('identity_links');
      expect(tableNames).toContain('oauth_states');
      expect(tableNames).toContain('outbox_deliveries');
      expect(tableNames).toContain('audit_logs');
      expect(tableNames).toContain('schedule_leases');
    });

    it('ensures migration runner is strictly idempotent on subsequent runs', () => {
      const migrator = new Migrator(db);
      const secondRun = migrator.runMigrations();
      expect(secondRun).toHaveLength(0);
      expect(migrator.getPendingMigrations()).toHaveLength(0);
    });
  });

  describe('IdentityRepository', () => {
    it('links, retrieves, updates, and unlinks user identity records', async () => {
      const repo = new IdentityRepository(db);
      const discordId = 'discord-user-123';
      const githubId = 987654;
      const githubLogin = 'octocat';
      const token = {
        ivHex: 'a'.repeat(24),
        authTagHex: 'b'.repeat(32),
        ciphertextHex: 'c'.repeat(32),
      };

      // Link identity
      await repo.linkIdentity(discordId, githubId, githubLogin, token);

      // Find by Discord ID
      const byDiscord = await repo.findByDiscordId(discordId);
      expect(byDiscord).not.toBeNull();
      expect(byDiscord?.discordUserId).toBe(discordId);
      expect(byDiscord?.githubUserId).toBe(githubId);
      expect(byDiscord?.githubUsername).toBe(githubLogin);
      expect(byDiscord?.applicationRole).toBe('Developer');
      expect(byDiscord?.encryptedToken).toEqual(token);

      // Find by GitHub ID
      const byGithub = await repo.findByGithubId(githubId);
      expect(byGithub?.discordUserId).toBe(discordId);

      // Upsert update
      await repo.linkIdentity(discordId, githubId, 'octocat-renamed', token);
      const updated = await repo.findByDiscordId(discordId);
      expect(updated?.githubUsername).toBe('octocat-renamed');

      // Unlink
      const unlinked = await repo.unlinkIdentity(discordId);
      expect(unlinked).toBe(true);

      const afterUnlink = await repo.findByDiscordId(discordId);
      expect(afterUnlink).toBeNull();

      // Second unlink returns false
      const unlinkedAgain = await repo.unlinkIdentity(discordId);
      expect(unlinkedAgain).toBe(false);
    });
  });

  describe('OAuthStateRepository', () => {
    it('creates, consumes single-use state, and rejects replays or expired states', async () => {
      const repo = new OAuthStateRepository(db);
      const state = 'secure-state-nonce-12345';
      const discordId = 'user-discord-99';
      const guildId = 'guild-discord-88';
      const codeVerifier = 'pkce-verifier-test-string-abc';

      // Create 10-minute session
      await repo.createSession(state, discordId, guildId, codeVerifier, 600);

      // Consume session once
      const consumed = await repo.consumeSession(state);
      expect(consumed).not.toBeNull();
      expect(consumed?.state).toBe(state);
      expect(consumed?.discordUserId).toBe(discordId);
      expect(consumed?.guildId).toBe(guildId);
      expect(consumed?.codeVerifier).toBe(codeVerifier);
      expect(consumed?.consumed).toBe(true);

      // Attempt replay -> returns null
      const replay = await repo.consumeSession(state);
      expect(replay).toBeNull();

      // Expired state -> returns null
      const expiredState = 'expired-nonce-xyz';
      await repo.createSession(expiredState, discordId, guildId, codeVerifier, -1);
      const expiredAttempt = await repo.consumeSession(expiredState);
      expect(expiredAttempt).toBeNull();
    });
  });

  describe('OutboxRepository', () => {
    it('enqueues, deduplicates, fetches pending, and marks processed / failed', async () => {
      const repo = new OutboxRepository(db);
      const deliveryId = 'gh-delivery-uuid-001';
      const eventType = 'issues';
      const payload = JSON.stringify({ action: 'opened', issue: { number: 10 } });

      // First enqueue succeeds
      const enqueued = await repo.enqueueDelivery(deliveryId, eventType, payload);
      expect(enqueued).toBe(true);

      // Duplicate delivery ID deduplicated
      const duplicate = await repo.enqueueDelivery(deliveryId, eventType, payload);
      expect(duplicate).toBe(false);

      // Fetch pending deliveries
      const pending = await repo.fetchPendingDeliveries(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.deliveryId).toBe(deliveryId);
      expect(pending[0]!.status).toBe('PENDING');
      expect(pending[0]!.attempts).toBe(0);

      // Record failure
      await repo.recordFailure(pending[0]!.id, 'Network timeout', 3);
      const failed = await repo.fetchPendingDeliveries(10);
      expect(failed[0]!.attempts).toBe(1);
      expect(failed[0]!.lastError).toBe('Network timeout');

      // Record failure up to maxAttempts -> DEAD_LETTER
      await repo.recordFailure(pending[0]!.id, 'Fatal error', 2);
      const afterDeadLetter = await repo.fetchPendingDeliveries(10);
      expect(afterDeadLetter).toHaveLength(0); // Status is DEAD_LETTER, not PENDING

      // Mark processed
      await repo.enqueueDelivery('gh-delivery-002', eventType, payload);
      const [secondPending] = await repo.fetchPendingDeliveries(10);
      await repo.markProcessed(secondPending!.id);

      const remaining = await repo.fetchPendingDeliveries(10);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('ScheduleRepository', () => {
    it('manages distributed lease locks and daily digest restart idempotency', async () => {
      const repo = new ScheduleRepository(db);
      const leaseKey = 'digest_lease_lock';

      // First acquire succeeds
      const acquired1 = await repo.acquireLease(leaseKey, 60);
      expect(acquired1).toBe(true);

      // Concurrent acquire while active fails
      const acquiredConcurrent = await repo.acquireLease(leaseKey, 60);
      expect(acquiredConcurrent).toBe(false);

      // Acquire after expiration succeeds
      db.prepare("UPDATE schedule_leases SET expires_at = datetime('now', '-10 seconds') WHERE lease_key = ?").run(leaseKey);
      const acquiredAfterExpire = await repo.acquireLease(leaseKey, 60);
      expect(acquiredAfterExpire).toBe(true);

      // Daily digest date check and record
      const jobKey = 'daily_digest';
      const dateStr = '2026-11-03';

      expect(await repo.isExecutedForDate(jobKey, dateStr)).toBe(false);

      await repo.recordExecution(jobKey, dateStr);

      expect(await repo.isExecutedForDate(jobKey, dateStr)).toBe(true);
    });
  });

  describe('AuditRepository', () => {
    it('records structured audit events and retrieves mutation history', async () => {
      const repo = new AuditRepository(db);
      await repo.recordAudit({
        actorDiscordId: 'user-discord-1',
        actorGithubId: 101,
        actorGithubLogin: 'lead-dev',
        action: 'ISSUE_STATUS_UPDATE',
        targetIssueNumber: 15,
        beforeState: { status: 'In Progress' },
        afterState: { status: 'In Review' },
        outcome: 'SUCCESS',
        correlationId: 'interaction-corr-001',
      });

      const audits = await repo.getRecentAudits(10);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorDiscordId).toBe('user-discord-1');
      expect(audits[0]!.actorGithubLogin).toBe('lead-dev');
      expect(audits[0]!.action).toBe('ISSUE_STATUS_UPDATE');
      expect(audits[0]!.targetIssueNumber).toBe(15);
      expect(audits[0]!.beforeState).toEqual({ status: 'In Progress' });
      expect(audits[0]!.afterState).toEqual({ status: 'In Review' });
      expect(audits[0]!.outcome).toBe('SUCCESS');
      expect(audits[0]!.correlationId).toBe('interaction-corr-001');
    });
  });
});
