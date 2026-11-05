import { Database as DatabaseInstance, Statement } from 'better-sqlite3';

export interface ProjectRecord {
  id: string;
  name: string;
  github_owner: string;
  github_repo: string;
  project_number: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuildPermissionRecord {
  guild_id: string;
  project_id: string;
  notification_channel_id: string | null;
  is_default: number;
  created_at: string;
  project_name?: string;
  github_owner?: string;
  github_repo?: string;
  project_number?: number;
}

export interface GuildBoundProject extends ProjectRecord {
  notification_channel_id: string | null;
  is_default: boolean;
}

export class ProjectRepository {
  private readonly stmtGetAllProjects: Statement;
  private readonly stmtGetProjectById: Statement;
  private readonly stmtGetProjectsForGuild: Statement;
  private readonly stmtGetDefaultProjectForGuild: Statement;
  private readonly stmtGetProjectForChannel: Statement;
  private readonly stmtInsertProject: Statement;
  private readonly stmtDeleteProject: Statement;
  private readonly stmtGetAllGuildPermissions: Statement;
  private readonly stmtInsertOrUpdatePermission: Statement;
  private readonly stmtClearDefaultPermission: Statement;
  private readonly stmtDeletePermission: Statement;
  private readonly stmtGetNotificationTargets: Statement;

  constructor(private readonly db: DatabaseInstance) {
    this.stmtGetAllProjects = db.prepare(`
      SELECT id, name, github_owner, github_repo, project_number, description, created_at, updated_at
      FROM projects
      ORDER BY name ASC;
    `);

    this.stmtGetProjectById = db.prepare(`
      SELECT id, name, github_owner, github_repo, project_number, description, created_at, updated_at
      FROM projects
      WHERE id = ?;
    `);

    this.stmtGetProjectsForGuild = db.prepare(`
      SELECT 
        p.id, p.name, p.github_owner, p.github_repo, p.project_number, p.description, p.created_at, p.updated_at,
        g.notification_channel_id, g.is_default
      FROM projects p
      JOIN guild_project_permissions g ON p.id = g.project_id
      WHERE g.guild_id = ?
      ORDER BY g.is_default DESC, p.name ASC;
    `);

    this.stmtGetDefaultProjectForGuild = db.prepare(`
      SELECT 
        p.id, p.name, p.github_owner, p.github_repo, p.project_number, p.description, p.created_at, p.updated_at,
        g.notification_channel_id, g.is_default
      FROM projects p
      JOIN guild_project_permissions g ON p.id = g.project_id
      WHERE g.guild_id = ? AND g.is_default = 1
      LIMIT 1;
    `);

    this.stmtGetProjectForChannel = db.prepare(`
      SELECT 
        p.id, p.name, p.github_owner, p.github_repo, p.project_number, p.description, p.created_at, p.updated_at,
        g.notification_channel_id, g.is_default
      FROM projects p
      JOIN guild_project_permissions g ON p.id = g.project_id
      WHERE g.guild_id = ? AND g.notification_channel_id = ?
      LIMIT 1;
    `);

    this.stmtInsertProject = db.prepare(`
      INSERT INTO projects (id, name, github_owner, github_repo, project_number, description)
      VALUES (@id, @name, @github_owner, @github_repo, @project_number, @description)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        github_owner = excluded.github_owner,
        github_repo = excluded.github_repo,
        project_number = excluded.project_number,
        description = excluded.description,
        updated_at = CURRENT_TIMESTAMP;
    `);

    this.stmtDeleteProject = db.prepare(`
      DELETE FROM projects WHERE id = ?;
    `);

    this.stmtGetAllGuildPermissions = db.prepare(`
      SELECT 
        g.guild_id, g.project_id, g.notification_channel_id, g.is_default, g.created_at,
        p.name AS project_name, p.github_owner, p.github_repo, p.project_number
      FROM guild_project_permissions g
      JOIN projects p ON g.project_id = p.id
      ORDER BY g.guild_id ASC, g.is_default DESC;
    `);

    this.stmtClearDefaultPermission = db.prepare(`
      UPDATE guild_project_permissions
      SET is_default = 0
      WHERE guild_id = ?;
    `);

    this.stmtInsertOrUpdatePermission = db.prepare(`
      INSERT INTO guild_project_permissions (guild_id, project_id, notification_channel_id, is_default)
      VALUES (@guild_id, @project_id, @notification_channel_id, @is_default)
      ON CONFLICT(guild_id, project_id) DO UPDATE SET
        notification_channel_id = excluded.notification_channel_id,
        is_default = excluded.is_default;
    `);

    this.stmtDeletePermission = db.prepare(`
      DELETE FROM guild_project_permissions
      WHERE guild_id = ? AND project_id = ?;
    `);

    this.stmtGetNotificationTargets = db.prepare(`
      SELECT g.guild_id, g.notification_channel_id
      FROM guild_project_permissions g
      JOIN projects p ON g.project_id = p.id
      WHERE LOWER(p.github_owner) = LOWER(?) AND LOWER(p.github_repo) = LOWER(?);
    `);
  }

  public getAllProjects(): ProjectRecord[] {
    return this.stmtGetAllProjects.all() as ProjectRecord[];
  }

  public getProjectById(id: string): ProjectRecord | null {
    const row = this.stmtGetProjectById.get(id);
    return (row as ProjectRecord) ?? null;
  }

  public getProjectsForGuild(guildId: string): GuildBoundProject[] {
    const rows = this.stmtGetProjectsForGuild.all(guildId) as Array<
      ProjectRecord & { notification_channel_id: string | null; is_default: number }
    >;
    return rows.map((r) => ({
      ...r,
      is_default: Boolean(r.is_default),
    }));
  }

  public getDefaultProjectForGuild(guildId: string): GuildBoundProject | null {
    const row = this.stmtGetDefaultProjectForGuild.get(guildId) as
      | (ProjectRecord & { notification_channel_id: string | null; is_default: number })
      | undefined;
    if (!row) {
      // If no explicit default, try taking the first project linked to the guild
      const all = this.getProjectsForGuild(guildId);
      return all[0] ?? null;
    }
    return {
      ...row,
      is_default: Boolean(row.is_default),
    };
  }

  public getProjectForChannel(guildId: string, channelId: string): GuildBoundProject | null {
    const row = this.stmtGetProjectForChannel.get(guildId, channelId) as
      | (ProjectRecord & { notification_channel_id: string | null; is_default: number })
      | undefined;
    if (!row) {
      return null;
    }
    return {
      ...row,
      is_default: Boolean(row.is_default),
    };
  }

  public createOrUpdateProject(project: {
    id: string;
    name: string;
    github_owner: string;
    github_repo: string;
    project_number: number;
    description?: string | null;
  }): void {
    this.stmtInsertProject.run({
      id: project.id.trim(),
      name: project.name.trim(),
      github_owner: project.github_owner.trim(),
      github_repo: project.github_repo.trim(),
      project_number: project.project_number,
      description: project.description ? project.description.trim() : null,
    });
  }

  public deleteProject(id: string): void {
    this.stmtDeleteProject.run(id);
  }

  public getAllGuildPermissions(): GuildPermissionRecord[] {
    return this.stmtGetAllGuildPermissions.all() as GuildPermissionRecord[];
  }

  public setGuildPermission(perm: {
    guild_id: string;
    project_id: string;
    notification_channel_id?: string | null;
    is_default?: boolean;
  }): void {
    const isDefault = perm.is_default ? 1 : 0;
    this.db.transaction(() => {
      if (isDefault) {
        this.stmtClearDefaultPermission.run(perm.guild_id);
      }
      this.stmtInsertOrUpdatePermission.run({
        guild_id: perm.guild_id.trim(),
        project_id: perm.project_id.trim(),
        notification_channel_id: perm.notification_channel_id ? perm.notification_channel_id.trim() : null,
        is_default: isDefault,
      });
    })();
  }

  public removeGuildPermission(guildId: string, projectId: string): void {
    this.stmtDeletePermission.run(guildId, projectId);
  }

  public getNotificationTargetsForRepo(
    owner: string,
    repo: string,
  ): Array<{ guild_id: string; notification_channel_id: string | null }> {
    return this.stmtGetNotificationTargets.all(owner, repo) as Array<{
      guild_id: string;
      notification_channel_id: string | null;
    }>;
  }
}
