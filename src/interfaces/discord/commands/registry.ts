import { REST, Routes } from 'discord.js';
import type { Config } from '../../../config/env.js';
import { ALL_COMMAND_DEFINITIONS } from './definitions.js';

export interface CommandRegistrationConfig {
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_BOT_TOKEN: string;
}

/**
 * Registers application commands strictly to the target Discord guild.
 * Guild-scoped registration avoids Discord's 1-hour global propagation delay
 * and ensures commands are never exposed to unauthorized guilds.
 */
export async function registerGuildSlashCommands(
  config: CommandRegistrationConfig | Pick<Config, 'DISCORD_APPLICATION_ID' | 'DISCORD_GUILD_ID' | 'DISCORD_BOT_TOKEN'>,
  commandDefinitions = ALL_COMMAND_DEFINITIONS,
): Promise<{ registeredCount: number }> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN);
  const payload = commandDefinitions.map((cmd) => cmd.toJSON());

  console.log(
    `[CommandRegistry] Registering ${payload.length} guild commands to guild ${config.DISCORD_GUILD_ID}...`,
  );

  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_APPLICATION_ID, config.DISCORD_GUILD_ID),
    { body: payload },
  );

  console.log(
    `[CommandRegistry] Successfully registered ${payload.length} commands to guild ${config.DISCORD_GUILD_ID}.`,
  );

  return { registeredCount: payload.length };
}
