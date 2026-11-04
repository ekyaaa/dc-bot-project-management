import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

describe('Deployment Runbooks & Scripts (Milestone 5)', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const scriptsDir = path.join(projectRoot, 'scripts/deploy');
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'runbook-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('all scripts have valid help CLI flags (--help) and exit 0', () => {
    const scripts = ['preflight.sh', 'build.sh', 'up.sh', 'health.sh', 'backup.sh', 'restore.sh'];
    for (const script of scripts) {
      const scriptPath = path.join(scriptsDir, script);
      expect(fs.existsSync(scriptPath)).toBe(true);

      const output = execFileSync('bash', [scriptPath, '--help'], {
        encoding: 'utf-8',
        cwd: projectRoot,
      });
      expect(output).toContain('Usage:');
    }
  });

  it('performs consistent SQLite backup and restore round-trip with integrity check and dry-run', () => {
    const originalDbPath = path.join(tempDir, 'original.db');
    const backupDir = path.join(tempDir, 'backups');
    const restoredDbPath = path.join(tempDir, 'restored.db');

    // 1. Create SQLite DB and insert test records
    const db = new Database(originalDbPath);
    db.exec(`
      CREATE TABLE test_data (id INTEGER PRIMARY KEY, key TEXT, value TEXT);
      INSERT INTO test_data (key, value) VALUES ('version', '1.0.0'), ('actor', 'developer_1');
    `);
    db.close();

    // 2. Run backup.sh targeting the temporary database
    const backupScript = path.join(scriptsDir, 'backup.sh');
    const backupOutput = execFileSync('bash', [
      backupScript,
      '--db-path', originalDbPath,
      '--backup-dir', backupDir,
    ], {
      encoding: 'utf-8',
      cwd: projectRoot,
    });

    expect(backupOutput).toContain('[BACKUP] Completed Successfully');
    const backupFiles = fs.readdirSync(backupDir).filter(f => f.startsWith('sqlite-backup-') && f.endsWith('.db'));
    expect(backupFiles.length).toBe(1);
    const backupFilePath = path.join(backupDir, backupFiles[0]);

    // 3. Test restore dry-run on valid backup
    const restoreScript = path.join(scriptsDir, 'restore.sh');
    const dryRunOutput = execFileSync('bash', [
      restoreScript,
      '--backup-file', backupFilePath,
      '--target-db', restoredDbPath,
      '--dry-run',
    ], {
      encoding: 'utf-8',
      cwd: projectRoot,
    });

    expect(dryRunOutput).toContain('[DRY-RUN] Restoration simulated successfully');
    expect(fs.existsSync(restoredDbPath)).toBe(false);

    // 4. Perform actual restore
    const restoreOutput = execFileSync('bash', [
      restoreScript,
      '--backup-file', backupFilePath,
      '--target-db', restoredDbPath,
      '--force',
    ], {
      encoding: 'utf-8',
      cwd: projectRoot,
    });

    expect(restoreOutput).toContain('[RESTORE] SQLite Database Restoration Completed Successfully');
    expect(fs.existsSync(restoredDbPath)).toBe(true);

    // 5. Verify restored database contents
    const restoredDb = new Database(restoredDbPath, { readonly: true });
    const rows = restoredDb.prepare('SELECT * FROM test_data ORDER BY id ASC').all() as Array<{ key: string; value: string }>;
    expect(rows).toEqual([
      { id: 1, key: 'version', value: '1.0.0' },
      { id: 2, key: 'actor', value: 'developer_1' },
    ]);
    restoredDb.close();
  });

  it('restore.sh fails gracefully on missing backup file', () => {
    const restoreScript = path.join(scriptsDir, 'restore.sh');
    expect(() => {
      execFileSync('bash', [
        restoreScript,
        '--backup-file', '/tmp/non-existent-backup-file.db',
        '--target-db', path.join(tempDir, 'fail.db'),
        '--force',
      ], {
        encoding: 'utf-8',
        cwd: projectRoot,
      });
    }).toThrow();
  });
});
