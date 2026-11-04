import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ICryptoService } from '../../../application/ports/ICryptoService.js';
import type { IOutboxRepository } from '../../../application/ports/IRepositories.js';

export interface WebhookRouteOptions {
  cryptoService: ICryptoService;
  webhookSecret: string;
  outboxRepository: IOutboxRepository;
  onDeliveryEnqueued?: (deliveryId: string, eventType: string) => void;
}

export function registerWebhookRoutes(app: FastifyInstance, options: WebhookRouteOptions): void {
  app.post(
    '/webhooks/github',
    {
      config: {
        rawBody: true, // Crucial: triggers fastify-raw-body Buffer capture
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signatureHeader = request.headers['x-hub-signature-256'];
      const deliveryId = request.headers['x-github-delivery'];
      const eventType = request.headers['x-github-event'];

      // 1. Validate signature header presence
      if (!signatureHeader || typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Missing or malformed X-Hub-Signature-256 header',
        });
      }

      // 2. Validate raw body presence
      const rawBody = request.rawBody;
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Missing or unreadable request body for signature verification',
        });
      }

      // 3. Constant-time HMAC SHA-256 verification
      const isValid = options.cryptoService.verifyHmacSha256(
        rawBody,
        signatureHeader,
        options.webhookSecret,
      );

      if (!isValid) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Invalid HMAC SHA-256 signature',
        });
      }

      // 4. Validate X-GitHub-Delivery header
      if (!deliveryId || typeof deliveryId !== 'string' || deliveryId.trim().length === 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid X-GitHub-Delivery header',
        });
      }

      // 5. Validate X-GitHub-Event header
      if (!eventType || typeof eventType !== 'string' || eventType.trim().length === 0) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Missing or invalid X-GitHub-Event header',
        });
      }

      const cleanDeliveryId = deliveryId.trim();
      const cleanEventType = eventType.trim();
      const payloadJson = rawBody.toString('utf8');

      // 6. Persist into SQLite Outbox with atomic deduplication
      const isNew = await options.outboxRepository.enqueueDelivery(
        cleanDeliveryId,
        cleanEventType,
        payloadJson,
      );

      if (isNew) {
        if (options.onDeliveryEnqueued) {
          try {
            options.onDeliveryEnqueued(cleanDeliveryId, cleanEventType);
          } catch {
            // Callback execution must not fail HTTP response
          }
        }
        return reply.code(202).send({
          status: 'enqueued',
          deliveryId: cleanDeliveryId,
          eventType: cleanEventType,
        });
      } else {
        return reply.code(200).send({
          status: 'duplicate_acknowledged',
          deliveryId: cleanDeliveryId,
          eventType: cleanEventType,
        });
      }
    },
  );
}
