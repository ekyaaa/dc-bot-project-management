import type {
  CanonicalStatus,
  CanonicalPriority,
  IssueSummary,
  IssueDetail,
  ProjectSummary,
  ReviewRequestSummary,
  BlockedIssueSummary,
  RepoPermissionLevel,
} from '../../domain/types.js';

export interface IssueFilter {
  status?: string;
  assignee?: string;
  limit?: number;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  type?: string;
  actorGithubUserId: number;
}

export interface IGitHubService {
  // ==========================================
  // Queries
  // ==========================================
  listIssues(filter: IssueFilter): Promise<IssueSummary[]>;
  getIssue(issueNumber: number): Promise<IssueDetail>;
  listMyIssues(githubUserId: number): Promise<IssueSummary[]>;
  getProjectSummary(): Promise<ProjectSummary>;
  listReviewRequests(githubUserId?: number): Promise<ReviewRequestSummary[]>;
  listBlockedIssues(): Promise<BlockedIssueSummary[]>;
  listUnassignedIssues(): Promise<IssueSummary[]>;

  // ==========================================
  // Mutations
  // ==========================================
  createIssue(input: CreateIssueInput): Promise<IssueDetail>;
  assignIssue(issueNumber: number, assigneeLogin: string, actorGithubUserId: number): Promise<void>;
  setProjectStatus(
    issueNumber: number,
    status: CanonicalStatus,
    actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
    blockerReason?: string,
  ): Promise<void>;
  setProjectPriority(
    issueNumber: number,
    priority: CanonicalPriority,
    actorGithubUserId: number,
    expectedPreviousPriority?: CanonicalPriority,
  ): Promise<void>;
  markBlocked(
    issueNumber: number,
    reason: string,
    actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
  ): Promise<void>;
  addComment(issueNumber: number, text: string, actorGithubUserId: number): Promise<void>;

  // ==========================================
  // Permission Check
  // ==========================================
  getUserRepoPermission(githubUsername: string): Promise<RepoPermissionLevel>;
}
