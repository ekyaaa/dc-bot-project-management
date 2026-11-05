import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface AdminAuthConfig {
  username?: string;
  passwordHash?: string;
  rawPassword?: string;
  sessionSecret?: string;
}

const DEFAULT_USERNAME = 'mashupsoat';
// PBKDF2 hash of 'password123' with salt 'mashupsoat_salt_hq2026'
// Iterations: 100000, Keylen: 64, Digest: sha512
const DEFAULT_SALT = 'mashupsoat_salt_hq2026';
const DEFAULT_HASH = crypto.pbkdf2Sync('password123', DEFAULT_SALT, 100000, 64, 'sha512').toString('hex');
const DEFAULT_PASSWORD_HASH_STRING = `${DEFAULT_SALT}:${DEFAULT_HASH}`;
const DEFAULT_SESSION_SECRET = 'mashupsoat_secure_session_secret_key_vps_32bytes!';

export class AdminAuthManager {
  private readonly username: string;
  private readonly passwordHashString: string;
  private readonly sessionSecret: string;

  constructor(config: AdminAuthConfig = {}) {
    this.username = config.username || process.env.ADMIN_USERNAME || DEFAULT_USERNAME;
    this.sessionSecret = config.sessionSecret || process.env.ADMIN_SESSION_SECRET || DEFAULT_SESSION_SECRET;

    if (config.passwordHash || process.env.ADMIN_PASSWORD_HASH) {
      this.passwordHashString = (config.passwordHash || process.env.ADMIN_PASSWORD_HASH)!;
    } else if (config.rawPassword || process.env.ADMIN_PASSWORD) {
      const raw = (config.rawPassword || process.env.ADMIN_PASSWORD)!;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync(raw, salt, 100000, 64, 'sha512').toString('hex');
      this.passwordHashString = `${salt}:${hash}`;
    } else {
      this.passwordHashString = DEFAULT_PASSWORD_HASH_STRING;
    }
  }

  public verifyCredentials(inputUser: string, inputPass: string): boolean {
    if (inputUser.trim() !== this.username) {
      return false;
    }

    const [salt, expectedHash] = this.passwordHashString.split(':');
    if (!salt || !expectedHash) {
      return false;
    }

    const actualHash = crypto.pbkdf2Sync(inputPass, salt, 100000, 64, 'sha512').toString('hex');
    const actualBuf = Buffer.from(actualHash, 'hex');
    const expectedBuf = Buffer.from(expectedHash, 'hex');

    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  }

  public createSessionToken(username: string): string {
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    const payload = `${username}|${expiresAt}`;
    const hmac = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex');
    return Buffer.from(`${payload}|${hmac}`).toString('base64url');
  }

  public verifySessionToken(token: string): { username: string; expiresAt: number } | null {
    try {
      const decoded = Buffer.from(token, 'base64url').toString('utf-8');
      const parts = decoded.split('|');
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        return null;
      }

      const user = parts[0];
      const expStr = parts[1];
      const signature = parts[2];
      const expiresAt = Number(expStr);

      if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
        return null;
      }

      const payload = `${user}|${expStr}`;
      const expectedHmac = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex');

      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedHmac, 'hex');

      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return null;
      }

      return { username: user, expiresAt };
    } catch {
      return null;
    }
  }

  /**
   * Fastify Hook for protecting admin routes
   */
  public createAuthHook() {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const cookieHeader = request.headers.cookie;
      let token: string | undefined;

      if (cookieHeader) {
        const cookies = Object.fromEntries(
          cookieHeader.split(';').map((c) => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
          }),
        );
        token = cookies['admin_session'];
      }

      if (!token && request.headers.authorization?.startsWith('Bearer ')) {
        token = request.headers.authorization.slice(7);
      }

      if (!token) {
        if (request.url.startsWith('/admin/api')) {
          return reply.code(401).send({ error: 'Unauthorized: Admin session required' });
        }
        return reply.redirect('/admin/login');
      }

      const session = this.verifySessionToken(token);
      if (!session) {
        if (request.url.startsWith('/admin/api')) {
          return reply.code(401).send({ error: 'Unauthorized: Invalid or expired session' });
        }
        return reply.redirect('/admin/login');
      }

      // Session is valid
      (request as unknown as { adminUser: string }).adminUser = session.username;
    };
  }
}
