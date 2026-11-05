import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/env.js';
import { createDatabase } from './infrastructure/persistence/database.js';
import { runMigrations } from './infrastructure/persistence/migrator.js';
import {
  IdentityRepository,
  OAuthStateRepository,
  OutboxRepository,
  AuditRepository,
  ScheduleRepository,
  ProjectRepository,
} from './infrastructure/persistence/repositories/index.js';
import { CryptoService } from './infrastructure/crypto/crypto.js';
import { AuditService } from './application/services/AuditService.js';
import { AuthorizationService } from './application/services/AuthorizationService.js';
import { NotificationService } from './application/services/NotificationService.js';
import { GitHubAppAuth } from './infrastructure/github/GitHubAppAuth.js';
import { GitHubService } from './infrastructure/github/GitHubService.js';
import { GitHubServiceFactory } from './infrastructure/github/GitHubServiceFactory.js';
import { GitHubOAuthClient } from './infrastructure/github/GitHubOAuthClient.js';
import { DiscordGatewayClient } from './interfaces/discord/client.js';
import { DiscordNotificationSender } from './interfaces/discord/notificationSender.js';
import { InteractionRouter } from './interfaces/discord/interactionRouter.js';
import { registerGuildSlashCommands } from './interfaces/discord/commands/registry.js';
import {
  InitiateAccountLinkUseCase,
  GetAccountStatusUseCase,
  DisconnectAccountUseCase,
  HandleOAuthCallbackUseCase,
  DispatchDailyDigestUseCase,
} from './application/usecases/index.js';
import { DigestScheduler } from './infrastructure/scheduling/DigestScheduler.js';
import { createHttpServer } from './infrastructure/http/server.js';

export async function bootstrap() {
  console.log('[Main] Loading configuration...');
  const config = loadConfig();

  console.log(`[Main] Initializing database at ${config.DATABASE_PATH}...`);
  const dbManager = createDatabase({ databasePath: config.DATABASE_PATH });

  console.log('[Main] Running database migrations...');
  runMigrations(dbManager.db);

  // Persistence Repositories
  const identityRepo = new IdentityRepository(dbManager.db);
  const oauthStateRepo = new OAuthStateRepository(dbManager.db);
  const outboxRepo = new OutboxRepository(dbManager.db);
  const auditRepo = new AuditRepository(dbManager.db);
  const scheduleRepo = new ScheduleRepository(dbManager.db);
  const projectRepo = new ProjectRepository(dbManager.db);

  // Security & Crypto Services
  const cryptoService = new CryptoService(config.TOKEN_ENCRYPTION_KEY);
  const auditService = new AuditService(auditRepo);

  // GitHub Adapters
  const gitHubAuth = new GitHubAppAuth(config);
  const gitHubService = new GitHubService({
    config,
    gitHubAppAuth: gitHubAuth,
  });
  const gitHubServiceFactory = new GitHubServiceFactory({
    gitHubAppAuth: gitHubAuth,
    defaultService: gitHubService,
  });
  const gitHubOAuthClient = new GitHubOAuthClient();

  // Authorization Policy Service
  const authService = new AuthorizationService(identityRepo, gitHubService, config, projectRepo);

  // Discord Gateway & Notification Sender
  const discordGateway = new DiscordGatewayClient({ config });
  const discordSender = new DiscordNotificationSender(discordGateway.rawClient, config, projectRepo);

  // Use Cases
  const initiateAccountLinkUseCase = new InitiateAccountLinkUseCase(
    oauthStateRepo,
    cryptoService,
    config,
    projectRepo,
  );
  const getAccountStatusUseCase = new GetAccountStatusUseCase(identityRepo, config, projectRepo);
  const disconnectAccountUseCase = new DisconnectAccountUseCase(identityRepo, auditRepo, config, projectRepo);
  const handleOAuthCallbackUseCase = new HandleOAuthCallbackUseCase(
    oauthStateRepo,
    identityRepo,
    auditRepo,
    cryptoService,
    gitHubOAuthClient,
    config,
  );

  const dispatchDailyDigestUseCase = new DispatchDailyDigestUseCase(
    gitHubService,
    scheduleRepo,
    discordSender,
    config,
    projectRepo,
    gitHubServiceFactory,
  );

  // Discord Interaction Router
  const interactionRouter = new InteractionRouter({
    config,
    gitHubService,
    gitHubServiceFactory,
    authService,
    auditService,
    projectRepository: projectRepo,
    accountUseCases: {
      initiateAccountLinkUseCase,
      getAccountStatusUseCase,
      disconnectAccountUseCase,
    },
  });

  discordGateway.rawClient.on('interactionCreate', (interaction) => {
    interactionRouter.handleInteraction(interaction).catch((err) => {
      console.error('[Main] Unhandled interaction error:', err);
    });
  });

  // Daily Digest Scheduler
  const digestScheduler = new DigestScheduler({
    config,
    dispatchUseCase: dispatchDailyDigestUseCase,
  });
  digestScheduler.start();

  // Webhook Notification Service (Outbox Worker)
  const notificationService = new NotificationService(
    outboxRepo,
    identityRepo,
    discordSender,
    config,
    {},
    dispatchDailyDigestUseCase,
    projectRepo,
  );
  notificationService.startWorker();

  // Fastify HTTP Server
  const httpServer = await createHttpServer({
    port: config.PORT,
    database: dbManager,
    cryptoService,
    authRouteOptions: {
      handleOAuthCallbackUseCase,
    },
    adminRouteOptions: {
      config,
      projectRepository: projectRepo,
    },
    webhookRouteOptions: {
      cryptoService,
      webhookSecret: config.GITHUB_WEBHOOK_SECRET,
      outboxRepository: outboxRepo,
      onDeliveryEnqueued: () => {
        notificationService.processOutboxBatch().catch((err) => {
          console.error('[Main] Error pulsing outbox batch:', err);
        });
      },
    },
  });

  await httpServer.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[Main] HTTP Server listening on port ${config.PORT}`);

  // Connect to Discord Gateway
  await discordGateway.start();
  console.log('[Main] Discord Gateway client logged in successfully.');

  // Register Guild Slash Commands for all permitted guilds
  const permittedGuilds = Array.from(
    new Set([
      config.DISCORD_GUILD_ID,
      ...projectRepo.getAllGuildPermissions().map((p) => p.guild_id),
    ]),
  );

  for (const guildId of permittedGuilds) {
    try {
      const { registeredCount } = await registerGuildSlashCommands({
        DISCORD_APPLICATION_ID: config.DISCORD_APPLICATION_ID,
        DISCORD_GUILD_ID: guildId,
        DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN,
      });
      console.log(`[Main] Successfully registered ${registeredCount} slash commands to guild ${guildId}.`);
    } catch (err) {
      console.error(`[Main] Failed to register slash commands to guild ${guildId}:`, err);
    }
  }

  // Graceful Shutdown Registration
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Main] Received ${signal}. Initiating graceful shutdown...`);

    digestScheduler.stop();
    notificationService.stopWorker();

    try {
      await httpServer.close();
      console.log('[Main] HTTP Server closed.');
    } catch (err) {
      console.error('[Main] Error closing HTTP server:', err);
    }

    try {
      await discordGateway.destroy();
    } catch (err) {
      console.error('[Main] Error destroying Discord gateway:', err);
    }

    try {
      dbManager.close();
      console.log('[Main] Database connection closed.');
    } catch (err) {
      console.error('[Main] Error closing database:', err);
    }

    console.log('[Main] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    config,
    dbManager,
    httpServer,
    discordGateway,
    digestScheduler,
    notificationService,
  };
}

// Auto-run if executed directly
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap().catch((error) => {
    console.error('[Main] Fatal bootstrap failure:', error);
    process.exit(1);
  });
}
