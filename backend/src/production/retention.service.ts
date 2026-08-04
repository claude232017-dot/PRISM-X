import { Injectable, Logger } from '@nestjs/common';
import { SchemaRepository } from '../database/repositories/production.repositories';
import { Metric, MetricsService } from './metrics.service';
import {
  PRUNE_BATCH,
  PRUNE_GUARDS,
  PRUNE_MAX_BATCHES,
  RETENTION_RULES,
  RETENTION_VERSION,
  cutoffFor,
  describePolicy,
  windowDays,
} from './retention';
import type { RetentionRule } from './retention';

export interface TableSweep {
  table: string;
  column: string;
  windowDays: number;
  cutoff: string | null;
  deleted: number;
  /** True when the batch cap was reached and eligible rows remain. */
  moreRemaining: boolean;
  skipped: 'disabled' | 'missing' | null;
  error?: string;
}

export interface RetentionSweep {
  version: string;
  startedAt: string;
  durationMs: number;
  deleted: number;
  tables: TableSweep[];
}

/**
 * Applies the retention policy.
 *
 * Runs on the leader only, for the same reason every other scheduled task does:
 * N instances each deleting the same rows is N times the lock contention for
 * one table's worth of work.
 *
 * Three properties make this safe to leave running unattended:
 *
 * **It deletes in bounded batches.** Each statement takes at most `PRUNE_BATCH`
 * rows, and each table gets at most `PRUNE_MAX_BATCHES` statements per sweep.
 * The first sweep on an old database does not try to delete ten million rows in
 * one transaction; it takes a slice, and the backlog drains over hours.
 *
 * **A failure on one table does not stop the others.** Each table is swept
 * independently and its error recorded, because "retention stopped working
 * three weeks ago because one table was locked" is exactly the silent failure
 * this is meant to prevent.
 *
 * **It reports what it did.** The sweep returns per-table counts and whether
 * rows remain, and the same numbers go to the metrics registry — so growth that
 * outruns retention is visible as a gauge that never reaches zero rather than
 * as a disk alert six months later.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  /** Guards against two sweeps overlapping if one runs long. */
  private sweeping = false;

  constructor(
    private readonly schema: SchemaRepository,
    private readonly metrics: MetricsService,
  ) {}

  /** The policy as configured in this deployment. */
  policy(): Record<string, unknown> {
    return {
      version: RETENTION_VERSION,
      batchSize: PRUNE_BATCH,
      maxBatchesPerTable: PRUNE_MAX_BATCHES,
      tables: describePolicy(),
    };
  }

  /**
   * Runs one sweep across every rule.
   *
   * `dryRun` counts what would go without deleting it, which is how an operator
   * checks a window change before living with it.
   */
  async sweep(options: { dryRun?: boolean } = {}): Promise<RetentionSweep> {
    const dryRun = options.dryRun === true;
    if (this.sweeping && !dryRun) {
      return {
        version: RETENTION_VERSION,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        deleted: 0,
        tables: [],
      };
    }

    if (!dryRun) this.sweeping = true;
    const started = Date.now();
    const tables: TableSweep[] = [];

    try {
      for (const rule of RETENTION_RULES) {
        tables.push(await this.sweepTable(rule, dryRun));
      }
    } finally {
      if (!dryRun) this.sweeping = false;
    }

    const deleted = tables.reduce((sum, table) => sum + table.deleted, 0);
    if (deleted > 0) {
      this.logger.log(
        `Retention ${dryRun ? '(dry run) ' : ''}removed ${deleted} row(s) across ` +
          `${tables.filter((table) => table.deleted > 0).length} table(s)`,
      );
    }

    const behind = tables.filter((table) => table.moreRemaining);
    if (behind.length) {
      // Not an error — the batch cap did its job — but worth saying, because a
      // table that is still behind on the next sweep is growing faster than
      // retention removes.
      this.logger.warn(
        `Retention backlog remains on: ${behind.map((table) => table.table).join(', ')}`,
      );
    }

    return {
      version: RETENTION_VERSION,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      deleted,
      tables,
    };
  }

  private async sweepTable(rule: RetentionRule, dryRun: boolean): Promise<TableSweep> {
    const days = windowDays(rule);
    const cutoff = cutoffFor(rule);

    const base: TableSweep = {
      table: rule.table,
      column: rule.column,
      windowDays: days,
      cutoff: cutoff?.toISOString() ?? null,
      deleted: 0,
      moreRemaining: false,
      skipped: null,
    };

    // Retention disabled — a deliberate "keep forever", not an oversight.
    if (!cutoff) return { ...base, skipped: 'disabled' };

    try {
      if (!(await this.schema.tableExists(rule.table))) {
        return { ...base, skipped: 'missing' };
      }

      if (dryRun) {
        const oldest = await this.schema.oldestRow(rule.table, rule.column);
        return {
          ...base,
          moreRemaining: Boolean(oldest && oldest < cutoff),
        };
      }

      const guard = PRUNE_GUARDS[rule.table];
      let deleted = 0;
      let batches = 0;

      while (batches < PRUNE_MAX_BATCHES) {
        const removed = await this.schema.pruneBatch(
          rule.table,
          rule.column,
          cutoff,
          PRUNE_BATCH,
          guard,
        );
        deleted += removed;
        batches += 1;
        // A short batch means the eligible rows are exhausted.
        if (removed < PRUNE_BATCH) break;
      }

      const moreRemaining = batches >= PRUNE_MAX_BATCHES;
      if (deleted) {
        this.metrics.increment(
          Metric.RetentionRowsDeleted,
          { table: rule.table },
          deleted,
          'Rows removed by the retention sweep',
        );
      }
      this.metrics.set(
        Metric.RetentionBacklog,
        moreRemaining ? 1 : 0,
        { table: rule.table },
        'Set when eligible rows remained after the batch cap',
      );

      return { ...base, deleted, moreRemaining };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Retention failed on "${rule.table}": ${message}`);
      return { ...base, error: message.slice(0, 300) };
    }
  }
}
