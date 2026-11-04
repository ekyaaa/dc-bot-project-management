import { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import crypto from 'node:crypto';
import type {
  AuditEntry,
  AuditRecord,
  IAuditRepository,
} from '../../../application/ports/IRepositories.js';

interface RawAuditRow {
  id: string;
  actor_discord_id: string;
  actor_github_id: number | null;
  actor_github_login: string | null;
  action: string;
  target_issue_number: number | null;
  before_state: string | null;
  after_state: string | null;
  outcome: string;
  error_reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export class AuditRepository implements IAuditRepository {
  private readonly stmtRecordAudit: Statement;
  private readonly stmtRecentAudits: Statement;

  constructor(db: DatabaseInstance) {
    this.stmtRecordAudit = db.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_discord_id,
        actor_github_id,
        actor_github_login,
        action,
        target_issue_number,
        before_state,
        after_state,
        outcome,
        error_reason,
        correlation_id,
        created_at
      ) VALUES (
        @id,
        @actorDiscordId,
        @actorGithubId,
        @actorGithubLogin,
        @action,
        @targetIssueNumber,
        @beforeState,
        @afterState,
        @outcome,
        @errorReason,
        @correlationId,
        CURRENT_TIMESTAMP
      );
    `);

    this.stmtRecentAudits = db.prepare(`
      SELECT
        id,
        actor_discord_id,
        actor_github_id,
        actor_github_login,
        action,
        target_issue_number,
        before_state,
        after_state,
        outcome,
        error_reason,
        correlation_id,
        created_at
      FROM audit_logs
      ORDER BY datetime(created_at) DESC
      LIMIT ?;
    `);
  }

  public async recordAudit(entry: AuditEntry): Promise<void> {
    const id = entry.id ?? crypto.randomUUID();
    const beforeStateJson = entry.beforeState ? JSON.stringify(entry.beforeState) : null;
    const afterStateJson = entry.afterState ? JSON.stringify(entry.afterState) : null;

    this.stmtRecordAudit.run({
      id,
      actorDiscordId: entry.actorDiscordId,
      actorGithubId: entry.actorGithubId ?? null,
      actorGithubLogin: entry.actorGithubLogin ?? null,
      action: entry.action,
      targetIssueNumber: entry.targetIssueNumber ?? null,
      beforeState: beforeStateJson,
      afterState: afterStateJson,
      outcome: entry.outcome,
      errorReason: entry.errorReason ?? null,
      correlationId: entry.correlationId ?? null,
    });
  }

  public async getRecentAudits(limit = 50): Promise<AuditRecord[]> {
    const rows = this.stmtRecentAudits.all(limit) as RawAuditRow[];
    return rows.map((r) => ({
      id: r.id,
      actorDiscordId: r.actor_discord_id,
      actorGithubId: r.actor_github_id,
      actorGithubLogin: r.actor_github_login,
      action: r.action,
      targetIssueNumber: r.target_issue_number,
      beforeState: r.before_state ? JSON.parse(r.before_state) : null,
      afterState: r.after_state ? JSON.parse(r.after_state) : null,
      outcome: r.outcome as AuditRecord['outcome'],
      errorReason: r.error_reason,
      correlationId: r.correlation_id,
      createdAt: r.created_at,
    }));
  }
}
