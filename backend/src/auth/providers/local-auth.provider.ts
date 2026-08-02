import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import {
  ExternalIdentity,
  IAuthProvider,
  IssuedTokens,
  VerifiedToken,
} from './auth-provider.interface';
import { UserRepository } from '../../database/repositories/identity.repositories';

/**
 * Self-contained identity driver: bcrypt password hashes in our own `users`
 * table, JWTs signed with JWT_SECRET.
 *
 * This exists so the backend is runnable and fully testable with no external
 * dependency — CI, local development, and the Phase 1 validation suite all use
 * it. Production is expected to run `AUTH_PROVIDER=supabase`; the env
 * validator warns when this driver is used with NODE_ENV=production.
 */
@Injectable()
export class LocalAuthProvider implements IAuthProvider {
  readonly name = 'local' as const;
  private readonly logger = new Logger(LocalAuthProvider.name);
  private static readonly SALT_ROUNDS = 12;

  /** Reset tokens live in memory: single-node dev convenience, not production. */
  private readonly resetTokens = new Map<string, { email: string; expiresAt: number }>();

  constructor(
    private readonly users: UserRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<ExternalIdentity> {
    const email = input.email.toLowerCase();
    if (await this.users.findByEmail(email)) {
      throw new ConflictException('An account with that email already exists');
    }

    const passwordHash = await bcrypt.hash(input.password, LocalAuthProvider.SALT_ROUNDS);
    const user = await this.users.create({
      email,
      displayName: input.displayName ?? null,
      passwordHash,
      // No mail transport in this driver; treat local accounts as verified so
      // development is not blocked behind an email that will never arrive.
      emailVerified: true,
    });

    return {
      externalId: null,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
    };
  }

  async login(input: { email: string; password: string }) {
    const user = await this.users.findByEmail(input.email);

    // Compare against a dummy hash when the user is missing so that response
    // time does not reveal whether an email is registered.
    const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(input.password, hash);

    if (!user || !ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return {
      identity: {
        externalId: null,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
      },
      tokens: this.issue(user.id, user.email),
    };
  }

  async logout(): Promise<void> {
    // Stateless JWTs: nothing to revoke provider-side. AuthService clears the
    // cached access record, which is what actually ends the session's
    // authorization.
  }

  async verify(accessToken: string): Promise<VerifiedToken> {
    try {
      const claims = await this.jwt.verifyAsync<Record<string, unknown>>(accessToken, {
        secret: this.config.get<string>('auth.jwtSecret'),
      });
      return {
        externalId: null,
        email: String(claims.email ?? ''),
        claims,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const claims = await this.jwt
      .verifyAsync<{ sub: string; email: string; typ?: string }>(refreshToken, {
        secret: this.config.get<string>('auth.jwtSecret'),
      })
      .catch(() => {
        throw new UnauthorizedException('Invalid or expired refresh token');
      });

    if (claims.typ !== 'refresh') {
      throw new UnauthorizedException('Supplied token is not a refresh token');
    }
    return this.issue(claims.sub, claims.email);
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    // Always resolve, whether or not the account exists — otherwise this
    // endpoint becomes an account-enumeration oracle.
    if (!user) return;

    const token = randomBytes(32).toString('hex');
    const digest = createHash('sha256').update(token).digest('hex');
    this.resetTokens.set(digest, {
      email: user.email,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    // A real transport belongs to the notifications module; in this driver the
    // token is logged so a developer can complete the flow.
    this.logger.debug(`Password reset token for ${user.email}: ${token}`);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const digest = createHash('sha256').update(token).digest('hex');
    const entry = this.resetTokens.get(digest);

    if (!entry || entry.expiresAt < Date.now()) {
      this.resetTokens.delete(digest);
      throw new UnauthorizedException('Reset token is invalid or has expired');
    }

    const user = await this.users.findByEmail(entry.email);
    if (!user) throw new UnauthorizedException('Reset token is invalid or has expired');

    await this.users.update(user.id, {
      passwordHash: await bcrypt.hash(newPassword, LocalAuthProvider.SALT_ROUNDS),
    });
    this.resetTokens.delete(digest);
  }

  async sendVerificationEmail(): Promise<void> {
    // Local accounts are created verified; nothing to send.
  }

  private issue(userId: string, email: string): IssuedTokens {
    const secret = this.config.get<string>('auth.jwtSecret');
    const expiresIn = this.config.get<string>('auth.jwtExpiresIn', '1h');

    return {
      accessToken: this.jwt.sign({ sub: userId, email }, { secret, expiresIn }),
      refreshToken: this.jwt.sign(
        { sub: userId, email, typ: 'refresh' },
        { secret, expiresIn: this.config.get<string>('auth.refreshExpiresIn', '7d') },
      ),
      expiresIn: LocalAuthProvider.toSeconds(expiresIn),
      tokenType: 'Bearer',
    };
  }

  private static toSeconds(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) return 3600;
    const value = parseInt(match[1], 10);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]] ?? 3600;
    return value * unit;
  }
}
