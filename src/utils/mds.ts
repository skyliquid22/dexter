import { classifyNarrativeShock } from './narrative-shock.js';
import type { NarrativeDoc, NarrativeShockParams, NarrativeShockResult } from './narrative-shock.js';
import {
  clamp,
  median,
  nearestByDate,
  parseReportDate,
  rollingTtmSeries,
  slope,
  sortByReportPeriod,
  stdev,
} from './series.js';
import type { CashFlowStatement, IncomeStatement, MetricsPoint } from './brs.js';
import { logToFile } from './file-logger.js';

export interface MdsInputs {
  ticker?: string;
  window_end?: string;
  docs?: NarrativeDoc[];
  narrative_params?: Partial<NarrativeShockParams>;
  multiple_compression_points: number; // 0-30
  expectation_reset_points: number; // 0-10 (analyst estimate compression)
  operating_resilience_points: number; // 0-25
  market_positioning_points: number; // 0-20 (short interest + ownership + insider bonus)
  narrative_shock_override?: 0 | 10 | 15;
}

export interface MdsResult {
  ticker?: string;
  multiple_compression_points: number;
  expectation_reset_points: number;
  narrative_shock_points: 0 | 10 | 15;
  operating_resilience_points: number;
  market_positioning_points: number;
  expectation_reset_total: number;
  total_mds_points: number;
  narrative_detail?: NarrativeShockResult;
}

export interface MdsConfig {
  history_short: number;
  history_long: number;
  history_min: number;
  ebitda_flat: number;
  ebitda_mild: number;
  ebitda_collapse: number;
  fcf_stdev_stable: number;
  fcf_stdev_volatile: number;
  ocf_stdev_stable: number;
  ocf_stdev_volatile: number;
  gm_stdev: number;
  revenue_stable: number;
  multiple_strong: number;
  multiple_mild: number;
  fcf_yield_up: number;
  eps_drop: number;
  short_elevated: number;
  short_extreme: number;
  insider_value_threshold: number;
  insider_pct_threshold: number;
  ownership_holders_drop: number;
  ownership_shares_drop: number;
}

export const DEFAULT_MDS_CONFIG: MdsConfig = {
  history_short: 12,
  history_long: 20,
  history_min: 12,
  ebitda_flat: -0.05,
  ebitda_mild: -0.20,
  ebitda_collapse: -0.30,
  fcf_stdev_stable: 0.03,
  fcf_stdev_volatile: 0.07,
  ocf_stdev_stable: 0.02,
  ocf_stdev_volatile: 0.05,
  gm_stdev: 0.02,
  revenue_stable: -0.05,
  multiple_strong: 0.30,
  multiple_mild: 0.20,
  fcf_yield_up: 0.30,
  eps_drop: -0.10,
  short_elevated: 0.10,
  short_extreme: 0.20,
  insider_value_threshold: 1_000_000,
  insider_pct_threshold: 0.0005,
  ownership_holders_drop: 0.10,
  ownership_shares_drop: 0.05,
};

export interface EstimatePoint {
  report_period: string;
  eps_estimate?: number;
  revenue_estimate?: number;
}

export interface OwnershipPoint {
  report_period: string;
  institutional_holders?: number;
  institutional_shares?: number;
}

export interface InsiderTrade {
  transaction_date: string;
  transaction_type?: 'buy' | 'sell';
  transaction_value?: number;
}

export interface MdsSeriesInputs {
  ticker?: string;
  asof_date?: string;
  metrics_history: MetricsPoint[];
  income_statements: IncomeStatement[];
  cash_flow_statements: CashFlowStatement[];
  estimates?: EstimatePoint[];
  ownership_history?: OwnershipPoint[];
  insider_trades?: InsiderTrade[];
  short_interest_pct?: number;
  docs?: NarrativeDoc[];
  narrative_params?: Partial<NarrativeShockParams>;
  fundamentals_intact?: boolean;
  config?: Partial<MdsConfig>;
}

export interface MdsSeriesResult extends MdsResult {
  subscores: {
    multiple_compression: number;
    fcf_yield_expansion: number;
    expectation_reset: number;
    narrative_shock: 0 | 10 | 15;
    operating_resilience: number;
    market_positioning: number;
    gm_defense: number;
    ocf_stability: number;
    capex_discipline: number;
    short_interest: number;
    ownership_capitulation: number;
    insider_bonus: number;
  };
  warnings: string[];
}

export function computeMds(inputs: MdsInputs): MdsResult {
  const multipleCompression = clamp(inputs.multiple_compression_points, 0, 30);
  const expectationReset = clamp(inputs.expectation_reset_points, 0, 10);
  const operatingResilience = clamp(inputs.operating_resilience_points, 0, 25);
  const marketPositioning = clamp(inputs.market_positioning_points, 0, 20);

  let narrativeShockPoints: 0 | 10 | 15 = 0;
  let narrativeDetail: NarrativeShockResult | undefined;

  if (inputs.narrative_shock_override !== undefined) {
    narrativeShockPoints = inputs.narrative_shock_override;
  } else if (inputs.docs && inputs.docs.length > 0) {
    narrativeDetail = classifyNarrativeShock(inputs.docs, {
      ticker: inputs.ticker,
      window_end: inputs.window_end,
      ...(inputs.narrative_params ?? {}),
    });
    narrativeShockPoints = narrativeDetail.mds_narrative_shock_points;
  }

  const expectationResetTotal = expectationReset + narrativeShockPoints;
  const total = clamp(
    multipleCompression + expectationResetTotal + operatingResilience + marketPositioning,
    0,
    100
  );

  return {
    ticker: inputs.ticker,
    multiple_compression_points: multipleCompression,
    expectation_reset_points: expectationReset,
    narrative_shock_points: narrativeShockPoints,
    operating_resilience_points: operatingResilience,
    market_positioning_points: marketPositioning,
    expectation_reset_total: expectationResetTotal,
    total_mds_points: total,
    narrative_detail: narrativeDetail,
  };
}

function resolveAsofDate(
  income: IncomeStatement[],
  cashflow: CashFlowStatement[],
  warnings: string[]
): Date | null {
  const incomeDates = new Set(income.map((r) => r.report_period));
  const cashDates = new Set(cashflow.map((r) => r.report_period));
  const candidates = [...incomeDates].filter((d) => cashDates.has(d));
  if (candidates.length > 0) {
    const sorted = candidates
      .map((d) => ({ d, date: parseReportDate(d) }))
      .filter((entry) => entry.date)
      .sort((a, b) => a.date!.getTime() - b.date!.getTime());
    return sorted[sorted.length - 1].date || null;
  }
  warnings.push('asof_misalignment');
  const incomeLatest = income.length > 0 ? sortByReportPeriod(income).slice(-1)[0] : null;
  const cashLatest = cashflow.length > 0 ? sortByReportPeriod(cashflow).slice(-1)[0] : null;
  const candidatesFallback = [incomeLatest, cashLatest]
    .filter((row): row is { report_period: string } => !!row)
    .map((row) => parseReportDate(row.report_period))
    .filter((date): date is Date => !!date);
  if (candidatesFallback.length === 0) return null;
  candidatesFallback.sort((a, b) => a.getTime() - b.getTime());
  return candidatesFallback[candidatesFallback.length - 1];
}

function buildEbitdaSeries(
  income: IncomeStatement[],
  cashflow: CashFlowStatement[]
): Array<{ report_period: string; value: number }> {
  const ebitTtm = rollingTtmSeries(income, (r) => r.ebit ?? null);
  const dAndATtm = rollingTtmSeries(cashflow, (r) => r.depreciation_and_amortization ?? null);
  return ebitTtm
    .map((row) => {
      const dAndA = dAndATtm.find((item) => item.report_period === row.report_period)?.value ?? null;
      if (dAndA === null) return null;
      return { report_period: row.report_period, value: row.value + dAndA };
    })
    .filter((v): v is { report_period: string; value: number } => v !== null);
}

function buildTtmSeries(
  rows: Array<{ report_period: string }>,
  getter: (row: { report_period: string } & Record<string, unknown>) => number | null | undefined
): Array<{ report_period: string; value: number }> {
  return rollingTtmSeries(rows, getter as (row: { report_period: string }) => number | null | undefined);
}

function buildRevenueSeries(income: IncomeStatement[]): Array<{ report_period: string; value: number }> {
  return buildTtmSeries(income, (r) => (r as IncomeStatement).revenue ?? null);
}

function computeYoYGrowth(series: Array<{ report_period: string; value: number }>): number[] {
  const sorted = sortByReportPeriod(series);
  const growths: number[] = [];
  for (let i = 4; i < sorted.length; i += 1) {
    const current = sorted[i].value;
    const prev = sorted[i - 4].value;
    if (prev === 0) continue;
    growths.push(current / prev - 1);
  }
  return growths;
}

function classifyEbitdaTrend(
  series: Array<{ report_period: string; value: number }>,
  config: MdsConfig
): 'flat' | 'mild' | 'collapse' | 'unknown' {
  const growths = computeYoYGrowth(series);
  if (growths.length === 0) return 'unknown';
  const medianGrowth = median(growths);
  if (medianGrowth === null) return 'unknown';
  let hasSevere = false;
  for (let i = 1; i < growths.length; i += 1) {
    if (growths[i] < config.ebitda_collapse && growths[i - 1] < config.ebitda_collapse) {
      hasSevere = true;
      break;
    }
  }
  if (medianGrowth < config.ebitda_mild || hasSevere) return 'collapse';
  if (medianGrowth < config.ebitda_flat) return 'mild';
  return 'flat';
}

function classifyFcfStability(
  fcfSeries: Array<{ report_period: string; value: number }>,
  revenueSeries: Array<{ report_period: string; value: number }>,
  config: MdsConfig
): 'stable' | 'volatile' | 'collapse' | 'unknown' {
  const ratios = fcfSeries
    .map((row) => {
      const revenue = revenueSeries.find((r) => r.report_period === row.report_period)?.value ?? null;
      if (revenue === null || revenue === 0) return null;
      return row.value / revenue;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));

  if (ratios.length < 4) return 'unknown';
  const last8 = ratios.slice(-8);
  const positiveCount = last8.filter((v) => v > 0).length;
  const ratioStdev = stdev(last8);
  const lastTwo = last8.slice(-2);
  const collapsing = positiveCount <= 3
    || (lastTwo.length === 2 && lastTwo[0] < 0 && lastTwo[1] < lastTwo[0]);

  if (collapsing) return 'collapse';
  if (positiveCount >= 6 && ratioStdev !== null && ratioStdev <= config.fcf_stdev_stable) return 'stable';
  if (positiveCount >= 4 || (ratioStdev !== null && ratioStdev <= config.fcf_stdev_volatile)) return 'volatile';
  return 'collapse';
}

function classifyOcfStability(
  ocfSeries: Array<{ report_period: string; value: number }>,
  revenueSeries: Array<{ report_period: string; value: number }>,
  config: MdsConfig
): 'stable' | 'volatile' | 'deteriorating' | 'unknown' {
  const ratios = ocfSeries
    .map((row) => {
      const revenue = revenueSeries.find((r) => r.report_period === row.report_period)?.value ?? null;
      if (revenue === null || revenue === 0) return null;
      return row.value / revenue;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));

  if (ratios.length < 4) return 'unknown';
  const last8 = ratios.slice(-8);
  const positiveCount = last8.filter((v) => v > 0).length;
  const ratioStdev = stdev(last8);
  if (positiveCount >= 7 && ratioStdev !== null && ratioStdev <= config.ocf_stdev_stable) return 'stable';
  if (positiveCount >= 5 || (ratioStdev !== null && ratioStdev <= config.ocf_stdev_volatile)) return 'volatile';
  return 'deteriorating';
}

function classifyGrossMargin(
  income: IncomeStatement[],
  config: MdsConfig
): { status: 'stable' | 'slight' | 'collapse' | 'unknown'; series: number[] } {
  const sorted = sortByReportPeriod(income);
  const series = sorted
    .map((row) => {
      if (!row.revenue || !row.gross_profit) return null;
      return row.gross_profit / row.revenue;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (series.length < 4) return { status: 'unknown', series };
  const last8 = series.slice(-8);
  const gmSlope = slope(last8);
  const gmStdev = stdev(last8);
  if (gmSlope === null || gmStdev === null) return { status: 'unknown', series };
  if (gmStdev > config.gm_stdev) return { status: 'collapse', series };
  if (gmSlope < 0) return { status: 'slight', series };
  return { status: 'stable', series };
}

function computeHistoryScore(
  currentValue: number | null,
  history: Array<{ report_period: string; value: number }>,
  windowSize: number,
  scoreFn: (current: number, medianValue: number, available: number) => number
): { score: number; available: number } {
  if (currentValue === null) return { score: 0, available: 0 };
  const sorted = sortByReportPeriod(history);
  const window = sorted.slice(-windowSize);
  const values = window.map((row) => row.value).filter((v) => Number.isFinite(v));
  if (values.length === 0) return { score: 0, available: 0 };
  const med = median(values);
  if (med === null) return { score: 0, available: values.length };
  return { score: scoreFn(currentValue, med, values.length), available: values.length };
}

function applyCoverage(
  score: number,
  available: number,
  config: MdsConfig,
  warnings: string[],
  tag: string
): number {
  if (available >= config.history_min) return score;
  if (available === 0) {
    warnings.push(`missing_history_${tag}`);
    return 0;
  }
  warnings.push(`short_history_${tag}`);
  const ratio = available / config.history_min;
  return Number((score * ratio).toFixed(2));
}

export function computeMdsFromSeries(inputs: MdsSeriesInputs): MdsSeriesResult {
  const warnings: string[] = [];
  const config: MdsConfig = { ...DEFAULT_MDS_CONFIG, ...(inputs.config ?? {}) };
  const asofDate = inputs.asof_date
    ? parseReportDate(inputs.asof_date)
    : resolveAsofDate(inputs.income_statements, inputs.cash_flow_statements, warnings);

  if (!asofDate) warnings.push('missing_asof_date');

  const metricsAsOf = asofDate
    ? nearestByDate(inputs.metrics_history, asofDate, 5)
    : null;

  const ebitdaSeries = buildEbitdaSeries(inputs.income_statements, inputs.cash_flow_statements);
  const revenueSeries = buildRevenueSeries(inputs.income_statements);
  const ocfSeries = buildTtmSeries(inputs.cash_flow_statements, (r) => (r as CashFlowStatement).net_cash_flow_from_operations ?? null);
  const fcfSeries = buildTtmSeries(inputs.cash_flow_statements, (r) => (r as CashFlowStatement).free_cash_flow ?? null);
  const capexSeries = buildTtmSeries(inputs.cash_flow_statements, (r) => (r as CashFlowStatement).capital_expenditure ?? null);

  const evToEbitdaSeries = inputs.metrics_history
    .map((row) => {
      if (row.enterprise_value_to_ebitda_ratio !== undefined) {
        return { report_period: row.report_period, value: row.enterprise_value_to_ebitda_ratio };
      }
      return null;
    })
    .filter((row): row is { report_period: string; value: number } => row !== null);

  const fcfYieldSeries = inputs.metrics_history
    .map((row) => {
      if (row.free_cash_flow_yield !== undefined) {
        return { report_period: row.report_period, value: row.free_cash_flow_yield };
      }
      if (row.market_cap !== undefined) {
        const fcf = fcfSeries.find((r) => r.report_period === row.report_period)?.value ?? null;
        if (fcf === null || row.market_cap === 0) return null;
        return { report_period: row.report_period, value: fcf / row.market_cap };
      }
      return null;
    })
    .filter((row): row is { report_period: string; value: number } => row !== null);

  const latestEv = evToEbitdaSeries.slice(-1)[0]?.value ?? null;
  const latestFcfYield = fcfYieldSeries.slice(-1)[0]?.value ?? null;
  const ebitdaAsOf = ebitdaSeries.find((row) => row.report_period === metricsAsOf?.report_period)?.value ?? null;
  const fcfAsOf = fcfSeries.find((row) => row.report_period === metricsAsOf?.report_period)?.value ?? null;

  const currentEvToEbitda = metricsAsOf?.enterprise_value_to_ebitda_ratio
    ?? (metricsAsOf?.enterprise_value && ebitdaAsOf ? metricsAsOf.enterprise_value / ebitdaAsOf : null)
    ?? latestEv;

  const currentFcfYield = metricsAsOf?.free_cash_flow_yield
    ?? (metricsAsOf?.market_cap && fcfAsOf ? fcfAsOf / metricsAsOf.market_cap : null)
    ?? latestFcfYield;
  if (currentEvToEbitda === null) warnings.push('missing_ev_to_ebitda');
  if (currentFcfYield === null) warnings.push('missing_fcf_yield');

  const ebitdaTrend = classifyEbitdaTrend(ebitdaSeries, config);
  if (ebitdaTrend === 'unknown') warnings.push('missing_ebitda_history');
  const fcfStability = classifyFcfStability(fcfSeries, revenueSeries, config);
  if (fcfStability === 'unknown') warnings.push('missing_fcf_history');

  const compressionScoreFn = (current: number, med: number): number => {
    if (med <= 0 || current <= 0) return 0;
    const compression = 1 - current / med;
    if (ebitdaTrend === 'unknown') return 0;
    if (compression >= config.multiple_strong && ebitdaTrend === 'flat') return 15;
    if (compression >= config.multiple_mild && ebitdaTrend !== 'collapse') return 10;
    if (compression > 0 && ebitdaTrend === 'collapse') return 0;
    return 0;
  };

  const fcfYieldScoreFn = (current: number, med: number): number => {
    if (med === 0) return 0;
    const change = (current - med) / Math.abs(med);
    if (change < config.fcf_yield_up) return 0;
    if (fcfStability === 'unknown') return 0;
    if (fcfStability === 'stable') return 15;
    if (fcfStability === 'volatile') return 8;
    return 0;
  };

  const h3Compression = computeHistoryScore(currentEvToEbitda, evToEbitdaSeries, config.history_short, compressionScoreFn);
  const h5Compression = computeHistoryScore(currentEvToEbitda, evToEbitdaSeries, config.history_long, compressionScoreFn);
  const compressionScore = Math.min(
    applyCoverage(h3Compression.score, h3Compression.available, config, warnings, 'multiple_h3'),
    applyCoverage(h5Compression.score, h5Compression.available, config, warnings, 'multiple_h5')
  );

  const h3FcfYield = computeHistoryScore(currentFcfYield, fcfYieldSeries, config.history_short, fcfYieldScoreFn);
  const h5FcfYield = computeHistoryScore(currentFcfYield, fcfYieldSeries, config.history_long, fcfYieldScoreFn);
  const fcfYieldScore = Math.min(
    applyCoverage(h3FcfYield.score, h3FcfYield.available, config, warnings, 'fcf_yield_h3'),
    applyCoverage(h5FcfYield.score, h5FcfYield.available, config, warnings, 'fcf_yield_h5')
  );

  const multipleCompressionPoints = clamp(compressionScore + fcfYieldScore, 0, 30);

  const epsEstimates = inputs.estimates ? sortByReportPeriod(inputs.estimates) : [];
  let expectationReset = 0;
  if (epsEstimates.length >= 2) {
    const recentRow = epsEstimates.slice(-1)[0];
    const priorRow = epsEstimates[Math.max(0, epsEstimates.length - 4)];
    const recent = recentRow.eps_estimate ?? null;
    const prior = priorRow.eps_estimate ?? null;
    if (recent !== null && prior !== null && prior !== 0) {
      const epsChange = (recent - prior) / Math.abs(prior);
      if (epsChange <= config.eps_drop) {
        let revenueStable = false;
        let revenueSignalAvailable = false;
        const recentRev = recentRow.revenue_estimate ?? null;
        const priorRev = priorRow.revenue_estimate ?? null;
        if (recentRev !== null && priorRev !== null && priorRev !== 0) {
          const revChange = (recentRev - priorRev) / Math.abs(priorRev);
          revenueStable = revChange >= config.revenue_stable;
          revenueSignalAvailable = true;
        } else {
          const revenueTrend = median(computeYoYGrowth(revenueSeries));
          if (revenueTrend !== null) {
            revenueStable = revenueTrend >= config.revenue_stable;
            revenueSignalAvailable = true;
          }
        }
        if (revenueSignalAvailable) {
          expectationReset = revenueStable ? 10 : 5;
        } else {
          warnings.push('missing_revenue_signal');
        }
      }
    }
  } else {
    warnings.push('missing_eps_estimates');
  }

  let narrativeShockPoints: 0 | 10 | 15 = 0;
  let narrativeDetail: NarrativeShockResult | undefined;
  if (inputs.docs && inputs.docs.length > 0) {
    narrativeDetail = classifyNarrativeShock(inputs.docs, {
      ticker: inputs.ticker,
      window_end: inputs.asof_date,
      ...(inputs.narrative_params ?? {}),
    });
    narrativeShockPoints = narrativeDetail.mds_narrative_shock_points;
  } else {
    warnings.push('missing_narrative_corpus');
  }

  const gmStatus = classifyGrossMargin(inputs.income_statements, config);
  if (gmStatus.status === 'unknown') warnings.push('missing_gross_margin_history');
  const revenueTrend = median(computeYoYGrowth(revenueSeries));
  let gmDefense = 0;
  if (gmStatus.status === 'stable' && revenueTrend !== null && revenueTrend < config.revenue_stable) {
    gmDefense = 10;
  } else if (gmStatus.status === 'stable' || gmStatus.status === 'slight') {
    gmDefense = 5;
  }

  const ocfStability = classifyOcfStability(ocfSeries, revenueSeries, config);
  if (ocfStability === 'unknown') warnings.push('missing_ocf_history');
  const ocfScore = ocfStability === 'stable' ? 10 : ocfStability === 'volatile' ? 5 : 0;

  const capexRatios = capexSeries
    .map((row) => {
      const revenue = revenueSeries.find((r) => r.report_period === row.report_period)?.value ?? null;
      if (revenue === null || revenue === 0) return null;
      return row.value / revenue;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
  let capexScore = 0;
  if (capexRatios.length >= 4) {
    const capexSlope = slope(capexRatios.slice(-8)) ?? 0;
    if (capexSlope <= 0) {
      capexScore = 5;
    } else if (revenueTrend !== null && revenueTrend < 0) {
      capexScore = 3;
    }
  } else {
    warnings.push('missing_capex_history');
  }

  const operatingResilience = clamp(gmDefense + ocfScore + capexScore, 0, 25);

  let shortInterestScore = 0;
  if (inputs.short_interest_pct !== undefined) {
    shortInterestScore = inputs.short_interest_pct >= config.short_extreme
      ? 5
      : inputs.short_interest_pct >= config.short_elevated
        ? 10
        : 0;
  } else {
    warnings.push('missing_short_interest');
  }

  let ownershipScore = 0;
  if (inputs.ownership_history && inputs.ownership_history.length >= 3) {
    const sorted = sortByReportPeriod(inputs.ownership_history);
    const latest = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 3];
    const holdersDrop = latest.institutional_holders && prev.institutional_holders
      ? (prev.institutional_holders - latest.institutional_holders) / prev.institutional_holders
      : 0;
    const sharesDrop = latest.institutional_shares && prev.institutional_shares
      ? (prev.institutional_shares - latest.institutional_shares) / prev.institutional_shares
      : 0;
    const ocfLatest = ocfSeries.slice(-1)[0]?.value ?? null;
    const fundamentalsIntact = inputs.fundamentals_intact ?? (ocfLatest !== null && ocfLatest > 0);
    if (fundamentalsIntact && (holdersDrop >= config.ownership_holders_drop || sharesDrop >= config.ownership_shares_drop)) {
      ownershipScore = 10;
    }
  } else {
    warnings.push('missing_ownership_history');
  }

  let insiderBonus = 0;
  const marketCap = metricsAsOf?.market_cap ?? null;
  if (inputs.insider_trades && inputs.insider_trades.length > 0) {
    const cutoff = asofDate ? asofDate.getTime() - 180 * 24 * 60 * 60 * 1000 : Date.now() - 180 * 24 * 60 * 60 * 1000;
    let net = 0;
    for (const trade of inputs.insider_trades) {
      const date = parseReportDate(trade.transaction_date);
      if (!date || date.getTime() < cutoff) continue;
      if (!trade.transaction_value || !trade.transaction_type) continue;
      net += trade.transaction_type === 'buy' ? trade.transaction_value : -trade.transaction_value;
    }
    if (net > 0) {
      const pct = marketCap ? net / marketCap : 0;
      if (net >= config.insider_value_threshold || pct >= config.insider_pct_threshold) {
        insiderBonus = 5;
      }
    }
  } else {
    warnings.push('missing_insider_trades');
  }

  const marketPositioning = clamp(shortInterestScore + ownershipScore + insiderBonus, 0, 20);

  const expectationResetTotal = expectationReset + narrativeShockPoints;
  const total = clamp(
    multipleCompressionPoints + expectationResetTotal + operatingResilience + marketPositioning,
    0,
    100
  );

  const result: MdsSeriesResult = {
    ticker: inputs.ticker,
    multiple_compression_points: multipleCompressionPoints,
    expectation_reset_points: expectationReset,
    narrative_shock_points: narrativeShockPoints,
    operating_resilience_points: operatingResilience,
    market_positioning_points: marketPositioning,
    expectation_reset_total: expectationResetTotal,
    total_mds_points: total,
    narrative_detail: narrativeDetail,
    subscores: {
      multiple_compression: compressionScore,
      fcf_yield_expansion: fcfYieldScore,
      expectation_reset: expectationReset,
      narrative_shock: narrativeShockPoints,
      operating_resilience: operatingResilience,
      market_positioning: marketPositioning,
      gm_defense: gmDefense,
      ocf_stability: ocfScore,
      capex_discipline: capexScore,
      short_interest: shortInterestScore,
      ownership_capitulation: ownershipScore,
      insider_bonus: insiderBonus,
    },
    warnings,
  };
  logMdsResult(result);
  return result;
}

// Append a summary log for pipeline debugging.
export function logMdsResult(result: MdsSeriesResult): void {
  logToFile('mds', 'computed', {
    ticker: result.ticker,
    total: result.total_mds_points,
    narrative_points: result.narrative_shock_points,
    warnings: result.warnings,
  });
}
