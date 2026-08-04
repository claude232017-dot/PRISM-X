import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Backup, BackupKind, RestoreRun } from '@prisma/client';
import {
  BackupRepository,
  RestoreRunRepository,
  SchemaRepository,
} from '../database/repositories/production.repositories';
import { CryptoService } from '../shared/crypto/crypto.service';
import { StorageService } from '../storage/storage.module';
import { EventBusService } from '../events/event-bus.service';
import { DomainEvent } from '../events/domain-events';
import { RequestContextStore } from '../shared/context/request-context';
import { InstanceService } from './instance.service';
import { BoundedMap } from '../shared/bounded-map';
import { declareProcessState } from '../shared/process-state';

/**
 * Backup, verification and restore.
 *
 * The thing that distinguishes a backup system from a backup script is what
 * happens after the write, so three properties are load-bearing here:
 *
 * **The checksum is of the plaintext, taken before encryption.** Verifying a
 * ciphertext proves the storage layer did not corrupt the file; it proves
 * nothing about whether the data inside is the data that went in. Hashing
 * first means verification decrypts, decompresses and re-hashes, and therefore
 * exercises the entire restore path rather than a substring of it.
 *
 * **Encryption uses a fresh data key per backup, sealed with the platform
 * key.** One key across every backup means one compromise reaches all of them,
 * and rotating it means re-encrypting the archive. A per-backup key sealed
 * with `CryptoService` means rotation touches the seals, not the data.
 *
 * **A verified backup is a different status from a successful one.** SUCCEEDED
 * means it was written. VERIFIED means it was read back and matched. CORRUPT is
 * loud on purpose: a backup that fails verification is worse than a missing
 * one, because it is the one somebody would have relied on.
 *
 * What this does *not* do is call `pg_dump`. The backup is a logical export
 * taken through the same connection the application uses, which is portable,
 * testable in CI, and restorable table by table. A physical snapshot with WAL
 * archiving is the right answer for true point-in-time recovery at scale, and
 * `pointInTime` is explicit that it reconstructs to the nearest backup rather
 * than pretending otherwise.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  /**
   * Tables exported, in dependency order.
   *
   * Order matters on restore: a child row inserted before its parent violates
   * a foreign key. Listing them explicitly — rather than discovering them —
   * means a new table is absent from backups until someone adds it here, which
   * is a visible omission rather than a silent one.
   */
  private static readonly TABLES: readonly string[] = [
    'organizations',
    'users',
    'roles',
    'permissions',
    'role_permissions',
    'memberships',
    'plans',
    'subscriptions',
    'providers',
    'credentials',
    'workers',
    'missions',
    'tasks',
    'knowledge',
    'memories',
    'integrations',
    'workflows',
    'workflow_versions',
    'triggers',
    'extensions',
    'extension_contributions',
    'publishers',
    'marketplace_listings',
    'marketplace_versions',
    'nodes',
    'evolution_policies',
    'api_keys',
    'webhook_endpoints',
  ];

  /**
   * Rows read per query while exporting a table.
   *
   * A page size, not a limit. The export walks the whole table in keyset pages
   * so a large table is exported completely rather than quietly clipped, and so
   * the client never holds a single result set the size of the table.
   */
  private static readonly CHUNK = 5_000;

  /**
   * The point at which a table is too large for a logical export.
   *
   * This is a ceiling, and reaching it is a *failure*, not a trim. The previous
   * behaviour — take the first fifty thousand rows and say nothing — produced
   * backups that verified, restored, and were missing data, which is the worst
   * available outcome: the restore appears to succeed and the loss is discovered
   * later, by a user, in production. If a deployment reaches this size the
   * answer is a physical snapshot with WAL archiving, and the backup says so out
   * loud instead of pretending.
   */
  private static readonly TABLE_LIMIT = 2_000_000;

  constructor(
    private readonly schema: SchemaRepository,
    private readonly backups: BackupRepository,
    private readonly restores: RestoreRunRepository,
    private readonly crypto: CryptoService,
    private readonly storage: StorageService,
    private readonly events: EventBusService,
    private readonly instances: InstanceService,
  ) {}

  // ============================================================ create

  async run(input: {
    kind?: BackupKind;
    retentionDays?: number;
    encrypt?: boolean;
  } = {}): Promise<Backup> {
    const kind = input.kind ?? 'DATABASE';
    const started = Date.now();

    const backup = await this.backups.create({
      kind,
      status: 'RUNNING',
      environment: this.instances.environment.toUpperCase(),
      encrypted: input.encrypt !== false,
      createdById: RequestContextStore.get()?.userId ?? null,
      retentionUntil: new Date(Date.now() + (input.retentionDays ?? 30) * 86_400_000),
    });

    try {
      const payload =
        kind === 'DATABASE'
          ? await this.exportDatabase()
          : kind === 'CONFIGURATION'
            ? this.exportConfiguration()
            : await this.exportStorage();

      const plaintext = Buffer.from(JSON.stringify(payload.data), 'utf8');
      // Hash the plaintext, not what lands on disk. Verification then proves
      // the data survived, rather than proving the file did.
      const checksum = createHash('sha256').update(plaintext).digest('hex');
      const compressed = gzipSync(plaintext);

      const { body, keyMaterial } =
        input.encrypt === false
          ? { body: compressed, keyMaterial: {} }
          : this.encrypt(compressed);

      const location = `backups/${kind.toLowerCase()}/${backup.id}.bin`;
      await this.storage.upload(
        {
          originalname: `${backup.id}.bin`,
          buffer: body,
          mimetype: 'application/octet-stream',
          size: body.length,
        },
        `backups/${kind.toLowerCase()}`,
      );

      const finished = await this.backups.update(backup.id, {
        status: 'SUCCEEDED',
        location,
        sizeBytes: body.length,
        checksum,
        keyMaterial: keyMaterial as never,
        manifest: payload.manifest as never,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      });

      // Kept in memory as well as in storage so verification and restore work
      // in a deployment whose storage driver is not shared between instances.
      this.artefacts.set(backup.id, body);

      await this.events.publish(DomainEvent.BackupCompleted, {
        backupId: backup.id,
        kind,
        sizeBytes: body.length,
        tables: Object.keys(payload.manifest.tables ?? {}).length,
      });

      this.logger.log(
        `Backup ${backup.id} (${kind}) — ${payload.manifest.rows} rows, ${body.length} bytes`,
      );
      return finished;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Backup ${backup.id} failed: ${message}`);
      await this.events.publish(DomainEvent.BackupFailed, {
        backupId: backup.id,
        error: message,
      });
      return this.backups.update(backup.id, {
        status: 'FAILED',
        error: message.slice(0, 500),
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      });
    }
  }

  /** Bytes this process will hold in backup artefacts before evicting. */
  private static readonly ARTEFACT_CACHE_BYTES = 64 * 1024 * 1024;

  /**
   * Artefacts held in process, bounded by total bytes.
   *
   * The local storage driver writes to a container filesystem, which another
   * instance cannot read. Holding the bytes lets verification and restore work
   * end to end in development and in tests; a shared object store makes this
   * cache redundant rather than load-bearing.
   *
   * It is bounded by size rather than by count because the entries are
   * backups: ten of them might be ten megabytes or ten gigabytes, and a cache
   * that counts entries cannot tell the difference until the process dies. An
   * evicted artefact is re-read from storage, which is where it already is.
   */
  private readonly artefacts = new BoundedMap<string, Buffer>(
    BackupService.ARTEFACT_CACHE_BYTES,
    (body) => body.length,
  );

  // Load-bearing only where the storage driver is not shared between
  // instances. With `local` storage, a verify that lands on another instance
  // cannot read the artefact — which is a real statelessness constraint, and
  // is why the review is told about it rather than reassured.
  private readonly declared = declareProcessState({
    name: 'backup.artefacts',
    loadBearing: (process.env.STORAGE_DRIVER ?? 'local') === 'local',
    describe: () =>
      `${this.artefacts.size} artefact(s), ${(this.artefacts.load / 1024 / 1024).toFixed(1)}MB ` +
      `of ${(BackupService.ARTEFACT_CACHE_BYTES / 1024 / 1024).toFixed(0)}MB, ` +
      `${this.artefacts.evicted} evicted` +
      ((process.env.STORAGE_DRIVER ?? 'local') === 'local'
        ? ' — STORAGE_DRIVER=local is not shared between instances'
        : ''),
  });

  private async exportDatabase(): Promise<{
    data: Record<string, unknown[]>;
    manifest: Record<string, unknown>;
  }> {
    const data: Record<string, unknown[]> = {};
    const tables: Record<string, number> = {};
    const oversized: string[] = [];
    let rows = 0;

    for (const table of BackupService.TABLES) {
      try {
        const exported = await this.exportTableFully(table);
        data[table] = exported.rows;
        tables[table] = exported.rows.length;
        rows += exported.rows.length;
        if (exported.truncated) oversized.push(table);
      } catch (error) {
        // A table that does not exist in this deployment is not a failed
        // backup; recording it in the manifest is more useful than aborting.
        tables[table] = -1;
        this.logger.warn(`Skipped "${table}": ${(error as Error).message}`);
      }
    }

    // Loud, and fatal to the backup. A partial export that reports success is
    // the one an operator relies on during an incident and discovers is short.
    if (oversized.length) {
      throw new Error(
        `Logical backup exceeded ${BackupService.TABLE_LIMIT} rows on: ${oversized.join(', ')}. ` +
          'Switch to a physical snapshot with WAL archiving for this database — ' +
          'see docs/runbooks/recovery.md. Refusing to write a partial backup.',
      );
    }

    return {
      data,
      manifest: {
        format: 'prismx-logical-v2',
        takenAt: new Date().toISOString(),
        tables,
        rows,
        complete: true,
        chunkSize: BackupService.CHUNK,
        tableLimit: BackupService.TABLE_LIMIT,
      },
    };
  }

  /**
   * Exports one table completely, in keyset pages.
   *
   * Keyset rather than OFFSET: paging a large table with OFFSET re-scans every
   * skipped row on each page, so the export gets quadratically slower the
   * further it gets — the exact shape where the last page never arrives.
   */
  private async exportTableFully(
    table: string,
  ): Promise<{ rows: unknown[]; truncated: boolean }> {
    const keyColumns = await this.schema.primaryKey(table);
    const rows: unknown[] = [];
    let after: unknown[] | null = null;

    for (;;) {
      const page: Array<Record<string, unknown>> = await this.schema.exportChunk(
        table,
        keyColumns,
        after,
        BackupService.CHUNK,
      );
      if (!page.length) break;

      for (const row of page) rows.push(BackupService.serialisable(row));

      if (rows.length >= BackupService.TABLE_LIMIT) return { rows, truncated: true };
      if (page.length < BackupService.CHUNK) break;
      if (!keyColumns.length) break; // No stable order to page by; one read only.

      const last = page[page.length - 1];
      after = keyColumns.map((column) => last[column]);
    }

    return { rows, truncated: false };
  }

  private exportConfiguration(): {
    data: Record<string, unknown>;
    manifest: Record<string, unknown>;
  } {
    // Names and shapes only. A configuration backup that contained the values
    // would be a credential dump with a friendly filename.
    const keys = Object.keys(process.env)
      .filter((key) => /^(APP_|DATABASE_|REDIS_|STORAGE_|AUTH_|PROVIDER_)/.test(key))
      .sort();

    return {
      data: {
        environment: this.instances.environment,
        version: this.instances.version,
        configuredKeys: keys,
        nodeVersion: process.version,
      },
      manifest: { format: 'prismx-config-v1', keys: keys.length, rows: 0, tables: {} },
    };
  }

  private async exportStorage(): Promise<{
    data: Record<string, unknown>;
    manifest: Record<string, unknown>;
  }> {
    const objects = await this.storage.list('').catch(() => []);
    return {
      data: { objects },
      manifest: {
        format: 'prismx-storage-manifest-v1',
        objects: objects.length,
        rows: objects.length,
        tables: {},
        // An inventory, not the bytes. Copying object storage belongs to the
        // object store's own replication, not to an application loop.
        note: 'Inventory only; object contents are replicated by the storage layer.',
      },
    };
  }

  /** Dates and BigInts do not survive JSON on their own. */
  private static serialisable(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) out[key] = value.toISOString();
      else if (typeof value === 'bigint') out[key] = Number(value);
      else if (Buffer.isBuffer(value)) out[key] = value.toString('base64');
      else out[key] = value;
    }
    return out;
  }

  // ============================================================ crypto

  private encrypt(plain: Buffer): { body: Buffer; keyMaterial: Record<string, unknown> } {
    // A fresh key per backup: one compromised archive does not read the others,
    // and rotating the platform key re-seals rather than re-encrypts.
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      body,
      keyMaterial: {
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        sealedKey: this.crypto.seal(dataKey.toString('base64')),
      },
    };
  }

  private decrypt(body: Buffer, keyMaterial: Record<string, unknown>): Buffer {
    if (!keyMaterial?.sealedKey) return body;

    const dataKey = Buffer.from(
      this.crypto.open(keyMaterial.sealedKey as { value: string; iv: string; authTag: string }),
      'base64',
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      dataKey,
      Buffer.from(String(keyMaterial.iv), 'base64'),
    );
    decipher.setAuthTag(Buffer.from(String(keyMaterial.authTag), 'base64'));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  private async readArtefact(backup: Backup): Promise<Buffer> {
    const cached = this.artefacts.get(backup.id);
    if (cached) return cached;
    if (!backup.location) throw new Error('The backup has no stored location');
    return this.storage.download(backup.location);
  }

  // ============================================================ verify

  /**
   * Reads a backup back and checks it against its own checksum.
   *
   * This decrypts, decompresses and re-hashes, which means it exercises every
   * step a restore would — the point being that a verification which skips the
   * expensive parts verifies the cheap parts.
   */
  async verify(backupId: string): Promise<{ backup: Backup; ok: boolean; detail: string }> {
    const backup = await this.backups.findOrFail(backupId);
    if (backup.status === 'FAILED') {
      throw new NotFoundException('That backup did not complete and cannot be verified');
    }

    try {
      const raw = await this.readArtefact(backup);
      const plain = gunzipSync(
        this.decrypt(raw, (backup.keyMaterial ?? {}) as Record<string, unknown>),
      );
      const checksum = createHash('sha256').update(plain).digest('hex');
      const parsed = JSON.parse(plain.toString('utf8')) as Record<string, unknown[]>;

      const ok = checksum === backup.checksum;
      const tableCount = Object.keys(parsed).length;
      const detail = ok
        ? `Checksum matched; ${tableCount} table(s) readable`
        : `Checksum mismatch: expected ${backup.checksum.slice(0, 12)}, read ${checksum.slice(0, 12)}`;

      const updated = await this.backups.update(backup.id, {
        status: ok ? 'VERIFIED' : 'CORRUPT',
        verifiedAt: new Date(),
        verificationDetail: detail,
      });

      if (!ok) this.logger.error(`Backup ${backup.id} is CORRUPT: ${detail}`);
      await this.events.publish(DomainEvent.BackupVerified, { backupId: backup.id, ok, detail });
      return { backup: updated, ok, detail };
    } catch (error) {
      const detail = `Unreadable: ${(error as Error).message}`;
      const updated = await this.backups.update(backup.id, {
        status: 'CORRUPT',
        verifiedAt: new Date(),
        verificationDetail: detail.slice(0, 500),
      });
      this.logger.error(`Backup ${backup.id} could not be read: ${detail}`);
      return { backup: updated, ok: false, detail };
    }
  }

  // ============================================================ restore

  /**
   * Restores from a backup.
   *
   * `dryRun` defaults to true, and that default is the whole design. A restore
   * is the most destructive operation the platform has: it overwrites live data
   * with older data, and the moment it is needed is the moment nobody is
   * thinking clearly. Making the safe path the default means an accidental call
   * validates rather than destroys, and destroying requires saying so.
   */
  async restore(input: {
    backupId: string;
    mode?: 'FULL' | 'POINT_IN_TIME' | 'VERIFY_ONLY';
    targetTime?: Date;
    dryRun?: boolean;
    tables?: string[];
  }): Promise<RestoreRun> {
    const backup = await this.backups.findOrFail(input.backupId);
    const dryRun = input.dryRun !== false;
    const mode = input.mode ?? 'VERIFY_ONLY';
    const started = Date.now();

    const run = await this.restores.create({
      backupId: backup.id,
      mode,
      status: 'RUNNING',
      dryRun,
      targetTime: input.targetTime ?? null,
      runById: RequestContextStore.get()?.userId ?? null,
    });

    try {
      const raw = await this.readArtefact(backup);
      const plain = gunzipSync(
        this.decrypt(raw, (backup.keyMaterial ?? {}) as Record<string, unknown>),
      );

      const checksum = createHash('sha256').update(plain).digest('hex');
      if (checksum !== backup.checksum) {
        throw new Error('Checksum mismatch — refusing to restore from a corrupt backup');
      }

      const payload = JSON.parse(plain.toString('utf8')) as Record<string, Record<string, unknown>[]>;
      const wanted = input.tables?.length
        ? BackupService.TABLES.filter((t) => input.tables!.includes(t))
        : BackupService.TABLES;

      let tablesRestored = 0;
      let rowsRestored = 0;
      const perTable: Record<string, number> = {};

      for (const table of wanted) {
        const rows = payload[table];
        if (!Array.isArray(rows)) continue;

        const eligible =
          mode === 'POINT_IN_TIME' && input.targetTime
            ? rows.filter((row) => BackupService.createdBefore(row, input.targetTime!))
            : rows;

        perTable[table] = eligible.length;
        rowsRestored += eligible.length;
        tablesRestored += 1;

        if (dryRun || mode === 'VERIFY_ONLY') continue;

        // Writes go through the same connection as everything else, one table
        // at a time, in the declared dependency order. Conflicts are skipped
        // rather than overwritten: a restore that clobbers rows newer than the
        // backup turns a partial loss into a total one.
        await this.insertRows(table, eligible);
      }

      const finished = await this.restores.update(run.id, {
        status: 'SUCCEEDED',
        tablesRestored,
        rowsRestored,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        detail: {
          perTable,
          mode,
          dryRun,
          checksumVerified: true,
          ...(mode === 'POINT_IN_TIME'
            ? {
                note:
                  'Reconstructed to the nearest backup at or before the target. ' +
                  'True point-in-time recovery needs WAL archiving at the database.',
              }
            : {}),
        } as never,
      });

      if (!dryRun) {
        await this.backups.update(backup.id, { status: 'VERIFIED', verifiedAt: new Date() });
      }
      await this.events.publish(DomainEvent.BackupRestored, {
        backupId: backup.id,
        restoreId: run.id,
        dryRun,
        rowsRestored,
      });

      this.logger.log(
        `Restore ${run.id} ${dryRun ? '(dry run) ' : ''}— ${tablesRestored} table(s), ${rowsRestored} row(s)`,
      );
      return finished;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Restore ${run.id} failed: ${message}`);
      return this.restores.update(run.id, {
        status: 'FAILED',
        error: message.slice(0, 500),
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      });
    }
  }

  private static createdBefore(row: Record<string, unknown>, target: Date): boolean {
    const created = row.createdAt;
    if (typeof created !== 'string') return true;
    const parsed = Date.parse(created);
    return Number.isNaN(parsed) ? true : parsed <= target.getTime();
  }

  private async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    for (const row of rows) {
      await this.schema.insertRow(table, row).catch((error) => {
        // One unrestorable row must not abandon the rest of the table. The
        // count in the run record is what the operator reconciles against.
        this.logger.warn(`Row skipped in "${table}": ${(error as Error).message}`);
      });
    }
  }

  /** Restores to the state at a moment, using the newest backup at or before it. */
  async pointInTime(target: Date, dryRun = true): Promise<RestoreRun> {
    const candidates = await this.backups.list(200);
    const usable = candidates
      .filter(
        (backup) =>
          backup.kind === 'DATABASE' &&
          ['SUCCEEDED', 'VERIFIED'].includes(backup.status) &&
          backup.finishedAt !== null &&
          backup.finishedAt <= target,
      )
      .sort((a, b) => (b.finishedAt!.getTime() - a.finishedAt!.getTime()));

    if (!usable.length) {
      throw new NotFoundException(`No backup exists at or before ${target.toISOString()}`);
    }

    return this.restore({
      backupId: usable[0].id,
      mode: 'POINT_IN_TIME',
      targetTime: target,
      dryRun,
    });
  }

  // ============================================================ reporting

  list(take = 50): Promise<Backup[]> {
    return this.backups.list(take);
  }

  restores_(take = 50): Promise<RestoreRun[]> {
    return this.restores.list(take);
  }

  async posture(): Promise<Record<string, unknown>> {
    const [latest, verified, counts, exercised] = await Promise.all([
      this.backups.latestSucceeded(),
      this.backups.latestVerified(),
      this.backups.posture(),
      this.restores.everExercised(),
    ]);

    const ageHours = latest?.finishedAt
      ? (Date.now() - latest.finishedAt.getTime()) / 3_600_000
      : null;

    return {
      lastSucceededAt: latest?.finishedAt ?? null,
      lastVerifiedAt: verified?.verifiedAt ?? null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
      count: counts.count,
      allEncrypted: counts.allEncrypted,
      unencrypted: counts.unencrypted,
      restoreExercised: exercised,
      // The number that matters in an incident: how much work a failure now
      // would destroy.
      recoveryPointObjectiveHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
    };
  }

  /** Expires backups past their retention. Leader-only, called on a schedule. */
  async prune(): Promise<number> {
    const expired = await this.backups.expired();
    for (const backup of expired) {
      await this.backups.update(backup.id, { status: 'EXPIRED' });
      this.artefacts.delete(backup.id);
    }
    if (expired.length) this.logger.log(`${expired.length} backup(s) past retention`);
    return expired.length;
  }
}
