import { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import type {
  IOutboxRepository,
  OutboxRecord,
} from '../../../application/ports/IRepositories.js';

interface RawOutboxRow {
  id: number;
  delivery_id: string;
  event_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

export class OutboxRepository implements IOutboxRepository {
  private readonly stmtEnqueue: Statement;
  private readonly stmtFetchPending: Statement;
  private readonly stmtMarkProcessed: Statement;
  private readonly stmtRecordFailure: Statement;

  constructor(db: DatabaseInstance) {
    this.stmtEnqueue = db.prepare(`
      INSERT INTO outbox_deliveries (
        delivery_id,
        event_type,
        payload_json,
        status,
        attempts,
        created_at
      ) VALUES (?, ?, ?, 'PENDING', 0, CURRENT_TIMESTAMP)
      ON CONFLICT(delivery_id) DO NOTHING;
    `);

    this.stmtFetchPending = db.prepare(`
      SELECT
        id,
        delivery_id,
        event_type,
        payload_json,
        status,
        attempts,
        max_attempts,
        last_error,
        created_at,
        processed_at
      FROM outbox_deliveries
      WHERE status = 'PENDING'
      ORDER BY id ASC
      LIMIT ?;
    `);

    this.stmtMarkProcessed = db.prepare(`
      UPDATE outbox_deliveries
      SET status = 'PROCESSED', processed_at = CURRENT_TIMESTAMP
      WHERE id = ?;
    `);

    this.stmtRecordFailure = db.prepare(`
      UPDATE outbox_deliveries
      SET
        attempts = attempts + 1,
        last_error = @error,
        status = CASE WHEN attempts + 1 >= @maxAttempts THEN 'DEAD_LETTER' ELSE 'PENDING' END
      WHERE id = @id;
    `);
  }

  public async enqueueDelivery(deliveryId: string, eventType: string, payloadJson: string): Promise<boolean> {
    const info = this.stmtEnqueue.run(deliveryId, eventType, payloadJson);
    return info.changes > 0;
  }

  public async fetchPendingDeliveries(limit: number): Promise<OutboxRecord[]> {
    const rows = this.stmtFetchPending.all(limit) as RawOutboxRow[];
    return rows.map((r) => this.mapRow(r));
  }

  public async markProcessed(id: number): Promise<void> {
    this.stmtMarkProcessed.run(id);
  }

  public async recordFailure(id: number, error: string, maxAttempts: number): Promise<void> {
    this.stmtRecordFailure.run({
      id,
      error,
      maxAttempts,
    });
  }

  private mapRow(row: RawOutboxRow): OutboxRecord {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      status: row.status as OutboxRecord['status'],
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}
