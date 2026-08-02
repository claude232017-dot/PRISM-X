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

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
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
