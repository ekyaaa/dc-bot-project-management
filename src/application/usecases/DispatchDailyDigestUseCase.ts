import type { Client } from 'discord.js';
import type { IGitHubService } from '../ports/IGitHubService.js';
import type { IScheduleRepository } from '../ports/IRepositories.js';
import type { IDiscordNotificationSender } from '../ports/IDiscordNotificationSender.js';
import type { Config } from '../../config/env.js';
import { MentionPolicy } from '../../domain/policies.js';
import { buildDigestEmbed } from '../../interfaces/discord/embeds.js';
import { getJakartaDateString } from '../../infrastructure/scheduling/dateUtils.js';

export interface DispatchDailyDigestOptions {
  force?: boolean;
  targetDate?: string;
}

export interface DispatchDailyDigestResult {
  dispatched: boolean;
  reason?: 'DISABLED' | 'ALREADY_EXECUTED' | 'LEASE_LOCKED' | 'SUCCESS';
  dateStr: string;
  projectNumber: number;
}

export type DiscordDigestTarget = IDiscordNotificationSender | Client;

export class DispatchDailyDigestUseCase {
  constructor(
    private readonly gitHubService: IGitHubService,
    private readonly scheduleRepository: IScheduleRepository,
    private readonly discordTarget: DiscordDigestTarget,
    private readonly config: Pick<
      Config,
      'GITHUB_PROJECT_NUMBER' | 'DISCORD_NOTIFICATION_CHANNEL_ID' | 'DIGEST_ENABLED'
    > & { SCHEDULED_DIGEST_ENABLED?: boolean },
  ) {}

  public async execute(options?: DispatchDailyDigestOptions): Promise<DispatchDailyDigestResult> {
    const isEnabled = this.config.DIGEST_ENABLED ?? this.config.SCHEDULED_DIGEST_ENABLED ?? false;
    const projectNumber = this.config.GITHUB_PROJECT_NUMBER;

    // 1. Feature Flag Guard
    if (!isEnabled && !options?.force) {
      return {
        dispatched: false,
        reason: 'DISABLED',
        dateStr: options?.targetDate ?? getJakartaDateString(),
        projectNumber,
      };
    }

    const dateStr = options?.targetDate ?? getJakartaDateString();
    const jobKey = `digest:${projectNumber}`;
    const leaseKey = `lease:${jobKey}`;

    // 2. Check Idempotency / Deduplication across Restarts
    if (!options?.force) {
      const alreadyExecuted = await this.scheduleRepository.isExecutedForDate(jobKey, dateStr);
      if (alreadyExecuted) {
        return {
          dispatched: false,
          reason: 'ALREADY_EXECUTED',
          dateStr,
          projectNumber,
        };
      }
    }

    // 3. Acquire Distributed Lease (300 seconds TTL)
    const leaseAcquired = await this.scheduleRepository.acquireLease(leaseKey, 300);
    if (!leaseAcquired && !options?.force) {
      return {
        dispatched: false,
        reason: 'LEASE_LOCKED',
        dateStr,
        projectNumber,
      };
    }

    // 4. Query GitHub Services Concurrently
    const [summary, blocked, unassigned, reviews] = await Promise.all([
      this.gitHubService.getProjectSummary(),
      this.gitHubService.listBlockedIssues(),
      this.gitHubService.listUnassignedIssues(),
      this.gitHubService.listReviewRequests(),
    ]);

    // 5. Build Indonesian Digest Card Embed
    const embed = buildDigestEmbed(summary, blocked, reviews, unassigned, {
      isScheduled: true,
      dateStr,
    });

    // 6. Dispatch to Discord Notification Channel with Safe Mentions
    const allowedMentions = MentionPolicy.buildSafeAllowedMentions([]);
    const channelId = this.config.DISCORD_NOTIFICATION_CHANNEL_ID;

    if ('sendNotification' in this.discordTarget) {
      await this.discordTarget.sendNotification({
        channelId,
        embeds: [embed],
        allowedMentions,
      });
    } else {
      let channel: any = this.discordTarget.channels.cache.get(channelId);
      if (!channel) {
        channel = await this.discordTarget.channels.fetch(channelId);
      }
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`Target notification channel '${channelId}' not found or cannot send messages.`);
      }
      await (channel as any).send({
        embeds: [embed],
        allowedMentions: {
          parse: [],
          users: [],
          roles: [],
          repliedUser: false,
        },
      });
    }

    // 7. Record Durable Execution in SQLite
    await this.scheduleRepository.recordExecution(jobKey, dateStr);

    return {
      dispatched: true,
      reason: 'SUCCESS',
      dateStr,
      projectNumber,
    };
  }
}
