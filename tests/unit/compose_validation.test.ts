import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Docker & Compose Configuration Validation (Milestone 5)', () => {
  const projectRoot = path.resolve(__dirname, '../..');

  it('validates Dockerfile structure and security directives', () => {
    const dockerfilePath = path.join(projectRoot, 'Dockerfile');
    expect(fs.existsSync(dockerfilePath)).toBe(true);

    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');

    // Multi-stage verification
    expect(dockerfileContent).toContain('AS builder');
    expect(dockerfileContent).toContain('AS runner');

    // Security & non-root user
    expect(dockerfileContent).toContain('USER node');
    expect(dockerfileContent).toContain('dumb-init');

    // Node 22 base
    expect(dockerfileContent).toMatch(/node:22-bookworm-slim/);

    // Healthcheck defined
    expect(dockerfileContent).toContain('HEALTHCHECK');
    expect(dockerfileContent).toContain('/health/live');

    // Expose port
    expect(dockerfileContent).toContain('EXPOSE 3000');
  });

  it('validates compose.yaml structure, persistent volume, and secrets mounts', () => {
    const composePath = path.join(projectRoot, 'compose.yaml');
    expect(fs.existsSync(composePath)).toBe(true);

    const composeContent = fs.readFileSync(composePath, 'utf-8');

    // Service definition
    expect(composeContent).toContain('services:');
    expect(composeContent).toContain('bot:');
    expect(composeContent).toContain('container_name: dc-bot');

    // Restart policy
    expect(composeContent).toContain('restart: unless-stopped');

    // SQLite volume
    expect(composeContent).toContain('volumes:');
    expect(composeContent).toContain('bot-data:');
    expect(composeContent).toContain('/data');

    // Docker secrets
    expect(composeContent).toContain('secrets:');
    expect(composeContent).toContain('github_app_private_key:');
    expect(composeContent).toContain('token_encryption_key:');

    // Resource limits
    expect(composeContent).toContain('limits:');
    expect(composeContent).toContain('memory:');

    // Logging rotation
    expect(composeContent).toContain('json-file');
    expect(composeContent).toContain('max-size:');

    // Healthcheck
    expect(composeContent).toContain('/health/live');
  });

  it('validates .dockerignore and .gitignore security hygiene', () => {
    const dockerignorePath = path.join(projectRoot, '.dockerignore');
    const gitignorePath = path.join(projectRoot, '.gitignore');

    expect(fs.existsSync(dockerignorePath)).toBe(true);
    expect(fs.existsSync(gitignorePath)).toBe(true);

    const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf-8');
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');

    // Sensitive files must be ignored
    expect(dockerignoreContent).toContain('.env');
    expect(dockerignoreContent).toContain('secrets');
    expect(dockerignoreContent).toContain('*.db');

    expect(gitignoreContent).toContain('.env');
    expect(gitignoreContent).toContain('secrets');
    expect(gitignoreContent).toContain('*.db');
  });
});
