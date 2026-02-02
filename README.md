# Dexter 🤖 (Extra Tools and Workflows)

Dexter is an autonomous financial research agent that thinks, plans, and learns as it works. It performs analysis using task planning, self-reflection, and real-time market data. Think Claude Code, but built specifically for financial research.

<img width="1098" height="659" alt="Screenshot 2026-01-21 at 5 25 10 PM" src="https://github.com/user-attachments/assets/3bcc3a7f-b68a-4f5e-8735-9d22196ff76e" />

## Table of Contents

- [👋 Overview](#-overview)
- [✅ Prerequisites](#-prerequisites)
- [💻 How to Install](#-how-to-install)
- [🚀 How to Run](#-how-to-run)
- [🧰 New Tools & Workflows](#-new-tools--workflows)
- [📊 How to Evaluate](#-how-to-evaluate)
- [🐛 How to Debug](#-how-to-debug)
- [🤝 How to Contribute](#-how-to-contribute)
- [📄 License](#-license)


## 👋 Overview

Dexter takes complex financial questions and turns them into clear, step-by-step research plans. It runs those tasks using live market data, checks its own work, and refines the results until it has a confident, data-backed answer.  

**Key Capabilities:**
- **Intelligent Task Planning**: Automatically decomposes complex queries into structured research steps
- **Autonomous Execution**: Selects and executes the right tools to gather financial data
- **Self-Validation**: Checks its own work and iterates until tasks are complete
- **Real-Time Financial Data**: Access to income statements, balance sheets, and cash flow statements
- **Safety Features**: Built-in loop detection and step limits to prevent runaway execution
- **Lower Token Cost**: Improved context handling to reduce max-token errors and overall usage cost

[![Twitter Follow](https://img.shields.io/twitter/follow/virattt?style=social)](https://twitter.com/virattt)

<img width="875" height="558" alt="Screenshot 2026-01-21 at 5 22 19 PM" src="https://github.com/user-attachments/assets/72d28363-69ea-4c74-a297-dfa60aa347f7" />


## ✅ Prerequisites

- [Bun](https://bun.com) runtime (v1.0 or higher)
- OpenAI API key (get [here](https://platform.openai.com/api-keys))
- Financial Datasets API key (get [here](https://financialdatasets.ai))
- Exa API key (get [here](https://exa.ai)) - optional, for web search

#### Installing Bun

If you don't have Bun installed, you can install it using curl:

**macOS/Linux:**
```bash
curl -fsSL https://bun.com/install | bash
```

**Windows:**
```bash
powershell -c "irm bun.sh/install.ps1|iex"
```

After installation, restart your terminal and verify Bun is installed:
```bash
bun --version
```

## 💻 How to Install

1. Clone the repository:
```bash
git clone https://github.com/virattt/dexter.git
cd dexter
```

2. Install dependencies with Bun:
```bash
bun install
```

3. Set up your environment variables:
```bash
# Copy the example environment file
cp env.example .env

# Edit .env and add your API keys (if using cloud providers)
# OPENAI_API_KEY=your-openai-api-key
# ANTHROPIC_API_KEY=your-anthropic-api-key (optional)
# GOOGLE_API_KEY=your-google-api-key (optional)
# XAI_API_KEY=your-xai-api-key (optional)
# OPENROUTER_API_KEY=your-openrouter-api-key (optional)

# (Optional) If using Ollama locally
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# Other required keys
# FINANCIAL_DATASETS_API_KEY=your-financial-datasets-api-key

# Web Search (Exa preferred, Tavily fallback)
# EXASEARCH_API_KEY=your-exa-api-key
# TAVILY_API_KEY=your-tavily-api-key
```

## 🚀 How to Run

Run Dexter in interactive mode:
```bash
bun start
```

Or with watch mode for development:
```bash
bun dev
```

## 🧰 New Tools & Workflows

Dexter now includes a richer toolset for **screening**, **narrative shock analysis**, and **BRS/MDS scoring**.

### 1) Financial Screener (universe builder)
**Tool:** `get_financial_screener`  
**What it does:** Runs metric filters (e.g., EV/EBITDA, EBITDA growth) and returns tickers only.  
**Caching:** Results cached for 12 hours.

**Example:**
```
Run get_financial_screener with filters=[{"field":"ev_ebitda_ratio","operator":"lt","value":15},{"field":"ebitda","operator":"gt","value":0},{"field":"ebitda_growth","operator":"gt","value":0.04},{"field":"earnings_per_share_diluted","operator":"gt","value":0}] limit=100 use_cache=true.
```

### 2) Narrative Shock Corpus
**Tool:** `narrative_shock_corpus`  
**What it does:** Builds a text corpus from **news + SEC filings** and runs a deterministic shock classifier.  
**Default:** `classify=true` and **writes output to disk** under `.dexter/outputs/`.

**Example:**
```
Run narrative_shock_corpus with ticker=AAPL, window_days=30, include_news=true, include_news_body=true, include_filings=true, filing_type=8-K, require_relevance=true.
```

**Output includes:**
- `docs` (normalized news/filings text)
- `classification` (shock_type, severity, structural risk, points)
- `output_path` (saved JSON)

### 3) BRS + MDS Pipeline (full scoring)
**Tool:** `brs_mds_pipeline`  
**What it does:** Pulls statements/metrics, optional estimates/ownership/insiders, narrative corpus, then computes **BRS + MDS**.  
**Limit:** up to **10 tickers per call**.  
**Outputs:** JSON results + summary ASCII table saved to `.dexter/outputs/`.

**Example (10 tickers max):**
```
Run brs_mds_pipeline with tickers=[ACN,ALL,AMGN,AMZN,AVGO,AXP,AZN,BAC,BN,BP], lookback_years=5, include_estimates=true, include_ownership=true, include_insider_trades=true, use_yfinance_short_interest=true, narrative={"window_days":30,"include_news":true,"include_news_body":true,"include_filings":true,"filing_type":"8-K","require_relevance":true}.
```

### 4) BRS + MDS from pre-fetched payload
**Tool:** `brs_mds_score`  
**What it does:** Computes BRS + MDS **without** hitting APIs (expects a pre-fetched payload).

**Example:**
```
Run brs_mds_score with tickers=[AAPL,MSFT] and payload=<pre-fetched data>.
```

### 5) Financial Metrics (model-routed)
**Tool:** `financial_metrics`  
**What it does:** A routed tool for the metrics endpoints (snapshot + history).

## 📊 How to Evaluate

Dexter includes an evaluation suite that tests the agent against a dataset of financial questions. Evals use LangSmith for tracking and an LLM-as-judge approach for scoring correctness.

**Run on all questions:**
```bash
bun run src/evals/run.ts
```

**Run on a random sample of data:**
```bash
bun run src/evals/run.ts --sample 10
```

The eval runner displays a real-time UI showing progress, current question, and running accuracy statistics. Results are logged to LangSmith for analysis.

## 🐛 How to Debug

Dexter logs all tool calls to a scratchpad file for debugging and history tracking. Each query creates a new JSONL file in `.dexter/scratchpad/`.

**Scratchpad location:**
```
.dexter/scratchpad/
├── 2026-01-30-111400_9a8f10723f79.jsonl
├── 2026-01-30-143022_a1b2c3d4e5f6.jsonl
└── ...
```

Each file contains newline-delimited JSON entries tracking:
- **init**: The original query
- **tool_result**: Each tool call with arguments, raw result, and LLM summary
- **thinking**: Agent reasoning steps

**Example scratchpad entry:**
```json
{"type":"tool_result","timestamp":"2026-01-30T11:14:05.123Z","toolName":"get_income_statements","args":{"ticker":"AAPL","period":"annual","limit":5},"result":{...},"llmSummary":"Retrieved 5 years of Apple annual income statements showing revenue growth from $274B to $394B"}
```

This makes it easy to inspect exactly what data the agent gathered and how it interpreted results.

## 🤝 How to Contribute

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

**Important**: Please keep your pull requests small and focused.  This will make it easier to review and merge.


## 📄 License

This project is licensed under the MIT License.
