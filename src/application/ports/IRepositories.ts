export interface EncryptedToken {
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
}

export interface IdentityRecord {
  discordUserId: string;
  githubUserId: number;
  githubUsername: string;
  applicationRole: 'Viewer' | 'Developer' | 'Maintainer' | 'Admin';
  encryptedToken?: EncryptedToken;
  tokenExpiresAt?: string;
  tokenScopes?: string[];
  linkedAt: string;
  updatedAt: string;
}

export interface OAuthSessionRecord {
  state: string;
  discordUserId: string;
  guildId: string;
  codeVerifier?: string;
  consumed: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface OutboxRecord {
  id: number;
  deliveryId: string;
  eventType: string;
  payloadJson: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER';
  attempts: number;
  maxAttempts: number;
  lastError?: string | null;
  createdAt: string;
  processedAt?: string | null;
}

export interface AuditEntry {
  id?: string;
  actorDiscordId: string;
  actorGithubId?: number | null;
  actorGithubLogin?: string | null;
  action: string;
  targetIssueNumber?: number | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  outcome: 'SUCCESS' | 'FAILED' | 'REJECTED';
  errorReason?: string | null;
  correlationId?: string | null;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  createdAt: string;
}

export interface IIdentityRepository {
  findByDiscordId(discordUserId: string): Promise<IdentityRecord | null>;
  findByGithubId(githubUserId: number): Promise<IdentityRecord | null>;
  linkIdentity(
    discordUserId: string,
    githubUserId: number,
    githubLogin: string,
    encryptedToken?: EncryptedToken,
  ): Promise<void>;
  unlinkIdentity(discordUserId: string): Promise<boolean>;
}

export interface IOAuthStateRepository {
  createSession(
    state: string,
    discordUserId: string,
    guildId: string,
    codeVerifier: string,
    ttlSeconds: number,
  ): Promise<void>;
  consumeSession(state: string): Promise<OAuthSessionRecord | null>;
}

export interface IOutboxRepository {
  enqueueDelivery(deliveryId: string, eventType: string, payloadJson: string): Promise<boolean>;
  fetchPendingDeliveries(limit: number): Promise<OutboxRecord[]>;
  markProcessed(id: number): Promise<void>;
  recordFailure(id: number, error: string, maxAttempts: number): Promise<void>;
}

export interface IScheduleRepository {
  acquireLease(leaseKey: string, ttlSeconds: number): Promise<boolean>;
  isExecutedForDate(jobKey: string, dateStr: string): Promise<boolean>;
  recordExecution(jobKey: string, dateStr: string): Promise<void>;
}

export interface IAuditRepository {
  recordAudit(entry: AuditEntry): Promise<void>;
}
