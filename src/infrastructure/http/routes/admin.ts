import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { Config } from '../../../config/env.js';
import type { ProjectRepository } from '../../persistence/repositories/ProjectRepository.js';
import { AdminAuthManager } from '../auth/adminAuth.js';
import { renderLoginPage, renderDashboardPage } from '../views/adminDashboard.js';
import { registerGuildSlashCommands } from '../../../interfaces/discord/commands/registry.js';

export interface AdminRouteOptions extends FastifyPluginOptions {
  config: Pick<Config, 'DISCORD_APPLICATION_ID' | 'DISCORD_BOT_TOKEN'>;
  projectRepository: ProjectRepository;
  authManager?: AdminAuthManager;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: AdminRouteOptions,
): Promise<void> {
  const authManager = options.authManager ?? new AdminAuthManager();
  const repo = options.projectRepository;
  const config = options.config;

  // 1. Login Page
  app.get('/admin/login', async (_request, reply) => {
    reply.type('text/html');
    return reply.send(renderLoginPage());
  });

  // 2. Login API
  app.post<{
    Body: { username?: string; password?: string };
  }>('/admin/api/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'Username dan password wajib diisi.' });
    }

    const isValid = authManager.verifyCredentials(username, password);
    if (!isValid) {
      return reply.code(401).send({ error: 'Username atau password salah.' });
    }

    const token = authManager.createSessionToken(username);
    reply.header(
      'Set-Cookie',
      `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`,
    );

    return reply.code(200).send({ ok: true, username });
  });

  // 3. Logout API
  app.post('/admin/api/logout', async (_request, reply) => {
    reply.header(
      'Set-Cookie',
      'admin_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax',
    );
    return reply.code(200).send({ ok: true });
  });

  // 4. Protected Sub-router for Admin Dashboard & APIs
  await app.register(async (adminScope) => {
    adminScope.addHook('preHandler', authManager.createAuthHook());

    // Dashboard HTML
    adminScope.get('/admin', async (request, reply) => {
      const username = (request as unknown as { adminUser?: string }).adminUser || 'mashupsoat';
      reply.type('text/html');
      return reply.send(renderDashboardPage(username));
    });

    // List Projects
    adminScope.get('/admin/api/projects', async (_request, reply) => {
      const projects = repo.getAllProjects();
      return reply.code(200).send(projects);
    });

    // Create / Update Project
    adminScope.post<{
      Body: {
        id: string;
        name: string;
        github_owner: string;
        github_repo: string;
        project_number: number;
        description?: string | null;
      };
    }>('/admin/api/projects', async (request, reply) => {
      const body = request.body;
      if (!body.id || !body.name || !body.github_owner || !body.github_repo || !body.project_number) {
        return reply.code(400).send({ error: 'Field id, name, github_owner, github_repo, dan project_number wajib diisi.' });
      }

      repo.createOrUpdateProject({
        id: body.id,
        name: body.name,
        github_owner: body.github_owner,
        github_repo: body.github_repo,
        project_number: Number(body.project_number),
        description: body.description ?? null,
      });

      return reply.code(200).send({ ok: true });
    });

    // Delete Project
    adminScope.delete<{
      Params: { id: string };
    }>('/admin/api/projects/:id', async (request, reply) => {
      repo.deleteProject(request.params.id);
      return reply.code(200).send({ ok: true });
    });

    // List Guild Permissions
    adminScope.get('/admin/api/permissions', async (_request, reply) => {
      const permissions = repo.getAllGuildPermissions();
      return reply.code(200).send(permissions);
    });

    // Link Guild Permission
    adminScope.post<{
      Body: {
        guild_id: string;
        project_id: string;
        notification_channel_id?: string | null;
        is_default?: boolean;
      };
    }>('/admin/api/permissions', async (request, reply) => {
      const body = request.body;
      if (!body.guild_id || !body.project_id) {
        return reply.code(400).send({ error: 'Guild ID dan Project ID wajib diisi.' });
      }

      repo.setGuildPermission({
        guild_id: body.guild_id,
        project_id: body.project_id,
        notification_channel_id: body.notification_channel_id ?? null,
        is_default: Boolean(body.is_default),
      });

      return reply.code(200).send({ ok: true });
    });

    // Delete Guild Permission
    adminScope.delete<{
      Params: { guildId: string; projectId: string };
    }>('/admin/api/permissions/:guildId/:projectId', async (request, reply) => {
      repo.removeGuildPermission(request.params.guildId, request.params.projectId);
      return reply.code(200).send({ ok: true });
    });

    // Instant Sync Slash Commands to Guild (Supports both POST & GET)
    const handleSyncCommands = async (
      request: { params: { guildId: string } },
      reply: any,
    ) => {
      const guildId = request.params.guildId;
      try {
        const result = await registerGuildSlashCommands({
          DISCORD_APPLICATION_ID: config.DISCORD_APPLICATION_ID,
          DISCORD_GUILD_ID: guildId,
          DISCORD_BOT_TOKEN: config.DISCORD_BOT_TOKEN,
        });
        return reply.code(200).send({ ok: true, registeredCount: result.registeredCount, guildId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: `Gagal sinkronisasi command ke guild: ${message}` });
      }
    };

    adminScope.post<{ Params: { guildId: string } }>('/admin/api/sync-commands/:guildId', handleSyncCommands);
    adminScope.get<{ Params: { guildId: string } }>('/admin/api/sync-commands/:guildId', handleSyncCommands);
  });
}
