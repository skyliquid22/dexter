export interface DatedValue {
  report_period: string;
}

export function parseReportDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sortByReportPeriod<T extends DatedValue>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = parseReportDate(a.report_period);
    const db = parseReportDate(b.report_period);
    if (!da || !db) return 0;
    return da.getTime() - db.getTime();
  });
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function percentileRank(values: number[], value: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) {
    if (v <= value) count += 1;
  }
  return count / sorted.length;
}

export function stdev(values: number[]): number | null {
  if (values.length === 0) return null;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function slope(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return (last - first) / (values.length - 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sum(values: Array<number | null | undefined>): number | null {
  if (values.some((v) => v === null || v === undefined || Number.isNaN(v))) {
    return null;
  }
  return (values as number[]).reduce((acc, v) => acc + v, 0);
}

export function rollingTtmSeries<T extends DatedValue>(
  rows: T[],
  getValue: (row: T) => number | null | undefined
): Array<{ report_period: string; value: number }> {
  const sorted = sortByReportPeriod(rows);
  const output: Array<{ report_period: string; value: number }> = [];
  for (let i = 3; i < sorted.length; i += 1) {
    const slice = sorted.slice(i - 3, i + 1);
    const values = slice.map(getValue);
    const total = sum(values);
    if (total === null) continue;
    output.push({ report_period: sorted[i].report_period, value: total });
  }
  return output;
}

export function nearestByDate<T extends DatedValue>(
  rows: T[],
  targetDate: Date,
  maxDaysDiff: number
): T | null {
  const sorted = sortByReportPeriod(rows);
  let best: { row: T; diff: number } | null = null;
  for (const row of sorted) {
    const date = parseReportDate(row.report_period);
    if (!date) continue;
    const diff = Math.abs(date.getTime() - targetDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diff > maxDaysDiff) continue;
    if (!best || diff < best.diff) {
      best = { row, diff };
    }
  }
  return best ? best.row : null;
}
