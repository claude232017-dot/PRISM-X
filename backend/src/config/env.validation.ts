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

  /**
   * A connection string that does not parse is the most expensive kind of
   * misconfiguration, because nothing downstream says so. `applyPoolSettings`
   * catches the parse failure and returns the string untouched — so the pool
   * silently goes unsized — and Prisma then fails with a connection error that
   * points at the network rather than at the URL.
   *
   * The usual cause is a generated password containing `/`, `#`, `?` or `@`.
   * Supabase hands those out routinely and shows them unencoded in the
   * dashboard, so the string a user copies is frequently not a valid URL. The
   * error names the fix rather than the symptom.
   */
  const databaseUrl = String(raw.DATABASE_URL ?? '');
  if (databaseUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      errors.push(
        'DATABASE_URL is not a parseable URL. If the password contains any of ' +
          '/ # ? @ % or a space, percent-encode it — node -e "console.log(' +
          'encodeURIComponent(process.argv[1]))" \'<password>\' — and put the ' +
          'encoded value in the string.',
      );
    }
    if (parsed && !parsed.protocol.startsWith('postgres')) {
      errors.push(`DATABASE_URL must be a postgres:// URL (got "${parsed.protocol}")`);
    }
    // Supabase's transaction pooler runs on 6543 and cannot serve the prepared
    // statements Prisma issues by default. Without this flag the connection
    // opens and then fails on the first query, which is a far worse signal
    // than failing here.
    if (parsed && parsed.port === '6543' && parsed.searchParams.get('pgbouncer') !== 'true') {
      errors.push(
        'DATABASE_URL uses port 6543 (a transaction pooler) but does not set ' +
          '?pgbouncer=true. Prisma needs it there, or use the session pooler ' +
          'on port 5432 instead.',
      );
    }
  }

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
    //
    // SUPABASE_JWT_SECRET is deliberately *not* required. It was, and nothing
    // read it — see `supabase-auth.provider.ts`, which verifies a token with
    // `admin.auth.getUser()` rather than by checking a signature locally. A
    // required variable that no code consumes only blocks deploys.
    //
    // Keeping the round trip is a choice, not an oversight. Local verification
    // would be faster, but a signature proves only that a token was issued —
    // not that the session still exists. Asking Supabase catches a revoked
    // session, a deleted user and a banned account; a local check cannot, and
    // for a multi-tenant system that difference is worth the call. Supabase
    // has also moved new projects to asymmetric signing keys, so the symmetric
    // secret is a shrinking foundation to build on.
    ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].forEach(required);
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
