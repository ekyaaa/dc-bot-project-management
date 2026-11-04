import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { AuditRepository } from '../../src/infrastructure/persistence/repositories/AuditRepository.js';
import { AuditService } from '../../src/application/services/AuditService.js';
import { AuthorizationService } from '../../src/application/services/AuthorizationService.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import {
  ConfirmationStore,
  handleConfirmationInteraction,
  type PendingConfirmationSession,
} from '../../src/interfaces/discord/confirmations.js';
import {
  createMockButtonInteraction,
} from '../mocks/MockDiscordInteraction.js';
import { ValidationError } from '../../src/domain/errors.js';

describe('Discord Two-Phase Actor-Bound Confirmations', () => {
  let db: DatabaseInstance;
  let identityRepo: IdentityRepository;
  let auditRepo: AuditRepository;
  let auditService: AuditService;
  let mockGitHubService: MockGitHubService;
  let authService: AuthorizationService;
  let confirmationStore: ConfirmationStore;

  const config = {
    DISCORD_GUILD_ID: 'guild_allowlist_123',
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_alerts_456',
    BOT_WRITE_ACTIONS_ENABLED: true,
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();

    identityRepo = new IdentityRepository(db);
    auditRepo = new AuditRepository(db);
    auditService = new AuditService(auditRepo);
    mockGitHubService = new MockGitHubService();
    authService = new AuthorizationService(identityRepo, mockGitHubService, config);
    confirmationStore = new ConfirmationStore();

    // Link test users in SQLite
    await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
    await identityRepo.linkIdentity('discord_bob', 1002, 'bob');
    await identityRepo.linkIdentity('discord_maintainer', 1003, 'maintainer_dan');

    mockGitHubService.collaborators.set('alice', 'write');
    mockGitHubService.collaborators.set('bob', 'write');
    mockGitHubService.collaborators.set('maintainer_dan', 'maintain');
  });

  afterEach(() => {
    confirmationStore.destroy();
    if (db.open) db.close();
  });

  it('rejects button click from unauthorized actor with ephemeral reply (Actor Binding)', async () => {
    const timestamp = Date.now();
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `status:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'status',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'Done',
        expectedPreviousStatus: 'In Progress',
      },
    };
    confirmationStore.set(sessionKey, session);

    // Intruder 'discord_bob' clicks Alice's confirmation button
    const intruderInteraction = createMockButtonInteraction(
      `confirm:status:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_bob', username: 'bob' },
    );

    const handled = await handleConfirmationInteraction(intruderInteraction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(intruderInteraction.replied).toBe(true);
    expect(intruderInteraction.ephemeral).toBe(true);
    expect(intruderInteraction.replyPayload.content).toContain('Akses Ditolak');
    expect(intruderInteraction.replyPayload.content).toContain('discord_alice');
    expect(intruderInteraction.updated).toBe(false);

    // Session remains intact for Alice
    expect(confirmationStore.get(sessionKey)).toBeDefined();
    // GitHub was not mutated
    expect(mockGitHubService.statusTransitions).toHaveLength(0);
  });

  it('rejects confirmation click after 60-second TTL expiration', async () => {
    const pastTimestamp = Date.now() - 65_000; // 65 seconds ago
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `status:${issueNumber}:${callerDiscordId}:${pastTimestamp}`;

    const session: PendingConfirmationSession = {
      action: 'status',
      issueNumber,
      callerDiscordId,
      timestamp: pastTimestamp,
      expiresAt: pastTimestamp + 60_000,
      payload: {
        targetStatus: 'Done',
        expectedPreviousStatus: 'In Progress',
      },
    };
    confirmationStore.set(sessionKey, session);

    const interaction = createMockButtonInteraction(
      `confirm:status:${issueNumber}:${callerDiscordId}:${pastTimestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    const handled = await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Konfirmasi Kedaluwarsa');
    expect(interaction.updatePayload.components).toEqual([]);

    // Session should be removed
    expect(confirmationStore.get(sessionKey)).toBeUndefined();
    expect(mockGitHubService.statusTransitions).toHaveLength(0);
  });

  it('cancels action cleanly when Cancel button is clicked', async () => {
    const timestamp = Date.now();
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `status:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'status',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'Done',
        expectedPreviousStatus: 'In Progress',
      },
    };
    confirmationStore.set(sessionKey, session);

    const cancelInteraction = createMockButtonInteraction(
      `cancel:status:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    const handled = await handleConfirmationInteraction(cancelInteraction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(cancelInteraction.updated).toBe(true);
    expect(cancelInteraction.updatePayload.embeds[0].data.title).toContain('Aksi Dibatalkan');
    expect(cancelInteraction.updatePayload.components).toEqual([]);

    // Session removed
    expect(confirmationStore.get(sessionKey)).toBeUndefined();
    // No mutation executed
    expect(mockGitHubService.statusTransitions).toHaveLength(0);
  });

  it('detects concurrency conflict (anti-stale re-fetch) on status change and aborts mutation', async () => {
    const timestamp = Date.now();
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `status:${issueNumber}:${callerDiscordId}:${timestamp}`;

    // Session expects 'In Progress'
    const session: PendingConfirmationSession = {
      action: 'status',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'Done',
        expectedPreviousStatus: 'In Progress',
      },
    };
    confirmationStore.set(sessionKey, session);

    // Simulate remote state changed to 'Blocked' between preview and confirm
    const issue = mockGitHubService.issues.get(issueNumber)!;
    issue.projectStatus = 'Blocked';

    const interaction = createMockButtonInteraction(
      `confirm:status:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    const handled = await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Konflik Konkurensi Terdeteksi');
    expect(interaction.updatePayload.embeds[0].data.description).toContain('Blocked');
    expect(interaction.updatePayload.components).toEqual([]);

    // State remains Blocked (not overwritten to Done)
    expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('Blocked');
    expect(confirmationStore.get(sessionKey)).toBeUndefined();
  });

  it('detects concurrency conflict on priority change and aborts mutation', async () => {
    const timestamp = Date.now();
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `priority:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'priority',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetPriority: 'Urgent',
        expectedPreviousPriority: 'High',
      },
    };
    confirmationStore.set(sessionKey, session);

    // Remote changed to Medium
    const issue = mockGitHubService.issues.get(issueNumber)!;
    issue.projectPriority = 'Medium';

    const interaction = createMockButtonInteraction(
      `confirm:priority:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Konflik Konkurensi Terdeteksi');
    expect(mockGitHubService.issues.get(issueNumber)!.projectPriority).toBe('Medium');
  });

  it('successfully confirms status update: executes mutation, logs audit, and delivers success card', async () => {
    const timestamp = Date.now();
    const issueNumber = 1; // Initially 'In Progress'
    const callerDiscordId = 'discord_alice';
    const sessionKey = `status:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'status',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'In Review',
        expectedPreviousStatus: 'In Progress',
      },
    };
    confirmationStore.set(sessionKey, session);

    const interaction = createMockButtonInteraction(
      `confirm:status:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    const handled = await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Berhasil Diperbarui');
    expect(interaction.updatePayload.components).toEqual([]);

    // Verify remote mutation in GitHub mock
    expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Review');
    expect(mockGitHubService.statusTransitions).toHaveLength(1);
    expect(mockGitHubService.statusTransitions[0]!.status).toBe('In Review');

    // Verify audit log
    const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_STATUS_UPDATE') as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_discord_id).toBe('discord_alice');
    expect(auditRows[0].target_issue_number).toBe(1);
    expect(auditRows[0].outcome).toBe('SUCCESS');
  });

  it('successfully confirms assign mutation: updates assignee and logs audit', async () => {
    const timestamp = Date.now();
    const issueNumber = 3; // Unassigned
    const callerDiscordId = 'discord_maintainer';
    const sessionKey = `assign:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'assign',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetAssignee: 'alice',
        expectedPreviousAssignees: [],
      },
    };
    confirmationStore.set(sessionKey, session);

    const interaction = createMockButtonInteraction(
      `confirm:assign:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_maintainer', username: 'maintainer_dan' },
    );

    await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Berhasil Diperbarui');

    expect(mockGitHubService.issues.get(issueNumber)!.assignees).toContain('alice');
    expect(mockGitHubService.assignCalls).toHaveLength(1);

    const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_ASSIGN') as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_github_login).toBe('maintainer_dan');
  });

  it('successfully confirms block mutation: marks blocked and posts blocker comment', async () => {
    const timestamp = Date.now();
    const issueNumber = 1; // assigned to alice
    const callerDiscordId = 'discord_alice';
    const sessionKey = `block:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'block',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'Blocked',
        expectedPreviousStatus: 'In Progress',
        blockerReason: 'Waiting for 3rd party API key approval',
      },
    };
    confirmationStore.set(sessionKey, session);

    const interaction = createMockButtonInteraction(
      `confirm:block:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Berhasil Diperbarui');

    // Verify issue marked Blocked and reason comment added
    expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('Blocked');
    expect(mockGitHubService.blockedActions).toHaveLength(1);
    expect(mockGitHubService.commentsAdded).toHaveLength(1);
    expect(mockGitHubService.commentsAdded[0]!.text).toContain('Waiting for 3rd party API key approval');
  });

  it('handles missing session on button click with friendly embed', async () => {
    const timestamp = Date.now();
    const interaction = createMockButtonInteraction(
      `confirm:status:1:discord_alice:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    const handled = await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(handled).toBe(true);
    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Sesi Konfirmasi Tidak Ditemukan');
  });

  it('detects concurrency conflict on block when remote status was modified', async () => {
    const timestamp = Date.now();
    const issueNumber = 1;
    const callerDiscordId = 'discord_alice';
    const sessionKey = `block:${issueNumber}:${callerDiscordId}:${timestamp}`;

    const session: PendingConfirmationSession = {
      action: 'block',
      issueNumber,
      callerDiscordId,
      timestamp,
      expiresAt: timestamp + 60_000,
      payload: {
        targetStatus: 'Blocked',
        expectedPreviousStatus: 'In Progress',
        blockerReason: 'Waiting for keys',
      },
    };
    confirmationStore.set(sessionKey, session);

    // Remote changed to Done
    mockGitHubService.issues.get(issueNumber)!.projectStatus = 'Done';

    const interaction = createMockButtonInteraction(
      `confirm:block:${issueNumber}:${callerDiscordId}:${timestamp}`,
      { id: 'discord_alice', username: 'alice' },
    );

    await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    expect(interaction.updated).toBe(true);
    expect(interaction.updatePayload.embeds[0].data.title).toContain('Konflik Konkurensi Terdeteksi');
    expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('Done');
  });

  it('returns false when customId is not a confirmation or cancellation button', async () => {
    const interaction = createMockButtonInteraction('some_random_button_id');
    const handled = await handleConfirmationInteraction(interaction as any, {
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });
    expect(handled).toBe(false);
  });

  it('throws ValidationError when customId is malformed', async () => {
    const interaction = createMockButtonInteraction('confirm:status');
    await expect(
      handleConfirmationInteraction(interaction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
