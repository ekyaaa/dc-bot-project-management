import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import type { ICryptoService } from '../../application/ports/ICryptoService.js';
import type { HandleOAuthCallbackUseCase } from '../../application/usecases/HandleOAuthCallbackUseCase.js';
import { registerAuthRoutes, type AuthRouteOptions } from './routes/auth.js';
import { registerWebhookRoutes, type WebhookRouteOptions } from './routes/webhooks.js';

export interface IDatabaseHealthCheck {
  healthCheck?(): boolean;
  checkHealth?(): boolean;
}

export type DatabaseTarget =
  | IDatabaseHealthCheck
  | { prepare: (sql: string) => { get: () => unknown } };

export interface HttpServerOptions {
  port?: number;
  host?: string;
  database?: DatabaseTarget;
  cryptoService?: ICryptoService;
  fastifyOptions?: FastifyServerOptions;
  authRouteOptions?: AuthRouteOptions;
  handleOAuthCallbackUseCase?: HandleOAuthCallbackUseCase;
  webhookRouteOptions?: WebhookRouteOptions;
}

export async function createHttpServer(options: HttpServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.fastifyOptions?.logger ?? false,
    trustProxy: options.fastifyOptions?.trustProxy ?? true,
    ...options.fastifyOptions,
  });

  // Register raw body plugin (scoped with global: false so only routes requesting rawBody buffer it)
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: false, // delivers rawBody as Buffer
    runFirst: true,
  });

  // Liveness Check: verifies process is responsive
  app.get('/health/live', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness Check: verifies SQLite connectivity
  app.get('/health/ready', async (_request, reply) => {
    const timestamp = new Date().toISOString();

    if (!options.database) {
      return reply.code(200).send({
        status: 'ready',
        checks: {
          database: 'unconfigured',
        },
        timestamp,
      });
    }

    try {
      let isHealthy = false;

      if ('healthCheck' in options.database && typeof options.database.healthCheck === 'function') {
        isHealthy = options.database.healthCheck();
      } else if ('checkHealth' in options.database && typeof options.database.checkHealth === 'function') {
        isHealthy = options.database.checkHealth();
      } else if ('prepare' in options.database && typeof options.database.prepare === 'function') {
        const result = options.database.prepare('SELECT 1 as alive').get();
        isHealthy = result !== undefined && result !== null;
      }

      if (!isHealthy) {
        throw new Error('Database ping query did not return healthy response');
      }

      return reply.code(200).send({
        status: 'ready',
        checks: {
          database: 'healthy',
        },
        timestamp,
      });
    } catch (error) {
      app.log.error({ err: error }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'unhealthy',
        checks: {
          database: 'unhealthy',
        },
        error: 'Database connectivity check failed',
        timestamp,
      });
    }
  });

  // Register Auth Routes if configured
  if (options.authRouteOptions) {
    registerAuthRoutes(app, options.authRouteOptions);
  } else if (options.handleOAuthCallbackUseCase) {
    registerAuthRoutes(app, {
      handleOAuthCallbackUseCase: options.handleOAuthCallbackUseCase,
    });
  }

  // Register Webhook Routes if configured
  if (options.webhookRouteOptions) {
    registerWebhookRoutes(app, options.webhookRouteOptions);
  }

  return app;
}
