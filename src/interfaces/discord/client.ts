import {
  Client,
  GatewayIntentBits,
  Events,
  type ClientOptions,
} from 'discord.js';
import type { Config } from '../../config/env.js';

export interface DiscordClientDependencies {
  config: Pick<Config, 'DISCORD_BOT_TOKEN' | 'DISCORD_GUILD_ID'>;
  clientOptions?: Partial<ClientOptions>;
}

/**
 * Factory function creating a discord.js v14 Client configured strictly
 * with non-privileged intents: Guilds and GuildMessages.
 * MessageContent and Member intents are intentionally omitted for security and privacy.
 */
export function createDiscordClient(
  customOptions?: Partial<ClientOptions>,
): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
    ...customOptions,
  });
}

/**
 * Managed Discord Gateway Service handling connection lifecycle,
 * structured logging, guild allowlist verification on ready, and graceful shutdown.
 */
export class DiscordGatewayClient {
  private readonly client: Client;
  private readonly token: string;
  private readonly targetGuildId: string;
  private isConnected = false;

  constructor(deps: DiscordClientDependencies) {
    this.token = deps.config.DISCORD_BOT_TOKEN;
    this.targetGuildId = deps.config.DISCORD_GUILD_ID;
    this.client = createDiscordClient(deps.clientOptions);
    this.registerLifecycleListeners();
  }

  public get rawClient(): Client {
    return this.client;
  }

  public get ready(): boolean {
    return this.isConnected;
  }

  private registerLifecycleListeners(): void {
    this.client.on(Events.ClientReady, (readyClient) => {
      this.isConnected = true;
      const tag = readyClient.user?.tag ?? 'Unknown';
      const guildCount = readyClient.guilds.cache.size;
      const targetGuildPresent = readyClient.guilds.cache.has(this.targetGuildId);

      console.log(`[DiscordGateway] Bot logged in as ${tag} (Guilds cached: ${guildCount})`);
      if (!targetGuildPresent) {
        console.warn(
          `[DiscordGateway] WARNING: Target guild ${this.targetGuildId} is not in bot cache. Ensure bot is invited with applications.commands scope.`,
        );
      } else {
        console.log(`[DiscordGateway] Target guild ${this.targetGuildId} verified in gateway cache.`);
      }
    });

    this.client.on(Events.Error, (error) => {
      console.error('[DiscordGateway] Gateway connection error:', error.message);
    });

    this.client.on(Events.Warn, (info) => {
      console.warn('[DiscordGateway] Gateway warning:', info);
    });

    this.client.on(Events.ShardDisconnect, (_event, id) => {
      this.isConnected = false;
      console.warn(`[DiscordGateway] Shard ${id} disconnected from gateway.`);
    });

    this.client.on(Events.ShardReconnecting, (id) => {
      console.log(`[DiscordGateway] Shard ${id} reconnecting to gateway...`);
    });

    this.client.on(Events.ShardResume, (id, replayedEvents) => {
      this.isConnected = true;
      console.log(`[DiscordGateway] Shard ${id} resumed (replayed ${replayedEvents} events).`);
    });
  }

  public async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    await this.client.login(this.token);
  }

  public async destroy(): Promise<void> {
    this.isConnected = false;
    await this.client.destroy();
    console.log('[DiscordGateway] Discord client destroyed cleanly.');
  }
}
