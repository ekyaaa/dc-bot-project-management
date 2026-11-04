import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, getRedactedConfig } from '../../src/config/env.js';
import { ConfigurationError } from '../../src/domain/errors.js';

describe('Config Layer: Environment Validation & Secrets Hygiene', () => {
  let tempDir: string;

  const validKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validPemKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----';

  const baseValidEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '8080',
    TZ: 'Asia/Jakarta',
    PUBLIC_BASE_URL: 'https://bot.example.com',
    DISCORD_APPLICATION_ID: '123456789',
    DISCORD_GUILD_ID: '987654321',
    DISCORD_NOTIFICATION_CHANNEL_ID: '111222333',
    DISCORD_BOT_TOKEN: 'discord-super-secret-token-12345',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_CLIENT_ID: 'Iv1.testclientid',
    GITHUB_APP_CLIENT_SECRET: 'github-super-secret-client-secret-abc',
    GITHUB_APP_INSTALLATION_ID: '654321',
    GITHUB_WEBHOOK_SECRET: 'github-super-secret-webhook-secret-xyz',
    GITHUB_APP_PRIVATE_KEY: validPemKey,
    GITHUB_OWNER: 'test-org',
    GITHUB_REPOSITORY: 'test-repo',
    GITHUB_PROJECT_NUMBER: '42',
    DATABASE_PATH: ':memory:',
    TOKEN_ENCRYPTION_KEY: validKeyHex,
    DIGEST_ENABLED: 'true',
    DIGEST_TIME: '09:00',
    DIGEST_TIMEZONE: 'Asia/Jakarta',
    BOT_WRITE_ACTIONS_ENABLED: 'false',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads valid configuration successfully', () => {
    const config = loadConfig(baseValidEnv);
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(8080);
    expect(config.GITHUB_PROJECT_NUMBER).toBe(42);
    expect(config.DIGEST_ENABLED).toBe(true);
    expect(config.BOT_WRITE_ACTIONS_ENABLED).toBe(false);
  });

  it('resolves secret variables via _FILE suffix', () => {
    const pemFile = path.join(tempDir, 'github_private_key.pem');
    const tokenKeyFile = path.join(tempDir, 'token_encryption_key.txt');

    fs.writeFileSync(pemFile, validPemKey, 'utf8');
    fs.writeFileSync(tokenKeyFile, validKeyHex, 'utf8');

    const envWithFiles = {
      ...baseValidEnv,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_FILE: pemFile,
      TOKEN_ENCRYPTION_KEY: undefined,
      TOKEN_ENCRYPTION_KEY_FILE: tokenKeyFile,
    };

    const config = loadConfig(envWithFiles);
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(validPemKey);
    expect(config.TOKEN_ENCRYPTION_KEY).toBe(validKeyHex);
  });

  it('resolves secret variables via _PATH suffix and aliases (e.g. GITHUB_APP_PRIVATE_KEY_PEM_PATH)', () => {
    const pemFile = path.join(tempDir, 'github_private_key_pem.pem');
    const tokenKeyFile = path.join(tempDir, 'token_encryption_key_path.txt');

    fs.writeFileSync(pemFile, validPemKey, 'utf8');
    fs.writeFileSync(tokenKeyFile, validKeyHex, 'utf8');

    const envWithPaths = {
      ...baseValidEnv,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PEM_PATH: pemFile,
      TOKEN_ENCRYPTION_KEY: undefined,
      TOKEN_ENCRYPTION_KEY_PATH: tokenKeyFile,
    };

    const config = loadConfig(envWithPaths);
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(validPemKey);
    expect(config.TOKEN_ENCRYPTION_KEY).toBe(validKeyHex);
  });

  it('resolves inline alias GITHUB_APP_PRIVATE_KEY_PEM when GITHUB_APP_PRIVATE_KEY is omitted', () => {
    const envWithAlias = {
      ...baseValidEnv,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PEM: validPemKey,
    };

    const config = loadConfig(envWithAlias);
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(validPemKey);
  });

  it('throws ConfigurationError when _FILE points to a non-existent file', () => {
    const nonExistentFile = path.join(tempDir, 'missing_file.key');
    const envWithMissingFile = {
      ...baseValidEnv,
      TOKEN_ENCRYPTION_KEY: undefined,
      TOKEN_ENCRYPTION_KEY_FILE: nonExistentFile,
    };

    expect(() => loadConfig(envWithMissingFile)).toThrow(ConfigurationError);
    expect(() => loadConfig(envWithMissingFile)).toThrow(/does not exist/);
  });

  it('throws ConfigurationError when _PATH points to a non-existent file', () => {
    const nonExistentFile = path.join(tempDir, 'missing_file_path.key');
    const envWithMissingPath = {
      ...baseValidEnv,
      TOKEN_ENCRYPTION_KEY: undefined,
      TOKEN_ENCRYPTION_KEY_PATH: nonExistentFile,
    };

    expect(() => loadConfig(envWithMissingPath)).toThrow(ConfigurationError);
    expect(() => loadConfig(envWithMissingPath)).toThrow(/does not exist/);
  });

  it('fails fast on missing required variables without leaking provided secret values', () => {
    const invalidEnv = {
      ...baseValidEnv,
      DISCORD_BOT_TOKEN: undefined,
      GITHUB_APP_ID: undefined,
    };

    try {
      loadConfig(invalidEnv);
      expect.fail('Should have thrown ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const err = error as ConfigurationError;

      // Error message must report only variable names
      expect(err.message).toContain('DISCORD_BOT_TOKEN');
      expect(err.message).toContain('GITHUB_APP_ID');

      // Crucial: Secret values must never leak in error message
      expect(err.message).not.toContain('github-super-secret-client-secret-abc');
      expect(err.message).not.toContain('github-super-secret-webhook-secret-xyz');
      expect(err.message).not.toContain(validKeyHex);
    }
  });

  it('validates 32-byte encryption key (64 hex characters or 32 raw bytes) and rejects invalid keys', () => {
    // 64 hex characters: valid
    expect(() =>
      loadConfig({ ...baseValidEnv, TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) }),
    ).not.toThrow();

    // 32 raw characters: valid
    expect(() =>
      loadConfig({ ...baseValidEnv, TOKEN_ENCRYPTION_KEY: '12345678901234567890123456789012' }),
    ).not.toThrow();

    // 16 characters: invalid
    expect(() =>
      loadConfig({ ...baseValidEnv, TOKEN_ENCRYPTION_KEY: 'too-short-key' }),
    ).toThrow(ConfigurationError);

    // 64 non-hex characters: invalid
    expect(() =>
      loadConfig({ ...baseValidEnv, TOKEN_ENCRYPTION_KEY: 'z'.repeat(64) }),
    ).toThrow(ConfigurationError);
  });

  it('rejects invalid ports', () => {
    expect(() => loadConfig({ ...baseValidEnv, PORT: '0' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...baseValidEnv, PORT: '70000' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...baseValidEnv, PORT: 'invalid-port' })).toThrow(ConfigurationError);
  });

  it('redacts sensitive credentials cleanly in getRedactedConfig', () => {
    const config = loadConfig(baseValidEnv);
    const redacted = getRedactedConfig(config);

    expect(redacted['DISCORD_BOT_TOKEN']).toBe('[REDACTED]');
    expect(redacted['GITHUB_APP_CLIENT_SECRET']).toBe('[REDACTED]');
    expect(redacted['GITHUB_WEBHOOK_SECRET']).toBe('[REDACTED]');
    expect(redacted['GITHUB_APP_PRIVATE_KEY']).toBe('[REDACTED]');
    expect(redacted['TOKEN_ENCRYPTION_KEY']).toBe('[REDACTED]');

    // Non-secret values remain intact
    expect(redacted['NODE_ENV']).toBe('test');
    expect(redacted['PORT']).toBe(8080);
    expect(redacted['PUBLIC_BASE_URL']).toBe('https://bot.example.com');
  });
});
