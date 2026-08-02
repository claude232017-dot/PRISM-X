import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export interface SealedSecret {
  value: string;
  iv: string;
  authTag: string;
}

/**
 * AES-256-GCM envelope for credential material.
 *
 * GCM (not CBC) so the ciphertext is authenticated: a tampered row fails to
 * decrypt rather than silently yielding garbage that downstream code might
 * ship to a provider.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_BYTES = 12;

  constructor(config: ConfigService) {
    const hex = config.get<string>('crypto.credentialKey', '');
    this.key = Buffer.from(hex, 'hex');
    if (this.key.length !== 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
  }

  seal(plaintext: string): SealedSecret {
    const iv = randomBytes(CryptoService.IV_BYTES);
    const cipher = createCipheriv(CryptoService.ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      value: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  open(sealed: SealedSecret): string {
    try {
      const decipher = createDecipheriv(
        CryptoService.ALGORITHM,
        this.key,
        Buffer.from(sealed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.value, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new InternalServerErrorException(
        'Stored credential could not be decrypted (wrong key or tampered record).',
      );
    }
  }

  /** Last 4 characters, for display. Never returns the secret itself. */
  hint(plaintext: string): string {
    return plaintext.length <= 4 ? '****' : `****${plaintext.slice(-4)}`;
  }

  static safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
