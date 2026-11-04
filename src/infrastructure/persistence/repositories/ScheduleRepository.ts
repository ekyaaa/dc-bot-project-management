import { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import type { IScheduleRepository } from '../../../application/ports/IRepositories.js';

export class ScheduleRepository implements IScheduleRepository {
  private readonly stmtAcquireLease: Statement;
  private readonly stmtIsExecuted: Statement;
  private readonly stmtRecordExecution: Statement;

  constructor(db: DatabaseInstance) {
    this.stmtAcquireLease = db.prepare(`
      INSERT INTO schedule_leases (
        lease_key,
        acquired_at,
        expires_at
      ) VALUES (
        ?,
        datetime('now'),
        datetime('now', ? || ' seconds')
      )
      ON CONFLICT(lease_key) DO UPDATE SET
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE datetime(schedule_leases.expires_at) <= datetime('now');
    `);

    this.stmtIsExecuted = db.prepare(`
      SELECT 1 FROM schedule_leases
      WHERE (job_key = ? AND date_str = ?)
         OR lease_key = 'exec:' || ? || ':' || ?
      LIMIT 1;
    `);

    this.stmtRecordExecution = db.prepare(`
      INSERT INTO schedule_leases (
        lease_key,
        job_key,
        date_str,
        acquired_at,
        expires_at
      ) VALUES (
        'exec:' || ? || ':' || ?,
        ?,
        ?,
        datetime('now'),
        '9999-12-31 23:59:59'
      )
      ON CONFLICT(lease_key) DO UPDATE SET
        job_key = excluded.job_key,
        date_str = excluded.date_str,
        acquired_at = datetime('now');
    `);
  }

  public async acquireLease(leaseKey: string, ttlSeconds: number): Promise<boolean> {
    const info = this.stmtAcquireLease.run(leaseKey, ttlSeconds);
    return info.changes > 0;
  }

  public async isExecutedForDate(jobKey: string, dateStr: string): Promise<boolean> {
    const row = this.stmtIsExecuted.get(jobKey, dateStr, jobKey, dateStr);
    return row !== undefined;
  }

  public async recordExecution(jobKey: string, dateStr: string): Promise<void> {
    this.stmtRecordExecution.run(jobKey, dateStr, jobKey, dateStr);
  }
}
