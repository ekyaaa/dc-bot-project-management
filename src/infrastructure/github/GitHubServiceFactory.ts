import { GitHubAppAuth, CustomOctokitInstance } from './GitHubAppAuth.js';
import { GitHubService } from './GitHubService.js';
import type { ProjectRecord } from '../persistence/repositories/ProjectRepository.js';

export interface GitHubServiceFactoryDependencies {
  gitHubAppAuth?: GitHubAppAuth;
  octokit?: CustomOctokitInstance;
  defaultService: GitHubService;
}

export class GitHubServiceFactory {
  private readonly cache = new Map<string, GitHubService>();
  private readonly gitHubAppAuth?: GitHubAppAuth;
  private readonly octokit?: CustomOctokitInstance;
  private readonly defaultService: GitHubService;

  constructor(deps: GitHubServiceFactoryDependencies) {
    this.gitHubAppAuth = deps.gitHubAppAuth;
    this.octokit = deps.octokit;
    this.defaultService = deps.defaultService;
  }

  public getServiceForProject(
    project?: Pick<ProjectRecord, 'github_owner' | 'github_repo' | 'project_number'> | null,
  ): GitHubService {
    if (!project || !project.github_owner || !project.github_repo) {
      return this.defaultService;
    }

    const cacheKey = `${project.github_owner.toLowerCase()}/${project.github_repo.toLowerCase()}#${project.project_number ?? 0}`;
    let service = this.cache.get(cacheKey);
    if (!service) {
      service = new GitHubService({
        config: {
          GITHUB_OWNER: project.github_owner,
          GITHUB_REPOSITORY: project.github_repo,
          GITHUB_PROJECT_NUMBER: project.project_number,
        },
        gitHubAppAuth: this.gitHubAppAuth,
        octokit: this.octokit,
      });
      this.cache.set(cacheKey, service);
    }
    return service;
  }

  public getDefaultService(): GitHubService {
    return this.defaultService;
  }
}
