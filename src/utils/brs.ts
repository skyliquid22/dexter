import {
  clamp,
  median,
  nearestByDate,
  parseReportDate,
  percentile,
  percentileRank,
  rollingTtmSeries,
  slope,
  sortByReportPeriod,
  stdev,
  sum,
} from './series.js';
import { logToFile } from './file-logger.js';

export interface CompanyFacts {
  ticker: string;
  sector?: string;
  industry?: string;
}

export interface IncomeStatement {
  report_period: string;
  revenue?: number;
  gross_profit?: number;
  ebit?: number;
  interest_expense?: number;
}

export interface BalanceSheet {
  report_period: string;
  total_debt?: number;
  cash_and_equivalents?: number;
}

export interface CashFlowStatement {
  report_period: string;
  depreciation_and_amortization?: number;
  net_cash_flow_from_operations?: number;
  free_cash_flow?: number;
  capital_expenditure?: number;
  dividends_and_other_cash_distributions?: number;
  issuance_or_purchase_of_equity_shares?: number;
  share_based_compensation?: number;
}

export interface MetricsPoint {
  report_period: string;
  enterprise_value_to_ebitda_ratio?: number;
  free_cash_flow_yield?: number;
  return_on_invested_capital?: number;
  interest_coverage?: number;
  gross_margin?: number;
  market_cap?: number;
  enterprise_value?: number;
}

export interface UniverseMetric {
  ticker: string;
  sector?: string;
  industry?: string;
  ev_to_ebitda?: number | null;
  roic_series?: Array<{ report_period: string; value: number }>;
}

export interface BrsConfig {
  min_peers: number;
  gm_stdev_threshold: number;
  low_history_gm_multiplier: number;
  winsor_low: number;
  winsor_high: number;
  median_bands: {
    cheap: number;
    mid: number;
    rich: number;
  };
}

export const DEFAULT_BRS_CONFIG: BrsConfig = {
  min_peers: 15,
  gm_stdev_threshold: 0.02,
  low_history_gm_multiplier: 0.5,
  winsor_low: 0.05,
  winsor_high: 0.95,
  median_bands: {
    cheap: 0.7,
    mid: 1.0,
    rich: 1.3,
  },
};

export interface BrsInputs {
  ticker: string;
  company_facts: CompanyFacts[];
  income_statements: IncomeStatement[];
  balance_sheets: BalanceSheet[];
  cash_flow_statements: CashFlowStatement[];
  metrics_history: MetricsPoint[];
  universe_metrics: UniverseMetric[];
  config?: Partial<BrsConfig>;
}

export interface BrsResult {
  ticker: string;
  asof_date: string | null;
  scores: {
    valuation_sanity: number;
    cash_truth_quality: number;
    capital_efficiency: number;
    balance_sheet_risk: number;
    durability_alignment: number;
    total: number;
  };
  subscores: {
    ev_to_ebitda: number;
    fcf_yield: number;
    cash_conversion: number;
    fcf_conversion: number;
    roic_vs_wacc: number;
    incremental_roic: number;
    net_debt_to_ebitda: number;
    interest_coverage: number;
    gross_margin_stability: number;
    shareholder_yield: number;
    sbc_to_fcf: number;
  };
  warnings: string[];
}

function latestReportDate(rows: Array<{ report_period: string }>): Date | null {
  const sorted = sortByReportPeriod(rows);
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  return parseReportDate(last.report_period);
}

function resolveAsofDate(
  income: IncomeStatement[],
  balance: BalanceSheet[],
  cashflow: CashFlowStatement[],
  warnings: string[]
): Date | null {
  const incomeDates = new Set(income.map((r) => r.report_period));
  const balanceDates = new Set(balance.map((r) => r.report_period));
  const cashDates = new Set(cashflow.map((r) => r.report_period));
  const candidates = [...incomeDates].filter((d) => balanceDates.has(d) && cashDates.has(d));
  if (candidates.length > 0) {
    const sorted = candidates
      .map((d) => ({ d, date: parseReportDate(d) }))
      .filter((entry) => entry.date)
      .sort((a, b) => a.date!.getTime() - b.date!.getTime());
    return sorted[sorted.length - 1].date || null;
  }
  warnings.push('asof_misalignment');
  return latestReportDate(income) || latestReportDate(balance) || latestReportDate(cashflow);
}

function lastNRows<T extends { report_period: string }>(
  rows: T[],
  asofDate: Date,
  n: number
): T[] {
  const sorted = sortByReportPeriod(rows);
  const filtered = sorted.filter((row) => {
    const date = parseReportDate(row.report_period);
    return date ? date <= asofDate : false;
  });
  return filtered.slice(-n);
}

function sumTtm<T extends { report_period: string }>(
  rows: T[],
  asofDate: Date,
  getValue: (row: T) => number | null | undefined
): number | null {
  const slice = lastNRows(rows, asofDate, 4);
  if (slice.length < 4) return null;
  return sum(slice.map(getValue));
}

function scoreEvToEbitdaPercentile(percentileRankValue: number | null, warnings: string[]): number {
  if (percentileRankValue === null) {
    warnings.push('missing_peer_ev_to_ebitda');
    return 0;
  }
  if (percentileRankValue <= 0.3) return 15;
  if (percentileRankValue <= 0.6) return 10;
  if (percentileRankValue <= 0.8) return 5;
  return 0;
}

function scoreEvToEbitdaMedian(
  value: number | null,
  medianValue: number | null,
  medianBands: BrsConfig['median_bands'],
  warnings: string[]
): number {
  if (value === null || medianValue === null || medianValue === 0) {
    warnings.push('missing_peer_ev_to_ebitda');
    return 0;
  }
  const ratio = value / medianValue;
  if (ratio <= medianBands.cheap) return 15;
  if (ratio <= medianBands.mid) return 10;
  if (ratio <= medianBands.rich) return 5;
  return 0;
}

function winsorize(values: number[], pLow: number, pHigh: number): number[] {
  const low = percentile(values, pLow);
  const high = percentile(values, pHigh);
  if (low === null || high === null) return values;
  return values.map((v) => Math.min(high, Math.max(low, v)));
}

function scoreFcfYield(value: number | null): number {
  if (value === null) return 0;
  if (value > 0.10) return 10;
  if (value >= 0.06) return 7;
  if (value >= 0.03) return 4;
  return 0;
}

function scoreCashConversion(value: number | null): number {
  if (value === null) return 0;
  if (value > 0.90) return 10;
  if (value >= 0.70) return 7;
  if (value >= 0.50) return 3;
  return 0;
}

function scoreFcfConversion(value: number | null): number {
  if (value === null) return 0;
  if (value > 0.60) return 10;
  if (value >= 0.40) return 6;
  if (value >= 0.20) return 3;
  return 0;
}

function normalizeRoicSeries(series: Array<{ report_period: string; value: number }>): number[] {
  const sorted = sortByReportPeriod(series);
  return sorted.slice(-8).map((row) => row.value);
}

function scoreIncrementalRoic(
  roicSeries: Array<{ report_period: string; value: number }> | null,
  ebitdaSeries: Array<{ report_period: string; value: number }> | null,
  warnings: string[]
): number {
  const growthFromSeries = (
    series: Array<{ report_period: string; value: number }>
  ): number | null => {
    const sorted = sortByReportPeriod(series);
    const growths: number[] = [];
    for (let i = 4; i < sorted.length; i += 1) {
      const current = sorted[i].value;
      const prev = sorted[i - 4].value;
      if (prev === 0) continue;
      growths.push(current / prev - 1);
    }
    return median(growths);
  };

  let growth = roicSeries ? growthFromSeries(roicSeries) : null;
  if (growth === null && ebitdaSeries) {
    growth = growthFromSeries(ebitdaSeries);
    if (growth !== null) warnings.push('incremental_roic_proxy_ebitda');
  }
  if (growth === null) {
    warnings.push('missing_incremental_roic');
    return 0;
  }
  if (growth > 0.15) return 10;
  if (growth >= 0.08) return 6;
  return 0;
}

function scoreGrossMarginStability(
  gmSeries: number[],
  config: BrsConfig,
  warnings: string[]
): number {
  if (gmSeries.length < 4) {
    warnings.push('missing_gross_margin_history');
    return 0;
  }
  const seriesToUse = gmSeries.slice(-8);
  const gmSlope = slope(seriesToUse);
  const gmStdev = stdev(seriesToUse);
  if (gmSlope === null || gmStdev === null) {
    warnings.push('missing_gross_margin_history');
    return 0;
  }
  const isStable = gmSlope >= 0 && gmStdev <= config.gm_stdev_threshold;
  let score = isStable ? 5 : 0;
  if (gmSeries.length < 8) {
    warnings.push('low_gross_margin_history');
    score = Math.round(score * config.low_history_gm_multiplier);
  }
  return score;
}

function buildGmSeries(income: IncomeStatement[]): number[] {
  const sorted = sortByReportPeriod(income);
  return sorted
    .map((row) => {
      const revenue = row.revenue ?? null;
      const gross = row.gross_profit ?? null;
      if (!revenue || !gross) return null;
      return gross / revenue;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

function resolveCompanyFacts(ticker: string, facts: CompanyFacts[]): CompanyFacts | null {
  return facts.find((f) => f.ticker.toUpperCase() === ticker.toUpperCase()) || null;
}

function resolvePeerSet(
  ticker: string,
  facts: CompanyFacts[],
  universe: UniverseMetric[],
  minPeers: number
): { peers: UniverseMetric[]; level: 'industry' | 'sector' | 'universe' | 'median' } {
  const company = resolveCompanyFacts(ticker, facts);
  const industry = company?.industry;
  const sector = company?.sector;
  const byIndustry = industry
    ? universe.filter((u) => u.industry === industry)
    : [];
  if (byIndustry.length >= minPeers) return { peers: byIndustry, level: 'industry' };
  const bySector = sector ? universe.filter((u) => u.sector === sector) : [];
  if (bySector.length >= minPeers) return { peers: bySector, level: 'sector' };
  if (universe.length >= minPeers) return { peers: universe, level: 'universe' };
  return { peers: bySector.length > 0 ? bySector : universe, level: 'median' };
}

function medianRoicFromPeers(
  peers: UniverseMetric[],
  warnings: string[]
): number | null {
  const peerMedians = peers
    .map((peer) => {
      if (!peer.roic_series || peer.roic_series.length === 0) return null;
      return median(normalizeRoicSeries(peer.roic_series));
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const med = median(peerMedians);
  if (med === null) warnings.push('missing_wacc_proxy');
  return med;
}

export function computeBrs(inputs: BrsInputs): BrsResult {
  const warnings: string[] = [];
  const config: BrsConfig = { ...DEFAULT_BRS_CONFIG, ...(inputs.config ?? {}) };
  const asofDate = resolveAsofDate(
    inputs.income_statements,
    inputs.balance_sheets,
    inputs.cash_flow_statements,
    warnings
  );

  if (!asofDate) {
    warnings.push('missing_asof_date');
  }

  const metricsAsOf = asofDate
    ? nearestByDate(inputs.metrics_history, asofDate, 5)
    : null;

  const revenueTtm = asofDate
    ? sumTtm(inputs.income_statements, asofDate, (r) => r.revenue)
    : null;
  const grossProfitTtm = asofDate
    ? sumTtm(inputs.income_statements, asofDate, (r) => r.gross_profit)
    : null;
  const ebitTtm = asofDate
    ? sumTtm(inputs.income_statements, asofDate, (r) => r.ebit)
    : null;
  const interestExpenseTtm = asofDate
    ? sumTtm(inputs.income_statements, asofDate, (r) => r.interest_expense)
    : null;

  const dAndATtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.depreciation_and_amortization)
    : null;
  const ocfTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.net_cash_flow_from_operations)
    : null;
  const fcfTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.free_cash_flow)
    : null;
  const capexTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.capital_expenditure)
    : null;
  const dividendsTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.dividends_and_other_cash_distributions)
    : null;
  const buybacksTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.issuance_or_purchase_of_equity_shares)
    : null;
  const sbcTtm = asofDate
    ? sumTtm(inputs.cash_flow_statements, asofDate, (r) => r.share_based_compensation)
    : null;

  const ebitdaTtm = ebitTtm !== null && dAndATtm !== null ? ebitTtm + dAndATtm : null;

  const balanceAsOf = asofDate
    ? nearestByDate(inputs.balance_sheets, asofDate, 5)
    : null;

  const netDebt = balanceAsOf && balanceAsOf.total_debt !== undefined
    && balanceAsOf.cash_and_equivalents !== undefined
    ? balanceAsOf.total_debt - balanceAsOf.cash_and_equivalents
    : null;

  const marketCap = metricsAsOf?.market_cap ?? null;
  if (marketCap === null) warnings.push('missing_market_cap');

  const evToEbitda = metricsAsOf?.enterprise_value_to_ebitda_ratio
    ?? (metricsAsOf?.enterprise_value && ebitdaTtm ? metricsAsOf.enterprise_value / ebitdaTtm : null);

  const fcfYield = metricsAsOf?.free_cash_flow_yield
    ?? (fcfTtm && marketCap ? fcfTtm / marketCap : null);
  if (fcfYield === null) warnings.push('missing_fcf_yield');

  const cashConversion = ocfTtm && ebitdaTtm ? ocfTtm / ebitdaTtm : null;
  const fcfConversion = fcfTtm && ebitdaTtm ? fcfTtm / ebitdaTtm : null;
  if (cashConversion === null) warnings.push('missing_cash_conversion');
  if (fcfConversion === null) warnings.push('missing_fcf_conversion');

  const roic = metricsAsOf?.return_on_invested_capital ?? null;
  if (roic === null) warnings.push('missing_roic');

  const roicSeries = rollingTtmSeries(inputs.metrics_history, (r) => r.return_on_invested_capital ?? null)
    .map((r) => ({ report_period: r.report_period, value: r.value }));

  const peerInfo = resolvePeerSet(
    inputs.ticker,
    inputs.company_facts,
    inputs.universe_metrics,
    config.min_peers
  );
  const peerValues = peerInfo.peers
    .map((p) => p.ev_to_ebitda)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));

  const winsorizedPeers = winsorize(peerValues, config.winsor_low, config.winsor_high);
  const evPercentile = evToEbitda !== null && winsorizedPeers.length > 0
    ? percentileRank(winsorizedPeers, clamp(evToEbitda, Math.min(...winsorizedPeers), Math.max(...winsorizedPeers)))
    : null;

  let evScore = 0;
  if (peerInfo.level === 'median') {
    warnings.push('peer_set_too_small');
    evScore = scoreEvToEbitdaMedian(evToEbitda, median(peerValues), config.median_bands, warnings);
  } else {
    evScore = scoreEvToEbitdaPercentile(evPercentile, warnings);
  }

  const fcfYieldScore = scoreFcfYield(fcfYield);
  const cashConversionScore = scoreCashConversion(cashConversion);
  const fcfConversionScore = scoreFcfConversion(fcfConversion);

  const waccProxy = medianRoicFromPeers(
    peerInfo.level === 'sector'
      || peerInfo.level === 'industry'
      ? peerInfo.peers
      : inputs.universe_metrics,
    warnings
  );

  const roicVsWaccScore = roic !== null && waccProxy !== null
    ? (roic >= waccProxy + 0.05 ? 15 : roic >= waccProxy ? 10 : 0)
    : 0;

  const ebitTtmSeries = rollingTtmSeries(inputs.income_statements, (r) => r.ebit ?? null);
  const dAndATtmSeries = rollingTtmSeries(inputs.cash_flow_statements, (c) => c.depreciation_and_amortization ?? null);
  const ebitdaSeries = ebitTtmSeries
    .map((row) => {
      const dAndA = dAndATtmSeries.find((item) => item.report_period === row.report_period)?.value ?? null;
      if (dAndA === null) return null;
      return { report_period: row.report_period, value: row.value + dAndA };
    })
    .filter((v): v is { report_period: string; value: number } => v !== null);

  const incrementalRoicScore = scoreIncrementalRoic(
    roicSeries.length > 0 ? roicSeries : null,
    ebitdaSeries.length > 0 ? ebitdaSeries : null,
    warnings
  );

  const netDebtToEbitda = netDebt !== null && ebitdaTtm ? netDebt / ebitdaTtm : null;
  const netDebtScore = netDebtToEbitda === null
    ? 0
    : netDebtToEbitda < 2 ? 10 : netDebtToEbitda <= 4 ? 5 : 0;
  if (netDebtToEbitda === null) warnings.push('missing_net_debt');

  const interestCoverage = metricsAsOf?.interest_coverage
    ?? (ebitTtm && interestExpenseTtm ? ebitTtm / interestExpenseTtm : null);
  const interestCoverageScore = interestCoverage === null
    ? 0
    : interestCoverage > 8 ? 5 : interestCoverage >= 4 ? 3 : 0;
  if (interestCoverage === null) warnings.push('missing_interest_coverage');

  const gmSeries = buildGmSeries(inputs.income_statements);
  const grossMarginScore = scoreGrossMarginStability(gmSeries, config, warnings);

  let shareholderYieldScore = 0;
  if (dividendsTtm !== null && buybacksTtm !== null && marketCap) {
    const netBuybacks = -buybacksTtm;
    const shareholderYield = (dividendsTtm + netBuybacks) / marketCap;
    shareholderYieldScore = shareholderYield > 0.05 ? 5 : shareholderYield >= 0.02 ? 3 : 0;
  } else {
    warnings.push('missing_shareholder_yield');
  }

  let sbcToFcfScore = 0;
  if (sbcTtm !== null && fcfTtm && fcfTtm !== 0) {
    const sbcRatio = sbcTtm / fcfTtm;
    sbcToFcfScore = sbcRatio < 0.10 ? 5 : sbcRatio <= 0.25 ? 3 : 0;
  } else {
    warnings.push('missing_sbc_or_fcf');
  }

  const valuationSanity = evScore + fcfYieldScore;
  const cashTruthQuality = cashConversionScore + fcfConversionScore;
  const capitalEfficiency = roicVsWaccScore + incrementalRoicScore;
  const balanceSheetRisk = netDebtScore + interestCoverageScore;
  const durabilityAlignment = grossMarginScore + shareholderYieldScore + sbcToFcfScore;

  const total = valuationSanity + cashTruthQuality + capitalEfficiency + balanceSheetRisk + durabilityAlignment;

  logToFile('brs', 'computed', {
    ticker: inputs.ticker,
    asof_date: asofDate ? asofDate.toISOString().slice(0, 10) : null,
    total,
    warnings,
  });

  return {
    ticker: inputs.ticker,
    asof_date: asofDate ? asofDate.toISOString().slice(0, 10) : null,
    scores: {
      valuation_sanity: valuationSanity,
      cash_truth_quality: cashTruthQuality,
      capital_efficiency: capitalEfficiency,
      balance_sheet_risk: balanceSheetRisk,
      durability_alignment: durabilityAlignment,
      total,
    },
    subscores: {
      ev_to_ebitda: evScore,
      fcf_yield: fcfYieldScore,
      cash_conversion: cashConversionScore,
      fcf_conversion: fcfConversionScore,
      roic_vs_wacc: roicVsWaccScore,
      incremental_roic: incrementalRoicScore,
      net_debt_to_ebitda: netDebtScore,
      interest_coverage: interestCoverageScore,
      gross_margin_stability: grossMarginScore,
      shareholder_yield: shareholderYieldScore,
      sbc_to_fcf: sbcToFcfScore,
    },
    warnings,
  };
}
