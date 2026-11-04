import type {
  IGitHubService,
  IssueFilter,
  CreateIssueInput,
} from '../../src/application/ports/IGitHubService.js';
import type {
  CanonicalStatus,
  CanonicalPriority,
  IssueSummary,
  IssueDetail,
  ProjectSummary,
  ReviewRequestSummary,
  BlockedIssueSummary,
  RepoPermissionLevel,
} from '../../src/domain/types.js';
import {
  ConflictError,
  NotFoundError,
  PendingPermissionError,
  RateLimitError,
  ValidationError,
  ExternalApiError,
} from '../../src/domain/errors.js';
import { StatusTransitionPolicy } from '../../src/domain/policies.js';

export class MockGitHubService implements IGitHubService {
  public issues: Map<number, IssueDetail> = new Map();
  public collaborators: Map<string, RepoPermissionLevel> = new Map();
  public reviewRequests: ReviewRequestSummary[] = [];

  // Simulation flags
  public simulatePendingPermission = false;
  public simulateRateLimit: { retryAfterSeconds: number } | null = null;
  public simulateConflict = false;
  public simulateServerError = false;

  // Audit of invoked mutations
  public createdIssues: CreateIssueInput[] = [];
  public statusTransitions: Array<{
    issueNumber: number;
    status: CanonicalStatus;
    actor: number;
  }> = [];
  public priorityTransitions: Array<{
    issueNumber: number;
    priority: CanonicalPriority;
    actor: number;
  }> = [];
  public blockedActions: Array<{
    issueNumber: number;
    reason: string;
    actor: number;
  }> = [];
  public commentsAdded: Array<{
    issueNumber: number;
    text: string;
    actor: number;
  }> = [];
  public assignCalls: Array<{
    issueNumber: number;
    assignee: string;
    actor: number;
  }> = [];

  private nextIssueNumber = 100;

  constructor() {
    this.seedDefaultData();
  }

  public seedDefaultData(): void {
    const defaultIssues: IssueDetail[] = [
      {
        number: 1,
        title: 'Setup Database Migrations',
        htmlUrl: 'https://github.com/example/repo/issues/1',
        state: 'OPEN',
        projectStatus: 'In Progress',
        projectPriority: 'High',
        assignees: ['alice'],
        author: 'octocat',
        labels: ['backend'],
        commentsCount: 2,
        updatedAt: '2026-11-01T10:00:00Z',
        createdAt: '2026-11-01T08:00:00Z',
        body: 'Implement initial SQLite migrations.',
        projectItemId: 'PVTI_item1',
      },
      {
        number: 2,
        title: 'Fix OAuth Callback Bug',
        htmlUrl: 'https://github.com/example/repo/issues/2',
        state: 'OPEN',
        projectStatus: 'Blocked',
        projectPriority: 'Urgent',
        assignees: ['bob'],
        author: 'alice',
        labels: ['bug', 'auth'],
        commentsCount: 5,
        updatedAt: '2026-11-02T12:00:00Z',
        createdAt: '2026-11-01T09:00:00Z',
        body: 'State nonce replay attack occurring in staging.',
        projectItemId: 'PVTI_item2',
        blockedReason: 'Waiting for upstream GitHub App credentials.',
      },
      {
        number: 3,
        title: 'Unassigned Task for Sprint',
        htmlUrl: 'https://github.com/example/repo/issues/3',
        state: 'OPEN',
        projectStatus: 'Ready',
        projectPriority: 'Medium',
        assignees: [],
        author: 'admin_user',
        labels: ['feature'],
        commentsCount: 0,
        updatedAt: '2026-11-02T14:00:00Z',
        createdAt: '2026-11-02T14:00:00Z',
        body: 'Ready for pickup by any developer.',
        projectItemId: 'PVTI_item3',
      },
    ];

    for (const issue of defaultIssues) {
      this.issues.set(issue.number, { ...issue });
    }

    this.collaborators.set('alice', 'write');
    this.collaborators.set('bob', 'write');
    this.collaborators.set('maintainer_dan', 'maintain');
    this.collaborators.set('admin_eva', 'admin');
    this.collaborators.set('viewer_val', 'read');

    this.reviewRequests = [
      {
        pullNumber: 10,
        title: 'PR: Add OAuth Route',
        htmlUrl: 'https://github.com/example/repo/pull/10',
        author: 'alice',
        requestedReviewers: ['bob', 'maintainer_dan'],
        draft: false,
        createdAt: '2026-11-02T11:00:00Z',
        updatedAt: '2026-11-02T15:00:00Z',
      },
    ];
  }

  private checkSimulations(): void {
    if (this.simulateRateLimit) {
      throw new RateLimitError(
        'GitHub API rate limit exceeded.',
        this.simulateRateLimit.retryAfterSeconds,
      );
    }
    if (this.simulatePendingPermission) {
      throw new PendingPermissionError('GitHub App lacks required permissions for Projects v2.');
    }
    if (this.simulateServerError) {
      throw new ExternalApiError('GitHub 500 Internal Server Error', 500);
    }
  }

  public async listIssues(filter: IssueFilter): Promise<IssueSummary[]> {
    this.checkSimulations();
    let result = Array.from(this.issues.values());

    if (filter.status) {
      result = result.filter(
        (i) => i.projectStatus?.toLowerCase() === filter.status!.toLowerCase(),
      );
    }

    if (filter.assignee) {
      const targetAssignee = filter.assignee.toLowerCase();
      result = result.filter((i) =>
        i.assignees.some((a) => a.toLowerCase() === targetAssignee),
      );
    }

    if (filter.limit) {
      result = result.slice(0, filter.limit);
    }

    return result.map((i) => ({ ...i }));
  }

  public async getIssue(issueNumber: number): Promise<IssueDetail> {
    this.checkSimulations();
    const issue = this.issues.get(issueNumber);
    if (!issue) {
      throw new NotFoundError(`Issue #${issueNumber} not found.`);
    }
    return { ...issue };
  }

  public async listMyIssues(githubUserId: number): Promise<IssueSummary[]> {
    this.checkSimulations();
    // Simulate mapping numeric githubUserId 1001 -> 'alice', 1002 -> 'bob'
    const loginMap: Record<number, string> = {
      1001: 'alice',
      1002: 'bob',
      1003: 'maintainer_dan',
      1004: 'admin_eva',
    };

    const targetLogin = loginMap[githubUserId]?.toLowerCase();
    if (!targetLogin) {
      return [];
    }

    return Array.from(this.issues.values())
      .filter((i) => i.assignees.some((a) => a.toLowerCase() === targetLogin))
      .map((i) => ({ ...i }));
  }

  public async getProjectSummary(): Promise<ProjectSummary> {
    this.checkSimulations();
    const statusCounts: Record<CanonicalStatus, number> = {
      Backlog: 0,
      Ready: 0,
      'In Progress': 0,
      'In Review': 0,
      Done: 0,
      Blocked: 0,
    };

    let totalOpenIssues = 0;
    for (const issue of this.issues.values()) {
      if (issue.state === 'OPEN') totalOpenIssues++;
      if (issue.projectStatus && statusCounts[issue.projectStatus] !== undefined) {
        statusCounts[issue.projectStatus]++;
      }
    }

    return {
      projectId: 'PVT_test_12345',
      projectNumber: 1,
      title: 'Discord Bot Roadmap',
      statusCounts,
      totalOpenIssues,
      totalOpenPullRequests: this.reviewRequests.length,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  public async listReviewRequests(githubUserId?: number): Promise<ReviewRequestSummary[]> {
    this.checkSimulations();
    if (!githubUserId) {
      return [...this.reviewRequests];
    }
    const loginMap: Record<number, string> = {
      1001: 'alice',
      1002: 'bob',
      1003: 'maintainer_dan',
    };
    const targetLogin = loginMap[githubUserId]?.toLowerCase();
    return this.reviewRequests.filter((pr) =>
      pr.requestedReviewers.some((r) => r.toLowerCase() === targetLogin),
    );
  }

  public async listBlockedIssues(): Promise<BlockedIssueSummary[]> {
    this.checkSimulations();
    return Array.from(this.issues.values())
      .filter((i) => i.projectStatus === 'Blocked')
      .map((i) => ({
        number: i.number,
        title: i.title,
        htmlUrl: i.htmlUrl,
        assignees: i.assignees,
        blockedReason: i.blockedReason ?? 'Blocked without specified reason',
        blockedAt: i.updatedAt,
      }));
  }

  public async listUnassignedIssues(): Promise<IssueSummary[]> {
    this.checkSimulations();
    return Array.from(this.issues.values())
      .filter((i) => i.assignees.length === 0)
      .map((i) => ({ ...i }));
  }

  public async createIssue(input: CreateIssueInput): Promise<IssueDetail> {
    this.checkSimulations();
    this.createdIssues.push(input);

    const issueNumber = this.nextIssueNumber++;
    const newIssue: IssueDetail = {
      number: issueNumber,
      title: input.title,
      body: input.body ?? '',
      htmlUrl: `https://github.com/example/repo/issues/${issueNumber}`,
      state: 'OPEN',
      projectStatus: 'Backlog',
      projectPriority: 'Medium',
      assignees: [],
      author: 'actor_' + input.actorGithubUserId,
      labels: input.type ? [input.type] : [],
      commentsCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectItemId: `PVTI_${issueNumber}`,
    };

    this.issues.set(issueNumber, newIssue);
    return { ...newIssue };
  }

  public async assignIssue(
    issueNumber: number,
    assigneeLogin: string,
    actorGithubUserId: number,
  ): Promise<void> {
    this.checkSimulations();
    this.assignCalls.push({ issueNumber, assignee: assigneeLogin, actor: actorGithubUserId });

    const issue = this.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`Issue #${issueNumber} not found.`);

    if (!issue.assignees.includes(assigneeLogin)) {
      issue.assignees.push(assigneeLogin);
    }
  }

  public async setProjectStatus(
    issueNumber: number,
    status: CanonicalStatus,
    actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
    blockerReason?: string,
  ): Promise<void> {
    this.checkSimulations();
    if (this.simulateConflict) {
      throw new ConflictError(
        `Concurrency conflict: issue #${issueNumber} status changed from expected '${expectedPreviousStatus}'.`,
      );
    }

    const issue = this.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`Issue #${issueNumber} not found.`);

    const currentStatus = issue.projectStatus ?? 'Backlog';
    StatusTransitionPolicy.assertStateNotStale(currentStatus, expectedPreviousStatus);
    if (currentStatus !== status) {
      StatusTransitionPolicy.assertValidTransition(currentStatus, status, blockerReason);
    }

    issue.projectStatus = status;
    issue.updatedAt = new Date().toISOString();
    this.statusTransitions.push({ issueNumber, status, actor: actorGithubUserId });
  }

  public async setProjectPriority(
    issueNumber: number,
    priority: CanonicalPriority,
    actorGithubUserId: number,
    expectedPreviousPriority?: CanonicalPriority,
  ): Promise<void> {
    this.checkSimulations();
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`Issue #${issueNumber} not found.`);

    if (expectedPreviousPriority && issue.projectPriority !== expectedPreviousPriority) {
      throw new ConflictError(
        `Concurrency conflict: issue #${issueNumber} priority changed from expected '${expectedPreviousPriority}'.`,
      );
    }

    issue.projectPriority = priority;
    issue.updatedAt = new Date().toISOString();
    this.priorityTransitions.push({ issueNumber, priority, actor: actorGithubUserId });
  }

  public async markBlocked(
    issueNumber: number,
    reason: string,
    actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
  ): Promise<void> {
    this.checkSimulations();
    if (!reason || reason.trim().length < 3) {
      throw new ValidationError(
        'A valid blocker reason (minimum 3 characters) is mandatory when marking an issue as Blocked.',
      );
    }

    await this.setProjectStatus(
      issueNumber,
      'Blocked',
      actorGithubUserId,
      expectedPreviousStatus,
      reason.trim(),
    );
    await this.addComment(issueNumber, `🚫 **Blocked**: ${reason.trim()}`, actorGithubUserId);

    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.blockedReason = reason.trim();
    }
    this.blockedActions.push({ issueNumber, reason: reason.trim(), actor: actorGithubUserId });
  }

  public async addComment(
    issueNumber: number,
    text: string,
    actorGithubUserId: number,
  ): Promise<void> {
    this.checkSimulations();
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new NotFoundError(`Issue #${issueNumber} not found.`);

    issue.commentsCount++;
    this.commentsAdded.push({ issueNumber, text, actor: actorGithubUserId });
  }

  public async getUserRepoPermission(githubUsername: string): Promise<RepoPermissionLevel> {
    this.checkSimulations();
    const perm = this.collaborators.get(githubUsername.toLowerCase());
    return perm ?? 'none';
  }
}
