import type { Config } from '../../config/env.js';
import type { ICryptoService } from '../ports/ICryptoService.js';
import type { IOAuthStateRepository } from '../ports/IRepositories.js';
import { UnauthorizedError } from '../../domain/errors.js';

export interface InitiateAccountLinkInput {
  discordUserId: string;
  guildId: string;
}

export interface InitiateAccountLinkResult {
  authorizationUrl: string;
  stateNonce: string;
  expiresInSeconds: number;
}

export class InitiateAccountLinkUseCase {
  constructor(
    private readonly oauthStateRepository: IOAuthStateRepository,
    private readonly cryptoService: ICryptoService,
    private readonly config: Pick<Config, 'DISCORD_GUILD_ID' | 'GITHUB_APP_CLIENT_ID' | 'PUBLIC_BASE_URL'>,
  ) {}

  public async execute(input: InitiateAccountLinkInput): Promise<InitiateAccountLinkResult> {
    // Fail-closed guild allowlist check
    if (input.guildId !== this.config.DISCORD_GUILD_ID) {
      throw new UnauthorizedError('Account linking is not permitted in this Discord server.');
    }

    const state = this.cryptoService.generateSecureNonce(32);
    const { verifier, challenge } = this.cryptoService.generatePkcePair();
    const ttlSeconds = 600; // 10 minutes

    // Persist session binding in SQLite
    await this.oauthStateRepository.createSession(
      state,
      input.discordUserId,
      input.guildId,
      verifier,
      ttlSeconds,
    );

    // Build authorization URL
    const callbackUrl = `${this.config.PUBLIC_BASE_URL}/auth/github/callback`;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.GITHUB_APP_CLIENT_ID);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('scope', 'read:user');

    return {
      authorizationUrl: url.toString(),
      stateNonce: state,
      expiresInSeconds: ttlSeconds,
    };
  }
}
