import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { ProjectRepository } from '../../src/infrastructure/persistence/repositories/ProjectRepository.js';
import { createHttpServer } from '../../src/infrastructure/http/server.js';
import { AdminAuthManager } from '../../src/infrastructure/http/auth/adminAuth.js';

describe('Admin Dashboard & API Routes', () => {
  let db: DatabaseInstance;
  let projectRepo: ProjectRepository;
  let authManager: AdminAuthManager;

  beforeEach(() => {
    db = new Database(':memory:');
    new Migrator(db).runMigrations();
    projectRepo = new ProjectRepository(db);
    authManager = new AdminAuthManager({
      username: 'mashupsoat',
      rawPassword: 'password123',
    });
  });

  afterEach(() => {
    if (db && db.open) {
      db.close();
    }
  });

  it('renders login page on GET /admin/login', async () => {
    const app = await createHttpServer({
      adminRouteOptions: {
        config: {
          DISCORD_APPLICATION_ID: '123',
          DISCORD_BOT_TOKEN: 'fake_token',
        },
        projectRepository: projectRepo,
        authManager,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/login',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Bot Management HQ');
  });

  it('rejects invalid login credentials and accepts valid ones', async () => {
    const app = await createHttpServer({
      adminRouteOptions: {
        config: {
          DISCORD_APPLICATION_ID: '123',
          DISCORD_BOT_TOKEN: 'fake_token',
        },
        projectRepository: projectRepo,
        authManager,
      },
    });

    // Wrong password
    const failRes = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { username: 'mashupsoat', password: 'wrongpassword' },
    });
    expect(failRes.statusCode).toBe(401);

    // Correct credentials
    const okRes = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      payload: { username: 'mashupsoat', password: 'password123' },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers['set-cookie']).toContain('admin_session=');
  });

  it('protects /admin and /admin/api routes from unauthenticated access', async () => {
    const app = await createHttpServer({
      adminRouteOptions: {
        config: {
          DISCORD_APPLICATION_ID: '123',
          DISCORD_BOT_TOKEN: 'fake_token',
        },
        projectRepository: projectRepo,
        authManager,
      },
    });

    // HTML dashboard redirects to login
    const dashRes = await app.inject({
      method: 'GET',
      url: '/admin',
    });
    expect(dashRes.statusCode).toBe(302);
    expect(dashRes.headers.location).toBe('/admin/login');

    // API returns 401 JSON
    const apiRes = await app.inject({
      method: 'GET',
      url: '/admin/api/projects',
    });
    expect(apiRes.statusCode).toBe(401);
  });

  it('allows full project and permission management with authenticated session', async () => {
    const app = await createHttpServer({
      adminRouteOptions: {
        config: {
          DISCORD_APPLICATION_ID: '123',
          DISCORD_BOT_TOKEN: 'fake_token',
        },
        projectRepository: projectRepo,
        authManager,
      },
    });

    const sessionToken = authManager.createSessionToken('mashupsoat');
    const cookieHeader = `admin_session=${encodeURIComponent(sessionToken)}`;

    // GET /admin with session
    const dashRes = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: cookieHeader },
    });
    expect(dashRes.statusCode).toBe(200);
    expect(dashRes.body).toContain('Discord Bot HQ');

    // GET /admin/api/projects
    const projRes = await app.inject({
      method: 'GET',
      url: '/admin/api/projects',
      headers: { cookie: cookieHeader },
    });
    expect(projRes.statusCode).toBe(200);
    const projects = JSON.parse(projRes.body);
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects[0].id).toBe('eva-ecosystem');

    // POST /admin/api/projects (create new)
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/api/projects',
      headers: { cookie: cookieHeader },
      payload: {
        id: 'new-app',
        name: 'New App',
        github_owner: 'TestOrg',
        github_repo: 'test-repo',
        project_number: 5,
      },
    });
    expect(createRes.statusCode).toBe(200);

    // POST /admin/api/permissions (link guild)
    const permRes = await app.inject({
      method: 'POST',
      url: '/admin/api/permissions',
      headers: { cookie: cookieHeader },
      payload: {
        guild_id: '9988776655',
        project_id: 'new-app',
        notification_channel_id: '112233',
        is_default: true,
      },
    });
    expect(permRes.statusCode).toBe(200);

    // Verify permission persisted
    const permListRes = await app.inject({
      method: 'GET',
      url: '/admin/api/permissions',
      headers: { cookie: cookieHeader },
    });
    expect(permListRes.statusCode).toBe(200);
    const perms = JSON.parse(permListRes.body);
    const matched = perms.find((p: { guild_id: string }) => p.guild_id === '9988776655');
    expect(matched).toBeDefined();
    expect(matched.project_id).toBe('new-app');
  });
});
