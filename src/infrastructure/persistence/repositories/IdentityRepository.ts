import { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import type {
  EncryptedToken,
  IdentityRecord,
  IIdentityRepository,
} from '../../../application/ports/IRepositories.js';

interface RawIdentityRow {
  discord_user_id: string;
  github_user_id: number;
  github_username: string;
  application_role: string;
  encrypted_token: string | null;
  encrypted_access_token: string | null;
  token_expires_at: string | null;
  token_scopes: string | null;
  linked_at: string;
  updated_at: string;
}

export class IdentityRepository implements IIdentityRepository {
  private readonly stmtFindByDiscordId: Statement;
  private readonly stmtFindByGithubId: Statement;
  private readonly stmtLinkIdentity: Statement;
  private readonly stmtUnlinkIdentity: Statement;

  constructor(db: DatabaseInstance) {
    this.stmtFindByDiscordId = db.prepare(`
      SELECT
        discord_user_id,
        github_user_id,
        github_username,
        application_role,
        encrypted_token,
        encrypted_access_token,
        token_expires_at,
        token_scopes,
        linked_at,
        updated_at
      FROM identity_links
      WHERE discord_user_id = ?;
    `);

    this.stmtFindByGithubId = db.prepare(`
      SELECT
        discord_user_id,
        github_user_id,
        github_username,
        application_role,
        encrypted_token,
        encrypted_access_token,
        token_expires_at,
        token_scopes,
        linked_at,
        updated_at
      FROM identity_links
      WHERE github_user_id = ?;
    `);

    this.stmtLinkIdentity = db.prepare(`
      INSERT INTO identity_links (
        discord_user_id,
        github_user_id,
        github_username,
        application_role,
        encrypted_token,
        linked_at,
        updated_at
      ) VALUES (
        @discordUserId,
        @githubUserId,
        @githubUsername,
        'Developer',
        @encryptedToken,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(discord_user_id) DO UPDATE SET
        github_user_id = excluded.github_user_id,
        github_username = excluded.github_username,
        encrypted_token = excluded.encrypted_token,
        updated_at = CURRENT_TIMESTAMP;
    `);

    this.stmtUnlinkIdentity = db.prepare(`
      DELETE FROM identity_links
      WHERE discord_user_id = ?;
    `);
  }

  public async findByDiscordId(discordUserId: string): Promise<IdentityRecord | null> {
    const row = this.stmtFindByDiscordId.get(discordUserId) as RawIdentityRow | undefined;
    return row ? this.mapRowToRecord(row) : null;
  }

  public async findByGithubId(githubUserId: number): Promise<IdentityRecord | null> {
    const row = this.stmtFindByGithubId.get(githubUserId) as RawIdentityRow | undefined;
    return row ? this.mapRowToRecord(row) : null;
  }

  public async linkIdentity(
    discordUserId: string,
    githubUserId: number,
    githubLogin: string,
    encryptedToken?: EncryptedToken,
  ): Promise<void> {
    const encryptedTokenJson = encryptedToken ? JSON.stringify(encryptedToken) : null;

    this.stmtLinkIdentity.run({
      discordUserId,
      githubUserId,
      githubUsername: githubLogin,
      encryptedToken: encryptedTokenJson,
    });
  }

  public async unlinkIdentity(discordUserId: string): Promise<boolean> {
    const info = this.stmtUnlinkIdentity.run(discordUserId);
    return info.changes > 0;
  }

  private mapRowToRecord(row: RawIdentityRow): IdentityRecord {
    let encryptedToken: EncryptedToken | undefined;
    if (row.encrypted_token) {
      try {
        encryptedToken = JSON.parse(row.encrypted_token) as EncryptedToken;
      } catch {
        encryptedToken = undefined;
      }
    }

    return {
      discordUserId: row.discord_user_id,
      githubUserId: row.github_user_id,
      githubUsername: row.github_username,
      applicationRole: row.application_role as IdentityRecord['applicationRole'],
      encryptedToken,
      tokenExpiresAt: row.token_expires_at ?? undefined,
      tokenScopes: row.token_scopes ? row.token_scopes.split(',') : undefined,
      linkedAt: row.linked_at,
      updatedAt: row.updated_at,
    };
  }
}
