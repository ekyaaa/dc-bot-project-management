import type { Config } from '../../config/env.js';
import type { IIdentityRepository, IAuditRepository } from '../ports/IRepositories.js';
import { UnauthorizedError } from '../../domain/errors.js';

export interface DisconnectAccountInput {
  discordUserId: string;
  guildId: string;
}

export interface DisconnectAccountResult {
  unlinked: boolean;
  previousGithubUsername?: string;
  previousGithubUserId?: number;
  revocationUrl: string;
  message: string;
}

export class DisconnectAccountUseCase {
  constructor(
    private readonly identityRepository: IIdentityRepository,
    private readonly auditRepository: IAuditRepository,
    private readonly config: Pick<Config, 'DISCORD_GUILD_ID'>,
  ) {}

  public async execute(input: DisconnectAccountInput): Promise<DisconnectAccountResult> {
    if (input.guildId !== this.config.DISCORD_GUILD_ID) {
      throw new UnauthorizedError('Command is not permitted in this Discord server.');
    }

    const existing = await this.identityRepository.findByDiscordId(input.discordUserId);
    if (!existing) {
      return {
        unlinked: false,
        revocationUrl: 'https://github.com/settings/applications',
        message: 'Your Discord account is not linked to any GitHub account.',
      };
    }

    await this.identityRepository.unlinkIdentity(input.discordUserId);

    await this.auditRepository.recordAudit({
      actorDiscordId: input.discordUserId,
      actorGithubId: existing.githubUserId,
      actorGithubLogin: existing.githubUsername,
      action: 'ACCOUNT_UNLINK',
      outcome: 'SUCCESS',
      correlationId: `unlink-${input.discordUserId}`,
      beforeState: {
        githubUserId: existing.githubUserId,
        githubUsername: existing.githubUsername,
        applicationRole: existing.applicationRole,
      },
    });

    return {
      unlinked: true,
      previousGithubUsername: existing.githubUsername,
      previousGithubUserId: existing.githubUserId,
      revocationUrl: 'https://github.com/settings/applications',
      message: `Successfully unlinked your GitHub account (@${existing.githubUsername}).`,
    };
  }
}
