import type {
  Principal,
  VerifiedPrincipal,
  ReadAction,
  WriteAction,
  ResourceContext,
  ConfirmationAction,
  RepoPermissionLevel,
} from '../../domain/types.js';
import type { IGitHubService } from './IGitHubService.js';

export interface AuthorizationDecision {
  allowed: boolean;
  reason?: string;
  repoPermission?: RepoPermissionLevel;
}

export interface IAuthorizationService {
  /**
   * Resolves Discord user and guild context into a Principal.
   * Resolves linked identity from IdentityRepository and fetches live repo permission.
   */
  resolvePrincipal(
    discordUserId: string,
    guildId: string,
    channelId?: string,
    overrideGitHubService?: IGitHubService,
  ): Promise<Principal>;

  /**
   * Asserts that the principal has a verified linked GitHub account.
   * Throws UnauthorizedError if unlinked or principal is null.
   */
  requireVerifiedIdentity(principal: Principal): asserts principal is VerifiedPrincipal;

  /**
   * Evaluates read permission for a command action.
   */
  authorizeRead(principal: Principal, action: ReadAction): AuthorizationDecision;

  /**
   * Evaluates write permission for a command action fail-closed against live repo permissions.
   */
  authorizeWrite(
    principal: Principal,
    action: WriteAction,
    resource?: ResourceContext,
  ): Promise<AuthorizationDecision>;

  /**
   * Asserts write permission; throws UnauthorizedError if denied.
   */
  assertAuthorizedWrite(
    principal: Principal,
    action: WriteAction,
    resource?: ResourceContext,
  ): Promise<VerifiedPrincipal>;

  /**
   * Validates actor-bound confirmation buttons and TTL expiration (60s).
   */
  validateConfirmation(
    confirmation: ConfirmationAction,
    actorDiscordUserId: string,
    now?: number,
  ): void;
}
