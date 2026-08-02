/**
 * Identity provider contract.
 *
 * AuthService depends on this interface, never on Supabase directly, so the
 * identity platform is swappable and the suite can run without a Supabase
 * project. Everything about *authorization* (roles, permissions, org
 * membership) stays in our database regardless of which driver authenticates.
 */
export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

export interface ExternalIdentity {
  /** Provider-side user id — stored on `users.supabaseUserId` when relevant. */
  externalId: string | null;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface VerifiedToken {
  externalId: string | null;
  email: string;
  /** Raw provider claims, for drivers that carry extra data. */
  claims: Record<string, unknown>;
}

export interface IAuthProvider {
  readonly name: 'supabase' | 'local';

  /** Creates the identity. Throws ConflictException if the email is taken. */
  register(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<ExternalIdentity>;

  /** Verifies credentials and returns tokens. Throws on bad credentials. */
  login(input: { email: string; password: string }): Promise<{
    identity: ExternalIdentity;
    tokens: IssuedTokens;
  }>;

  /** Invalidates a session where the provider supports it. */
  logout(accessToken: string): Promise<void>;

  /** Validates an access token's signature and expiry. */
  verify(accessToken: string): Promise<VerifiedToken>;

  /** Exchanges a refresh token for a new access token. */
  refresh(refreshToken: string): Promise<IssuedTokens>;

  /** Starts a password reset. Always resolves — never reveals if the email exists. */
  requestPasswordReset(email: string): Promise<void>;

  /** Completes a password reset using the provider's recovery token. */
  resetPassword(token: string, newPassword: string): Promise<void>;

  /** Re-sends the verification email. */
  sendVerificationEmail(email: string): Promise<void>;
}
