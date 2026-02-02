import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logToFile } from '../../utils/file-logger.js';

const BASE_URL = 'https://api.financialdatasets.ai';
const LOG_DIR = '.dexter/logs';

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

function sanitizeJsonText(raw: string): string {
  return raw
    .replace(/\bNaN\b/g, 'null')
    .replace(/\bInfinity\b/g, 'null')
    .replace(/\b-Infinity\b/g, 'null');
}

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

export async function callApi(
  endpoint: string,
  params: Record<string, string | number | string[] | undefined>
): Promise<ApiResponse> {
  // Read API key lazily at call time (after dotenv has loaded)
  const FINANCIAL_DATASETS_API_KEY = process.env.FINANCIAL_DATASETS_API_KEY;
  const url = new URL(`${BASE_URL}${endpoint}`);

  // Add params to URL, handling arrays
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, v));
      } else {
        url.searchParams.append(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      'x-api-key': FINANCIAL_DATASETS_API_KEY || '',
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return { data, url: url.toString() };
}

export async function callApiPost(
  endpoint: string,
  body: Record<string, unknown>
): Promise<ApiResponse> {
  const FINANCIAL_DATASETS_API_KEY = process.env.FINANCIAL_DATASETS_API_KEY;
  const url = new URL(`${BASE_URL}${endpoint}`);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'x-api-key': FINANCIAL_DATASETS_API_KEY || '',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  try {
    const data = JSON.parse(rawText) as Record<string, unknown>;
    return { data, url: url.toString() };
  } catch {
    const sanitized = sanitizeJsonText(rawText);
    try {
      const data = JSON.parse(sanitized) as Record<string, unknown>;
      logToFile('finance-api', 'json_sanitized', { endpoint, status: response.status });
      return { data, url: url.toString() };
    } catch {
      ensureLogDir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = join(LOG_DIR, `finance-api-${stamp}.txt`);
      const head = rawText.slice(0, 2000);
      const tail = rawText.slice(Math.max(0, rawText.length - 2000));
      writeFileSync(
        filename,
        `status=${response.status} ${response.statusText}\nendpoint=${endpoint}\n\n--- head ---\n${head}\n\n--- tail ---\n${tail}\n`
      );
      logToFile('finance-api', 'json_parse_error', {
        endpoint,
        status: response.status,
        statusText: response.statusText,
        bodySnippet: rawText.slice(0, 500),
        dumpFile: filename,
      });
      throw new Error('Failed to parse JSON');
    }
  }
}
