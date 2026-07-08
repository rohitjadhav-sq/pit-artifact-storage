import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  STORAGE_ROOT: z.string().min(1).default('./data/artifacts'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),
  DATABASE_URL: z.string().min(1).default('postgres://pit:pit@localhost:5432/pit'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SSE_KEEPALIVE_MS: z.coerce.number().int().min(1000).default(20_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  port: number;
  host: string;
  storageRoot: string;
  maxUploadBytes: number;
  databaseUrl: string;
  corsOrigins: string[];
  sseKeepAliveMs: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    storageRoot: parsed.STORAGE_ROOT,
    maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
    databaseUrl: parsed.DATABASE_URL,
    corsOrigins: parsed.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    sseKeepAliveMs: parsed.SSE_KEEPALIVE_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
