import { Database as DatabaseInstance } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: string;
}

export interface MigrationResult {
  name: string;
  applied: boolean;
  durationMs: number;
}

export class Migrator {
  private readonly db: DatabaseInstance;
  private readonly migrationsDir: string;

  constructor(db: DatabaseInstance, migrationsDir?: string) {
    this.db = db;
    this.migrationsDir = migrationsDir
      ? path.resolve(migrationsDir)
      : path.resolve(process.cwd(), 'migrations');
  }

  /**
   * Initializes the _migrations tracking table
   */
  public ensureMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
  }

  /**
   * Returns list of already applied migration names
   */
  public getAppliedMigrations(): string[] {
    this.ensureMigrationsTable();
    const rows = this.db.prepare('SELECT name FROM _migrations ORDER BY id ASC').all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * Finds pending migrations from disk
   */
  public getPendingMigrations(): string[] {
    if (!fs.existsSync(this.migrationsDir)) {
      return [];
    }

    const applied = new Set(this.getAppliedMigrations());
    const files = fs
      .readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    return files.filter((file) => !applied.has(file));
  }

  /**
   * Executes all pending migrations in sorted order within atomic transactions
   */
  public runMigrations(): MigrationResult[] {
    this.ensureMigrationsTable();
    const pending = this.getPendingMigrations();
    const results: MigrationResult[] = [];

    const insertMigration = this.db.prepare('INSERT INTO _migrations (name) VALUES (?)');

    for (const filename of pending) {
      const filePath = path.join(this.migrationsDir, filename);
      const sqlContent = fs.readFileSync(filePath, 'utf-8');
      const startTime = performance.now();

      // Wrap each migration file execution and tracking insertion in an immediate transaction
      const executeMigration = this.db.transaction(() => {
        this.db.exec(sqlContent);
        insertMigration.run(filename);
      });

      try {
        executeMigration();
        const durationMs = Math.round(performance.now() - startTime);
        results.push({ name: filename, applied: true, durationMs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to apply migration '${filename}': ${message}`);
      }
    }

    return results;
  }
}

/**
 * Standalone execution helper
 */
export function runMigrations(db: DatabaseInstance, migrationsDir?: string): MigrationResult[] {
  const migrator = new Migrator(db, migrationsDir);
  return migrator.runMigrations();
}
