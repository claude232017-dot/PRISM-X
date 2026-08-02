import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { CryptoService } from './crypto.service';

const configWith = (key: string) =>
  ({ get: () => key }) as unknown as ConfigService;

describe('CryptoService', () => {
  const key = randomBytes(32).toString('hex');
  let crypto: CryptoService;

  beforeEach(() => {
    crypto = new CryptoService(configWith(key));
  });

  it('round-trips a secret', () => {
    const secret = 'sk-live-abcdef123456';
    expect(crypto.open(crypto.seal(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = crypto.seal('same-input');
    const b = crypto.seal('same-input');
    expect(a.value).not.toBe(b.value);
    expect(a.iv).not.toBe(b.iv);
    // Both must still decrypt back to the original.
    expect(crypto.open(a)).toBe(crypto.open(b));
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const sealed = crypto.seal('sensitive');
    const flipped = Buffer.from(sealed.value, 'base64');
    flipped[0] ^= 0xff;

    expect(() =>
      crypto.open({ ...sealed, value: flipped.toString('base64') }),
    ).toThrow(/could not be decrypted/i);
  });

  it('rejects a ciphertext opened with the wrong key', () => {
    const sealed = crypto.seal('sensitive');
    const other = new CryptoService(configWith(randomBytes(32).toString('hex')));
    expect(() => other.open(sealed)).toThrow(/could not be decrypted/i);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new CryptoService(configWith('abcd'))).toThrow(/32 bytes/);
  });

  it('hints only the last four characters', () => {
    expect(crypto.hint('sk-live-abcdef123456')).toBe('****3456');
    expect(crypto.hint('abc')).toBe('****');
  });
});
