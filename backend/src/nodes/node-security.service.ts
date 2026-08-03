import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Node, NodeKey } from '@prisma/client';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NodeKeyRepository } from '../database/repositories/distributed.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';

export interface SignedHeaders {
  'x-prismx-node-id': string;
  'x-prismx-key-version': string;
  'x-prismx-timestamp': string;
  'x-prismx-signature': string;
}

export interface VerifiedNodeCaller {
  nodeId: string;
  organizationId: string;
  keyVersion: number;
}

export interface IssuedNodeSecret {
  nodeId: string;
  keyVersion: number;
  /** Plaintext. Returned at registration or rotation and not shown again. */
  secret: string;
}

/**
 * Mutual authentication between the control plane and its nodes.
 *
 * Every message in either direction carries an HMAC-SHA256 signature over
 * `<timestamp>.<body>`, which buys three things a bearer token does not:
 * the body cannot be altered in flight, a captured request expires, and the
 * node can verify the control plane just as the control plane verifies the
 * node. Both sides hold the same per-node secret, versioned so a rotation
 * can overlap instead of severing a running node mid-task.
 *
 * A node that fails verification is refused and the attempt is recorded — an
 * unexplained burst of `node.auth_failed` is exactly the signal that someone
 * is probing the fleet.
 */
@Injectable()
export class NodeSecurityService {
  private readonly logger = new Logger(NodeSecurityService.name);

  /** How far a timestamp may drift before a request is treated as replayed. */
  static readonly CLOCK_SKEW_SECONDS = 300;
  /** Overlap during which a rotated-out key still verifies. */
  static readonly ROTATION_OVERLAP_MS = 15 * 60 * 1000;

  constructor(
    private readonly keys: NodeKeyRepository,
    private readonly crypto: CryptoService,
    private readonly events: EventBusService,
  ) {}

  // ----------------------------------------------------------------
  // Signing
  // ----------------------------------------------------------------

  /**
   * `v1=<hmac>` over `<timestamp>.<body>`.
   *
   * The timestamp is inside the signed material rather than beside it, so an
   * attacker cannot take a valid signature and pair it with a fresh
   * timestamp to extend its life.
   */
  static sign(secret: string, timestamp: number, body: string): string {
    const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `v1=${mac}`;
  }

  static verifySignature(
    secret: string,
    signature: string,
    timestamp: number,
    body: string,
    toleranceSeconds = NodeSecurityService.CLOCK_SKEW_SECONDS,
  ): boolean {
    if (!signature || !Number.isFinite(timestamp)) return false;

    const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (age > toleranceSeconds) return false;

    const expected = NodeSecurityService.sign(secret, timestamp, body);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // Length must match before timingSafeEqual, which throws on a mismatch —
    // and an early return here leaks only the length, never the content.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  static hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /** 32 bytes of entropy, base64url so it survives headers and shells intact. */
  static generateSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  /** Deterministic fingerprint an operator can compare without seeing the key. */
  static fingerprint(secret: string): string {
    return NodeSecurityService.hash(secret).slice(0, 16);
  }

  // ----------------------------------------------------------------
  // Key lifecycle
  // ----------------------------------------------------------------

  /** Creates version 1 of a node's key. Called once, during registration. */
  async issueInitialKey(nodeId: string): Promise<IssuedNodeSecret> {
    const secret = NodeSecurityService.generateSecret();
    const sealed = this.crypto.seal(secret);

    await this.keys.create({
      nodeId,
      version: 1,
      secretHash: NodeSecurityService.hash(secret),
      secretCipher: sealed.value,
      secretIv: sealed.iv,
      secretTag: sealed.authTag,
      status: 'ACTIVE',
    });

    return { nodeId, keyVersion: 1, secret };
  }

  /**
   * Issues the next key version and retires the current one after an overlap.
   *
   * The old key stays valid for a quarter of an hour, which is what makes
   * rotation a non-event: a node holding an in-flight task finishes it,
   * picks up the new secret on its next heartbeat, and nothing is dropped.
   * Revoking immediately is a separate, deliberate action.
   */
  async rotate(node: Node): Promise<IssuedNodeSecret> {
    const existing = await this.keys.listForNode(node.id);
    const nextVersion = Math.max(0, ...existing.map((k) => k.version)) + 1;

    const secret = NodeSecurityService.generateSecret();
    const sealed = this.crypto.seal(secret);

    await this.keys.create({
      nodeId: node.id,
      version: nextVersion,
      secretHash: NodeSecurityService.hash(secret),
      secretCipher: sealed.value,
      secretIv: sealed.iv,
      secretTag: sealed.authTag,
      status: 'ACTIVE',
    });

    const retiresAt = new Date(Date.now() + NodeSecurityService.ROTATION_OVERLAP_MS);
    for (const key of existing.filter((k) => k.status === 'ACTIVE')) {
      await this.keys.update(key.id, { status: 'RETIRING', retiresAt });
    }

    await this.events.publish(DomainEvent.NodeKeyRotated, {
      nodeId: node.id,
      keyVersion: nextVersion,
      previousVersions: existing.map((k) => k.version),
      overlapUntil: retiresAt.toISOString(),
    });

    return { nodeId: node.id, keyVersion: nextVersion, secret };
  }

  /** Immediate revocation. No overlap — used when a key is believed stolen. */
  async revokeAll(nodeId: string): Promise<number> {
    const existing = await this.keys.listForNode(nodeId);
    let revoked = 0;
    for (const key of existing.filter((k) => k.status !== 'REVOKED')) {
      await this.keys.update(key.id, { status: 'REVOKED', revokedAt: new Date() });
      revoked += 1;
    }
    return revoked;
  }

  /** The secret the control plane signs outbound calls to this node with. */
  async currentSecret(nodeId: string): Promise<{ secret: string; version: number } | null> {
    const candidates = await this.keys.verifiableUnscoped(nodeId);
    const active = candidates.find((k) => k.status === 'ACTIVE') ?? candidates[0];
    if (!active) return null;
    return { secret: this.unseal(active), version: active.version };
  }

  // ----------------------------------------------------------------
  // Inbound verification
  // ----------------------------------------------------------------

  /**
   * Authenticates a request that claims to come from a node.
   *
   * Runs before any organization is known — establishing which tenant the
   * caller belongs to is the *result* of verification, not an input to it.
   * Every candidate key version is tried so a node mid-rotation is not
   * rejected for having signed with the key it still legitimately holds.
   */
  async verifyRequest(input: {
    nodeId?: string;
    keyVersion?: string | number;
    timestamp?: string | number;
    signature?: string;
    body: string;
  }): Promise<VerifiedNodeCaller> {
    const nodeId = (input.nodeId ?? '').trim();
    if (!nodeId) throw new UnauthorizedException('Missing node identity');

    const timestamp = Number(input.timestamp);
    const signature = (input.signature ?? '').trim();

    const candidates = await this.keys.verifiableUnscoped(nodeId);
    if (candidates.length === 0) {
      await this.recordAuthFailure(nodeId, 'no_verifiable_key');
      throw new UnauthorizedException('Node has no verifiable key');
    }

    // A stated version narrows the search but is not itself trusted — the
    // signature decides. An attacker naming version 99 simply fails to match.
    const requested = Number(input.keyVersion);
    const ordered = Number.isFinite(requested)
      ? [...candidates].sort((a, b) => Number(b.version === requested) - Number(a.version === requested))
      : candidates;

    for (const key of ordered) {
      let secret: string;
      try {
        secret = this.unseal(key);
      } catch {
        // A key that cannot be decrypted is unusable, not a reason to fail
        // the whole request — another version may still verify.
        this.logger.warn(`Node key ${key.id} could not be unsealed`);
        continue;
      }

      if (
        NodeSecurityService.verifySignature(secret, signature, timestamp, input.body)
      ) {
        await this.keys.markUsedUnscoped(key.id);
        return {
          nodeId,
          organizationId: key.organizationId,
          keyVersion: key.version,
        };
      }
    }

    await this.recordAuthFailure(nodeId, 'signature_mismatch');
    throw new UnauthorizedException('Node signature verification failed');
  }

  /** Headers the control plane attaches to an outbound call to a node. */
  buildHeaders(nodeId: string, keyVersion: number, secret: string, body: string): SignedHeaders {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      'x-prismx-node-id': nodeId,
      'x-prismx-key-version': String(keyVersion),
      'x-prismx-timestamp': String(timestamp),
      'x-prismx-signature': NodeSecurityService.sign(secret, timestamp, body),
    };
  }

  private unseal(key: NodeKey): string {
    return this.crypto.open({
      value: key.secretCipher,
      iv: key.secretIv,
      authTag: key.secretTag,
    });
  }

  /**
   * Records a rejected attempt.
   *
   * Deliberately best-effort: the caller is already being refused, and a
   * failure to write the audit trail must not turn a clean 401 into a 500
   * that tells an attacker something interesting.
   */
  private async recordAuthFailure(nodeId: string, reason: string): Promise<void> {
    const organizationId = RequestContextStore.get()?.organizationId;
    if (!organizationId) return;
    try {
      await this.events.publish(DomainEvent.NodeAuthFailed, { nodeId, reason });
    } catch (error) {
      this.logger.warn(`Could not record node auth failure: ${(error as Error).message}`);
    }
  }
}
