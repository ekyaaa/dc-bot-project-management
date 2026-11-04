import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { CryptoService } from '../../src/infrastructure/crypto/crypto.js';
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
  GetAccountStatusUseCase,
  DisconnectAccountUseCase,
} from '../../src/application/usecases/index.js';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import {
  UnauthorizedError,
  ValidationError,
  ExternalApiError,
} from '../../src/domain/errors.js';

describe('OAuth 2.0 PKCE & Account Linking', () => {
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

  describe('GitHubOAuthClient', () => {
    it('exchangeCodeForToken: sends POST and returns parsed token result', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'ghu_access_token_12345',
            token_type: 'bearer',
            scope: 'read:user',
            expires_in: 28800,
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new GitHubOAuthClient();
      const result = await client.exchangeCodeForToken({
        clientId: 'cid',
        clientSecret: 'csec',
        code: 'code123',
        redirectUri: 'https://bot.example.com/callback',
        codeVerifier: 'verifier123',
      });

      expect(result.accessToken).toBe('ghu_access_token_12345');
      expect(result.tokenType).toBe('bearer');
      expect(result.expiresIn).toBe(28800);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('exchangeCodeForToken: throws ValidationError on error_description in body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              error: 'bad_verification_code',
              error_description: 'The code passed is incorrect or expired.',
            }),
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.exchangeCodeForToken({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'bad_code',
          redirectUri: 'https://bot.example.com/callback',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('exchangeCodeForToken: throws ExternalApiError on HTTP failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      const client = new GitHubOAuthClient();
      await expect(
        client.exchangeCodeForToken({
          clientId: 'cid',
          clientSecret: 'csec',
          code: 'code123',
          redirectUri: 'https://bot.example.com/callback',
        }),
      ).rejects.toThrow(ExternalApiError);
    });

    it('fetchUserProfile: retrieves verified user profile', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 112233,
              login: 'octodev',
              name: 'Octo Developer',
              avatar_url: 'https://avatars.githubusercontent.com/u/112233',
              email: 'octo@example.com',
            }),
        }),
      );

      const client = new GitHubOAuthClient();
      const profile = await client.fetchUserProfile('token123');
      expect(profile.id).toBe(112233);
      expect(profile.login).toBe('octodev');
      expect(profile.name).toBe('Octo Developer');
    });
  });

  describe('InitiateAccountLinkUseCase', () => {
    it('creates state nonce and PKCE pair in SQLite and returns authorization URL', async () => {
      const useCase = new InitiateAccountLinkUseCase(oauthRepo, cryptoService, testConfig);

      const result = await useCase.execute({
        discordUserId: 'discord_user_1',
        guildId: testConfig.DISCORD_GUILD_ID,
      });

      expect(result.stateNonce).toHaveLength(64); // 32 bytes hex
      expect(result.expiresInSeconds).toBe(600);
      expect(result.authorizationUrl).toContain('https://github.com/login/oauth/authorize');
      expect(result.authorizationUrl).toContain(`client_id=${testConfig.GITHUB_APP_CLIENT_ID}`);
      expect(result.authorizationUrl).toContain(`state=${result.stateNonce}`);
      expect(result.authorizationUrl).toContain('code_challenge=');
      expect(result.authorizationUrl).toContain('code_challenge_method=S256');
      expect(result.authorizationUrl).toContain('scope=read%3Auser');

      // Verify stored in DB
      const session = await oauthRepo.consumeSession(result.stateNonce);
      expect(session).not.toBeNull();
      expect(session?.discordUserId).toBe('discord_user_1');
      expect(session?.codeVerifier).toBeDefined();
    });

    it('fails closed when guild ID does not match configuration', async () => {
      const useCase = new InitiateAccountLinkUseCase(oauthRepo, cryptoService, testConfig);

      await expect(
        useCase.execute({
          discordUserId: 'discord_user_1',
          guildId: 'wrong_unauthorized_guild',
        }),
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('HandleOAuthCallbackUseCase', () => {
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

    it('rejects missing code or state parameters with ValidationError', async () => {
      await expect(useCase.execute({ code: '', state: 'xyz' })).rejects.toThrow(ValidationError);
      await expect(useCase.execute({ code: 'abc', state: '' })).rejects.toThrow(ValidationError);
    });

    it('rejects forged or expired state nonces and records audit rejection', async () => {
      await expect(
        useCase.execute({
          code: 'valid_code',
          state: 'non_existent_forged_state_nonce',
        }),
      ).rejects.toThrow('The authorization link is invalid, has expired, or has already been used.');

      const audits = await auditRepo.getRecentAudits(5);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.outcome).toBe('REJECTED');
      expect(audits[0]!.action).toBe('ACCOUNT_LINK');
    });

    it('happy path: single-use code exchange, identity binding, token encryption, and audit log', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      const { verifier } = cryptoService.generatePkcePair();

      // Create session in DB
      await oauthRepo.createSession(stateNonce, 'discord_user_88', testConfig.DISCORD_GUILD_ID, verifier, 600);

      const result = await useCase.execute({
        code: 'gh_code_valid',
        state: stateNonce,
      });

      expect(result.discordUserId).toBe('discord_user_88');
      expect(result.githubUserId).toBe(mockOAuthClient.defaultUserProfile.id);
      expect(result.githubLogin).toBe(mockOAuthClient.defaultUserProfile.login);

      // Verify single-use nonce consumption (replay should fail)
      const replayed = await oauthRepo.consumeSession(stateNonce);
      expect(replayed).toBeNull();

      // Verify identity link in DB with encrypted token
      const linked = await identityRepo.findByDiscordId('discord_user_88');
      expect(linked).not.toBeNull();
      expect(linked?.githubUserId).toBe(mockOAuthClient.defaultUserProfile.id);
      expect(linked?.githubUsername).toBe('testuser');
      expect(linked?.encryptedToken).toBeDefined();

      // Decrypt token to verify round-trip
      const decrypted = cryptoService.decryptToken(
        linked!.encryptedToken!.ivHex,
        linked!.encryptedToken!.authTagHex,
        linked!.encryptedToken!.ciphertextHex,
      );
      expect(decrypted).toBe(mockOAuthClient.defaultTokenResult.accessToken);

      // Verify audit log entry
      const audits = await auditRepo.getRecentAudits(5);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.outcome).toBe('SUCCESS');
      expect(audits[0]!.action).toBe('ACCOUNT_LINK');
      expect(audits[0]!.actorDiscordId).toBe('discord_user_88');
      expect(audits[0]!.actorGithubId).toBe(mockOAuthClient.defaultUserProfile.id);
    });
  });

  describe('GetAccountStatusUseCase', () => {
    it('returns linked = false for unlinked user', async () => {
      const useCase = new GetAccountStatusUseCase(identityRepo, testConfig);
      const status = await useCase.execute({
        discordUserId: 'unlinked_user',
        guildId: testConfig.DISCORD_GUILD_ID,
      });

      expect(status.linked).toBe(false);
      expect(status.discordUserId).toBe('unlinked_user');
      expect(status.githubUsername).toBeUndefined();
    });

    it('returns linked = true with account details for linked user', async () => {
      await identityRepo.linkIdentity('user_linked', 54321, 'octocat', {
        ivHex: '00',
        authTagHex: '11',
        ciphertextHex: '22',
      });

      const useCase = new GetAccountStatusUseCase(identityRepo, testConfig);
      const status = await useCase.execute({
        discordUserId: 'user_linked',
        guildId: testConfig.DISCORD_GUILD_ID,
      });

      expect(status.linked).toBe(true);
      expect(status.githubUserId).toBe(54321);
      expect(status.githubUsername).toBe('octocat');
      expect(status.hasEncryptedToken).toBe(true);
    });

    it('fails closed on unauthorized guild', async () => {
      const useCase = new GetAccountStatusUseCase(identityRepo, testConfig);
      await expect(
        useCase.execute({
          discordUserId: 'user',
          guildId: 'alien_guild',
        }),
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('DisconnectAccountUseCase', () => {
    it('unlinks identity, logs audit, and returns helpful instructions', async () => {
      await identityRepo.linkIdentity('user_to_unlink', 998877, 'unlink_me');

      const useCase = new DisconnectAccountUseCase(identityRepo, auditRepo, testConfig);
      const result = await useCase.execute({
        discordUserId: 'user_to_unlink',
        guildId: testConfig.DISCORD_GUILD_ID,
      });

      expect(result.unlinked).toBe(true);
      expect(result.previousGithubUsername).toBe('unlink_me');
      expect(result.previousGithubUserId).toBe(998877);
      expect(result.revocationUrl).toBe('https://github.com/settings/applications');

      // Verify removed from DB
      const identity = await identityRepo.findByDiscordId('user_to_unlink');
      expect(identity).toBeNull();

      // Verify audit entry
      const audits = await auditRepo.getRecentAudits(5);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe('ACCOUNT_UNLINK');
      expect(audits[0]!.outcome).toBe('SUCCESS');
    });

    it('is idempotent for unlinked user', async () => {
      const useCase = new DisconnectAccountUseCase(identityRepo, auditRepo, testConfig);
      const result = await useCase.execute({
        discordUserId: 'never_linked_user',
        guildId: testConfig.DISCORD_GUILD_ID,
      });

      expect(result.unlinked).toBe(false);
      expect(result.message).toContain('not linked');
    });

    it('fails closed on unauthorized guild', async () => {
      const useCase = new DisconnectAccountUseCase(identityRepo, auditRepo, testConfig);
      await expect(
        useCase.execute({
          discordUserId: 'user',
          guildId: 'bad_guild',
        }),
      ).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('Fastify Route GET /auth/github/callback (fastify.inject)', () => {
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

    it('Happy Path: returns 200 HTML with security headers, username, and numeric ID', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'discord_actor_1', testConfig.DISCORD_GUILD_ID, 'verifier1', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const response = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.payload).toContain('Account Successfully Connected');
      expect(response.payload).toContain(`@${mockOAuthClient.defaultUserProfile.login}`);
      expect(response.payload).toContain(`Numeric ID: ${mockOAuthClient.defaultUserProfile.id}`);

      await server.close();
    });

    it('Replay Attack: rejects replayed state nonce with 400 Bad Request HTML', async () => {
      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'discord_actor_2', testConfig.DISCORD_GUILD_ID, 'verifier2', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      // 1st request -> 200
      const res1 = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });
      expect(res1.statusCode).toBe(200);

      // 2nd request (replay) -> 400
      const res2 = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });
      expect(res2.statusCode).toBe(400);
      expect(res2.payload).toContain('Authorization Failed');
      expect(res2.payload).toContain('invalid, has expired, or has already been used');

      await server.close();
    });

    it('User Cancelled: handles ?error=access_denied gracefully with 400 HTML', async () => {
      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.',
      });

      expect(response.statusCode).toBe(400);
      expect(response.payload).toContain('Authorization Cancelled');
      expect(response.payload).toContain('The user has denied your application access.');

      await server.close();
    });

    it('Missing parameters: returns 400 Bad Request', async () => {
      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const resNoQuery = await server.inject({ method: 'GET', url: '/auth/github/callback' });
      expect(resNoQuery.statusCode).toBe(400);

      const resNoCode = await server.inject({ method: 'GET', url: '/auth/github/callback?state=xyz' });
      expect(resNoCode.statusCode).toBe(400);

      await server.close();
    });

    it('GitHub API Outage: returns 502 Bad Gateway HTML when GitHub API fails', async () => {
      mockOAuthClient.shouldFailUserFetch = true;
      mockOAuthClient.userFetchStatusCode = 502;

      const stateNonce = cryptoService.generateSecureNonce(32);
      await oauthRepo.createSession(stateNonce, 'discord_actor_3', testConfig.DISCORD_GUILD_ID, 'verifier3', 600);

      const server = await createHttpServer({
        database: db,
        cryptoService,
        handleOAuthCallbackUseCase: handleUseCase,
      });

      const response = await server.inject({
        method: 'GET',
        url: `/auth/github/callback?code=good_code&state=${stateNonce}`,
      });

      expect(response.statusCode).toBe(502);
      expect(response.payload).toContain('GitHub Authentication Error');

      // Verify no corrupted identity stored
      const identity = await identityRepo.findByDiscordId('discord_actor_3');
      expect(identity).toBeNull();

      await server.close();
    });
  });
});
