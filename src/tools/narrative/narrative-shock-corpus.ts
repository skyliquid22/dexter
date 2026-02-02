import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { callApi } from '../finance/api.js';
import { formatToolResult } from '../types.js';
import { classifyNarrativeShock } from '../../utils/narrative-shock.js';
import { logToFile } from '../../utils/file-logger.js';

const NEWS_BODY_ENDPOINT = (process.env.NEWS_BODY_ENDPOINT_PATH || '').trim();
const NEWS_BODY_MIN_CHARS = 120;
const NEWS_BODY_MAX_CHARS = 200000;
const NEWS_BODY_TIMEOUT_MS = 8000;
const OUTPUT_DIR = '.dexter/outputs';

const NarrativeShockCorpusInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to build a narrative shock corpus for. For example, 'AAPL'."),
  company_name: z
    .string()
    .optional()
    .describe('Optional company name override for relevance filtering (e.g., "Apple Inc.").'),
  window_days: z
    .number()
    .default(30)
    .describe('Number of days to include in the corpus (default: 30).'),
  include_news: z.boolean().default(true),
  include_news_body: z
    .boolean()
    .default(true)
    .describe('Attempt to fetch full news body when summaries are missing.'),
  include_filings: z.boolean().default(true),
  filing_type: z.enum(['8-K', '10-Q', '10-K']).default('8-K'),
  filings_limit: z.number().default(5).describe('Max filings to fetch (default: 5).'),
  news_limit: z.number().default(20).describe('Max news items to fetch (default: 20).'),
  allowed_news_sources: z
    .array(z.string())
    .optional()
    .describe('Optional allowlist for news sources (matches source field or URL hostname).'),
  require_relevance: z
    .boolean()
    .default(true)
    .describe('Filter news to items mentioning the ticker or company name.'),
  classify: z.boolean().default(true).describe('Run deterministic classifier on the corpus.'),
});

type SourceType = 'SEC_FILING' | 'NEWS' | 'EARNINGS_RELEASE' | 'PRESS_RELEASE';

interface NarrativeDoc {
  source_type: SourceType;
  title: string;
  body: string;
  published_at: string;
  form_type?: string;
  filing_item?: string;
  url?: string;
  id?: string;
}

function toIsoDate(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ensureOutputDir(): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

const COMPANY_NAME_STOPWORDS = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'plc',
  'holdings',
  'group',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase();
}

function buildNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !COMPANY_NAME_STOPWORDS.has(token));
}

function buildRelevanceMatchers(ticker: string, companyName?: string): RegExp[] {
  const matchers: RegExp[] = [];
  if (ticker.length >= 2) {
    matchers.push(new RegExp(`\\b${escapeRegExp(ticker)}\\b`, 'i'));
  }
  if (companyName) {
    const tokens = buildNameTokens(companyName);
    tokens.forEach((token) => matchers.push(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i')));
  }
  return matchers;
}

function isCompanyNameInTitle(title: string, companyName: string | null): boolean {
  if (!companyName) return false;
  const tokens = buildNameTokens(companyName);
  if (tokens.length === 0) return false;
  return tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(title));
}

function isRelevantText(text: string, matchers: RegExp[]): boolean {
  if (matchers.length === 0) return true;
  return matchers.some((matcher) => matcher.test(text));
}

function matchesAllowedSources(
  source: string,
  hostname: string | null,
  allowedSources: string[]
): boolean {
  if (allowedSources.length === 0) return true;
  const sourceValue = normalizeSource(source);
  const hostValue = hostname ? normalizeSource(hostname) : '';
  return allowedSources.some((allowed) => {
    const token = normalizeSource(allowed);
    if (!token) return false;
    return sourceValue.includes(token) || hostValue.includes(token) || token.includes(sourceValue);
  });
}

function decodeHtmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, entity) => {
    if (entity.startsWith('#x')) {
      const codePoint = parseInt(entity.slice(2), 16);
      return Number.isNaN(codePoint) ? match : String.fromCharCode(codePoint);
    }
    if (entity.startsWith('#')) {
      const codePoint = parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCharCode(codePoint);
    }
    return entityMap[entity] ?? match;
  });
}

function stripHtml(text: string): string {
  const withoutScripts = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutScripts.replace(/<\/(p|div|br|li|h[1-6])>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, ' ');
  const decoded = decodeHtmlEntities(stripped);
  return decoded.replace(/\s+/g, ' ').trim();
}

function extractFromTag(html: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  return match ? match[1] : null;
}

function extractArticleHtml(html: string): string {
  const article = extractFromTag(html, 'article');
  if (article) return article;
  const main = extractFromTag(html, 'main');
  if (main) return main;
  const body = extractFromTag(html, 'body');
  if (body) return body;
  return html;
}

function extractNewsBody(data: Record<string, unknown>): string {
  if (typeof data === 'string') return data;
  const candidates = [
    'body',
    'content',
    'text',
    'article',
    'article_body',
    'news_body',
    'summary',
  ];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
}

async function fetchNewsBody(url: string): Promise<string | null> {
  if (!NEWS_BODY_ENDPOINT) return null;
  try {
    const { data } = await callApi(NEWS_BODY_ENDPOINT, { url });
    const rawBody = extractNewsBody(data as Record<string, unknown>);
    if (!rawBody) return null;
    const cleaned = stripHtml(rawBody);
    return cleaned.length > 0 ? cleaned : null;
  } catch (error) {
    logToFile('narrative-corpus', 'news_body_error', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchNewsBodyDirect(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NEWS_BODY_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; Dexter/1.0)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!response.ok) return null;
      const html = await response.text();
      const trimmed = html.slice(0, NEWS_BODY_MAX_CHARS);
      const extracted = stripHtml(extractArticleHtml(trimmed));
      return extracted.length >= NEWS_BODY_MIN_CHARS ? extracted : null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    logToFile('narrative-corpus', 'news_body_direct_error', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildNewsDoc(item: Record<string, unknown>, bodyOverride?: string): NarrativeDoc {
  const title = coerceString(item.title ?? item.headline ?? item.subject ?? '');
  const body = bodyOverride ?? coerceString(item.body ?? item.summary ?? item.content ?? item.text ?? '');
  const publishedAt = coerceString(item.published_at ?? item.date ?? item.datetime ?? '');
  return {
    source_type: 'NEWS',
    title,
    body,
    published_at: publishedAt || new Date().toISOString(),
    url: typeof item.url === 'string' ? item.url : undefined,
    id: typeof item.id === 'string' ? item.id : undefined,
  };
}

function buildFilingDoc(
  filing: Record<string, unknown>,
  items: unknown
): NarrativeDoc {
  const title = coerceString(filing.title ?? filing.filing_type ?? 'SEC Filing');
  const publishedAt = coerceString(filing.filing_date ?? filing.report_date ?? filing.report_period ?? '');
  let body = '';
  if (items && typeof items === 'object') {
    const values = Object.values(items as Record<string, unknown>);
    body = values.map((v) => coerceString(v)).join('\n\n');
  } else {
    body = coerceString(items);
  }
  return {
    source_type: 'SEC_FILING',
    title,
    body,
    published_at: publishedAt || new Date().toISOString(),
    form_type: typeof filing.filing_type === 'string' ? filing.filing_type : undefined,
    url: typeof filing.url === 'string' ? filing.url : undefined,
    id: typeof filing.accession_number === 'string' ? filing.accession_number : undefined,
  };
}

async function fetchCompanyName(ticker: string): Promise<string | null> {
  try {
    const { data } = await callApi('/company/facts/', { ticker });
    const facts = (data as Record<string, unknown>).company_facts || data;
    if (facts && typeof facts === 'object' && 'name' in facts) {
      const value = (facts as Record<string, unknown>).name;
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  } catch (error) {
    logToFile('narrative-corpus', 'company_facts_error', {
      ticker,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

async function fetchNews(
  ticker: string,
  start: string,
  end: string,
  limit: number,
  includeNewsBody: boolean,
  requireRelevance: boolean,
  companyName: string | null,
  allowedSources: string[]
): Promise<{ docs: NarrativeDoc[]; stats: Record<string, number> }> {
  const { data } = await callApi('/news/', {
    ticker,
    start_date: start,
    end_date: end,
    limit,
  });
  const items = Array.isArray(data.news) ? data.news : Array.isArray(data) ? data : [];
  const docs: NarrativeDoc[] = [];
  const stats = {
    total: items.length,
    kept: 0,
    skipped_source: 0,
    skipped_relevance: 0,
    body_fetched: 0,
  };
  const bodyCache = new Map<string, string>();
  const matchers = buildRelevanceMatchers(ticker, companyName || undefined);

  for (const item of items) {
    const record = item as Record<string, unknown>;
    let bodyOverride: string | undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    const source = coerceString(record.source ?? record.provider ?? '');
    const title = coerceString(record.title ?? record.headline ?? '');
    let hostname: string | null = null;
    if (url) {
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = null;
      }
    }
    if (!matchesAllowedSources(source, hostname, allowedSources)) {
      stats.skipped_source += 1;
      continue;
    }
    const preview = coerceString(record.body ?? record.summary ?? record.content ?? record.text ?? '');
    let textForRelevance = `${title} ${preview}`.trim();
    let relevant = !requireRelevance || isRelevantText(textForRelevance, matchers);
    const titleHasCompanyName = isCompanyNameInTitle(title, companyName);
    if (includeNewsBody && url && preview.trim().length < NEWS_BODY_MIN_CHARS && titleHasCompanyName) {
      const cached = bodyCache.get(url);
      if (cached) {
        bodyOverride = cached;
      } else {
        const body = NEWS_BODY_ENDPOINT ? await fetchNewsBody(url) : await fetchNewsBodyDirect(url);
        if (body) {
          bodyCache.set(url, body);
          bodyOverride = body;
          stats.body_fetched += 1;
          logToFile('narrative-corpus', 'news_body_loaded', {
            url,
            length: body.length,
            source: NEWS_BODY_ENDPOINT ? 'endpoint' : 'direct',
          });
        }
      }
    }
    if (requireRelevance && !relevant && bodyOverride) {
      textForRelevance = `${coerceString(record.title ?? record.headline ?? '')} ${bodyOverride}`.trim();
      relevant = isRelevantText(textForRelevance, matchers);
    }
    if (requireRelevance && !relevant) {
      stats.skipped_relevance += 1;
      continue;
    }
    docs.push(buildNewsDoc(record, bodyOverride));
    stats.kept += 1;
  }
  return { docs, stats };
}

async function fetchFilings(
  ticker: string,
  filingType: '8-K' | '10-Q' | '10-K',
  limit: number
): Promise<Record<string, unknown>[]> {
  const { data } = await callApi('/filings/', {
    ticker,
    filing_type: filingType,
    limit,
  });
  return Array.isArray(data.filings) ? data.filings : Array.isArray(data) ? data : [];
}

async function fetchFilingItems(
  ticker: string,
  filingType: '8-K' | '10-Q' | '10-K',
  filing: Record<string, unknown>
): Promise<unknown> {
  if (filingType === '8-K') {
    const accession = filing.accession_number ?? filing.accessionNumber ?? filing.accession;
    if (!accession || typeof accession !== 'string') return null;
    const { data } = await callApi('/filings/items/', {
      ticker,
      filing_type: '8-K',
      accession_number: accession,
    });
    return data;
  }

  const yearValue = filing.fiscal_year ?? filing.year ?? filing.report_year;
  const year = typeof yearValue === 'number' ? yearValue : Number(yearValue);
  if (!year || Number.isNaN(year)) return null;
  if (filingType === '10-K') {
    const { data } = await callApi('/filings/items/', {
      ticker,
      filing_type: '10-K',
      year,
    });
    return data;
  }
  const quarterValue = filing.quarter ?? filing.fiscal_quarter;
  const quarter = typeof quarterValue === 'number' ? quarterValue : Number(quarterValue);
  if (!quarter || Number.isNaN(quarter)) return null;
  const { data } = await callApi('/filings/items/', {
    ticker,
    filing_type: '10-Q',
    year,
    quarter,
  });
  return data;
}

export const narrativeShockCorpus = new DynamicStructuredTool({
  name: 'narrative_shock_corpus',
  description: `Builds a text corpus for narrative shock analysis using SEC filings and/or company news.
Returns normalized docs with source_type, title, body, and published_at.
Optional: run deterministic narrative shock classification.`,
  schema: NarrativeShockCorpusInputSchema,
  func: async (input) => {
    const ticker = input.ticker.toUpperCase();
    const start = toIsoDate(input.window_days);
    const end = new Date().toISOString().slice(0, 10);
    const docs: NarrativeDoc[] = [];

    logToFile('narrative-corpus', 'start', {
      ticker,
      window_days: input.window_days,
      include_news: input.include_news,
      include_news_body: input.include_news_body,
      require_relevance: input.require_relevance,
      allowed_news_sources: input.allowed_news_sources,
      include_filings: input.include_filings,
      filing_type: input.filing_type,
    });

    if (input.include_news) {
      try {
        const companyName =
          input.require_relevance && !input.company_name
            ? await fetchCompanyName(ticker)
            : input.company_name ?? null;
        const allowedSources = input.allowed_news_sources ?? [];
        const { docs: newsDocs, stats } = await fetchNews(
          ticker,
          start,
          end,
          input.news_limit,
          input.include_news_body,
          input.require_relevance,
          companyName,
          allowedSources
        );
        docs.push(...newsDocs);
        logToFile('narrative-corpus', 'news_loaded', {
          ticker,
          count: newsDocs.length,
          stats,
          company_name: companyName ?? undefined,
        });
      } catch (error) {
        logToFile('narrative-corpus', 'news_error', {
          ticker,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (input.include_filings) {
      try {
        const filings = await fetchFilings(ticker, input.filing_type, input.filings_limit);
        logToFile('narrative-corpus', 'filings_loaded', { ticker, count: filings.length });
        for (const filing of filings) {
          const items = await fetchFilingItems(ticker, input.filing_type, filing);
          if (items) {
            docs.push(buildFilingDoc(filing, items));
          }
        }
      } catch (error) {
        logToFile('narrative-corpus', 'filings_error', {
          ticker,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const output: Record<string, unknown> = {
      ticker,
      window_start: start,
      window_end: end,
      docs,
    };

    if (input.classify) {
      const classification = classifyNarrativeShock(docs, { ticker, window_end: end });
      output.classification = classification;
      logToFile('narrative-corpus', 'classified', {
        ticker,
        shock_type: classification.shock_type,
        points: classification.mds_narrative_shock_points,
      });
    }

    ensureOutputDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = join(OUTPUT_DIR, `narrative_shock_${ticker}_${stamp}.json`);
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    output.output_path = outputPath;

    logToFile('narrative-corpus', 'complete', { ticker, docs: docs.length });
    return formatToolResult(output, []);
  },
});
