import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MentionPolicy } from '../../src/domain/policies.js';
import { NotificationService } from '../../src/application/services/NotificationService.js';
import { DiscordNotificationSender } from '../../src/interfaces/discord/notificationSender.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';
import {
  UnauthorizedError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  ExternalApiError,
} from '../../src/domain/errors.js';

describe('Mention Security & Channel Allowlisting', () => {
  let db: Database.Database;
  let outboxRepo: OutboxRepository;
  let identityRepo: IdentityRepository;
  let mockSender: MockDiscordNotificationSender;
  let notificationService: NotificationService;

  const CONFIG = {
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_safe_alerts',
    DISCORD_GUILD_ID: 'guild_authorized_123',
    GITHUB_OWNER: 'secops',
    GITHUB_REPOSITORY: 'app',
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    outboxRepo = new OutboxRepository(db);
    identityRepo = new IdentityRepository(db);
    mockSender = new MockDiscordNotificationSender();

    notificationService = new NotificationService(
      outboxRepo,
      identityRepo,
      mockSender,
      CONFIG,
    );

    // Seed verified linked user: GitHub numeric 4444 -> Discord 'discord_verified_user'
    await identityRepo.linkIdentity('discord_verified_user', 4444, 'target_dev');
  });

  afterEach(() => {
    db.close();
  });

  describe('MentionPolicy Unit Validation', () => {
    it('buildSafeAllowedMentions strictly returns parse: [] and provided user IDs only', () => {
      const mentions = MentionPolicy.buildSafeAllowedMentions(['user_1', 'user_2']);
      expect(mentions.parse).toEqual([]);
      expect(mentions.users).toEqual(['user_1', 'user_2']);
    });

    it('buildSafeAllowedMentions defaults to empty users array', () => {
      const mentions = MentionPolicy.buildSafeAllowedMentions();
      expect(mentions.parse).toEqual([]);
      expect(mentions.users).toEqual([]);
    });

    it('sanitizeDiscordMentions neutralizes @everyone with zero-width space', () => {
      const input = 'Urgent bug report! @everyone please check!';
      const sanitized = MentionPolicy.sanitizeDiscordMentions(input);
      expect(sanitized).toBe('Urgent bug report! @\u200beveryone please check!');
      expect(sanitized).not.toContain('@everyone');
    });

    it('sanitizeDiscordMentions neutralizes @here with zero-width space', () => {
      const input = 'Attention @here right now';
      const sanitized = MentionPolicy.sanitizeDiscordMentions(input);
      expect(sanitized).toBe('Attention @\u200bhere right now');
      expect(sanitized).not.toContain('@here');
    });

    it('sanitizeDiscordMentions neutralizes role mentions <@&123456789>', () => {
      const input = 'Escalating to <@&999888777> on call!';
      const sanitized = MentionPolicy.sanitizeDiscordMentions(input);
      expect(sanitized).toBe('Escalating to <@&\u200b999888777> on call!');
      expect(sanitized).not.toContain('<@&999888777>');
    });

    it('sanitizeDiscordMentions neutralizes raw user mentions <@123456789>', () => {
      const input = 'Assigned by <@123456789>';
      const sanitized = MentionPolicy.sanitizeDiscordMentions(input);
      expect(sanitized).toBe('Assigned by <@\u200b123456789>');
    });

    it('handles null, undefined, or empty strings gracefully', () => {
      expect(MentionPolicy.sanitizeDiscordMentions('')).toBe('');
      expect(MentionPolicy.sanitizeDiscordMentions(null as any)).toBe('');
      expect(MentionPolicy.sanitizeDiscordMentions(undefined as any)).toBe('');
    });
  });

  describe('Adversarial Payload Sanitization in Notification Pipeline', () => {
    it('neutralizes malicious issue title containing @everyone and role pings', async () => {
      const maliciousPayload = {
        action: 'opened',
        issue: {
          number: 666,
          title: 'Exploit: @everyone check out <@&1122334455> NOW!',
          html_url: 'https://github.com/secops/app/issues/666',
          body: 'Malicious body with @here and <@99887766>',
          user: { login: 'hacker' },
        },
      };

      const decision = await notificationService.routeEvent('issues', maliciousPayload);
      expect(decision.shouldSend).toBe(true);

      // Verify allowedMentions has strictly empty parse and no users
      expect(decision.allowedMentions?.parse).toEqual([]);
      expect(decision.allowedMentions?.users).toEqual([]);

      const embed: any = decision.embeds![0];
      expect(embed.data.description).toContain('@\u200beveryone');
      expect(embed.data.description).not.toContain(' @everyone');
      expect(embed.data.description).toContain('<@&\u200b1122334455>');
      expect(embed.data.description).toContain('@\u200bhere');
    });

    it('neutralizes malicious assignee login attempting mention injection', async () => {
      const maliciousPayload = {
        action: 'assigned',
        assignee: {
          id: 88888, // unlinked
          login: 'everyone',
        },
        issue: {
          number: 667,
          title: 'Assignee spoof test',
          html_url: 'https://github.com/secops/app/issues/667',
          user: { login: 'attacker' },
        },
      };

      const decision = await notificationService.routeEvent('issues', maliciousPayload);
      expect(decision.shouldSend).toBe(true);
      // Sanitized: @\u200beveryone
      expect(decision.content).toContain('@\u200beveryone');
      expect(decision.content).not.toContain('**@everyone**');
      expect(decision.allowedMentions?.parse).toEqual([]);
      expect(decision.allowedMentions?.users).toEqual([]);
    });

    it('ensures allowedMentions.users only contains verified linked Discord ID even with forged payloads', async () => {
      const payload = {
        action: 'assigned',
        assignee: {
          id: 4444, // Verified linked user -> discord_verified_user
          login: 'target_dev',
        },
        issue: {
          number: 668,
          title: 'Normal title with spoofed text <@999999999999>',
          html_url: 'https://github.com/secops/app/issues/668',
          user: { login: 'somebody' },
        },
      };

      const decision = await notificationService.routeEvent('issues', payload);
      expect(decision.shouldSend).toBe(true);
      // ONLY discord_verified_user in users array; 999999999999 is NOT included
      expect(decision.allowedMentions?.users).toEqual(['discord_verified_user']);
      expect(decision.allowedMentions?.parse).toEqual([]);
    });
  });

  describe('DiscordNotificationSender Channel & Guild Allowlist Enforcement', () => {
    it('throws UnauthorizedError if destination channel does not match DISCORD_NOTIFICATION_CHANNEL_ID', async () => {
      const mockClient: any = {
        channels: {
          cache: new Map(),
          fetch: async () => null,
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: 'attacker_controlled_channel',
          content: 'Hello',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('throws UnauthorizedError if channel belongs to a different guild', async () => {
      const mockChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: 'rogue_guild_999', // Different from CONFIG.DISCORD_GUILD_ID
        isTextBased: () => true,
        send: async () => ({ id: '1' }),
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockChannel]]),
          fetch: async () => mockChannel,
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Alert',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('throws NotFoundError if notification channel cannot be resolved', async () => {
      const mockClient: any = {
        channels: {
          cache: new Map(),
          fetch: async () => null,
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Alert',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError if channel is not text-based or lacks send function', async () => {
      const mockVoiceChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: CONFIG.DISCORD_GUILD_ID,
        isTextBased: () => false, // Voice / Category channel
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockVoiceChannel]]),
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Alert',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('successfully dispatches message with strict safe mentions to valid text channel', async () => {
      let capturedPayload: any = null;
      const mockTextChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: CONFIG.DISCORD_GUILD_ID,
        isTextBased: () => true,
        send: async (payload: any) => {
          capturedPayload = payload;
          return { id: 'sent_msg_1001' };
        },
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockTextChannel]]),
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      const result = await sender.sendNotification({
        channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        content: 'Safe notification',
        allowedMentions: MentionPolicy.buildSafeAllowedMentions(['discord_verified_user']),
      });

      expect(result.messageId).toBe('sent_msg_1001');
      expect(capturedPayload.allowedMentions).toEqual({
        parse: [],
        users: ['discord_verified_user'],
        roles: [],
        repliedUser: false,
      });
    });

    it('verifyChannel returns true for valid channel and false for invalid channel or guild', async () => {
      const mockTextChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: CONFIG.DISCORD_GUILD_ID,
        isTextBased: () => true,
        send: async () => ({ id: '1' }),
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockTextChannel]]),
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      expect(await sender.verifyChannel(CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID)).toBe(true);
      expect(await sender.verifyChannel('wrong_channel')).toBe(false);
    });

    it('translates Discord 429 rate limit to RateLimitError', async () => {
      const mockTextChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: CONFIG.DISCORD_GUILD_ID,
        isTextBased: () => true,
        send: async () => {
          const err: any = new Error('Rate limited');
          err.status = 429;
          err.retryAfter = 10;
          throw err;
        },
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockTextChannel]]),
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Rate limit test',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(RateLimitError);
    });

    it('translates Discord 403 missing access during fetch to UnauthorizedError', async () => {
      const mockClient: any = {
        channels: {
          cache: new Map(),
          fetch: async () => {
            const err: any = new Error('Missing Access');
            err.code = 50001;
            throw err;
          },
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Missing access test',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('translates generic Discord API error to ExternalApiError', async () => {
      const mockTextChannel: any = {
        id: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
        guildId: CONFIG.DISCORD_GUILD_ID,
        isTextBased: () => true,
        send: async () => {
          const err: any = new Error('Internal Discord Server Error');
          err.status = 500;
          throw err;
        },
      };

      const mockClient: any = {
        channels: {
          cache: new Map([[CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID, mockTextChannel]]),
        },
      };

      const sender = new DiscordNotificationSender(mockClient, CONFIG);

      await expect(
        sender.sendNotification({
          channelId: CONFIG.DISCORD_NOTIFICATION_CHANNEL_ID,
          content: 'Server error test',
          allowedMentions: MentionPolicy.buildSafeAllowedMentions([]),
        }),
      ).rejects.toThrow(ExternalApiError);
    });
  });
});
