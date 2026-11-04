export interface GitHubTokenExchangeParams {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

export interface GitHubTokenExchangeResult {
  accessToken: string;
  tokenType: string;
  scope?: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}

export interface GitHubUserProfile {
  id: number;
  login: string;
  name?: string | null;
  avatarUrl?: string;
  email?: string | null;
}

export interface IGitHubOAuthClient {
  /**
   * Exchanges an authorization code and PKCE verifier for a user access token.
   * Throws ValidationError on invalid code or ExternalApiError on server failure.
   */
  exchangeCodeForToken(params: GitHubTokenExchangeParams): Promise<GitHubTokenExchangeResult>;

  /**
   * Fetches verified user identity from https://api.github.com/user using the access token.
   */
  fetchUserProfile(accessToken: string): Promise<GitHubUserProfile>;
}
