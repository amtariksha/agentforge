import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './admin/auth/routes.js';
import { tenantRoutes } from './admin/tenants/routes.js';
import { whatsappWebhookRoutes } from './gateway/whatsapp/webhook.js';
import { sseRoutes } from './gateway/sse.js';
import { hitlRoutes } from './admin/hitl/approval-queue.js';
import { liveChatRoutes } from './admin/live-chat/manager.js';
import { ticketRoutes } from './admin/tickets/routes.js';
import { correctionRoutes } from './admin/corrections/routes.js';
import { humanAgentRoutes } from './admin/agents/routes.js';
import { telegramWebhookRoutes } from './gateway/telegram/webhook.js';
import { mobileApiRoutes } from './gateway/mobile/routes.js';
import { conversationRoutes } from './admin/conversations/routes.js';
import { analyticsRoutes } from './admin/analytics/routes.js';
import { agentTypeRoutes } from './admin/agent-types/routes.js';
import { toolRoutes } from './admin/tools/routes.js';
import { guardrailRoutes } from './admin/guardrails/routes.js';
import { webhookAdminRoutes } from './admin/webhooks/routes.js';
import { knowledgeBaseRoutes } from './memory/knowledge-base.js';
import { initializeGateway } from './tools/tenant-gateway/registry.js';
import { logger } from './shared/utils/logger.js';
import { redis } from './shared/redis.js';
import { pool } from './shared/db.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  // Raw body needed for WhatsApp webhook signature verification
  bodyLimit: 1048576, // 1MB
});

async function start() {
  // Plugins
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Initialize tenant gateway
  await initializeGateway();

  // Register routes
  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(whatsappWebhookRoutes);
  await app.register(sseRoutes);
  await app.register(hitlRoutes);
  await app.register(liveChatRoutes);
  await app.register(ticketRoutes);
  await app.register(correctionRoutes);
  await app.register(humanAgentRoutes);
  await app.register(telegramWebhookRoutes);
  await app.register(mobileApiRoutes);
  await app.register(conversationRoutes);
  await app.register(analyticsRoutes);
  await app.register(agentTypeRoutes);
  await app.register(toolRoutes);
  await app.register(guardrailRoutes);
  await app.register(webhookAdminRoutes);
  await app.register(knowledgeBaseRoutes);

  // Global error handler
  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, _request, reply) => {
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation Error',
        message: error.message,
        details: error.validation,
      });
    }

    // Zod errors
    if (error.name === 'ZodError') {
      return reply.status(400).send({
        error: 'Validation Error',
        message: 'Invalid request data',
        details: JSON.parse(error.message),
      });
    }

    app.log.error(error);
    return reply.status(error.statusCode ?? 500).send({
      error: error.name ?? 'Internal Server Error',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : error.message,
    });
  });

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info({ signal }, 'Shutting down gracefully');
      await app.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  }

  const host = process.env.HOST ?? '0.0.0.0';
  const port = parseInt(process.env.PORT ?? '3000', 10);

  await app.listen({ host, port });
  app.log.info(`AgentForge server running at http://${host}:${port}`);
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
