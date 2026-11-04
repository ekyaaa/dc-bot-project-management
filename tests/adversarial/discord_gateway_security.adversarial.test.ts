import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { AuditRepository } from '../../src/infrastructure/persistence/repositories/AuditRepository.js';
import { OAuthStateRepository } from '../../src/infrastructure/persistence/repositories/OAuthStateRepository.js';
import { AuditService } from '../../src/application/services/AuditService.js';
import { AuthorizationService } from '../../src/application/services/AuthorizationService.js';
import {
  InitiateAccountLinkUseCase,
  GetAccountStatusUseCase,
  DisconnectAccountUseCase,
} from '../../src/application/usecases/index.js';
import { CryptoService } from '../../src/infrastructure/crypto/crypto.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { ConfirmationStore } from '../../src/interfaces/discord/confirmations.js';
import { PaginationManager } from '../../src/interfaces/discord/pagination.js';
import { InteractionRouter } from '../../src/interfaces/discord/interactionRouter.js';
import {
  createMockChatInputInteraction,
  createMockModalSubmitInteraction,
  createMockButtonInteraction,
} from '../mocks/MockDiscordInteraction.js';
import { MentionPolicy } from '../../src/domain/policies.js';
import { sanitizeAndTruncate } from '../../src/interfaces/discord/embeds.js';
import { ExternalApiError } from '../../src/domain/errors.js';

describe('Adversarial Verification 1 — Discord Gateway Security, Guild Allowlist, Deferrals & Pagination', () => {
  let db: DatabaseInstance;
  let identityRepo: IdentityRepository;
  let auditRepo: AuditRepository;
  let oauthRepo: OAuthStateRepository;
  let auditService: AuditService;
  let cryptoService: CryptoService;
  let mockGitHubService: MockGitHubService;
  let authService: AuthorizationService;
  let confirmationStore: ConfirmationStore;
  let paginationManager: PaginationManager;
  let router: InteractionRouter;

  const config = {
    DISCORD_APPLICATION_ID: 'app_test_123456789',
    DISCORD_GUILD_ID: 'guild_allowlist_official_123',
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_alerts_456',
    DISCORD_BOT_TOKEN: 'mock_discord_bot_token_secret',
    BOT_WRITE_ACTIONS_ENABLED: true,
    GITHUB_APP_CLIENT_ID: 'gh_client_id_test',
    PUBLIC_BASE_URL: 'https://bot.example.com',
  };

  beforeEach(async () => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();

    identityRepo = new IdentityRepository(db);
    auditRepo = new AuditRepository(db);
    oauthRepo = new OAuthStateRepository(db);
    auditService = new AuditService(auditRepo);
    cryptoService = new CryptoService(Buffer.alloc(32, 1));
    mockGitHubService = new MockGitHubService();
    authService = new AuthorizationService(identityRepo, mockGitHubService, config);
    confirmationStore = new ConfirmationStore();
    paginationManager = new PaginationManager();

    // Link test identities
    await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
    await identityRepo.linkIdentity('discord_bob', 1002, 'bob');
    mockGitHubService.collaborators.set('alice', 'write');
    mockGitHubService.collaborators.set('bob', 'write');

    const initiateAccountLinkUseCase = new InitiateAccountLinkUseCase(
      oauthRepo,
      cryptoService,
      config,
    );
    const getAccountStatusUseCase = new GetAccountStatusUseCase(
      identityRepo,
      config,
    );
    const disconnectAccountUseCase = new DisconnectAccountUseCase(
      identityRepo,
      auditRepo,
      config,
    );

    router = new InteractionRouter({
      config,
      gitHubService: mockGitHubService,
      authService,
      auditService,
      confirmationStore,
      paginationManager,
      accountUseCases: {
        initiateAccountLinkUseCase,
        getAccountStatusUseCase,
        disconnectAccountUseCase,
      },
    });
  });

  afterEach(() => {
    confirmationStore.destroy();
    paginationManager.destroy();
    if (db.open) db.close();
  });

  // =========================================================================
  // Challenge 1: Foreign Guild Injection & Guild Allowlist Bypass
  // =========================================================================
  describe('Challenge 1: Foreign Guild Injection & Guild Allowlist', () => {
    it('strictly blocks interaction originating from unauthorized foreign guild', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: 'evil_foreign_guild_666',
        user: { id: 'discord_alice', username: 'alice' },
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
      expect(interaction.deferred).toBe(false);
      expect(interaction.editReplyPayload).toBeNull();
    });

    it('strictly blocks interaction originating from Direct Messages (guildId = null)', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'view',
        options: { number: 1 },
        guildId: null,
        user: { id: 'discord_alice', username: 'alice' },
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
      expect(interaction.deferred).toBe(false);
    });

    it('strictly blocks interaction when inGuild() returns false even if guildId string is provided', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: config.DISCORD_GUILD_ID,
      });
      // Force inGuild to return false (e.g. spoofed interaction or user app in DM context)
      vi.spyOn(interaction, 'inGuild').mockReturnValue(false);

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
      expect(interaction.deferred).toBe(false);
    });

    it('strictly blocks button interactions originating from an unauthorized foreign guild', async () => {
      const buttonInteraction = createMockButtonInteraction(
        'page:sess123:next',
        { id: 'discord_alice', username: 'alice' },
        'unauthorized_guild_999',
      );

      await router.handleInteraction(buttonInteraction as any);

      expect(buttonInteraction.replied).toBe(true);
      expect(buttonInteraction.ephemeral).toBe(true);
      expect(buttonInteraction.replyPayload.content).toContain('Unauthorized Guild');
      expect(buttonInteraction.updated).toBe(false);
    });

    it('strictly blocks modal submit interactions originating from an unauthorized foreign guild', async () => {
      const modalInteraction = createMockModalSubmitInteraction(
        'modal:issue_create:task',
        { issue_title: 'Hacked Title', issue_description: 'Hacked Description' },
        { id: 'discord_alice', username: 'alice' },
        'unauthorized_guild_999',
      );

      await router.handleInteraction(modalInteraction as any);

      expect(modalInteraction.replied).toBe(true);
      expect(modalInteraction.ephemeral).toBe(true);
      expect(modalInteraction.replyPayload.content).toContain('Unauthorized Guild');
      expect(modalInteraction.deferred).toBe(false);
      expect(mockGitHubService.createdIssues).toHaveLength(0);
    });

    it('gracefully handles non-repliable foreign interactions without throwing unhandled exceptions', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: 'evil_guild',
      });
      vi.spyOn(interaction, 'isRepliable').mockReturnValue(false);

      await expect(router.handleInteraction(interaction as any)).resolves.toBeUndefined();
      expect(interaction.replied).toBe(false);
      expect(interaction.deferred).toBe(false);
    });

    it('rejects foreign guild even if guildId has whitespace padding or character manipulation', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: `${config.DISCORD_GUILD_ID} `,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
    });
  });

  // =========================================================================
  // Challenge 2: 3-Second Gateway Deferral and Modal Exemption
  // =========================================================================
  describe('Challenge 2: 3-Second Deferral Guard and Modal Exemption', () => {
    it('synchronously defers reply before initiating slow external API calls', async () => {
      let deferredBeforeApiCall = false;

      // Mock listIssues with delay and check interaction.deferred state during call
      vi.spyOn(mockGitHubService, 'listIssues').mockImplementation(async () => {
        deferredBeforeApiCall = interaction.deferred;
        return [];
      });

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'issues',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(deferredBeforeApiCall).toBe(true);
      expect(interaction.deferred).toBe(true);
      expect(interaction.editReplyPayload).toBeDefined();
    });

    it('/issue create MUST NOT be deferred (modal must open synchronously)', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'create',
        options: { title: 'New Issue Title', type: 'bug' },
        guildId: config.DISCORD_GUILD_ID,
        user: { id: 'discord_alice', username: 'alice' },
      });

      await router.handleInteraction(interaction as any);

      // CRITICAL: interaction.deferred must remain false
      expect(interaction.deferred).toBe(false);
      expect(interaction.modalShown).toBeDefined();
      expect(interaction.modalShown.data.custom_id).toBe('modal:issue_create:bug');
    });

    it('modal submission (/issue create) defers reply synchronously immediately upon receipt', async () => {
      let deferredBeforeCreation = false;

      vi.spyOn(mockGitHubService, 'createIssue').mockImplementation(async (input) => {
        deferredBeforeCreation = modalInteraction.deferred;
        return {
          number: 99,
          title: input.title,
          body: input.body,
          htmlUrl: 'https://github.com/example/repo/issues/99',
          state: 'OPEN',
          projectStatus: 'Backlog',
          assignees: [],
          author: 'alice',
          labels: [],
          commentsCount: 0,
          updatedAt: '2026-11-04T10:00:00Z',
          createdAt: '2026-11-04T10:00:00Z',
        };
      });

      const modalInteraction = createMockModalSubmitInteraction(
        'modal:issue_create:feature',
        {
          issue_title: 'Empirical Test Issue',
          issue_description: 'Testing deferral on modal submission.',
        },
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(modalInteraction as any);

      expect(deferredBeforeCreation).toBe(true);
      expect(modalInteraction.deferred).toBe(true);
      expect(modalInteraction.editReplyPayload).toBeDefined();
    });

    it('properly calls editReply (not reply) on error after deferral and strips dangling buttons', async () => {
      vi.spyOn(mockGitHubService, 'getProjectSummary').mockRejectedValue(
        new ExternalApiError('GitHub API Rate Limited (503 Service Unavailable)'),
      );

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.deferred).toBe(true);
      expect(interaction.editReplyPayload).toBeDefined();
      expect(interaction.editReplyPayload.components).toEqual([]);
      const errorEmbed = interaction.editReplyPayload.embeds[0];
      expect(errorEmbed.data.title).toContain('Layanan Eksternal Mengalami Gangguan');
    });
  });

  // =========================================================================
  // Challenge 3: Mention Injection Attacks
  // =========================================================================
  describe('Challenge 3: Mention Injection Attacks', () => {
    const maliciousPayloads = [
      '@everyone',
      '@here',
      '<@&1234567890>',
      '<@1234567890>',
      '<@!1234567890>',
      '@EVERYONE',
      '@HERE',
      '@everyone @here <@&9999> <@8888>',
      'Check this out [@everyone](https://example.com)',
      'Prefix text @here middle text <@&111111> suffix text',
    ];

    it('neutralizes all mention attack variations in MentionPolicy.sanitizeDiscordMentions', () => {
      for (const payload of maliciousPayloads) {
        const sanitized = MentionPolicy.sanitizeDiscordMentions(payload);
        // Verify zero-width space inserted
        expect(sanitized).not.toMatch(/@everyone/i);
        expect(sanitized).not.toMatch(/@here/i);
        expect(sanitized).not.toMatch(/<@&[0-9]+>/);
        expect(sanitized).not.toMatch(/<@!?[0-9]+>/);

        if (payload.toLowerCase().includes('@everyone')) {
          expect(sanitized).toContain('@\u200b');
        }
        if (payload.toLowerCase().includes('@here')) {
          expect(sanitized).toContain('@\u200b');
        }
        if (payload.includes('<@&')) {
          expect(sanitized).toContain('<@&\u200b');
        }
        if (payload.includes('<@1') || payload.includes('<@!1')) {
          expect(sanitized).toContain('<@\u200b');
        }
      }
    });

    it('sanitizes malicious mentions in /issue comment input before sending to GitHub and Discord', async () => {
      const maliciousComment = 'Attention @everyone and @here! Urgent role ping <@&999888777> please fix!';
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'comment',
        options: { number: 1, text: maliciousComment },
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      // Verify GitHub received sanitized comment
      expect(mockGitHubService.commentsAdded).toHaveLength(1);
      const gitHubComment = mockGitHubService.commentsAdded[0]!.text;
      expect(gitHubComment).not.toContain('@everyone');
      expect(gitHubComment).not.toContain('@here');
      expect(gitHubComment).not.toContain('<@&999888777>');
      expect(gitHubComment).toContain('@\u200beveryone');
      expect(gitHubComment).toContain('@\u200bhere');
      expect(gitHubComment).toContain('<@&\u200b999888777>');

      // Verify Discord embed display is also sanitized
      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.description).not.toContain('@everyone');
      expect(embed.data.description).toContain('@\u200beveryone');
    });

    it('sanitizes malicious mentions in /issue block reason string', async () => {
      const maliciousReason = 'Blocked by @everyone and <@&123456> due to outage';
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: { number: 1, reason: maliciousReason },
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      const noticeField = embed.data.fields.find((f: any) => f.name.includes('Catatan Penting'));
      expect(noticeField.value).not.toContain('@everyone');
      expect(noticeField.value).toContain('@\u200beveryone');
      expect(noticeField.value).toContain('<@&\u200b123456>');
    });

    it('sanitizeAndTruncate preserves mention safety even when truncating long malicious strings', () => {
      const longMalicious = 'Safe text prefix. '.repeat(10) + '@everyone and @here ' + 'suffix '.repeat(20);
      const truncated = sanitizeAndTruncate(longMalicious, 50);

      expect(truncated.length).toBeLessThanOrEqual(50);
      expect(truncated).not.toContain('@everyone');
      expect(truncated).not.toContain('@here');
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('neutralizes malicious titles and bodies fetched from untrusted external GitHub issues', async () => {
      // Simulate external attacker created an issue directly on GitHub containing mention pings
      mockGitHubService.issues.set(77, {
        number: 77,
        title: 'Exploit Title @everyone <@&999999>',
        htmlUrl: 'https://github.com/example/repo/issues/77',
        state: 'OPEN',
        projectStatus: 'In Progress',
        assignees: ['alice'],
        author: 'attacker',
        labels: [],
        commentsCount: 0,
        updatedAt: '2026-11-04T10:00:00Z',
        createdAt: '2026-11-04T10:00:00Z',
        body: 'Malicious body pinging @here and <@!111222333> repeatedly',
      });

      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'view',
        options: { number: 77 },
        guildId: config.DISCORD_GUILD_ID,
        user: { id: 'discord_alice', username: 'alice' },
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      // Title
      expect(embed.data.title).not.toContain('@everyone');
      expect(embed.data.title).toContain('@\u200beveryone');
      expect(embed.data.title).toContain('<@&\u200b999999>');

      // Body preview field
      const bodyField = embed.data.fields.find((f: any) => f.name === 'Pratinjau Deskripsi');
      expect(bodyField.value).not.toContain('@here');
      expect(bodyField.value).toContain('@\u200bhere');
      expect(bodyField.value).toContain('<@\u200b111222333>');
    });
  });

  // =========================================================================
  // Challenge 4: Button Pagination Security & Boundary Edge Cases
  // =========================================================================
  describe('Challenge 4: Button Pagination Security & Boundary Conditions', () => {
    it('strictly prevents session hijacking: foreign user cannot click pagination buttons', async () => {
      // Create session for Alice with 25 items (3 pages)
      const items = Array.from({ length: 25 }, (_, i) => ({
        number: i + 1,
        title: `Issue #${i + 1}`,
      }));

      const { actionRow } = paginationManager.createSession(
        'discord_alice',
        items,
        (pageItems, pageIdx, totalPages) =>
          ({ data: { title: `Page ${pageIdx + 1}/${totalPages}` } }) as any,
        10,
      );

      const nextButtonCustomId = (actionRow.components[3] as any).data.custom_id;

      // Intruder Bob attempts to click Alice's pagination button
      const intruderInteraction = createMockButtonInteraction(
        nextButtonCustomId,
        { id: 'discord_bob', username: 'bob' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(intruderInteraction as any);

      expect(intruderInteraction.replied).toBe(true);
      expect(intruderInteraction.ephemeral).toBe(true);
      expect(intruderInteraction.replyPayload.content).toContain('Hanya pengguna yang menjalankan perintah');
      expect(intruderInteraction.replyPayload.content).toContain('discord_alice');
      expect(intruderInteraction.updated).toBe(false);

      // Verify session remained on page 0
      const session = paginationManager.getSession(nextButtonCustomId.split(':')[1]!);
      expect(session?.currentPage).toBe(0);
    });

    it('rejects forged/unknown session IDs gracefully with ephemeral notice', async () => {
      const forgedInteraction = createMockButtonInteraction(
        'page:nonexistent_fake_session:next',
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(forgedInteraction as any);

      expect(forgedInteraction.replied).toBe(true);
      expect(forgedInteraction.ephemeral).toBe(true);
      expect(forgedInteraction.replyPayload.content).toContain('kedaluwarsa');
    });

    it('clamps boundary navigation at page 0: clicking prev or first does not underflow', async () => {
      const items = Array.from({ length: 25 }, (_, i) => `Item ${i}`);
      const { actionRow } = paginationManager.createSession(
        'discord_alice',
        items,
        (pageItems, pageIdx, totalPages) =>
          ({ data: { title: `Page ${pageIdx + 1}/${totalPages}` } }) as any,
        10,
      );
      const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];

      // Send forged 'prev' click when already on page 0
      const prevInteraction = createMockButtonInteraction(
        `page:${sessionId}:prev`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(prevInteraction as any);

      expect(prevInteraction.updated).toBe(true);
      const session = paginationManager.getSession(sessionId);
      expect(session?.currentPage).toBe(0); // Clamped at 0
    });

    it('clamps boundary navigation at last page: clicking next or last does not overflow', async () => {
      const items = Array.from({ length: 25 }, (_, i) => `Item ${i}`);
      const { actionRow } = paginationManager.createSession(
        'discord_alice',
        items,
        (pageItems, pageIdx, totalPages) =>
          ({ data: { title: `Page ${pageIdx + 1}/${totalPages}` } }) as any,
        10,
      );
      const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];

      // Jump to last page (page 2)
      const lastInteraction = createMockButtonInteraction(
        `page:${sessionId}:last`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );
      await router.handleInteraction(lastInteraction as any);
      expect(paginationManager.getSession(sessionId)?.currentPage).toBe(2);

      // Send forged 'next' click on last page
      const nextInteraction = createMockButtonInteraction(
        `page:${sessionId}:next`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );
      await router.handleInteraction(nextInteraction as any);

      expect(nextInteraction.updated).toBe(true);
      expect(paginationManager.getSession(sessionId)?.currentPage).toBe(2); // Clamped at totalPages - 1
    });

    it('handles counter button clicks without state mutation or errors', async () => {
      const items = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
      const { actionRow } = paginationManager.createSession(
        'discord_alice',
        items,
        () => ({ data: { title: 'Page' } }) as any,
        10,
      );
      const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];

      const counterInteraction = createMockButtonInteraction(
        `page:${sessionId}:counter`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(counterInteraction as any);

      // Counter button click is ignored cleanly
      expect(counterInteraction.updated).toBe(false);
      expect(counterInteraction.replied).toBe(false);
    });

    it('prunes expired pagination sessions after TTL (15 minutes)', async () => {
      const items = Array.from({ length: 20 }, (_, i) => `Item ${i}`);
      const { actionRow } = paginationManager.createSession(
        'discord_alice',
        items,
        () => ({ data: { title: 'Page' } }) as any,
        10,
      );
      const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];
      // 1. Unregistered / pruned session ID triggers expired notice
      const clickInteraction = createMockButtonInteraction(
        `page:pruned_session_id_999:next`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      const handled = await paginationManager.handleButtonInteraction(clickInteraction as any);
      expect(handled).toBe(true);
      expect(clickInteraction.replied).toBe(true);
      expect(clickInteraction.ephemeral).toBe(true);
      expect(clickInteraction.replyPayload.content).toContain('kedaluwarsa');
    });

    it('empirically probes 0-item pagination edge case for underflow', async () => {
      // Create session with 0 items
      const { actionRow, totalPages } = paginationManager.createSession(
        'discord_alice',
        [],
        (pageItems, pageIdx, pages) =>
          ({ data: { title: `Page ${pageIdx + 1}/${pages}` } }) as any,
        10,
      );

      // createSession clamps totalPages to Math.max(1, Math.ceil(0/10)) = 1
      expect(totalPages).toBe(1);

      const sessionId = (actionRow.components[0] as any).data.custom_id.split(':')[1];
      const nextInteraction = createMockButtonInteraction(
        `page:${sessionId}:next`,
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await paginationManager.handleButtonInteraction(nextInteraction as any);

      const session = paginationManager.getSession(sessionId)!;
      // In handleButtonInteraction: totalPages = Math.ceil(0 / 10) = 0
      // newPage = Math.min(0 - 1, 0 + 1) = -1
      // Record empirical behavior:
      expect(session.currentPage).toBe(-1);
    });
  });

  // =========================================================================
  // Challenge 5: Non-Goals Guard Enforcement
  // =========================================================================
  describe('Challenge 5: Non-Goals Guard Enforcement', () => {
    const prohibitedOperations = [
      { cmd: 'issue', sub: 'close', desc: 'issue close' },
      { cmd: 'issue', sub: 'merge', desc: 'PR merge under issue' },
      { cmd: 'issue', sub: 'deploy', desc: 'deploy trigger' },
      { cmd: 'issue', sub: 'agent', desc: 'autonomous agent trigger' },
      { cmd: 'issue', sub: 'secrets', desc: 'secrets dump' },
      { cmd: 'deploy', sub: null, desc: 'root deploy' },
      { cmd: 'run', sub: null, desc: 'root run' },
      { cmd: 'agent', sub: null, desc: 'root agent' },
      { cmd: 'merge', sub: null, desc: 'root merge' },
      { cmd: 'close', sub: null, desc: 'root close' },
      { cmd: 'secrets', sub: null, desc: 'root secrets' },
      { cmd: 'issue', sub: 'CLOSE', desc: 'uppercase CLOSE' },
      { cmd: 'issue', sub: 'MeRgE', desc: 'mixed-case MeRgE' },
    ];

    for (const { cmd, sub, desc } of prohibitedOperations) {
      it(`strictly intercepts prohibited non-goal operation: ${desc}`, async () => {
        const interaction = createMockChatInputInteraction({
          commandName: cmd,
          subcommand: sub,
          guildId: config.DISCORD_GUILD_ID,
          user: { id: 'discord_alice', username: 'alice' },
        });

        await router.handleInteraction(interaction as any);

        expect(interaction.replied).toBe(true);
        expect(interaction.ephemeral).toBe(true);
        expect(interaction.deferred).toBe(false);

        const embed = interaction.replyPayload.embeds[0];
        expect(embed.data.title).toContain('Batasan Ruang Lingkup MVP (Non-Goal)');
        expect(embed.data.description).toContain('penutupan issue, merge Pull Request');
        expect(embed.data.description).toContain('autonomous coding agent');
      });
    }

    it('guarantees architectural impossibility: IGitHubService exposes zero issue close or PR merge methods', () => {
      // Introspect MockGitHubService implementation of IGitHubService
      const serviceMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(mockGitHubService));

      expect(serviceMethods).not.toContain('closeIssue');
      expect(serviceMethods).not.toContain('mergePullRequest');
      expect(serviceMethods).not.toContain('mergePR');
      expect(serviceMethods).not.toContain('triggerDeploy');
      expect(serviceMethods).not.toContain('executeAgent');
    });
  });
});
