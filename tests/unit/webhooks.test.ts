import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import { CryptoService } from '../../src/infrastructure/crypto/crypto.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';

describe('Webhook HTTP Route: POST /webhooks/github', () => {
  let db: Database.Database;
  let outboxRepo: OutboxRepository;
  let cryptoService: CryptoService;
  let server: FastifyInstance;

  const WEBHOOK_SECRET = 'super_secret_webhook_key_12345';
  const ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex
  let enqueuedEvents: Array<{ deliveryId: string; eventType: string }> = [];

  function computeSignature(payload: string, secret: string = WEBHOOK_SECRET): string {
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return `sha256=${hmac}`;
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    outboxRepo = new OutboxRepository(db);
    cryptoService = new CryptoService(ENCRYPTION_KEY);
    enqueuedEvents = [];

    server = await createHttpServer({
      database: db,
      cryptoService,
      webhookRouteOptions: {
        cryptoService,
        webhookSecret: WEBHOOK_SECRET,
        outboxRepository: outboxRepo,
        onDeliveryEnqueued: (deliveryId, eventType) => {
          enqueuedEvents.push({ deliveryId, eventType });
        },
      },
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('accepts valid HMAC SHA-256 signature and enqueues new delivery (HTTP 202)', async () => {
    const payload = JSON.stringify({ action: 'opened', issue: { number: 101, title: 'Bug report' } });
    const signature = computeSignature(payload);
    const deliveryId = 'delivery-uuid-001';

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe('enqueued');
    expect(body.deliveryId).toBe(deliveryId);
    expect(body.eventType).toBe('issues');

    // Verify row persisted into SQLite
    const pending = await outboxRepo.fetchPendingDeliveries(10);
    expect(pending.length).toBe(1);
    expect(pending[0].deliveryId).toBe(deliveryId);
    expect(pending[0].eventType).toBe('issues');
    expect(pending[0].status).toBe('PENDING');

    // Verify callback invoked
    expect(enqueuedEvents).toEqual([{ deliveryId, eventType: 'issues' }]);
  });

  it('deduplicates duplicate delivery ID atomically and returns HTTP 200 without duplicate queueing', async () => {
    const payload = JSON.stringify({ action: 'assigned', issue: { number: 102 } });
    const signature = computeSignature(payload);
    const deliveryId = 'delivery-uuid-duplicate-002';

    // First arrival: 202 Accepted
    const res1 = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'issues',
      },
      payload,
    });
    expect(res1.statusCode).toBe(202);
    expect(res1.json().status).toBe('enqueued');

    // Second arrival with same deliveryId: 200 OK duplicate_acknowledged
    const res2 = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'issues',
      },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().status).toBe('duplicate_acknowledged');
    expect(res2.json().deliveryId).toBe(deliveryId);

    // Verify total records in SQLite remains exactly 1
    const pending = await outboxRepo.fetchPendingDeliveries(10);
    expect(pending.length).toBe(1);

    // Callback only fired once
    expect(enqueuedEvents.length).toBe(1);
  });

  it('rejects request with missing X-Hub-Signature-256 header (HTTP 401)', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-uuid-003',
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('Unauthorized');
  });

  it('rejects request with whitespace-only signature header (HTTP 401)', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': '   ',
        'x-github-delivery': 'delivery-uuid-004',
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('Unauthorized');
  });

  it('rejects request when body is tampered (HTTP 401)', async () => {
    const originalPayload = JSON.stringify({ action: 'opened', issue: { number: 103 } });
    const signature = computeSignature(originalPayload);
    const tamperedPayload = JSON.stringify({ action: 'opened', issue: { number: 9999 } });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'delivery-uuid-005',
        'x-github-event': 'issues',
      },
      payload: tamperedPayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('Unauthorized');
  });

  it('rejects signature computed with incorrect secret (HTTP 401)', async () => {
    const payload = JSON.stringify({ action: 'closed' });
    const wrongSignature = computeSignature(payload, 'wrong_secret_attacker');

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': wrongSignature,
        'x-github-delivery': 'delivery-uuid-006',
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects signature missing sha256= prefix (HTTP 401)', async () => {
    const payload = JSON.stringify({ action: 'closed' });
    const rawHex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': rawHex, // missing sha256=
        'x-github-delivery': 'delivery-uuid-007',
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects malformed signature hex string (HTTP 401)', async () => {
    const payload = JSON.stringify({ action: 'closed' });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=not_a_valid_hex_string_too_short',
        'x-github-delivery': 'delivery-uuid-008',
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects request with missing X-GitHub-Delivery header (HTTP 400)', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const signature = computeSignature(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Bad Request');
    expect(response.json().message).toContain('X-GitHub-Delivery');
  });

  it('rejects request with missing X-GitHub-Event header (HTTP 400)', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const signature = computeSignature(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'delivery-uuid-009',
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('Bad Request');
    expect(response.json().message).toContain('X-GitHub-Event');
  });

  it('supports ping event gracefully (HTTP 202)', async () => {
    const payload = JSON.stringify({ zen: 'Mind your words, they become actions.', hook_id: 123456 });
    const signature = computeSignature(payload);
    const deliveryId = 'delivery-uuid-ping-010';

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'ping',
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('enqueued');
    expect(response.json().eventType).toBe('ping');

    // Duplicate ping returns 200
    const resDuplicate = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'ping',
      },
      payload,
    });
    expect(resDuplicate.statusCode).toBe(200);
    expect(resDuplicate.json().status).toBe('duplicate_acknowledged');
  });

  it('does not fail request even if onDeliveryEnqueued callback throws an error', async () => {
    const customServer = await createHttpServer({
      database: db,
      cryptoService,
      webhookRouteOptions: {
        cryptoService,
        webhookSecret: WEBHOOK_SECRET,
        outboxRepository: outboxRepo,
        onDeliveryEnqueued: () => {
          throw new Error('Callback boom');
        },
      },
    });

    const payload = JSON.stringify({ action: 'opened', issue: { number: 104 } });
    const signature = computeSignature(payload);
    const deliveryId = 'delivery-uuid-callback-err';

    const response = await customServer.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature,
        'x-github-delivery': deliveryId,
        'x-github-event': 'issues',
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    await customServer.close();
  });
});
