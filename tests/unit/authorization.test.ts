import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import {
  AuthorizationService,
  mapRepoPermissionToRole,
} from '../../src/application/services/AuthorizationService.js';
import { UnauthorizedError, ConflictError } from '../../src/domain/errors.js';
import type { ConfirmationAction, Principal } from '../../src/domain/types.js';

describe('AuthorizationService & Fail-Closed RBAC', () => {
  let db: DatabaseInstance;
  let identityRepo: IdentityRepository;
  let mockGitHubService: MockGitHubService;
  let authService: AuthorizationService;

  const config = {
    DISCORD_GUILD_ID: 'guild_allowlist_123',
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_alerts_456',
    BOT_WRITE_ACTIONS_ENABLED: true,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();

    identityRepo = new IdentityRepository(db);
    mockGitHubService = new MockGitHubService();
    authService = new AuthorizationService(identityRepo, mockGitHubService, config);
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  describe('mapRepoPermissionToRole', () => {
    it('maps GitHub repo permissions to application roles', () => {
      expect(mapRepoPermissionToRole('admin')).toBe('Admin');
      expect(mapRepoPermissionToRole('maintain')).toBe('Maintainer');
      expect(mapRepoPermissionToRole('write')).toBe('Developer');
      expect(mapRepoPermissionToRole('triage')).toBe('Viewer');
      expect(mapRepoPermissionToRole('read')).toBe('Viewer');
      expect(mapRepoPermissionToRole('none')).toBe('Viewer');
    });
  });

  describe('resolvePrincipal', () => {
    it('resolves unlinked principal when Discord ID not found in database', async () => {
      const principal = await authService.resolvePrincipal('unknown_discord_user', config.DISCORD_GUILD_ID);
      expect(principal.discordUserId).toBe('unknown_discord_user');
      expect(principal.guildId).toBe(config.DISCORD_GUILD_ID);
      expect(principal.identity).toBeNull();
    });

    it('resolves linked principal with live repo permission mapped to role', async () => {
      await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
      mockGitHubService.collaborators.set('alice', 'write');

      const principal = await authService.resolvePrincipal('discord_alice', config.DISCORD_GUILD_ID);
      expect(principal.identity).not.toBeNull();
      expect(principal.identity?.githubLogin).toBe('alice');
      expect(principal.identity?.githubUserId).toBe(1001);
      expect(principal.identity?.applicationRole).toBe('Developer');
    });

    it('fails closed to role Viewer when collaborator check fails or throws', async () => {
      await identityRepo.linkIdentity('discord_error_user', 1009, 'error_user');
      mockGitHubService.simulateServerError = true;

      const principal = await authService.resolvePrincipal('discord_error_user', config.DISCORD_GUILD_ID);
      expect(principal.identity).not.toBeNull();
      expect(principal.identity?.applicationRole).toBe('Viewer');
    });
  });

  describe('requireVerifiedIdentity', () => {
    it('throws UnauthorizedError if principal identity is null', () => {
      const principal: Principal = {
        discordUserId: 'user_unlinked',
        guildId: config.DISCORD_GUILD_ID,
        identity: null,
      };

      expect(() => authService.requireVerifiedIdentity(principal)).toThrow(UnauthorizedError);
      expect(() => authService.requireVerifiedIdentity(principal)).toThrow('/account connect');
    });

    it('passes assertion if principal has verified identity', async () => {
      await identityRepo.linkIdentity('discord_bob', 1002, 'bob');
      const principal = await authService.resolvePrincipal('discord_bob', config.DISCORD_GUILD_ID);

      expect(() => authService.requireVerifiedIdentity(principal)).not.toThrow();
    });
  });

  describe('authorizeRead', () => {
    it('allows general read queries in allowlisted guild even if unlinked', async () => {
      const principal = await authService.resolvePrincipal('unlinked_guest', config.DISCORD_GUILD_ID);

      expect(authService.authorizeRead(principal, 'view_status').allowed).toBe(true);
      expect(authService.authorizeRead(principal, 'list_issues').allowed).toBe(true);
      expect(authService.authorizeRead(principal, 'view_issue').allowed).toBe(true);
      expect(authService.authorizeRead(principal, 'help').allowed).toBe(true);
    });

    it('denies /project mine (view_mine) for unlinked users', async () => {
      const principal = await authService.resolvePrincipal('unlinked_guest', config.DISCORD_GUILD_ID);
      const decision = authService.authorizeRead(principal, 'view_mine');

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('/account connect');
    });

    it('allows /project mine (view_mine) for linked users', async () => {
      await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
      const principal = await authService.resolvePrincipal('discord_alice', config.DISCORD_GUILD_ID);

      expect(authService.authorizeRead(principal, 'view_mine').allowed).toBe(true);
    });

    it('denies read queries when guildId does not match allowlist', async () => {
      const principal = await authService.resolvePrincipal('any_user', 'foreign_guild_999');
      const decision = authService.authorizeRead(principal, 'view_status');

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('not permitted in this Discord server');
    });
  });

  describe('authorizeWrite and assertAuthorizedWrite', () => {
    it('fails closed when BOT_WRITE_ACTIONS_ENABLED is false', async () => {
      const disabledService = new AuthorizationService(identityRepo, mockGitHubService, {
        ...config,
        BOT_WRITE_ACTIONS_ENABLED: false,
      });

      await identityRepo.linkIdentity('admin_eva', 1004, 'admin_eva');
      mockGitHubService.collaborators.set('admin_eva', 'admin');
      const principal = await disabledService.resolvePrincipal('admin_eva', config.DISCORD_GUILD_ID);

      const decision = await disabledService.authorizeWrite(principal, 'create_issue');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('disabled by administrator configuration');

      await expect(disabledService.assertAuthorizedWrite(principal, 'create_issue')).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it('fails closed when interaction originates from wrong guild', async () => {
      await identityRepo.linkIdentity('admin_eva', 1004, 'admin_eva');
      mockGitHubService.collaborators.set('admin_eva', 'admin');
      const principal = await authService.resolvePrincipal('admin_eva', 'alien_guild_000');

      const decision = await authService.authorizeWrite(principal, 'create_issue');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('not permitted in this Discord server');
    });

    it('fails closed when user has not linked account', async () => {
      const principal = await authService.resolvePrincipal('unlinked_dev', config.DISCORD_GUILD_ID);
      const decision = await authService.authorizeWrite(principal, 'create_issue');

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('/account connect');
    });

    it('fails closed when GitHub repo permission is less than write (Viewer)', async () => {
      await identityRepo.linkIdentity('discord_viewer', 1005, 'viewer_val');
      mockGitHubService.collaborators.set('viewer_val', 'read');
      const principal = await authService.resolvePrincipal('discord_viewer', config.DISCORD_GUILD_ID);

      const decision = await authService.authorizeWrite(principal, 'create_issue');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Insufficient GitHub repository permissions');
    });

    it('Developer role: allows self-assignment and denies assigning to another developer', async () => {
      await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
      mockGitHubService.collaborators.set('alice', 'write');
      const principal = await authService.resolvePrincipal('discord_alice', config.DISCORD_GUILD_ID);

      // Self-assignment
      const selfAssign = await authService.authorizeWrite(principal, 'assign_issue', {
        targetAssigneeGithubLogin: 'alice',
      });
      expect(selfAssign.allowed).toBe(true);

      // Cross-assignment to Bob
      const otherAssign = await authService.authorizeWrite(principal, 'assign_issue', {
        targetAssigneeGithubLogin: 'bob',
      });
      expect(otherAssign.allowed).toBe(false);
      expect(otherAssign.reason).toContain('Developers may only assign issues to themselves');
    });

    it('Developer role: allows status/priority update on self-assigned issue, denies on others', async () => {
      await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
      mockGitHubService.collaborators.set('alice', 'write');
      const principal = await authService.resolvePrincipal('discord_alice', config.DISCORD_GUILD_ID);

      // Self-assigned
      const ownIssue = await authService.authorizeWrite(principal, 'update_status', {
        currentAssigneeGithubLogin: 'alice',
      });
      expect(ownIssue.allowed).toBe(true);

      // Bob's issue
      const otherIssue = await authService.authorizeWrite(principal, 'update_status', {
        currentAssigneeGithubLogin: 'bob',
      });
      expect(otherIssue.allowed).toBe(false);
      expect(otherIssue.reason).toContain('Developers may only modify issues assigned to themselves');
    });

    it('Maintainer role: full write authority across any developer', async () => {
      await identityRepo.linkIdentity('discord_maintainer', 1003, 'maintainer_dan');
      mockGitHubService.collaborators.set('maintainer_dan', 'maintain');
      const principal = await authService.resolvePrincipal('discord_maintainer', config.DISCORD_GUILD_ID);

      // Cross-assign to bob
      const assign = await authService.authorizeWrite(principal, 'assign_issue', {
        targetAssigneeGithubLogin: 'bob',
      });
      expect(assign.allowed).toBe(true);

      // Modify bob's issue status
      const mutate = await authService.authorizeWrite(principal, 'update_status', {
        currentAssigneeGithubLogin: 'bob',
      });
      expect(mutate.allowed).toBe(true);
    });

    it('Admin role: full write authority', async () => {
      await identityRepo.linkIdentity('discord_admin', 1004, 'admin_eva');
      mockGitHubService.collaborators.set('admin_eva', 'admin');
      const principal = await authService.resolvePrincipal('discord_admin', config.DISCORD_GUILD_ID);

      const verified = await authService.assertAuthorizedWrite(principal, 'create_issue');
      expect(verified.identity.applicationRole).toBe('Admin');
    });
  });

  describe('validateConfirmation', () => {
    it('accepts confirmation from initiating actor within 60s TTL', () => {
      const confirmation: ConfirmationAction = {
        actionId: 'act_123',
        nonce: 'nonce_abc',
        actorDiscordUserId: 'user_initiator',
        command: 'assign_issue',
        payload: { issueNumber: 1 },
        expiresAt: Date.now() + 30000,
      };

      expect(() =>
        authService.validateConfirmation(confirmation, 'user_initiator', Date.now()),
      ).not.toThrow();
    });

    it('rejects confirmation from a different user with UnauthorizedError', () => {
      const confirmation: ConfirmationAction = {
        actionId: 'act_123',
        nonce: 'nonce_abc',
        actorDiscordUserId: 'user_initiator',
        command: 'assign_issue',
        payload: { issueNumber: 1 },
        expiresAt: Date.now() + 30000,
      };

      expect(() =>
        authService.validateConfirmation(confirmation, 'malicious_interloper', Date.now()),
      ).toThrow(UnauthorizedError);
    });

    it('rejects confirmation past 60s expiration with ConflictError', () => {
      const confirmation: ConfirmationAction = {
        actionId: 'act_123',
        nonce: 'nonce_abc',
        actorDiscordUserId: 'user_initiator',
        command: 'assign_issue',
        payload: { issueNumber: 1 },
        expiresAt: Date.now() - 5000, // Expired 5 seconds ago
      };

      expect(() =>
        authService.validateConfirmation(confirmation, 'user_initiator', Date.now()),
      ).toThrow(ConflictError);
    });
  });
});
