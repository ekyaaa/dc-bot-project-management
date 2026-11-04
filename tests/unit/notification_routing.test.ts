import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NotificationService } from '../../src/application/services/NotificationService.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';
import { EMBED_COLORS } from '../../src/interfaces/discord/embeds.js';

describe('Notification Routing & Event Filtering: NotificationService', () => {
  let db: Database.Database;
  let outboxRepo: OutboxRepository;
  let identityRepo: IdentityRepository;
  let discordSender: MockDiscordNotificationSender;
  let notificationService: NotificationService;

  const CONFIG = {
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_notif_123',
    DISCORD_GUILD_ID: 'guild_target_456',
    GITHUB_OWNER: 'testowner',
    GITHUB_REPOSITORY: 'testrepo',
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    outboxRepo = new OutboxRepository(db);
    identityRepo = new IdentityRepository(db);
    discordSender = new MockDiscordNotificationSender();

    notificationService = new NotificationService(
      outboxRepo,
      identityRepo,
      discordSender,
      CONFIG,
    );

    // Seed linked test identity: numeric GitHub ID 12345 -> Discord Snowflake 'discord_dev_001'
    await identityRepo.linkIdentity('discord_dev_001', 12345, 'alice_dev');
    // Seed linked test identity: numeric GitHub ID 67890 -> Discord Snowflake 'discord_rev_002'
    await identityRepo.linkIdentity('discord_rev_002', 67890, 'bob_reviewer');
  });

  afterEach(() => {
    db.close();
  });

  describe('Issue Events Routing', () => {
    it('routes issues.opened with description snippet and READY color', async () => {
      const payload = {
        action: 'opened',
        issue: {
          number: 42,
          title: 'Implement Webhook Routing',
          html_url: 'https://github.com/testowner/testrepo/issues/42',
          body: 'Detailed issue description for testing routing.\nSecond line.',
          user: { login: 'charlie_creator' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.embeds).toHaveLength(1);
      const embed: any = decision.embeds![0];

      expect(embed.data.title).toBe('📌 Issue Baru Dibuka: #42');
      expect(embed.data.color).toBe(EMBED_COLORS.READY);
      expect(embed.data.description).toContain('Detailed issue description for testing routing.');
      expect(embed.data.fields).toContainEqual({
        name: 'Pembuat',
        value: '@charlie_creator',
        inline: true,
      });
      expect(decision.content).toBeUndefined();
      expect(decision.allowedMentions?.users).toEqual([]);
    });

    it('routes issues.assigned with linked Discord mention and IN_PROGRESS color', async () => {
      const payload = {
        action: 'assigned',
        assignee: {
          id: 12345,
          login: 'alice_dev',
        },
        issue: {
          number: 43,
          title: 'Database connection pooling',
          html_url: 'https://github.com/testowner/testrepo/issues/43',
          user: { login: 'charlie_creator' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('🔔 <@discord_dev_001> Anda ditugaskan pada issue **#43**!');
      expect(decision.allowedMentions?.users).toEqual(['discord_dev_001']);
      expect(decision.allowedMentions?.parse).toEqual([]);

      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('👤 Penugasan Issue: #43');
      expect(embed.data.color).toBe(EMBED_COLORS.IN_PROGRESS);
      expect(embed.data.fields).toContainEqual({
        name: 'Ditugaskan Kepada',
        value: '@alice_dev',
        inline: true,
      });
    });

    it('routes issues.assigned with unlinked GitHub user gracefully falling back to plain text @login', async () => {
      const payload = {
        action: 'assigned',
        assignee: {
          id: 99999, // Unlinked user
          login: 'stranger_danger',
        },
        issue: {
          number: 44,
          title: 'Unassigned bug resolved',
          html_url: 'https://github.com/testowner/testrepo/issues/44',
          user: { login: 'charlie_creator' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('🔔 **@stranger_danger** ditugaskan pada issue **#44**');
      expect(decision.allowedMentions?.users).toEqual([]); // No Discord ping
      expect(decision.allowedMentions?.parse).toEqual([]);
    });

    it('routes issues.reopened with READY color', async () => {
      const payload = {
        action: 'reopened',
        issue: {
          number: 45,
          title: 'Flaky unit test in CI',
          html_url: 'https://github.com/testowner/testrepo/issues/45',
          user: { login: 'alice_dev' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('🔄 Issue Dibuka Kembali: #45');
      expect(embed.data.color).toBe(EMBED_COLORS.READY);
    });

    it('routes issues.closed with SUCCESS color', async () => {
      const payload = {
        action: 'closed',
        issue: {
          number: 46,
          title: 'Feature completed',
          html_url: 'https://github.com/testowner/testrepo/issues/46',
          user: { login: 'alice_dev' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('✅ Issue Ditutup: #46');
      expect(embed.data.color).toBe(EMBED_COLORS.SUCCESS);
    });

    it('ignores unsupported issue actions (edited, labeled, unassigned) without sending', async () => {
      for (const action of ['edited', 'labeled', 'unlabeled', 'milestoned', 'demilestoned']) {
        const decision = await notificationService.routeEvent('issues', {
          action,
          issue: { number: 47, title: 'Test issue' },
        });
        expect(decision.shouldSend).toBe(false);
      }
    });
  });

  describe('Pull Request Events Routing', () => {
    it('routes pull_request.review_requested with linked reviewer Discord ping', async () => {
      const payload = {
        action: 'review_requested',
        requested_reviewer: {
          id: 67890,
          login: 'bob_reviewer',
        },
        pull_request: {
          number: 88,
          title: 'Add HMAC SHA-256 Webhook Verification',
          html_url: 'https://github.com/testowner/testrepo/pull/88',
          user: { login: 'alice_dev' },
          head: { ref: 'feat/webhook' },
          base: { ref: 'main' },
        },
      };

      const decision = await notificationService.routeEvent('pull_request', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('🔍 <@discord_rev_002> Anda diminta meninjau Pull Request **#88**!');
      expect(decision.allowedMentions?.users).toEqual(['discord_rev_002']);
      expect(decision.allowedMentions?.parse).toEqual([]);

      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('🔍 Permintaan Code Review PR: #88');
      expect(embed.data.color).toBe(EMBED_COLORS.IN_REVIEW);
      expect(embed.data.fields).toContainEqual({
        name: 'Reviewer Diminta',
        value: '@bob_reviewer',
        inline: true,
      });
      expect(embed.data.fields).toContainEqual({
        name: 'Branch',
        value: '`feat/webhook` ➔ `main`',
        inline: false,
      });
    });

    it('routes pull_request.review_requested for unlinked reviewer without ping', async () => {
      const payload = {
        action: 'review_requested',
        requested_reviewer: {
          id: 77777, // Unlinked
          login: 'external_reviewer',
        },
        pull_request: {
          number: 89,
          title: 'Refactor CSS',
          html_url: 'https://github.com/testowner/testrepo/pull/89',
          user: { login: 'alice_dev' },
        },
      };

      const decision = await notificationService.routeEvent('pull_request', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('🔍 **@external_reviewer** diminta meninjau Pull Request **#89**');
      expect(decision.allowedMentions?.users).toEqual([]);
    });

    it('routes pull_request.ready_for_review with IN_REVIEW color', async () => {
      const payload = {
        action: 'ready_for_review',
        pull_request: {
          number: 90,
          title: 'Docker multi-stage setup',
          html_url: 'https://github.com/testowner/testrepo/pull/90',
          user: { login: 'alice_dev' },
          head: { ref: 'feat/docker' },
          base: { ref: 'main' },
        },
      };

      const decision = await notificationService.routeEvent('pull_request', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('🚀 PR Siap Ditinjau: #90');
      expect(embed.data.color).toBe(EMBED_COLORS.IN_REVIEW);
    });

    it('routes pull_request.closed with merged: true as merged PR', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 91,
          title: 'Completed milestone 4',
          html_url: 'https://github.com/testowner/testrepo/pull/91',
          merged: true,
          user: { login: 'alice_dev' },
          head: { ref: 'feat/m4' },
          base: { ref: 'main' },
        },
      };

      const decision = await notificationService.routeEvent('pull_request', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('🔀 Pull Request Digabungkan: #91');
      expect(embed.data.color).toBe(EMBED_COLORS.SUCCESS);
    });

    it('routes pull_request.closed with merged: false as closed PR (unmerged)', async () => {
      const payload = {
        action: 'closed',
        pull_request: {
          number: 92,
          title: 'Abandoned experiment',
          html_url: 'https://github.com/testowner/testrepo/pull/92',
          merged: false,
          user: { login: 'alice_dev' },
          head: { ref: 'exp/junk' },
          base: { ref: 'main' },
        },
      };

      const decision = await notificationService.routeEvent('pull_request', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('🛑 Pull Request Ditutup: #92');
      expect(embed.data.color).toBe(EMBED_COLORS.BACKLOG);
    });

    it('ignores unsupported PR actions (opened, synchronize, labeled)', async () => {
      for (const action of ['opened', 'synchronize', 'labeled', 'unlabeled']) {
        const decision = await notificationService.routeEvent('pull_request', {
          action,
          pull_request: { number: 93 },
        });
        expect(decision.shouldSend).toBe(false);
      }
    });
  });

  describe('CI Failure Events Routing (workflow_run & check_suite)', () => {
    it('routes workflow_run failure on main branch with BLOCKED color and commit author mention', async () => {
      const payload = {
        action: 'completed',
        workflow_run: {
          name: 'Build and Test',
          html_url: 'https://github.com/testowner/testrepo/actions/runs/55555',
          head_branch: 'main',
          head_sha: 'abcdef1234567890',
          conclusion: 'failure',
          actor: {
            id: 12345,
            login: 'alice_dev',
          },
        },
        repository: {
          full_name: 'testowner/testrepo',
          default_branch: 'main',
        },
      };

      const decision = await notificationService.routeEvent('workflow_run', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('⚠️ <@discord_dev_001> Pipeline CI gagal pada workflow **Build and Test**!');
      expect(decision.allowedMentions?.users).toEqual(['discord_dev_001']);

      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('❌ CI Pipeline Gagal: Build and Test');
      expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED);
      expect(embed.data.fields).toContainEqual({
        name: 'Hasil',
        value: '⚠️ Gagal (Failure)',
        inline: true,
      });
      expect(embed.data.fields).toContainEqual({
        name: 'Commit',
        value: '`abcdef1`',
        inline: true,
      });
    });

    it('routes workflow_run timed_out on PR branch', async () => {
      const payload = {
        action: 'completed',
        workflow_run: {
          name: 'Integration E2E',
          html_url: 'https://github.com/testowner/testrepo/actions/runs/66666',
          head_branch: 'feat/heavy-tests',
          head_sha: '9876543210fedcba',
          conclusion: 'timed_out',
          actor: {
            id: 99999, // Unlinked
            login: 'external_contrib',
          },
          pull_requests: [{ number: 50 }],
        },
        repository: {
          full_name: 'testowner/testrepo',
          default_branch: 'main',
        },
      };

      const decision = await notificationService.routeEvent('workflow_run', payload);
      expect(decision.shouldSend).toBe(true);
      expect(decision.content).toBe('⚠️ Pipeline CI gagal untuk commit oleh **@external_contrib**');
      expect(decision.allowedMentions?.users).toEqual([]);

      const embed: any = decision.embeds![0];
      expect(embed.data.fields).toContainEqual({
        name: 'Hasil',
        value: '⚠️ Waktu Habis (Timed Out)',
        inline: true,
      });
    });

    it('filters out successful workflow_run runs without sending messages', async () => {
      const payload = {
        action: 'completed',
        workflow_run: {
          name: 'Build and Test',
          head_branch: 'main',
          conclusion: 'success', // SUCCESS -> must be dropped
        },
        repository: { default_branch: 'main' },
      };

      const decision = await notificationService.routeEvent('workflow_run', payload);
      expect(decision.shouldSend).toBe(false);
    });

    it('filters out non-completed workflow_run runs (requested, in_progress)', async () => {
      const payload = {
        action: 'in_progress',
        workflow_run: {
          name: 'Build and Test',
          head_branch: 'main',
          conclusion: null,
        },
      };

      const decision = await notificationService.routeEvent('workflow_run', payload);
      expect(decision.shouldSend).toBe(false);
    });

    it('filters out CI failures on scratch/feature branches not tied to PRs to prevent noise', async () => {
      const payload = {
        action: 'completed',
        workflow_run: {
          name: 'Scratch Test',
          head_branch: 'experimental-wip-branch',
          conclusion: 'failure',
          pull_requests: [], // No PR association
        },
        repository: { default_branch: 'main' },
      };

      const decision = await notificationService.routeEvent('workflow_run', payload);
      expect(decision.shouldSend).toBe(false);
    });

    it('suppresses check_suite events originating from github-actions to prevent duplicate alerts', async () => {
      const payload = {
        action: 'completed',
        check_suite: {
          app: { slug: 'github-actions' },
          conclusion: 'failure',
          head_branch: 'main',
        },
        repository: { default_branch: 'main' },
      };

      const decision = await notificationService.routeEvent('check_suite', payload);
      expect(decision.shouldSend).toBe(false);
    });

    it('routes non-GitHub-Actions check_suite failures on default branch', async () => {
      const payload = {
        action: 'completed',
        check_suite: {
          app: { slug: 'circleci', name: 'CircleCI' },
          conclusion: 'failure',
          head_branch: 'main',
          head_sha: '1234567890abcdef',
          html_url: 'https://circleci.com/build/123',
          pull_requests: [],
        },
        repository: {
          full_name: 'testowner/testrepo',
          default_branch: 'main',
        },
        sender: { login: 'circleci-bot' },
      };

      const decision = await notificationService.routeEvent('check_suite', payload);
      expect(decision.shouldSend).toBe(true);
      const embed: any = decision.embeds![0];
      expect(embed.data.title).toBe('❌ CI Pipeline Gagal: CircleCI');
      expect(embed.data.color).toBe(EMBED_COLORS.BLOCKED);
    });
  });

  describe('Ping and Unknown Events', () => {
    it('handles ping event without sending Discord messages', async () => {
      const decision = await notificationService.routeEvent('ping', { zen: 'Keep it simple.' });
      expect(decision.shouldSend).toBe(false);
    });

    it('handles unknown event types without sending Discord messages', async () => {
      const decision = await notificationService.routeEvent('star', { action: 'created' });
      expect(decision.shouldSend).toBe(false);
    });
  });
});
