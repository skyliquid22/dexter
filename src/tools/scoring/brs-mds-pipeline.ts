import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callApi } from '../finance/api.js';
import { narrativeShockCorpus } from '../narrative/index.js';
import { brsMdsScore } from './brs-mds-score.js';
import { formatToolResult } from '../types.js';
import { parseReportDate, sortByReportPeriod } from '../../utils/series.js';
import { logToFile } from '../../utils/file-logger.js';
import { fetchShortInterestYfinance, normalizeShortInterest } from '../../utils/short-interest.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_TICKERS = 10;
const MAX_LOOKBACK_YEARS = 10;
const MAX_UNIVERSE_TICKERS = 100;
const MIN_HISTORY_QUARTERS = 8;
const DEFAULT_LOOKBACK_YEARS = 5;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_OWNERSHIP_LIMIT = 100;
const TABLE_HEADERS = ['Ticker', 'BRS', 'MDS', 'BRS Tier', 'MDS Tier', 'As-of', 'Short %'];

const NarrativeOptionsSchema = z.object({
  include: z.boolean().default(true),
  window_days: z.number().default(30),
  include_news: z.boolean().default(true),
  include_news_body: z.boolean().default(true),
  include_filings: z.boolean().default(true),
  filing_type: z.enum(['8-K', '10-Q', '10-K']).default('8-K'),
  filings_limit: z.number().default(5),
  news_limit: z.number().default(20),
  require_relevance: z.boolean().default(true),
  allowed_news_sources: z.array(z.string()).optional(),
  company_name: z.string().optional(),
}).passthrough();

const TickerInputSchema = z.union([
  z.string(),
  z.object({ ticker: z.string() }).passthrough(),
]);

const PipelineInputSchema = z.object({
  tickers: z.array(z.unknown()).min(1).max(MAX_TICKERS).optional(),
  ticker: z.unknown().optional(),
  lookback_years: z.number().optional(),
  universe_tickers: z.array(z.unknown()).optional(),
  universe_ticker: z.unknown().optional(),
  short_interest_pct: z.record(z.string(), z.number()).optional(),
  use_yfinance_short_interest: z.boolean().optional(),
  include_estimates: z.boolean().optional(),
  estimates_period: z.enum(['annual', 'quarterly']).optional(),
  include_ownership: z.boolean().optional(),
  include_insider_trades: z.boolean().optional(),
  insider_limit: z.number().optional(),
  insider_days: z.number().optional(),
  narrative: NarrativeOptionsSchema.optional(),
  config: z
    .object({
      brs: z.record(z.string(), z.any()).optional(),
      mds: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
}).passthrough();

type GenericRow = Record<string, unknown>;
type TickerInput = string | { ticker: string } | Record<string, unknown>;

function toUpperTickers(tickers: TickerInput[]): string[] {
  const unique = new Set<string>();
  for (const ticker of tickers) {
    if (!ticker) continue;
    const value = typeof ticker === 'string'
      ? ticker
      : typeof (ticker as { ticker?: unknown }).ticker === 'string'
        ? (ticker as { ticker: string }).ticker
        : '';
    if (!value) continue;
    unique.add(value.trim().toUpperCase());
  }
  return Array.from(unique);
}

function clampLookbackYears(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOOKBACK_YEARS;
  return Math.min(Math.max(1, value), MAX_LOOKBACK_YEARS);
}

function lookbackQuarters(years: number): number {
  return Math.max(MIN_HISTORY_QUARTERS, Math.round(years * 4));
}

function toIsoDate(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function brsTier(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value >= 80) return 'Elite';
  if (value >= 60) return 'High';
  if (value >= 40) return 'Mixed';
  return 'Weak';
}

function mdsTier(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value >= 70) return 'Severe';
  if (value >= 50) return 'Moderate';
  return 'Low';
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function buildSummaryTable(
  results: Array<Record<string, unknown>>,
  shortInterest: Record<string, number>
): string {
  const rows = results.map((result) => {
    const ticker = typeof result.ticker === 'string' ? result.ticker : '';
    const brsTotal = (result.brs as Record<string, unknown> | undefined)?.scores
      ? (result.brs as Record<string, unknown>).scores as Record<string, unknown>
      : undefined;
    const brsValue = typeof brsTotal?.total === 'number' ? brsTotal.total : null;
    const mdsValue = typeof (result.mds as Record<string, unknown> | undefined)?.total_mds_points === 'number'
      ? (result.mds as Record<string, unknown>).total_mds_points as number
      : null;
    const asof = typeof result.asof_date === 'string' && result.asof_date.trim().length > 0
      ? result.asof_date
      : 'n/a';
    const shortValue = shortInterest[ticker];
    return [
      ticker,
      brsValue === null ? 'n/a' : String(brsValue),
      mdsValue === null ? 'n/a' : String(mdsValue),
      brsTier(brsValue),
      mdsTier(mdsValue),
      asof,
      formatPercent(typeof shortValue === 'number' ? shortValue : null),
    ];
  });

  const widths = TABLE_HEADERS.map((header) => header.length);
  rows.forEach((row) => {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], String(cell).length);
    });
  });

  const separator = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const headerRow = `| ${TABLE_HEADERS.map((h, i) => h.padEnd(widths[i])).join(' | ')} |`;
  const dataRows = rows.map(
    (row) => `| ${row.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`
  );

  return [separator, headerRow, separator, ...dataRows, separator].join('\n');
}

function latestDate(rows: Array<{ report_period: string }>): string | null {
  let latest: { date: Date; value: string } | null = null;
  for (const row of rows) {
    const parsed = parseReportDate(row.report_period);
    if (!parsed) continue;
    if (!latest || parsed > latest.date) {
      latest = { date: parsed, value: row.report_period };
    }
  }
  return latest?.value ?? null;
}

function computeAsofDate(
  income: Array<{ report_period: string }>,
  balance: Array<{ report_period: string }>,
  cashflow: Array<{ report_period: string }>
): string | null {
  const incomeDates = new Set(income.map((row) => row.report_period));
  const balanceDates = new Set(balance.map((row) => row.report_period));
  const cashDates = new Set(cashflow.map((row) => row.report_period));
  const candidates = [...incomeDates].filter((d) => balanceDates.has(d) && cashDates.has(d));
  if (candidates.length > 0) {
    const withDates = candidates
      .map((value) => ({ value, date: parseReportDate(value) }))
      .filter((entry): entry is { value: string; date: Date } => !!entry.date)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    return withDates[withDates.length - 1]?.value ?? null;
  }
  return latestDate(income) || latestDate(balance) || latestDate(cashflow);
}

const REPORT_PERIOD_KEYS = [
  'report_period',
  'report_date',
  'period_end',
  'period_end_date',
  'end_date',
  'date',
  'as_of_date',
  'period',
];

function quarterEnd(year: number, quarter: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(quarter)) return null;
  const q = Math.round(quarter);
  if (q < 1 || q > 4) return null;
  const month = q * 3;
  const day = month === 3 || month === 12 ? 31 : 30;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeReportPeriod(row: GenericRow): GenericRow {
  if (typeof row.report_period === 'string' && row.report_period.trim().length > 0) {
    return row;
  }
  for (const key of REPORT_PERIOD_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      if (parseReportDate(value)) {
        return { ...row, report_period: value };
      }
      const trimmed = value.trim();
      const fyMatch = trimmed.match(/FY\s*(\d{4})/i);
      if (fyMatch) {
        return { ...row, report_period: `${fyMatch[1]}-12-31` };
      }
      const qMatch = trimmed.match(/Q([1-4])\s*(\d{4})/i);
      if (qMatch) {
        const date = quarterEnd(Number(qMatch[2]), Number(qMatch[1]));
        if (date) return { ...row, report_period: date };
      }
    }
  }
  const fiscalPeriod = typeof row.fiscal_period === 'string' ? row.fiscal_period : '';
  const match = fiscalPeriod.match(/(\d{4})\s*[- ]?\s*Q([1-4])/i);
  if (match) {
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const date = quarterEnd(year, quarter);
    if (date) return { ...row, report_period: date };
  }
  const yearValue = row.fiscal_year ?? row.year;
  const quarterValue = row.fiscal_quarter ?? row.quarter;
  const year = typeof yearValue === 'number' ? yearValue : Number(yearValue);
  const quarter = typeof quarterValue === 'number' ? quarterValue : Number(quarterValue);
  const date = quarterEnd(year, quarter);
  if (date) return { ...row, report_period: date };
  if (typeof row.period === 'string' && row.period.trim().length > 0) {
    return { ...row, report_period: row.period.trim() };
  }
  return row;
}

function filterRowsByReportPeriod(rows: GenericRow[], label: string): GenericRow[] {
  if (rows.length === 0) return rows;
  const normalized = rows.map((row) => normalizeReportPeriod(row));
  const filtered = normalized.filter(
    (row) => typeof row.report_period === 'string' && row.report_period.trim().length > 0
  );
  if (filtered.length < rows.length) {
    logToFile('brs-mds-pipeline', 'rows_dropped', {
      label,
      dropped: rows.length - filtered.length,
    });
  }
  return filtered;
}

function filterRowsByTransactionDate(rows: GenericRow[], label: string): GenericRow[] {
  if (rows.length === 0) return rows;
  const filtered = rows.filter(
    (row) => typeof row.transaction_date === 'string' && row.transaction_date.trim().length > 0
  );
  if (filtered.length < rows.length) {
    logToFile('brs-mds-pipeline', 'rows_dropped', {
      label,
      dropped: rows.length - filtered.length,
    });
  }
  return filtered;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) break;
      results[index] = await handler(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchArray(endpoint: string, params: Record<string, string | number | undefined>, key: string): Promise<GenericRow[]> {
  const { data } = await callApi(endpoint, params);
  const payload = (data as Record<string, unknown>)[key] ?? data;
  return Array.isArray(payload) ? (payload as GenericRow[]) : [];
}

async function fetchCompanyFacts(ticker: string): Promise<GenericRow[]> {
  const { data } = await callApi('/company/facts/', { ticker });
  const payload = (data as Record<string, unknown>).company_facts ?? data;
  if (Array.isArray(payload)) return payload as GenericRow[];
  if (payload && typeof payload === 'object') return [payload as GenericRow];
  return [];
}

async function fetchOwnershipHistory(ticker: string): Promise<GenericRow[]> {
  const { data } = await callApi('/institutional-ownership/', {
    ticker,
    limit: DEFAULT_OWNERSHIP_LIMIT,
  });
  const payload =
    (data as Record<string, unknown>).ownership
      ?? (data as Record<string, unknown>).institutional_ownership
      ?? data;
  return Array.isArray(payload) ? (payload as GenericRow[]) : [];
}

function extractCompanyName(facts: GenericRow[]): string | null {
  const entry = facts[0];
  if (!entry) return null;
  const name = entry.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function buildUniverseMetric(
  ticker: string,
  facts: GenericRow[],
  metrics: GenericRow[]
): GenericRow {
  const sorted = sortByReportPeriod(metrics as Array<{ report_period: string }>);
  const latest = sorted[sorted.length - 1];
  const evToEbitda =
    typeof latest?.enterprise_value_to_ebitda_ratio === 'number'
      ? latest.enterprise_value_to_ebitda_ratio
      : undefined;
  const roicSeries = sorted
    .filter((row) => typeof row.return_on_invested_capital === 'number')
    .slice(-8)
    .map((row) => ({
      report_period: row.report_period,
      value: row.return_on_invested_capital as number,
    }));
  const fact = facts[0] ?? {};
  const base: GenericRow = {
    ticker,
    sector: typeof fact.sector === 'string' ? fact.sector : undefined,
    industry: typeof fact.industry === 'string' ? fact.industry : undefined,
  };
  if (evToEbitda !== undefined) {
    base.ev_to_ebitda = evToEbitda;
  }
  if (roicSeries.length > 0) {
    base.roic_series = roicSeries;
  }
  return base;
}

function buildMissingFlags(data: {
  company_facts: GenericRow[];
  income_statements: GenericRow[];
  balance_sheets: GenericRow[];
  cash_flow_statements: GenericRow[];
  metrics_history: GenericRow[];
  estimates?: GenericRow[];
  ownership_history?: GenericRow[];
  insider_trades?: GenericRow[];
  docs?: GenericRow[];
}): string[] {
  const flags: string[] = [];
  if (data.company_facts.length === 0) flags.push('missing_company_facts');
  if (data.income_statements.length === 0) flags.push('missing_income_statements');
  if (data.balance_sheets.length === 0) flags.push('missing_balance_sheets');
  if (data.cash_flow_statements.length === 0) flags.push('missing_cash_flow_statements');
  if (data.metrics_history.length === 0) flags.push('missing_metrics_history');
  if (!data.estimates || data.estimates.length === 0) flags.push('missing_estimates');
  if (!data.ownership_history || data.ownership_history.length === 0) flags.push('missing_ownership_history');
  if (!data.insider_trades || data.insider_trades.length === 0) flags.push('missing_insider_trades');
  if (!data.docs || data.docs.length === 0) flags.push('missing_narrative_docs');
  return flags;
}

export const brsMdsPipeline = new DynamicStructuredTool({
  name: 'brs_mds_pipeline',
  description: `Fetches required financial data and computes BRS + MDS in one step.
Runs statement/metrics pulls, narrative corpus fetch, and scoring. Returns JSON with per-ticker scores, as-of date, and missing-data flags.`,
  schema: PipelineInputSchema,
  func: async (input) => {
    const tickerInput = input.tickers ?? (input.ticker ? [input.ticker] : []);
    const tickers = toUpperTickers(tickerInput);
    if (tickers.length === 0) {
      throw new Error('tickers required');
    }
    if (tickers.length > MAX_TICKERS) {
      throw new Error(`too many tickers (max ${MAX_TICKERS})`);
    }

    const lookbackYears = clampLookbackYears(
      typeof input.lookback_years === 'number' ? input.lookback_years : DEFAULT_LOOKBACK_YEARS
    );
    const historyLimit = lookbackQuarters(lookbackYears);
    const shortInterestMap = input.short_interest_pct ?? {};
    const narrative = NarrativeOptionsSchema.parse(input.narrative ?? {});
    const includeEstimates = input.include_estimates ?? true;
    const includeOwnership = input.include_ownership ?? true;
    const includeInsider = input.include_insider_trades ?? true;
    const estimatesPeriod = input.estimates_period ?? 'quarterly';
    const insiderLimit = input.insider_limit ?? 200;
    const insiderDays = input.insider_days ?? 180;
    const useYfinanceShortInterest = input.use_yfinance_short_interest ?? true;
    const insiderStartDate = toIsoDate(insiderDays);
    const pipelineErrors: Array<{ ticker: string; error: string }> = [];
    const shortInterestErrors: Array<{ ticker: string; error: string }> = [];
    const endpointErrors: Array<{ ticker: string; endpoint: string; error: string }> = [];

    logToFile('brs-mds-pipeline', 'start', {
      tickers: tickers.length,
      lookback_years: lookbackYears,
      history_limit: historyLimit,
    });

    const concurrency = DEFAULT_CONCURRENCY;
    const shortInterestValues: Record<string, number> = {};
    const shortInterestSources: Record<string, string | undefined> = {};
    for (const [rawTicker, value] of Object.entries(shortInterestMap)) {
      const ticker = rawTicker.toUpperCase();
      const normalized = normalizeShortInterest(value);
      if (normalized !== null) {
        shortInterestValues[ticker] = normalized;
        shortInterestSources[ticker] = 'input';
      } else {
        shortInterestErrors.push({ ticker, error: 'short_interest_invalid' });
      }
    }
    if (useYfinanceShortInterest) {
      const missingTickers = tickers.filter((ticker) => typeof shortInterestValues[ticker] !== 'number');
      if (missingTickers.length > 0) {
        const result = await fetchShortInterestYfinance(missingTickers);
        Object.assign(shortInterestValues, result.values);
        Object.assign(shortInterestSources, result.sources);
        shortInterestErrors.push(...result.errors);
        logToFile('brs-mds-pipeline', 'short_interest_fetch', {
          requested: missingTickers.length,
          received: Object.keys(result.values).length,
          errors: result.errors.length,
        });
      }
    }
    const safeFetch = async <T,>(
      ticker: string,
      endpoint: string,
      fetcher: () => Promise<T>,
      fallback: T
    ): Promise<T> => {
      try {
        return await fetcher();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        endpointErrors.push({ ticker, endpoint, error: errorMsg });
        logToFile('brs-mds-pipeline', 'endpoint_error', { ticker, endpoint, error: errorMsg });
        return fallback;
      }
    };

    const tickerResults = await mapWithConcurrency(tickers, concurrency, async (ticker) => {
      try {
        const [companyFacts, income, balance, cashflow, metrics] = await Promise.all([
          safeFetch(ticker, 'company_facts', () => fetchCompanyFacts(ticker), []),
          safeFetch(
            ticker,
            'income_statements',
            () =>
              fetchArray(
                '/financials/income-statements/',
                { ticker, period: 'quarterly', limit: historyLimit },
                'income_statements'
              ),
            []
          ),
          safeFetch(
            ticker,
            'balance_sheets',
            () =>
              fetchArray(
                '/financials/balance-sheets/',
                { ticker, period: 'quarterly', limit: historyLimit },
                'balance_sheets'
              ),
            []
          ),
          safeFetch(
            ticker,
            'cash_flow_statements',
            () =>
              fetchArray(
                '/financials/cash-flow-statements/',
                { ticker, period: 'quarterly', limit: historyLimit },
                'cash_flow_statements'
              ),
            []
          ),
          safeFetch(
            ticker,
            'financial_metrics',
            () => fetchArray('/financial-metrics/', { ticker, period: 'ttm', limit: historyLimit }, 'financial_metrics'),
            []
          ),
        ]);

        const incomeStatements = filterRowsByReportPeriod(income, 'income_statements');
        const balanceSheets = filterRowsByReportPeriod(balance, 'balance_sheets');
        const cashFlowStatements = filterRowsByReportPeriod(cashflow, 'cash_flow_statements');
        const metricsHistory = filterRowsByReportPeriod(metrics, 'metrics_history');

        const extraCalls: Array<Promise<GenericRow[]>> = [];
        const extraKeys: Array<'estimates' | 'ownership' | 'insider'> = [];

        if (includeEstimates) {
          extraCalls.push(
            safeFetch(
              ticker,
              'analyst_estimates',
              () => fetchArray('/analyst-estimates/', { ticker, period: estimatesPeriod }, 'analyst_estimates'),
              []
            )
          );
          extraKeys.push('estimates');
        }

        if (includeOwnership) {
          extraCalls.push(safeFetch(ticker, 'institutional_ownership', () => fetchOwnershipHistory(ticker), []));
          extraKeys.push('ownership');
        }

        if (includeInsider) {
          extraCalls.push(
            safeFetch(
              ticker,
              'insider_trades',
              () =>
                fetchArray(
                  '/insider-trades/',
                  { ticker, limit: insiderLimit, filing_date_gte: insiderStartDate },
                  'insider_trades'
                ),
              []
            )
          );
          extraKeys.push('insider');
        }

        const extraResults = extraCalls.length > 0 ? await Promise.all(extraCalls) : [];
        const extras: Record<string, GenericRow[] | undefined> = {};
        extraKeys.forEach((key, index) => {
          extras[key] = extraResults[index];
        });

        if (extras.estimates) {
          extras.estimates = filterRowsByReportPeriod(extras.estimates, 'analyst_estimates');
        }
        if (extras.ownership) {
          extras.ownership = filterRowsByReportPeriod(extras.ownership, 'ownership_history');
        }
        if (extras.insider) {
          extras.insider = filterRowsByTransactionDate(extras.insider, 'insider_trades');
        }

        let docs: GenericRow[] | undefined;
        if (narrative.include) {
          try {
            const companyName = narrative.company_name ?? extractCompanyName(companyFacts);
            const raw = await narrativeShockCorpus.invoke({
              ticker,
              window_days: narrative.window_days,
              include_news: narrative.include_news,
              include_news_body: narrative.include_news_body,
              include_filings: narrative.include_filings,
              filing_type: narrative.filing_type,
              filings_limit: narrative.filings_limit,
              news_limit: narrative.news_limit,
              require_relevance: narrative.require_relevance,
              allowed_news_sources: narrative.allowed_news_sources,
              company_name: companyName ?? undefined,
              classify: false,
            });
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            docs = Array.isArray(parsed?.data?.docs) ? parsed.data.docs : [];
          } catch (error) {
            logToFile('brs-mds-pipeline', 'narrative_error', {
              ticker,
              error: error instanceof Error ? error.message : String(error),
            });
            docs = [];
          }
        }

        const asofDate = computeAsofDate(
          incomeStatements as Array<{ report_period: string }>,
          balanceSheets as Array<{ report_period: string }>,
          cashFlowStatements as Array<{ report_period: string }>
        );

        const payload = {
          ticker,
          company_facts: companyFacts,
          income_statements: incomeStatements,
          balance_sheets: balanceSheets,
          cash_flow_statements: cashFlowStatements,
          metrics_history: metricsHistory,
          estimates: extras.estimates,
          ownership_history: extras.ownership,
          insider_trades: extras.insider,
          docs,
          short_interest_pct:
            typeof shortInterestValues[ticker] === 'number'
              ? shortInterestValues[ticker]
              : undefined,
          asof_date: asofDate ?? undefined,
        };

        const missingFlags = buildMissingFlags({
          company_facts: companyFacts,
          income_statements: incomeStatements,
          balance_sheets: balanceSheets,
          cash_flow_statements: cashFlowStatements,
          metrics_history: metricsHistory,
          estimates: extras.estimates,
          ownership_history: extras.ownership,
          insider_trades: extras.insider,
          docs,
        });
        if (payload.short_interest_pct === undefined) {
          missingFlags.push('missing_short_interest');
        }

        return { payload, missingFlags };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        pipelineErrors.push({ ticker, error: errorMsg });
        logToFile('brs-mds-pipeline', 'ticker_error', { ticker, error: errorMsg });
        const payload = {
          ticker,
          company_facts: [],
          income_statements: [],
          balance_sheets: [],
          cash_flow_statements: [],
          metrics_history: [],
          estimates: [],
          ownership_history: [],
          insider_trades: [],
          docs: [],
          short_interest_pct:
            typeof shortInterestValues[ticker] === 'number'
              ? shortInterestValues[ticker]
              : undefined,
        };
        return { payload, missingFlags: ['fetch_error'] };
      }
    });

    const companyFactsAll = tickerResults
      .flatMap((entry) => entry.payload.company_facts || [])
      .filter((fact) => !!fact);

    const universeInput = input.universe_tickers ?? (input.universe_ticker ? [input.universe_ticker] : undefined);
    const universeSource = universeInput && universeInput.length > 0 ? universeInput : tickers;
    const universeTickers = toUpperTickers(universeSource).slice(0, MAX_UNIVERSE_TICKERS);

    if (universeInput && universeInput.length > MAX_UNIVERSE_TICKERS) {
      logToFile('brs-mds-pipeline', 'universe_trimmed', {
        requested: universeInput.length,
        used: MAX_UNIVERSE_TICKERS,
      });
    }

    const universeMetrics = await mapWithConcurrency(universeTickers, concurrency, async (ticker) => {
      const existing = tickerResults.find((entry) => entry.payload.ticker === ticker);
      if (existing) {
        return buildUniverseMetric(ticker, existing.payload.company_facts, existing.payload.metrics_history);
      }
      const [facts, metrics] = await Promise.all([
        fetchCompanyFacts(ticker),
        fetchArray('/financial-metrics/', { ticker, period: 'ttm', limit: historyLimit }, 'financial_metrics'),
      ]);
      return buildUniverseMetric(ticker, facts, metrics);
    });

    const scoreInput = {
      tickers: tickerResults.map((entry) => entry.payload),
      defaults: {
        company_facts: companyFactsAll,
        universe_metrics: universeMetrics,
      },
      config: input.config,
    };

    const rawScore = await brsMdsScore.invoke(scoreInput);
    const parsedScore = typeof rawScore === 'string' ? JSON.parse(rawScore) : rawScore;

    const results = Array.isArray(parsedScore?.data?.results) ? parsedScore.data.results : [];
    const enrichedResults = results.map((result: Record<string, unknown>) => {
      const ticker = typeof result.ticker === 'string' ? result.ticker : '';
      const matching = tickerResults.find((entry) => entry.payload.ticker === ticker);
      const missingFlags = matching?.missingFlags ?? [];
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const missingFromWarnings = warnings.filter((flag: string) => flag.startsWith('missing_'));
      const mergedMissing = Array.from(new Set([...missingFlags, ...missingFromWarnings]));
      const brs = result.brs as Record<string, unknown> | undefined;
      return {
        ...result,
        asof_date: brs?.asof_date ?? matching?.payload.asof_date ?? null,
        missing_data_flags: mergedMissing,
      };
    });

    const summaryTable = buildSummaryTable(enrichedResults, shortInterestValues);

    const payload: Record<string, unknown> = {
      results: enrichedResults,
      short_interest: {
        values: shortInterestValues,
        sources: shortInterestSources,
        errors: shortInterestErrors,
      },
      endpoint_errors: endpointErrors,
      summary_table: summaryTable,
    };
    const scoreErrors = Array.isArray(parsedScore?.data?.errors) ? parsedScore.data.errors : [];
    const allErrors = [...scoreErrors, ...pipelineErrors, ...shortInterestErrors];
    if (allErrors.length > 0) {
      payload.errors = allErrors;
    }

    const outputDir = path.join(process.cwd(), '.dexter', 'outputs');
    await mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputName = `brs_mds_pipeline_${timestamp}.json`;
    const outputPath = path.join(outputDir, outputName);
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    payload.output_path = outputPath;
    const tablePath = path.join(outputDir, `brs_mds_pipeline_${timestamp}.table.txt`);
    await writeFile(tablePath, `${summaryTable}\n`, 'utf8');
    payload.summary_table_path = tablePath;

    logToFile('brs-mds-pipeline', 'complete', {
      tickers: enrichedResults.length,
      errors: Array.isArray(payload.errors) ? payload.errors.length : 0,
      output_path: outputPath,
      summary_table_path: tablePath,
    });

    return formatToolResult(payload, []);
  },
});
