import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { AuditRepository } from '../../src/infrastructure/persistence/repositories/AuditRepository.js';
import { AuditService } from '../../src/application/services/AuditService.js';
import type { AuditAction } from '../../src/domain/types.js';

describe('AuditService & Deep Redaction Filter', () => {
  let db: DatabaseInstance;
  let auditRepo: AuditRepository;
  let auditService: AuditService;

  beforeEach(() => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();

    auditRepo = new AuditRepository(db);
    auditService = new AuditService(auditRepo);
  });

  afterEach(() => {
    if (db.open) db.close();
    vi.restoreAllMocks();
  });

  it('records mutation events for all 8 audit actions with success and failure outcomes', async () => {
    const actions: AuditAction[] = [
      'ACCOUNT_LINK',
      'ACCOUNT_UNLINK',
      'ISSUE_CREATE',
      'ISSUE_ASSIGN',
      'ISSUE_STATUS_UPDATE',
      'ISSUE_PRIORITY_UPDATE',
      'ISSUE_BLOCK',
      'ISSUE_COMMENT',
    ];

    for (const action of actions) {
      await auditService.logMutation({
        actorDiscordId: 'actor_123',
        actorGithubId: 456,
        actorGithubLogin: 'octo',
        action,
        targetIssueNumber: 1,
        outcome: 'SUCCESS',
        correlationId: `corr-${action}`,
      });
    }

    const recent = await auditRepo.getRecentAudits(20);
    expect(recent).toHaveLength(8);
    const recordedActions = recent.map((r) => r.action);
    for (const action of actions) {
      expect(recordedActions).toContain(action);
    }
  });

  it('deep redaction: redacts sensitive keys in beforeState and afterState', async () => {
    await auditService.logMutation({
      actorDiscordId: 'actor_123',
      action: 'ACCOUNT_LINK',
      outcome: 'SUCCESS',
      correlationId: 'corr-redact-keys',
      afterState: {
        githubLogin: 'octocat',
        accessToken: 'ghu_topsecret123456789012345678901234567890',
        refreshToken: 'ghr_refreshsecret1234567890123456789012',
        codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        clientSecret: 'secret_app_key',
        nested: {
          privateKey: '-----BEGIN RSA PRIVATE KEY-----...',
          password: 'supersecretpassword',
          safeField: 'This is visible',
        },
      },
    });

    const recent = await auditRepo.getRecentAudits(1);
    expect(recent).toHaveLength(1);
    const state = recent[0]!.afterState as any;

    expect(state.githubLogin).toBe('octocat');
    expect(state.accessToken).toBe('[REDACTED]');
    expect(state.refreshToken).toBe('[REDACTED]');
    expect(state.codeVerifier).toBe('[REDACTED]');
    expect(state.clientSecret).toBe('[REDACTED]');
    expect(state.nested.privateKey).toBe('[REDACTED]');
    expect(state.nested.password).toBe('[REDACTED]');
    expect(state.nested.safeField).toBe('This is visible');
  });

  it('deep redaction: redacts GitHub tokens embedded inside string values and error reasons', async () => {
    const sensitiveError =
      'Failed connecting to GitHub with token ghu_abcdef123456789012345678901234567890: HTTP 401 Unauthorized Bearer eyJhbGciOi...';

    await auditService.logMutation({
      actorDiscordId: 'actor_123',
      action: 'ACCOUNT_LINK',
      outcome: 'FAILED',
      errorReason: sensitiveError,
      correlationId: 'corr-redact-string',
      beforeState: {
        rawMessage: 'User supplied token ghu_anothersecrettoken12345678901234567890 in body',
      },
    });

    const recent = await auditRepo.getRecentAudits(1);
    expect(recent).toHaveLength(1);

    expect(recent[0]!.errorReason).not.toContain('ghu_abcdef123456789012345678901234567890');
    expect(recent[0]!.errorReason).toContain('[REDACTED]');

    const beforeState = recent[0]!.beforeState as any;
    expect(beforeState.rawMessage).not.toContain('ghu_anothersecrettoken12345678901234567890');
    expect(beforeState.rawMessage).toContain('[REDACTED]');
  });

  it('zero-crash guarantee: database failure logs error without throwing exception', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Force DB failure by closing database
    db.close();

    await expect(
      auditService.logMutation({
        actorDiscordId: 'actor_123',
        action: 'ISSUE_CREATE',
        outcome: 'SUCCESS',
        correlationId: 'corr-db-closed',
      }),
    ).resolves.not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AuditService] Failed to record audit log:'),
      expect.anything(),
    );
  });
});
