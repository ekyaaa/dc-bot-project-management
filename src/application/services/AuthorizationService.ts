import type { IAuthorizationService, AuthorizationDecision } from '../ports/IAuthorizationService.js';
import type { IIdentityRepository } from '../ports/IRepositories.js';
import type { IGitHubService } from '../ports/IGitHubService.js';
import type { Config } from '../../config/env.js';
import {
  AuthorizationPolicy,
  type AuthorizationPolicyOptions,
} from '../../domain/policies.js';
import { UnauthorizedError } from '../../domain/errors.js';
import type {
  Principal,
  VerifiedPrincipal,
  ReadAction,
  WriteAction,
  ResourceContext,
  ConfirmationAction,
  RepoPermissionLevel,
  ApplicationRole,
  UserIdentity,
} from '../../domain/types.js';

export function mapRepoPermissionToRole(permission: RepoPermissionLevel): ApplicationRole {
  switch (permission) {
    case 'admin':
      return 'Admin';
    case 'maintain':
      return 'Maintainer';
    case 'write':
      return 'Developer';
    case 'triage':
    case 'read':
    case 'none':
    default:
      return 'Viewer';
  }
}

export class AuthorizationService implements IAuthorizationService {
  private readonly policyOptions: AuthorizationPolicyOptions;

  constructor(
    private readonly identityRepo: IIdentityRepository,
    private readonly githubService: IGitHubService,
    private readonly config: Pick<
      Config,
      'DISCORD_GUILD_ID' | 'DISCORD_NOTIFICATION_CHANNEL_ID' | 'BOT_WRITE_ACTIONS_ENABLED'
    >,
  ) {
    this.policyOptions = {
      allowedGuildId: config.DISCORD_GUILD_ID,
      writeActionsEnabled: config.BOT_WRITE_ACTIONS_ENABLED,
    };
  }

  public async resolvePrincipal(
    discordUserId: string,
    guildId: string,
    channelId?: string,
  ): Promise<Principal> {
    const record = await this.identityRepo.findByDiscordId(discordUserId);

    if (!record) {
      return {
        discordUserId,
        guildId,
        channelId,
        identity: null,
      };
    }

    let repoPermission: RepoPermissionLevel = 'none';
    try {
      repoPermission = await this.githubService.getUserRepoPermission(record.githubUsername);
    } catch {
      // If collaborator not found or API fails, fail-closed to 'none'
      repoPermission = 'none';
    }

    const effectiveRole = mapRepoPermissionToRole(repoPermission);

    const identity: UserIdentity = {
      discordUserId: record.discordUserId,
      githubUserId: record.githubUserId,
      githubLogin: record.githubUsername,
      applicationRole: effectiveRole,
      createdAt: record.linkedAt,
      updatedAt: record.updatedAt,
    };

    return {
      discordUserId,
      guildId,
      channelId,
      identity,
    };
  }

  public requireVerifiedIdentity(principal: Principal): asserts principal is VerifiedPrincipal {
    if (!principal || !principal.identity) {
      throw new UnauthorizedError(
        'Your Discord account is not linked to GitHub. Please run `/account connect` to link your account.',
      );
    }
  }

  public authorizeRead(principal: Principal, action: ReadAction): AuthorizationDecision {
    return AuthorizationPolicy.canExecuteRead(principal, action, {
      allowedGuildId: this.config.DISCORD_GUILD_ID,
    });
  }

  public async authorizeWrite(
    principal: Principal,
    action: WriteAction,
    resource?: ResourceContext,
  ): Promise<AuthorizationDecision> {
    if (!this.config.BOT_WRITE_ACTIONS_ENABLED) {
      return {
        allowed: false,
        reason: 'Write actions are currently disabled by administrator configuration.',
      };
    }

    if (principal.guildId !== this.config.DISCORD_GUILD_ID) {
      return {
        allowed: false,
        reason: 'Write commands are not permitted in this Discord server.',
      };
    }

    if (!principal.identity) {
      return {
        allowed: false,
        reason: 'Your Discord account is not linked to GitHub. Please run `/account connect` to link your account.',
      };
    }

    let repoPermission: RepoPermissionLevel = 'none';
    try {
      repoPermission = await this.githubService.getUserRepoPermission(
        principal.identity.githubLogin,
      );
    } catch {
      return {
        allowed: false,
        reason: 'Failed to verify live repository permissions with GitHub. Action denied (fail-closed).',
      };
    }

    // Evaluate policy with fresh live repo permission
    const effectiveRole = mapRepoPermissionToRole(repoPermission);
    const effectivePrincipal: Principal = {
      ...principal,
      identity: {
        ...principal.identity,
        applicationRole: effectiveRole,
      },
    };

    const decision = AuthorizationPolicy.canExecuteWrite(
      effectivePrincipal,
      action,
      repoPermission,
      resource,
      this.policyOptions,
    );

    return {
      ...decision,
      repoPermission,
    };
  }

  public async assertAuthorizedWrite(
    principal: Principal,
    action: WriteAction,
    resource?: ResourceContext,
  ): Promise<VerifiedPrincipal> {
    const decision = await this.authorizeWrite(principal, action, resource);
    if (!decision.allowed) {
      throw new UnauthorizedError(decision.reason ?? 'Write action unauthorized.');
    }
    this.requireVerifiedIdentity(principal);
    return principal;
  }

  public validateConfirmation(
    confirmation: ConfirmationAction,
    actorDiscordUserId: string,
    now: number = Date.now(),
  ): void {
    AuthorizationPolicy.validateConfirmationActor(confirmation, actorDiscordUserId, now);
  }
}
