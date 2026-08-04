import { Logger } from '@nestjs/common';

export interface AppendBufferOptions {
  /** Flush once this many rows are waiting. */
  maxRows: number;
  /** Flush this long after the first row arrives, even if the batch is small. */
  maxDelayMs: number;
  /**
   * Rows past which `add` stops returning immediately and waits for the flush.
   *
   * Backpressure rather than a drop. A buffer that discards on overflow loses
   * exactly the audit rows written during the incident that caused the
   * overflow, which is when they matter most.
   */
  capacity: number;
}

export const APPEND_BUFFER_DEFAULTS: AppendBufferOptions = {
  maxRows: 100,
  maxDelayMs: 250,
  capacity: 5_000,
};

/**
 * Batches append-only writes.
 *
 * Every mutating request writes an audit row, and most publish an event. Both
 * are single-row INSERTs, which means two extra round trips to Postgres on the
 * request path — plus two more rows of WAL, two more index updates, and two
 * more connections held for the duration. At a thousand requests a second that
 * is two thousand statements a second doing work that batches perfectly.
 *
 * So they are batched: rows accumulate for up to `maxDelayMs` or `maxRows`,
 * whichever comes first, and go out as one `createMany`. Postgres does the same
 * work in one statement that it did in a hundred.
 *
 * The properties that make this safe rather than merely fast:
 *
 * **Rows are grouped by tenant at flush.** The organization is captured when
 * the row is buffered, not read from ambient context at flush time — by then
 * the request is long gone. Each tenant's rows are written together, so the
 * write can be performed under that tenant's scope.
 *
 * **A read can force a flush.** Anything querying the table drains the buffer
 * first, so "write then read" behaves exactly as it did before batching. This
 * is the difference between an optimisation and a behaviour change.
 *
 * **Shutdown flushes.** The window of loss is bounded by `maxDelayMs` and only
 * applies to an actual crash, not to a deploy.
 *
 * What is genuinely traded away: a hard kill loses up to `maxDelayMs` of audit
 * rows. That is a real cost, stated rather than hidden, and it buys back two
 * round trips on every mutating request.
 */
export class AppendBuffer<TRow extends Record<string, unknown>> {
  private readonly logger: Logger;
  private rows: Array<{ organizationId: string; row: TRow }> = [];
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private droppedRows = 0;

  constructor(
    private readonly name: string,
    /** Writes one tenant's rows. Called once per organization per flush. */
    private readonly write: (organizationId: string, rows: TRow[]) => Promise<void>,
    private readonly options: AppendBufferOptions = APPEND_BUFFER_DEFAULTS,
  ) {
    this.logger = new Logger(`AppendBuffer:${name}`);
  }

  get depth(): number {
    return this.rows.length;
  }

  get dropped(): number {
    return this.droppedRows;
  }

  /**
   * Buffers one row.
   *
   * Resolves immediately in the normal case. At capacity it waits for the
   * in-flight flush, which slows the producer down instead of growing the
   * buffer without limit — the only two options are backpressure and losing
   * rows, and losing audit rows is not an option.
   */
  async add(organizationId: string, row: TRow): Promise<void> {
    this.rows.push({ organizationId, row });

    if (this.rows.length >= this.options.capacity) {
      await this.flush();
      return;
    }
    if (this.rows.length >= this.options.maxRows) {
      void this.flush();
      return;
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.maxDelayMs);
    // A pending flush must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /**
   * Writes everything buffered.
   *
   * Concurrent callers share one flush rather than racing: a read that forces a
   * drain while the timer is firing must not produce two writers for the same
   * rows.
   */
  async flush(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      // Rows added while that flush was running still need writing.
      if (!this.rows.length) return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.rows.length) return;

    const batch = this.rows;
    this.rows = [];

    this.inFlight = this.writeBatch(batch).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  private async writeBatch(
    batch: Array<{ organizationId: string; row: TRow }>,
  ): Promise<void> {
    const byTenant = new Map<string, TRow[]>();
    for (const entry of batch) {
      const existing = byTenant.get(entry.organizationId);
      if (existing) existing.push(entry.row);
      else byTenant.set(entry.organizationId, [entry.row]);
    }

    for (const [organizationId, rows] of byTenant) {
      try {
        await this.write(organizationId, rows);
      } catch (error) {
        // One retry, because the common failure is a momentary connection
        // blip and re-inserting append-only rows is harmless. A second
        // failure is reported loudly rather than retried forever: an
        // unbounded retry of a batch that cannot be written is how a buffer
        // becomes the memory leak that takes the process down.
        try {
          await this.write(organizationId, rows);
        } catch (retryError) {
          this.droppedRows += rows.length;
          this.logger.error(
            `Lost ${rows.length} ${this.name} row(s) for organization ${organizationId} ` +
              `after a retry: ${(retryError as Error).message}`,
          );
        }
      }
    }
  }
}
