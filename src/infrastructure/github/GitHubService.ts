import type { Config } from '../../config/env.js';
import type {
  IGitHubService,
  IssueFilter,
  CreateIssueInput,
} from '../../application/ports/IGitHubService.js';
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
import {
  ValidationError,
  ConflictError,
  NotFoundError,
} from '../../domain/errors.js';
import { StatusTransitionPolicy } from '../../domain/policies.js';
import { mapGitHubError } from './errorMapper.js';
import {
  CustomOctokitInstance,
  GitHubAppAuth,
} from './GitHubAppAuth.js';
import {
  GET_ORG_PROJECT_V2_METADATA,
  GET_USER_PROJECT_V2_METADATA,
  GET_PROJECT_V2_ITEMS,
  GET_ISSUE_PROJECT_ITEM,
  ADD_PROJECT_V2_ITEM_BY_ID,
  UPDATE_PROJECT_V2_ITEM_FIELD_VALUE,
} from './graphql/queries.js';

interface ProjectMetadata {
  projectId: string;
  title: string;
  number: number;
  statusFieldId?: string;
  statusOptions: Map<string, string>; // name -> optionId
  priorityFieldId?: string;
  priorityOptions: Map<string, string>; // name -> optionId
  cachedAt: number;
}

export interface GitHubServiceDependencies {
  config: Pick<Config, 'GITHUB_OWNER' | 'GITHUB_REPOSITORY' | 'GITHUB_PROJECT_NUMBER'>;
  gitHubAppAuth?: GitHubAppAuth;
  octokit?: CustomOctokitInstance;
}

export class GitHubService implements IGitHubService {
  private readonly octokit: CustomOctokitInstance;
  private readonly owner: string;
  private readonly repo: string;
  private readonly projectNumber: number;

  private cachedProjectMetadata: ProjectMetadata | null = null;
  private static readonly METADATA_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(deps: GitHubServiceDependencies) {
    this.owner = deps.config.GITHUB_OWNER;
    this.repo = deps.config.GITHUB_REPOSITORY;
    this.projectNumber = deps.config.GITHUB_PROJECT_NUMBER;

    if (deps.octokit) {
      this.octokit = deps.octokit;
    } else if (deps.gitHubAppAuth) {
      this.octokit = deps.gitHubAppAuth.getInstallationOctokit();
    } else {
      throw new Error('GitHubService requires either gitHubAppAuth or octokit instance');
    }
  }

  // ==========================================
  // Project Metadata Discovery & Caching
  // ==========================================
  private async getProjectMetadata(): Promise<ProjectMetadata> {
    const now = Date.now();
    if (
      this.cachedProjectMetadata &&
      now - this.cachedProjectMetadata.cachedAt < GitHubService.METADATA_TTL_MS
    ) {
      return this.cachedProjectMetadata;
    }

    try {
      // 1. Try Organization-level Project v2 first
      let projectData: any = null;
      try {
        const orgRes: any = await this.octokit.graphql(GET_ORG_PROJECT_V2_METADATA, {
          owner: this.owner,
          number: this.projectNumber,
        });
        projectData = orgRes?.organization?.projectV2;
      } catch (orgErr: any) {
        // If organization not found or error, fall through to try user
        projectData = null;
      }

      // 2. If organization returned null, try User-level Project v2
      if (!projectData) {
        try {
          const userRes: any = await this.octokit.graphql(GET_USER_PROJECT_V2_METADATA, {
            owner: this.owner,
            number: this.projectNumber,
          });
          projectData = userRes?.user?.projectV2;
        } catch (userErr: any) {
          projectData = null;
        }
      }

      if (!projectData) {
        throw new NotFoundError(
          `Project v2 #${this.projectNumber} not found under owner '${this.owner}'.`,
        );
      }

      const statusOptions = new Map<string, string>();
      const priorityOptions = new Map<string, string>();
      let statusFieldId: string | undefined;
      let priorityFieldId: string | undefined;

      const fields = projectData.fields?.nodes ?? [];
      for (const field of fields) {
        const fieldName = (field.name ?? '').toLowerCase();
        if (fieldName === 'status' && Array.isArray(field.options)) {
          statusFieldId = field.id;
          for (const opt of field.options) {
            statusOptions.set(opt.name, opt.id);
          }
        } else if (fieldName === 'priority' && Array.isArray(field.options)) {
          priorityFieldId = field.id;
          for (const opt of field.options) {
            priorityOptions.set(opt.name, opt.id);
          }
        }
      }

      const metadata: ProjectMetadata = {
        projectId: projectData.id,
        title: projectData.title ?? `Project #${this.projectNumber}`,
        number: projectData.number ?? this.projectNumber,
        statusFieldId,
        statusOptions,
        priorityFieldId,
        priorityOptions,
        cachedAt: now,
      };

      this.cachedProjectMetadata = metadata;
      return metadata;
    } catch (err) {
      throw mapGitHubError(err, 'getProjectMetadata');
    }
  }

  // ==========================================
  // Queries
  // ==========================================

  public async listIssues(filter: IssueFilter): Promise<IssueSummary[]> {
    try {
      const res = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        sort: 'updated',
        direction: 'desc',
      });

      // Filter out pull requests
      let issues = res.data.filter((item) => !item.pull_request);

      // Filter by assignee if specified
      if (filter.assignee) {
        const targetAssignee = filter.assignee.toLowerCase();
        issues = issues.filter((item) =>
          item.assignees?.some((a) => a.login.toLowerCase() === targetAssignee),
        );
      }

      // If status filter is specified or we want project statuses, we can cross-reference project items
      let projectItemsMap: Map<number, { status?: CanonicalStatus; priority?: CanonicalPriority }> | null = null;
      try {
        const metadata = await this.getProjectMetadata();
        const itemsRes: any = await this.octokit.graphql(GET_PROJECT_V2_ITEMS, {
          projectId: metadata.projectId,
        });

        projectItemsMap = new Map();
        const nodes = itemsRes?.node?.items?.nodes ?? [];
        for (const item of nodes) {
          if (item.content?.__typename === 'Issue' && item.content.number) {
            let itemStatus: CanonicalStatus | undefined;
            let itemPriority: CanonicalPriority | undefined;

            for (const fv of item.fieldValues?.nodes ?? []) {
              const fieldName = (fv.field?.name ?? '').toLowerCase();
              if (fieldName === 'status' && fv.name) {
                itemStatus = fv.name as CanonicalStatus;
              } else if (fieldName === 'priority' && fv.name) {
                itemPriority = fv.name as CanonicalPriority;
              }
            }

            projectItemsMap.set(item.content.number, {
              status: itemStatus,
              priority: itemPriority,
            });
          }
        }
      } catch {
        // Non-blocking if Projects v2 fails or is unconfigured
        projectItemsMap = null;
      }

      const summaries: IssueSummary[] = [];
      for (const item of issues) {
        const projectInfo = projectItemsMap?.get(item.number);
        const projectStatus = projectInfo?.status;
        const projectPriority = projectInfo?.priority;

        if (filter.status && projectStatus?.toLowerCase() !== filter.status.toLowerCase()) {
          continue;
        }

        summaries.push({
          number: item.number,
          title: item.title,
          htmlUrl: item.html_url,
          state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
          projectStatus,
          projectPriority,
          assignees: item.assignees?.map((a) => a.login) ?? [],
          author: item.user?.login ?? 'ghost',
          labels: item.labels?.map((l) => (typeof l === 'string' ? l : l.name ?? '')) ?? [],
          commentsCount: item.comments,
          updatedAt: item.updated_at,
          createdAt: item.created_at,
        });

        if (filter.limit && summaries.length >= filter.limit) {
          break;
        }
      }

      return summaries;
    } catch (err) {
      throw mapGitHubError(err, 'listIssues');
    }
  }

  public async getIssue(issueNumber: number): Promise<IssueDetail> {
    try {
      const res: any = await this.octokit.graphql(GET_ISSUE_PROJECT_ITEM, {
        owner: this.owner,
        repo: this.repo,
        issueNumber,
      });

      const issueData = res?.repository?.issue;
      if (!issueData) {
        throw new NotFoundError(`Issue #${issueNumber} not found in ${this.owner}/${this.repo}.`);
      }

      let projectItemId: string | undefined;
      let projectStatus: CanonicalStatus | undefined;
      let projectPriority: CanonicalPriority | undefined;

      const projectNodes = issueData.projectItems?.nodes ?? [];
      for (const pNode of projectNodes) {
        if (pNode.project?.number === this.projectNumber || !this.projectNumber) {
          projectItemId = pNode.id;
          for (const fv of pNode.fieldValues?.nodes ?? []) {
            const fieldName = (fv.field?.name ?? '').toLowerCase();
            if (fieldName === 'status' && fv.name) {
              projectStatus = fv.name as CanonicalStatus;
            } else if (fieldName === 'priority' && fv.name) {
              projectPriority = fv.name as CanonicalPriority;
            }
          }
          break;
        }
      }

      // Check comments for blocker reason if blocked
      let blockedReason: string | undefined;
      if (projectStatus === 'Blocked') {
        const comments = issueData.comments?.nodes ?? [];
        for (let i = comments.length - 1; i >= 0; i--) {
          const body = comments[i]?.body ?? '';
          if (body.includes('🚫') || body.toLowerCase().includes('blocked:')) {
            const match = body.match(/(?:🚫\s*\*\*Blocked\*\*:\s*|blocked:\s*)(.+)/i);
            if (match && match[1]) {
              blockedReason = match[1].trim();
              break;
            }
            blockedReason = body;
            break;
          }
        }
      }

      return {
        number: issueData.number,
        title: issueData.title,
        htmlUrl: issueData.url,
        state: issueData.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
        projectStatus,
        projectPriority,
        assignees: issueData.assignees?.nodes?.map((a: any) => a.login) ?? [],
        author: issueData.author?.login ?? 'ghost',
        labels: issueData.labels?.nodes?.map((l: any) => l.name) ?? [],
        commentsCount: issueData.comments?.totalCount ?? 0,
        updatedAt: issueData.updatedAt,
        createdAt: issueData.createdAt,
        body: issueData.body ?? '',
        projectItemId,
        blockedReason,
      };
    } catch (err) {
      throw mapGitHubError(err, `getIssue(#${issueNumber})`);
    }
  }

  public async listMyIssues(githubUserId: number): Promise<IssueSummary[]> {
    try {
      const res = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        sort: 'updated',
        direction: 'desc',
      });

      const myIssues = res.data.filter((item) => {
        if (item.pull_request) return false;
        return item.assignees?.some((a) => (a as any).id === githubUserId);
      });

      return myIssues.map((item) => ({
        number: item.number,
        title: item.title,
        htmlUrl: item.html_url,
        state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
        assignees: item.assignees?.map((a) => a.login) ?? [],
        author: item.user?.login ?? 'ghost',
        labels: item.labels?.map((l) => (typeof l === 'string' ? l : l.name ?? '')) ?? [],
        commentsCount: item.comments,
        updatedAt: item.updated_at,
        createdAt: item.created_at,
      }));
    } catch (err) {
      throw mapGitHubError(err, `listMyIssues(${githubUserId})`);
    }
  }

  public async getProjectSummary(): Promise<ProjectSummary> {
    try {
      const metadata = await this.getProjectMetadata();
      const res: any = await this.octokit.graphql(GET_PROJECT_V2_ITEMS, {
        projectId: metadata.projectId,
      });

      const statusCounts: Record<CanonicalStatus, number> = {
        Backlog: 0,
        Ready: 0,
        'In Progress': 0,
        'In Review': 0,
        Done: 0,
        Blocked: 0,
      };

      let totalOpenIssues = 0;
      let totalOpenPullRequests = 0;

      const items = res?.node?.items?.nodes ?? [];
      for (const item of items) {
        const content = item.content;
        const isOpen = content?.state === 'OPEN';

        if (content?.__typename === 'Issue' && isOpen) {
          totalOpenIssues++;
        } else if (content?.__typename === 'PullRequest' && isOpen) {
          totalOpenPullRequests++;
        }

        // Count status
        for (const fv of item.fieldValues?.nodes ?? []) {
          const fieldName = (fv.field?.name ?? '').toLowerCase();
          if (fieldName === 'status' && fv.name) {
            const statusName = fv.name as CanonicalStatus;
            if (statusCounts[statusName] !== undefined) {
              statusCounts[statusName]++;
            }
          }
        }
      }

      return {
        projectId: metadata.projectId,
        projectNumber: metadata.number,
        title: metadata.title,
        statusCounts,
        totalOpenIssues,
        totalOpenPullRequests,
        lastSyncedAt: new Date().toISOString(),
      };
    } catch (err) {
      throw mapGitHubError(err, 'getProjectSummary');
    }
  }

  public async listReviewRequests(githubUserId?: number): Promise<ReviewRequestSummary[]> {
    try {
      const res = await this.octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        sort: 'updated',
        direction: 'desc',
      });

      let pulls = res.data;
      if (githubUserId !== undefined) {
        pulls = pulls.filter((pr) =>
          pr.requested_reviewers?.some((reviewer: any) => reviewer.id === githubUserId),
        );
      }

      return pulls.map((pr) => ({
        pullNumber: pr.number,
        title: pr.title,
        htmlUrl: pr.html_url,
        author: pr.user?.login ?? 'ghost',
        requestedReviewers: pr.requested_reviewers?.map((r) => r.login) ?? [],
        draft: Boolean(pr.draft),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
      }));
    } catch (err) {
      throw mapGitHubError(err, 'listReviewRequests');
    }
  }

  public async listBlockedIssues(): Promise<BlockedIssueSummary[]> {
    try {
      const issues = await this.listIssues({ limit: 100 });
      const blockedSummaries: BlockedIssueSummary[] = [];

      for (const issue of issues) {
        if (issue.projectStatus === 'Blocked') {
          // Fetch full detail for reason
          const detail = await this.getIssue(issue.number);
          blockedSummaries.push({
            number: detail.number,
            title: detail.title,
            htmlUrl: detail.htmlUrl,
            assignees: detail.assignees,
            blockedReason: detail.blockedReason ?? 'No reason provided',
            blockedAt: detail.updatedAt,
          });
        }
      }

      return blockedSummaries;
    } catch (err) {
      throw mapGitHubError(err, 'listBlockedIssues');
    }
  }

  public async listUnassignedIssues(): Promise<IssueSummary[]> {
    try {
      const res = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: 'open',
        per_page: 100,
        sort: 'created',
        direction: 'desc',
      });

      const unassigned = res.data.filter((item) => {
        if (item.pull_request) return false;
        return !item.assignees || item.assignees.length === 0;
      });

      return unassigned.map((item) => ({
        number: item.number,
        title: item.title,
        htmlUrl: item.html_url,
        state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
        assignees: [],
        author: item.user?.login ?? 'ghost',
        labels: item.labels?.map((l) => (typeof l === 'string' ? l : l.name ?? '')) ?? [],
        commentsCount: item.comments,
        updatedAt: item.updated_at,
        createdAt: item.created_at,
      }));
    } catch (err) {
      throw mapGitHubError(err, 'listUnassignedIssues');
    }
  }

  // ==========================================
  // Mutations
  // ==========================================

  public async createIssue(input: CreateIssueInput): Promise<IssueDetail> {
    try {
      const labels = input.type ? [input.type] : [];
      const res = await this.octokit.rest.issues.create({
        owner: this.owner,
        repo: this.repo,
        title: input.title,
        body: input.body,
        labels,
      });

      const issueNumber = res.data.number;
      const contentId = res.data.node_id;

      // Link to Project v2
      try {
        const metadata = await this.getProjectMetadata();
        await this.octokit.graphql(ADD_PROJECT_V2_ITEM_BY_ID, {
          projectId: metadata.projectId,
          contentId,
        });
      } catch {
        // Project linking failure should not prevent issue return
      }

      return this.getIssue(issueNumber);
    } catch (err) {
      throw mapGitHubError(err, 'createIssue');
    }
  }

  public async assignIssue(
    issueNumber: number,
    assigneeLogin: string,
    _actorGithubUserId: number,
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.addAssignees({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        assignees: [assigneeLogin],
      });
    } catch (err) {
      throw mapGitHubError(err, `assignIssue(#${issueNumber}, ${assigneeLogin})`);
    }
  }

  public async setProjectStatus(
    issueNumber: number,
    status: CanonicalStatus,
    _actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
    blockerReason?: string,
  ): Promise<void> {
    try {
      const issue = await this.getIssue(issueNumber);
      const currentStatus = issue.projectStatus ?? 'Backlog';

      // Concurrency check
      StatusTransitionPolicy.assertStateNotStale(currentStatus, expectedPreviousStatus);

      // Transition rule validation (only if status is actually changing)
      if (currentStatus !== status) {
        StatusTransitionPolicy.assertValidTransition(currentStatus, status, blockerReason);
      }

      if (!issue.projectItemId) {
        throw new ValidationError(`Issue #${issueNumber} is not associated with Project v2.`);
      }

      const metadata = await this.getProjectMetadata();
      if (!metadata.statusFieldId) {
        throw new ValidationError('Project v2 does not have a single-select "Status" field configured.');
      }

      const optionId = metadata.statusOptions.get(status);
      if (!optionId) {
        throw new ValidationError(
          `Status '${status}' is not configured as an option in Project v2 (Available: [${Array.from(metadata.statusOptions.keys()).join(', ')}]).`,
        );
      }

      await this.octokit.graphql(UPDATE_PROJECT_V2_ITEM_FIELD_VALUE, {
        projectId: metadata.projectId,
        itemId: issue.projectItemId,
        fieldId: metadata.statusFieldId,
        optionId,
      });
    } catch (err) {
      throw mapGitHubError(err, `setProjectStatus(#${issueNumber}, ${status})`);
    }
  }

  public async setProjectPriority(
    issueNumber: number,
    priority: CanonicalPriority,
    _actorGithubUserId: number,
    expectedPreviousPriority?: CanonicalPriority,
  ): Promise<void> {
    try {
      const issue = await this.getIssue(issueNumber);
      const currentPriority = issue.projectPriority;

      if (expectedPreviousPriority && currentPriority !== expectedPreviousPriority) {
        throw new ConflictError(
          `Concurrency conflict: issue priority has changed from '${expectedPreviousPriority}' to '${currentPriority}' since preview.`,
        );
      }

      if (!issue.projectItemId) {
        throw new ValidationError(`Issue #${issueNumber} is not associated with Project v2.`);
      }

      const metadata = await this.getProjectMetadata();
      if (!metadata.priorityFieldId) {
        throw new ValidationError('Project v2 does not have a single-select "Priority" field configured.');
      }

      const optionId = metadata.priorityOptions.get(priority);
      if (!optionId) {
        throw new ValidationError(
          `Priority '${priority}' is not configured as an option in Project v2 (Available: [${Array.from(metadata.priorityOptions.keys()).join(', ')}]).`,
        );
      }

      await this.octokit.graphql(UPDATE_PROJECT_V2_ITEM_FIELD_VALUE, {
        projectId: metadata.projectId,
        itemId: issue.projectItemId,
        fieldId: metadata.priorityFieldId,
        optionId,
      });
    } catch (err) {
      throw mapGitHubError(err, `setProjectPriority(#${issueNumber}, ${priority})`);
    }
  }

  public async markBlocked(
    issueNumber: number,
    reason: string,
    actorGithubUserId: number,
    expectedPreviousStatus?: CanonicalStatus,
  ): Promise<void> {
    if (!reason || reason.trim().length < 3) {
      throw new ValidationError(
        'A valid blocker reason (minimum 3 characters) is mandatory when marking an issue as Blocked.',
      );
    }

    try {
      await this.setProjectStatus(
        issueNumber,
        'Blocked',
        actorGithubUserId,
        expectedPreviousStatus,
        reason.trim(),
      );
      await this.addComment(issueNumber, `🚫 **Blocked**: ${reason.trim()}`, actorGithubUserId);
    } catch (err) {
      throw mapGitHubError(err, `markBlocked(#${issueNumber})`);
    }
  }

  public async addComment(
    issueNumber: number,
    text: string,
    _actorGithubUserId: number,
  ): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body: text,
      });
    } catch (err) {
      throw mapGitHubError(err, `addComment(#${issueNumber})`);
    }
  }

  // ==========================================
  // Repository Collaborator Live Permission Check
  // ==========================================

  public async getUserRepoPermission(githubUsername: string): Promise<RepoPermissionLevel> {
    try {
      const res = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: this.owner,
        repo: this.repo,
        username: githubUsername,
      });

      const perm = (res.data.permission || (res.data as any).role_name || '').toLowerCase();
      switch (perm) {
        case 'admin':
          return 'admin';
        case 'maintain':
          return 'maintain';
        case 'write':
          return 'write';
        case 'triage':
          return 'triage';
        case 'read':
          return 'read';
        default:
          return 'none';
      }
    } catch (err: any) {
      if (err?.status === 404) {
        return 'none';
      }
      throw mapGitHubError(err, `getUserRepoPermission(${githubUsername})`);
    }
  }
}
