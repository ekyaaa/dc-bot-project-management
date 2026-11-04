import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { CryptoService, CryptoError } from '../../src/infrastructure/crypto/crypto.js';
import {
  OAuthStateRepository,
  IdentityRepository,
  AuditRepository,
} from '../../src/infrastructure/persistence/repositories/index.js';
import { GitHubOAuthClient } from '../../src/infrastructure/github/GitHubOAuthClient.js';
import { MockGitHubOAuthClient } from '../mocks/MockGitHubOAuthClient.js';
import {
  InitiateAccountLinkUseCase,
  HandleOAuthCallbackUseCase,
} from '../../src/application/usecases/index.js';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import {
  ValidationError,
  ExternalApiError,
} from '../../src/domain/errors.js';

describe('Adversarial Verification: OAuth PKCE, State Replay, CSRF & Token Security', () => {
  let db: DatabaseInstance;
  let oauthRepo: OAuthStateRepository;
  let identityRepo: IdentityRepository;
  let auditRepo: AuditRepository;
  let cryptoService: CryptoService;

  const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const testConfig = {
    DISCORD_GUILD_ID: 'guild_123456789',
    GITHUB_APP_CLIENT_ID: 'Iv1.test_client_id',
    GITHUB_APP_CLIENT_SECRET: 'test_client_secret_xyz',
    PUBLIC_BASE_URL: 'https://bot.example.com',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();

    oauthRepo = new OAuthStateRepository(db);
    identityRepo = new IdentityRepository(db);
    auditRepo = new AuditRepository(db);
    cryptoService = new CryptoService(encryptionKey);
  });

  afterEach(() => {
    if (db.open) db.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. REPLAY ATTACKS & CONCURRENCY RACE CONDITIONS
  // =========================================================================
  describe('1. Replay Attacks & Concurrency Race Conditions', () => {
    it('Concurrent requests with same state nonce: exactly 1 succeeds, all others fail', async () => {
      const mockOAuthClient = new MockGitHubOAuthClient();
      const useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(
        stateNonce,
        'victim_user_1',
        testConfig.DISCORD_GUILD_ID,
        'verifier_race',
        600,
      );

      // Launch 50 concurrent requests simultaneously
      const concurrency = 50;
      const promises = Array.from({ length: concurrency }).map(() =>
        useCase.execute({
          code: 'valid_code',
          state: stateNonce,
        }).then(
          (res) => ({ status: 'fulfilled' as const, value: res }),
          (err) => ({ status: 'rejected' as const, reason: err }),
        ),
      );

      const results = await Promise.all(promises);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(concurrency - 1);

      // All rejections must be ValidationError
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(ValidationError);
        expect((rej.reason as Error).message).toContain('invalid, has expired, or has already been used');
      }

      // Verify DB identity state: exactly 1 row
      const row = db.prepare('SELECT COUNT(*) as count FROM identity_links').get() as { count: number };
      expect(row.count).toBe(1);

      // Verify audit logs: exactly 1 SUCCESS, (concurrency - 1) REJECTED
      const auditRows = db.prepare('SELECT outcome, COUNT(*) as count FROM audit_logs GROUP BY outcome').all() as { outcome: string; count: number }[];
      const successAudit = auditRows.find((r) => r.outcome === 'SUCCESS');
      const rejectedAudit = auditRows.find((r) => r.outcome === 'REJECTED');

      expect(successAudit?.count).toBe(1);
      expect(rejectedAudit?.count).toBe(concurrency - 1);
    });

    it('Immediate sequential replay attack is rejected on second invocation', async () => {
      const mockOAuthClient = new MockGitHubOAuthClient();
      const useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(
        stateNonce,
        'user_replay_seq',
        testConfig.DISCORD_GUILD_ID,
        'verifier_seq',
        600,
      );

      // 1st consumption succeeds
      const firstResult = await useCase.execute({ code: 'code1', state: stateNonce });
      expect(firstResult.discordUserId).toBe('user_replay_seq');

      // 2nd consumption must fail
      await expect(
        useCase.execute({ code: 'code1', state: stateNonce }),
      ).rejects.toThrow(ValidationError);

      // 3rd consumption must also fail
      await expect(
        useCase.execute({ code: 'code1', state: stateNonce }),
      ).rejects.toThrow(ValidationError);
    });

    it('Cross-user CSRF attack: attacker cannot link victim authorization code to attacker Discord ID', async () => {
      const mockOAuthClient = new MockGitHubOAuthClient();
      const useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );

      // Victim initiates OAuth
      const victimState = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(
        victimState,
        'victim_discord_id',
        testConfig.DISCORD_GUILD_ID,
        'victim_verifier',
        600,
      );

      // Attacker intercepts callback and executes it
      const result = await useCase.execute({
        code: 'intercepted_code',
        state: victimState,
      });

      // The linked Discord ID MUST be the victim's, never the attacker's
      expect(result.discordUserId).toBe('victim_discord_id');

      const linkedIdentity = await identityRepo.findByDiscordId('victim_discord_id');
      expect(linkedIdentity).not.toBeNull();

      const attackerIdentity = await identityRepo.findByDiscordId('attacker_discord_id');
      expect(attackerIdentity).toBeNull();
    });
  });

  // =========================================================================
  // 2. STATE EXPIRATION ENFORCEMENT
  // =========================================================================
  describe('2. State Expiration Enforcement', () => {
    it('Expired state nonce cannot be consumed (expired via SQL datetime)', async () => {
      const mockOAuthClient = new MockGitHubOAuthClient();
      const useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );

      const stateNonce = cryptoService.generateSecureNonce(32);

      // Directly insert an already-expired state (expired 10 seconds ago)
      db.prepare(`
        INSERT INTO oauth_states (
          state_nonce, discord_user_id, guild_id, code_verifier, consumed, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 0, datetime('now', '-10 seconds'), CURRENT_TIMESTAMP);
      `).run(stateNonce, 'expired_user', testConfig.DISCORD_GUILD_ID, 'verifier_exp');

      await expect(
        useCase.execute({ code: 'code_exp', state: stateNonce }),
      ).rejects.toThrow(ValidationError);

      // Ensure consumed flag was not even set because it was never returned as active
      const stateRow = db.prepare('SELECT consumed FROM oauth_states WHERE state_nonce = ?').get(stateNonce) as { consumed: number };
      expect(stateRow.consumed).toBe(0);
    });

    it('Negative TTL in createSession creates an instantly expired state that cannot be consumed', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(
        stateNonce,
        'user_neg_ttl',
        testConfig.DISCORD_GUILD_ID,
        'neg_verifier',
        -10, // -10 seconds TTL
      );

      const session = await oauthRepo.consumeSession(stateNonce);
      expect(session).toBeNull();
    });

    it('purgeExpired removes expired nonces while preserving unexpired unconsumed sessions', async () => {
      const expiredNonce = cryptoService.generateSecureNonce(32);
      const activeNonce = cryptoService.generateSecureNonce(32);

      // Insert expired session
      db.prepare(`
        INSERT INTO oauth_states (
          state_nonce, discord_user_id, guild_id, code_verifier, consumed, expires_at, created_at
        ) VALUES (?, 'u1', 'g1', 'v1', 0, datetime('now', '-60 seconds'), CURRENT_TIMESTAMP);
      `).run(expiredNonce);

      // Insert active session
      await oauthRepo.createSession(activeNonce, 'u2', 'g1', 'v2', 600);

      const purgedCount = await oauthRepo.purgeExpired();
      expect(purgedCount).toBe(1);

      // Verify active nonce is still intact and consumable
      const activeSession = await oauthRepo.consumeSession(activeNonce);
      expect(activeSession).not.toBeNull();
      expect(activeSession?.state).toBe(activeNonce);

      // Verify expired nonce is deleted from DB
      const expiredRow = db.prepare('SELECT * FROM oauth_states WHERE state_nonce = ?').get(expiredNonce);
      expect(expiredRow).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. INVALID & TAMPERED STATE NONCES
  // =========================================================================
  describe('3. Invalid & Tampered State Nonce Attack Surface', () => {
    let mockOAuthClient: MockGitHubOAuthClient;
    let useCase: HandleOAuthCallbackUseCase;

    beforeEach(() => {
      mockOAuthClient = new MockGitHubOAuthClient();
      useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );
    });

    it.each([
      ["SQL Injection: ' OR '1'='1", "' OR '1'='1"],
      ["SQL Injection: '; DROP TABLE oauth_states; --", "'; DROP TABLE oauth_states; --"],
      ["SQL Injection: UNION SELECT", "' UNION SELECT * FROM identity_links --"],
      ["Null Byte Injection", "valid_nonce\x00extra_payload"],
      ["Whitespace only", "   "],
      ["Non-hex characters", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
      ["Unicode emojis", "🔥✨💀👑🚀💎🎉"],
      ["Extremely long string (10k chars)", "a".repeat(10000)],
      ["Truncated nonce", "abc123"],
    ])('Rejects adversarial state input: %s', async (_desc, maliciousState) => {
      await expect(
        useCase.execute({
          code: 'some_code',
          state: maliciousState,
        }),
      ).rejects.toThrow(ValidationError);

      // Confirm DB table wasn't dropped or damaged
      const checkTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_states'").get();
      expect(checkTable).toBeDefined();
    });

    it('Flipping a single bit or character in valid state nonce causes rejection', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'user_bitflip', testConfig.DISCORD_GUILD_ID, 'v', 600);

      // Flip the last character
      const lastChar = stateNonce[stateNonce.length - 1];
      const flippedChar = lastChar === 'a' ? 'b' : 'a';
      const tamperedNonce = stateNonce.slice(0, -1) + flippedChar;

      await expect(
        useCase.execute({ code: 'valid_code', state: tamperedNonce }),
      ).rejects.toThrow(ValidationError);

      // Original unconsumed nonce should still be intact and consumable once
      const session = await oauthRepo.consumeSession(stateNonce);
      expect(session).not.toBeNull();
    });
  });

  // =========================================================================
  // 4. CODE EXCHANGE FAILURES & UNEXPECTED PAYLOADS
  // =========================================================================
  describe('4. Code Exchange Failures & Malformed Payloads', () => {
    it('GitHubOAuthClient: rejects non-JSON / HTML response from token endpoint', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.exchangeCodeForToken({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'bad_json_code',
          redirectUri: 'https://bot.example.com/callback',
        }),
      ).rejects.toThrow(SyntaxError);
    });

    it('GitHubOAuthClient: rejects token payload with missing access_token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ token_type: 'bearer', scope: 'read:user' }),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.exchangeCodeForToken({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'missing_token_code',
          redirectUri: 'https://bot.example.com/callback',
        }),
      ).rejects.toThrow(ExternalApiError);
    });

    it('GitHubOAuthClient: rejects token payload with numeric access_token (wrong type)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ access_token: 12345 }),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.exchangeCodeForToken({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'numeric_token_code',
          redirectUri: 'https://bot.example.com/callback',
        }),
      ).rejects.toThrow(ExternalApiError);
    });

    it('GitHubOAuthClient: rejects user profile with string ID instead of numeric ID', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: '12345', login: 'octodev' }),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.fetchUserProfile('token_xyz'),
      ).rejects.toThrow(ExternalApiError);
    });

    it('GitHubOAuthClient: rejects user profile with missing login', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: 12345, name: 'Anonymous' }),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.fetchUserProfile('token_xyz'),
      ).rejects.toThrow(ExternalApiError);
    });

    it('OAuth code exchange failure: state is marked consumed and no half-linked identity is created', async () => {
      const mockOAuthClient = new MockGitHubOAuthClient();
      vi.spyOn(mockOAuthClient, 'exchangeCodeForToken').mockRejectedValue(
        new ExternalApiError('GitHub token endpoint timeout', 504),
      );

      const useCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'user_fail_atomic', testConfig.DISCORD_GUILD_ID, 'v', 600);

      await expect(
        useCase.execute({ code: 'some_code', state: stateNonce }),
      ).rejects.toThrow(ExternalApiError);

      // State MUST be consumed to prevent replay brute-force
      const stateRow = db.prepare('SELECT consumed FROM oauth_states WHERE state_nonce = ?').get(stateNonce) as { consumed: number };
      expect(stateRow.consumed).toBe(1);

      // No identity row created
      const identity = await identityRepo.findByDiscordId('user_fail_atomic');
      expect(identity).toBeNull();
    });
  });

  // =========================================================================
  // 5. TOKEN ENCRYPTION AT REST (AES-256-GCM) & TAMPER RESISTANCE
  // =========================================================================
  describe('5. Token Encryption at Rest & Tamper Resistance', () => {
    it('Stored token in SQLite is strictly encrypted and plaintext is never stored', async () => {
      const secretToken = 'ghu_super_secret_oauth_token_production_value_987654321';
      const encrypted = cryptoService.encryptToken(secretToken);

      await identityRepo.linkIdentity('user_vault', 778899, 'vault_user', encrypted);

      // Read raw DB row
      const rawRow = db.prepare('SELECT * FROM identity_links WHERE discord_user_id = ?').get('user_vault') as any;

      expect(rawRow.encrypted_token).toBeDefined();
      expect(rawRow.encrypted_token).not.toContain(secretToken);

      // Search entire database for plaintext token
      const tableDump = JSON.stringify(db.prepare('SELECT * FROM identity_links').all());
      expect(tableDump).not.toContain(secretToken);

      // Verify JSON payload format
      const parsed = JSON.parse(rawRow.encrypted_token);
      expect(parsed.ivHex).toMatch(/^[0-9a-fA-F]{24}$/);
      expect(parsed.authTagHex).toMatch(/^[0-9a-fA-F]{32}$/);
      expect(parsed.ciphertextHex).toMatch(/^[0-9a-fA-F]+$/);
    });

    it('Ciphertext tampering: altering 1 hex char fails authentication tag check', () => {
      const payload = cryptoService.encryptToken('test_token_abc');
      const tamperedCiphertext =
        payload.ciphertextHex.slice(0, -1) +
        (payload.ciphertextHex.endsWith('0') ? '1' : '0');

      expect(() => {
        cryptoService.decryptToken(payload.ivHex, payload.authTagHex, tamperedCiphertext);
      }).toThrow(CryptoError);
    });

    it('Auth tag tampering: altering 1 hex char fails authentication', () => {
      const payload = cryptoService.encryptToken('test_token_abc');
      const tamperedTag =
        payload.authTagHex.slice(0, -1) +
        (payload.authTagHex.endsWith('0') ? '1' : '0');

      expect(() => {
        cryptoService.decryptToken(payload.ivHex, tamperedTag, payload.ciphertextHex);
      }).toThrow(CryptoError);
    });

    it('IV tampering: altering 1 hex char fails authentication tag check', () => {
      const payload = cryptoService.encryptToken('test_token_abc');
      const tamperedIv =
        payload.ivHex.slice(0, -1) +
        (payload.ivHex.endsWith('0') ? '1' : '0');

      expect(() => {
        cryptoService.decryptToken(tamperedIv, payload.authTagHex, payload.ciphertextHex);
      }).toThrow(CryptoError);
    });

    it('Decryption with a different 256-bit key fails', () => {
      const payload = cryptoService.encryptToken('test_token_abc');
      const differentKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const foreignCryptoService = new CryptoService(differentKey);

      expect(() => {
        foreignCryptoService.decryptToken(payload.ivHex, payload.authTagHex, payload.ciphertextHex);
      }).toThrow(CryptoError);
    });

    it('Encrypting the same token twice produces distinct IVs and ciphertexts', () => {
      const token = 'ghu_identical_input_token';
      const enc1 = cryptoService.encryptToken(token);
      const enc2 = cryptoService.encryptToken(token);

      expect(enc1.ivHex).not.toBe(enc2.ivHex);
      expect(enc1.ciphertextHex).not.toBe(enc2.ciphertextHex);
      expect(enc1.authTagHex).not.toBe(enc2.authTagHex);

      expect(cryptoService.decryptToken(enc1.ivHex, enc1.authTagHex, enc1.ciphertextHex)).toBe(token);
      expect(cryptoService.decryptToken(enc2.ivHex, enc2.authTagHex, enc2.ciphertextHex)).toBe(token);
    });
  });

  // =========================================================================
  // 6. SECURITY HEADERS & XSS DEFENSES ACROSS ALL ENDPOINTS
  // =========================================================================
  describe('6. Security Headers & XSS Defenses', () => {
    let mockOAuthClient: MockGitHubOAuthClient;
    let handleUseCase: HandleOAuthCallbackUseCase;

    beforeEach(() => {
      mockOAuthClient = new MockGitHubOAuthClient();
      handleUseCase = new HandleOAuthCallbackUseCase(
        oauthRepo,
        identityRepo,
        auditRepo,
        cryptoService,
        mockOAuthClient,
        testConfig,
      );
    });

    const assertSecurityHeaders = (headers: Record<string, any>) => {
      expect(headers['content-type']).toContain('text/html; charset=utf-8');
      expect(headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none';",
      );
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['x-content-type-options']).toBe('nosniff');
    };

    it('200 Success response has all strict security headers', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'user_h1', testConfig.DISCORD_GUILD_ID, 'v1', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });

      expect(res.statusCode).toBe(200);
      assertSecurityHeaders(res.headers);
      await server.close();
    });

    it('400 User Cancelled response has all strict security headers', async () => {
      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const res = await server.inject({
        method: 'GET',
        url: '/auth/github/callback?error=access_denied&error_description=Cancelled+by+user',
      });

      expect(res.statusCode).toBe(400);
      assertSecurityHeaders(res.headers);
      await server.close();
    });

    it('400 Invalid/Missing params response has all strict security headers', async () => {
      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const res = await server.inject({
        method: 'GET',
        url: '/auth/github/callback',
      });

      expect(res.statusCode).toBe(400);
      assertSecurityHeaders(res.headers);
      await server.close();
    });

    it('502 GitHub API Outage response has all strict security headers', async () => {
      vi.spyOn(mockOAuthClient, 'exchangeCodeForToken').mockRejectedValue(
        new ExternalApiError('GitHub Down', 502),
      );

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'user_h2', testConfig.DISCORD_GUILD_ID, 'v2', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=any&state=${stateNonce}`,
      });

      expect(res.statusCode).toBe(502);
      assertSecurityHeaders(res.headers);
      await server.close();
    });

    it('XSS Injection in error_description is strictly escaped in HTML response', async () => {
      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const xssPayload = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';
      const res = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?error=access_denied&error_description=${encodeURIComponent(xssPayload)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain('<script>');
      expect(res.payload).not.toContain('<img src=x');
      expect(res.payload).toContain('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
      await server.close();
    });

    it('XSS Injection in user profile login is strictly escaped in success HTML', async () => {
      mockOAuthClient.defaultUserProfile = {
        id: 99999,
        login: 'attacker<script>alert(1)</script>',
        avatarUrl: 'https://avatars.githubusercontent.com/u/99999"><script>alert(2)</script>',
      };

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'user_xss', testConfig.DISCORD_GUILD_ID, 'vx', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const res = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.payload).not.toContain('<script>alert(1)</script>');
      expect(res.payload).not.toContain('<script>alert(2)</script>');
      expect(res.payload).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      await server.close();
    });
  });
});
