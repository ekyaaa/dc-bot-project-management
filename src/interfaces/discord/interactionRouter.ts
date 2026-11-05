import {
  EmbedBuilder,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Config } from '../../config/env.js';
import type { IGitHubService } from '../../application/ports/IGitHubService.js';
import type { GitHubServiceFactory } from '../../infrastructure/github/GitHubServiceFactory.js';
import type { IAuthorizationService } from '../../application/ports/IAuthorizationService.js';
import type { ProjectRepository, ProjectRecord } from '../../infrastructure/persistence/repositories/ProjectRepository.js';
import type { AuditService } from '../../application/services/AuditService.js';
import type {
  InitiateAccountLinkUseCase,
  GetAccountStatusUseCase,
  DisconnectAccountUseCase,
} from '../../application/usecases/index.js';
import { ConfirmationStore, handleConfirmationInteraction } from './confirmations.js';
import { PaginationManager } from './pagination.js';
import { buildHelpEmbed } from './commands/help.js';
import { buildErrorEmbed, EMBED_COLORS } from './embeds.js';
import {
  handleProjectQueryCommand,
  handleIssueViewCommand,
} from './commands/queryHandlers.js';
import {
  handleIssueCreateInitiate,
  handleIssueCreateModalSubmit,
  handleIssueAssignCommand,
  handleIssueStatusCommand,
  handleIssuePriorityCommand,
  handleIssueBlockCommand,
  handleIssueCommentCommand,
} from './commands/writeHandlers.js';
import { handleAccountCommand } from './commands/accountHandlers.js';

export interface InteractionRouterDependencies {
  config: Pick<Config, 'DISCORD_GUILD_ID' | 'DISCORD_APPLICATION_ID' | 'BOT_WRITE_ACTIONS_ENABLED'>;
  gitHubService: IGitHubService;
  gitHubServiceFactory?: GitHubServiceFactory;
  authService: IAuthorizationService;
  auditService: AuditService;
  projectRepository?: ProjectRepository;
  confirmationStore?: ConfirmationStore;
  paginationManager?: PaginationManager;
  accountUseCases: {
    initiateAccountLinkUseCase: InitiateAccountLinkUseCase;
    getAccountStatusUseCase: GetAccountStatusUseCase;
    disconnectAccountUseCase: DisconnectAccountUseCase;
  };
}

const PROHIBITED_NON_GOAL_OPERATIONS = new Set([
  'close',
  'merge',
  'deploy',
  'run',
  'agent',
  'secrets',
]);

export class InteractionRouter {
  private readonly config: Pick<
    Config,
    'DISCORD_GUILD_ID' | 'DISCORD_APPLICATION_ID' | 'BOT_WRITE_ACTIONS_ENABLED'
  >;
  private readonly gitHubService: IGitHubService;
  private readonly gitHubServiceFactory?: GitHubServiceFactory;
  private readonly authService: IAuthorizationService;
  private readonly auditService: AuditService;
  private readonly projectRepository?: ProjectRepository;
  private readonly confirmationStore: ConfirmationStore;
  private readonly paginationManager: PaginationManager;
  private readonly accountUseCases: {
    initiateAccountLinkUseCase: InitiateAccountLinkUseCase;
    getAccountStatusUseCase: GetAccountStatusUseCase;
    disconnectAccountUseCase: DisconnectAccountUseCase;
  };

  constructor(deps: InteractionRouterDependencies) {
    this.config = deps.config;
    this.gitHubService = deps.gitHubService;
    this.gitHubServiceFactory = deps.gitHubServiceFactory;
    this.authService = deps.authService;
    this.auditService = deps.auditService;
    this.projectRepository = deps.projectRepository;
    this.confirmationStore = deps.confirmationStore ?? ConfirmationStore.getInstance();
    this.paginationManager = deps.paginationManager ?? PaginationManager.getInstance();
    this.accountUseCases = deps.accountUseCases;
  }

  /**
   * Main Gateway Interaction Dispatcher
   */
  public async handleInteraction(interaction: Interaction): Promise<void> {
    // 1. Fail-closed Guild Allowlist Enforcement
    const isAuthorized = this.projectRepository
      ? (this.projectRepository.getProjectsForGuild(interaction.guildId || '').length > 0 || interaction.guildId === this.config.DISCORD_GUILD_ID)
      : (interaction.guildId === this.config.DISCORD_GUILD_ID);

    if (!interaction.inGuild() || !isAuthorized) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: '⛔ Server ini belum memiliki izin akses ke proyek GitHub manapun (Unauthorized Guild). Silakan tautkan di Web Dashboard Admin.',
          ephemeral: true,
        });
      }
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        await this.routeChatInputCommand(interaction);
      } else if (interaction.isButton()) {
        await this.routeButtonInteraction(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.routeModalSubmitInteraction(interaction);
      }
    } catch (error) {
      await this.handleError(interaction, error);
    }
  }

  /**
   * Routes Chat Input Commands (/project, /issue, /account, /help)
   */
  private async routeChatInputCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const { commandName } = interaction;
    let subcommand: string | null = null;
    try {
      subcommand = interaction.options.getSubcommand(false);
    } catch {
      subcommand = null;
    }

    // 2. Non-Goals Interception Guard
    if (
      PROHIBITED_NON_GOAL_OPERATIONS.has(commandName.toLowerCase()) ||
      (subcommand && PROHIBITED_NON_GOAL_OPERATIONS.has(subcommand.toLowerCase()))
    ) {
      const nonGoalEmbed = new EmbedBuilder()
        .setTitle('🛡️ Batasan Ruang Lingkup MVP (Non-Goal)')
        .setColor(EMBED_COLORS.BLOCKED)
        .setDescription(
          `Operasi \`${subcommand || commandName}\` sengaja tidak disediakan pada bot.\n\n` +
            'Demi menjaga keamanan dan integritas proyek, penutupan issue, merge Pull Request, deployment server, dan eksekusi autonomous coding agent harus dilakukan secara manual langsung pada GitHub atau CI/CD pipeline.',
        )
        .setTimestamp();

      await interaction.reply({ embeds: [nonGoalEmbed], ephemeral: true });
      return;
    }

    // 3. 3-Second Timeout Deferral Guard
    // Special exception: /issue create opens a Modal dialog, which MUST NOT be deferred!
    const isModalOpeningCommand = commandName === 'issue' && subcommand === 'create';

    if (!isModalOpeningCommand) {
      const isEphemeral = this.determineEphemeralPrivacy(commandName, subcommand);
      await interaction.deferReply({ ephemeral: isEphemeral });
    }

    // 4. Dispatch to Specific Command Handlers
    const resolvedProject = this.resolveProjectForInteraction(interaction);
    const activeGitHubService = this.getGitHubService(resolvedProject);

    const queryDeps = {
      gitHubService: activeGitHubService,
      authService: this.authService,
      paginationManager: this.paginationManager,
    };

    const writeDeps = {
      authService: this.authService,
      gitHubService: activeGitHubService,
      auditService: this.auditService,
      confirmationStore: this.confirmationStore,
      projectId: resolvedProject?.id,
    };

    switch (commandName) {
      case 'project': {
        await handleProjectQueryCommand(interaction, queryDeps);
        break;
      }

      case 'issue': {
        switch (subcommand) {
          case 'view':
            await handleIssueViewCommand(interaction, queryDeps);
            break;
          case 'create':
            await handleIssueCreateInitiate(interaction, resolvedProject?.id);
            break;
          case 'assign':
            await handleIssueAssignCommand(interaction, writeDeps);
            break;
          case 'status':
            await handleIssueStatusCommand(interaction, writeDeps);
            break;
          case 'priority':
            await handleIssuePriorityCommand(interaction, writeDeps);
            break;
          case 'block':
            await handleIssueBlockCommand(interaction, writeDeps);
            break;
          case 'comment':
            await handleIssueCommentCommand(interaction, writeDeps);
            break;
          default:
            throw new Error(`Subcommand /issue '${subcommand}' tidak dikenal.`);
        }
        break;
      }

      case 'account': {
        await handleAccountCommand(interaction, this.accountUseCases);
        break;
      }

      case 'help': {
        const category = interaction.options.getString('category');
        const helpEmbed = buildHelpEmbed(category);
        await interaction.editReply({ embeds: [helpEmbed], components: [] });
        break;
      }

      default:
        throw new Error(`Perintah '${commandName}' tidak didukung.`);
    }
  }

  /**
   * Routes Button Interactions (Pagination and 2-phase Confirmations)
   */
  private async routeButtonInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
    // 1. Try pagination button handler
    const handledByPagination = await this.paginationManager.handleButtonInteraction(interaction);
    if (handledByPagination) {
      return;
    }

    // 2. Try confirmation button handler
    let activeGitHubService = this.gitHubService;
    let resolvedProjectId: string | undefined;

    const parts = interaction.customId.split(':');
    if (parts.length >= 5 && (parts[0] === 'confirm' || parts[0] === 'cancel')) {
      const sessionKey = `${parts[1]}:${parts[2]}:${parts[3]}:${parts[4]}`;
      const session = this.confirmationStore.get(sessionKey);
      if (session?.projectId && this.projectRepository) {
        resolvedProjectId = session.projectId;
        const project = this.projectRepository.getProjectById(session.projectId);
        activeGitHubService = this.getGitHubService(project);
      } else {
        const resolvedProject = this.resolveProjectForInteraction(interaction);
        resolvedProjectId = resolvedProject?.id;
        activeGitHubService = this.getGitHubService(resolvedProject);
      }
    } else {
      const resolvedProject = this.resolveProjectForInteraction(interaction);
      resolvedProjectId = resolvedProject?.id;
      activeGitHubService = this.getGitHubService(resolvedProject);
    }

    const writeDeps = {
      authService: this.authService,
      gitHubService: activeGitHubService,
      auditService: this.auditService,
      confirmationStore: this.confirmationStore,
      projectId: resolvedProjectId,
    };

    const handledByConfirmation = await handleConfirmationInteraction(interaction, writeDeps);
    if (handledByConfirmation) {
      return;
    }

    // Unknown button interaction
    await interaction.reply({
      content: '⚠️ Tombol interaksi tidak dikenali atau telah kedaluwarsa.',
      ephemeral: true,
    });
  }

  /**
   * Routes Modal Submit Interactions (/issue create)
   */
  private async routeModalSubmitInteraction(
    interaction: ModalSubmitInteraction,
  ): Promise<void> {
    // Defer reply immediately within 3s
    await interaction.deferReply({ ephemeral: false });

    let activeGitHubService = this.gitHubService;
    let resolvedProjectId: string | undefined;

    const modalParts = interaction.customId.split(':');
    if (modalParts.length >= 4 && modalParts[3] && modalParts[3] !== 'default' && this.projectRepository) {
      resolvedProjectId = modalParts[3];
      const project = this.projectRepository.getProjectById(modalParts[3]);
      activeGitHubService = this.getGitHubService(project);
    } else {
      const resolvedProject = this.resolveProjectForInteraction(interaction);
      resolvedProjectId = resolvedProject?.id;
      activeGitHubService = this.getGitHubService(resolvedProject);
    }

    const writeDeps = {
      authService: this.authService,
      gitHubService: activeGitHubService,
      auditService: this.auditService,
      confirmationStore: this.confirmationStore,
      projectId: resolvedProjectId,
    };

    if (interaction.customId.startsWith('modal:issue_create')) {
      await handleIssueCreateModalSubmit(interaction, writeDeps);
      return;
    }

    throw new Error(`Modal submission '${interaction.customId}' tidak dikenali.`);
  }

  /**
   * Resolves the target ProjectRecord for an interaction.
   */
  public resolveProjectForInteraction(interaction: Interaction): ProjectRecord | null {
    if (!this.projectRepository) {
      return null;
    }

    if (interaction.isChatInputCommand()) {
      try {
        const projectOpt = interaction.options.getString('project');
        if (projectOpt) {
          const project = this.projectRepository.getProjectById(projectOpt);
          if (project) return project;
        }
      } catch {
        // Ignored
      }
    }

    const guildId = interaction.guildId;
    const channelId = interaction.channelId;

    if (guildId && channelId) {
      const channelProject = this.projectRepository.getProjectForChannel(guildId, channelId);
      if (channelProject) return channelProject;
    }

    if (guildId) {
      const defaultProject = this.projectRepository.getDefaultProjectForGuild(guildId);
      if (defaultProject) return defaultProject;

      const allGuildProjects = this.projectRepository.getProjectsForGuild(guildId);
      if (allGuildProjects.length > 0 && allGuildProjects[0]) return allGuildProjects[0];
    }

    return null;
  }

  private getGitHubService(project?: ProjectRecord | null): IGitHubService {
    if (this.gitHubServiceFactory && project) {
      return this.gitHubServiceFactory.getServiceForProject(project);
    }
    return this.gitHubService;
  }

  /**
   * Determines whether command response should be strictly ephemeral
   */
  private determineEphemeralPrivacy(
    commandName: string,
    subcommand: string | null,
  ): boolean {
    if (commandName === 'account') {
      return true; // All account commands are private
    }

    if (commandName === 'project' && subcommand === 'mine') {
      return true; // Personal developer dashboard
    }

    if (
      commandName === 'issue' &&
      (subcommand === 'assign' ||
        subcommand === 'status' ||
        subcommand === 'priority' ||
        subcommand === 'block')
    ) {
      // 2-phase confirmation diff previews are ephemeral to prevent channel clutter
      return true;
    }

    return false;
  }

  /**
   * Centralized Domain Error Handler:
   * Maps domain errors to friendly embeds and clears any dangling buttons
   */
  private async handleError(interaction: Interaction, error: unknown): Promise<void> {
    const errorEmbed = buildErrorEmbed(error);

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [errorEmbed],
          components: [], // Clear any remaining buttons to prevent broken state
        });
      } else {
        await interaction.reply({
          embeds: [errorEmbed],
          ephemeral: true,
        });
      }
    } else {
      console.error('[InteractionRouter] Non-repliable interaction encountered error:', error);
    }
  }
}
