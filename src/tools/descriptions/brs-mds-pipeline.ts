export const BRS_MDS_PIPELINE_DESCRIPTION = `Fetches required financial data and runs a full BRS + MDS analysis in one step.

Use when you want Dexter to orchestrate data pulls (statements, metrics, estimates, ownership, insider trades, narrative corpus) and compute scores.
If short interest is missing, it can optionally fetch via the local yfinance helper script (use_yfinance_short_interest).
Supports up to 10 tickers per call, trims lookback to 10 years, and returns JSON with per-ticker scores, as-of date, missing-data flags, plus a summary ASCII table.
Writes outputs to .dexter/outputs and returns output_path and summary_table_path.`;
