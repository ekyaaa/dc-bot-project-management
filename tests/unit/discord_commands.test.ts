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
import { ALL_COMMAND_DEFINITIONS } from '../../src/interfaces/discord/commands/definitions.js';
import { registerGuildSlashCommands } from '../../src/interfaces/discord/commands/registry.js';
import { createDiscordClient, DiscordGatewayClient } from '../../src/interfaces/discord/client.js';

describe('Discord Commands & Interaction Layer (Milestone 3)', () => {
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
    DISCORD_APPLICATION_ID: 'app_123456789',
    DISCORD_GUILD_ID: 'guild_allowlist_123',
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

    // Link test users
    await identityRepo.linkIdentity('discord_alice', 1001, 'alice');
    await identityRepo.linkIdentity('discord_bob', 1002, 'bob');
    await identityRepo.linkIdentity('discord_maintainer', 1003, 'maintainer_dan');

    mockGitHubService.collaborators.set('alice', 'write');
    mockGitHubService.collaborators.set('bob', 'write');
    mockGitHubService.collaborators.set('maintainer_dan', 'maintain');

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
  // 1. Guild Allowlisting & 3-Second Deferral Protection
  // =========================================================================
  describe('Guild Allowlisting & Deferral Protection', () => {
    it('fails closed when command executed in unauthorized guild', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: 'unauthorized_guild_999',
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
      expect(interaction.deferred).toBe(false);
    });

    it('fails closed when command executed outside guild (e.g. DMs)', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: null,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      expect(interaction.replyPayload.content).toContain('Unauthorized Guild');
    });

    it('synchronously defers reply within 3s for async commands', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.deferred).toBe(true);
      expect(interaction.ephemeral).toBe(false);
      expect(interaction.editReplyPayload).toBeDefined();
    });

    it('enforces ephemeral deferral for /project mine', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'mine',
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.deferred).toBe(true);
      expect(interaction.ephemeral).toBe(true);
    });

    it('does NOT call deferReply on /issue create (modal must be shown directly)', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'create',
        options: { title: 'New Task Title', type: 'task' },
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.deferred).toBe(false);
      expect(interaction.modalShown).toBeDefined();
      expect(interaction.modalShown.data.title).toContain('Buat Issue GitHub');
    });
  });

  // =========================================================================
  // 2. Read-Only Query Commands (/project and /issue view)
  // =========================================================================
  describe('Read-Only Query Commands', () => {
    it('/project status: returns project summary with canonical status counts and PRs', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'status',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Status Proyek');
      expect(embed.data.fields).toHaveLength(7);
      expect(embed.data.fields[0].name).toContain('Backlog');
      expect(embed.data.fields[6].name).toContain('Total Metrik');
    });

    it('/project issues: returns issue list with status and priority indicators', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'issues',
        options: { status: 'In Progress', limit: 10 },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Daftar Issue Proyek');
      expect(embed.data.description).toContain('Setup Database Migrations');
      expect(interaction.editReplyPayload.components).toHaveLength(0); // <= 10 items, no buttons
    });

    it('/project issues: attaches interactive pagination buttons when items > 10', async () => {
      // Seed 15 issues in mock
      for (let i = 10; i < 25; i++) {
        mockGitHubService.issues.set(i, {
          number: i,
          title: `Bulk Issue #${i}`,
          htmlUrl: `https://github.com/example/repo/issues/${i}`,
          state: 'OPEN',
          projectStatus: 'Ready',
          assignees: ['alice'],
          author: 'alice',
          labels: [],
          commentsCount: 0,
          updatedAt: '2026-11-01T10:00:00Z',
          createdAt: '2026-11-01T08:00:00Z',
          body: 'Test body',
        });
      }

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'issues',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Halaman 1 dari');
      expect(interaction.editReplyPayload.components).toHaveLength(1); // ActionRow present
      expect(interaction.editReplyPayload.components[0].components).toHaveLength(5); // 5 buttons
    });

    it('/project mine: returns assigned issues and pending reviews for linked caller', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'mine',
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Dasbor Tugas Saya (@alice)');
      expect(embed.data.fields[0].name).toContain('Issue Ditugaskan');
    });

    it('/project mine: rejects unlinked Discord users with UnauthorizedError', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'mine',
        user: { id: 'unlinked_user_999', username: 'stranger' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Akses Ditolak');
      expect(embed.data.description).toContain('/account connect');
    });

    it('/project blocked: lists blocked issues with reasons', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'blocked',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Issue Terblokir (1)');
      expect(embed.data.description).toContain('Fix OAuth Callback Bug');
      expect(embed.data.description).toContain('Waiting for upstream GitHub App credentials');
    });

    it('/project unassigned: returns unassigned issues sorted by canonical priority', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'unassigned',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Issue Terbuka Belum Ditugaskan');
      expect(embed.data.description).toContain('Unassigned Task for Sprint');
      expect(embed.data.description).toContain('Prioritas: **Medium**');
    });

    it('/project reviews: lists open PR review requests', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'reviews',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Antrean Code Review PR');
      expect(embed.data.description).toContain('PR: Add OAuth Route');
    });

    it('/project issues: renders empty state embed when 0 issues found', async () => {
      mockGitHubService.issues.clear();
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'issues',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('0 item');
      expect(embed.data.description).toContain('Tidak ada issue');
    });

    it('/project blocked: paginates when blocked issues > 10', async () => {
      for (let i = 10; i < 25; i++) {
        mockGitHubService.issues.set(i, {
          number: i,
          title: `Blocked Issue #${i}`,
          htmlUrl: `https://github.com/example/repo/issues/${i}`,
          state: 'OPEN',
          projectStatus: 'Blocked',
          blockedReason: 'API limit',
          assignees: ['alice'],
          author: 'alice',
          labels: [],
          commentsCount: 0,
          updatedAt: '2026-11-01T10:00:00Z',
          createdAt: '2026-11-01T08:00:00Z',
          body: '',
        });
      }

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'blocked',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.editReplyPayload.components).toHaveLength(1);
      expect(interaction.editReplyPayload.embeds[0].data.title).toContain('Issue Terblokir');
    });

    it('/project unassigned: paginates when unassigned issues > 10', async () => {
      for (let i = 10; i < 25; i++) {
        mockGitHubService.issues.set(i, {
          number: i,
          title: `Unassigned Issue #${i}`,
          htmlUrl: `https://github.com/example/repo/issues/${i}`,
          state: 'OPEN',
          projectStatus: 'Backlog',
          projectPriority: 'Low',
          assignees: [],
          author: 'alice',
          labels: [],
          commentsCount: 0,
          updatedAt: '2026-11-01T10:00:00Z',
          createdAt: '2026-11-01T08:00:00Z',
          body: '',
        });
      }

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'unassigned',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.editReplyPayload.components).toHaveLength(1);
    });

    it('/project reviews: paginates when review requests > 10', async () => {
      mockGitHubService.reviewRequests = Array.from({ length: 15 }, (_, i) => ({
        pullNumber: 100 + i,
        title: `PR Review #${i}`,
        htmlUrl: `https://github.com/example/repo/pull/${100 + i}`,
        author: 'developer',
        requestedReviewers: ['reviewer1'],
        draft: false,
        createdAt: '2026-11-01T08:00:00Z',
        updatedAt: '2026-11-01T10:00:00Z',
      }));

      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'reviews',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.editReplyPayload.components).toHaveLength(1);
    });

    it('/project digest: returns daily summary preview', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'project',
        subcommand: 'digest',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Ringkasan Harian Proyek');
      expect(embed.data.fields[0].name).toContain('Alur Kerja Pipa Status');
      expect(embed.data.footer.text).toContain('09:00 WIB');
    });

    it('/issue view: returns detailed issue card with labels, assignees, and link button', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'view',
        options: { number: 1 },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('[#1] Setup Database Migrations');
      expect(embed.data.fields.some((f: any) => f.name === 'Assignee')).toBe(true);

      const components = interaction.editReplyPayload.components;
      expect(components).toHaveLength(1);
      expect((components[0].components[0] as any).data.label).toBe('Buka di GitHub');
    });

    it('/issue view: handles non-existent issue with NotFoundError', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'view',
        options: { number: 9999 },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Data Tidak Ditemukan');
      expect(interaction.editReplyPayload.components).toEqual([]);
    });
  });

  // =========================================================================
  // 3. Controlled Write Operations & Modal Submissions
  // =========================================================================
  describe('Controlled Write Operations', () => {
    it('handles modal submission for /issue create: creates issue, logs audit, and delivers card', async () => {
      const modalInteraction = createMockModalSubmitInteraction(
        'modal:issue_create:feature',
        {
          issue_title: 'Implement Dark Mode UX',
          issue_description: 'Add persistent theme toggle for developer comfort.',
          issue_criteria: '- [ ] Theme toggle works\n- [ ] Persists in localStorage',
        },
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(modalInteraction as any);

      expect(modalInteraction.deferred).toBe(true);
      const embed = modalInteraction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Implement Dark Mode UX');

      // Verify issue created in GitHub mock
      expect(mockGitHubService.createdIssues).toHaveLength(1);
      expect(mockGitHubService.createdIssues[0]!.title).toBe('Implement Dark Mode UX');
      expect(mockGitHubService.createdIssues[0]!.body).toContain('### Acceptance Criteria');

      // Verify audit log
      const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_CREATE') as any[];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].actor_github_login).toBe('alice');
    });

    it('/issue assign: renders Diff Preview embed with Confirm / Cancel buttons', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'assign',
        options: { number: 3, developer: 'alice' },
        user: { id: 'discord_maintainer', username: 'maintainer_dan' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.deferred).toBe(true);
      expect(interaction.ephemeral).toBe(true);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Konfirmasi Diperlukan: Penugasan Issue');
      expect(embed.data.fields[1].value).toContain('@alice');

      const buttons = interaction.editReplyPayload.components[0].components;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].data.label).toBe('Konfirmasi');
      expect(buttons[1].data.label).toBe('Batalkan');
    });

    it('/issue status: renders Diff Preview embed with Confirm / Cancel buttons', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'status',
        options: { number: 1, status: 'In Review' }, // Issue 1 is assigned to alice ('In Progress')
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Pembaruan Status Project v2');
      expect(embed.data.fields[1].value).toContain('In Progress` ➔ **`In Review`**');
    });

    it('/issue priority: renders Diff Preview embed with Confirm / Cancel buttons', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'priority',
        options: { number: 1, priority: 'Urgent' }, // Currently High
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Pembaruan Tingkat Prioritas');
      expect(embed.data.fields[1].value).toContain('High` ➔ **`Urgent`**');
    });

    it('/issue block: enforces mandatory blocker reason (min 3 chars)', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: { number: 1, reason: 'no' }, // shorter than 3 chars
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Validasi Tidak Sesuai');
      expect(embed.data.description).toContain('minimal 3 karakter');
    });

    it('/issue block: renders Diff Preview embed with notice when valid reason provided', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'block',
        options: { number: 1, reason: 'Blocked by upstream database outage' },
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Penandaan Issue Terblokir');
      expect(embed.data.fields.some((f: any) => f.name.includes('Catatan Penting'))).toBe(true);
    });

    it('/issue comment: sanitizes text against mention injection, posts comment, and logs audit', async () => {
      const rawText = 'Urgent update @everyone and <@&999999> please review this immediately.';
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'comment',
        options: { number: 1, text: rawText },
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(mockGitHubService.commentsAdded).toHaveLength(1);
      const postedComment = mockGitHubService.commentsAdded[0]!.text;
      // Confirm @everyone was neutralized with zero-width space
      expect(postedComment).not.toContain('@everyone');
      expect(postedComment).toContain('@\u200Beveryone');
      expect(postedComment).toContain('*Dikirim dari Discord oleh @alice*');

      const auditRows = db.prepare('SELECT * FROM audit_logs WHERE action = ?').all('ISSUE_COMMENT') as any[];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].actor_github_login).toBe('alice');

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Komentar Berhasil Ditambahkan');
    });
  });

  // =========================================================================
  // 4. Account Management Slash Commands (/account)
  // =========================================================================
  describe('Account Management Slash Commands', () => {
    it('/account connect: returns ephemeral PKCE authorization URL and state nonce', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'account',
        subcommand: 'connect',
        user: { id: 'discord_charlie', username: 'charlie' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.ephemeral).toBe(true);
      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Tautkan Akun Discord ke GitHub');

      const components = interaction.editReplyPayload.components;
      expect((components[0].components[0] as any).data.label).toBe('Otorisasi dengan GitHub');
      expect((components[0].components[0] as any).data.url).toContain('https://github.com/login/oauth/authorize');
    });

    it('/account status: returns linked account status and application role', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'account',
        subcommand: 'status',
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Status Akun GitHub Tertaut');
      expect(embed.data.fields[0].value).toBe('@alice');
      expect(embed.data.fields[2].value).toBe('**Developer**');
    });

    it('/account disconnect: unlinks account in database and returns revocation guidance', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'account',
        subcommand: 'disconnect',
        user: { id: 'discord_alice', username: 'alice' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Tautan Akun Berhasil Diputuskan');

      // Verify unlinked in SQLite
      const identity = await identityRepo.findByDiscordId('discord_alice');
      expect(identity).toBeNull();
    });
  });

  // =========================================================================
  // 5. Help Directory & Categorized Help (/help)
  // =========================================================================
  describe('Categorized /help Command', () => {
    it('/help: renders main directory when no category option passed', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'help',
        subcommand: null,
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Direktori Panduan Perintah Bot Proyek');
      expect(embed.data.fields).toHaveLength(4);
    });

    it('/help category:general: displays read-only query commands', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'help',
        options: { category: 'general' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Kueri Proyek & Read-Only');
      expect(embed.data.fields.some((f: any) => f.name === '`/project status`')).toBe(true);
    });

    it('/help category:write: displays write operations and non-goals', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'help',
        options: { category: 'write' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Operasi Tulis & Workflow');
      expect(embed.data.fields.some((f: any) => f.name.includes('Non-Goals'))).toBe(true);
    });

    it('/help category:account: displays OAuth PKCE explanation', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'help',
        options: { category: 'account' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Manajemen Akun & Identitas');
    });

    it('/help category:policies: displays RBAC and security policies', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'help',
        options: { category: 'policies' },
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      const embed = interaction.editReplyPayload.embeds[0];
      expect(embed.data.title).toContain('Kebijakan Keamanan & Hak Akses');
    });
  });

  // =========================================================================
  // 6. Non-Goals Interception Guard
  // =========================================================================
  describe('MVP Non-Goals Interception Guard', () => {
    it('intercepts /issue close and explains MVP non-goal boundary', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'issue',
        subcommand: 'close',
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.ephemeral).toBe(true);
      const embed = interaction.replyPayload.embeds[0];
      expect(embed.data.title).toContain('Batasan Ruang Lingkup MVP (Non-Goal)');
      expect(embed.data.description).toContain('penutupan issue, merge Pull Request');
    });

    it('intercepts prohibited root operations like deploy or run', async () => {
      const interaction = createMockChatInputInteraction({
        commandName: 'deploy',
        subcommand: null,
        guildId: config.DISCORD_GUILD_ID,
      });

      await router.handleInteraction(interaction as any);

      expect(interaction.replied).toBe(true);
      expect(interaction.replyPayload.embeds[0].data.title).toContain('Non-Goal');
    });
  });

  // =========================================================================
  // 7. Client, Command Schemas, and Registry Helpers
  // =========================================================================
  describe('Gateway Client & Command Registration', () => {
    it('creates Discord client with only non-privileged intents (Guilds & GuildMessages)', () => {
      const client = createDiscordClient();
      expect(client).toBeDefined();
      expect(client.options.intents).toBeDefined();
    });

    it('creates DiscordGatewayClient and handles start/destroy', async () => {
      const gatewayClient = new DiscordGatewayClient({ config });
      expect(gatewayClient.rawClient).toBeDefined();
      expect(gatewayClient.ready).toBe(false);

      // Mock login & destroy
      vi.spyOn(gatewayClient.rawClient, 'login').mockResolvedValue('mock_token');
      vi.spyOn(gatewayClient.rawClient, 'destroy').mockResolvedValue(undefined as any);

      await gatewayClient.start();
      await gatewayClient.destroy();
      expect(gatewayClient.ready).toBe(false);
    });

    it('validates ALL_COMMAND_DEFINITIONS schemas serialize to valid JSON', () => {
      expect(ALL_COMMAND_DEFINITIONS).toHaveLength(4);
      const jsonList = ALL_COMMAND_DEFINITIONS.map((c) => c.toJSON());
      expect(jsonList).toHaveLength(4);

      const names = jsonList.map((c) => c.name);
      expect(names).toEqual(['project', 'issue', 'account', 'help']);
    });

    it('registerGuildSlashCommands sends PUT request with command payload', async () => {
      const { REST } = await import('discord.js');
      const putSpy = vi.spyOn(REST.prototype, 'put').mockResolvedValue([] as any);

      const result = await registerGuildSlashCommands({
        DISCORD_APPLICATION_ID: config.DISCORD_APPLICATION_ID,
        DISCORD_GUILD_ID: config.DISCORD_GUILD_ID,
        DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN,
      });

      expect(result.registeredCount).toBe(4);
      expect(putSpy).toHaveBeenCalled();
      putSpy.mockRestore();
    });

    it('router handles unknown button interaction with ephemeral notice', async () => {
      const buttonInteraction = createMockButtonInteraction(
        'unknown_button_id',
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(buttonInteraction as any);

      expect(buttonInteraction.replied).toBe(true);
      expect(buttonInteraction.ephemeral).toBe(true);
      expect(buttonInteraction.replyPayload.content).toContain('tidak dikenali');
    });

    it('router handles unknown modal submission with error embed', async () => {
      const modalInteraction = createMockModalSubmitInteraction(
        'modal:unknown_action',
        {},
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(modalInteraction as any);

      expect(modalInteraction.deferred).toBe(true);
      expect(modalInteraction.editReplyPayload.embeds[0].data.title).toContain('Gagal');
    });

    it('modal /issue create rejects title shorter than 3 characters with ValidationError', async () => {
      const modalInteraction = createMockModalSubmitInteraction(
        'modal:issue_create:task',
        {
          issue_title: 'AB',
          issue_description: 'Valid description text goes here',
        },
        { id: 'discord_alice', username: 'alice' },
        config.DISCORD_GUILD_ID,
      );

      await router.handleInteraction(modalInteraction as any);

      expect(modalInteraction.editReplyPayload.embeds[0].data.title).toContain('Validasi Tidak Sesuai');
    });
  });
});
