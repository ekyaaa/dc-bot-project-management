import type { Client } from 'discord.js';
import type {
  IDiscordNotificationSender,
  DiscordNotificationPayload,
} from '../../application/ports/IDiscordNotificationSender.js';
import type { Config } from '../../config/env.js';
import {
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  ExternalApiError,
  RateLimitError,
} from '../../domain/errors.js';

export class DiscordNotificationSender implements IDiscordNotificationSender {
  constructor(
    private readonly client: Client,
    private readonly config: Pick<Config, 'DISCORD_NOTIFICATION_CHANNEL_ID' | 'DISCORD_GUILD_ID'>,
  ) {}

  public async sendNotification(payload: DiscordNotificationPayload): Promise<{ messageId: string }> {
    // 1. Enforce Channel Allowlist
    if (payload.channelId !== this.config.DISCORD_NOTIFICATION_CHANNEL_ID) {
      throw new UnauthorizedError(
        `Security violation: Target channel '${payload.channelId}' does not match allowed notification channel '${this.config.DISCORD_NOTIFICATION_CHANNEL_ID}'.`,
      );
    }

    // 2. Resolve Channel (cache fallback to fetch)
    const channel = await this.resolveChannel(payload.channelId);

    // 3. Verify Guild Allowlist
    if ('guildId' in channel && channel.guildId && channel.guildId !== this.config.DISCORD_GUILD_ID) {
      throw new UnauthorizedError(
        `Security violation: Notification channel '${payload.channelId}' belongs to guild '${channel.guildId}', expected '${this.config.DISCORD_GUILD_ID}'.`,
      );
    }

    // 4. Verify channel is sendable
    if (!channel.isTextBased() || !('send' in channel) || typeof (channel as any).send !== 'function') {
      throw new ValidationError(
        `Notification channel '${payload.channelId}' is not a text channel capable of sending messages.`,
      );
    }

    // 5. Send message with strictly enforced safe mentions
    try {
      const message = await (channel as any).send({
        content: payload.content,
        embeds: payload.embeds,
        allowedMentions: {
          parse: [], // strictly empty
          users: payload.allowedMentions?.users ?? [],
          roles: [],
          repliedUser: false,
        },
      });

      return { messageId: message.id };
    } catch (error: any) {
      if (error?.status === 429 || error?.code === 429) {
        const retryAfter = error?.retryAfter ?? 5;
        throw new RateLimitError(`Discord rate limit hit on sending notification: ${error.message}`, retryAfter);
      }
      throw new ExternalApiError(
        `Failed to send Discord notification: ${error instanceof Error ? error.message : String(error)}`,
        error?.status ?? error?.code,
      );
    }
  }

  public async verifyChannel(channelId: string): Promise<boolean> {
    if (channelId !== this.config.DISCORD_NOTIFICATION_CHANNEL_ID) {
      return false;
    }
    try {
      const channel = await this.resolveChannel(channelId);
      if ('guildId' in channel && channel.guildId && channel.guildId !== this.config.DISCORD_GUILD_ID) {
        return false;
      }
      return channel.isTextBased() && 'send' in channel;
    } catch {
      return false;
    }
  }

  private async resolveChannel(channelId: string): Promise<any> {
    let channel: any = this.client.channels.cache.get(channelId);
    if (!channel) {
      try {
        channel = await this.client.channels.fetch(channelId);
      } catch (error: any) {
        if (error?.code === 10003 || error?.status === 404) {
          throw new NotFoundError(`Discord notification channel '${channelId}' not found.`);
        }
        if (error?.code === 50001 || error?.status === 403) {
          throw new UnauthorizedError(`Missing access to Discord notification channel '${channelId}'.`);
        }
        throw new ExternalApiError(
          `Failed to fetch Discord notification channel '${channelId}': ${error instanceof Error ? error.message : String(error)}`,
          error?.status ?? error?.code,
        );
      }
    }

    if (!channel) {
      throw new NotFoundError(`Discord notification channel '${channelId}' not found.`);
    }

    return channel;
  }
}
