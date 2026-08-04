import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** The Prisma surface a repository is allowed to touch — client or transaction. */
export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Postgres session variable read by the RLS policies in
 * `prisma/migrations/*_rls/migration.sql`.
 */
export const ORG_CONTEXT_GUC = 'app.current_organization_id';

/**
 * Connection pool sizing.
 *
 * Prisma's default is `num_cpus * 2 + 1` *per process*. On an 8-core host
 * running four replicas that is 68 connections against a Postgres whose
 * `max_connections` is typically 100 — and the pgbouncer/Supabase poolers sit
 * lower still. The failure mode is not gradual: the pool is fine until the
 * moment it is not, and then every instance starts refusing connections at
 * once, including the one trying to serve the health probe.
 *
 * So the size is declared rather than inferred. `DATABASE_CONNECTION_LIMIT`
 * should be set to `(pooler capacity - headroom) / replica count`; the default
 * of 10 is deliberately conservative, because under-provisioning shows up as
 * latency you can measure and over-provisioning shows up as an outage.
 *
 * `pool_timeout` is how long a query waits for a free connection before it
 * gives up. Waiting forever converts pool exhaustion into a hung request that
 * holds its own resources, which is how a slow dependency becomes a cascade.
 */
export const POOL_DEFAULTS = { connectionLimit: 10, poolTimeoutSeconds: 10 } as const;

/**
 * Applies pool settings to a Postgres connection string.
 *
 * An operator who has already put `connection_limit` in the URL means it, so
 * an explicit parameter always wins over the environment variable. Non-Postgres
 * or unparseable URLs are returned untouched: this function's job is to size a
 * pool, not to validate a DSN, and failing to boot over a query parameter would
 * be a worse outcome than an unsized pool.
 */
export function applyPoolSettings(
  url: string,
  settings: { connectionLimit?: number; poolTimeoutSeconds?: number } = {},
): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.protocol.startsWith('postgres')) return url;

  const limit = settings.connectionLimit ?? POOL_DEFAULTS.connectionLimit;
  const timeout = settings.poolTimeoutSeconds ?? POOL_DEFAULTS.poolTimeoutSeconds;

  if (!parsed.searchParams.has('connection_limit') && Number.isFinite(limit) && limit > 0) {
    parsed.searchParams.set('connection_limit', String(Math.floor(limit)));
  }
  if (!parsed.searchParams.has('pool_timeout') && Number.isFinite(timeout) && timeout >= 0) {
    parsed.searchParams.set('pool_timeout', String(Math.floor(timeout)));
  }
  return parsed.toString();
}

/** Reads the configured pool size, falling back to the conservative default. */
function poolFromEnvironment(): { connectionLimit: number; poolTimeoutSeconds: number } {
  const limit = Number.parseInt(process.env.DATABASE_CONNECTION_LIMIT ?? '', 10);
  const timeout = Number.parseInt(process.env.DATABASE_POOL_TIMEOUT ?? '', 10);
  return {
    connectionLimit:
      Number.isFinite(limit) && limit > 0 ? limit : POOL_DEFAULTS.connectionLimit,
    poolTimeoutSeconds:
      Number.isFinite(timeout) && timeout >= 0 ? timeout : POOL_DEFAULTS.poolTimeoutSeconds,
  };
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** The pool this process is actually configured for. Reported by readiness. */
  readonly pool: { connectionLimit: number; poolTimeoutSeconds: number };

  constructor() {
    const pool = poolFromEnvironment();
    const url = applyPoolSettings(process.env.DATABASE_URL ?? '', pool);
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      ...(url ? { datasources: { db: { url } } } : {}),
    });
    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Database connection established (pool: ${this.pool.connectionLimit} connections, ` +
        `${this.pool.poolTimeoutSeconds}s timeout)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `fn` inside a transaction whose Postgres session is pinned to
   * `organizationId`, so row-level security policies evaluate against it.
   *
   * `set_config(..., true)` makes the setting transaction-local: it is
   * discarded on commit or rollback, which keeps it correct under connection
   * pooling where the next caller may inherit the same physical connection.
   */
  async withTenant<T>(
    organizationId: string,
    fn: (tx: PrismaTx) => Promise<T>,
    options?: { timeout?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config(${ORG_CONTEXT_GUC}, ${organizationId}, true)`;
        return fn(tx);
      },
      { timeout: options?.timeout ?? 15_000 },
    );
  }

  /** Plain transaction with no tenant pinning — for cross-org/system work. */
  async transaction<T>(fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => fn(tx));
  }

  /** True when the database answers a trivial query. Used by the health check. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(`Health probe failed: ${(error as Error).message}`);
      return false;
    }
  }

  static isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }

  static isNotFound(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
    );
  }
}
