import type { Config } from '../../config/env.js';
import type { IIdentityRepository } from '../ports/IRepositories.js';
import type { ApplicationRole } from '../../domain/types.js';
import { UnauthorizedError } from '../../domain/errors.js';

export interface GetAccountStatusInput {
  discordUserId: string;
  guildId: string;
}

export interface AccountStatusResult {
  linked: boolean;
  discordUserId: string;
  githubUserId?: number;
  githubUsername?: string;
  applicationRole?: ApplicationRole;
  linkedAt?: string;
  hasEncryptedToken?: boolean;
}

export class GetAccountStatusUseCase {
  constructor(
    private readonly identityRepository: IIdentityRepository,
    private readonly config: Pick<Config, 'DISCORD_GUILD_ID'>,
  ) {}

  public async execute(input: GetAccountStatusInput): Promise<AccountStatusResult> {
    if (input.guildId !== this.config.DISCORD_GUILD_ID) {
      throw new UnauthorizedError('Command is not permitted in this Discord server.');
    }

    const identity = await this.identityRepository.findByDiscordId(input.discordUserId);
    if (!identity) {
      return {
        linked: false,
        discordUserId: input.discordUserId,
      };
    }

    return {
      linked: true,
      discordUserId: identity.discordUserId,
      githubUserId: identity.githubUserId,
      githubUsername: identity.githubUsername,
      applicationRole: identity.applicationRole,
      linkedAt: identity.linkedAt,
      hasEncryptedToken: Boolean(identity.encryptedToken),
    };
  }
}
