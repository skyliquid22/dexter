import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getSetting } from './config.js';
import { computeBrs, computeMdsFromSeries } from './index.js';
import type { BrsConfig, BrsInputs, BrsResult, MdsConfig, MdsSeriesInputs, MdsSeriesResult } from './index.js';
import { logToFile } from './file-logger.js';

export interface ScoreConfig {
  brs?: Partial<BrsConfig>;
  mds?: Partial<MdsConfig>;
}

export interface ScoreRequest {
  brs?: BrsInputs;
  mds?: MdsSeriesInputs;
  config?: ScoreConfig;
}

export interface ScoreResponse {
  brs?: BrsResult;
  mds?: MdsSeriesResult;
}

function mergeConfig(requestConfig?: ScoreConfig): ScoreConfig {
  const settings = getSetting<ScoreConfig>('scoring', {});
  return {
    brs: { ...(settings.brs ?? {}), ...(requestConfig?.brs ?? {}) },
    mds: { ...(settings.mds ?? {}), ...(requestConfig?.mds ?? {}) },
  };
}

export function runScoreRequest(request: ScoreRequest): ScoreResponse {
  const config = mergeConfig(request.config);
  logToFile('score-runner', 'score_request_start', {
    has_brs: !!request.brs,
    has_mds: !!request.mds,
  });
  const brs = request.brs
    ? computeBrs({ ...request.brs, config: config.brs })
    : undefined;
  const mds = request.mds
    ? computeMdsFromSeries({ ...request.mds, config: config.mds })
    : undefined;
  logToFile('score-runner', 'score_request_complete', {
    brs_total: brs?.scores.total,
    mds_total: mds?.total_mds_points,
    brs_warnings: brs?.warnings?.length ?? 0,
    mds_warnings: mds?.warnings?.length ?? 0,
  });
  return { brs, mds };
}

export function runScoreRequestFromFile(filePath: string): ScoreResponse {
  const fullPath = resolve(filePath);
  logToFile('score-runner', 'score_request_file', { file: fullPath });
  const raw = readFileSync(fullPath, 'utf-8');
  const payload = JSON.parse(raw) as ScoreRequest;
  return runScoreRequest(payload);
}

export function formatScoreResponse(response: ScoreResponse): string {
  return JSON.stringify(response, null, 2);
}
