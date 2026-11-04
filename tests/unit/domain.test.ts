import { describe, it, expect } from 'vitest';
import {
  StatusTransitionPolicy,
  AuthorizationPolicy,
  MentionPolicy,
} from '../../src/domain/policies.js';
import {
  DomainError,
  ConfigurationError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  ValidationError,
  PendingPermissionError,
  RateLimitError,
  ExternalApiError,
} from '../../src/domain/errors.js';
import type {
  Principal,
  ConfirmationAction,
  CanonicalStatus,
} from '../../src/domain/types.js';

describe('Domain Layer: Errors Hierarchy', () => {
  it('should instantiate all typed errors with correct codes and inheritance', () => {
    const configErr = new ConfigurationError('Invalid configuration');
    expect(configErr).toBeInstanceOf(DomainError);
    expect(configErr).toBeInstanceOf(Error);
    expect(configErr.code).toBe('CONFIGURATION_ERROR');
    expect(configErr.isOperational).toBe(true);

    const unauthErr = new UnauthorizedError('Unauthorized');
    expect(unauthErr.code).toBe('UNAUTHORIZED');

    const notFoundErr = new NotFoundError('Not found');
    expect(notFoundErr.code).toBe('NOT_FOUND');

    const conflictErr = new ConflictError('Conflict');
    expect(conflictErr.code).toBe('CONFLICT');

    const valErr = new ValidationError('Invalid input');
    expect(valErr.code).toBe('VALIDATION_ERROR');

    const pendingPermErr = new PendingPermissionError('Pending permission');
    expect(pendingPermErr.code).toBe('PENDING_PERMISSION');

    const rateLimitErr = new RateLimitError('Too many requests', 60);
    expect(rateLimitErr.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(rateLimitErr.retryAfterSeconds).toBe(60);

    const extApiErr = new ExternalApiError('GitHub 502 Bad Gateway', 502);
    expect(extApiErr.code).toBe('EXTERNAL_API_ERROR');
    expect(extApiErr.statusCode).toBe(502);
  });
});

describe('Domain Layer: StatusTransitionPolicy', () => {
  it('allows valid state transitions along the canonical pipeline', () => {
    expect(StatusTransitionPolicy.canTransition('Backlog', 'Ready')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Backlog', 'In Progress')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Ready', 'In Progress')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('In Progress', 'In Review')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('In Review', 'Done')).toBe(true);
  });

  it('allows transitions to and from Blocked state for active tasks', () => {
    expect(StatusTransitionPolicy.canTransition('Backlog', 'Blocked')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Ready', 'Blocked')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('In Progress', 'Blocked')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('In Review', 'Blocked')).toBe(true);

    expect(StatusTransitionPolicy.canTransition('Blocked', 'Backlog')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Blocked', 'Ready')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Blocked', 'In Progress')).toBe(true);
    expect(StatusTransitionPolicy.canTransition('Blocked', 'In Review')).toBe(true);
  });

  it('rejects invalid or illegal transitions', () => {
    expect(StatusTransitionPolicy.canTransition('Backlog', 'Done')).toBe(false);
    expect(StatusTransitionPolicy.canTransition('Ready', 'Done')).toBe(false);
    expect(StatusTransitionPolicy.canTransition('Done', 'In Progress')).toBe(false);
    expect(StatusTransitionPolicy.canTransition('Done', 'Backlog')).toBe(false);
  });

  it('enforces non-empty blocker reason of at least 3 characters when transitioning to Blocked', () => {
    expect(() =>
      StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', undefined),
    ).toThrow(ValidationError);

    expect(() =>
      StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', '  '),
    ).toThrow(ValidationError);

    expect(() =>
      StatusTransitionPolicy.assertValidTransition('In Progress', 'Blocked', 'ab'),
    ).toThrow(ValidationError);

    expect(() =>
      StatusTransitionPolicy.assertValidTransition(
        'In Progress',
        'Blocked',
        'Waiting for upstream API deployment',
      ),
    ).not.toThrow();
  });

  it('throws ConflictError when trying to transition to current status', () => {
    expect(() =>
      StatusTransitionPolicy.assertValidTransition('In Progress', 'In Progress'),
    ).toThrow(ConflictError);
  });

  it('throws ConflictError when attempting illegal transition via assertValidTransition', () => {
    expect(() =>
      StatusTransitionPolicy.assertValidTransition('Backlog', 'Done'),
    ).toThrow(ConflictError);
  });

  it('detects concurrent stale state via assertStateNotStale', () => {
    expect(() =>
      StatusTransitionPolicy.assertStateNotStale('In Progress', 'In Progress'),
    ).not.toThrow();

    expect(() =>
      StatusTransitionPolicy.assertStateNotStale('Done', 'In Progress' as CanonicalStatus),
    ).toThrow(ConflictError);
  });
});

describe('Domain Layer: AuthorizationPolicy', () => {
  const allowedGuildId = 'guild-1001';
  const policyOpts = { allowedGuildId, writeActionsEnabled: true };

  const linkedAdmin: Principal = {
    discordUserId: 'user-admin',
    guildId: allowedGuildId,
    identity: {
      discordUserId: 'user-admin',
      githubUserId: 101,
      githubLogin: 'admin-dev',
      applicationRole: 'Admin',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  };

  const linkedDeveloper: Principal = {
    discordUserId: 'user-dev',
    guildId: allowedGuildId,
    identity: {
      discordUserId: 'user-dev',
      githubUserId: 202,
      githubLogin: 'alice-dev',
      applicationRole: 'Developer',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  };

  const linkedViewer: Principal = {
    discordUserId: 'user-viewer',
    guildId: allowedGuildId,
    identity: {
      discordUserId: 'user-viewer',
      githubUserId: 303,
      githubLogin: 'bob-viewer',
      applicationRole: 'Viewer',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  };

  const unlinkedUser: Principal = {
    discordUserId: 'user-unlinked',
    guildId: allowedGuildId,
    identity: null,
  };

  describe('Read Authorization', () => {
    it('rejects unresolved principal or non-matching guild', () => {
      expect(AuthorizationPolicy.canExecuteRead(null, 'view_status', { allowedGuildId })).toEqual({
        allowed: false,
        reason: 'Principal could not be resolved.',
      });

      const wrongGuildUser: Principal = { ...unlinkedUser, guildId: 'other-guild' };
      expect(AuthorizationPolicy.canExecuteRead(wrongGuildUser, 'view_status', { allowedGuildId })).toEqual({
        allowed: false,
        reason: 'Command is not permitted in this Discord server.',
      });
    });

    it('allows general read queries for unlinked users', () => {
      expect(AuthorizationPolicy.canExecuteRead(unlinkedUser, 'view_status', { allowedGuildId })).toEqual({
        allowed: true,
      });
      expect(AuthorizationPolicy.canExecuteRead(unlinkedUser, 'list_issues', { allowedGuildId })).toEqual({
        allowed: true,
      });
    });

    it('strictly requires linked identity for /project mine (view_mine)', () => {
      const decisionUnlinked = AuthorizationPolicy.canExecuteRead(unlinkedUser, 'view_mine', { allowedGuildId });
      expect(decisionUnlinked.allowed).toBe(false);
      expect(decisionUnlinked.reason).toContain('/account connect');

      const decisionLinked = AuthorizationPolicy.canExecuteRead(linkedDeveloper, 'view_mine', { allowedGuildId });
      expect(decisionLinked.allowed).toBe(true);
    });
  });

  describe('Write Authorization & Fail-Closed RBAC', () => {
    it('rejects all write actions when write actions feature flag is disabled', () => {
      const disabledOpts = { allowedGuildId, writeActionsEnabled: false };
      const decision = AuthorizationPolicy.canExecuteWrite(linkedAdmin, 'create_issue', 'admin', undefined, disabledOpts);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('disabled by administrator configuration');
    });

    it('rejects write actions from unlinked users', () => {
      const decision = AuthorizationPolicy.canExecuteWrite(unlinkedUser, 'create_issue', 'write', undefined, policyOpts);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('not linked');
    });

    it('fails closed when collaborator lacks repo write/maintain/admin access', () => {
      const decisionRead = AuthorizationPolicy.canExecuteWrite(linkedAdmin, 'create_issue', 'read', undefined, policyOpts);
      expect(decisionRead.allowed).toBe(false);
      expect(decisionRead.reason).toContain("your GitHub account (@admin-dev) has 'read' access");

      const decisionNone = AuthorizationPolicy.canExecuteWrite(linkedAdmin, 'create_issue', 'none', undefined, policyOpts);
      expect(decisionNone.allowed).toBe(false);
    });

    it('rejects write actions for Viewer role even with repo write access', () => {
      const decision = AuthorizationPolicy.canExecuteWrite(linkedViewer, 'create_issue', 'write', undefined, policyOpts);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Viewer role does not have permission');
    });

    it('allows Admin and Maintainer full write access with repo write permission', () => {
      const adminDecision = AuthorizationPolicy.canExecuteWrite(linkedAdmin, 'create_issue', 'admin', undefined, policyOpts);
      expect(adminDecision.allowed).toBe(true);

      const maintainerPrincipal: Principal = {
        ...linkedAdmin,
        identity: { ...linkedAdmin.identity!, applicationRole: 'Maintainer' },
      };
      const maintainerDecision = AuthorizationPolicy.canExecuteWrite(
        maintainerPrincipal,
        'assign_issue',
        'maintain',
        { targetAssigneeGithubLogin: 'other-dev' },
        policyOpts,
      );
      expect(maintainerDecision.allowed).toBe(true);
    });

    it('enforces self-assignment and self-ownership for Developer role', () => {
      // Developer assigning to self -> allowed
      const selfAssign = AuthorizationPolicy.canExecuteWrite(
        linkedDeveloper,
        'assign_issue',
        'write',
        { targetAssigneeGithubLogin: 'alice-dev' },
        policyOpts,
      );
      expect(selfAssign.allowed).toBe(true);

      // Developer assigning to someone else -> denied
      const otherAssign = AuthorizationPolicy.canExecuteWrite(
        linkedDeveloper,
        'assign_issue',
        'write',
        { targetAssigneeGithubLogin: 'bob-other' },
        policyOpts,
      );
      expect(otherAssign.allowed).toBe(false);
      expect(otherAssign.reason).toContain('Developers may only assign issues to themselves');

      // Developer updating status on self-assigned issue -> allowed
      const selfStatus = AuthorizationPolicy.canExecuteWrite(
        linkedDeveloper,
        'update_status',
        'write',
        { currentAssigneeGithubLogin: 'alice-dev' },
        policyOpts,
      );
      expect(selfStatus.allowed).toBe(true);

      // Developer updating status on someone else's issue -> denied
      const otherStatus = AuthorizationPolicy.canExecuteWrite(
        linkedDeveloper,
        'update_status',
        'write',
        { currentAssigneeGithubLogin: 'charlie-dev' },
        policyOpts,
      );
      expect(otherStatus.allowed).toBe(false);
      expect(otherStatus.reason).toContain('Developers may only modify issues assigned to themselves');
    });

    it('assertAuthorizedWrite asserts type and throws UnauthorizedError when rejected', () => {
      expect(() => {
        AuthorizationPolicy.assertAuthorizedWrite(unlinkedUser, 'create_issue', 'write', undefined, policyOpts);
      }).toThrow(UnauthorizedError);

      expect(() => {
        AuthorizationPolicy.assertAuthorizedWrite(linkedAdmin, 'create_issue', 'admin', undefined, policyOpts);
      }).not.toThrow();
    });
  });

  describe('Actor-Bound Confirmation Session Validation', () => {
    const confirmation: ConfirmationAction = {
      actionId: 'action-99',
      nonce: 'nonce-hex',
      actorDiscordUserId: 'user-original',
      command: 'update_status',
      payload: { status: 'Done' },
      expiresAt: Date.now() + 60000,
    };

    it('succeeds for matching actor before expiration', () => {
      expect(() =>
        AuthorizationPolicy.validateConfirmationActor(confirmation, 'user-original', Date.now()),
      ).not.toThrow();
    });

    it('throws UnauthorizedError when responding user is not the initiator', () => {
      expect(() =>
        AuthorizationPolicy.validateConfirmationActor(confirmation, 'user-intruder', Date.now()),
      ).toThrow(UnauthorizedError);
    });

    it('throws ConflictError when confirmation has expired (> 60s TTL)', () => {
      const expiredNow = confirmation.expiresAt + 1000;
      expect(() =>
        AuthorizationPolicy.validateConfirmationActor(confirmation, 'user-original', expiredNow),
      ).toThrow(ConflictError);
    });
  });
});

describe('Domain Layer: MentionPolicy', () => {
  it('buildSafeAllowedMentions strictly disallows @everyone, @here and role pings', () => {
    const allowed = MentionPolicy.buildSafeAllowedMentions(['111222333']);
    expect(allowed.parse).toEqual([]);
    expect(allowed.users).toEqual(['111222333']);
  });

  it('sanitizeDiscordMentions neutralizes mass mentions and role tags with zero-width space', () => {
    const input = 'Attention @everyone and @here! Check with <@&9876543210> and <@123456789>';
    const sanitized = MentionPolicy.sanitizeDiscordMentions(input);

    expect(sanitized).not.toContain('@everyone');
    expect(sanitized).not.toContain('@here');
    expect(sanitized).not.toContain('<@&9876543210>');
    expect(sanitized).toContain('@\u200beveryone');
    expect(sanitized).toContain('@\u200bhere');
    expect(sanitized).toContain('<@&\u200b9876543210>');
    expect(sanitized).toContain('<@\u200b123456789>');
  });

  it('handles empty or blank inputs safely', () => {
    expect(MentionPolicy.sanitizeDiscordMentions('')).toBe('');
  });
});
