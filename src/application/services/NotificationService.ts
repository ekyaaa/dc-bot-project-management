import type { IOutboxRepository, IIdentityRepository, OutboxRecord } from '../ports/IRepositories.js';
import type { IDiscordNotificationSender } from '../ports/IDiscordNotificationSender.js';
import type { Config } from '../../config/env.js';
import { MentionPolicy } from '../../domain/policies.js';
import {
  buildIssueWebhookEmbed,
  buildPullRequestWebhookEmbed,
  buildCiFailureWebhookEmbed,
} from '../../interfaces/discord/embeds.js';
import type { DispatchDailyDigestUseCase } from '../usecases/DispatchDailyDigestUseCase.js';
import type { ProjectRepository } from '../../infrastructure/persistence/repositories/ProjectRepository.js';

export interface NotificationWorkerOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface EventRoutingDecision {
  shouldSend: boolean;
  content?: string;
  embeds?: unknown[];
  allowedMentions?: { parse: never[]; users: string[] };
}

export class NotificationService {
  private readonly outboxRepository: IOutboxRepository;
  private readonly identityRepository: IIdentityRepository;
  private readonly discordSender: IDiscordNotificationSender;
  private readonly config: Pick<
    Config,
    'DISCORD_NOTIFICATION_CHANNEL_ID' | 'DISCORD_GUILD_ID' | 'GITHUB_OWNER' | 'GITHUB_REPOSITORY'
  >;
  private readonly options: Required<NotificationWorkerOptions>;
  private readonly dispatchDailyDigestUseCase?: DispatchDailyDigestUseCase;
  private readonly projectRepository?: ProjectRepository;

  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly nextRetrySchedule = new Map<number, number>();

  constructor(
    outboxRepository: IOutboxRepository,
    identityRepository: IIdentityRepository,
    discordSender: IDiscordNotificationSender,
    config: Pick<
      Config,
      'DISCORD_NOTIFICATION_CHANNEL_ID' | 'DISCORD_GUILD_ID' | 'GITHUB_OWNER' | 'GITHUB_REPOSITORY'
    >,
    options: NotificationWorkerOptions = {},
    dispatchDailyDigestUseCase?: DispatchDailyDigestUseCase,
    projectRepository?: ProjectRepository,
  ) {
    this.outboxRepository = outboxRepository;
    this.identityRepository = identityRepository;
    this.discordSender = discordSender;
    this.config = config;
    this.options = {
      batchSize: options.batchSize ?? 10,
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      maxAttempts: options.maxAttempts ?? 5,
      baseBackoffMs: options.baseBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 60000,
    };
    this.dispatchDailyDigestUseCase = dispatchDailyDigestUseCase;
    this.projectRepository = projectRepository;
  }

  public async ingestWebhook(deliveryId: string, eventType: string, rawPayload: string): Promise<void> {
    await this.outboxRepository.enqueueDelivery(deliveryId, eventType, rawPayload);
  }

  public async processOutboxBatch(batchSize: number = this.options.batchSize): Promise<number> {
    if (this.isProcessing) {
      return 0;
    }
    this.isProcessing = true;

    try {
      const pending = await this.outboxRepository.fetchPendingDeliveries(batchSize);
      if (pending.length === 0) {
        return 0;
      }

      let processedCount = 0;
      const now = Date.now();

      for (const record of pending) {
        // 1. Check backoff window
        const nextAttempt = this.nextRetrySchedule.get(record.id) ?? 0;
        if (now < nextAttempt) {
          continue;
        }

        try {
          await this.processSingleRecord(record);
          await this.outboxRepository.markProcessed(record.id);
          this.nextRetrySchedule.delete(record.id);
          processedCount++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          const maxAttempts = this.options.maxAttempts ?? record.maxAttempts;
          await this.outboxRepository.recordFailure(record.id, errorMsg, maxAttempts);

          const nextAttempts = record.attempts + 1;
          if (nextAttempts < maxAttempts) {
            const delay = Math.min(
              this.options.maxBackoffMs,
              this.options.baseBackoffMs * Math.pow(2, nextAttempts - 1),
            );
            this.nextRetrySchedule.set(record.id, Date.now() + delay);
          } else {
            this.nextRetrySchedule.delete(record.id);
          }
        }
      }

      return processedCount;
    } finally {
      this.isProcessing = false;
    }
  }

  public async dispatchDailyDigest(force?: boolean): Promise<boolean> {
    if (!this.dispatchDailyDigestUseCase) {
      return false;
    }
    const result = await this.dispatchDailyDigestUseCase.execute({ force });
    return result.dispatched;
  }

  public startWorker(intervalMs: number = this.options.pollIntervalMs): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.processOutboxBatch().catch((err) => {
        console.error('[NotificationService] Background outbox batch error:', err);
      });
    }, intervalMs);
    this.pollTimer.unref();
  }

  public stopWorker(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public get isWorkerRunning(): boolean {
    return this.pollTimer !== null;
  }

  private async processSingleRecord(record: OutboxRecord): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(record.payloadJson);
    } catch {
      // Invalid JSON in outbox payload cannot be retried; mark failure
      throw new Error(`Corrupted payload JSON in outbox record #${record.id}`);
    }

    const decision = await this.routeEvent(record.eventType, payload);

    if (decision.shouldSend && decision.embeds && decision.embeds.length > 0) {
      const repoOwner = payload?.repository?.owner?.login || this.config.GITHUB_OWNER;
      const repoName = payload?.repository?.name || this.config.GITHUB_REPOSITORY;

      const targets = this.projectRepository?.getNotificationTargetsForRepo(repoOwner, repoName) || [];
      const validChannels = targets
        .map((t) => t.notification_channel_id)
        .filter((c): c is string => Boolean(c));

      const targetChannels = validChannels.length > 0
        ? Array.from(new Set(validChannels))
        : [this.config.DISCORD_NOTIFICATION_CHANNEL_ID];

      for (const channelId of targetChannels) {
        await this.discordSender.sendNotification({
          channelId,
          content: decision.content,
          embeds: decision.embeds,
          allowedMentions: decision.allowedMentions ?? MentionPolicy.buildSafeAllowedMentions([]),
        });
      }
    }
  }

  public async routeEvent(eventType: string, payload: any): Promise<EventRoutingDecision> {
    switch (eventType) {
      case 'ping':
        return { shouldSend: false };

      case 'issues':
        return this.routeIssuesEvent(payload);

      case 'pull_request':
        return this.routePullRequestEvent(payload);

      case 'workflow_run':
        return this.routeWorkflowRunEvent(payload);

      case 'check_suite':
        return this.routeCheckSuiteEvent(payload);

      default:
        return { shouldSend: false };
    }
  }

  private async routeIssuesEvent(payload: any): Promise<EventRoutingDecision> {
    const action = payload?.action;
    const allowedActions = ['opened', 'assigned', 'reopened', 'closed'] as const;

    if (!allowedActions.includes(action)) {
      return { shouldSend: false };
    }

    const issue = payload.issue;
    if (!issue || !issue.number) {
      return { shouldSend: false };
    }

    let targetDiscordUserId: string | null = null;
    let content: string | undefined;

    if (action === 'assigned' && payload.assignee?.id) {
      const numericId = Number(payload.assignee.id);
      const link = await this.identityRepository.findByGithubId(numericId);
      if (link) {
        targetDiscordUserId = link.discordUserId;
        content = `🔔 <@${targetDiscordUserId}> Anda ditugaskan pada issue **#${issue.number}**!`;
      } else {
        const rawLogin = payload.assignee.login ?? 'user';
        content = MentionPolicy.sanitizeDiscordMentions(`🔔 **@${rawLogin}** ditugaskan pada issue **#${issue.number}**`);
      }
    }

    const embed = buildIssueWebhookEmbed(action, {
      number: issue.number,
      title: MentionPolicy.sanitizeDiscordMentions(issue.title ?? ''),
      htmlUrl: issue.html_url ?? '',
      body: issue.body ? MentionPolicy.sanitizeDiscordMentions(issue.body) : undefined,
      author: MentionPolicy.sanitizeDiscordMentions(issue.user?.login ?? 'unknown'),
      assigneeLogin: payload.assignee?.login
        ? MentionPolicy.sanitizeDiscordMentions(payload.assignee.login)
        : undefined,
    });

    return {
      shouldSend: true,
      content,
      embeds: [embed],
      allowedMentions: MentionPolicy.buildSafeAllowedMentions(
        targetDiscordUserId ? [targetDiscordUserId] : [],
      ),
    };
  }

  private async routePullRequestEvent(payload: any): Promise<EventRoutingDecision> {
    const action = payload?.action;
    const pr = payload.pull_request;

    if (!pr || !pr.number) {
      return { shouldSend: false };
    }

    if (action === 'review_requested') {
      let targetDiscordUserId: string | null = null;
      let reviewerLogin = payload.requested_reviewer?.login ?? 'reviewer';
      let content: string;

      if (payload.requested_reviewer?.id) {
        const numericId = Number(payload.requested_reviewer.id);
        const link = await this.identityRepository.findByGithubId(numericId);
        if (link) {
          targetDiscordUserId = link.discordUserId;
          content = `🔍 <@${targetDiscordUserId}> Anda diminta meninjau Pull Request **#${pr.number}**!`;
        } else {
          content = MentionPolicy.sanitizeDiscordMentions(`🔍 **@${reviewerLogin}** diminta meninjau Pull Request **#${pr.number}**`);
        }
      } else {
        content = MentionPolicy.sanitizeDiscordMentions(`🔍 **@${reviewerLogin}** diminta meninjau Pull Request **#${pr.number}**`);
      }

      const embed = buildPullRequestWebhookEmbed('review_requested', {
        number: pr.number,
        title: MentionPolicy.sanitizeDiscordMentions(pr.title ?? ''),
        htmlUrl: pr.html_url ?? '',
        author: MentionPolicy.sanitizeDiscordMentions(pr.user?.login ?? 'unknown'),
        headRef: pr.head?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.head.ref) : undefined,
        baseRef: pr.base?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.base.ref) : undefined,
        requestedReviewerLogin: MentionPolicy.sanitizeDiscordMentions(reviewerLogin),
      });

      return {
        shouldSend: true,
        content,
        embeds: [embed],
        allowedMentions: MentionPolicy.buildSafeAllowedMentions(
          targetDiscordUserId ? [targetDiscordUserId] : [],
        ),
      };
    }

    if (action === 'ready_for_review') {
      const embed = buildPullRequestWebhookEmbed('ready_for_review', {
        number: pr.number,
        title: MentionPolicy.sanitizeDiscordMentions(pr.title ?? ''),
        htmlUrl: pr.html_url ?? '',
        author: MentionPolicy.sanitizeDiscordMentions(pr.user?.login ?? 'unknown'),
        headRef: pr.head?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.head.ref) : undefined,
        baseRef: pr.base?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.base.ref) : undefined,
      });

      return {
        shouldSend: true,
        embeds: [embed],
        allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
      };
    }

    if (action === 'closed') {
      const prAction = pr.merged === true ? 'merged' : 'closed';
      const embed = buildPullRequestWebhookEmbed(prAction, {
        number: pr.number,
        title: MentionPolicy.sanitizeDiscordMentions(pr.title ?? ''),
        htmlUrl: pr.html_url ?? '',
        author: MentionPolicy.sanitizeDiscordMentions(pr.user?.login ?? 'unknown'),
        headRef: pr.head?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.head.ref) : undefined,
        baseRef: pr.base?.ref ? MentionPolicy.sanitizeDiscordMentions(pr.base.ref) : undefined,
      });

      return {
        shouldSend: true,
        embeds: [embed],
        allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
      };
    }

    return { shouldSend: false };
  }

  private async routeWorkflowRunEvent(payload: any): Promise<EventRoutingDecision> {
    if (payload?.action !== 'completed') {
      return { shouldSend: false };
    }

    const run = payload.workflow_run;
    if (!run) {
      return { shouldSend: false };
    }

    // Only failure or timed_out trigger notification
    if (!['failure', 'timed_out'].includes(run.conclusion)) {
      return { shouldSend: false };
    }

    // Branch filter: default branch or PR branches only
    const defaultBranch = payload.repository?.default_branch || 'main';
    const headBranch = run.head_branch ?? '';
    const isDefaultBranch = headBranch === defaultBranch || ['main', 'master'].includes(headBranch);
    const isPrBranch = Array.isArray(run.pull_requests) && run.pull_requests.length > 0;

    if (!isDefaultBranch && !isPrBranch) {
      return { shouldSend: false };
    }

    let targetDiscordUserId: string | null = null;
    let content: string | undefined;

    if (run.actor?.id) {
      const numericId = Number(run.actor.id);
      const link = await this.identityRepository.findByGithubId(numericId);
      if (link) {
        targetDiscordUserId = link.discordUserId;
        content = `⚠️ <@${targetDiscordUserId}> Pipeline CI gagal pada workflow **${MentionPolicy.sanitizeDiscordMentions(run.name ?? '')}**!`;
      } else {
        const rawLogin = run.actor?.login ?? 'user';
        content = MentionPolicy.sanitizeDiscordMentions(`⚠️ Pipeline CI gagal untuk commit oleh **@${rawLogin}**`);
      }
    }

    const repoFullName = MentionPolicy.sanitizeDiscordMentions(
      payload.repository?.full_name ?? `${this.config.GITHUB_OWNER}/${this.config.GITHUB_REPOSITORY}`,
    );

    const embed = buildCiFailureWebhookEmbed({
      name: MentionPolicy.sanitizeDiscordMentions(run.name ?? 'CI Workflow'),
      htmlUrl: run.html_url ?? '',
      headBranch: MentionPolicy.sanitizeDiscordMentions(headBranch),
      headSha: run.head_sha ?? '',
      conclusion: run.conclusion,
      actorLogin: MentionPolicy.sanitizeDiscordMentions(run.actor?.login ?? 'unknown'),
      repoFullName,
    });

    return {
      shouldSend: true,
      content,
      embeds: [embed],
      allowedMentions: MentionPolicy.buildSafeAllowedMentions(
        targetDiscordUserId ? [targetDiscordUserId] : [],
      ),
    };
  }

  private async routeCheckSuiteEvent(payload: any): Promise<EventRoutingDecision> {
    const suite = payload?.check_suite;
    if (!suite) {
      return { shouldSend: false };
    }

    // Suppress GitHub Actions check_suites to prevent duplicate alerts from workflow_run
    if (suite.app?.slug === 'github-actions') {
      return { shouldSend: false };
    }

    if (payload.action !== 'completed') {
      return { shouldSend: false };
    }

    if (!['failure', 'timed_out'].includes(suite.conclusion)) {
      return { shouldSend: false };
    }

    // Branch filter: default branch or PR branches
    const defaultBranch = payload.repository?.default_branch || 'main';
    const headBranch = suite.head_branch ?? '';
    const isDefaultBranch = headBranch === defaultBranch || ['main', 'master'].includes(headBranch);
    const isPrBranch = Array.isArray(suite.pull_requests) && suite.pull_requests.length > 0;

    if (!isDefaultBranch && !isPrBranch) {
      return { shouldSend: false };
    }

    const repoFullName = MentionPolicy.sanitizeDiscordMentions(
      payload.repository?.full_name ?? `${this.config.GITHUB_OWNER}/${this.config.GITHUB_REPOSITORY}`,
    );

    const embed = buildCiFailureWebhookEmbed({
      name: MentionPolicy.sanitizeDiscordMentions(suite.app?.name ?? 'Check Suite'),
      htmlUrl: suite.html_url ?? payload.repository?.html_url ?? '',
      headBranch: MentionPolicy.sanitizeDiscordMentions(headBranch),
      headSha: suite.head_sha ?? '',
      conclusion: suite.conclusion,
      actorLogin: MentionPolicy.sanitizeDiscordMentions(payload.sender?.login ?? 'unknown'),
      repoFullName,
    });

    return {
      shouldSend: true,
      embeds: [embed],
      allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
    };
  }
}
