import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DispatchDailyDigestUseCase } from '../../src/application/usecases/DispatchDailyDigestUseCase.js';
import { ScheduleRepository } from '../../src/infrastructure/persistence/repositories/ScheduleRepository.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';
import { EMBED_COLORS } from '../../src/interfaces/discord/embeds.js';

describe('Daily Digest & SQLite Deduplication: DispatchDailyDigestUseCase', () => {
  let db: Database.Database;
  let scheduleRepo: ScheduleRepository;
  let gitHubService: MockGitHubService;
  let discordSender: MockDiscordNotificationSender;

  const CONFIG = {
    GITHUB_PROJECT_NUMBER: 1,
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_digest_alerts',
    DIGEST_ENABLED: true,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    scheduleRepo = new ScheduleRepository(db);
    gitHubService = new MockGitHubService();
    discordSender = new MockDiscordNotificationSender();

    // Populate mock GitHub data
    gitHubService.issues.set(10, {
      number: 10,
      title: 'Database connection timeout',
      htmlUrl: 'https://github.com/example/repo/issues/10',
      state: 'OPEN',
      projectStatus: 'Blocked',
      projectPriority: 'Urgent',
      assignees: ['alice'],
      author: 'dan',
      labels: ['bug'],
      blockedReason: 'Waiting on upstream DB provider fix',
      blockedAt: '2026-11-01T10:00:00Z',
      commentsCount: 2,
      createdAt: '2026-11-01T09:00:00Z',
      updatedAt: '2026-11-01T10:00:00Z',
    });

    gitHubService.issues.set(11, {
      number: 11,
      title: 'Orphaned task needs owner',
      htmlUrl: 'https://github.com/example/repo/issues/11',
      state: 'OPEN',
      projectStatus: 'Ready',
      projectPriority: 'High',
      assignees: [], // Unassigned
      author: 'carol',
      labels: ['enhancement'],
      commentsCount: 0,
      createdAt: '2026-11-02T09:00:00Z',
      updatedAt: '2026-11-02T09:00:00Z',
    });

    gitHubService.reviewRequests = [
      {
        pullNumber: 201,
        title: 'Add webhook signature validation',
        htmlUrl: 'https://github.com/example/repo/pull/201',
        author: 'alice',
        requestedReviewers: ['bob'],
        draft: false,
        createdAt: '2026-11-03T10:00:00Z',
        updatedAt: '2026-11-03T11:00:00Z',
      },
    ];
  });

  afterEach(() => {
    db.close();
  });

  it('runs first daily digest successfully and records execution in SQLite', async () => {
    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);

    const result = await useCase.execute({ targetDate: '2026-11-04' });
    expect(result.dispatched).toBe(true);
    expect(result.reason).toBe('SUCCESS');
    expect(result.dateStr).toBe('2026-11-04');
    expect(result.projectNumber).toBe(1);

    // Verify 1 notification sent to Discord
    expect(discordSender.sentNotifications).toHaveLength(1);
    const sent = discordSender.sentNotifications[0];
    expect(sent.channelId).toBe('channel_digest_alerts');
    expect(sent.allowedMentions.parse).toEqual([]);
    expect(sent.allowedMentions.users).toEqual([]);

    // Verify embed content
    const embed: any = sent.embeds![0];
    expect(embed.data.title).toContain('Ringkasan Harian Proyek');
    expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED); // Blocked issues exist!
    expect(embed.data.footer.text).toContain('2026-11-04');
    expect(embed.data.footer.text).toContain('09:00 WIB');

    // Verify SQLite record exists
    const isRecorded = await scheduleRepo.isExecutedForDate('digest:1', '2026-11-04');
    expect(isRecorded).toBe(true);
  });

  it('simulates bot restart on same day and prevents duplicate execution', async () => {
    // Initial run succeeds
    const firstInstance = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);
    const firstResult = await firstInstance.execute({ targetDate: '2026-11-04' });
    expect(firstResult.dispatched).toBe(true);
    expect(discordSender.sentNotifications).toHaveLength(1);

    // Simulate bot restart: create new usecase and repository instance pointing to the same SQLite database
    const restartedScheduleRepo = new ScheduleRepository(db);
    const restartedInstance = new DispatchDailyDigestUseCase(
      gitHubService,
      restartedScheduleRepo,
      discordSender,
      CONFIG,
    );

    const secondResult = await restartedInstance.execute({ targetDate: '2026-11-04' });
    expect(secondResult.dispatched).toBe(false);
    expect(secondResult.reason).toBe('ALREADY_EXECUTED');

    // Total messages sent to Discord remains 1 (no duplicate spam)
    expect(discordSender.sentNotifications).toHaveLength(1);
  });

  it('allows execution on the next day', async () => {
    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);

    // Day 1
    const res1 = await useCase.execute({ targetDate: '2026-11-04' });
    expect(res1.dispatched).toBe(true);
    expect(discordSender.sentNotifications).toHaveLength(1);

    // Day 2 (simulate 24 hours passing so in-flight 300s lease has expired)
    db.prepare("UPDATE schedule_leases SET expires_at = datetime('now', '-10 seconds') WHERE lease_key = 'lease:digest:1'").run();

    const res2 = await useCase.execute({ targetDate: '2026-11-05' });
    expect(res2.dispatched).toBe(true);
    expect(res2.reason).toBe('SUCCESS');
    expect(discordSender.sentNotifications).toHaveLength(2);
  });

  it('aborts with LEASE_LOCKED when concurrent instance holds active lease', async () => {
    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);

    // Another process holds active lease
    const leaseAcquired = await scheduleRepo.acquireLease('lease:digest:1', 300);
    expect(leaseAcquired).toBe(true);

    const result = await useCase.execute({ targetDate: '2026-11-06' });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('LEASE_LOCKED');

    // No Discord message sent
    expect(discordSender.sentNotifications).toHaveLength(0);
  });

  it('allows forced execution bypassing already executed state', async () => {
    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);

    await useCase.execute({ targetDate: '2026-11-04' });
    expect(discordSender.sentNotifications).toHaveLength(1);

    const forceResult = await useCase.execute({ targetDate: '2026-11-04', force: true });
    expect(forceResult.dispatched).toBe(true);
    expect(forceResult.reason).toBe('SUCCESS');
    expect(discordSender.sentNotifications).toHaveLength(2);
  });

  it('renders BRAND color when there are zero blocked issues', async () => {
    // Clear all blocked issues
    for (const [num, issue] of gitHubService.issues.entries()) {
      if (issue.projectStatus === 'Blocked') {
        gitHubService.issues.delete(num);
      }
    }

    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, CONFIG);
    const result = await useCase.execute({ targetDate: '2026-11-07' });
    expect(result.dispatched).toBe(true);

    const embed: any = discordSender.sentNotifications[0].embeds![0];
    expect(embed.data.color).toBe(EMBED_COLORS.BRAND);
  });

  it('aborts with DISABLED when feature flag DIGEST_ENABLED is false', async () => {
    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, discordSender, {
      ...CONFIG,
      DIGEST_ENABLED: false,
    });

    const result = await useCase.execute({ targetDate: '2026-11-04' });
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('DISABLED');
    expect(discordSender.sentNotifications).toHaveLength(0);
  });

  it('supports raw Discord Client instance with channels.fetch', async () => {
    let sentMessages: any[] = [];
    const mockRawChannel: any = {
      isTextBased: () => true,
      send: async (msg: any) => {
        sentMessages.push(msg);
        return { id: 'raw_1' };
      },
    };

    const mockRawClient: any = {
      channels: {
        cache: new Map(),
        fetch: async () => mockRawChannel,
      },
    };

    const useCase = new DispatchDailyDigestUseCase(gitHubService, scheduleRepo, mockRawClient, CONFIG);
    const result = await useCase.execute({ targetDate: '2026-11-08' });
    expect(result.dispatched).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].allowedMentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    });
  });
});
