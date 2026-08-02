/**
 * Typed configuration surface. Every module reads settings through
 * ConfigService<AppConfig> — no `process.env` access outside this file.
 */
export type AuthDriver = 'supabase' | 'local';
export type StorageDriver = 'supabase' | 'local';

export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  database: { url: string };
  auth: {
    driver: AuthDriver;
    jwtSecret: string;
    jwtExpiresIn: string;
    refreshExpiresIn: string;
  };
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    jwtSecret: string;
  };
  storage: { driver: StorageDriver; bucket: string; localPath: string };
  redis: { host: string; port: number; password?: string; queuePrefix: string };
  crypto: { credentialKey: string };
  swagger: { enabled: boolean; path: string };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  auth: {
    driver: (process.env.AUTH_PROVIDER as AuthDriver) ?? 'local',
    jwtSecret: process.env.JWT_SECRET ?? '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
  },
  storage: {
    driver: (process.env.STORAGE_DRIVER as StorageDriver) ?? 'local',
    bucket: process.env.STORAGE_BUCKET ?? 'prismx',
    localPath: process.env.STORAGE_LOCAL_PATH ?? './.storage',
  },
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    queuePrefix: process.env.QUEUE_PREFIX ?? 'prismx',
  },
  crypto: {
    credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY ?? '',
  },
  swagger: {
    enabled: (process.env.SWAGGER_ENABLED ?? 'true') === 'true',
    path: process.env.SWAGGER_PATH ?? 'docs',
  },
});
