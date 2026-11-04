import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapGitHubError } from '../../src/infrastructure/github/errorMapper.js';
import {
  DomainError,
  PendingPermissionError,
  RateLimitError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ExternalApiError,
} from '../../src/domain/errors.js';
import { GitHubAppAuth } from '../../src/infrastructure/github/GitHubAppAuth.js';
import { GitHubService } from '../../src/infrastructure/github/GitHubService.js';
import {
  GET_ORG_PROJECT_V2_METADATA,
  GET_PROJECT_V2_ITEMS,
  GET_ISSUE_PROJECT_ITEM,
  ADD_PROJECT_V2_ITEM_BY_ID,
  UPDATE_PROJECT_V2_ITEM_FIELD_VALUE,
} from '../../src/infrastructure/github/graphql/queries.js';

// Sample RSA private key for testing
const TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0mY+0Z2j4L4e0P9D2q9K2g3d4e5f6a7b8c9d0e1f2a3b4c5d
6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f
8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b
0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d
2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f
4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b
-----END RSA PRIVATE KEY-----`;

describe('GitHub Integration & Error Mapping', () => {
  describe('mapGitHubError', () => {
    it('returns DomainError untouched', () => {
      const err = new NotFoundError('Not found');
      expect(mapGitHubError(err)).toBe(err);
    });

    it('maps GraphQL integration permission errors to PendingPermissionError', () => {
      const gqlError = {
        errors: [{ message: 'Resource not accessible by integration' }],
      };
      const result = mapGitHubError(gqlError);
      expect(result).toBeInstanceOf(PendingPermissionError);
      expect(result.message).toContain('GitHub App lacks required permissions');
    });

    it('maps GraphQL viewer permission errors to PendingPermissionError', () => {
      const gqlError = {
        errors: [{ message: 'Viewer does not have permission to view projectV2' }],
      };
      const result = mapGitHubError(gqlError);
      expect(result).toBeInstanceOf(PendingPermissionError);
    });

    it('maps other GraphQL errors to ExternalApiError', () => {
      const gqlError = {
        errors: [{ message: 'Syntax error in query' }],
      };
      const result = mapGitHubError(gqlError);
      expect(result).toBeInstanceOf(ExternalApiError);
      expect(result.message).toContain('Syntax error in query');
    });

    it('maps HTTP 403 rate limit to RateLimitError with retry-after header', () => {
      const httpError = {
        status: 403,
        message: 'API rate limit exceeded for installation',
        response: {
          headers: {
            'x-ratelimit-remaining': '0',
            'retry-after': '120',
          },
        },
      };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(RateLimitError);
      expect((result as RateLimitError).retryAfterSeconds).toBe(120);
    });

    it('maps HTTP 429 rate limit with x-ratelimit-reset', () => {
      const futureEpoch = Math.floor(Date.now() / 1000) + 45;
      const httpError = {
        status: 429,
        message: 'secondary rate limit',
        response: {
          headers: {
            'x-ratelimit-reset': String(futureEpoch),
          },
        },
      };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(RateLimitError);
      expect((result as RateLimitError).retryAfterSeconds).toBeGreaterThanOrEqual(40);
    });

    it('maps HTTP 403 Resource not accessible to PendingPermissionError', () => {
      const httpError = {
        status: 403,
        message: 'Resource not accessible by integration',
      };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(PendingPermissionError);
    });

    it('maps HTTP 404 to NotFoundError', () => {
      const httpError = { status: 404, message: 'Not Found' };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(NotFoundError);
    });

    it('maps HTTP 409 to ConflictError', () => {
      const httpError = { status: 409, message: 'Conflict' };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(ConflictError);
    });

    it('maps HTTP 422 to ValidationError', () => {
      const httpError = { status: 422, message: 'Validation Failed' };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(ValidationError);
    });

    it('maps HTTP 500 to ExternalApiError', () => {
      const httpError = { status: 500, message: 'Internal Server Error' };
      const result = mapGitHubError(httpError);
      expect(result).toBeInstanceOf(ExternalApiError);
      expect((result as ExternalApiError).statusCode).toBe(500);
    });

    it('maps standard Error to ExternalApiError', () => {
      const err = new Error('Network timeout');
      const result = mapGitHubError(err);
      expect(result).toBeInstanceOf(ExternalApiError);
      expect(result.message).toContain('Network timeout');
    });

    it('maps unknown value to ExternalApiError', () => {
      const result = mapGitHubError('string-error');
      expect(result).toBeInstanceOf(ExternalApiError);
    });
  });

  describe('GitHubAppAuth', () => {
    it('initializes correctly with config', () => {
      const auth = new GitHubAppAuth({
        GITHUB_APP_ID: 12345,
        GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
        GITHUB_APP_CLIENT_ID: 'Iv1.testclientid',
        GITHUB_APP_CLIENT_SECRET: 'test_client_secret',
        GITHUB_APP_INSTALLATION_ID: 67890,
        GITHUB_WEBHOOK_SECRET: 'webhook_secret',
      });

      expect(auth.getInstallationOctokit()).toBeDefined();
      expect(auth.getApp()).toBeDefined();
    });
  });

  describe('GitHubService', () => {
    let mockOctokit: any;
    let service: GitHubService;

    const mockConfig = {
      GITHUB_OWNER: 'testorg',
      GITHUB_REPOSITORY: 'testrepo',
      GITHUB_PROJECT_NUMBER: 42,
    };

    const mockProjectV2Data = {
      organization: {
        projectV2: {
          id: 'PVT_kwDOA123',
          title: 'Project Alpha',
          number: 42,
          fields: {
            nodes: [
              {
                id: 'PVTSSF_status',
                name: 'Status',
                options: [
                  { id: 'opt_backlog', name: 'Backlog' },
                  { id: 'opt_ready', name: 'Ready' },
                  { id: 'opt_inprogress', name: 'In Progress' },
                  { id: 'opt_inreview', name: 'In Review' },
                  { id: 'opt_done', name: 'Done' },
                  { id: 'opt_blocked', name: 'Blocked' },
                ],
              },
              {
                id: 'PVTSSF_priority',
                name: 'Priority',
                options: [
                  { id: 'opt_low', name: 'Low' },
                  { id: 'opt_medium', name: 'Medium' },
                  { id: 'opt_high', name: 'High' },
                  { id: 'opt_urgent', name: 'Urgent' },
                ],
              },
            ],
          },
        },
      },
    };

    beforeEach(() => {
      mockOctokit = {
        rest: {
          issues: {
            listForRepo: vi.fn(),
            get: vi.fn(),
            create: vi.fn(),
            addAssignees: vi.fn(),
            createComment: vi.fn(),
          },
          pulls: {
            list: vi.fn(),
          },
          repos: {
            getCollaboratorPermissionLevel: vi.fn(),
          },
        },
        graphql: vi.fn(),
      };

      service = new GitHubService({
        config: mockConfig,
        octokit: mockOctokit,
      });
    });

    it('listIssues: lists open issues and filters out pull requests', async () => {
      mockOctokit.graphql.mockResolvedValue(mockProjectV2Data);
      mockOctokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          {
            number: 1,
            title: 'Issue One',
            html_url: 'https://github.com/testorg/testrepo/issues/1',
            state: 'open',
            user: { login: 'alice' },
            assignees: [{ login: 'bob' }],
            labels: [{ name: 'bug' }],
            comments: 3,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-02T00:00:00Z',
          },
          {
            number: 2,
            title: 'Pull Request Two',
            html_url: 'https://github.com/testorg/testrepo/pull/2',
            pull_request: {}, // Indicates pull request
          },
        ],
      });

      const issues = await service.listIssues({});
      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(1);
      expect(issues[0]!.title).toBe('Issue One');
      expect(issues[0]!.author).toBe('alice');
      expect(issues[0]!.assignees).toEqual(['bob']);
    });

    it('listIssues: filters by assignee and limit', async () => {
      mockOctokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          {
            number: 1,
            title: 'For Alice',
            assignees: [{ login: 'alice' }],
            labels: [],
            comments: 0,
          },
          {
            number: 2,
            title: 'For Bob',
            assignees: [{ login: 'bob' }],
            labels: [],
            comments: 0,
          },
          {
            number: 3,
            title: 'Also For Alice',
            assignees: [{ login: 'alice' }],
            labels: [],
            comments: 0,
          },
        ],
      });

      const issues = await service.listIssues({ assignee: 'alice', limit: 1 });
      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(1);
    });

    it('getIssue: returns detailed card with Project v2 status, priority, and blocked reason', async () => {
      mockOctokit.graphql.mockResolvedValue({
        repository: {
          issue: {
            id: 'I_123',
            number: 5,
            title: 'Blocked Task',
            body: 'Fix the failing CI pipeline.',
            url: 'https://github.com/testorg/testrepo/issues/5',
            state: 'OPEN',
            author: { login: 'alice' },
            assignees: { nodes: [{ id: 'U_bob', login: 'bob', databaseId: 555 }] },
            labels: { nodes: [{ name: 'ci' }] },
            comments: {
              totalCount: 1,
              nodes: [{ body: '🚫 **Blocked**: Waiting for Docker daemon fix' }],
            },
            createdAt: '2026-11-01T00:00:00Z',
            updatedAt: '2026-11-02T00:00:00Z',
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_item5',
                  project: { id: 'PVT_kwDOA123', number: 42 },
                  fieldValues: {
                    nodes: [
                      {
                        name: 'Blocked',
                        field: { id: 'PVTSSF_status', name: 'Status' },
                      },
                      {
                        name: 'Urgent',
                        field: { id: 'PVTSSF_priority', name: 'Priority' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });

      const issue = await service.getIssue(5);
      expect(issue.number).toBe(5);
      expect(issue.projectStatus).toBe('Blocked');
      expect(issue.projectPriority).toBe('Urgent');
      expect(issue.projectItemId).toBe('PVTI_item5');
      expect(issue.blockedReason).toBe('Waiting for Docker daemon fix');
    });

    it('getIssue: throws NotFoundError if issue is missing', async () => {
      mockOctokit.graphql.mockResolvedValue({
        repository: { issue: null },
      });

      await expect(service.getIssue(999)).rejects.toThrow(NotFoundError);
    });

    it('listMyIssues: filters by numeric githubUserId', async () => {
      mockOctokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          {
            number: 10,
            title: 'Assigned to Dev 777',
            assignees: [{ id: 777, login: 'dev777' }],
            labels: [],
            comments: 1,
          },
          {
            number: 11,
            title: 'Assigned to Dev 888',
            assignees: [{ id: 888, login: 'dev888' }],
            labels: [],
            comments: 0,
          },
        ],
      });

      const issues = await service.listMyIssues(777);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.number).toBe(10);
    });

    it('getProjectSummary: aggregates status counts and open item tallies', async () => {
      // 1st call for metadata
      mockOctokit.graphql.mockResolvedValueOnce(mockProjectV2Data);
      // 2nd call for items
      mockOctokit.graphql.mockResolvedValueOnce({
        node: {
          items: {
            nodes: [
              {
                content: { __typename: 'Issue', state: 'OPEN' },
                fieldValues: { nodes: [{ name: 'In Progress', field: { name: 'Status' } }] },
              },
              {
                content: { __typename: 'Issue', state: 'OPEN' },
                fieldValues: { nodes: [{ name: 'Blocked', field: { name: 'Status' } }] },
              },
              {
                content: { __typename: 'PullRequest', state: 'OPEN' },
                fieldValues: { nodes: [{ name: 'In Review', field: { name: 'Status' } }] },
              },
            ],
          },
        },
      });

      const summary = await service.getProjectSummary();
      expect(summary.projectNumber).toBe(42);
      expect(summary.totalOpenIssues).toBe(2);
      expect(summary.totalOpenPullRequests).toBe(1);
      expect(summary.statusCounts['In Progress']).toBe(1);
      expect(summary.statusCounts['Blocked']).toBe(1);
      expect(summary.statusCounts['In Review']).toBe(1);
      expect(summary.statusCounts['Backlog']).toBe(0);
    });

    it('listReviewRequests: returns pull requests with reviewers', async () => {
      mockOctokit.rest.pulls.list.mockResolvedValue({
        data: [
          {
            number: 15,
            title: 'PR Feature',
            html_url: 'https://github.com/pr/15',
            user: { login: 'alice' },
            requested_reviewers: [{ id: 999, login: 'bob' }],
            draft: false,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T01:00:00Z',
          },
        ],
      });

      const prs = await service.listReviewRequests(999);
      expect(prs).toHaveLength(1);
      expect(prs[0]!.pullNumber).toBe(15);
      expect(prs[0]!.requestedReviewers).toContain('bob');
    });

    it('listUnassignedIssues: filters out issues with assignees', async () => {
      mockOctokit.rest.issues.listForRepo.mockResolvedValue({
        data: [
          { number: 1, assignees: [{ login: 'dev' }], labels: [] },
          { number: 2, assignees: [], labels: [{ name: 'help-wanted' }] },
        ],
      });

      const unassigned = await service.listUnassignedIssues();
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0]!.number).toBe(2);
    });

    it('createIssue: creates issue via REST and attaches to Project v2', async () => {
      mockOctokit.rest.issues.create.mockResolvedValue({
        data: { number: 20, node_id: 'I_node_20' },
      });
      // Metadata
      mockOctokit.graphql.mockResolvedValueOnce(mockProjectV2Data);
      // Project add item mutation
      mockOctokit.graphql.mockResolvedValueOnce({
        addProjectV2ItemById: { item: { id: 'PVTI_20' } },
      });
      // getIssue call
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 20,
            title: 'New Bug',
            body: 'Bug desc',
            url: 'https://github.com/issues/20',
            state: 'OPEN',
            author: { login: 'reporter' },
            assignees: { nodes: [] },
            labels: { nodes: [] },
            comments: { totalCount: 0, nodes: [] },
            createdAt: '2026-11-03T00:00:00Z',
            updatedAt: '2026-11-03T00:00:00Z',
            projectItems: { nodes: [] },
          },
        },
      });

      const issue = await service.createIssue({
        title: 'New Bug',
        body: 'Bug desc',
        actorGithubUserId: 123,
      });

      expect(issue.number).toBe(20);
      expect(mockOctokit.rest.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New Bug', body: 'Bug desc' }),
      );
    });

    it('assignIssue: invokes addAssignees REST endpoint', async () => {
      mockOctokit.rest.issues.addAssignees.mockResolvedValue({});
      await service.assignIssue(10, 'alice', 123);
      expect(mockOctokit.rest.issues.addAssignees).toHaveBeenCalledWith({
        owner: 'testorg',
        repo: 'testrepo',
        issue_number: 10,
        assignees: ['alice'],
      });
    });

    it('setProjectStatus: verifies concurrency and state transitions before mutating', async () => {
      // 1. getIssue mock (current status: Ready)
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 7,
            url: 'https://github.com/issues/7',
            state: 'OPEN',
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_7',
                  project: { number: 42 },
                  fieldValues: { nodes: [{ name: 'Ready', field: { name: 'Status' } }] },
                },
              ],
            },
          },
        },
      });

      // 2. getProjectMetadata mock
      mockOctokit.graphql.mockResolvedValueOnce(mockProjectV2Data);

      // 3. updateProjectV2ItemFieldValue mutation
      mockOctokit.graphql.mockResolvedValueOnce({
        updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_7' } },
      });

      // Valid transition Ready -> In Progress
      await service.setProjectStatus(7, 'In Progress', 123, 'Ready');

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        UPDATE_PROJECT_V2_ITEM_FIELD_VALUE,
        expect.objectContaining({
          itemId: 'PVTI_7',
          optionId: 'opt_inprogress',
        }),
      );
    });

    it('setProjectStatus: throws ConflictError if expectedPreviousStatus is stale', async () => {
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 7,
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_7',
                  project: { number: 42 },
                  fieldValues: { nodes: [{ name: 'In Progress', field: { name: 'Status' } }] },
                },
              ],
            },
          },
        },
      });

      await expect(service.setProjectStatus(7, 'In Review', 123, 'Ready')).rejects.toThrow(
        ConflictError,
      );
    });

    it('setProjectStatus: throws ConflictError for invalid transition (Backlog -> Done)', async () => {
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 7,
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_7',
                  project: { number: 42 },
                  fieldValues: { nodes: [{ name: 'Backlog', field: { name: 'Status' } }] },
                },
              ],
            },
          },
        },
      });

      await expect(service.setProjectStatus(7, 'Done', 123, 'Backlog')).rejects.toThrow(
        ConflictError,
      );
    });

    it('setProjectPriority: updates singleSelect priority field', async () => {
      // getIssue
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 8,
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_8',
                  project: { number: 42 },
                  fieldValues: { nodes: [{ name: 'Low', field: { name: 'Priority' } }] },
                },
              ],
            },
          },
        },
      });
      // Metadata
      mockOctokit.graphql.mockResolvedValueOnce(mockProjectV2Data);
      // Mutation
      mockOctokit.graphql.mockResolvedValueOnce({});

      await service.setProjectPriority(8, 'Urgent', 123, 'Low');

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        UPDATE_PROJECT_V2_ITEM_FIELD_VALUE,
        expect.objectContaining({
          itemId: 'PVTI_8',
          optionId: 'opt_urgent',
        }),
      );
    });

    it('markBlocked: validates reason length, sets status to Blocked, and posts comment', async () => {
      // 1. Validation failure on short reason
      await expect(service.markBlocked(9, 'no', 123)).rejects.toThrow(ValidationError);

      // 2. getIssue
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          issue: {
            number: 9,
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_9',
                  project: { number: 42 },
                  fieldValues: { nodes: [{ name: 'In Progress', field: { name: 'Status' } }] },
                },
              ],
            },
          },
        },
      });
      // Metadata
      mockOctokit.graphql.mockResolvedValueOnce(mockProjectV2Data);
      // Status update mutation
      mockOctokit.graphql.mockResolvedValueOnce({});
      // Comment creation
      mockOctokit.rest.issues.createComment.mockResolvedValue({});

      await service.markBlocked(9, 'Waiting for security review', 123, 'In Progress');

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 9,
          body: '🚫 **Blocked**: Waiting for security review',
        }),
      );
    });

    it('getUserRepoPermission: maps collaborator permission and handles 404', async () => {
      mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
        data: { permission: 'admin' },
      });
      expect(await service.getUserRepoPermission('admin_user')).toBe('admin');

      mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
        data: { permission: 'write' },
      });
      expect(await service.getUserRepoPermission('writer_user')).toBe('write');

      // 404 handled cleanly as 'none'
      mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValueOnce({
        status: 404,
        message: 'User is not a collaborator',
      });
      expect(await service.getUserRepoPermission('stranger')).toBe('none');
    });
  });
});
