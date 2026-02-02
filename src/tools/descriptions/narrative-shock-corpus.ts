export const NARRATIVE_SHOCK_CORPUS_DESCRIPTION = `Build a narrative-shock text corpus from SEC filings and/or company news.

Use when you need source text for the deterministic narrative-shock classifier.
This tool does NOT perform screening or valuation.

Inputs:
- ticker: required
- window_days: lookback window (default 30)
- include_news / include_filings: toggle sources
- include_news_body: attempt to fetch full article text when summaries are short (direct fetch or backend endpoint)
- company_name: optional company name override for relevance filtering
- allowed_news_sources: optional allowlist for news sources (source field or URL hostname)
- require_relevance: filter news to items mentioning the ticker or company name
- filing_type: 8-K/10-Q/10-K (default 8-K)
- classify: optional, runs the deterministic classifier on the corpus (default true)

Outputs:
- docs + window metadata
- classification (if enabled)
- output_path saved under .dexter/outputs`;
