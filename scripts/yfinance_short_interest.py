#!/usr/bin/env python3
import json
import sys
import time


def normalize_short_interest(value):
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num < 0:
        return None
    if num > 1 and num <= 100:
        return num / 100.0
    if num > 1:
        return None
    return num


def get_short_interest(info):
    for key in ("shortPercentOfFloat", "shortPercentFloat", "shortPercent"):
        if key in info and info[key] is not None:
            return info[key], key
    shares_short = info.get("sharesShort")
    float_shares = info.get("floatShares") or info.get("sharesFloat")
    if shares_short and float_shares:
        try:
            return float(shares_short) / float(float_shares), "sharesShort/floatShares"
        except (TypeError, ValueError, ZeroDivisionError):
            return None, None
    return None, None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"results": [], "errors": [{"ticker": "*", "error": "missing_tickers"}]}))
        return 1

    tickers_arg = sys.argv[1]
    tickers = [t.strip().upper() for t in tickers_arg.split(",") if t.strip()]
    if not tickers:
        print(json.dumps({"results": [], "errors": [{"ticker": "*", "error": "missing_tickers"}]}))
        return 1

    try:
        import yfinance as yf
    except Exception as exc:
        print(json.dumps({"results": [], "errors": [{"ticker": "*", "error": f"yfinance_import:{exc}"}]}))
        return 2

    results = []
    errors = []
    for ticker in tickers:
        try:
            info = yf.Ticker(ticker).info or {}
            raw_value, source_field = get_short_interest(info)
            normalized = normalize_short_interest(raw_value)
            results.append({
                "ticker": ticker,
                "short_interest_pct": normalized,
                "source_field": source_field,
            })
        except Exception as exc:
            errors.append({"ticker": ticker, "error": str(exc)})

    payload = {
        "timestamp": int(time.time()),
        "results": results,
        "errors": errors,
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
