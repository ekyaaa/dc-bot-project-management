/**
 * Base domain error class.
 */
export abstract class DomainError extends Error {
  public abstract readonly code: string;
  public readonly isOperational: boolean = true;
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Configuration errors (missing env, unreadable secrets, invalid format).
 * MUST NOT leak secret values.
 */
export class ConfigurationError extends DomainError {
  public readonly code = 'CONFIGURATION_ERROR';
}

/**
 * Unauthorized access errors (unlinked identity, wrong guild/channel, insufficient repo permissions).
 */
export class UnauthorizedError extends DomainError {
  public readonly code = 'UNAUTHORIZED';
}

/**
 * Resource not found errors (issue, identity, project item).
 */
export class NotFoundError extends DomainError {
  public readonly code = 'NOT_FOUND';
}

/**
 * Concurrency conflict and stale state errors (state changed between preview and confirmation).
 */
export class ConflictError extends DomainError {
  public readonly code = 'CONFLICT';
}

/**
 * Validation errors (malformed inputs, missing blocker reasons, invalid options).
 */
export class ValidationError extends DomainError {
  public readonly code = 'VALIDATION_ERROR';
}

/**
 * GitHub App lacks Projects v2 permissions.
 * Mandated by DISCORD_PROJECT_BOT.md § 5.1 l. 205.
 */
export class PendingPermissionError extends DomainError {
  public readonly code = 'PENDING_PERMISSION';
}

/**
 * Rate limit errors (Discord 429, GitHub secondary rate limits).
 */
export class RateLimitError extends DomainError {
  public readonly code = 'RATE_LIMIT_EXCEEDED';
  public readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number, details?: Record<string, unknown>) {
    super(message, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * External API failures (GitHub 5xx, network timeouts).
 */
export class ExternalApiError extends DomainError {
  public readonly code = 'EXTERNAL_API_ERROR';
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number, details?: Record<string, unknown>) {
    super(message, details);
    this.statusCode = statusCode;
  }
}
