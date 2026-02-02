import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { callApiPost } from './api.js';
import { formatToolResult } from '../types.js';
import { logToFile } from '../../utils/file-logger.js';

const CACHE_DIR = '.dexter/cache/screener';
const CACHE_TTL_HOURS = 12;
const MAX_LIMIT = 100;
const CACHE_VERSION = 2;

const ScreenerFilterSchema = z.object({
  field: z.string(),
  operator: z.enum(['eq', 'gt', 'gte', 'lt', 'lte', 'in']),
  value: z.union([z.number(), z.array(z.number())]),
});

const FinancialScreenerInputSchema = z.object({
  filters: z.array(ScreenerFilterSchema).min(1),
  limit: z.number().default(100),
  use_cache: z.boolean().default(true),
});

type ScreenerFilter = z.infer<typeof ScreenerFilterSchema>;

function normalizeFilters(filters: ScreenerFilter[]): ScreenerFilter[] {
  return [...filters].sort((a, b) => {
    const keyA = `${a.field}:${a.operator}:${JSON.stringify(a.value)}`;
    const keyB = `${b.field}:${b.operator}:${JSON.stringify(b.value)}`;
    return keyA.localeCompare(keyB);
  });
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cachePath(filters: ScreenerFilter[], limit: number): string {
  const payload = JSON.stringify({ filters: normalizeFilters(filters), limit, v: CACHE_VERSION });
  const hash = createHash('md5').update(payload).digest('hex');
  return join(CACHE_DIR, `${hash}.json`);
}

function readCache(path: string): { expiresAt: number; data: unknown; version?: number } | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { expiresAt: number; data: unknown; version?: number };
    if (Date.now() > parsed.expiresAt) return null;
    if ((parsed.version ?? 1) !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, data: unknown): void {
  const expiresAt = Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000;
  const payload = { expiresAt, data, version: CACHE_VERSION };
  writeFileSync(path, JSON.stringify(payload));
}

export const getFinancialScreener = new DynamicStructuredTool({
  name: 'get_financial_screener',
  description: `Runs a financial screener with metric filters and returns matching tickers. Results are cached for 12 hours.`,
  schema: FinancialScreenerInputSchema,
  func: async (input) => {
    const limit = Math.min(input.limit, MAX_LIMIT);
    if (input.limit > MAX_LIMIT) {
      logToFile('screener', 'limit_clamped', { requested: input.limit, limit });
    }
    ensureCacheDir();
    const cacheFile = cachePath(input.filters, limit);
    if (input.use_cache) {
      const cached = readCache(cacheFile);
      if (cached) {
        logToFile('screener', 'cache_hit', { limit });
        return formatToolResult(cached.data, []);
      }
    }

    const { data, url } = await callApiPost('/financials/search/screener/', {
      filters: input.filters,
      limit,
    });
    const payload =
      (data as Record<string, unknown>).search_results
      ?? (data as Record<string, unknown>).results
      ?? data
      ?? [];
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Record<string, unknown>).results)
        ? ((payload as Record<string, unknown>).results as unknown[])
        : [];
    const tickers = rows
      .map((row) => (row && typeof row === 'object' && 'ticker' in row ? String(row.ticker) : ''))
      .filter((ticker) => ticker.trim().length > 0)
      .map((ticker) => ticker.toUpperCase());
    const uniqueTickers = Array.from(new Set(tickers));
    writeCache(cacheFile, uniqueTickers);
    logToFile('screener', 'cache_miss', { limit, url, count: uniqueTickers.length });
    return formatToolResult(uniqueTickers, [url]);
  },
});
