import type {
  IGitHubOAuthClient,
  GitHubTokenExchangeParams,
  GitHubTokenExchangeResult,
  GitHubUserProfile,
} from '../../src/application/ports/IGitHubOAuthClient.js';
import { ExternalApiError, ValidationError } from '../../src/domain/errors.js';

export class MockGitHubOAuthClient implements IGitHubOAuthClient {
  public defaultTokenResult: GitHubTokenExchangeResult = {
    accessToken: 'ghu_test_mock_token_abcdef123456',
    tokenType: 'bearer',
    scope: 'read:user',
    expiresIn: 28800,
  };

  public defaultUserProfile: GitHubUserProfile = {
    id: 98765432,
    login: 'testuser',
    name: 'Test Developer',
    avatarUrl: 'https://avatars.githubusercontent.com/u/98765432?v=4',
    email: 'testuser@example.com',
  };

  public shouldFailExchange = false;
  public exchangeErrorMessage = 'Bad verification code';
  public shouldFailUserFetch = false;
  public userFetchStatusCode = 503;

  public exchangeCalls: GitHubTokenExchangeParams[] = [];
  public userFetchTokens: string[] = [];

  public async exchangeCodeForToken(
    params: GitHubTokenExchangeParams,
  ): Promise<GitHubTokenExchangeResult> {
    this.exchangeCalls.push(params);
    if (this.shouldFailExchange) {
      throw new ValidationError(this.exchangeErrorMessage);
    }
    return { ...this.defaultTokenResult };
  }

  public async fetchUserProfile(accessToken: string): Promise<GitHubUserProfile> {
    this.userFetchTokens.push(accessToken);
    if (this.shouldFailUserFetch) {
      throw new ExternalApiError('GitHub API unavailable', this.userFetchStatusCode);
    }
    return { ...this.defaultUserProfile };
  }

  public reset(): void {
    this.shouldFailExchange = false;
    this.shouldFailUserFetch = false;
    this.exchangeCalls = [];
    this.userFetchTokens = [];
  }
}
