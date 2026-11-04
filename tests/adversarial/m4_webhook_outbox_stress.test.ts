import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import { CryptoService } from '../../src/infrastructure/crypto/crypto.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { ScheduleRepository } from '../../src/infrastructure/persistence/repositories/ScheduleRepository.js';
import { NotificationService } from '../../src/application/services/NotificationService.js';
import { DispatchDailyDigestUseCase } from '../../src/application/usecases/DispatchDailyDigestUseCase.js';
import { DigestScheduler } from '../../src/infrastructure/scheduling/DigestScheduler.js';
import { getJakartaDateString } from '../../src/infrastructure/scheduling/dateUtils.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { MockGitHubService } from '../mocks/MockGitHubService.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';
import { RateLimitError, ExternalApiError } from '../../src/domain/errors.js';

describe('Adversarial Verification: M4 Webhooks, Outbox Failure Dynamics & Digest Deduplication', () => {
  let db: DatabaseInstance;
  let outboxRepo: OutboxRepository;
  let identityRepo: IdentityRepository;
  let scheduleRepo: ScheduleRepository;
  let cryptoService: CryptoService;
  let discordSender: MockDiscordNotificationSender;
  let gitHubService: MockGitHubService;
  let server: FastifyInstance;

  const WEBHOOK_SECRET = 'v3ry_s3cr3t_gh_w3bh00k_k3y_987654321';
  const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const CONFIG = {
    DISCORD_NOTIFICATION_CHANNEL_ID: '111222333444555666',
    DISCORD_GUILD_ID: '999888777666555444',
    GITHUB_OWNER: 'test-org',
    GITHUB_REPOSITORY: 'test-repo',
    GITHUB_PROJECT_NUMBER: 42,
    DIGEST_ENABLED: true,
  };

  let enqueuedWebhookEvents: Array<{ deliveryId: string; eventType: string }> = [];

  function computeValidSignature(payload: string, secret: string = WEBHOOK_SECRET): string {
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${hmac}`;
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    outboxRepo = new OutboxRepository(db);
    identityRepo = new IdentityRepository(db);
    scheduleRepo = new ScheduleRepository(db);
    cryptoService = new CryptoService(ENCRYPTION_KEY);
    discordSender = new MockDiscordNotificationSender();
    gitHubService = new MockGitHubService();
    enqueuedWebhookEvents = [];

    server = await createHttpServer({
      database: db,
      cryptoService,
      webhookRouteOptions: {
        cryptoService,
        webhookSecret: WEBHOOK_SECRET,
        outboxRepository: outboxRepo,
        onDeliveryEnqueued: (deliveryId, eventType) => {
          enqueuedWebhookEvents.push({ deliveryId, eventType });
        },
      },
    });
  });

  afterEach(async () => {
    await server.close();
    if (db.open) {
      db.close();
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. WEBHOOK SECURITY & HMAC SHA-256 ADVERSARIAL PROBING
  // =========================================================================
  describe('1. Webhook Security & HMAC SHA-256 Probing', () => {
    const validPayload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 401,
        title: 'Adversarial Test Issue',
        html_url: 'https://github.com/test-org/test-repo/issues/401',
        user: { login: 'hacker_one' },
      },
    });

    it('rejects completely forged signatures with valid format (HTTP 401)', async () => {
      // 64 random hex characters with valid sha256= prefix
      const forgedSig = 'sha256=' + 'deadbeefcafebabe0123456789abcdef'.repeat(2);
      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': forgedSig,
          'x-github-delivery': 'deliv-forged-001',
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toContain('Invalid HMAC SHA-256 signature');

      // Ensure nothing was written to SQLite
      const pending = await outboxRepo.fetchPendingDeliveries(10);
      expect(pending).toHaveLength(0);
      expect(enqueuedWebhookEvents).toHaveLength(0);
    });

    it('rejects signature computed with wrong secret or 1-byte difference in secret (HTTP 401)', async () => {
      // Secret with just the last character flipped
      const slightlyWrongSecret = WEBHOOK_SECRET.slice(0, -1) + '0';
      const wrongSig = computeValidSignature(validPayload, slightlyWrongSecret);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': wrongSig,
          'x-github-delivery': 'deliv-wrong-secret-002',
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects truncated signatures of varying lengths (HTTP 401)', async () => {
      const fullSig = computeValidSignature(validPayload);
      const hexPart = fullSig.slice(7);

      const truncatedVariations = [
        'sha256=', // 0 hex chars
        'sha256=a', // 1 hex char
        `sha256=${hexPart.slice(0, 16)}`, // 16 hex chars
        `sha256=${hexPart.slice(0, 32)}`, // 32 hex chars
        `sha256=${hexPart.slice(0, 63)}`, // 63 hex chars (1 character short)
      ];

      for (const truncated of truncatedVariations) {
        const res = await server.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': truncated,
            'x-github-delivery': `deliv-trunc-${truncated.length}`,
            'x-github-event': 'issues',
          },
          payload: validPayload,
        });

        expect(res.statusCode, `Expected 401 for truncated signature '${truncated}'`).toBe(401);
        expect(res.json().error).toBe('Unauthorized');
      }
    });

    it('rejects oversized signatures (HTTP 401)', async () => {
      const fullSig = computeValidSignature(validPayload);
      const oversizedSig = fullSig + 'ff'; // 66 hex characters

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': oversizedSig,
          'x-github-delivery': 'deliv-oversized-001',
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects non-hex signatures (HTTP 401)', async () => {
      // 64 characters but with non-hex letters and symbols
      const nonHexChars = [
        'sha256=' + 'g'.repeat(64),
        'sha256=' + 'z'.repeat(64),
        'sha256=' + '0123456789abcdef'.repeat(3) + '!@#$%^&*()_+=-~?',
        'sha256=' + ' '.repeat(64),
      ];

      for (const nonHex of nonHexChars) {
        const res = await server.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': nonHex,
            'x-github-delivery': 'deliv-nonhex',
            'x-github-event': 'issues',
          },
          payload: validPayload,
        });

        expect(res.statusCode, `Expected 401 for non-hex signature: ${nonHex}`).toBe(401);
      }
    });

    it('rejects signatures missing sha256= prefix or using alternative prefixes (HTTP 401)', async () => {
      const rawHex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(validPayload).digest('hex');

      const badPrefixes = [
        rawHex, // bare hex without prefix
        `sha1=${rawHex}`, // wrong algorithm prefix
        `sha512=${rawHex}`, // wrong algorithm prefix
        `md5=${rawHex}`, // wrong algorithm prefix
        `bearer ${rawHex}`, // auth header prefix
        `sha256: ${rawHex}`, // colon instead of equals
      ];

      for (const badSig of badPrefixes) {
        const res = await server.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': badSig,
            'x-github-delivery': 'deliv-bad-prefix',
            'x-github-event': 'issues',
          },
          payload: validPayload,
        });

        expect(res.statusCode, `Expected 401 for invalid prefix signature: ${badSig}`).toBe(401);
      }
    });

    it('rejects single-byte flip tampering in payload with valid original signature (HTTP 401)', async () => {
      const originalPayload = JSON.stringify({
        action: 'opened',
        issue: { number: 402, title: 'Original Secure Title' },
      });
      const validSig = computeValidSignature(originalPayload);

      // Mutate exactly one byte in original payload
      const tamperedPayload = originalPayload.replace('Original', 'Priginal');

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': 'deliv-byte-flip',
          'x-github-event': 'issues',
        },
        payload: tamperedPayload,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });

    it('rejects subtle whitespace or newline appending tampering (HTTP 401)', async () => {
      const originalPayload = JSON.stringify({ action: 'reopened', issue: { number: 403 } });
      const validSig = computeValidSignature(originalPayload);

      const tamperedPayload = originalPayload + '\n';

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': 'deliv-whitespace-tamper',
          'x-github-event': 'issues',
        },
        payload: tamperedPayload,
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects missing or empty X-GitHub-Delivery header (HTTP 400)', async () => {
      const validSig = computeValidSignature(validPayload);

      // 1. Missing header
      const resMissing = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });
      expect(resMissing.statusCode).toBe(400);
      expect(resMissing.json().message).toContain('X-GitHub-Delivery');

      // 2. Empty string header
      const resEmpty = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': '',
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });
      expect(resEmpty.statusCode).toBe(400);

      // 3. Whitespace-only header
      const resWhitespace = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': '     ',
          'x-github-event': 'issues',
        },
        payload: validPayload,
      });
      expect(resWhitespace.statusCode).toBe(400);
    });

    it('rejects missing or empty X-GitHub-Event header (HTTP 400)', async () => {
      const validSig = computeValidSignature(validPayload);

      // 1. Missing header
      const resMissing = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': 'deliv-event-header-test-01',
        },
        payload: validPayload,
      });
      expect(resMissing.statusCode).toBe(400);
      expect(resMissing.json().message).toContain('X-GitHub-Event');

      // 2. Empty string header
      const resEmpty = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': 'deliv-event-header-test-02',
          'x-github-event': '',
        },
        payload: validPayload,
      });
      expect(resEmpty.statusCode).toBe(400);

      // 3. Whitespace-only header
      const resWhitespace = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSig,
          'x-github-delivery': 'deliv-event-header-test-03',
          'x-github-event': '   \t  ',
        },
        payload: validPayload,
      });
      expect(resWhitespace.statusCode).toBe(400);
    });

    it('rapid concurrent duplicate deliveries with identical delivery ID: exactly 1 returns 202, 49 return 200', async () => {
      const concurrentDeliveryId = 'deliv-concurrent-race-stress-001';
      const signature = computeValidSignature(validPayload);
      const CONCURRENCY_COUNT = 50;

      const requests = Array.from({ length: CONCURRENCY_COUNT }, () =>
        server.inject({
          method: 'POST',
          url: '/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signature,
            'x-github-delivery': concurrentDeliveryId,
            'x-github-event': 'issues',
          },
          payload: validPayload,
        }),
      );

      const responses = await Promise.all(requests);

      // Count HTTP status codes
      const status202 = responses.filter((r) => r.statusCode === 202);
      const status200 = responses.filter((r) => r.statusCode === 200);
      const errors = responses.filter((r) => r.statusCode !== 200 && r.statusCode !== 202);

      expect(errors).toHaveLength(0);
      expect(status202).toHaveLength(1);
      expect(status200).toHaveLength(CONCURRENCY_COUNT - 1);

      expect(status202[0].json()).toEqual({
        status: 'enqueued',
        deliveryId: concurrentDeliveryId,
        eventType: 'issues',
      });

      for (const res of status200) {
        expect(res.json()).toEqual({
          status: 'duplicate_acknowledged',
          deliveryId: concurrentDeliveryId,
          eventType: 'issues',
        });
      }

      // SQLite must contain exactly 1 entry for this deliveryId
      const rowCount = db
        .prepare('SELECT COUNT(*) as cnt FROM outbox_deliveries WHERE delivery_id = ?')
        .get(concurrentDeliveryId) as { cnt: number };
      expect(rowCount.cnt).toBe(1);

      // Callback must have fired exactly once
      expect(enqueuedWebhookEvents).toHaveLength(1);
      expect(enqueuedWebhookEvents[0].deliveryId).toBe(concurrentDeliveryId);
    });
  });

  // =========================================================================
  // 2. OUTBOX WORKER FAILURE, BACKOFF DYNAMICS & DEAD LETTER TRANSITION
  // =========================================================================
  describe('2. Outbox Worker Failure & Backoff Dynamics', () => {
    let notificationService: NotificationService;

    beforeEach(() => {
      discordSender.reset();
      notificationService = new NotificationService(
        outboxRepo,
        identityRepo,
        discordSender,
        CONFIG,
        {
          batchSize: 10,
          baseBackoffMs: 50, // fast 50ms base backoff for test determinism
          maxBackoffMs: 2000,
          maxAttempts: 5, // strictly 5 consecutive failures before DEAD_LETTER
        },
      );
    });

    afterEach(() => {
      notificationService.stopWorker();
    });

    it('simulates Discord Gateway rate limit (429) and enforces backoff delay', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 501, title: 'Rate Limited Issue', html_url: 'https://github.com' },
      });
      await notificationService.ingestWebhook('deliv-ratelimit-429', 'issues', payload);

      // Simulate Discord 429 RateLimitError
      discordSender.shouldFail = true;
      discordSender.failureError = new RateLimitError('Rate limit exceeded on webhook channel', 2);

      // Attempt 1: Fails due to 429
      const processed1 = await notificationService.processOutboxBatch(10);
      expect(processed1).toBe(0);

      // Check SQLite state
      const row1 = db
        .prepare('SELECT attempts, status, last_error FROM outbox_deliveries WHERE delivery_id = ?')
        .get('deliv-ratelimit-429') as any;
      expect(row1.attempts).toBe(1);
      expect(row1.status).toBe('PENDING');
      expect(row1.last_error).toContain('Rate limit exceeded');

      // Immediate second batch call MUST be skipped due to active backoff delay
      const processedImmediate = await notificationService.processOutboxBatch(10);
      expect(processedImmediate).toBe(0);

      // No additional attempt recorded in SQLite during backoff window
      const rowImmediate = db
        .prepare('SELECT attempts FROM outbox_deliveries WHERE delivery_id = ?')
        .get('deliv-ratelimit-429') as any;
      expect(rowImmediate.attempts).toBe(1);

      // Advance past the 50ms backoff window
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Resolve Discord 429 condition
      discordSender.shouldFail = false;

      // Attempt 2: Now eligible and succeeds
      const processed2 = await notificationService.processOutboxBatch(10);
      expect(processed2).toBe(1);

      const rowSuccess = db
        .prepare('SELECT status, processed_at FROM outbox_deliveries WHERE delivery_id = ?')
        .get('deliv-ratelimit-429') as any;
      expect(rowSuccess.status).toBe('PROCESSED');
      expect(rowSuccess.processed_at).toBeTruthy();
    });

    it('transitions to DEAD_LETTER after exactly 5 consecutive failures and fetchPendingDeliveries ignores it', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 502, title: 'Permanent Failure Issue', html_url: 'https://github.com' },
      });
      const deliveryId = 'deliv-deadletter-5-attempts';
      await notificationService.ingestWebhook(deliveryId, 'issues', payload);

      // Simulate persistent network dropout / 503 Gateway Down
      discordSender.shouldFail = true;
      discordSender.failureError = new ExternalApiError('Discord Gateway ETIMEDOUT network failure', 503);

      // Attempt 1 (delay = 50 * 2^0 = 50ms)
      await notificationService.processOutboxBatch(10);
      let row = db.prepare('SELECT attempts, status FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as any;
      expect(row.attempts).toBe(1);
      expect(row.status).toBe('PENDING');

      // Attempt 2 (delay = 50 * 2^1 = 100ms)
      await new Promise((r) => setTimeout(r, 60));
      await notificationService.processOutboxBatch(10);
      row = db.prepare('SELECT attempts, status FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as any;
      expect(row.attempts).toBe(2);
      expect(row.status).toBe('PENDING');

      // Attempt 3 (delay = 50 * 2^2 = 200ms)
      await new Promise((r) => setTimeout(r, 120));
      await notificationService.processOutboxBatch(10);
      row = db.prepare('SELECT attempts, status FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as any;
      expect(row.attempts).toBe(3);
      expect(row.status).toBe('PENDING');

      // Attempt 4 (delay = 50 * 2^3 = 400ms)
      await new Promise((r) => setTimeout(r, 220));
      await notificationService.processOutboxBatch(10);
      row = db.prepare('SELECT attempts, status FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as any;
      expect(row.attempts).toBe(4);
      expect(row.status).toBe('PENDING');

      // Attempt 5 (attempts 5 >= maxAttempts 5 -> transitions to DEAD_LETTER)
      await new Promise((r) => setTimeout(r, 420));
      await notificationService.processOutboxBatch(10);
      row = db.prepare('SELECT attempts, status, last_error, processed_at FROM outbox_deliveries WHERE delivery_id = ?').get(deliveryId) as any;
      expect(row.attempts).toBe(5);
      expect(row.status).toBe('DEAD_LETTER');
      expect(row.last_error).toContain('Discord Gateway ETIMEDOUT');
      expect(row.processed_at).toBeNull();

      // VERIFY: fetchPendingDeliveries strictly ignores DEAD_LETTER records
      const pending = await outboxRepo.fetchPendingDeliveries(10);
      expect(pending).toHaveLength(0);

      // Subsequent batch processing does NOT re-process the dead letter item
      const processedDead = await notificationService.processOutboxBatch(10);
      expect(processedDead).toBe(0);
    });

    it('prevents head-of-line blocking: failing delivery does not block succeeding deliveries in same batch', async () => {
      // Record A will fail, Record B and C will succeed
      const payloadA = JSON.stringify({
        action: 'opened',
        issue: { number: 601, title: 'Fail Me', html_url: 'https://github.com/test-org/test-repo/issues/601' },
      });
      const payloadB = JSON.stringify({
        action: 'opened',
        issue: { number: 602, title: 'Succeed B', html_url: 'https://github.com/test-org/test-repo/issues/602' },
      });
      const payloadC = JSON.stringify({
        action: 'opened',
        issue: { number: 603, title: 'Succeed C', html_url: 'https://github.com/test-org/test-repo/issues/603' },
      });

      await notificationService.ingestWebhook('deliv-hol-A', 'issues', payloadA);
      await notificationService.ingestWebhook('deliv-hol-B', 'issues', payloadB);
      await notificationService.ingestWebhook('deliv-hol-C', 'issues', payloadC);

      // Custom discordSender behavior: fail only for issue 601
      const originalSend = discordSender.sendNotification.bind(discordSender);
      discordSender.sendNotification = async (p) => {
        const title = (p.embeds?.[0] as any)?.data?.title || (p.embeds?.[0] as any)?.title || '';
        if (title.includes('#601')) {
          throw new Error('Specific failure on delivery A');
        }
        return originalSend(p);
      };

      const processed = await notificationService.processOutboxBatch(10);
      // B and C should have processed successfully!
      expect(processed).toBe(2);

      // Check statuses in DB
      const rowA = db.prepare('SELECT status, attempts FROM outbox_deliveries WHERE delivery_id = ?').get('deliv-hol-A') as any;
      const rowB = db.prepare('SELECT status FROM outbox_deliveries WHERE delivery_id = ?').get('deliv-hol-B') as any;
      const rowC = db.prepare('SELECT status FROM outbox_deliveries WHERE delivery_id = ?').get('deliv-hol-C') as any;

      expect(rowA.status).toBe('PENDING');
      expect(rowA.attempts).toBe(1);
      expect(rowB.status).toBe('PROCESSED');
      expect(rowC.status).toBe('PROCESSED');
    });

    it('prevents overlapping batch executions with concurrent lock guard', async () => {
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 701, title: 'Slow Batch', html_url: 'https://github.com/test-org/test-repo/issues/701' },
      });
      await notificationService.ingestWebhook('deliv-overlap-001', 'issues', payload);

      // Hook discord sender with artificial delay to keep first batch running
      let finishDelay: () => void;
      const delayPromise = new Promise<void>((resolve) => {
        finishDelay = resolve;
      });

      const originalSend = discordSender.sendNotification.bind(discordSender);
      discordSender.sendNotification = async (p) => {
        await delayPromise;
        return originalSend(p);
      };

      // Start batch 1 (async, will hang on delayPromise)
      const batch1Promise = notificationService.processOutboxBatch(10);

      // Immediately attempt batch 2 while batch 1 is in-flight
      const batch2Result = await notificationService.processOutboxBatch(10);
      // Batch 2 must immediately abort and return 0
      expect(batch2Result).toBe(0);

      // Release batch 1
      finishDelay!();
      const batch1Result = await batch1Promise;
      expect(batch1Result).toBe(1);
    });
  });

  // =========================================================================
  // 3. EVENT ROUTING & MENTION SECURITY ADVERSARIAL STRESS
  // =========================================================================
  describe('3. Event Routing & Mention Sanitization Stress', () => {
    let notificationService: NotificationService;

    beforeEach(() => {
      discordSender.reset();
      notificationService = new NotificationService(
        outboxRepo,
        identityRepo,
        discordSender,
        CONFIG,
      );
    });

    it('neutralizes malicious @everyone and role mentions in issue title and body', async () => {
      const maliciousPayload = {
        action: 'opened',
        issue: {
          number: 801,
          title: '🚨 CRITICAL EXPLOIT: @everyone @here <@&112233445566778899>',
          body: 'Attention @everyone and <@&998877665544332211> please click immediately!',
          html_url: 'https://github.com/test-org/test-repo/issues/801',
          user: { login: 'attacker' },
        },
      };

      const decision = await notificationService.routeEvent('issues', maliciousPayload);
      expect(decision.shouldSend).toBe(true);

      // Embed title and body must be sanitized with zero-width spaces
      const embedData = (decision.embeds![0] as any).data || (decision.embeds![0] as any);
      expect(embedData.title).not.toContain('@everyone');
      expect(embedData.title).not.toContain('@here');
      expect(embedData.description).not.toContain('@everyone');

      // Discord allowedMentions must have parse strictly empty
      expect(decision.allowedMentions?.parse).toEqual([]);
      expect(decision.allowedMentions?.users).toEqual([]);
    });

    it('resolves issue assignment: mapped Discord user gets ping outside embed, unlinked user gets plain text', async () => {
      // 1. Unlinked assignee
      const unlinkedPayload = {
        action: 'assigned',
        assignee: { id: 999111, login: 'unlinked_developer' },
        issue: {
          number: 802,
          title: 'Unlinked Assignment',
          html_url: 'https://github.com',
          user: { login: 'pm_lead' },
        },
      };
      const unlinkedDecision = await notificationService.routeEvent('issues', unlinkedPayload);
      expect(unlinkedDecision.shouldSend).toBe(true);
      expect(unlinkedDecision.content).toContain('**@unlinked_developer**');
      expect(unlinkedDecision.content).not.toContain('<@');
      expect(unlinkedDecision.allowedMentions?.users).toEqual([]);

      // 2. Linked assignee
      await identityRepo.linkIdentity('discord_user_888', 999222, 'linked_developer');
      const linkedPayload = {
        action: 'assigned',
        assignee: { id: 999222, login: 'linked_developer' },
        issue: {
          number: 803,
          title: 'Linked Assignment',
          html_url: 'https://github.com',
          user: { login: 'pm_lead' },
        },
      };
      const linkedDecision = await notificationService.routeEvent('issues', linkedPayload);
      expect(linkedDecision.shouldSend).toBe(true);
      expect(linkedDecision.content).toContain('<@discord_user_888>');
      expect(linkedDecision.allowedMentions?.users).toEqual(['discord_user_888']);
      expect(linkedDecision.allowedMentions?.parse).toEqual([]);
    });

    it('workflow_run routing: alerts only on failure/timed_out on default/PR branches, drops success and scratch branches', async () => {
      // 1. Success conclusion -> dropped
      const successPayload = {
        action: 'completed',
        workflow_run: {
          name: 'CI Test',
          head_branch: 'main',
          conclusion: 'success',
          html_url: 'https://github.com',
        },
        repository: { default_branch: 'main' },
      };
      const successDecision = await notificationService.routeEvent('workflow_run', successPayload);
      expect(successDecision.shouldSend).toBe(false);

      // 2. Failure on scratch feature branch without PR -> dropped
      const scratchBranchPayload = {
        action: 'completed',
        workflow_run: {
          name: 'CI Test',
          head_branch: 'scratch-experiments-no-pr',
          conclusion: 'failure',
          pull_requests: [],
          html_url: 'https://github.com',
        },
        repository: { default_branch: 'main' },
      };
      const scratchDecision = await notificationService.routeEvent('workflow_run', scratchBranchPayload);
      expect(scratchDecision.shouldSend).toBe(false);

      // 3. Failure on PR branch -> sends alert
      const prBranchPayload = {
        action: 'completed',
        workflow_run: {
          name: 'Build & Test',
          head_branch: 'feat/new-api',
          conclusion: 'failure',
          pull_requests: [{ number: 88 }],
          html_url: 'https://github.com/runs/123',
          actor: { id: 12345, login: 'ci_dev' },
        },
        repository: { default_branch: 'main' },
      };
      const prDecision = await notificationService.routeEvent('workflow_run', prBranchPayload);
      expect(prDecision.shouldSend).toBe(true);
      expect(prDecision.embeds).toHaveLength(1);
    });

    it('check_suite routing: actively suppresses github-actions check suites to avoid duplicate alerts', async () => {
      const ghActionsCheckSuite = {
        action: 'completed',
        check_suite: {
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          conclusion: 'failure',
          head_branch: 'main',
        },
        repository: { default_branch: 'main' },
      };
      const decision = await notificationService.routeEvent('check_suite', ghActionsCheckSuite);
      expect(decision.shouldSend).toBe(false);
    });
  });

  // =========================================================================
  // 4. DAILY DIGEST DEDUPLICATION & LEASE ACQUISITION UNDER CONCURRENCY
  // =========================================================================
  describe('4. Daily Digest Deduplication & Restart Idempotency', () => {
    let dispatchUseCase: DispatchDailyDigestUseCase;

    beforeEach(() => {
      discordSender.reset();
      dispatchUseCase = new DispatchDailyDigestUseCase(
        gitHubService,
        scheduleRepo,
        discordSender,
        CONFIG,
      );
    });

    it('concurrent lease acquisition: exactly 1 wins, the other aborts with LEASE_LOCKED', async () => {
      const targetDate = '2026-11-04';

      // Fire 2 simultaneous executions for the same target date
      const [res1, res2] = await Promise.all([
        dispatchUseCase.execute({ targetDate }),
        dispatchUseCase.execute({ targetDate }),
      ]);

      const dispatched = [res1, res2].filter((r) => r.dispatched);
      const locked = [res1, res2].filter((r) => !r.dispatched && (r.reason === 'LEASE_LOCKED' || r.reason === 'ALREADY_EXECUTED'));

      expect(dispatched).toHaveLength(1);
      expect(locked).toHaveLength(1);

      // Verify Discord received exactly 1 digest notification embed
      expect(discordSender.sentNotifications).toHaveLength(1);
    });

    it('container restart idempotency: executing after restart is blocked by ALREADY_EXECUTED', async () => {
      const targetDate = '2026-11-04';

      // Instance 1 runs at 09:00 WIB
      const initialRun = await dispatchUseCase.execute({ targetDate });
      expect(initialRun.dispatched).toBe(true);
      expect(initialRun.reason).toBe('SUCCESS');

      // Simulate container crash & restart by creating brand new use case instance with same persistent DB
      const restartedUseCase = new DispatchDailyDigestUseCase(
        gitHubService,
        scheduleRepo,
        discordSender,
        CONFIG,
      );

      // Instance 2 boots up and attempts digest for same day
      const rerun = await restartedUseCase.execute({ targetDate });
      expect(rerun.dispatched).toBe(false);
      expect(rerun.reason).toBe('ALREADY_EXECUTED');

      // Still only 1 digest sent to Discord
      expect(discordSender.sentNotifications).toHaveLength(1);

      // Forcing with force: true bypasses already executed check
      const forceRun = await restartedUseCase.execute({ targetDate, force: true });
      expect(forceRun.dispatched).toBe(true);
      expect(forceRun.reason).toBe('SUCCESS');
      expect(discordSender.sentNotifications).toHaveLength(2);
    });

    it('formats date correctly in Asia/Jakarta timezone around UTC day boundary', () => {
      // 2026-11-03T22:30:00Z in UTC is 2026-11-04 05:30:00 WIB in Asia/Jakarta (+7)
      const dateUtcNight = new Date('2026-11-03T22:30:00Z');
      const jakartaDate = getJakartaDateString(dateUtcNight);
      expect(jakartaDate).toBe('2026-11-04');

      // 2026-11-03T16:59:00Z is 2026-11-03 23:59:00 WIB
      const dateUtcBeforeMidnightWib = new Date('2026-11-03T16:59:00Z');
      expect(getJakartaDateString(dateUtcBeforeMidnightWib)).toBe('2026-11-03');
    });

    it('respects DIGEST_ENABLED=false feature flag in scheduler and use case', async () => {
      const disabledUseCase = new DispatchDailyDigestUseCase(
        gitHubService,
        scheduleRepo,
        discordSender,
        { ...CONFIG, DIGEST_ENABLED: false },
      );

      const res = await disabledUseCase.execute();
      expect(res.dispatched).toBe(false);
      expect(res.reason).toBe('DISABLED');

      const scheduler = new DigestScheduler({
        config: { DIGEST_ENABLED: false, DIGEST_TIME: '09:00', DIGEST_TIMEZONE: 'Asia/Jakarta' },
        dispatchUseCase: disabledUseCase,
      });

      const started = scheduler.start();
      expect(started).toBe(false);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  // =========================================================================
  // 5. INJECTION, OVERSIZED PAYLOADS & PROTOTYPE POLLUTION RESISTANCE
  // =========================================================================
  describe('5. Injection, Oversized Payloads & Prototype Pollution Resistance', () => {
    it('defends against SQL injection in X-GitHub-Delivery and X-GitHub-Event headers', async () => {
      const maliciousDeliveryId = "deliv-sqli'; DROP TABLE outbox_deliveries; --";
      const maliciousEvent = "issues' OR '1'='1";
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 901, title: 'SQLi Probe', html_url: 'https://github.com/issues/901' },
      });
      const sig = computeValidSignature(payload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-delivery': maliciousDeliveryId,
          'x-github-event': maliciousEvent,
        },
        payload,
      });

      expect(res.statusCode).toBe(202);

      // Verify the table was NOT dropped and the row was inserted with literal delivery_id
      const row = db
        .prepare('SELECT delivery_id, event_type FROM outbox_deliveries WHERE delivery_id = ?')
        .get(maliciousDeliveryId) as any;
      expect(row).toBeDefined();
      expect(row.delivery_id).toBe(maliciousDeliveryId);
      expect(row.event_type).toBe(maliciousEvent);
    });

    it('safely ingests and stores large webhook payload (150KB)', async () => {
      const largeDescription = 'x'.repeat(150 * 1024); // 150KB string
      const largePayload = JSON.stringify({
        action: 'opened',
        issue: {
          number: 902,
          title: 'Large Payload Issue',
          body: largeDescription,
          html_url: 'https://github.com/issues/902',
        },
      });
      const sig = computeValidSignature(largePayload);
      const deliveryId = 'deliv-large-150kb';

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
        },
        payload: largePayload,
      });

      expect(res.statusCode).toBe(202);

      const row = db
        .prepare('SELECT length(payload_json) as len FROM outbox_deliveries WHERE delivery_id = ?')
        .get(deliveryId) as any;
      expect(row.len).toBeGreaterThan(150 * 1024);
    });

    it('neutralizes prototype pollution attempts in JSON payloads', async () => {
      const pollutionPayload = JSON.stringify({
        __proto__: { isAdmin: true },
        action: 'opened',
        issue: { number: 903, title: 'Pollution Probe', html_url: 'https://github.com/issues/903' },
      });
      const sig = computeValidSignature(pollutionPayload);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-delivery': 'deliv-pollution-001',
          'x-github-event': 'issues',
        },
        payload: pollutionPayload,
      });

      expect(res.statusCode).toBe(202);

      // Verify Object prototype has not been polluted
      expect((Object.prototype as any).isAdmin).toBeUndefined();
    });

    it('calculates Jakarta timezone transitions across leap years and year boundaries', () => {
      // Leap day evening UTC: 2024-02-29T20:00:00Z -> 2024-03-01 03:00:00 WIB
      const leapDayUtc = new Date('2024-02-29T20:00:00Z');
      expect(getJakartaDateString(leapDayUtc)).toBe('2024-03-01');

      // New Year evening UTC: 2024-12-31T20:00:00Z -> 2025-01-01 03:00:00 WIB
      const newYearEveUtc = new Date('2024-12-31T20:00:00Z');
      expect(getJakartaDateString(newYearEveUtc)).toBe('2025-01-01');
    });
  });
});
