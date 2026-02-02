import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { computeBrs, computeMdsFromSeries } from '../../utils/index.js';
import type {
  BrsConfig,
  BrsInputs,
  BrsResult,
  MdsConfig,
  MdsSeriesInputs,
  MdsSeriesResult,
  NarrativeDoc,
} from '../../utils/index.js';
import { formatToolResult } from '../types.js';
import { parseReportDate } from '../../utils/series.js';
import { logToFile } from '../../utils/file-logger.js';

const MAX_TICKERS = 10;
const MAX_LOOKBACK_YEARS = 10;

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const ScoreToolInputSchema = z.object({
  tickers: z.array(z.any()).min(1).max(MAX_TICKERS),
  defaults: z.any().optional(),
  config: z.any().optional(),
}).passthrough();

type DateRow = { report_period: string };
type TradeRow = { transaction_date: string };
type DocRow = { published_at: string };
type GenericRow = Record<string, unknown>;

function arrayOrEmpty(value: unknown): GenericRow[] {
  return Array.isArray(value) ? (value as GenericRow[]) : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function trimRowsByLookback<T extends DateRow>(
  rows: T[],
  warnings: string[],
  label: string
): T[] {
  if (rows.length === 0) return rows;
  const dates = rows
    .map((row) => parseReportDate(row.report_period))
    .filter((d): d is Date => !!d);
  if (dates.length === 0) return rows;
  const latest = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
  const cutoff = new Date(latest);
  cutoff.setFullYear(cutoff.getFullYear() - MAX_LOOKBACK_YEARS);
  const filtered = rows.filter((row) => {
    const date = parseReportDate(row.report_period);
    return date ? date >= cutoff : true;
  });
  if (filtered.length < rows.length) {
    warnings.push(`trimmed_${label}_lookback`);
  }
  return filtered;
}

function trimTradesByLookback<T extends TradeRow>(
  rows: T[],
  warnings: string[],
  label: string
): T[] {
  if (rows.length === 0) return rows;
  const dates = rows
    .map((row) => parseReportDate(row.transaction_date))
    .filter((d): d is Date => !!d);
  if (dates.length === 0) return rows;
  const latest = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
  const cutoff = new Date(latest);
  cutoff.setFullYear(cutoff.getFullYear() - MAX_LOOKBACK_YEARS);
  const filtered = rows.filter((row) => {
    const date = parseReportDate(row.transaction_date);
    return date ? date >= cutoff : true;
  });
  if (filtered.length < rows.length) {
    warnings.push(`trimmed_${label}_lookback`);
  }
  return filtered;
}

function trimDocsByLookback<T extends DocRow>(
  rows: T[],
  warnings: string[],
  label: string
): T[] {
  if (rows.length === 0) return rows;
  const dates = rows
    .map((row) => parseReportDate(row.published_at))
    .filter((d): d is Date => !!d);
  if (dates.length === 0) return rows;
  const latest = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
  const cutoff = new Date(latest);
  cutoff.setFullYear(cutoff.getFullYear() - MAX_LOOKBACK_YEARS);
  const filtered = rows.filter((row) => {
    const date = parseReportDate(row.published_at);
    return date ? date >= cutoff : true;
  });
  if (filtered.length < rows.length) {
    warnings.push(`trimmed_${label}_lookback`);
  }
  return filtered;
}

function mergeDocs(
  tickerDocs?: NarrativeDoc[],
  defaultDocs?: NarrativeDoc[]
): NarrativeDoc[] | undefined {
  if (tickerDocs && tickerDocs.length > 0) return tickerDocs;
  if (defaultDocs && defaultDocs.length > 0) return defaultDocs;
  return undefined;
}

export const brsMdsScore = new DynamicStructuredTool({
  name: 'brs_mds_score',
  description: `Compute BRS + MDS from pre-fetched payload data (no API calls).
Accepts up to 10 tickers per call, trims series to a max 10-year lookback, and returns JSON results with warnings.`,
  schema: ScoreToolInputSchema,
  func: async (input) => {
    logToFile('brs-mds-tool', 'start', { tickers: input.tickers.length });
    const results: Array<{
      ticker: string;
      brs?: BrsResult;
      mds?: MdsSeriesResult;
      warnings: string[];
    }> = [];
    const errors: Array<{ ticker: string; error: string }> = [];
    const defaults = input.defaults && typeof input.defaults === 'object' ? (input.defaults as Record<string, unknown>) : {};
    const brsConfig = (input.config && typeof input.config === 'object'
      ? (input.config as Record<string, unknown>).brs
      : undefined) as Partial<BrsConfig> | undefined;
    const mdsConfig = (input.config && typeof input.config === 'object'
      ? (input.config as Record<string, unknown>).mds
      : undefined) as Partial<MdsConfig> | undefined;

    const entries = Array.isArray(input.tickers) ? input.tickers : [];
    for (const rawEntry of entries) {
      const warnings: string[] = [];
      try {
        const entry = (rawEntry && typeof rawEntry === 'object') ? (rawEntry as Record<string, unknown>) : {};
        const tickerValue = asString(entry.ticker);
        if (!tickerValue) {
          errors.push({ ticker: 'UNKNOWN', error: 'missing_ticker' });
          continue;
        }
        const companyFacts = arrayOrEmpty(entry.company_facts ?? defaults.company_facts);
        const universeMetrics = arrayOrEmpty(entry.universe_metrics ?? defaults.universe_metrics);
        const docs = mergeDocs(entry.docs as NarrativeDoc[] | undefined, defaults.docs as NarrativeDoc[] | undefined);

        const income = trimRowsByLookback(arrayOrEmpty(entry.income_statements), warnings, 'income').map((row) => ({
          ...row,
          revenue: toNumber(row.revenue),
          gross_profit: toNumber(row.gross_profit),
          ebit: toNumber(row.ebit),
          interest_expense: toNumber(row.interest_expense),
        }));
        const balance = trimRowsByLookback(arrayOrEmpty(entry.balance_sheets), warnings, 'balance').map((row) => ({
          ...row,
          total_debt: toNumber(row.total_debt),
          cash_and_equivalents: toNumber(row.cash_and_equivalents),
        }));
        const cashflow = trimRowsByLookback(arrayOrEmpty(entry.cash_flow_statements), warnings, 'cashflow').map((row) => ({
          ...row,
          depreciation_and_amortization: toNumber(row.depreciation_and_amortization),
          net_cash_flow_from_operations: toNumber(row.net_cash_flow_from_operations),
          free_cash_flow: toNumber(row.free_cash_flow),
          capital_expenditure: toNumber(row.capital_expenditure),
          dividends_and_other_cash_distributions: toNumber(row.dividends_and_other_cash_distributions),
          issuance_or_purchase_of_equity_shares: toNumber(row.issuance_or_purchase_of_equity_shares),
          share_based_compensation: toNumber(row.share_based_compensation),
        }));
        const metrics = trimRowsByLookback(arrayOrEmpty(entry.metrics_history), warnings, 'metrics').map((row) => ({
          ...row,
          enterprise_value_to_ebitda_ratio: toNumber(row.enterprise_value_to_ebitda_ratio),
          free_cash_flow_yield: toNumber(row.free_cash_flow_yield),
          return_on_invested_capital: toNumber(row.return_on_invested_capital),
          interest_coverage: toNumber(row.interest_coverage),
          gross_margin: toNumber(row.gross_margin),
          market_cap: toNumber(row.market_cap),
          enterprise_value: toNumber(row.enterprise_value),
        }));
        const estimates = entry.estimates
          ? trimRowsByLookback(arrayOrEmpty(entry.estimates), warnings, 'estimates').map((row) => ({
            ...row,
            eps_estimate: toNumber(
              row.eps_estimate
              ?? row.eps
              ?? row.estimated_eps
              ?? row.eps_mean
              ?? row.eps_avg
              ?? row.consensus_eps
            ),
            revenue_estimate: toNumber(
              row.revenue_estimate
              ?? row.revenue
              ?? row.estimated_revenue
              ?? row.revenue_mean
              ?? row.revenue_avg
              ?? row.consensus_revenue
            ),
          }))
          : undefined;
        const ownership = entry.ownership_history
          ? trimRowsByLookback(arrayOrEmpty(entry.ownership_history), warnings, 'ownership').map((row) => ({
            ...row,
            institutional_holders: toNumber(row.institutional_holders),
            institutional_shares: toNumber(row.institutional_shares),
          }))
          : undefined;
        const insider = entry.insider_trades
          ? trimTradesByLookback(arrayOrEmpty(entry.insider_trades), warnings, 'insider_trades').map((row) => ({
            ...row,
            transaction_value: toNumber(row.transaction_value),
          }))
          : undefined;
        const docsTrimmed = docs ? trimDocsByLookback(docs, warnings, 'docs') : undefined;

        const brsInput: BrsInputs = {
          ticker: tickerValue,
          company_facts: companyFacts,
          income_statements: income,
          balance_sheets: balance,
          cash_flow_statements: cashflow,
          metrics_history: metrics,
          universe_metrics: universeMetrics,
          config: brsConfig,
        };

        const mdsInput: MdsSeriesInputs = {
          ticker: tickerValue,
          asof_date: asString(entry.asof_date) ?? undefined,
          metrics_history: metrics,
          income_statements: income,
          cash_flow_statements: cashflow,
          estimates,
          ownership_history: ownership,
          insider_trades: insider,
          short_interest_pct: toNumber(entry.short_interest_pct),
          docs: docsTrimmed,
          config: mdsConfig,
        };

        const brs = computeBrs(brsInput);
        const mds = computeMdsFromSeries(mdsInput);

        results.push({
          ticker: tickerValue,
          brs,
          mds,
          warnings: [...warnings, ...brs.warnings, ...mds.warnings],
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ ticker: entry.ticker, error: errorMsg });
        logToFile('brs-mds-tool', 'error', { ticker: entry.ticker, error: errorMsg });
      }
    }

    logToFile('brs-mds-tool', 'complete', {
      tickers: results.length,
      errors: errors.length,
    });

    const payload: Record<string, unknown> = { results };
    if (errors.length > 0) {
      payload.errors = errors;
    }
    return formatToolResult(payload, []);
  },
});
