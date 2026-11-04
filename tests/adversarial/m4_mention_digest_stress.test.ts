import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';
import { MentionPolicy } from '../../src/domain/policies.js';
import { NotificationService } from '../../src/application/services/NotificationService.js';
import { DiscordNotificationSender } from '../../src/interfaces/discord/notificationSender.js';
import { DispatchDailyDigestUseCase } from '../../src/application/usecases/DispatchDailyDigestUseCase.js';
import { ScheduleRepository } from '../../src/infrastructure/persistence/repositories/ScheduleRepository.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { getJakartaDateString } from '../../src/infrastructure/scheduling/dateUtils.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import { CryptoService } from '../../src/infrastructure/crypto/crypto.js';
import { UnauthorizedError, ValidationError, NotFoundError } from '../../src/domain/errors.js';
import { EMBED_COLORS } from '../../src/interfaces/discord/embeds.js';

describe('Adversarial Verification: Milestone 4 (Mention Safety, Routing & Daily Digest Stress)', () => {
  let db: DatabaseInstance;
  let outboxRepo: OutboxRepository;
  let identityRepo: IdentityRepository;
  let scheduleRepo: ScheduleRepository;
  let mockSender: MockDiscordNotificationSender;
  let mockGitHubService: MockGitHubService;
  let notificationService: NotificationService;

  const CONFIG = {
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_safe_notif_999',
    DISCORD_GUILD_ID: 'guild_authorized_111',
    GITHUB_OWNER: 'adversarial-org',
    GITHUB_REPOSITORY: 'hardened-repo',
    GITHUB_PROJECT_NUMBER: 42,
    DIGEST_ENABLED: true,
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    outboxRepo = new OutboxRepository(db);
    identityRepo = new IdentityRepository(db);
    scheduleRepo = new ScheduleRepository(db);
    mockSender = new MockDiscordNotificationSender();
    mockGitHubService = new MockGitHubService();

    notificationService = new NotificationService(
      outboxRepo,
      identityRepo,
      mockSender,
      CONFIG,
    );

    // Seed linked identities
    await identityRepo.linkIdentity('discord_legit_dev', 10001, 'legit_dev');
    await identityRepo.linkIdentity('discord_legit_rev', 20002, 'legit_reviewer');
  });

  afterEach(() => {
    if (db.open) db.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SUITE 1: MENTION SAFETY & INJECTION ATTACKS
  // =========================================================================
  describe('1. Mention Safety & Injection Attacks', () => {
    describe('1.1 Adversarial Payload String Neutralization', () => {
      it('neutralizes raw @everyone and @here across varied casing and whitespace', () => {
        const attackVectors = [
          '@everyone',
          '@EVERYONE',
          '@EveryOne',
          '@here',
          '@HERE',
          '@Here',
          'Hello @everyone\nCheck this out',
          '@everyone@here',
          'Pinging @everyone now!',
        ];

        for (const vector of attackVectors) {
          const sanitized = MentionPolicy.sanitizeDiscordMentions(vector);
          expect(sanitized).not.toMatch(/(?<!\u200b)@everyone/i);
          expect(sanitized).not.toMatch(/(?<!\u200b)@here/i);
          expect(sanitized).toContain('\u200b');
        }
      });

      it('neutralizes role mention injections <@&roleId>', () => {
        const roleVectors = [
          '<@&123456789012345678>',
          '<@&999>',
          'Urgent escalation: <@&888888888888888888> required immediately!',
          '<@&111><@&222><@&333>',
        ];

        for (const vector of roleVectors) {
          const sanitized = MentionPolicy.sanitizeDiscordMentions(vector);
          expect(sanitized).not.toMatch(/<@&[0-9]+>/);
          expect(sanitized).toMatch(/<@&\u200b[0-9]+>/);
        }
      });

      it('neutralizes raw user mention injections (<@userId> and <@!userId>)', () => {
        const userVectors = [
          '<@123456789012345678>',
          '<@!987654321098765432>',
          'Created by <@!111222333444> for test',
          '<@111><@!222>',
        ];

        for (const vector of userVectors) {
          const sanitized = MentionPolicy.sanitizeDiscordMentions(vector);
          expect(sanitized).not.toMatch(/<@!?[0-9]+>/);
          expect(sanitized).toMatch(/<@\u200b[0-9]+>/);
        }
      });

      it('handles unicode zero-width space collisions and double injection attempts', () => {
        // Pre-existing zero-width space trick (trying to evade regex)
        const tricky = 'Pre-sanitized: @\u200beveryone and @\u200bhere';
        const sanitized = MentionPolicy.sanitizeDiscordMentions(tricky);
        // Must still not contain raw un-escaped mention
        expect(sanitized).not.toMatch(/(?<!\u200b)@everyone/i);

        // Multiple zero-width spaces
        const multi = '@\u200b\u200beveryone';
        const res = MentionPolicy.sanitizeDiscordMentions(multi);
        expect(res).not.toMatch(/(?<!\u200b)@everyone/i);
      });

      it('handles newline, control character and markdown injection', () => {
        const injection = 'Line 1\r\n@everyone\n\t<@&12345>\x00\b**@here**';
        const sanitized = MentionPolicy.sanitizeDiscordMentions(injection);
        expect(sanitized).not.toMatch(/(?<!\u200b)@everyone/i);
        expect(sanitized).not.toMatch(/(?<!\u200b)@here/i);
        expect(sanitized).not.toMatch(/<@&[0-9]+>/);
      });
    });

    describe('1.2 DiscordNotificationSender Strict AllowedMentions Lockdown', () => {
      it('guarantees allowedMentions.parse is strictly empty and never allows everyone or roles', async () => {
        let capturedPayload: any = null;
        const mockChannel: any = {
          id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          guildId: CONFIG.DISCORD_GUILD_ID,
          isTextBased: () => true,
          send: async (data: any) => {
            capturedPayload = data;
            return { id: 'sent_stress_01' };
          },
        };

        const mockClient: any = {
          channels: {
            cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockChannel]]),
          },
        };

        const sender = new DiscordNotificationSender(mockClient, CONFIG);

        // Adversarial attempt: pass malicious allowedMentions attempting to parse everyone/roles
        await sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Pinging everyone: @everyone <@&999999>',
          allowedMentions: {
            parse: ['everyone', 'roles', 'users'] as any,
            users: ['unauthorized_target_user'],
          },
        });

        expect(capturedPayload).not.toBeNull();
        // Crucial security invariant: parse MUST be empty array []
        expect(capturedPayload.allowedMentions.parse).toEqual([]);
        // Crucial security invariant: roles MUST be empty array []
        expect(capturedPayload.allowedMentions.roles).toEqual([]);
        expect(capturedPayload.allowedMentions.repliedUser).toBe(false);
        // Only target users explicitly declared can be pinged
        expect(capturedPayload.allowedMentions.users).toEqual(['unauthorized_target_user']);
      });

      it('strictly enforces channel allowlist, rejecting unauthorized channels', async () => {
        const mockClient: any = {
          channels: {
            cache: new Map(),
            fetch: async () => null,
          },
        };

        const sender = new DiscordNotificationSender(mockClient, CONFIG);

        await expect(
          sender.sendNotification({
            channelId: 'rogue_channel_666',
            content: 'Attack',
            allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
          }),
        ).rejects.toThrow(UnauthorizedError);
      });

      it('strictly enforces guild allowlist, rejecting channels belonging to foreign guilds', async () => {
        const foreignChannel: any = {
          id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          guildId: 'foreign_attacker_guild_999',
          isTextBased: () => true,
          send: async () => ({ id: '1' }),
        };

        const mockClient: any = {
          channels: {
            cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, foreignChannel]]),
          },
        };

        const sender = new DiscordNotificationSender(mockClient, CONFIG);

        await expect(
          sender.sendNotification({
            channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
            content: 'Attack',
            allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
          }),
        ).rejects.toThrow(UnauthorizedError);
      });
    });

    describe('1.3 Identity Linking Boundary in Event Routing', () => {
      it('never pings unlinked users even if GitHub login is "everyone" or contains mention markup', async () => {
        const maliciousPayload = {
          action: 'assigned',
          assignee: {
            id: 9999999, // Unlinked numeric ID
            login: 'everyone',
          },
          issue: {
            number: 777,
            title: 'Adversarial Login Test',
            html_url: 'https://github.com/adversarial-org/hardened-repo/issues/777',
            user: { login: 'attacker' },
          },
        };

        const decision = await notificationService.routeEvent('issues', maliciousPayload);
        expect(decision.shouldSend).toBe(true);

        // Content sanitized: @\u200beveryone
        expect(decision.content).toContain('@\u200beveryone');
        expect(decision.content).not.toContain('**@everyone**');

        // allowedMentions has NO users and NO parse
        expect(decision.allowedMentions?.users).toEqual([]);
        expect(decision.allowedMentions?.parse).toEqual([]);
      });

      it('pings verified linked Discord user only when identity is legitimately linked', async () => {
        const legitimatePayload = {
          action: 'assigned',
          assignee: {
            id: 10001, // Verified linked -> discord_legit_dev
            login: 'legit_dev',
          },
          issue: {
            number: 778,
            title: 'Normal Issue with injection in body: @everyone <@&55555>',
            body: 'Body contains @everyone and <@!99999999>',
            html_url: 'https://github.com/adversarial-org/hardened-repo/issues/778',
            user: { login: 'author' },
          },
        };

        const decision = await notificationService.routeEvent('issues', legitimatePayload);
        expect(decision.shouldSend).toBe(true);

        // Verified Discord mention in content
        expect(decision.content).toBe('🔔 <@discord_legit_dev> Anda ditugaskan pada issue **#778**!');
        // Allowed mentions contains ONLY the verified Discord ID
        expect(decision.allowedMentions?.users).toEqual(['discord_legit_dev']);
        expect(decision.allowedMentions?.parse).toEqual([]);

        // Embed body sanitized
        const embed: any = decision.embeds![0];
        expect(embed.data.description).toContain('@\u200beveryone');
        expect(embed.data.description).not.toContain(' @everyone');
      });

      it('handles malicious non-numeric assignee IDs gracefully without crashing or injecting', async () => {
        const maliciousPayload = {
          action: 'assigned',
          assignee: {
            id: 'NaN_OR_SQLI_INJECTION; DROP TABLE identities;',
            login: 'hacker',
          },
          issue: {
            number: 779,
            title: 'Non-numeric ID injection',
            html_url: 'https://github.com/adversarial-org/hardened-repo/issues/779',
            user: { login: 'attacker' },
          },
        };

        const decision = await notificationService.routeEvent('issues', maliciousPayload);
        expect(decision.shouldSend).toBe(true);
        // Falls back to sanitized login
        expect(decision.content).toContain('**@hacker**');
        expect(decision.allowedMentions?.users).toEqual([]);
        expect(decision.allowedMentions?.parse).toEqual([]);
      });
    });
  });

  // =========================================================================
  // SUITE 2: EVENT ROUTING & BRANCH FILTERING
  // =========================================================================
  describe('2. Event Routing & Branch Filtering', () => {
    describe('2.1 CI workflow_run Filtering Matrix', () => {
      const conclusionsToDrop = ['success', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale'];

      for (const conclusion of conclusionsToDrop) {
        it(`drops workflow_run on default branch with conclusion "${conclusion}" -> ZERO Discord messages`, async () => {
          const payload = {
            action: 'completed',
            workflow_run: {
              name: 'CI Suite',
              head_branch: 'main',
              conclusion,
            },
            repository: { default_branch: 'main' },
          };

          const decision = await notificationService.routeEvent('workflow_run', payload);
          expect(decision.shouldSend).toBe(false);
          expect(decision.embeds).toBeUndefined();
        });
      }

      it('drops workflow_run failures on random feature/scratch branches without associated PRs', async () => {
        const scratchBranches = [
          'feature/experimental-ui',
          'bugfix/quick-test',
          'dev-scratch-branch',
          'temp-ci-check',
          'dependabot/npm_and_yarn/lodash-4.17.21',
        ];

        for (const branch of scratchBranches) {
          const payload = {
            action: 'completed',
            workflow_run: {
              name: 'Build Test',
              head_branch: branch,
              conclusion: 'failure',
              pull_requests: [], // Zero associated PRs
            },
            repository: { default_branch: 'main' },
          };

          const decision = await notificationService.routeEvent('workflow_run', payload);
          expect(decision.shouldSend).toBe(false);
        }
      });

      it('drops workflow_run when pull_requests is null or undefined on non-default branch', async () => {
        const payload1 = {
          action: 'completed',
          workflow_run: {
            name: 'Test',
            head_branch: 'random-branch',
            conclusion: 'failure',
            pull_requests: null,
          },
          repository: { default_branch: 'main' },
        };
        const decision1 = await notificationService.routeEvent('workflow_run', payload1);
        expect(decision1.shouldSend).toBe(false);

        const payload2 = {
          action: 'completed',
          workflow_run: {
            name: 'Test',
            head_branch: 'random-branch',
            conclusion: 'failure',
          },
          repository: { default_branch: 'main' },
        };
        const decision2 = await notificationService.routeEvent('workflow_run', payload2);
        expect(decision2.shouldSend).toBe(false);
      });

      it('routes workflow_run failure on main branch with author ping and BLOCKED embed color', async () => {
        const payload = {
          action: 'completed',
          workflow_run: {
            name: 'Production Deploy',
            html_url: 'https://github.com/adversarial-org/hardened-repo/actions/runs/12345',
            head_branch: 'main',
            head_sha: '1a2b3c4d5e6f7a8b',
            conclusion: 'failure',
            actor: {
              id: 10001, // legit_dev -> discord_legit_dev
              login: 'legit_dev',
            },
          },
          repository: {
            full_name: 'adversarial-org/hardened-repo',
            default_branch: 'main',
          },
        };

        const decision = await notificationService.routeEvent('workflow_run', payload);
        expect(decision.shouldSend).toBe(true);
        expect(decision.content).toBe('⚠️ <@discord_legit_dev> Pipeline CI gagal pada workflow **Production Deploy**!');
        expect(decision.allowedMentions?.users).toEqual(['discord_legit_dev']);

        const embed: any = decision.embeds![0];
        expect(embed.data.title).toBe('❌ CI Pipeline Gagal: Production Deploy');
        expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED);
        expect(embed.data.fields).toContainEqual({
          name: 'Hasil',
          value: '⚠️ Gagal (Failure)',
          inline: true,
        });
      });

      it('routes workflow_run timed_out on PR branch with associated pull requests', async () => {
        const payload = {
          action: 'completed',
          workflow_run: {
            name: 'Integration Tests',
            html_url: 'https://github.com/adversarial-org/hardened-repo/actions/runs/12346',
            head_branch: 'feat/webhook-outbox',
            head_sha: '9f8e7d6c5b4a3f2e',
            conclusion: 'timed_out',
            actor: {
              id: 99999, // Unlinked
              login: 'external_dev',
            },
            pull_requests: [{ number: 105 }],
          },
          repository: {
            full_name: 'adversarial-org/hardened-repo',
            default_branch: 'main',
          },
        };

        const decision = await notificationService.routeEvent('workflow_run', payload);
        expect(decision.shouldSend).toBe(true);
        expect(decision.content).toBe('⚠️ Pipeline CI gagal untuk commit oleh **@external_dev**');
        expect(decision.allowedMentions?.users).toEqual([]);

        const embed: any = decision.embeds![0];
        expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED);
        expect(embed.data.fields).toContainEqual({
          name: 'Hasil',
          value: '⚠️ Waktu Habis (Timed Out)',
          inline: true,
        });
      });
    });

    describe('2.2 Check Suite Suppression & Multi-CI Matrix', () => {
      it('strictly suppresses check_suite originating from github-actions even on failure on main', async () => {
        const payload = {
          action: 'completed',
          check_suite: {
            app: {
              slug: 'github-actions',
              name: 'GitHub Actions',
            },
            head_branch: 'main',
            conclusion: 'failure',
            head_sha: 'aaaa1111bbbb2222',
          },
          repository: { default_branch: 'main' },
        };

        const decision = await notificationService.routeEvent('check_suite', payload);
        // Must be suppressed to prevent duplicate alert alongside workflow_run
        expect(decision.shouldSend).toBe(false);
      });

      it('strictly suppresses check_suite from github-actions on PR branch timed_out', async () => {
        const payload = {
          action: 'completed',
          check_suite: {
            app: { slug: 'github-actions' },
            head_branch: 'feat/test',
            conclusion: 'timed_out',
            pull_requests: [{ number: 99 }],
          },
          repository: { default_branch: 'main' },
        };

        const decision = await notificationService.routeEvent('check_suite', payload);
        expect(decision.shouldSend).toBe(false);
      });

      it('routes third-party CI (e.g. circleci) check_suite failures on main branch', async () => {
        const payload = {
          action: 'completed',
          check_suite: {
            app: {
              slug: 'circleci',
              name: 'CircleCI Checks',
            },
            head_branch: 'main',
            conclusion: 'failure',
            head_sha: 'cccc3333dddd4444',
            html_url: 'https://circleci.com/gh/adversarial-org/hardened-repo/123',
            pull_requests: [],
          },
          repository: {
            full_name: 'adversarial-org/hardened-repo',
            default_branch: 'main',
          },
          sender: { login: 'circleci-bot' },
        };

        const decision = await notificationService.routeEvent('check_suite', payload);
        expect(decision.shouldSend).toBe(true);
        const embed: any = decision.embeds![0];
        expect(embed.data.title).toBe('❌ CI Pipeline Gagal: CircleCI Checks');
        expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED);
      });

      it('drops third-party CI check_suite when conclusion is success or cancelled', async () => {
        for (const conclusion of ['success', 'cancelled', 'neutral', 'skipped']) {
          const payload = {
            action: 'completed',
            check_suite: {
              app: { slug: 'travis-ci', name: 'Travis CI' },
              head_branch: 'main',
              conclusion,
            },
            repository: { default_branch: 'main' },
          };

          const decision = await notificationService.routeEvent('check_suite', payload);
          expect(decision.shouldSend).toBe(false);
        }
      });
    });

    describe('2.3 Outbox Queue Batch Processor End-to-End Event Filtering', () => {
      it('processes batch of mixed events, dispatching only legitimate alerts and dropping noise', async () => {
        // Enqueue 5 deliveries:
        // 1. Success workflow_run on main -> Drop
        // 2. Cancelled workflow_run on main -> Drop
        // 3. Failure workflow_run on scratch branch -> Drop
        // 4. check_suite from github-actions failure -> Drop
        // 5. Legitimate failure workflow_run on main -> SEND
        await outboxRepo.enqueueDelivery(
          'd-1',
          'workflow_run',
          JSON.stringify({
            action: 'completed',
            workflow_run: { name: 'CI', head_branch: 'main', conclusion: 'success' },
            repository: { default_branch: 'main' },
          }),
        );

        await outboxRepo.enqueueDelivery(
          'd-2',
          'workflow_run',
          JSON.stringify({
            action: 'completed',
            workflow_run: { name: 'CI', head_branch: 'main', conclusion: 'cancelled' },
            repository: { default_branch: 'main' },
          }),
        );

        await outboxRepo.enqueueDelivery(
          'd-3',
          'workflow_run',
          JSON.stringify({
            action: 'completed',
            workflow_run: { name: 'CI', head_branch: 'wip-experiment', conclusion: 'failure', pull_requests: [] },
            repository: { default_branch: 'main' },
          }),
        );

        await outboxRepo.enqueueDelivery(
          'd-4',
          'check_suite',
          JSON.stringify({
            action: 'completed',
            check_suite: { app: { slug: 'github-actions' }, conclusion: 'failure', head_branch: 'main' },
            repository: { default_branch: 'main' },
          }),
        );

        await outboxRepo.enqueueDelivery(
          'd-5',
          'workflow_run',
          JSON.stringify({
            action: 'completed',
            workflow_run: {
              name: 'Build',
              html_url: 'https://github.com/adversarial-org/hardened-repo/actions/runs/99999',
              head_branch: 'main',
              head_sha: 'abcdef123456',
              conclusion: 'failure',
              actor: { id: 10001, login: 'legit_dev' },
            },
            repository: { default_branch: 'main' },
          }),
        );

        const processed = await notificationService.processOutboxBatch(10);
        expect(processed).toBe(5);

        // Exactly ONE Discord notification sent (d-5)
        expect(mockSender.sentNotifications).toHaveLength(1);
        expect(mockSender.sentNotifications[0].content).toContain('<@discord_legit_dev>');

        // All 5 rows in outbox marked PROCESSED
        const pending = await outboxRepo.fetchPendingDeliveries(10);
        expect(pending).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // SUITE 3: DAILY DIGEST TIMEZONE & RESTART DEDUPLICATION
  // =========================================================================
  describe('3. Daily Digest Timezone & Restart Deduplication', () => {
    describe('3.1 Timezone Boundary & Date Rollover Calculation (WIB = UTC+7)', () => {
      it('correctly calculates Asia/Jakarta date across UTC midnight rollover boundaries', () => {
        // Test vectors: [UTC Timestamp, Expected YYYY-MM-DD in Jakarta]
        const vectors: Array<[string, string, string]> = [
          // 16:59 UTC = 23:59 WIB (Same day in UTC, same day in WIB)
          ['2026-11-03T16:59:59.000Z', '2026-11-03', '23:59:59 WIB on Nov 3'],
          // 17:00 UTC = 00:00 WIB (Nov 4 starts in Jakarta while UTC is still Nov 3!)
          ['2026-11-03T17:00:00.000Z', '2026-11-04', '00:00:00 WIB rollover on Nov 4'],
          // 23:59 UTC = 06:59 WIB on Nov 4
          ['2026-11-03T23:59:59.000Z', '2026-11-04', '06:59:59 WIB morning Nov 4'],
          // 00:00 UTC = 07:00 WIB on Nov 4
          ['2026-11-04T00:00:00.000Z', '2026-11-04', '07:00:00 WIB (00:00 UTC vs 07:00 WIB)'],
          // 02:00 UTC = 09:00 WIB on Nov 4 (Target scheduled digest time)
          ['2026-11-04T02:00:00.000Z', '2026-11-04', '09:00:00 WIB scheduled digest run'],
          // 02:05 UTC = 09:05 WIB on Nov 4 (Container restart 5 mins later)
          ['2026-11-04T02:05:00.000Z', '2026-11-04', '09:05:00 WIB container restart test'],
          // Leap year edge case: 2028-02-28 17:00 UTC -> 2028-02-29 00:00 WIB
          ['2028-02-28T17:00:00.000Z', '2028-02-29', 'Leap year Feb 29 rollover'],
          // Year rollover: 2026-12-31 17:00 UTC -> 2027-01-01 00:00 WIB
          ['2026-12-31T17:00:00.000Z', '2027-01-01', 'New Year 2027 rollover'],
        ];

        for (const [utcIso, expectedJakartaDate, label] of vectors) {
          const dateObj = new Date(utcIso);
          const computed = getJakartaDateString(dateObj);
          expect(computed, `Failed for ${label} (${utcIso})`).toBe(expectedJakartaDate);
        }
      });
    });

    describe('3.2 Container Restart at 09:05 WIB Deduplication', () => {
      it('prevents double-firing after container restart at 09:05 WIB on same date', async () => {
        // Setup mock GitHub data for digest
        mockGitHubService.issues.set(101, {
          number: 101,
          title: 'Critical server memory leak',
          htmlUrl: 'https://github.com/adversarial-org/hardened-repo/issues/101',
          state: 'OPEN',
          projectStatus: 'Blocked',
          projectPriority: 'Urgent',
          assignees: ['alice'],
          author: 'dan',
          labels: ['bug'],
          blockedReason: 'Awaiting kernel patch from host vendor',
          blockedAt: '2026-11-04T08:00:00Z',
          commentsCount: 3,
          createdAt: '2026-11-04T07:00:00Z',
          updatedAt: '2026-11-04T08:00:00Z',
        });

        const scheduledTime = new Date('2026-11-04T02:00:00Z'); // 09:00 WIB
        const restartTime = new Date('2026-11-04T02:05:00Z');   // 09:05 WIB

        const dateStrScheduled = getJakartaDateString(scheduledTime);
        const dateStrRestart = getJakartaDateString(restartTime);
        expect(dateStrScheduled).toBe('2026-11-04');
        expect(dateStrRestart).toBe('2026-11-04');

        // Initial run at 09:00 WIB
        const initialUseCase = new DispatchDailyDigestUseCase(
          mockGitHubService,
          scheduleRepo,
          mockSender,
          CONFIG,
        );

        const initialResult = await initialUseCase.execute({ targetDate: dateStrScheduled });
        expect(initialResult.dispatched).toBe(true);
        expect(initialResult.reason).toBe('SUCCESS');
        expect(mockSender.sentNotifications).toHaveLength(1);

        // Verify SQLite idempotency key written
        expect(await scheduleRepo.isExecutedForDate('digest:42', dateStrScheduled)).toBe(true);

        // SIMULATE CONTAINER CRASH & RESTART at 09:05 WIB:
        // New DI container initializes a fresh ScheduleRepository and DispatchDailyDigestUseCase
        // connected to the same persistent SQLite database
        const restartedScheduleRepo = new ScheduleRepository(db);
        const restartedSender = new MockDiscordNotificationSender();
        const restartedUseCase = new DispatchDailyDigestUseCase(
          mockGitHubService,
          restartedScheduleRepo,
          restartedSender,
          CONFIG,
        );

        // Verification query
        const isAlreadyRecorded = await restartedScheduleRepo.isExecutedForDate('digest:42', dateStrRestart);
        expect(isAlreadyRecorded).toBe(true);

        // Attempt execution on restarted container
        const restartResult = await restartedUseCase.execute({ targetDate: dateStrRestart });
        expect(restartResult.dispatched).toBe(false);
        expect(restartResult.reason).toBe('ALREADY_EXECUTED');

        // ZERO messages dispatched by the restarted container
        expect(restartedSender.sentNotifications).toHaveLength(0);
        // Total messages sent across lifetime remains exactly 1
        expect(mockSender.sentNotifications).toHaveLength(1);
      });
    });

    describe('3.3 Concurrent Workers Atomic Lease Locking', () => {
      it('prevents race conditions when 10 workers fire concurrently; exactly ONE wins the lease', async () => {
        // Setup 10 separate worker instances targeting the same SQLite database
        const workerCount = 10;
        const senders: MockDiscordNotificationSender[] = [];
        const workers: DispatchDailyDigestUseCase[] = [];

        for (let i = 0; i < workerCount; i++) {
          const s = new MockDiscordNotificationSender();
          senders.push(s);
          const repo = new ScheduleRepository(db);
          workers.push(new DispatchDailyDigestUseCase(mockGitHubService, repo, s, CONFIG));
        }

        const targetDate = '2026-11-10';

        // Fire all 10 workers concurrently at the exact same millisecond
        const results = await Promise.all(
          workers.map((worker) => worker.execute({ targetDate })),
        );

        const successful = results.filter((r) => r.dispatched && r.reason === 'SUCCESS');
        const lockedOut = results.filter((r) => !r.dispatched && r.reason === 'LEASE_LOCKED');
        const alreadyDone = results.filter((r) => !r.dispatched && r.reason === 'ALREADY_EXECUTED');

        // Invariant 1: Exactly ONE worker successfully executes and dispatches
        expect(successful).toHaveLength(1);
        expect(successful[0].dateStr).toBe(targetDate);

        // Invariant 2: The remaining 9 workers are rejected by lease lock or already executed
        expect(lockedOut.length + alreadyDone.length).toBe(workerCount - 1);

        // Invariant 3: Total notifications sent across all senders is EXACTLY 1
        const totalSent = senders.reduce((acc, s) => acc + s.sentNotifications.length, 0);
        expect(totalSent).toBe(1);

        // Invariant 4: Subsequent immediate attempt is rejected with ALREADY_EXECUTED
        const subsequentResult = await workers[0].execute({ targetDate });
        expect(subsequentResult.dispatched).toBe(false);
        expect(subsequentResult.reason).toBe('ALREADY_EXECUTED');
      });
    });

    describe('3.4 Atomic Lease Recovery After Worker Crash', () => {
      it('blocks secondary workers while lease TTL is active, but allows recovery after TTL expiration', async () => {
        const leaseKey = 'lease:digest:42';

        // Worker 1 acquires lease for 300 seconds (5 mins) but crashes before recording execution
        const worker1Acquired = await scheduleRepo.acquireLease(leaseKey, 300);
        expect(worker1Acquired).toBe(true);

        // Worker 2 attempts while lease is active
        const worker2Acquired = await scheduleRepo.acquireLease(leaseKey, 300);
        expect(worker2Acquired).toBe(false);

        // Fast-forward SQLite time past 300s expiration (simulate 301 seconds passing)
        db.prepare(
          "UPDATE schedule_leases SET expires_at = datetime('now', '-1 second') WHERE lease_key = ?",
        ).run(leaseKey);

        // Worker 3 attempts after lease expired
        const worker3Acquired = await scheduleRepo.acquireLease(leaseKey, 300);
        expect(worker3Acquired).toBe(true);
      });
    });
  });

  // =========================================================================
  // SUITE 4: WEBHOOK INGESTION & DEDUPLICATION STRESS
  // =========================================================================
  describe('4. Webhook Ingestion & Deduplication Stress', () => {
    let server: FastifyInstance;
    let cryptoService: CryptoService;
    const WEBHOOK_SECRET = 'super_robust_webhook_secret_key_888';
    const ENCRYPTION_KEY = 'c'.repeat(64);

    function signPayload(body: string, secret: string = WEBHOOK_SECRET): string {
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
      return `sha256=${hmac}`;
    }

    beforeEach(async () => {
      cryptoService = new CryptoService(ENCRYPTION_KEY);
      server = await createHttpServer({
        database: db,
        cryptoService,
        webhookRouteOptions: {
          cryptoService,
          webhookSecret: WEBHOOK_SECRET,
          outboxRepository: outboxRepo,
        },
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it('rejects tampered HMAC SHA-256 signatures with HTTP 401 Unauthorized', async () => {
      const body = JSON.stringify({ action: 'opened', issue: { number: 99 } });
      const validSig = signPayload(body);
      // Flip 1 character in signature
      const tamperedSig = validSig.slice(0, -1) + (validSig.endsWith('0') ? '1' : '0');

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': tamperedSig,
          'x-github-delivery': 'tamper-delivery-001',
          'x-github-event': 'issues',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      const json = JSON.parse(response.body);
      expect(json.error).toBe('Unauthorized');
      expect(json.message).toBe('Invalid HMAC SHA-256 signature');
    });

    it('rejects signatures missing sha256= prefix or using legacy sha1', async () => {
      const body = JSON.stringify({ action: 'opened' });

      // Missing prefix
      const rawHex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
      const res1 = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': rawHex, // Missing 'sha256='
          'x-github-delivery': 'malformed-001',
          'x-github-event': 'issues',
        },
        payload: body,
      });
      expect(res1.statusCode).toBe(401);

      // Legacy sha1 prefix
      const sha1Sig = `sha1=${crypto.createHmac('sha1', WEBHOOK_SECRET).update(body).digest('hex')}`;
      const res2 = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sha1Sig,
          'x-github-delivery': 'malformed-002',
          'x-github-event': 'issues',
        },
        payload: body,
      });
      expect(res2.statusCode).toBe(401);
    });

    it('rejects requests with missing or empty delivery and event headers with HTTP 400', async () => {
      const body = JSON.stringify({ action: 'ping' });
      const sig = signPayload(body);

      // Missing delivery header
      const res1 = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-event': 'ping',
        },
        payload: body,
      });
      expect(res1.statusCode).toBe(400);

      // Missing event header
      const res2 = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-delivery': 'del-001',
        },
        payload: body,
      });
      expect(res2.statusCode).toBe(400);
    });

    it('guarantees atomic outbox deduplication under 10 concurrent requests with identical delivery ID', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 404, title: 'Concurrency test' },
      });
      const sig = signPayload(payload);
      const deliveryId = 'delivery-concurrent-stress-uuid-999';

      const requestCount = 10;
      const responses = await Promise.all(
        Array.from({ length: requestCount }, () =>
          server.inject({
            method: 'POST',
            url: '/webhooks/github',
            headers: {
              'content-type': 'application/json',
              'x-hub-signature-256': sig,
              'x-github-delivery': deliveryId,
              'x-github-event': 'issues',
            },
            payload,
          }),
        ),
      );

      // Invariant 1: Exactly 1 request receives HTTP 202 Accepted (enqueued)
      const enqueued = responses.filter((r) => r.statusCode === 202);
      expect(enqueued).toHaveLength(1);
      const enqueuedBody = JSON.parse(enqueued[0].body);
      expect(enqueuedBody.status).toBe('enqueued');
      expect(enqueuedBody.deliveryId).toBe(deliveryId);

      // Invariant 2: Exactly 9 requests receive HTTP 200 OK (duplicate_acknowledged)
      const dups = responses.filter((r) => r.statusCode === 200);
      expect(dups).toHaveLength(requestCount - 1);
      for (const d of dups) {
        const dupBody = JSON.parse(d.body);
        expect(dupBody.status).toBe('duplicate_acknowledged');
        expect(dupBody.deliveryId).toBe(deliveryId);
      }

      // Invariant 3: Exactly ONE record persisted in SQLite outbox queue
      const row = db.prepare('SELECT COUNT(*) as cnt FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as { cnt: number };
      expect(row.cnt).toBe(1);
    });

    it('enforces exponential backoff and transitions to DEAD_LETTER after maxAttempts is reached', async () => {
      // Configure outbox with maxAttempts = 3, baseBackoffMs = 50
      const resilientWorker = new NotificationService(
        outboxRepo,
        identityRepo,
        mockSender,
        CONFIG,
        {
          batchSize: 10,
          maxAttempts: 3,
          baseBackoffMs: 50,
          maxBackoffMs: 500,
        },
      );

      // Force mockSender to fail
      mockSender.shouldFail = true;
      mockSender.failureError = new Error('Discord Gateway connection reset');

      await outboxRepo.enqueueDelivery(
        'retry-delivery-001',
        'issues',
        JSON.stringify({
          action: 'opened',
          issue: {
            number: 808,
            title: 'Flaky network issue',
            html_url: 'https://github.com/adversarial-org/hardened-repo/issues/808',
            user: { login: 'tester' },
          },
        }),
      );

      // Attempt 1: Fails, attempts becomes 1
      const p1 = await resilientWorker.processOutboxBatch(10);
      expect(p1).toBe(0);
      const r1: any = db.prepare("SELECT status, attempts, last_error FROM outbox_deliveries WHERE delivery_id = 'retry-delivery-001'").get();
      expect(r1.status).toBe('PENDING');
      expect(r1.attempts).toBe(1);
      expect(r1.last_error).toContain('Discord Gateway connection reset');

      // Immediate attempt 2 within backoff window: Skipped
      const p2Immediate = await resilientWorker.processOutboxBatch(10);
      expect(p2Immediate).toBe(0);
      const r2Immediate: any = db.prepare("SELECT attempts FROM outbox_deliveries WHERE delivery_id = 'retry-delivery-001'").get();
      expect(r2Immediate.attempts).toBe(1); // unchanged because backoff delayed it

      // Wait for backoff window (50ms * 2^0 = 50ms)
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Attempt 2: Fails, attempts becomes 2
      await resilientWorker.processOutboxBatch(10);
      const r2: any = db.prepare("SELECT status, attempts FROM outbox_deliveries WHERE delivery_id = 'retry-delivery-001'").get();
      expect(r2.status).toBe('PENDING');
      expect(r2.attempts).toBe(2);

      // Wait for backoff window (50ms * 2^1 = 100ms)
      await new Promise((resolve) => setTimeout(resolve, 110));

      // Attempt 3: Fails, reaches maxAttempts (3) -> transitions to DEAD_LETTER
      await resilientWorker.processOutboxBatch(10);
      const r3: any = db.prepare("SELECT status, attempts FROM outbox_deliveries WHERE delivery_id = 'retry-delivery-001'").get();
      expect(r3.status).toBe('DEAD_LETTER');
      expect(r3.attempts).toBe(3);

      // Subsequent batch: DEAD_LETTER is not fetched
      const pendingAfter = await outboxRepo.fetchPendingDeliveries(10);
      expect(pendingAfter).toHaveLength(0);
    });

    it('gracefully handles corrupted JSON in outbox payload without crashing the batch worker', async () => {
      const resilientWorker = new NotificationService(
        outboxRepo,
        identityRepo,
        mockSender,
        CONFIG,
        { batchSize: 10, maxAttempts: 1 },
      );

      await outboxRepo.enqueueDelivery(
        'corrupt-payload-001',
        'issues',
        'THIS IS NOT VALID JSON {{{',
      );

      // Must not throw unhandled exception
      const processed = await resilientWorker.processOutboxBatch(10);
      expect(processed).toBe(0);

      const r: any = db.prepare("SELECT status, last_error FROM outbox_deliveries WHERE delivery_id = 'corrupt-payload-001'").get();
      expect(r.status).toBe('DEAD_LETTER');
      expect(r.last_error).toContain('Corrupted payload JSON');
    });
  });
});
