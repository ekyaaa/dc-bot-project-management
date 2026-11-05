import { describe, it, expect, vi } from 'vitest';
import { GitHubServiceFactory } from '../../src/infrastructure/github/GitHubServiceFactory.js';
import { GitHubService } from '../../src/infrastructure/github/GitHubService.js';

describe('GitHubServiceFactory', () => {
  const mockDefaultService = {} as unknown as GitHubService;

  it('returns defaultService when no project is provided', () => {
    const factory = new GitHubServiceFactory({ defaultService: mockDefaultService });
    expect(factory.getServiceForProject(null)).toBe(mockDefaultService);
    expect(factory.getServiceForProject(undefined)).toBe(mockDefaultService);
    expect(factory.getDefaultService()).toBe(mockDefaultService);
  });

  it('instantiates and caches a GitHubService for a specific project', () => {
    const mockAuth = {
      getInstallationOctokit: () => ({} as any),
      getOctokitForRepo: async () => ({} as any),
    } as any;
    const factory = new GitHubServiceFactory({
      defaultService: mockDefaultService,
      gitHubAppAuth: mockAuth,
    });
    const projectA = {
      github_owner: 'ownerA',
      github_repo: 'repoA',
      project_number: 1,
    };

    const service1 = factory.getServiceForProject(projectA);
    const service2 = factory.getServiceForProject(projectA);

    expect(service1).toBeDefined();
    expect(service1).not.toBe(mockDefaultService);
    expect(service1).toBe(service2); // Caching check
  });
});
