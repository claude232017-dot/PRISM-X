import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RequestContextStore } from '../shared/context/request-context';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Permissions } from '../auth/permissions';

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

export interface StoredObject {
  path: string;
  size: number;
  contentType: string;
  uploadedAt: Date;
}

/**
 * Object storage contract.
 *
 * Callers deal in logical paths; the driver decides where bytes actually live.
 * Every path is prefixed with the caller's organization id by StorageService,
 * so tenant separation holds regardless of driver.
 */
export interface IStorageDriver {
  readonly name: 'supabase' | 'local';
  put(path: string, data: Buffer, contentType: string): Promise<StoredObject>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  /** Time-limited download URL. */
  signedUrl(path: string, expiresInSeconds: number): Promise<string>;
}

// ------------------------------------------------------------- Drivers

@Injectable()
export class SupabaseStorageDriver implements IStorageDriver {
  readonly name = 'supabase' as const;
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.client = createClient(
      config.getOrThrow<string>('supabase.url'),
      config.getOrThrow<string>('supabase.serviceRoleKey'),
      { auth: { persistSession: false } },
    );
    this.bucket = config.get<string>('storage.bucket', 'prismx');
  }

  async put(path: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, data, { contentType, upsert: true });
    if (error) throw new BadRequestException(`Upload failed: ${error.message}`);
    return { path, size: data.length, contentType, uploadedAt: new Date() };
  }

  async get(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error || !data) throw new BadRequestException(`Download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(path: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error) throw new BadRequestException(`Delete failed: ${error.message}`);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const { data, error } = await this.client.storage.from(this.bucket).list(prefix);
    if (error) throw new BadRequestException(`List failed: ${error.message}`);
    return (data ?? []).map((item) => ({
      path: `${prefix}/${item.name}`,
      size: (item.metadata?.size as number) ?? 0,
      contentType: (item.metadata?.mimetype as string) ?? 'application/octet-stream',
      uploadedAt: new Date(item.created_at ?? Date.now()),
    }));
  }

  async signedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresInSeconds);
    if (error || !data) throw new BadRequestException(`Signing failed: ${error?.message}`);
    return data.signedUrl;
  }
}

/** Filesystem driver for development and CI. */
@Injectable()
export class LocalStorageDriver implements IStorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('storage.localPath', './.storage'));
  }

  /**
   * Resolves a logical path to disk, refusing anything that escapes the root.
   * Without this check a crafted `../../` path would read arbitrary files.
   */
  private safePath(path: string): string {
    const target = resolve(join(this.root, normalize(path)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new BadRequestException('Invalid storage path');
    }
    return target;
  }

  async put(path: string, data: Buffer, contentType: string): Promise<StoredObject> {
    const target = this.safePath(path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    await fs.writeFile(`${target}.meta`, JSON.stringify({ contentType }));
    return { path, size: data.length, contentType, uploadedAt: new Date() };
  }

  async get(path: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.safePath(path));
    } catch {
      throw new BadRequestException(`No stored object at "${path}"`);
    }
  }

  async delete(path: string): Promise<void> {
    const target = this.safePath(path);
    await fs.rm(target, { force: true });
    await fs.rm(`${target}.meta`, { force: true });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = this.safePath(prefix);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return Promise.all(
        entries
          .filter((e) => e.isFile() && !e.name.endsWith('.meta'))
          .map(async (e) => {
            const stat = await fs.stat(join(dir, e.name));
            let contentType = 'application/octet-stream';
            try {
              contentType =
                JSON.parse(await fs.readFile(join(dir, `${e.name}.meta`), 'utf8'))
                  .contentType ?? contentType;
            } catch {
              /* metadata is optional */
            }
            return {
              path: `${prefix}/${e.name}`,
              size: stat.size,
              contentType,
              uploadedAt: stat.mtime,
            };
          }),
      );
    } catch {
      return [];
    }
  }

  async signedUrl(path: string): Promise<string> {
    // No signing authority locally; the API route serves the bytes instead.
    return `/api/v1/storage/download?path=${encodeURIComponent(path)}`;
  }
}

// ------------------------------------------------------------- Service

@Injectable()
export class StorageService {
  private static readonly MAX_BYTES = 25 * 1024 * 1024;

  constructor(@Inject(STORAGE_DRIVER) private readonly driver: IStorageDriver) {}

  /** Namespaces every object under the caller's organization. */
  private scoped(path: string): string {
    const { organizationId } = RequestContextStore.require();
    const clean = path.replace(/^\/+/, '');
    return `org/${organizationId}/${clean}`;
  }

  async upload(file: {
    originalname: string;
    buffer: Buffer;
    mimetype: string;
    size: number;
  }, folder = 'uploads'): Promise<StoredObject> {
    if (!file) throw new BadRequestException('No file was uploaded');
    if (file.size > StorageService.MAX_BYTES) {
      throw new BadRequestException(
        `File exceeds the ${StorageService.MAX_BYTES / 1024 / 1024} MB limit`,
      );
    }

    // A UUID prefix keeps concurrent uploads of the same filename from
    // overwriting one another.
    const safeName = file.originalname.replace(/[^\w.\-]/g, '_');
    const key = this.scoped(`${folder}/${randomUUID()}-${safeName}`);

    return this.driver.put(key, file.buffer, file.mimetype);
  }

  download(path: string): Promise<Buffer> {
    return this.driver.get(this.scoped(path));
  }

  remove(path: string): Promise<void> {
    return this.driver.delete(this.scoped(path));
  }

  list(prefix = 'uploads'): Promise<StoredObject[]> {
    return this.driver.list(this.scoped(prefix));
  }

  signedUrl(path: string, expiresIn = 3600): Promise<string> {
    return this.driver.signedUrl(this.scoped(path), expiresIn);
  }

  get driverName(): string {
    return this.driver.name;
  }
}

// ---------------------------------------------------------- Controller

@ApiTags('Storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('upload')
  @RequirePermissions(Permissions.StorageWrite)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: { type: 'string', example: 'knowledge', default: 'uploads' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Objects are namespaced under `org/{organizationId}/…`, so one organization ' +
      'can never address another’s files. Maximum 25 MB.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        path: 'org/clx0org0001/knowledge/2f1c…-report.pdf',
        size: 91204,
        contentType: 'application/pdf',
        uploadedAt: '2026-08-02T11:44:51.312Z',
      },
    },
  })
  upload(@UploadedFile() file: Express.Multer.File, @Query('folder') folder?: string) {
    return this.storage.upload(file, folder);
  }

  @Get()
  @RequirePermissions(Permissions.StorageRead)
  @ApiQuery({ name: 'prefix', required: false, example: 'knowledge' })
  @ApiOperation({ summary: 'List stored objects' })
  @ApiOkResponse({
    schema: {
      example: [
        {
          path: 'org/clx0org0001/knowledge/2f1c-report.pdf',
          size: 91204,
          contentType: 'application/pdf',
          uploadedAt: '2026-08-02T11:44:51.312Z',
        },
      ],
    },
  })
  list(@Query('prefix') prefix?: string) {
    return this.storage.list(prefix);
  }

  @Get('signed-url')
  @RequirePermissions(Permissions.StorageRead)
  @ApiQuery({ name: 'path', required: true, example: 'knowledge/report.pdf' })
  @ApiQuery({ name: 'expiresIn', required: false, example: 3600 })
  @ApiOperation({ summary: 'Create a time-limited download URL' })
  @ApiOkResponse({ schema: { example: { url: 'https://…', expiresIn: 3600 } } })
  async signedUrl(@Query('path') path: string, @Query('expiresIn') expiresIn?: string) {
    const ttl = expiresIn ? parseInt(expiresIn, 10) : 3600;
    return { url: await this.storage.signedUrl(path, ttl), expiresIn: ttl };
  }

  @Delete(':path')
  @RequirePermissions(Permissions.StorageDelete)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a stored object' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  remove(@Param('path') path: string) {
    return this.storage.remove(path);
  }
}

@Module({
  controllers: [StorageController],
  providers: [
    StorageService,
    LocalStorageDriver,
    {
      provide: STORAGE_DRIVER,
      inject: [ConfigService, LocalStorageDriver],
      useFactory: (config: ConfigService, local: LocalStorageDriver): IStorageDriver =>
        config.get<string>('storage.driver') === 'supabase'
          ? new SupabaseStorageDriver(config)
          : local,
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
