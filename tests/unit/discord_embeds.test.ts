import { describe, it, expect, vi } from 'vitest';
import { Events } from 'discord.js';
import {
  getStatusColor,
  sanitizeAndTruncate,
  buildErrorEmbed,
  buildBlockedIssuesEmbed,
  buildReviewsEmbed,
  buildUnassignedIssuesEmbed,
  buildIssueListEmbed,
  buildIssueDetailEmbed,
  EMBED_COLORS,
} from '../../src/interfaces/discord/embeds.js';
import {
  DomainError,
  UnauthorizedError,
  ValidationError,
  ConflictError,
  NotFoundError,
  PendingPermissionError,
  RateLimitError,
  ExternalApiError,
} from '../../src/domain/errors.js';
import { DiscordGatewayClient } from '../../src/interfaces/discord/client.js';
import { PaginationManager } from '../../src/interfaces/discord/pagination.js';
import { createMockButtonInteraction } from '../mocks/MockDiscordInteraction.js';

describe('Discord Embeds, Client Events & Edge Cases', () => {
  describe('getStatusColor', () => {
    it('maps every canonical status to its brand color', () => {
      expect(getStatusColor('Done')).toBe(EMBED_COLORS.SUCCESS);
      expect(getStatusColor('In Progress')).toBe(EMBED_COLORS.IN_PROGRESS);
      expect(getStatusColor('Blocked')).toBe(EMBED_COLORS.BLOCKED);
      expect(getStatusColor('Ready')).toBe(EMBED_COLORS.READY);
      expect(getStatusColor('In Review')).toBe(EMBED_COLORS.IN_REVIEW);
      expect(getStatusColor('Backlog')).toBe(EMBED_COLORS.BACKLOG);
      expect(getStatusColor(undefined)).toBe(EMBED_COLORS.BRAND);
    });
  });

  describe('sanitizeAndTruncate', () => {
    it('handles empty and null text gracefully', () => {
      expect(sanitizeAndTruncate('', 100)).toBe('');
      expect(sanitizeAndTruncate(null as any, 100)).toBe('');
      expect(sanitizeAndTruncate(undefined as any, 100)).toBe('');
    });

    it('truncates text exceeding maxLength with ellipsis', () => {
      const longText = 'A'.repeat(50);
      const result = sanitizeAndTruncate(longText, 10);
      expect(result).toHaveLength(10);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('buildErrorEmbed', () => {
    it('maps all domain error codes correctly', () => {
      const errUnauthorized = new UnauthorizedError('Unauthorized access');
      const embedUnauthorized = buildErrorEmbed(errUnauthorized);
      expect(embedUnauthorized.data.title).toContain('Akses Ditolak');

      const errValidation = new ValidationError('Invalid input');
      const embedValidation = buildErrorEmbed(errValidation);
      expect(embedValidation.data.title).toContain('Validasi Tidak Sesuai');

      const errConflict = new ConflictError('State conflict');
      const embedConflict = buildErrorEmbed(errConflict);
      expect(embedConflict.data.title).toContain('Konflik Status');

      const errNotFound = new NotFoundError('Item not found');
      const embedNotFound = buildErrorEmbed(errNotFound);
      expect(embedNotFound.data.title).toContain('Data Tidak Ditemukan');

      const errPermission = new PendingPermissionError('Projects v2 permission pending');
      const embedPermission = buildErrorEmbed(errPermission);
      expect(embedPermission.data.title).toContain('Izin Proyek Belum Diberikan');

      const errRateLimit = new RateLimitError('Too many requests', 30);
      const embedRateLimit = buildErrorEmbed(errRateLimit);
      expect(embedRateLimit.data.title).toContain('Batas Permintaan Terlampaui');

      const errExternal = new ExternalApiError('GitHub 502 Bad Gateway', 502);
      const embedExternal = buildErrorEmbed(errExternal);
      expect(embedExternal.data.title).toContain('Layanan Eksternal Mengalami Gangguan');

      class CustomDomainError extends DomainError {
        public readonly code = 'CUSTOM_CODE';
      }
      const errCustomDomain = new CustomDomainError('Custom error message');
      const embedCustom = buildErrorEmbed(errCustomDomain);
      expect(embedCustom.data.title).toContain('CUSTOM_CODE');

      const errStandard = new Error('Standard JavaScript error');
      const embedStandard = buildErrorEmbed(errStandard);
      expect(embedStandard.data.title).toBe('❌ Permintaan Gagal');

      const errUnknown = 'Random string error';
      const embedUnknown = buildErrorEmbed(errUnknown);
      expect(embedUnknown.data.title).toContain('System Error');
    });
  });

  describe('Empty state embeds', () => {
    it('buildBlockedIssuesEmbed: renders celebratory embed when 0 blocked', () => {
      const embed = buildBlockedIssuesEmbed([], 0, 1);
      expect(embed.data.title).toBe('🚫 Issue Terblokir (0)');
      expect(embed.data.color).toBe(EMBED_COLORS.SUCCESS);
      expect(embed.data.description).toContain('Tidak ada issue terblokir');
    });

    it('buildReviewsEmbed: renders celebratory embed when 0 reviews', () => {
      const embed = buildReviewsEmbed([], 0, 1);
      expect(embed.data.title).toBe('🔍 Antrean Code Review (0)');
      expect(embed.data.color).toBe(EMBED_COLORS.SUCCESS);
      expect(embed.data.description).toContain('Antrean bersih');
    });

    it('buildUnassignedIssuesEmbed: renders celebratory embed when 0 unassigned', () => {
      const embed = buildUnassignedIssuesEmbed([], 0, 1);
      expect(embed.data.title).toBe('📋 Issue Belum Ditugaskan (0)');
      expect(embed.data.color).toBe(EMBED_COLORS.SUCCESS);
      expect(embed.data.description).toContain('Semua issue telah memiliki pemilik');
    });

    it('buildIssueListEmbed: renders empty state when 0 issues', () => {
      const embed = buildIssueListEmbed([], {}, 0, 1);
      expect(embed.data.title).toContain('0 item');
      expect(embed.data.description).toContain('Tidak ada issue yang sesuai');
    });

    it('buildIssueDetailEmbed: includes labels, blocker reason, and body preview', () => {
      const { embed, components } = buildIssueDetailEmbed({
        number: 42,
        title: 'Deep Refactoring Task',
        htmlUrl: 'https://github.com/example/repo/issues/42',
        state: 'OPEN',
        projectStatus: 'Blocked',
        projectPriority: 'Urgent',
        assignees: ['alice', 'bob'],
        author: 'dan',
        labels: ['refactor', 'core'],
        commentsCount: 3,
        updatedAt: '2026-11-01T10:00:00Z',
        createdAt: '2026-11-01T08:00:00Z',
        body: 'Multiline description details here...',
        blockedReason: 'Awaiting architecture sign-off',
      });

      expect(embed.data.title).toContain('#42');
      expect(embed.data.fields.some((f: any) => f.name === 'Label')).toBe(true);
      expect(embed.data.fields.some((f: any) => f.name.includes('Alasan Kendala'))).toBe(true);
      expect(embed.data.fields.some((f: any) => f.name.includes('Pratinjau Deskripsi'))).toBe(true);
      expect(components).toHaveLength(1);
    });
  });

  describe('DiscordGatewayClient Lifecycle & Event Handlers', () => {
    it('triggers client lifecycle event handlers safely without crashing', async () => {
      const client = new DiscordGatewayClient({
        config: {
          DISCORD_BOT_TOKEN: 'mock_token',
          DISCORD_GUILD_ID: 'guild_target_123',
        },
      });

      const rawClient = client.rawClient;

      // Simulate ClientReady with guild present
      const mockReadyWithGuild: any = {
        user: { tag: 'TestBot#0001' },
        guilds: {
          cache: new Map([['guild_target_123', {}]]),
        },
      };
      rawClient.emit(Events.ClientReady, mockReadyWithGuild);
      expect(client.ready).toBe(true);

      // Simulate ClientReady without target guild in cache (triggers warning branch)
      const mockReadyWithoutGuild: any = {
        user: { tag: 'TestBot#0001' },
        guilds: {
          cache: new Map(),
        },
      };
      rawClient.emit(Events.ClientReady, mockReadyWithoutGuild);

      // Simulate Error, Warn, ShardDisconnect, ShardReconnecting, ShardResume
      rawClient.emit(Events.Error, new Error('Websocket dropped'));
      rawClient.emit(Events.Warn, 'Heartbeat delayed');
      rawClient.emit(Events.ShardDisconnect, {} as any, 0);
      expect(client.ready).toBe(false);

      rawClient.emit(Events.ShardReconnecting, 0);
      rawClient.emit(Events.ShardResume, 0, 5);
      expect(client.ready).toBe(true);

      await client.destroy();
      expect(client.ready).toBe(false);
    });
  });

  describe('PaginationManager counter and session retrieval', () => {
    it('handles counter button without error', async () => {
      const pm = new PaginationManager();
      const { actionRow } = pm.createSession('caller_1', ['item1', 'item2'], () => {
        return buildBlockedIssuesEmbed([], 0, 1);
      });

      const counterCustomId = (actionRow.components[2] as any).data.custom_id;
      const interaction = createMockButtonInteraction(counterCustomId, {
        id: 'caller_1',
        username: 'caller',
      });

      const handled = await pm.handleButtonInteraction(interaction as any);
      expect(handled).toBe(true);
      expect(interaction.updated).toBe(false);
      expect(pm.getSession(counterCustomId.split(':')[1])).toBeDefined();

      pm.destroy();
    });
  });
});
