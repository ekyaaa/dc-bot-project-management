import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { createAppAuth } from '@octokit/auth-app';
import { App } from '@octokit/app';
import type { Config } from '../../config/env.js';

export const CustomOctokit = CoreOctokit.plugin(paginateRest, restEndpointMethods);
export type CustomOctokitInstance = InstanceType<typeof CustomOctokit>;

export interface GitHubAppAuthConfig {
  appId: number;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  installationId: number;
  webhookSecret: string;
}

export class GitHubAppAuth {
  private readonly app: App;
  private readonly defaultInstallationOctokit: CustomOctokitInstance;
  private readonly installationOctokits = new Map<number, CustomOctokitInstance>();
  private readonly repoInstallationCache = new Map<string, number>();

  constructor(
    private readonly config: Pick<
      Config,
      | 'GITHUB_APP_ID'
      | 'GITHUB_APP_PRIVATE_KEY'
      | 'GITHUB_APP_CLIENT_ID'
      | 'GITHUB_APP_CLIENT_SECRET'
      | 'GITHUB_APP_INSTALLATION_ID'
      | 'GITHUB_WEBHOOK_SECRET'
    >,
  ) {
    this.app = new App({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_APP_PRIVATE_KEY,
      oauth: {
        clientId: config.GITHUB_APP_CLIENT_ID,
        clientSecret: config.GITHUB_APP_CLIENT_SECRET,
      },
      webhooks: {
        secret: config.GITHUB_WEBHOOK_SECRET,
      },
    });

    this.defaultInstallationOctokit = new CustomOctokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
        installationId: config.GITHUB_APP_INSTALLATION_ID,
      },
    });
  }

  public getInstallationOctokit(): CustomOctokitInstance {
    return this.defaultInstallationOctokit;
  }

  public async getOctokitForRepo(owner: string, repo: string): Promise<CustomOctokitInstance> {
    const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
    let installationId = this.repoInstallationCache.get(cacheKey);

    if (!installationId) {
      try {
        const { data } = await this.app.octokit.request('GET /repos/{owner}/{repo}/installation', {
          owner,
          repo,
        });
        installationId = data.id;
        this.repoInstallationCache.set(cacheKey, installationId);
      } catch {
        try {
          const { data: orgInst } = await this.app.octokit.request('GET /orgs/{org}/installation', {
            org: owner,
          });
          installationId = orgInst.id;
          this.repoInstallationCache.set(cacheKey, installationId);
        } catch {
          return this.defaultInstallationOctokit;
        }
      }
    }

    if (!this.installationOctokits.has(installationId)) {
      const octokit = new CustomOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: this.config.GITHUB_APP_ID,
          privateKey: this.config.GITHUB_APP_PRIVATE_KEY,
          installationId,
        },
      });
      this.installationOctokits.set(installationId, octokit);
    }

    return this.installationOctokits.get(installationId)!;
  }

  public getApp(): App {
    return this.app;
  }
}
