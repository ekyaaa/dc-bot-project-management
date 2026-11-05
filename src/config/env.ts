import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigurationError } from '../domain/errors.js';

/**
 * Mapping of secret variables to file path environment variable candidates.
 * Supports both _FILE and _PATH suffixes as well as PEM-specific variations.
 */
const SECRET_FILE_CANDIDATES: Record<string, string[]> = {
  GITHUB_APP_PRIVATE_KEY: [
    'GITHUB_APP_PRIVATE_KEY_FILE',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_PRIVATE_KEY_PEM_PATH',
    'GITHUB_APP_PRIVATE_KEY_PEM_FILE',
  ],
  TOKEN_ENCRYPTION_KEY: [
    'TOKEN_ENCRYPTION_KEY_FILE',
    'TOKEN_ENCRYPTION_KEY_PATH',
  ],
  DISCORD_BOT_TOKEN: [
    'DISCORD_BOT_TOKEN_FILE',
    'DISCORD_BOT_TOKEN_PATH',
  ],
  GITHUB_APP_CLIENT_SECRET: [
    'GITHUB_APP_CLIENT_SECRET_FILE',
    'GITHUB_APP_CLIENT_SECRET_PATH',
  ],
  GITHUB_WEBHOOK_SECRET: [
    'GITHUB_WEBHOOK_SECRET_FILE',
    'GITHUB_WEBHOOK_SECRET_PATH',
  ],
};

/**
 * Inline aliases mapped to base secret variables.
 */
const INLINE_ALIASES: Record<string, string[]> = {
  GITHUB_APP_PRIVATE_KEY: ['GITHUB_APP_PRIVATE_KEY_PEM'],
};

/**
 * Resolves secret file environment variables securely before schema validation.
 * Supports both _FILE and _PATH suffixes as well as inline aliases.
 */
export function resolveSecretFileVariables(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const resolved = { ...env };

  for (const [baseVar, candidates] of Object.entries(SECRET_FILE_CANDIDATES)) {
    // 1. Resolve inline aliases if baseVar is missing or empty
    if (!resolved[baseVar] || resolved[baseVar]!.trim().length === 0) {
      const inlineAliases = INLINE_ALIASES[baseVar] ?? [];
      for (const alias of inlineAliases) {
        if (resolved[alias] && resolved[alias]!.trim().length > 0) {
          resolved[baseVar] = resolved[alias]!.trim();
          break;
        }
      }
    }

    // 2. Resolve file candidates if specified
    for (const candidateVar of candidates) {
      const filePath = resolved[candidateVar];

      if (filePath && filePath.trim().length > 0) {
        const trimmedPath = filePath.trim();
        const resolvedPath = path.isAbsolute(trimmedPath)
          ? trimmedPath
          : path.resolve(process.cwd(), trimmedPath);

        if (!fs.existsSync(resolvedPath)) {
          throw new ConfigurationError(
            `Secret file specified by ${candidateVar} does not exist: ${trimmedPath}`,
          );
        }

        try {
          const fileContent = fs.readFileSync(resolvedPath, 'utf8');
          resolved[baseVar] = fileContent.trim();
          break;
        } catch {
          throw new ConfigurationError(
            `Failed to read secret file specified by ${candidateVar}: ${trimmedPath}`,
          );
        }
      }
    }
  }

  return resolved;
}

/**
 * Zod schema for environment configuration.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  TZ: z.string().default('Asia/Jakarta'),
  PUBLIC_BASE_URL: z.string().url(),

  // Discord Credentials
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_NOTIFICATION_CHANNEL_ID: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),

  // GitHub App Credentials
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.coerce.number().int().positive(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).refine(
    (val) => val.includes('BEGIN RSA PRIVATE KEY') || val.includes('BEGIN PRIVATE KEY'),
    { message: 'GITHUB_APP_PRIVATE_KEY must contain a valid PEM private key' },
  ),

  // Target Repository & Project Binding
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_PROJECT_NUMBER: z.coerce.number().int().positive(),

  // Persistence
  DATABASE_PATH: z.string().default('/data/bot.sqlite'),

  // Crypto: 32-byte key for AES-256-GCM (64 hex characters or 32 raw bytes)
  TOKEN_ENCRYPTION_KEY: z.string().min(1).refine(
    (val) => {
      const trimmed = val.trim();
      if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) return true;
      if (Buffer.from(trimmed, 'utf8').length === 32) return true;
      return false;
    },
    { message: 'TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters or 32 raw bytes)' },
  ),

  // Scheduling & Feature Flags
  DIGEST_ENABLED: z
    .union([z.boolean(), z.string().transform((v) => v === 'true')])
    .default(false),
  DIGEST_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'DIGEST_TIME must match HH:MM format')
    .default('09:00'),
  DIGEST_TIMEZONE: z.string().default('Asia/Jakarta'),
  BOT_WRITE_ACTIONS_ENABLED: z
    .union([z.boolean(), z.string().transform((v) => v === 'true')])
    .default(false),

  // Web Admin Authentication (Optional overrides)
  ADMIN_USERNAME: z.string().default('mashupsoat'),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Loads and validates configuration fail-fast with strict secrets hygiene.
 * NEVER prints secret values in error messages.
 */
export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  const resolvedEnv = resolveSecretFileVariables(rawEnv);
  if (resolvedEnv.DIGEST_ENABLED === undefined && resolvedEnv.SCHEDULED_DIGEST_ENABLED !== undefined) {
    resolvedEnv.DIGEST_ENABLED = resolvedEnv.SCHEDULED_DIGEST_ENABLED;
  }
  const result = EnvSchema.safeParse(resolvedEnv);

  if (!result.success) {
    // Extract unique variable paths without leaking received values
    const invalidFields = Array.from(
      new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ).filter(Boolean);

    throw new ConfigurationError(
      `Configuration validation failed. Missing or invalid variables: [${invalidFields.join(', ')}]`,
      { invalidFields },
    );
  }

  return result.data;
}

/**
 * Returns a sanitized copy of configuration safe for logging.
 */
export function getRedactedConfig(config: Config): Record<string, unknown> {
  return {
    ...config,
    DISCORD_BOT_TOKEN: '[REDACTED]',
    GITHUB_APP_CLIENT_SECRET: '[REDACTED]',
    GITHUB_WEBHOOK_SECRET: '[REDACTED]',
    GITHUB_APP_PRIVATE_KEY: '[REDACTED]',
    TOKEN_ENCRYPTION_KEY: '[REDACTED]',
  };
}
