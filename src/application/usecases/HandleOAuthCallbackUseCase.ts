import type { Config } from '../../config/env.js';
import type { ICryptoService } from '../ports/ICryptoService.js';
import type { IGitHubOAuthClient } from '../ports/IGitHubOAuthClient.js';
import type {
  IOAuthStateRepository,
  IIdentityRepository,
  IAuditRepository,
} from '../ports/IRepositories.js';
import { ValidationError } from '../../domain/errors.js';

export interface HandleOAuthCallbackInput {
  code?: string;
  state?: string;
}

export interface HandleOAuthCallbackResult {
  discordUserId: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl?: string;
}

export class HandleOAuthCallbackUseCase {
  constructor(
    private readonly oauthStateRepository: IOAuthStateRepository,
    private readonly identityRepository: IIdentityRepository,
    private readonly auditRepository: IAuditRepository,
    private readonly cryptoService: ICryptoService,
    private readonly gitHubOAuthClient: IGitHubOAuthClient,
    private readonly config: Pick<
      Config,
      'GITHUB_APP_CLIENT_ID' | 'GITHUB_APP_CLIENT_SECRET' | 'PUBLIC_BASE_URL'
    >,
  ) {}

  public async execute(input: HandleOAuthCallbackInput): Promise<HandleOAuthCallbackResult> {
    if (!input.code || typeof input.code !== 'string' || input.code.trim().length === 0) {
      throw new ValidationError('Missing required authorization parameter: code');
    }
    if (!input.state || typeof input.state !== 'string' || input.state.trim().length === 0) {
      throw new ValidationError('Missing required authorization parameter: state');
    }

    const stateNonce = input.state.trim();
    const code = input.code.trim();

    // Atomic single-use consumption in SQLite (rejects replays, expirations, and forged states)
    const session = await this.oauthStateRepository.consumeSession(stateNonce);
    if (!session) {
      await this.auditRepository.recordAudit({
        actorDiscordId: 'UNKNOWN',
        action: 'ACCOUNT_LINK',
        outcome: 'REJECTED',
        errorReason: 'Invalid, expired, or replayed OAuth state nonce',
        correlationId: `oauth-fail-${stateNonce.slice(0, 8)}`,
      });
      throw new ValidationError(
        'The authorization link is invalid, has expired, or has already been used.',
      );
    }

    const redirectUri = `${this.config.PUBLIC_BASE_URL}/auth/github/callback`;

    // Exchange authorization code & PKCE verifier for user token
    const tokenResult = await this.gitHubOAuthClient.exchangeCodeForToken({
      clientId: this.config.GITHUB_APP_CLIENT_ID,
      clientSecret: this.config.GITHUB_APP_CLIENT_SECRET,
      code,
      redirectUri,
      codeVerifier: session.codeVerifier,
    });

    // Fetch verified numeric GitHub user ID and login
    const userProfile = await this.gitHubOAuthClient.fetchUserProfile(tokenResult.accessToken);

    // Encrypt token at rest using AES-256-GCM
    const encryptedToken = this.cryptoService.encryptToken(tokenResult.accessToken);

    // Persist verified identity link in SQLite
    await this.identityRepository.linkIdentity(
      session.discordUserId,
      userProfile.id,
      userProfile.login,
      encryptedToken,
    );

    // Record structured audit event (without logging tokens or credentials)
    await this.auditRepository.recordAudit({
      actorDiscordId: session.discordUserId,
      actorGithubId: userProfile.id,
      actorGithubLogin: userProfile.login,
      action: 'ACCOUNT_LINK',
      outcome: 'SUCCESS',
      correlationId: `oauth-success-${session.discordUserId}`,
      afterState: {
        githubUserId: userProfile.id,
        githubUsername: userProfile.login,
        applicationRole: 'Developer',
      },
    });

    return {
      discordUserId: session.discordUserId,
      githubUserId: userProfile.id,
      githubLogin: userProfile.login,
      avatarUrl: userProfile.avatarUrl,
    };
  }
}
