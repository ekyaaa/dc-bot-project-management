import type { Client } from 'discord.js';
import type { IGitHubService } from '../ports/IGitHubService.js';
import type { IScheduleRepository } from '../ports/IRepositories.js';
import type { IDiscordNotificationSender } from '../ports/IDiscordNotificationSender.js';
import type { ProjectRepository } from '../../infrastructure/persistence/repositories/ProjectRepository.js';
import type { GitHubServiceFactory } from '../../infrastructure/github/GitHubServiceFactory.js';
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
    private readonly projectRepository?: ProjectRepository,
    private readonly gitHubServiceFactory?: GitHubServiceFactory,
  ) {}

  public async execute(options?: DispatchDailyDigestOptions): Promise<DispatchDailyDigestResult> {
    const isEnabled = this.config.DIGEST_ENABLED ?? this.config.SCHEDULED_DIGEST_ENABLED ?? false;
    const projectNumber = this.config.GITHUB_PROJECT_NUMBER;
    const dateStr = options?.targetDate ?? getJakartaDateString();

    // 1. Feature Flag Guard
    if (!isEnabled && !options?.force) {
      return {
        dispatched: false,
        reason: 'DISABLED',
        dateStr,
        projectNumber,
      };
    }

    // 2. Multi-project dispatch branch
    if (this.projectRepository && this.gitHubServiceFactory) {
      const projects = this.projectRepository.getAllProjects();
      let anyDispatched = false;

      for (const project of projects) {
        const targets = this.projectRepository.getNotificationTargetsForRepo(
          project.github_owner,
          project.github_repo,
        );

        const validChannels = Array.from(
          new Set(
            targets
              .map((t) => t.notification_channel_id)
              .filter((c): c is string => Boolean(c)),
          ),
        );

        if (validChannels.length === 0) continue;

        const jobKey = `digest:${project.id}`;
        const leaseKey = `lease:${jobKey}`;

        if (!options?.force) {
          const alreadyExecuted = await this.scheduleRepository.isExecutedForDate(jobKey, dateStr);
          if (alreadyExecuted) continue;
        }

        const leaseAcquired = await this.scheduleRepository.acquireLease(leaseKey, 300);
        if (!leaseAcquired && !options?.force) continue;

        try {
          const service = this.gitHubServiceFactory.getServiceForProject(project);
          const [summary, blocked, unassigned, reviews] = await Promise.all([
            service.getProjectSummary(),
            service.listBlockedIssues(),
            service.listUnassignedIssues(),
            service.listReviewRequests(),
          ]);

          const embed = buildDigestEmbed(summary, blocked, reviews, unassigned, {
            isScheduled: true,
            dateStr,
          });

          for (const channelId of validChannels) {
            await this.sendDigestToChannel(channelId, embed);
          }

          await this.scheduleRepository.recordExecution(jobKey, dateStr);
          anyDispatched = true;
        } catch (err) {
          console.error(`[DispatchDailyDigestUseCase] Failed for project ${project.id}:`, err);
        }
      }

      return {
        dispatched: anyDispatched,
        reason: anyDispatched ? 'SUCCESS' : 'ALREADY_EXECUTED',
        dateStr,
        projectNumber,
      };
    }

    // 3. Single-tenant fallback (for unit tests / backward compatibility)
    const jobKey = `digest:${projectNumber}`;
    const leaseKey = `lease:${jobKey}`;

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

    const leaseAcquired = await this.scheduleRepository.acquireLease(leaseKey, 300);
    if (!leaseAcquired && !options?.force) {
      return {
        dispatched: false,
        reason: 'LEASE_LOCKED',
        dateStr,
        projectNumber,
      };
    }

    const [summary, blocked, unassigned, reviews] = await Promise.all([
      this.gitHubService.getProjectSummary(),
      this.gitHubService.listBlockedIssues(),
      this.gitHubService.listUnassignedIssues(),
      this.gitHubService.listReviewRequests(),
    ]);

    const embed = buildDigestEmbed(summary, blocked, reviews, unassigned, {
      isScheduled: true,
      dateStr,
    });

    await this.sendDigestToChannel(this.config.DISCORD_NOTIFICATION_CHANNEL_ID, embed);
    await this.scheduleRepository.recordExecution(jobKey, dateStr);

    return {
      dispatched: true,
      reason: 'SUCCESS',
      dateStr,
      projectNumber,
    };
  }

  private async sendDigestToChannel(channelId: string, embed: any): Promise<void> {
    const allowedMentions = MentionPolicy.buildSafeAllowedMentions([]);

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
  }
}
