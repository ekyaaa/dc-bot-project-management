import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { AuditRepository } from '../../src/infrastructure/persistence/repositories/AuditRepository.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { AuthorizationService } from '../../src/application/services/AuthorizationService.js';
import { AuditService } from '../../src/application/services/AuditService.js';
import {
  ConfirmationStore,
  handleConfirmationInteraction,
  type PendingConfirmationSession,
} from '../../src/interfaces/discord/confirmations.js';
import {
  handleIssueBlockCommand,
  handleIssueStatusCommand,
  handleIssuePriorityCommand,
  handleIssueAssignCommand,
} from '../../src/interfaces/discord/commands/writeHandlers.js';
import {
  createMockButtonInteraction,
  createMockChatInputInteraction,
} from '../mocks/MockDiscordInteraction.js';
import { ValidationError, ConflictError, UnauthorizedError } from '../../src/domain/errors.js';
import { StatusTransitionPolicy } from '../../src/domain/policies.js';

describe('Adversarial Verification 2: Confirmation Stealing, 60s TTL Race & Concurrency Stale-State Conflict', () => {
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

    // Link test identities in SQLite
    await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
    await identityRepo.linkIdentity('discord_bob', 1002, 'bob');
    await identityRepo.linkIdentity('discord_eve', 1004, 'eve_intruder');
    await identityRepo.linkIdentity('discord_maintainer', 1003, 'maintainer_dan');

    mockGitHubService.collaborators.set('alice', 'write');
    mockGitHubService.collaborators.set('bob', 'write');
    mockGitHubService.collaborators.set('eve_intruder', 'write');
    mockGitHubService.collaborators.set('maintainer_dan', 'maintain');
  });

  afterEach(() => {
    confirmationStore.destroy();
    if (db.open) db.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. CONFIRMATION STEALING (ACTOR BINDING ADVERSARIAL CHALLENGES)
  // =========================================================================
  describe('1. Confirmation Stealing & Actor Binding Enforcement', () => {
    it('strictly rejects when User B clicks the Confirm button created for User A (ephemeral denial)', async () => {
      const timestamp = Date.now();
      const issueNumber = 1; // Initially 'In Progress'
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      const session: PendingConfirmationSession = {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      };
      confirmationStore.set(sessionKey, session);

      // Intruding user Eve attempts to click Confirm button
      const eveInteraction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_eve', username: 'eve_intruder' },
      );

      const handled = await handleConfirmationInteraction(eveInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(handled).toBe(true);
      expect(eveInteraction.replied).toBe(true);
      expect(eveInteraction.ephemeral).toBe(true);
      expect(eveInteraction.replyPayload.content).toContain('Akses Ditolak');
      expect(eveInteraction.replyPayload.content).toContain('discord_alice');
      expect(eveInteraction.updated).toBe(false);

      // Verify User A's session remains completely unharmed in the store
      const storedSession = confirmationStore.get(sessionKey);
      expect(storedSession).toBeDefined();
      expect(storedSession?.callerDiscordId).toBe('discord_alice');

      // Verify no mutation occurred on GitHub
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Progress');

      // Verify zero audit records created for intruder
      const auditRows = db.prepare('SELECT * FROM audit_logs').all();
      expect(auditRows).toHaveLength(0);
    });

    it('strictly rejects when User B attempts to click the Cancel button created for User A', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      const session: PendingConfirmationSession = {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      };
      confirmationStore.set(sessionKey, session);

      // Intruding user Bob attempts to click Cancel button
      const bobCancelInteraction = createMockButtonInteraction(
        `cancel:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_bob', username: 'bob' },
      );

      const handled = await handleConfirmationInteraction(bobCancelInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(handled).toBe(true);
      expect(bobCancelInteraction.replied).toBe(true);
      expect(bobCancelInteraction.ephemeral).toBe(true);
      expect(bobCancelInteraction.replyPayload.content).toContain('Akses Ditolak');
      expect(bobCancelInteraction.updated).toBe(false);

      // Session must NOT be cancelled by Bob
      expect(confirmationStore.get(sessionKey)).toBeDefined();
    });

    it('allows legitimate User A to confirm successfully even after multiple failed intrusion attempts', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      const session: PendingConfirmationSession = {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      };
      confirmationStore.set(sessionKey, session);

      // 1. Intruder Bob attempts confirm
      const bobInteraction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_bob', username: 'bob' },
      );
      await handleConfirmationInteraction(bobInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      // 2. Intruder Eve attempts cancel
      const eveInteraction = createMockButtonInteraction(
        `cancel:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_eve', username: 'eve_intruder' },
      );
      await handleConfirmationInteraction(eveInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      // 3. Legitimate user Alice clicks Confirm
      const aliceInteraction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );
      const handled = await handleConfirmationInteraction(aliceInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(handled).toBe(true);
      expect(aliceInteraction.updated).toBe(true);
      expect(aliceInteraction.updatePayload.embeds[0].data.title).toContain('Berhasil Diperbarui');
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Review');

      // Audit log records Alice
      const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_STATUS_UPDATE') as any[];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].actor_discord_id).toBe('discord_alice');
      expect(auditRows[0].actor_github_login).toBe('alice');
    });

    it('rejects tampered customId where intruder changes callerDiscordId in the customId string', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;

      // Alice's session registered in store
      confirmationStore.set(`status:${issueNumber}:discord_alice:${timestamp}`, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      // Eve tampers customId to say Eve is the caller: `confirm:status:1:discord_eve:timestamp`
      const tamperedInteraction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_eve:${timestamp}`,
        { id: 'discord_eve', username: 'eve_intruder' },
      );

      const handled = await handleConfirmationInteraction(tamperedInteraction as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(handled).toBe(true);
      // Fails session lookup because session key was created for Alice
      expect(tamperedInteraction.updated).toBe(true);
      expect(tamperedInteraction.updatePayload.embeds[0].data.title).toContain('Sesi Konfirmasi Tidak Ditemukan');
      expect(tamperedInteraction.updatePayload.components).toEqual([]);
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. 60-SECOND TTL RACE CONDITION CHALLENGES (59s VS 61s)
  // =========================================================================
  describe('2. 60-Second TTL Race Conditions (59s vs 61s)', () => {
    it('accepts confirmation click at 59 seconds (within 60s TTL window)', async () => {
      const now = Date.now();
      const timestampAt59sAgo = now - 59_000; // 59 seconds ago
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestampAt59sAgo}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp: timestampAt59sAgo,
        expiresAt: timestampAt59sAgo + ConfirmationStore.TTL_MS,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestampAt59sAgo}`,
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
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Review');
    });

    it('strictly rejects confirmation click at 60 seconds + 1ms (expired TTL)', async () => {
      const now = Date.now();
      const timestampAt60s1msAgo = now - 60_001; // 60.001 seconds ago
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestampAt60s1msAgo}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp: timestampAt60s1msAgo,
        expiresAt: timestampAt60s1msAgo + ConfirmationStore.TTL_MS,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestampAt60s1msAgo}`,
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

      // Session must be purged
      expect(confirmationStore.get(sessionKey)).toBeUndefined();
      // No mutation
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });

    it('strictly rejects confirmation click at 61 seconds with buttons disabled and purged session', async () => {
      const now = Date.now();
      const timestampAt61sAgo = now - 61_000; // 61 seconds ago
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestampAt61sAgo}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp: timestampAt61sAgo,
        expiresAt: timestampAt61sAgo + ConfirmationStore.TTL_MS,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestampAt61sAgo}`,
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
      expect(confirmationStore.get(sessionKey)).toBeUndefined();
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });

    it('handles background sweep prune: when pruneExpired clears the session, click is safely rejected', async () => {
      const now = Date.now();
      const timestampAt65sAgo = now - 65_000;
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestampAt65sAgo}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp: timestampAt65sAgo,
        expiresAt: timestampAt65sAgo + ConfirmationStore.TTL_MS,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      // Background cleaner runs
      confirmationStore.pruneExpired(now);
      expect(confirmationStore.get(sessionKey)).toBeUndefined();

      // Click arrives after prune
      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestampAt65sAgo}`,
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
      // Detected either by TTL comparison or missing session, buttons cleared
      expect(interaction.updatePayload.components).toEqual([]);
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });
  });

  // =========================================================================
  // 3. REMOTE STATE DRIFT (STALE-STATE CONFLICT / CONCURRENCY RACE)
  // =========================================================================
  describe('3. Remote State Drift & Concurrency Conflict Protection', () => {
    it('detects status drift from Ready to In Progress between preview and confirmation, aborting mutation', async () => {
      const timestamp = Date.now();
      const issueNumber = 3; // Initially 'Ready'
      const issue = mockGitHubService.issues.get(issueNumber)!;
      expect(issue.projectStatus).toBe('Ready');

      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;
      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Progress',
          expectedPreviousStatus: 'Ready',
        },
      });

      // Another developer mutates remote status on GitHub to 'In Progress'
      issue.projectStatus = 'In Progress';

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
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
      expect(interaction.updatePayload.embeds[0].data.description).toContain('Ready');
      expect(interaction.updatePayload.embeds[0].data.description).toContain('In Progress');
      expect(interaction.updatePayload.components).toEqual([]);

      // GitHub state remains In Progress (not modified)
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Progress');
      expect(mockGitHubService.statusTransitions).toHaveLength(0);

      // Session is deleted
      expect(confirmationStore.get(sessionKey)).toBeUndefined();

      // No successful audit log written
      const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_STATUS_UPDATE');
      expect(auditRows).toHaveLength(0);
    });

    it('detects status drift from In Progress to Blocked, preventing invalid status jump', async () => {
      const timestamp = Date.now();
      const issueNumber = 1; // Initially 'In Progress'
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      // Teammate concurrently blocks the issue on GitHub
      mockGitHubService.issues.get(issueNumber)!.projectStatus = 'Blocked';

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
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
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('Blocked');
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });

    it('detects priority drift between preview and confirmation click', async () => {
      const timestamp = Date.now();
      const issueNumber = 1; // ProjectPriority initially 'High'
      const sessionKey = `priority:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'priority',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetPriority: 'Urgent',
          expectedPreviousPriority: 'High',
        },
      });

      // Drift priority on GitHub to 'Low'
      mockGitHubService.issues.get(issueNumber)!.projectPriority = 'Low';

      const interaction = createMockButtonInteraction(
        `confirm:priority:${issueNumber}:discord_alice:${timestamp}`,
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
      expect(interaction.updatePayload.embeds[0].data.description).toContain('High');
      expect(interaction.updatePayload.embeds[0].data.description).toContain('Low');
      expect(mockGitHubService.issues.get(issueNumber)!.projectPriority).toBe('Low');
      expect(mockGitHubService.priorityTransitions).toHaveLength(0);
    });

    it('detects status drift when attempting to confirm issue block', async () => {
      const timestamp = Date.now();
      const issueNumber = 1; // Initially 'In Progress'
      const sessionKey = `block:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'block',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'Blocked',
          expectedPreviousStatus: 'In Progress',
          blockerReason: 'Waiting for database migration',
        },
      });

      // Drift status to 'Done'
      mockGitHubService.issues.get(issueNumber)!.projectStatus = 'Done';

      const interaction = createMockButtonInteraction(
        `confirm:block:${issueNumber}:discord_alice:${timestamp}`,
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
      expect(mockGitHubService.blockedActions).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. REPLAY / DOUBLE-CLICK ATTACK CHALLENGES
  // =========================================================================
  describe('4. Replay & Double-Click Attack Resistance', () => {
    it('prevents sequential double-click replay: second click receives missing session notice with 0 duplicate mutations', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      const firstClick = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );

      // First click succeeds
      await handleConfirmationInteraction(firstClick as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(firstClick.updated).toBe(true);
      expect(firstClick.updatePayload.embeds[0].data.title).toContain('Berhasil Diperbarui');
      expect(mockGitHubService.statusTransitions).toHaveLength(1);

      // Second click (replay) on the same button
      const secondClick = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );

      await handleConfirmationInteraction(secondClick as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(secondClick.updated).toBe(true);
      expect(secondClick.updatePayload.embeds[0].data.title).toContain('Sesi Konfirmasi Tidak Ditemukan');
      expect(secondClick.updatePayload.components).toEqual([]);

      // Exactly 1 mutation on GitHub
      expect(mockGitHubService.statusTransitions).toHaveLength(1);

      // Exactly 1 audit record in SQLite
      const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_STATUS_UPDATE');
      expect(auditRows).toHaveLength(1);
    });

    it('safely handles concurrent double-click (rapid succession race): GitHub state remains consistent', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      const click1 = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );
      const click2 = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );

      // Dispatch both clicks concurrently
      const results = await Promise.allSettled([
        handleConfirmationInteraction(click1 as any, {
          authService,
          gitHubService: mockGitHubService,
          auditService,
          confirmationStore,
        }),
        handleConfirmationInteraction(click2 as any, {
          authService,
          gitHubService: mockGitHubService,
          auditService,
          confirmationStore,
        }),
      ]);

      // If one succeeds and the other rejects due to concurrent conflict, verify it is ConflictError
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // At least one fulfilled, and if one rejected it must be ConflictError
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      if (rejected.length > 0) {
        const error = (rejected[0] as PromiseRejectedResult).reason;
        expect(error).toBeInstanceOf(ConflictError);
      }

      // Final GitHub status is In Review
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Review');
      // Exactly 1 mutation executed
      expect(mockGitHubService.statusTransitions).toHaveLength(1);
      // Store cleaned up
      expect(confirmationStore.get(sessionKey)).toBeUndefined();
    });

    it('prevents confirm click after cancel was already clicked', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      // User clicks Cancel
      const cancelClick = createMockButtonInteraction(
        `cancel:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );
      await handleConfirmationInteraction(cancelClick as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(cancelClick.updated).toBe(true);
      expect(cancelClick.updatePayload.embeds[0].data.title).toContain('Aksi Dibatalkan');
      expect(confirmationStore.get(sessionKey)).toBeUndefined();

      // User subsequently clicks Confirm on stale button
      const confirmClick = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );
      await handleConfirmationInteraction(confirmClick as any, {
        authService,
        gitHubService: mockGitHubService,
        auditService,
        confirmationStore,
      });

      expect(confirmClick.updated).toBe(true);
      expect(confirmClick.updatePayload.embeds[0].data.title).toContain('Sesi Konfirmasi Tidak Ditemukan');
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. BLOCKER REASON VALIDATION CHALLENGES
  // =========================================================================
  describe('5. Blocker Reason Validation & Transition Policy Enforcement', () => {
    const writeDeps = () => ({
      authService,
      gitHubService: mockGitHubService,
      auditService,
      confirmationStore,
    });

    it('rejects empty blocker reason with ValidationError in handleIssueBlockCommand', async () => {
      const cmd = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: {
          number: 1,
          reason: '',
        },
        user: { id: 'discord_alice', username: 'alice' },
      });

      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        ValidationError,
      );
      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        /minimal 3 karakter/,
      );
    });

    it('rejects whitespace-only blocker reason with ValidationError in handleIssueBlockCommand', async () => {
      const cmd = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: {
          number: 1,
          reason: '     ',
        },
        user: { id: 'discord_alice', username: 'alice' },
      });

      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        ValidationError,
      );
    });

    it('rejects 1-character blocker reason with ValidationError in handleIssueBlockCommand', async () => {
      const cmd = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: {
          number: 1,
          reason: 'x',
        },
        user: { id: 'discord_alice', username: 'alice' },
      });

      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        ValidationError,
      );
      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        /minimal 3 karakter/,
      );
    });

    it('rejects 2-character blocker reason with ValidationError in handleIssueBlockCommand', async () => {
      const cmd = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: {
          number: 1,
          reason: 'no',
        },
        user: { id: 'discord_alice', username: 'alice' },
      });

      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        ValidationError,
      );
      await expect(handleIssueBlockCommand(cmd as any, writeDeps())).rejects.toThrow(
        /minimal 3 karakter/,
      );
    });

    it('accepts valid 3-character blocker reason and creates confirmation session', async () => {
      const cmd = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: {
          number: 1, // 'In Progress', assigned to alice
          reason: 'bug',
        },
        user: { id: 'discord_alice', username: 'alice' },
      });

      await handleIssueBlockCommand(cmd as any, writeDeps());

      expect(cmd.editReplyPayload).toBeDefined();
      expect(cmd.editReplyPayload.embeds[0].data.title).toContain('Penandaan Issue Terblokir');
      expect(cmd.editReplyPayload.components).toHaveLength(1);

      // Verify pending session created
      const customId = cmd.editReplyPayload.components[0].components[0].data.custom_id;
      const parts = customId.split(':');
      const timestamp = parseInt(parts[4], 10);
      const session = confirmationStore.get(`block:1:discord_alice:${timestamp}`);
      expect(session).toBeDefined();
      expect(session?.payload.blockerReason).toBe('bug');
    });

    it('verifies StatusTransitionPolicy.assertValidTransition directly enforces min 3 chars for Blocked', () => {
      expect(() => {
        StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', undefined);
      }).toThrow(ValidationError);

      expect(() => {
        StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', '');
      }).toThrow(ValidationError);

      expect(() => {
        StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', '  ');
      }).toThrow(ValidationError);

      expect(() => {
        StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', 'ab');
      }).toThrow(ValidationError);

      expect(() => {
        StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', 'abc');
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 6. IDENTITY DISCONNECT MID-FLOW & STORE CAPACITY STRESS TESTING
  // =========================================================================
  describe('6. Identity Disconnect Mid-Flow & Store Capacity Stress Testing', () => {
    it('fails closed with UnauthorizedError if actor disconnects account between preview and confirm click', async () => {
      const timestamp = Date.now();
      const issueNumber = 1;
      const sessionKey = `status:${issueNumber}:discord_alice:${timestamp}`;

      confirmationStore.set(sessionKey, {
        action: 'status',
        issueNumber,
        callerDiscordId: 'discord_alice',
        timestamp,
        expiresAt: timestamp + 60_000,
        payload: {
          targetStatus: 'In Review',
          expectedPreviousStatus: 'In Progress',
        },
      });

      // Alice unlinks her identity before clicking confirm
      await identityRepo.unlinkIdentity('discord_alice');

      const interaction = createMockButtonInteraction(
        `confirm:status:${issueNumber}:discord_alice:${timestamp}`,
        { id: 'discord_alice', username: 'alice' },
      );

      await expect(
        handleConfirmationInteraction(interaction as any, {
          authService,
          gitHubService: mockGitHubService,
          auditService,
          confirmationStore,
        }),
      ).rejects.toThrow(UnauthorizedError);

      // GitHub status remains In Progress (no mutation executed)
      expect(mockGitHubService.issues.get(issueNumber)!.projectStatus).toBe('In Progress');
      expect(mockGitHubService.statusTransitions).toHaveLength(0);
    });

    it('ConfirmationStore triggers auto-pruning when store capacity reaches maxEntries (1000)', () => {
      const now = Date.now();
      // Fill store with 1000 expired entries
      for (let i = 0; i < 1000; i++) {
        confirmationStore.set(`key_${i}`, {
          action: 'status',
          issueNumber: i,
          callerDiscordId: 'discord_alice',
          timestamp: now - 70_000,
          expiresAt: now - 10_000, // Expired
          payload: { targetStatus: 'Done' },
        });
      }

      // Add 1 more entry: should trigger pruneExpired and keep size under control
      confirmationStore.set('active_key', {
        action: 'status',
        issueNumber: 9999,
        callerDiscordId: 'discord_alice',
        timestamp: now,
        expiresAt: now + 60_000, // Active
        payload: { targetStatus: 'Done' },
      });

      // The expired entries are pruned
      expect(confirmationStore.get('active_key')).toBeDefined();
      expect(confirmationStore.get('key_0')).toBeUndefined();
    });
  });
});

