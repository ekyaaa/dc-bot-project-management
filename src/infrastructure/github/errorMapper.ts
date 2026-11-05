import {
  DomainError,
  PendingPermissionError,
  RateLimitError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ExternalApiError,
} from '../../domain/errors.js';

interface GraphQLErrorItem {
  message?: string;
  type?: string;
  path?: Array<string | number>;
}

interface RequestErrorLike {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: unknown;
  };
}

export function mapGitHubError(error: unknown, context?: string): Error {
  if (error instanceof DomainError) {
    return error;
  }

  // 1. Intercept GraphQL errors array
  if (
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray((error as { errors?: unknown[] }).errors)
  ) {
    const rawErrors = (error as { errors: GraphQLErrorItem[] }).errors;
    const messages = rawErrors.map((e) => e.message ?? '').join('; ');

    const isProjectV2PermissionError =
      messages.includes('Resource not accessible by integration') ||
      messages.includes('Viewer does not have permission') ||
      messages.includes('You must have write permissions') ||
      messages.includes("Field 'projectV2' doesn't exist") ||
      messages.includes('Could not resolve to a ProjectV2');

    if (isProjectV2PermissionError) {
      return new PendingPermissionError(
        `GitHub App lacks required permissions for GitHub Projects v2: ${messages}`,
        { context, rawErrors },
      );
    }

    if (messages.includes('Resource protected by organization SAML enforcement')) {
      return new PendingPermissionError(
        `Organisasi memerlukan otorisasi SAML/SSO untuk GitHub App: ${messages}`,
        { context, rawErrors },
      );
    }

    if (
      rawErrors.some((e) => e.type === 'NOT_FOUND') ||
      messages.toLowerCase().includes('could not resolve to a') ||
      messages.toLowerCase().includes('could not resolve to an')
    ) {
      return new NotFoundError(`GitHub resource not found: ${messages}`, { context, rawErrors });
    }

    if (
      rawErrors.some((e) => e.type === 'RATE_LIMITED') ||
      messages.toLowerCase().includes('rate limit') ||
      messages.toLowerCase().includes('secondary rate limit')
    ) {
      return new RateLimitError(
        `GitHub API rate limit exceeded. Silakan tunggu beberapa saat.`,
        60,
        { context, rawErrors },
      );
    }

    return new ExternalApiError(`GitHub GraphQL error: ${messages}`, 500, { context });
  }

  // 2. Intercept Octokit REST / HTTP errors
  if (error && typeof error === 'object' && 'status' in error) {
    const reqErr = error as RequestErrorLike;
    const status = reqErr.status;
    const headers = reqErr.response?.headers ?? {};
    const message = reqErr.message ?? '';

    if (status === 403 || status === 429) {
      const remaining = headers['x-ratelimit-remaining'];
      const isRateLimited =
        remaining === '0' ||
        message.toLowerCase().includes('rate limit') ||
        message.toLowerCase().includes('secondary rate limit');

      if (isRateLimited) {
        const resetHeader = headers['x-ratelimit-reset'];
        const retryHeader = headers['retry-after'];

        let retryAfterSeconds = 60;
        if (retryHeader) {
          const parsed = parseInt(retryHeader, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            retryAfterSeconds = parsed;
          }
        } else if (resetHeader) {
          const resetEpoch = parseInt(resetHeader, 10);
          if (!Number.isNaN(resetEpoch)) {
            const diff = resetEpoch - Math.floor(Date.now() / 1000);
            retryAfterSeconds = Math.max(1, diff);
          }
        }

        return new RateLimitError(
          `GitHub API rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
          retryAfterSeconds,
          { context },
        );
      }

      if (
        message.includes('Resource not accessible by integration') ||
        message.includes('Integration does not have permission')
      ) {
        return new PendingPermissionError(
          `GitHub App lacks required repository permissions: ${message}`,
          { context },
        );
      }
    }

    if (status === 404) {
      return new NotFoundError(`GitHub resource not found: ${message}`, { context });
    }

    if (status === 409) {
      return new ConflictError(`GitHub conflict error: ${message}`, { context });
    }

    if (status === 422) {
      return new ValidationError(`GitHub validation error: ${message}`, { context });
    }

    if (typeof status === 'number' && status >= 500) {
      return new ExternalApiError(
        `GitHub API server error (HTTP ${status}): ${message}`,
        status,
        { context },
      );
    }
  }

  if (error instanceof Error) {
    if (
      error.message.includes('ECONNRESET') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('fetch failed')
    ) {
      return new ExternalApiError(
        `Koneksi ke GitHub API terputus atau timeout: ${error.message}`,
        504,
        { context },
      );
    }
    return new ExternalApiError(`GitHub integration error: ${error.message}`, 500, { context });
  }

  return new ExternalApiError('Unknown GitHub integration error', 500, { context });
}
