import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NotificationService } from '../../src/application/services/NotificationService.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/OutboxRepository.js';
import { IdentityRepository } from '../../src/infrastructure/persistence/repositories/IdentityRepository.js';
import { MockDiscordNotificationSender } from '../mocks/MockDiscordNotificationSender.js';
import { runMigrations } from '../../src/infrastructure/persistence/migrator.js';

describe('Notification Outbox Worker Integration: NotificationService', () => {
  let db: Database.Database;
  let outboxRepo: OutboxRepository;
  let identityRepo: IdentityRepository;
  let discordSender: MockDiscordNotificationSender;
  let notificationService: NotificationService;

  const CONFIG = {
    DISCORD_NOTIFICATION_CHANNEL_ID: 'channel_alerts_999',
    DISCORD_GUILD_ID: 'guild_target_123',
    GITHUB_OWNER: 'testowner',
    GITHUB_REPOSITORY: 'testrepo',
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    outboxRepo = new OutboxRepository(db);
    identityRepo = new IdentityRepository(db);
    discordSender = new MockDiscordNotificationSender();

    notificationService = new NotificationService(
      outboxRepo,
      identityRepo,
      discordSender,
      CONFIG,
      {
        batchSize: 10,
        baseBackoffMs: 100, // Fast backoff for tests
        maxBackoffMs: 5000,
        maxAttempts: 3,
      },
    );
  });

  afterEach(() => {
    notificationService.stopWorker();
    db.close();
    vi.restoreAllMocks();
  });

  it('enqueues deliveries and processes them to PROCESSED status', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 101,
        title: 'New Feature Request',
        html_url: 'https://github.com/testowner/testrepo/issues/101',
        user: { login: 'dev_user' },
      },
    });

    await notificationService.ingestWebhook('delivery_outbox_001', 'issues', payload);

    // Verify row is PENDING
    let pending = await outboxRepo.fetchPendingDeliveries(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('PENDING');

    // Process batch
    const processedCount = await notificationService.processOutboxBatch(10);
    expect(processedCount).toBe(1);

    // Verify message was delivered to Discord
    expect(discordSender.sentNotifications).toHaveLength(1);
    expect(discordSender.sentNotifications[0].channelId).toBe('channel_alerts_999');

    // Verify row is marked PROCESSED
    pending = await outboxRepo.fetchPendingDeliveries(10);
    expect(pending).toHaveLength(0);

    const row = db.prepare('SELECT status, processed_at FROM outbox_deliveries WHERE delivery_id = ?').get('delivery_outbox_001') as any;
    expect(row.status).toBe('PROCESSED');
    expect(row.processed_at).toBeDefined();
  });

  it('records failure and skips retry during backoff window', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 102,
        title: 'Failing Delivery',
        html_url: 'https://github.com/testowner/testrepo/issues/102',
        user: { login: 'dev_user' },
      },
    });

    await notificationService.ingestWebhook('delivery_outbox_fail_002', 'issues', payload);

    // Simulate Discord API outage
    discordSender.shouldFail = true;
    discordSender.failureError = new Error('Discord Gateway unavailable (503)');

    // Attempt 1: Fails
    const processed1 = await notificationService.processOutboxBatch(10);
    expect(processed1).toBe(0);

    const rowAfterAttempt1 = db.prepare('SELECT attempts, status, last_error FROM outbox_deliveries WHERE delivery_id = ?').get('delivery_outbox_fail_002') as any;
    expect(rowAfterAttempt1.attempts).toBe(1);
    expect(rowAfterAttempt1.status).toBe('PENDING');
    expect(rowAfterAttempt1.last_error).toContain('Discord Gateway unavailable (503)');

    // Immediate second call should be skipped because backoff window is active
    const processedImmediate = await notificationService.processOutboxBatch(10);
    expect(processedImmediate).toBe(0);

    // Advance time past the 100ms baseBackoff window
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Restore Discord service
    discordSender.shouldFail = false;

    // Attempt 2: Succeeds
    const processed2 = await notificationService.processOutboxBatch(10);
    expect(processed2).toBe(1);

    const rowAfterSuccess = db.prepare('SELECT status, processed_at FROM outbox_deliveries WHERE delivery_id = ?').get('delivery_outbox_fail_002') as any;
    expect(rowAfterSuccess.status).toBe('PROCESSED');
    expect(rowAfterSuccess.processed_at).toBeDefined();
  });

  it('transitions delivery to DEAD_LETTER after maxAttempts reached', async () => {
    const payload = JSON.stringify({
      action: 'opened',
      issue: {
        number: 103,
        title: 'Persistent Failure Issue',
        html_url: 'https://github.com/testowner/testrepo/issues/103',
        user: { login: 'dev_user' },
      },
    });

    await notificationService.ingestWebhook('delivery_deadletter_003', 'issues', payload);
    discordSender.shouldFail = true;
    discordSender.failureError = new Error('Rate limit exhausted');

    // Attempt 1 (attempts becomes 1, status PENDING)
    await notificationService.processOutboxBatch(10);
    await new Promise((r) => setTimeout(r, 120));

    // Attempt 2 (attempts becomes 2, status PENDING)
    await notificationService.processOutboxBatch(10);
    await new Promise((r) => setTimeout(r, 220));

    // Attempt 3 (attempts becomes 3 >= maxAttempts 3 -> DEAD_LETTER)
    await notificationService.processOutboxBatch(10);

    const row = db.prepare('SELECT attempts, status, last_error FROM outbox_deliveries WHERE delivery_id = ?').get('delivery_deadletter_003') as any;
    expect(row.attempts).toBe(3);
    expect(row.status).toBe('DEAD_LETTER');
    expect(row.last_error).toContain('Rate limit exhausted');

    // Dead letter records are no longer fetched as pending
    const pending = await outboxRepo.fetchPendingDeliveries(10);
    expect(pending).toHaveLength(0);
  });

  it('respects batch size limits when processing large queues', async () => {
    // Insert 15 items
    for (let i = 1; i <= 15; i++) {
      const payload = JSON.stringify({
        action: 'opened',
        issue: { number: 200 + i, title: `Batch Issue #${i}`, html_url: 'https://example.com' },
      });
      await notificationService.ingestWebhook(`delivery_batch_${i}`, 'issues', payload);
    }

    // Process batch with limit 10
    const processedFirst = await notificationService.processOutboxBatch(10);
    expect(processedFirst).toBe(10);
    expect(discordSender.sentNotifications).toHaveLength(10);

    // Remaining pending items should be exactly 5
    let remaining = await outboxRepo.fetchPendingDeliveries(20);
    expect(remaining).toHaveLength(5);

    // Process remainder
    const processedSecond = await notificationService.processOutboxBatch(10);
    expect(processedSecond).toBe(5);
    expect(discordSender.sentNotifications).toHaveLength(15);

    remaining = await outboxRepo.fetchPendingDeliveries(20);
    expect(remaining).toHaveLength(0);
  });

  it('handles corrupted JSON payload gracefully by failing delivery', async () => {
    // Insert directly corrupted JSON
    await outboxRepo.enqueueDelivery('delivery_corrupt_json', 'issues', 'NOT_VALID_JSON{]');

    const processed = await notificationService.processOutboxBatch(10);
    expect(processed).toBe(0);

    const row = db.prepare('SELECT attempts, status, last_error FROM outbox_deliveries WHERE delivery_id = ?').get('delivery_corrupt_json') as any;
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('Corrupted payload JSON');
  });

  it('manages background polling worker lifecycle (startWorker, stopWorker, isWorkerRunning)', () => {
    expect(notificationService.isWorkerRunning).toBe(false);

    notificationService.startWorker(5000);
    expect(notificationService.isWorkerRunning).toBe(true);

    // Calling start again is idempotent
    notificationService.startWorker(5000);
    expect(notificationService.isWorkerRunning).toBe(true);

    notificationService.stopWorker();
    expect(notificationService.isWorkerRunning).toBe(false);
  });
});
