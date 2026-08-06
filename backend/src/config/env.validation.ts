import { Logger } from '@nestjs/common';

/**
 * Fail fast on misconfiguration. Runs before the Nest container boots, so a
 * bad deploy dies at startup rather than at the first request that needs the
 * missing value.
 */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const logger = new Logger('EnvValidation');
  const errors: string[] = [];

  const required = (key: string) => {
    if (!raw[key] || String(raw[key]).trim() === '') errors.push(`${key} is required`);
  };

  required('DATABASE_URL');

  const authDriver = String(raw.AUTH_PROVIDER ?? 'local');
  if (!['supabase', 'local'].includes(authDriver)) {
    errors.push(`AUTH_PROVIDER must be "supabase" or "local" (got "${authDriver}")`);
  }

  if (authDriver === 'supabase') {
    // ANON_KEY belongs here even though it reads like an optional extra:
    // `SupabaseAuthProvider` calls `getOrThrow('supabase.anonKey')` in its
    // constructor, so a deploy without it dies at boot regardless. Listing it
    // is the difference between one message naming every missing variable and
    // a Nest dependency error naming one.
    [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
    ].forEach(required);
  } else {
    const secret = String(raw.JWT_SECRET ?? '');
    if (secret.length < 32) errors.push('JWT_SECRET must be at least 32 characters');
  }

  const storageDriver = String(raw.STORAGE_DRIVER ?? 'local');
  if (!['supabase', 'local'].includes(storageDriver)) {
    errors.push(`STORAGE_DRIVER must be "supabase" or "local" (got "${storageDriver}")`);
  }
  if (storageDriver === 'supabase') {
    ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].forEach(required);
  }

  const cryptoKey = String(raw.CREDENTIAL_ENCRYPTION_KEY ?? '');
  if (!/^[0-9a-fA-F]{64}$/.test(cryptoKey)) {
    errors.push('CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  if (String(raw.NODE_ENV) === 'production') {
    if (authDriver === 'local') {
      logger.warn('AUTH_PROVIDER=local in production — intended for dev/CI only.');
    }
    if (cryptoKey === '0'.repeat(64)) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY is still the placeholder value.');
    }
  }

  return raw;
}
