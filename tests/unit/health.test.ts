import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import { DatabaseManager } from '../../src/infrastructure/persistence/database.js';

describe('HTTP & Health Endpoints: Fastify Server', () => {
  it('GET /health/live returns HTTP 200 with uptime and timestamp', async () => {
    const server = await createHttpServer();

    const response = await server.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.timestamp).toBeDefined();

    await server.close();
  });

  it('GET /health/ready returns HTTP 200 when database is healthy', async () => {
    const db = new Database(':memory:');
    const server = await createHttpServer({ database: db });

    const response = await server.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe('healthy');

    db.close();
    await server.close();
  });

  it('GET /health/ready supports DatabaseManager instance', async () => {
    const manager = new DatabaseManager({ databasePath: ':memory:' });
    const server = await createHttpServer({ database: manager });

    const response = await server.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe('healthy');

    manager.close();
    await server.close();
  });

  it('GET /health/ready returns HTTP 503 when database is unhealthy or disconnected', async () => {
    const failingDb = {
      prepare: () => {
        throw new Error('SQLite disk I/O error at /internal/hidden/path/db.sqlite with key=secret');
      },
    };

    const server = await createHttpServer({ database: failingDb });

    const response = await server.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('unhealthy');
    expect(body.checks.database).toBe('unhealthy');

    // Secrets & internal paths hygiene: generic error message only
    expect(body.error).toBe('Database connectivity check failed');
    expect(response.payload).not.toContain('/internal/hidden/path');
    expect(response.payload).not.toContain('key=secret');

    await server.close();
  });

  it('preserves raw body Buffer for webhook verification', async () => {
    const server = await createHttpServer();

    // Register a test route requiring rawBody
    server.post('/test-webhook', { config: { rawBody: true } }, async (request, reply) => {
      const isBuffer = Buffer.isBuffer(request.rawBody);
      return reply.code(200).send({
        isBuffer,
        receivedText: request.rawBody?.toString('utf8'),
      });
    });

    const payloadText = JSON.stringify({ event: 'ping', zen: 'Keep it logically awesome.' });
    const response = await server.inject({
      method: 'POST',
      url: '/test-webhook',
      headers: {
        'content-type': 'application/json',
      },
      payload: payloadText,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.isBuffer).toBe(true);
    expect(body.receivedText).toBe(payloadText);

    await server.close();
  });
});
