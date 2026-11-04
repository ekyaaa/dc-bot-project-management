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
  private readonly installationOctokit: CustomOctokitInstance;

  constructor(config: Pick<
    Config,
    | 'GITHUB_APP_ID'
    | 'GITHUB_APP_PRIVATE_KEY'
    | 'GITHUB_APP_CLIENT_ID'
    | 'GITHUB_APP_CLIENT_SECRET'
    | 'GITHUB_APP_INSTALLATION_ID'
    | 'GITHUB_WEBHOOK_SECRET'
  >) {
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

    this.installationOctokit = new CustomOctokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_APP_PRIVATE_KEY,
        installationId: config.GITHUB_APP_INSTALLATION_ID,
      },
    });
  }

  public getInstallationOctokit(): CustomOctokitInstance {
    return this.installationOctokit;
  }

  public getApp(): App {
    return this.app;
  }
}
