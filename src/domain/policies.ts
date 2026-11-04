import type {
  CanonicalStatus,
  RepoPermissionLevel,
  Principal,
  VerifiedPrincipal,
  ReadAction,
  WriteAction,
  ResourceContext,
  ConfirmationAction,
  AllowedMentions,
} from './types.js';
import {
  ValidationError,
  ConflictError,
  UnauthorizedError,
} from './errors.js';

/**
 * Allowed status transitions map.
 * Canonical Flow: Backlog -> Ready -> In Progress -> In Review -> Done
 * Exceptional State: Blocked (bidirectional with active states)
 */
const ALLOWED_STATUS_TRANSITIONS: Record<CanonicalStatus, ReadonlyArray<CanonicalStatus>> = {
  Backlog: ['Ready', 'In Progress', 'Blocked'],
  Ready: ['In Progress', 'Backlog', 'Blocked'],
  'In Progress': ['In Review', 'Ready', 'Blocked'],
  'In Review': ['Done', 'In Progress', 'Blocked'],
  Blocked: ['Backlog', 'Ready', 'In Progress', 'In Review'],
  Done: [], // Terminal for MVP
};

export class StatusTransitionPolicy {
  /**
   * Checks if status transition is allowed by the canonical state machine.
   */
  public static canTransition(from: CanonicalStatus, to: CanonicalStatus): boolean {
    if (from === to) return true; // Idempotent no-op
    return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
  }

  /**
   * Validates status transition, enforcing blocker reason and state machine rules.
   */
  public static assertValidTransition(
    from: CanonicalStatus,
    to: CanonicalStatus,
    blockerReason?: string,
  ): void {
    if (from === to) {
      throw new ConflictError(`Issue is already in status '${to}'.`);
    }

    if (to === 'Blocked') {
      if (!blockerReason || blockerReason.trim().length < 3) {
        throw new ValidationError(
          'A valid blocker reason (minimum 3 characters) is mandatory when marking an issue as Blocked.',
        );
      }
    }

    if (!this.canTransition(from, to)) {
      throw new ConflictError(
        `Invalid status transition from '${from}' to '${to}'. Allowed transitions from '${from}': [${ALLOWED_STATUS_TRANSITIONS[from].join(', ')}].`,
      );
    }
  }

  /**
   * Validates that the issue's server-side status matches the status observed during preview.
   */
  public static assertStateNotStale(
    actualStatus: CanonicalStatus,
    expectedPreviousStatus?: CanonicalStatus,
  ): void {
    if (expectedPreviousStatus && actualStatus !== expectedPreviousStatus) {
      throw new ConflictError(
        `Concurrency conflict: issue status has changed from '${expectedPreviousStatus}' to '${actualStatus}' since diff preview. Please re-run the command with fresh data.`,
      );
    }
  }
}

export interface AuthorizationPolicyOptions {
  allowedGuildId: string;
  writeActionsEnabled: boolean;
}

export class AuthorizationPolicy {
  /**
   * Checks read operation permissions.
   */
  public static canExecuteRead(
    principal: Principal | null,
    action: ReadAction,
    options: { allowedGuildId: string },
  ): { allowed: boolean; reason?: string } {
    if (!principal) {
      return { allowed: false, reason: 'Principal could not be resolved.' };
    }

    if (principal.guildId !== options.allowedGuildId) {
      return { allowed: false, reason: 'Command is not permitted in this Discord server.' };
    }

    // /project mine strictly requires a verified linked identity
    if (action === 'view_mine' && !principal.identity) {
      return {
        allowed: false,
        reason: 'Your Discord account is not linked to GitHub. Run `/account connect` to view your assigned issues.',
      };
    }

    return { allowed: true };
  }

  /**
   * Checks write operation permissions fail-closed.
   */
  public static canExecuteWrite(
    principal: Principal,
    action: WriteAction,
    repoPermission: RepoPermissionLevel,
    resource?: ResourceContext,
    options?: AuthorizationPolicyOptions,
  ): { allowed: boolean; reason?: string } {
    if (options && !options.writeActionsEnabled) {
      return { allowed: false, reason: 'Write actions are currently disabled by administrator configuration.' };
    }

    if (options && principal.guildId !== options.allowedGuildId) {
      return { allowed: false, reason: 'Write commands are not permitted in this Discord server.' };
    }

    if (!principal.identity) {
      return {
        allowed: false,
        reason: 'Your Discord account is not linked to GitHub. Please run `/account connect` to link your account.',
      };
    }

    // Fail closed if collaborator lacks write/maintain/admin on GitHub repository
    const hasWritePermission = ['admin', 'maintain', 'write'].includes(repoPermission);
    if (!hasWritePermission) {
      return {
        allowed: false,
        reason: `Insufficient GitHub repository permissions: your GitHub account (@${principal.identity.githubLogin}) has '${repoPermission}' access; write or maintain access is required.`,
      };
    }

    const role = principal.identity.applicationRole;

    // Viewers cannot execute write commands
    if (role === 'Viewer') {
      return { allowed: false, reason: 'Viewer role does not have permission to execute write actions.' };
    }

    // Admin & Maintainer have full write access on repository
    if (role === 'Admin' || role === 'Maintainer') {
      return { allowed: true };
    }

    // Developer role scope restrictions
    if (role === 'Developer') {
      if (action === 'assign_issue') {
        const callerLogin = principal.identity.githubLogin.toLowerCase();
        const targetLogin = resource?.targetAssigneeGithubLogin?.toLowerCase();
        if (targetLogin && targetLogin !== callerLogin) {
          return {
            allowed: false,
            reason: 'Developers may only assign issues to themselves. Assigning to other developers requires Maintainer or Admin role.',
          };
        }
      }

      if (action === 'update_status' || action === 'update_priority' || action === 'mark_blocked') {
        const callerLogin = principal.identity.githubLogin.toLowerCase();
        const currentAssignee = resource?.currentAssigneeGithubLogin?.toLowerCase();
        if (currentAssignee && currentAssignee !== callerLogin) {
          return {
            allowed: false,
            reason: `Developers may only modify issues assigned to themselves. Issue is currently assigned to @${resource?.currentAssigneeGithubLogin}.`,
          };
        }
      }

      return { allowed: true };
    }

    return { allowed: false, reason: 'Unrecognized application role.' };
  }

  /**
   * Asserts write permission; throws UnauthorizedError if denied.
   */
  public static assertAuthorizedWrite(
    principal: Principal,
    action: WriteAction,
    repoPermission: RepoPermissionLevel,
    resource?: ResourceContext,
    options?: AuthorizationPolicyOptions,
  ): asserts principal is VerifiedPrincipal {
    const decision = this.canExecuteWrite(principal, action, repoPermission, resource, options);
    if (!decision.allowed) {
      throw new UnauthorizedError(decision.reason ?? 'Write action unauthorized.');
    }
  }

  /**
   * Validates confirmation button interactions.
   */
  public static validateConfirmationActor(
    confirmation: ConfirmationAction,
    actorDiscordUserId: string,
    now: number = Date.now(),
  ): void {
    if (confirmation.actorDiscordUserId !== actorDiscordUserId) {
      throw new UnauthorizedError('You are not authorized to confirm or cancel this action. Only the initiating user may respond.');
    }

    if (now > confirmation.expiresAt) {
      throw new ConflictError('Confirmation session has expired (TTL 60s). Please execute the command again.');
    }
  }
}

export class MentionPolicy {
  /**
   * Generates safe Discord allowedMentions payload.
   * STRICTLY bans @everyone, @here, and role pings.
   */
  public static buildSafeAllowedMentions(targetDiscordUserIds: string[] = []): AllowedMentions {
    return {
      parse: [] as never[], // strictly empty
      users: targetDiscordUserIds,
    };
  }

  /**
   * Sanitizes markdown text from GitHub issues/comments to neutralize mention attacks.
   */
  public static sanitizeDiscordMentions(text: string): string {
    if (!text) return '';

    return text
      // Neutralize @everyone and @here with zero-width space
      .replace(/@(everyone)/gi, '@\u200b$1')
      .replace(/@(here)/gi, '@\u200b$1')
      // Neutralize role mentions <@&123456> -> <@&\u200b123456>
      .replace(/<@&([0-9]+)>/g, '<@&\u200b$1>')
      // Neutralize direct user mentions unless authorized by system
      .replace(/<@!?([0-9]+)>/g, '<@\u200b$1>');
  }
}
