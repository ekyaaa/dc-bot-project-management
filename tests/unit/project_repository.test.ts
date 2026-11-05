import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import { Migrator } from '../../src/infrastructure/persistence/migrator.js';
import { ProjectRepository } from '../../src/infrastructure/persistence/repositories/ProjectRepository.js';

describe('ProjectRepository & Multi-Project Schema', () => {
  let db: DatabaseInstance;
  let repo: ProjectRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    const migrator = new Migrator(db);
    migrator.runMigrations();
    repo = new ProjectRepository(db);
  });

  afterEach(() => {
    if (db && db.open) {
      db.close();
    }
  });

  it('contains the auto-seeded Eva Ecosystem project and guild permission', () => {
    const projects = repo.getAllProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);

    const eva = repo.getProjectById('eva-ecosystem');
    expect(eva).toBeDefined();
    expect(eva?.name).toBe('Eva Ecosystem');
    expect(eva?.github_owner).toBe('Nexa-Code-Studio');
    expect(eva?.github_repo).toBe('eva-ecosystem');
    expect(eva?.project_number).toBe(2);

    const guildProjects = repo.getProjectsForGuild('1374691978230366240');
    expect(guildProjects.length).toBe(1);
    expect(guildProjects[0].id).toBe('eva-ecosystem');
    expect(guildProjects[0].notification_channel_id).toBe('1567466308789076048');
    expect(guildProjects[0].is_default).toBe(true);

    const defaultProj = repo.getDefaultProjectForGuild('1374691978230366240');
    expect(defaultProj?.id).toBe('eva-ecosystem');

    const channelProj = repo.getProjectForChannel('1374691978230366240', '1567466308789076048');
    expect(channelProj?.id).toBe('eva-ecosystem');

    const unknownChannel = repo.getProjectForChannel('1374691978230366240', '999999999999999999');
    expect(unknownChannel).toBeNull();
  });

  it('can create, update, and delete new projects', () => {
    repo.createOrUpdateProject({
      id: 'project-two',
      name: 'Second Repo',
      github_owner: 'org-test',
      github_repo: 'repo-two',
      project_number: 42,
      description: 'Second test repo',
    });

    const fetched = repo.getProjectById('project-two');
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe('Second Repo');
    expect(fetched?.project_number).toBe(42);

    repo.createOrUpdateProject({
      id: 'project-two',
      name: 'Second Repo Updated',
      github_owner: 'org-test',
      github_repo: 'repo-two',
      project_number: 43,
      description: 'Updated desc',
    });

    const updated = repo.getProjectById('project-two');
    expect(updated?.name).toBe('Second Repo Updated');
    expect(updated?.project_number).toBe(43);

    repo.deleteProject('project-two');
    expect(repo.getProjectById('project-two')).toBeNull();
  });

  it('can set, switch default, and remove guild permissions', () => {
    repo.createOrUpdateProject({
      id: 'alpha',
      name: 'Alpha Project',
      github_owner: 'org',
      github_repo: 'alpha-repo',
      project_number: 1,
    });
    repo.createOrUpdateProject({
      id: 'beta',
      name: 'Beta Project',
      github_owner: 'org',
      github_repo: 'beta-repo',
      project_number: 2,
    });

    repo.setGuildPermission({
      guild_id: 'guild-999',
      project_id: 'alpha',
      notification_channel_id: 'channel-alpha',
      is_default: true,
    });

    expect(repo.getDefaultProjectForGuild('guild-999')?.id).toBe('alpha');

    // Setting beta as default should switch default from alpha to beta
    repo.setGuildPermission({
      guild_id: 'guild-999',
      project_id: 'beta',
      notification_channel_id: 'channel-beta',
      is_default: true,
    });

    const guildProjects = repo.getProjectsForGuild('guild-999');
    expect(guildProjects.length).toBe(2);
    expect(repo.getDefaultProjectForGuild('guild-999')?.id).toBe('beta');

    repo.removeGuildPermission('guild-999', 'beta');
    const remaining = repo.getProjectsForGuild('guild-999');
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe('alpha');
  });

  it('finds notification targets for a given repo owner and repo name', () => {
    const targets = repo.getNotificationTargetsForRepo('nexa-code-studio', 'eva-ecosystem');
    expect(targets.length).toBe(1);
    expect(targets[0].guild_id).toBe('1374691978230366240');
    expect(targets[0].notification_channel_id).toBe('1567466308789076048');
  });
});
