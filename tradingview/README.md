# TradingView Master Indicator — Sweep + Volume Profile

Pine Script v6 implementation of the "Master" strategy: Volume Profile bias +
Previous-Day High/Low liquidity sweep + Break of Structure + Fair Value Gap
entry, with volume confirmation at every step.

## Files

| File | What it is |
|---|---|
| `master_indicator.pine` | The indicator: BUY/SELL labels with SL/TP levels, FVG boxes, PDH/PDL + VAH/VAL/POC lines, alerts, status panel |
| `master_strategy.pine` | Same engine wrapped in `strategy()` — open the Strategy Tester tab to backtest win rate / PnL before trusting a single signal |

## Install

1. TradingView → open a chart → Pine Editor (bottom panel)
2. Delete the starter code, paste the entire contents of `master_indicator.pine`
3. Click **Add to chart**
4. Set the chart timeframe to **5 minutes** (the engine is designed for 5m entries)
5. Repeat with `master_strategy.pine` in a second Pine Editor tab to backtest

## What you see (clean by default)

Out of the box the chart shows **only** big green **BUY** / red **SELL** tags on the
candles, plus the dashed SL/TP lines for the most recent signal. Everything else
(PDH/PDL, VAH/VAL/POC, FVG boxes, status panel) is **hidden by default** so the
chart isn't cluttered. **Hover over a BUY/SELL tag** to see the full plan
(entry, SL, TP1, TP, R:R). If you want to see the levels the strategy is using,
open the indicator settings → **Display** group and switch any of them back on.

## Alerts

Right-click the chart → **Add alert** → Condition: *Master B/S* → pick
**Master BUY**, **Master SELL**, or **Master BUY or SELL** → set
"Once per bar close" → choose app/popup/email/webhook delivery.

## The three modes

- **Master (all filters)** — full stack: price must be at/below VAL (long),
  sweep PDL, declining volume on the sweep, body-close BOS with ≥1.5× volume
  spike, bullish FVG, low-volume pullback into the FVG. Fires rarely, by design.
- **Liquidity Sweep only** — sweep + BOS + FVG + pullback + R:R ≥ 2.5.
  No volume/VP filters. Target = PDH/PDL.
- **Volume Profile only** — mean reversion: close crossing below VAL = BUY,
  above VAH = SELL. Partial at POC, full target at the opposite band.

## SL / TP on every signal

Each signal prints a compact **BUY**/**SELL** tag directly on the candle.
**Hover your mouse over the tag** to see the full trade plan (entry, SL,
TP1, TP, R:R) as a tooltip — Pine Script has no click-event API for drawn
objects, so hover is the closest thing to "click for details" it supports.

Dashed SL/TP lines are also drawn on the chart. Stops sit at the sweep
extreme (or 1.5×ATR in VP mode). In Master/VP modes TP1 = POC (take half),
TP = VAH/VAL. In Sweep mode TP = PDH/PDL.

The **"SL/TP lines"** input (Display group) controls how many sets of lines
stay on the chart:
- **Latest signal only** (default) — only the most recent long/short signal's
  lines are shown; older ones are deleted automatically so the chart stays
  readable.
- **All signals** — every signal keeps its lines (gets busy on longer history).
- **Off (hover tooltip only)** — no lines at all, just the BUY/SELL tags and
  their hover tooltips.

## Implementation notes (why it differs slightly from the videos)

- Pine scripts **cannot read** TradingView's built-in Fixed Range Volume
  Profile, so VAH/VAL/POC are computed from a rolling lookback window
  (default 400 bars) using typical-price volume binning and 70% value-area
  expansion around the POC. Expect values close to, but not identical to,
  the drawing tool.
- "Break of previous swing high" is implemented as a **body close above the
  highest high of the sweep leg** (every bar since price first broke the PDL).
  This is fast, non-repainting, and doesn't get stuck on stale pre-drop highs.
- The exhaustion filter (declining sweep volume) deliberately excludes the BOS
  candle itself — that candle is *supposed* to have a volume spike.
- PDH/PDL use confirmed previous-day values (`high[1]`/`low[1]` with
  lookahead) — no repainting.
- The signal logic was verified with a Python port of the state machine run
  against synthetic bar sequences (positive + negative cases).

## Before you trade real money

1. Run `master_strategy.pine` in the Strategy Tester across several tickers
   and at least 6–12 months of 5m data (TradingView plan permitting).
2. Paper trade the live signals for 2–4 weeks.
3. Keep risk at 0.5–1% per trade — the strategy inputs default to 1%.
4. No indicator prints money; this one just refuses to signal until every
   condition in the strategy is met. Most days it will stay silent. That is
   correct behavior.
