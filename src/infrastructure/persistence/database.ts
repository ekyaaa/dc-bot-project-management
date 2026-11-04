import Database, { Database as DatabaseInstance } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface DatabaseConfig {
  databasePath: string;
  busyTimeoutMs?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export interface IDatabaseManager {
  readonly db: DatabaseInstance;
  healthCheck(): boolean;
  backup(destinationPath: string): Promise<void>;
  close(): void;
}

export class DatabaseManager implements IDatabaseManager {
  private _db: DatabaseInstance | null = null;
  private isClosed = false;
  private readonly config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = {
      databasePath: config.databasePath,
      busyTimeoutMs: config.busyTimeoutMs ?? 5000,
      verbose: config.verbose,
    };
  }

  public get db(): DatabaseInstance {
    if (!this._db) {
      this.init();
    }
    return this._db!;
  }

  public init(): DatabaseInstance {
    if (this._db) {
      return this._db;
    }

    const { databasePath, busyTimeoutMs, verbose } = this.config;

    // Handle in-memory database vs persistent filesystem database
    if (databasePath !== ':memory:') {
      const dir = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this._db = new Database(databasePath, {
      verbose,
    });
    this.isClosed = false;

    // Configure resilient SQLite PRAGMAs
    // 1. WAL mode: allows concurrent readers alongside single writer
    this._db.pragma('journal_mode = WAL');
    // 2. Busy timeout: waits up to 5000ms on locks before throwing SQLITE_BUSY
    this._db.pragma(`busy_timeout = ${busyTimeoutMs ?? 5000}`);
    // 3. Enforce foreign key constraints
    this._db.pragma('foreign_keys = ON');
    // 4. Synchronous NORMAL: crash-safe in WAL mode with optimal throughput
    this._db.pragma('synchronous = NORMAL');
    // 5. Memory temp store: keep temp tables and indexes in RAM
    this._db.pragma('temp_store = MEMORY');

    return this._db;
  }

  public healthCheck(): boolean {
    if (this.isClosed) {
      return false;
    }
    try {
      if (!this._db) {
        this.init();
      }
      if (!this._db || !this._db.open) {
        return false;
      }
      const result = this._db.prepare('SELECT 1 AS alive').get() as { alive: number } | undefined;
      return result?.alive === 1;
    } catch {
      return false;
    }
  }

  public async backup(destinationPath: string): Promise<void> {
    const db = this.db;
    const destDir = path.dirname(path.resolve(destinationPath));
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Uses better-sqlite3 native online backup API
    // Guarantees transactionally consistent snapshot without taking database offline
    await db.backup(destinationPath);
  }

  public close(): void {
    this.isClosed = true;
    if (this._db && this._db.open) {
      try {
        // Run WAL checkpoint before closing to merge WAL frames into main DB file
        this._db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Suppress errors during checkpoint on teardown
      }
      this._db.close();
      this._db = null;
    }
  }
}

/**
 * Factory helper for clean dependency injection
 */
export function createDatabase(config: DatabaseConfig): DatabaseManager {
  const manager = new DatabaseManager(config);
  manager.init();
  return manager;
}
