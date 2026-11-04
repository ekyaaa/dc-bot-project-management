import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { HandleOAuthCallbackUseCase } from '../../../application/usecases/HandleOAuthCallbackUseCase.js';
import { DomainError, ExternalApiError } from '../../../domain/errors.js';

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export interface AuthRouteOptions {
  handleOAuthCallbackUseCase: HandleOAuthCallbackUseCase;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  app.get(
    '/auth/github/callback',
    async (req: FastifyRequest<{ Querystring: CallbackQuery }>, reply: FastifyReply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none';",
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');

      const { code, state, error, error_description } = req.query;

      // Handle user cancellation or GitHub errors
      if (error) {
        const errorMsg = error_description || error;
        return reply.code(400).send(
          renderErrorHtml(
            'Authorization Cancelled',
            `GitHub reported: ${escapeHtml(errorMsg)}. Run <code>/account connect</code> in Discord to try again.`,
          ),
        );
      }

      try {
        const result = await options.handleOAuthCallbackUseCase.execute({ code, state });

        return reply
          .code(200)
          .send(renderSuccessHtml(result.githubLogin, result.githubUserId, result.avatarUrl));
      } catch (err) {
        let statusCode = 400;
        let title = 'Authentication Failed';
        let message = 'An unexpected error occurred during authorization.';

        if (err instanceof ExternalApiError) {
          statusCode = err.statusCode ?? 502;
          title = 'GitHub Authentication Error';
          message = err.message;
        } else if (err instanceof DomainError) {
          statusCode = 400;
          title = 'Authorization Failed';
          message = err.message;
        } else if (err instanceof Error) {
          message = err.message;
        }

        return reply.code(statusCode).send(renderErrorHtml(title, escapeHtml(message)));
      }
    },
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSuccessHtml(login: string, id: number, avatarUrl?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Account Successfully Connected | Discord Project Bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; color: #58a6ff; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.5; color: #8b949e; margin: 0 0 20px; }
    .profile { display: inline-flex; align-items: center; gap: 12px; background: #21262d; border: 1px solid #30363d; border-radius: 8px; padding: 10px 16px; margin-bottom: 24px; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; border: 1px solid #30363d; }
    .user-info { text-align: left; }
    .user-login { font-weight: 600; color: #f0f6fc; font-size: 15px; }
    .user-id { font-size: 12px; color: #8b949e; }
    .badge { display: inline-block; background: #238636; color: #fff; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 16px; }
    .hint { font-size: 13px; color: #8b949e; border-top: 1px solid #21262d; padding-top: 16px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <div class="badge">Verified Connection</div>
    <h1>Account Successfully Connected</h1>
    <p>Your Discord account is now linked to your GitHub account.</p>
    <div class="profile">
      ${avatarUrl ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="Avatar">` : ''}
      <div class="user-info">
        <div class="user-login">@${escapeHtml(login)}</div>
        <div class="user-id">Numeric ID: ${id}</div>
      </div>
    </div>
    <div class="hint">You can safely close this window and return to Discord to use project commands.</div>
  </div>
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} | Discord Project Bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #161b22; border: 1px solid #da3633; border-radius: 12px; padding: 32px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; color: #f85149; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.5; color: #c9d1d9; margin: 0 0 20px; }
    .hint { font-size: 13px; color: #8b949e; border-top: 1px solid #30363d; padding-top: 16px; margin-top: 16px; }
    code { background: #21262d; padding: 2px 6px; border-radius: 4px; color: #58a6ff; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    <div class="hint">Please return to Discord and run <code>/account connect</code> to initiate a new authorization session.</div>
  </div>
</body>
</html>`;
}
