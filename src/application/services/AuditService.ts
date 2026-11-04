import type { IAuditRepository, AuditEntry } from '../ports/IRepositories.js';
import type { AuditAction, AuditOutcome } from '../../domain/types.js';

export interface LogMutationParams {
  actorDiscordId: string;
  actorGithubId?: number | null;
  actorGithubLogin?: string | null;
  action: AuditAction;
  targetIssueNumber?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  outcome: AuditOutcome;
  errorReason?: string | null;
  correlationId?: string | null;
}

const SENSITIVE_KEY_REGEX =
  /(token|secret|key|password|authorization|privatekey|accesstoken|refreshtoken|codeverifier|cookie|credential)/i;

const GITHUB_TOKEN_REGEX = /(gh[uoprse]_[A-Za-z0-9_]{36,}|Bearer\s+[A-Za-z0-9._-]+)/gi;

export class AuditService {
  constructor(private readonly auditRepo: IAuditRepository) {}

  public async logMutation(params: LogMutationParams): Promise<void> {
    const sanitizedBefore = params.beforeState
      ? (this.deepSanitize(params.beforeState) as Record<string, unknown>)
      : null;
    const sanitizedAfter = params.afterState
      ? (this.deepSanitize(params.afterState) as Record<string, unknown>)
      : null;
    const sanitizedReason = params.errorReason
      ? this.sanitizeString(params.errorReason)
      : null;

    const entry: AuditEntry = {
      actorDiscordId: params.actorDiscordId,
      actorGithubId: params.actorGithubId ?? null,
      actorGithubLogin: params.actorGithubLogin ?? null,
      action: params.action,
      targetIssueNumber: params.targetIssueNumber ?? null,
      beforeState: sanitizedBefore,
      afterState: sanitizedAfter,
      outcome: params.outcome,
      errorReason: sanitizedReason,
      correlationId: params.correlationId ?? null,
    };

    try {
      await this.auditRepo.recordAudit(entry);
    } catch (err) {
      // Audit failure must never crash core transaction, but should log error
      console.error('[AuditService] Failed to record audit log:', err);
    }
  }

  public deepSanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return this.sanitizeString(obj);
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepSanitize(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.deepSanitize(value);
      }
    }
    return sanitized;
  }

  public sanitizeString(str: string): string {
    return str.replace(GITHUB_TOKEN_REGEX, '[REDACTED]');
  }
}
