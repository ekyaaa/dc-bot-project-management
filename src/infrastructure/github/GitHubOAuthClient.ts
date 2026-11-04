import type {
  IGitHubOAuthClient,
  GitHubTokenExchangeParams,
  GitHubTokenExchangeResult,
  GitHubUserProfile,
} from '../../application/ports/IGitHubOAuthClient.js';
import { ExternalApiError, ValidationError } from '../../domain/errors.js';

export class GitHubOAuthClient implements IGitHubOAuthClient {
  constructor(private readonly userAgent: string = 'discord-project-management-bot') {}

  public async exchangeCodeForToken(
    params: GitHubTokenExchangeParams,
  ): Promise<GitHubTokenExchangeResult> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new ExternalApiError(
        `GitHub token endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.error) {
      throw new ValidationError(
        `GitHub OAuth code exchange failed: ${String(data.error_description || data.error)}`,
        { error: data.error, errorDescription: data.error_description },
      );
    }

    if (typeof data.access_token !== 'string') {
      throw new ExternalApiError(
        'Malformed response from GitHub token endpoint: missing access_token',
      );
    }

    return {
      accessToken: data.access_token,
      tokenType: String(data.token_type || 'bearer'),
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : undefined,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
      refreshTokenExpiresIn:
        typeof data.refresh_token_expires_in === 'number'
          ? data.refresh_token_expires_in
          : undefined,
    };
  }

  public async fetchUserProfile(accessToken: string): Promise<GitHubUserProfile> {
    const response = await fetch('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': this.userAgent,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      throw new ExternalApiError(
        `GitHub user endpoint returned HTTP ${response.status}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (typeof data.id !== 'number' || typeof data.login !== 'string') {
      throw new ExternalApiError(
        'Malformed user profile response from GitHub: missing numeric id or login',
      );
    }

    return {
      id: data.id,
      login: data.login,
      name: typeof data.name === 'string' ? data.name : null,
      avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : undefined,
      email: typeof data.email === 'string' ? data.email : null,
    };
  }
}
