import { Database as DatabaseInstance, Statement } from 'better-sqlite3';
import type {
  IOAuthStateRepository,
  OAuthSessionRecord,
} from '../../../application/ports/IRepositories.js';

interface RawOAuthStateRow {
  state_nonce: string;
  discord_user_id: string;
  guild_id: string;
  code_verifier: string | null;
  consumed: number;
  expires_at: string;
  created_at: string;
}

export class OAuthStateRepository implements IOAuthStateRepository {
  private readonly stmtCreateSession: Statement;
  private readonly stmtFindActive: Statement;
  private readonly stmtMarkConsumed: Statement;

  constructor(private readonly db: DatabaseInstance) {
    this.stmtCreateSession = db.prepare(`
      INSERT INTO oauth_states (
        state_nonce,
        discord_user_id,
        guild_id,
        code_verifier,
        consumed,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, 0, datetime('now', ? || ' seconds'), CURRENT_TIMESTAMP);
    `);

    this.stmtFindActive = db.prepare(`
      SELECT
        state_nonce,
        discord_user_id,
        guild_id,
        code_verifier,
        consumed,
        expires_at,
        created_at
      FROM oauth_states
      WHERE state_nonce = ?
        AND consumed = 0
        AND datetime(expires_at) > datetime('now');
    `);

    this.stmtMarkConsumed = db.prepare(`
      UPDATE oauth_states
      SET consumed = 1
      WHERE state_nonce = ?;
    `);
  }

  public async createSession(
    state: string,
    discordUserId: string,
    guildId: string,
    codeVerifier: string,
    ttlSeconds: number,
  ): Promise<void> {
    this.stmtCreateSession.run(state, discordUserId, guildId, codeVerifier, ttlSeconds);
  }

  /**
   * Atomically verifies and marks an OAuth session consumed.
   * Prevents CSRF replay attacks.
   */
  public async consumeSession(state: string): Promise<OAuthSessionRecord | null> {
    const consumeTx = this.db.transaction((stateNonce: string) => {
      const row = this.stmtFindActive.get(stateNonce) as RawOAuthStateRow | undefined;
      if (!row) {
        return null;
      }
      this.stmtMarkConsumed.run(stateNonce);
      return row;
    });

    const row = consumeTx(state);
    if (!row) {
      return null;
    }

    return {
      state: row.state_nonce,
      discordUserId: row.discord_user_id,
      guildId: row.guild_id,
      codeVerifier: row.code_verifier ?? undefined,
      consumed: true,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Helper to clean up expired states during maintenance
   */
  public async purgeExpired(): Promise<number> {
    const info = this.db.prepare("DELETE FROM oauth_states WHERE datetime(expires_at) <= datetime('now')").run();
    return info.changes;
  }
}
