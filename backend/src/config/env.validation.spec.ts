import { validateEnv } from './env.validation';

/**
 * Environment validation, written against the misconfigurations that actually
 * happened rather than the ones that seemed likely.
 *
 * The DATABASE_URL cases come from a real Supabase connection string whose
 * generated password contained `/`, `#` and `$`. It was pasted into the
 * environment exactly as the dashboard displayed it, and `new URL()` could not
 * parse it. Nothing downstream said so: `applyPoolSettings` catches the parse
 * failure and returns the string untouched, so the pool went unsized and
 * Prisma reported a connection error that pointed at the network.
 */

const HEX_KEY = 'a'.repeat(64);

const base = (over: Record<string, unknown> = {}) => ({
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/postgres',
  AUTH_PROVIDER: 'local',
  JWT_SECRET: 'x'.repeat(32),
  CREDENTIAL_ENCRYPTION_KEY: HEX_KEY,
  ...over,
});

describe('DATABASE_URL', () => {
  it('accepts a well-formed connection string', () => {
    expect(() => validateEnv(base())).not.toThrow();
  });

  it('rejects one whose password was not percent-encoded', () => {
    // The exact shape that failed: `/` and `#` in the password. `#` is
    // especially nasty — in a URL it starts a fragment, so a lenient parser
    // would silently truncate the password rather than reject it.
    expect(() =>
      validateEnv(
        base({
          DATABASE_URL:
            'postgresql://postgres.abc:xYn/9#4L$-5YrV$@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
        }),
      ),
    ).toThrow(/percent-encode/i);
  });

  it('accepts the same password once it is encoded', () => {
    const encoded = encodeURIComponent('xYn/9#4L$-5YrV$');
    expect(() =>
      validateEnv(
        base({
          DATABASE_URL: `postgresql://postgres.abc:${encoded}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
        }),
      ),
    ).not.toThrow();
  });

  it('requires pgbouncer=true on the transaction pooler port', () => {
    // Without it the connection opens and fails on the first query, which
    // looks like a database problem rather than a URL problem.
    expect(() =>
      validateEnv(
        base({ DATABASE_URL: 'postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres' }),
      ),
    ).toThrow(/pgbouncer=true/);
  });

  it('does not demand pgbouncer on the session pooler port', () => {
    expect(() =>
      validateEnv(
        base({ DATABASE_URL: 'postgresql://u:p@aws-0.pooler.supabase.com:5432/postgres' }),
      ),
    ).not.toThrow();
  });

  it('rejects a non-postgres scheme', () => {
    expect(() => validateEnv(base({ DATABASE_URL: 'mysql://u:p@db.example.com:3306/x' }))).toThrow(
      /postgres:\/\//,
    );
  });
});

describe('Supabase auth requirements', () => {
  const supabase = (over: Record<string, unknown> = {}) =>
    base({
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'service',
      ...over,
    });

  it('accepts a complete Supabase configuration', () => {
    expect(() => validateEnv(supabase())).not.toThrow();
  });

  it('does not require SUPABASE_JWT_SECRET', () => {
    // Deliberate. Nothing reads it — tokens are verified through
    // `admin.auth.getUser()`, not by checking a signature locally — and a
    // required variable no code consumes only blocks deploys.
    expect(() => validateEnv(supabase({ SUPABASE_JWT_SECRET: undefined }))).not.toThrow();
  });

  it('requires the anon key, which the provider reads at construction', () => {
    expect(() => validateEnv(supabase({ SUPABASE_ANON_KEY: '' }))).toThrow(
      /SUPABASE_ANON_KEY is required/,
    );
  });

  it('requires the service role key', () => {
    expect(() => validateEnv(supabase({ SUPABASE_SERVICE_ROLE_KEY: '' }))).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY is required/,
    );
  });

  it('reports every missing variable at once, not the first', () => {
    // The point of validating here rather than letting Nest fail on the first
    // unresolvable dependency: one round trip for the operator.
    try {
      validateEnv(supabase({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }));
      throw new Error('expected a rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SUPABASE_URL');
      expect(message).toContain('SUPABASE_ANON_KEY');
    }
  });
});

describe('other required values', () => {
  it('rejects an encryption key that is not 64 hex characters', () => {
    expect(() => validateEnv(base({ CREDENTIAL_ENCRYPTION_KEY: 'short' }))).toThrow(
      /64 hex characters/,
    );
  });

  it('rejects the placeholder encryption key in production', () => {
    expect(() =>
      validateEnv(base({ NODE_ENV: 'production', CREDENTIAL_ENCRYPTION_KEY: '0'.repeat(64) })),
    ).toThrow(/placeholder/);
  });

  it('rejects a short JWT secret when auth is local', () => {
    expect(() => validateEnv(base({ JWT_SECRET: 'tooshort' }))).toThrow(/at least 32/);
  });
});
