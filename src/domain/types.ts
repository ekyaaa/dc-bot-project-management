/**
 * Canonical Project v2 Statuses.
 * Conceptual Flow: Backlog -> Ready -> In Progress -> In Review -> Done
 * Exceptional State: Blocked (bidirectional with active states)
 */
export type CanonicalStatus =
  | 'Backlog'
  | 'Ready'
  | 'In Progress'
  | 'In Review'
  | 'Done'
  | 'Blocked';

export const CANONICAL_STATUSES = [
  'Backlog',
  'Ready',
  'In Progress',
  'In Review',
  'Done',
  'Blocked',
] as const;

/**
 * Canonical Task Priorities.
 */
export type CanonicalPriority = 'Urgent' | 'High' | 'Medium' | 'Low';

export const CANONICAL_PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'] as const;

/**
 * GitHub Issue Lifecycle State (separate from Project v2 Status).
 */
export type IssueState = 'OPEN' | 'CLOSED';

/**
 * Application RBAC Roles.
 */
export type ApplicationRole = 'Viewer' | 'Developer' | 'Maintainer' | 'Admin';

export const APPLICATION_ROLES = ['Viewer', 'Developer', 'Maintainer', 'Admin'] as const;

/**
 * GitHub Repository Collaborator Permission Levels.
 */
export type RepoPermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

/**
 * Verified Discord-GitHub Identity Link.
 */
export interface UserIdentity {
  discordUserId: string;
  githubUserId: number;
  githubLogin: string;
  applicationRole: ApplicationRole;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Execution Principal.
 */
export interface Principal {
  discordUserId: string;
  guildId: string;
  channelId?: string;
  identity: UserIdentity | null;
}

export interface VerifiedPrincipal extends Principal {
  identity: UserIdentity;
}

/**
 * Actions for Authorization Checks.
 */
export type ReadAction =
  | 'view_status'
  | 'list_issues'
  | 'view_mine'
  | 'view_blocked'
  | 'view_unassigned'
  | 'view_reviews'
  | 'view_digest'
  | 'view_issue'
  | 'view_account'
  | 'help';

export type WriteAction =
  | 'create_issue'
  | 'assign_issue'
  | 'update_status'
  | 'update_priority'
  | 'mark_blocked'
  | 'add_comment'
  | 'link_account'
  | 'unlink_account';

export interface ResourceContext {
  issueNumber?: number;
  currentAssigneeGithubLogin?: string;
  targetAssigneeGithubLogin?: string;
  currentStatus?: CanonicalStatus;
  targetStatus?: CanonicalStatus;
  repositoryOwner?: string;
  repositoryName?: string;
}

/**
 * Issue and Project Data Models.
 */
export interface IssueSummary {
  number: number;
  title: string;
  htmlUrl: string;
  state: IssueState;
  projectStatus?: CanonicalStatus;
  projectPriority?: CanonicalPriority;
  assignees: string[]; // GitHub logins
  author: string;
  labels: string[];
  commentsCount: number;
  updatedAt: string; // ISO 8601
  createdAt: string; // ISO 8601
}

export interface IssueDetail extends IssueSummary {
  body: string;
  projectItemId?: string; // GitHub Project v2 GraphQL Node ID
  blockedReason?: string;
}

export interface ProjectSummary {
  projectId: string;
  projectNumber: number;
  title: string;
  statusCounts: Record<CanonicalStatus, number>;
  totalOpenIssues: number;
  totalOpenPullRequests: number;
  lastSyncedAt: string; // ISO 8601
}

export interface ReviewRequestSummary {
  pullNumber: number;
  title: string;
  htmlUrl: string;
  author: string;
  requestedReviewers: string[];
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BlockedIssueSummary {
  number: number;
  title: string;
  htmlUrl: string;
  assignees: string[];
  blockedReason: string;
  blockedAt: string;
}

/**
 * Structured Audit Event Models.
 */
export type AuditAction =
  | 'ISSUE_CREATE'
  | 'ISSUE_ASSIGN'
  | 'ISSUE_STATUS_UPDATE'
  | 'ISSUE_PRIORITY_UPDATE'
  | 'ISSUE_BLOCK'
  | 'ISSUE_COMMENT'
  | 'ACCOUNT_LINK'
  | 'ACCOUNT_UNLINK';

export type AuditOutcome = 'SUCCESS' | 'REJECTED' | 'FAILED';

export interface AuditEntry {
  id?: string;
  actorDiscordUserId: string;
  actorGithubUserId?: number;
  actorGithubLogin?: string;
  action: AuditAction;
  issueNumber?: number;
  beforeStateJson?: string;
  afterStateJson?: string;
  outcome: AuditOutcome;
  reason?: string;
  correlationId: string;
  timestamp: string; // ISO 8601
}

/**
 * Confirmation Interaction Session.
 */
export interface ConfirmationAction<T = unknown> {
  actionId: string;
  nonce: string;
  actorDiscordUserId: string;
  command: WriteAction;
  payload: T;
  expectedPreviousState?: string;
  expiresAt: number; // Unix epoch ms
}

/**
 * Outbox and Webhook Delivery Models.
 */
export type DeliveryStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER';

export interface OutboxRecord {
  id: number;
  deliveryId: string;
  eventType: string;
  payloadJson: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Discord Safe Mentions Configuration.
 */
export interface AllowedMentions {
  parse: never[]; // strictly empty array
  users: string[]; // Discord user IDs
  roles?: never[];
  repliedUser?: boolean;
}
