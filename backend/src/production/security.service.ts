import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IpAllowEntry, MfaEnrollment, SecretRotation, UserSession } from '@prisma/client';
import {
  IpAllowRepository,
  MfaRepository,
  SecretRotationRepository,
  UserSessionRepository,
} from '../database/repositories/production.repositories';
import {
  ApiKeyRepository,
  WebhookEndpointRepository,
} from '../database/repositories/automation.repositories';
import { CredentialRepository } from '../database/repositories/tenant.repositories';
import { MembershipRepository } from '../database/repositories/identity.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { Metric, MetricsService } from './metrics.service';

/**
 * Enterprise security controls: second factors, session lifetime, network
 * restrictions and secret rotation.
 *
 * TOTP is implemented here rather than pulled in for the same reason the
 * semver comparator was in Phase 7: the algorithm is thirty lines of HMAC and
 * a counter, the correctness properties are testable, and a wrong
 * implementation of "is this code valid" is a security hole rather than a bug.
 * What a library would add — QR rendering, provisioning helpers — is
 * presentation.
 *
 * Two decisions worth stating:
 *
 * **Verification accepts one step either side of now.** Clocks drift, and a
 * second factor that rejects a correct code because a phone is four seconds
 * fast gets switched off by the people it protects. One step is ±30 seconds;
 * widening further would meaningfully enlarge the guessing window.
 *
 * **Recovery codes are stored hashed and consumed on use.** They are passwords
 * that bypass the second factor, so they get the same treatment as passwords,
 * and a code that survived being used would be a permanent bypass.
 */
@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);

  private static readonly TOTP_STEP_SECONDS = 30;
  private static readonly TOTP_DIGITS = 6;
  /** Steps of clock skew tolerated either side of now. */
  private static readonly TOTP_WINDOW = 1;
  private static readonly RECOVERY_CODES = 10;

  constructor(
    private readonly mfa: MfaRepository,
    private readonly sessions: UserSessionRepository,
    private readonly allowlist: IpAllowRepository,
    private readonly rotations: SecretRotationRepository,
    private readonly credentials: CredentialRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly webhooks: WebhookEndpointRepository,
    private readonly memberships: MembershipRepository,
    private readonly crypto: CryptoService,
    private readonly metrics: MetricsService,
    private readonly events: EventBusService,
  ) {}

  // ============================================================ TOTP

  /** RFC 4648 base32, which is what every authenticator app expects. */
  private static base32Encode(buffer: Buffer): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    return output;
  }

  private static base32Decode(encoded: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (const character of clean) {
      const index = alphabet.indexOf(character);
      if (index < 0) continue;
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  /** HOTP over a time counter — the whole of TOTP. */
  private static totp(secret: Buffer, counter: number): string {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);

    const digest = createHmac('sha1', secret).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);

    return String(binary % 10 ** SecurityService.TOTP_DIGITS).padStart(
      SecurityService.TOTP_DIGITS,
      '0',
    );
  }

  /** Constant-time, because a code comparison is a secret comparison. */
  private static codesMatch(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  /**
   * Begins enrolment. The secret is returned once, here, and sealed at rest;
   * the enrolment is not active until a code proves the user actually stored it.
   */
  async beginMfaEnrolment(
    userId: string,
    accountLabel: string,
  ): Promise<{ secret: string; otpauthUrl: string; digits: number; period: number }> {
    const existing = await this.mfa.find(userId);
    if (existing?.confirmedAt && !existing.disabledAt) {
      throw new BadRequestException('A second factor is already enrolled; disable it first');
    }

    const secret = randomBytes(20);
    const encoded = SecurityService.base32Encode(secret);

    await this.mfa.upsert(userId, {
      method: 'TOTP',
      secret: this.crypto.seal(encoded) as never,
      confirmedAt: null,
      disabledAt: null,
      recoveryCodes: [],
    });

    const issuer = encodeURIComponent('PRISM-X');
    const label = encodeURIComponent(accountLabel);
    return {
      secret: encoded,
      otpauthUrl:
        `otpauth://totp/${issuer}:${label}?secret=${encoded}&issuer=${issuer}` +
        `&algorithm=SHA1&digits=${SecurityService.TOTP_DIGITS}&period=${SecurityService.TOTP_STEP_SECONDS}`,
      digits: SecurityService.TOTP_DIGITS,
      period: SecurityService.TOTP_STEP_SECONDS,
    };
  }

  /** Confirms enrolment and issues recovery codes — shown exactly once. */
  async confirmMfaEnrolment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const enrolment = await this.mfa.find(userId);
    if (!enrolment) throw new BadRequestException('No enrolment is in progress');
    if (enrolment.confirmedAt && !enrolment.disabledAt) {
      throw new BadRequestException('This second factor is already confirmed');
    }
    if (!this.verifyTotp(enrolment, code)) {
      this.metrics.increment(Metric.AuthFailures, { reason: 'mfa_enrolment' });
      throw new UnauthorizedException('That code is not valid');
    }

    const codes = Array.from({ length: SecurityService.RECOVERY_CODES }, () =>
      randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'),
    );

    await this.mfa.update(userId, {
      confirmedAt: new Date(),
      disabledAt: null,
      lastUsedAt: new Date(),
      // Hashed, like passwords, because that is what they are.
      recoveryCodes: codes.map((c) => SecurityService.hash(c)),
    });

    await this.events.publish(DomainEvent.MfaEnrolled, { userId });
    return { recoveryCodes: codes };
  }

  private verifyTotp(enrolment: MfaEnrollment, code: string): boolean {
    const sealed = enrolment.secret as unknown as { value: string; iv: string; authTag: string };
    if (!sealed?.value) return false;

    const secret = SecurityService.base32Decode(this.crypto.open(sealed));
    const counter = Math.floor(Date.now() / 1000 / SecurityService.TOTP_STEP_SECONDS);
    const supplied = String(code ?? '').replace(/\s/g, '');

    for (let drift = -SecurityService.TOTP_WINDOW; drift <= SecurityService.TOTP_WINDOW; drift += 1) {
      if (SecurityService.codesMatch(SecurityService.totp(secret, counter + drift), supplied)) {
        return true;
      }
    }
    return false;
  }

  /** Verifies a second factor, accepting a recovery code and consuming it. */
  async verifySecondFactor(userId: string, code: string): Promise<{ ok: boolean; method: string }> {
    const enrolment = await this.mfa.find(userId);
    if (!enrolment || !enrolment.confirmedAt || enrolment.disabledAt) {
      return { ok: false, method: 'none' };
    }

    if (this.verifyTotp(enrolment, code)) {
      await this.mfa.update(userId, { lastUsedAt: new Date() });
      return { ok: true, method: 'TOTP' };
    }

    const hashed = SecurityService.hash(String(code ?? '').trim().toUpperCase());
    if (enrolment.recoveryCodes.includes(hashed)) {
      await this.mfa.update(userId, {
        // Consumed: a recovery code that survived use would be a standing bypass.
        recoveryCodes: enrolment.recoveryCodes.filter((c) => c !== hashed),
        lastUsedAt: new Date(),
      });
      this.logger.warn(`Recovery code used for ${userId}`);
      return { ok: true, method: 'RECOVERY_CODE' };
    }

    this.metrics.increment(Metric.AuthFailures, { reason: 'mfa' });
    return { ok: false, method: 'none' };
  }

  async disableMfa(userId: string, code: string): Promise<void> {
    const enrolment = await this.mfa.find(userId);
    if (!enrolment) throw new BadRequestException('No second factor is enrolled');

    // Disabling needs the factor itself. Otherwise a stolen session removes the
    // control that a stolen session was supposed to run into.
    const verified = await this.verifySecondFactor(userId, code);
    if (!verified.ok) throw new UnauthorizedException('That code is not valid');

    await this.mfa.update(userId, { disabledAt: new Date(), recoveryCodes: [] });
    await this.events.publish(DomainEvent.MfaDisabled, { userId });
  }

  async mfaStatus(userId: string): Promise<Record<string, unknown>> {
    const enrolment = await this.mfa.find(userId);
    return {
      enrolled: Boolean(enrolment?.confirmedAt && !enrolment.disabledAt),
      pending: Boolean(enrolment && !enrolment.confirmedAt && !enrolment.disabledAt),
      method: enrolment?.method ?? null,
      recoveryCodesRemaining: enrolment?.recoveryCodes.length ?? 0,
      lastUsedAt: enrolment?.lastUsedAt ?? null,
    };
  }

  private static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  // ============================================================ sessions

  async openSession(input: {
    userId: string;
    token: string;
    ip?: string;
    userAgent?: string;
    ttlSeconds?: number;
    mfaSatisfied?: boolean;
  }): Promise<UserSession> {
    return this.sessions.create({
      userId: input.userId,
      tokenHash: SecurityService.hash(input.token),
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      mfaSatisfied: input.mfaSatisfied ?? false,
      expiresAt: new Date(Date.now() + (input.ttlSeconds ?? 3600) * 1000),
    });
  }

  listSessions(userId?: string): Promise<UserSession[]> {
    return this.sessions.active(userId);
  }

  async revokeSession(id: string, reason = 'revoked by user'): Promise<{ revoked: boolean }> {
    const count = await this.sessions.revoke(id, reason);
    if (count) await this.events.publish(DomainEvent.SessionRevoked, { sessionId: id, reason });
    return { revoked: count > 0 };
  }

  /** Ends every session for a user — what a compromised password requires. */
  async revokeAllSessions(userId: string, reason = 'all sessions revoked'): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAllForUser(userId, reason);
    if (revoked) await this.events.publish(DomainEvent.SessionRevoked, { userId, revoked, reason });
    return { revoked };
  }

  // ============================================================ network

  addAllowEntry(cidr: string, label?: string): Promise<IpAllowEntry> {
    if (!SecurityService.validCidr(cidr)) {
      throw new BadRequestException(`"${cidr}" is not a valid IPv4 address or CIDR block`);
    }
    return this.allowlist.create({
      cidr,
      label: label ?? null,
      createdById: RequestContextStore.get()?.userId ?? null,
    });
  }

  listAllowEntries(): Promise<IpAllowEntry[]> {
    return this.allowlist.findMany({}, { orderBy: { createdAt: 'asc' } });
  }

  async removeAllowEntry(id: string): Promise<void> {
    await this.allowlist.findByIdOrFail(id);
    await this.allowlist.remove(id);
  }

  /**
   * Whether an address may act for an organization.
   *
   * An empty allowlist means no restriction, not "deny everything". The
   * alternative locks an organization out the moment they add their first
   * entry from an address they did not think of, which is how this feature
   * gets disabled permanently after one incident.
   */
  async addressPermitted(organizationId: string, ip: string | undefined): Promise<boolean> {
    const entries = await this.allowlist.enabledForOrganization(organizationId);
    if (!entries.length) return true;
    if (!ip) return false;

    const permitted = entries.some((entry) => SecurityService.withinCidr(ip, entry.cidr));
    if (!permitted) {
      this.metrics.increment(Metric.AuthFailures, { reason: 'ip_restriction' });
      await this.events.publish(DomainEvent.AccessDeniedByIp, { organizationId, ip });
    }
    return permitted;
  }

  private static validCidr(value: string): boolean {
    const [address, prefix] = value.split('/');
    const octets = address.split('.');
    if (octets.length !== 4) return false;
    if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
    if (prefix === undefined) return true;
    return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32;
  }

  private static toInt(address: string): number {
    return address
      .split('.')
      .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
  }

  static withinCidr(ip: string, cidr: string): boolean {
    if (!SecurityService.validCidr(ip.split('/')[0])) return false;
    const [network, prefixText] = cidr.split('/');
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (prefix === 0) return true;

    // Shifting by 32 is undefined in JavaScript, which is why /32 is special-cased.
    const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
    return (SecurityService.toInt(ip) & mask) === (SecurityService.toInt(network) & mask);
  }

  // ============================================================ rotation

  /**
   * Rotates a class of secret, with an overlap window.
   *
   * The overlap is the difference between rotation and an outage. Old material
   * keeps verifying while callers pick up the new, and only then is it retired.
   * A rotation that invalidates everything the instant it runs is one nobody
   * performs twice.
   */
  async rotate(
    scope: SecretRotation['scope'],
    options: { overlapHours?: number } = {},
  ): Promise<SecretRotation> {
    const previous = await this.rotations.latest(scope);
    const rotation = await this.rotations.create({
      scope,
      status: 'RUNNING',
      previousKeyId: previous?.newKeyId ?? '',
      newKeyId: randomBytes(8).toString('hex'),
      actorId: RequestContextStore.get()?.userId ?? null,
      overlapUntil: new Date(Date.now() + (options.overlapHours ?? 24) * 3_600_000),
    });

    try {
      const rotated = await this.performRotation(scope);
      const finished = await this.rotations.update(rotation.id, {
        status: 'OVERLAPPING',
        itemsRotated: rotated.rotated,
        itemsFailed: rotated.failed,
        finishedAt: new Date(),
      });

      await this.events.publish(DomainEvent.SecretRotated, {
        scope,
        rotated: rotated.rotated,
        failed: rotated.failed,
      });
      this.logger.log(`Rotated ${rotated.rotated} ${scope} secret(s), ${rotated.failed} failed`);
      return finished;
    } catch (error) {
      return this.rotations.update(rotation.id, {
        status: 'FAILED',
        error: (error as Error).message.slice(0, 500),
        finishedAt: new Date(),
      });
    }
  }

  private async performRotation(
    scope: SecretRotation['scope'],
  ): Promise<{ rotated: number; failed: number }> {
    let rotated = 0;
    let failed = 0;

    if (scope === 'CREDENTIAL_KEY') {
      // Re-seal every credential under the current key. The plaintext is
      // decrypted and re-encrypted in one step so no credential is ever
      // persisted unsealed, even momentarily.
      const credentials = await this.credentials.findMany({}, { take: 1000 });
      for (const credential of credentials) {
        try {
          const plain = this.crypto.open({
            value: credential.value,
            iv: credential.iv,
            authTag: credential.authTag,
          });
          const resealed = this.crypto.seal(plain);
          await this.credentials.update(credential.id, resealed as unknown as Record<string, unknown>);
          rotated += 1;
        } catch {
          failed += 1;
        }
      }
      return { rotated, failed };
    }

    if (scope === 'WEBHOOK_SECRET') {
      const endpoints = await this.webhooks.findMany({}, { take: 500 });
      for (const endpoint of endpoints) {
        try {
          await this.webhooks.update(endpoint.id, { secret: randomBytes(24).toString('hex') });
          rotated += 1;
        } catch {
          failed += 1;
        }
      }
      return { rotated, failed };
    }

    if (scope === 'API_KEY') {
      // Keys cannot be re-issued without the holder, so rotation here means
      // retiring what has already expired. Anything live is the customer's to
      // roll, and silently invalidating their key would be an outage we caused.
      const expired = await this.apiKeys.findMany(
        { expiresAt: { lt: new Date() }, revokedAt: null },
        { take: 500 },
      );
      for (const key of expired) {
        await this.apiKeys.update(key.id, { revokedAt: new Date() });
        rotated += 1;
      }
      return { rotated, failed };
    }

    return { rotated, failed };
  }

  rotationHistory(take = 50): Promise<SecretRotation[]> {
    return this.rotations.list(take);
  }

  /** Age of the newest rotation per scope — what the readiness review reads. */
  async rotationPosture(): Promise<Record<string, unknown>> {
    const scopes: SecretRotation['scope'][] = [
      'CREDENTIAL_KEY',
      'API_KEY',
      'WEBHOOK_SECRET',
      'NODE_KEY',
    ];
    const entries = await Promise.all(
      scopes.map(async (scope) => {
        const latest = await this.rotations.latest(scope);
        return [
          scope,
          {
            lastRotatedAt: latest?.startedAt ?? null,
            ageDays: latest
              ? Number(((Date.now() - latest.startedAt.getTime()) / 86_400_000).toFixed(1))
              : null,
            itemsRotated: latest?.itemsRotated ?? 0,
          },
        ] as const;
      }),
    );

    const ages = entries
      .map(([, value]) => value.ageDays)
      .filter((age): age is number => age !== null);

    return {
      scopes: Object.fromEntries(entries),
      // Null when nothing has ever rotated, which the review treats as unknown
      // rather than as fresh.
      oldestAgeDays: ages.length ? Math.max(...ages) : null,
    };
  }

  // ============================================================ posture

  /** Everything the readiness review needs about security, in one query set. */
  async posture(): Promise<Record<string, unknown>> {
    const members = await this.memberships.listByOrganization(
      RequestContextStore.require().organizationId,
    );
    const administrators = members.filter((m) =>
      ['OWNER', 'ADMIN'].includes((m as { role: { key: string } }).role.key),
    );
    const enrolled = await this.mfa.confirmedFor(administrators.map((m) => m.userId));

    const [staleKeys, rotation, sessions] = await Promise.all([
      this.apiKeys.findMany({ expiresAt: { lt: new Date() }, revokedAt: null }, { take: 200 }),
      this.rotationPosture(),
      this.sessions.active(),
    ]);

    return {
      administrators: administrators.length,
      administratorsWithMfa: enrolled.length,
      mfaCoverage: administrators.length
        ? Number((enrolled.length / administrators.length).toFixed(2))
        : null,
      staleApiKeys: staleKeys.length,
      activeSessions: sessions.length,
      rotation,
      allowlistEntries: (await this.allowlist.enabled()).length,
    };
  }

  /** Asserts a second factor for an action that should require one. */
  async requireSecondFactor(userId: string, code: string | undefined): Promise<void> {
    const status = await this.mfaStatus(userId);
    if (!status.enrolled) return; // Nothing enrolled; nothing to assert.
    if (!code) throw new ForbiddenException('This action requires your second factor');
    const verified = await this.verifySecondFactor(userId, code);
    if (!verified.ok) throw new UnauthorizedException('That code is not valid');
  }
}
