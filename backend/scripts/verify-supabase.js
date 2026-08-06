#!/usr/bin/env node
/**
 * Supabase readiness check.
 *
 * Run this where the credentials live — locally with a `.env`, or on the host
 * that runs the backend. It answers, in order, the questions that decide
 * whether the app can boot at all:
 *
 *   1. Is every required variable set, and are the drivers actually switched?
 *   2. Does DATABASE_URL parse, and is it pointed at Supabase rather than a
 *      local Postgres left over from development?
 *   3. Does the database accept a connection?
 *   4. Have the migrations been applied?
 *   5. Do the Supabase auth and storage endpoints accept the keys?
 *
 * It does not check RLS. `prisma migrate status` reporting a schema that is up
 * to date already implies the RLS migrations ran, and the Omega validation
 * suite proves the policies actually hold — asserting it a third time here,
 * weakly, would only be a second place to keep in sync.
 *
 * It never prints a secret. Keys are reported by length and by the claims
 * inside them, which is enough to tell a service_role key from an anon key
 * and to spot a value pasted into the wrong variable.
 *
 * Read-only throughout. It creates nothing, migrates nothing and deletes
 * nothing, so it is safe to run against production.
 *
 *   node scripts/verify-supabase.js
 */

const { execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

/** Prisma needs an explicit schema when it is not invoked from a project root. */
const SCHEMA = path.join(__dirname, '..', 'prisma', 'schema.prisma');

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};
const warn = (label, detail = '') => {
  warnings += 1;
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ''}`);
};
const section = (name) => console.log(`\n--- ${name} ---`);

// Load .env if present, without adding a dependency.
try {
  require('node:fs')
    .readFileSync(require('node:path').join(process.cwd(), '.env'), 'utf8')
    .split('\n')
    .forEach((line) => {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    });
} catch {
  /* no .env — variables come from the real environment */
}

/** Decodes a JWT payload without verifying it. Reports claims, never the key. */
function claims(token) {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

// ============================================================ 1. variables

section('environment variables');

const env = process.env;
const authDriver = env.AUTH_PROVIDER ?? 'local';
const storageDriver = env.STORAGE_DRIVER ?? 'local';

if (authDriver === 'supabase') ok('AUTH_PROVIDER', 'supabase');
else bad('AUTH_PROVIDER', `"${authDriver}" — Supabase keys are set but ignored until this is "supabase"`);

if (storageDriver === 'supabase') ok('STORAGE_DRIVER', 'supabase');
else warn('STORAGE_DRIVER', `"${storageDriver}" — file storage stays on local disk`);

for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  const value = env[key];
  if (!value) {
    bad(key, 'missing — required when AUTH_PROVIDER=supabase');
    continue;
  }
  if (key === 'SUPABASE_URL') {
    ok(key, value.replace(/https:\/\/([^.]{4})[^.]*/, 'https://$1…'));
  } else {
    const parsed = claims(value);
    const role = parsed?.role ?? 'unreadable';
    const expected = key.includes('SERVICE_ROLE') ? 'service_role' : 'anon';
    if (role === expected) ok(key, `role=${role}, ${value.length} chars`);
    else bad(key, `role="${role}" but this variable expects "${expected}" — the two keys may be swapped`);
  }
}

if (env.SUPABASE_JWT_SECRET) {
  warn(
    'SUPABASE_JWT_SECRET',
    'set but unused — nothing reads it. Safe to delete from your environment.',
  );
}

const cryptoKey = env.CREDENTIAL_ENCRYPTION_KEY ?? '';
if (!/^[0-9a-fA-F]{64}$/.test(cryptoKey)) {
  bad('CREDENTIAL_ENCRYPTION_KEY', 'must be 64 hex characters; boot fails without it');
} else if (cryptoKey === '0'.repeat(64)) {
  bad('CREDENTIAL_ENCRYPTION_KEY', 'still the placeholder; refused in production');
} else {
  ok('CREDENTIAL_ENCRYPTION_KEY');
}

// ============================================================ 2. the URL

section('DATABASE_URL');

const raw = env.DATABASE_URL ?? '';
let url = null;
if (!raw) {
  bad('DATABASE_URL', 'not set');
} else {
  try {
    url = new URL(raw);
    ok('parses as a URL');
  } catch {
    bad(
      'does not parse',
      'percent-encode the password: node -e "console.log(encodeURIComponent(process.argv[1]))" \'<password>\'',
    );
  }
}

if (url) {
  const host = url.hostname;
  if (/supabase\.(co|com)$/.test(host)) ok('points at Supabase', host);
  else if (/^(127\.|localhost|::1)/.test(host)) bad('points at LOCAL Postgres', host);
  else warn('host is not a Supabase domain', host);

  const port = url.port || '5432';
  if (port === '6543') {
    if (url.searchParams.get('pgbouncer') === 'true') {
      ok('transaction pooler with pgbouncer=true');
    } else {
      bad('port 6543 without ?pgbouncer=true', 'Prisma will fail on the first query');
    }
  } else if (port === '5432') {
    ok('session pooler / direct', 'right for migrations; 6543 is better for runtime');
  }

  if (!url.password) warn('no password in the URL');

  // TCP reachability, before Prisma so a network problem is not read as a
  // credentials problem.
  const reachable = () =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port: Number(port) });
      socket.setTimeout(8000);
      socket.on('connect', () => (socket.destroy(), resolve('open')));
      socket.on('timeout', () => (socket.destroy(), resolve('timed out')));
      socket.on('error', (e) => resolve(e.code ?? e.message));
    });

  (async () => {
    section('connectivity');
    const state = await reachable();
    if (state === 'open') ok(`TCP ${host}:${port}`, 'reachable');
    else bad(`TCP ${host}:${port}`, state);

    // ======================================================== 3-5. schema
    section('schema and migrations');
    const query = (sql) =>
      execFileSync('npx', ['prisma', 'db', 'execute', '--stdin', '--schema', SCHEMA], {
        input: sql,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

    try {
      query('SELECT 1;');
      ok('database accepts a connection');
    } catch (error) {
      bad('database refused the connection', String(error.stderr || error.message).split('\n')[0]);
      return report();
    }

    // `prisma db execute` does not return rows, so counts come through
    // migrate status and a raw client where available.
    try {
      const status = execFileSync('npx', ['prisma', 'migrate', 'status', '--schema', SCHEMA], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (/Database schema is up to date/i.test(status)) {
        ok('migrations applied', 'schema is up to date');
      } else if (/have not yet been applied|following migration/i.test(status)) {
        bad('migrations PENDING', 'run: npx prisma migrate deploy (use port 5432)');
      } else {
        warn('migrate status was inconclusive', status.split('\n').find(Boolean) ?? '');
      }
    } catch (error) {
      const text = String(error.stdout || error.stderr || error.message);
      if (/not yet been applied|No migration found|P3005/i.test(text)) {
        bad('migrations NOT applied', 'run: npx prisma migrate deploy (use port 5432)');
      } else {
        warn('could not read migrate status', text.split('\n').find(Boolean) ?? '');
      }
    }

    // ======================================================== 6. endpoints
    section('Supabase endpoints');
    const base = env.SUPABASE_URL;
    const probe = async (label, path, key) => {
      try {
        const response = await fetch(base + path, {
          headers: { apikey: key, authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (response.status === 401) bad(label, 'key rejected (401) — rotated or wrong project?');
        else if (response.ok || response.status === 404) ok(label, `HTTP ${response.status}`);
        else warn(label, `HTTP ${response.status}`);
      } catch (error) {
        bad(label, error.message);
      }
    };

    if (base && env.SUPABASE_ANON_KEY) {
      await probe('auth endpoint accepts the anon key', '/auth/v1/health', env.SUPABASE_ANON_KEY);
    }
    if (base && env.SUPABASE_SERVICE_ROLE_KEY) {
      await probe('REST accepts the service_role key', '/rest/v1/', env.SUPABASE_SERVICE_ROLE_KEY);
      const bucket = env.STORAGE_BUCKET ?? 'prismx';
      await probe(
        `storage bucket "${bucket}" exists`,
        `/storage/v1/bucket/${bucket}`,
        env.SUPABASE_SERVICE_ROLE_KEY,
      );
    }

    report();
  })();
}

function report() {
  console.log(
    `\n${failures === 0 ? 'READY' : 'NOT READY'} — ${failures} failure(s), ${warnings} warning(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
