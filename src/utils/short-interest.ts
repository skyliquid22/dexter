import { existsSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';

const SHORT_INTEREST_TIMEOUT_MS = 15000;
const DEFAULT_SCRIPT_PATH = 'scripts/yfinance_short_interest.py';
const DEFAULT_PYTHON_BIN = 'python3';

export interface ShortInterestFetchResult {
  values: Record<string, number>;
  sources: Record<string, string | undefined>;
  errors: Array<{ ticker: string; error: string }>;
}

export interface ShortInterestFetchOptions {
  scriptPath?: string;
  pythonBin?: string;
  timeoutMs?: number;
}

export function normalizeShortInterest(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return null;
  if (num > 1 && num <= 100) return num / 100;
  if (num > 1) return null;
  return num;
}

export async function fetchShortInterestYfinance(
  tickers: string[],
  options: ShortInterestFetchOptions = {}
): Promise<ShortInterestFetchResult> {
  const scriptPath = resolve(options.scriptPath ?? process.env.YFINANCE_SHORT_INTEREST_SCRIPT ?? DEFAULT_SCRIPT_PATH);
  const pythonBin = options.pythonBin ?? process.env.PYTHON_BIN ?? DEFAULT_PYTHON_BIN;
  const timeoutMs = options.timeoutMs ?? SHORT_INTEREST_TIMEOUT_MS;

  if (!existsSync(scriptPath)) {
    return { values: {}, sources: {}, errors: [{ ticker: '*', error: 'short_interest_script_missing' }] };
  }

  const args = [scriptPath, tickers.join(',')];
  return await new Promise((resolvePromise) => {
    const child = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolvePromise({
        values: {},
        sources: {},
        errors: [{ ticker: '*', error: error.message || 'short_interest_spawn_error' }],
      });
    });
    child.on('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout || '{}') as {
          results?: Array<{ ticker: string; short_interest_pct: unknown; source_field?: string }>;
          errors?: Array<{ ticker: string; error: string }>;
        };
        const values: Record<string, number> = {};
        const sources: Record<string, string | undefined> = {};
        const errors: Array<{ ticker: string; error: string }> = parsed.errors ?? [];
        if (Array.isArray(parsed.results)) {
          for (const item of parsed.results) {
            if (!item || typeof item.ticker !== 'string') continue;
            const normalized = normalizeShortInterest(item.short_interest_pct);
            if (normalized !== null) {
              values[item.ticker.toUpperCase()] = normalized;
              sources[item.ticker.toUpperCase()] = item.source_field;
            } else {
              errors.push({ ticker: item.ticker, error: 'short_interest_invalid' });
            }
          }
        }
        if (stderr.trim()) {
          errors.push({ ticker: '*', error: `short_interest_stderr:${stderr.trim().slice(0, 300)}` });
        }
        resolvePromise({ values, sources, errors });
      } catch {
        resolvePromise({ values: {}, sources: {}, errors: [{ ticker: '*', error: 'short_interest_parse_error' }] });
      }
    });
  });
}
