import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { ProjectRepository } from '../../src/infrastructure/persistence/repositories/ProjectRepository.js';
import { GitHubServiceFactory } from '../../src/infrastructure/github/GitHubServiceFactory.js';
import { InteractionRouter } from '../../src/interfaces/discord/interactionRouter.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { ConfirmationStore } from '../../src/interfaces/discord/confirmations.js';
import type { IAuthorizationService } from '../../src/application/ports/IAuthorizationService.js';

describe('Multi-Project Interaction Routing', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let defaultMockGitHub: MockGitHubService;
  let kopkarMockGitHub: MockGitHubService;
  let gitHubFactory: GitHubServiceFactory;
  let router: InteractionRouter;

  const MOCK_CONFIG = {
    DISCORD_GUILD_ID: '1374691978230366240',
    DISCORD_APPLICATION_ID: 'test_app_id',
    BOT_WRITE_ACTIONS_ENABLED: true,
  };

  const mockAuthService: IAuthorizationService = {
    resolvePrincipal: vi.fn().mockImplementation(async (discordId, guildId) => ({
      discordUserId: discordId,
      guildId,
      identity: {
        discordUserId: discordId,
        githubUserId: 12345,
        githubLogin: 'testuser',
        applicationRole: 'Developer',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    })),
    requireVerifiedIdentity: vi.fn(),
    authorizeRead: vi.fn().mockReturnValue({ allowed: true }),
    authorizeWrite: vi.fn().mockResolvedValue({ allowed: true }),
    assertAuthorizedWrite: vi.fn().mockImplementation(async (p) => p),
    authorizeConfirmation: vi.fn().mockReturnValue({ allowed: true }),
    assertAuthorizedConfirmation: vi.fn().mockImplementation(async (p) => p),
  };

  beforeEach(() => {
    db = new Database(':memory:');
    const migrator = new Migrator(db);
    migrator.runMigrations();

    projectRepo = new ProjectRepository(db);

    // Seed Kopkar project and permission
    projectRepo.createOrUpdateProject({
      id: 'kopkar-sai',
      name: 'Kopkar SAI',
      github_owner: 'kopkar-xyz',
      github_repo: 'kopkarsai-ecosystem',
      project_number: 1,
      description: 'Kopkar testing ecosystem',
    });

    projectRepo.setGuildPermission({
      guild_id: '1463907110050861302',
      project_id: 'kopkar-sai',
      notification_channel_id: '1567707422074740838',
      is_default: true,
    });

    defaultMockGitHub = new MockGitHubService();
    kopkarMockGitHub = new MockGitHubService();

    // Default mock has issue #1
    defaultMockGitHub.issues.set(1, {
      number: 1,
      title: 'Eva Issue',
      htmlUrl: 'https://github.com/Nexa-Code-Studio/eva-ecosystem/issues/1',
      state: 'OPEN',
      assignees: [],
      author: 'eva-author',
      labels: [],
      commentsCount: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    // Kopkar mock has issue #2
    kopkarMockGitHub.issues.set(2, {
      number: 2,
      title: 'Kopkar Issue',
      htmlUrl: 'https://github.com/kopkar-xyz/kopkarsai-ecosystem/issues/2',
      state: 'OPEN',
      assignees: [],
      author: 'kopkar-author',
      labels: [],
      commentsCount: 0,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    // Mock factory to route to respective services
    gitHubFactory = {
      getServiceForProject: vi.fn().mockImplementation((proj) => {
        if (proj?.id === 'kopkar-sai' || proj?.github_owner === 'kopkar-xyz') {
          return kopkarMockGitHub;
        }
        return defaultMockGitHub;
      }),
      getDefaultService: vi.fn().mockReturnValue(defaultMockGitHub),
    } as unknown as GitHubServiceFactory;

    router = new InteractionRouter({
      config: MOCK_CONFIG,
      gitHubService: defaultMockGitHub as any,
      gitHubServiceFactory: gitHubFactory,
      authService: mockAuthService,
      auditService: { logMutation: vi.fn() } as any,
      projectRepository: projectRepo,
      confirmationStore: new ConfirmationStore(),
      accountUseCases: {
        initiateAccountLinkUseCase: {} as any,
        getAccountStatusUseCase: {} as any,
        disconnectAccountUseCase: {} as any,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  it('resolves Kopkar project when interaction comes from Kopkar notification channel', () => {
    const mockInteraction: any = {
      guildId: '1463907110050861302',
      channelId: '1567707422074740838',
      isChatInputCommand: () => false,
    };

    const resolved = router.resolveProjectForInteraction(mockInteraction);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('kopkar-sai');
    expect(resolved?.github_owner).toBe('kopkar-xyz');
    expect(resolved?.github_repo).toBe('kopkarsai-ecosystem');
  });

  it('resolves Eva project when interaction comes from Eva notification channel', () => {
    const mockInteraction: any = {
      guildId: '1374691978230366240',
      channelId: '1567466308789076048',
      isChatInputCommand: () => false,
    };

    const resolved = router.resolveProjectForInteraction(mockInteraction);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('eva-ecosystem');
    expect(resolved?.github_owner).toBe('Nexa-Code-Studio');
    expect(resolved?.github_repo).toBe('eva-ecosystem');
  });

  it('resolves guild default project when interaction channel is not explicitly bound', () => {
    const mockInteraction: any = {
      guildId: '1463907110050861302',
      channelId: 'random_general_chat_id',
      isChatInputCommand: () => false,
    };

    const resolved = router.resolveProjectForInteraction(mockInteraction);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('kopkar-sai');
  });

  it('prioritizes explicit project option over channel binding', () => {
    const mockInteraction: any = {
      guildId: '1463907110050861302',
      channelId: '1567707422074740838', // Kopkar channel
      isChatInputCommand: () => true,
      options: {
        getString: vi.fn().mockImplementation((name) => (name === 'project' ? 'eva-ecosystem' : null)),
      },
    };

    const resolved = router.resolveProjectForInteraction(mockInteraction);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe('eva-ecosystem');
  });

  it('routes /project issues to Kopkar service when executed in Kopkar channel', async () => {
    const mockInteraction: any = {
      guildId: '1463907110050861302',
      channelId: '1567707422074740838',
      inGuild: () => true,
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName: 'project',
      options: {
        getSubcommand: () => 'issues',
        getString: () => null,
        getInteger: () => 50,
      },
      user: { id: 'user_123' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    const spyListIssuesKopkar = vi.spyOn(kopkarMockGitHub, 'listIssues');
    const spyListIssuesDefault = vi.spyOn(defaultMockGitHub, 'listIssues');

    await router.handleInteraction(mockInteraction);

    expect(spyListIssuesKopkar).toHaveBeenCalled();
    expect(spyListIssuesDefault).not.toHaveBeenCalled();
    expect(mockInteraction.editReply).toHaveBeenCalled();
  });
});
