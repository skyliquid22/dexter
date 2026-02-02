export const BRS_MDS_SCORE_DESCRIPTION = `Compute BRS + MDS scores from pre-fetched payload data (no API calls).

Use when the orchestrator has already gathered all required financial metrics and statements.
Supports up to 10 tickers per call. Enforces a max 10-year lookback window (older data trimmed).
Returns JSON with per-ticker scores, as-of date, and missing-data warnings.`;
