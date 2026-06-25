"""
OTE Strategy Backtest — daily bars proxy, 2015-present
Usage: python backtest.py
Requires: pip install yfinance pandas numpy tabulate
"""

from __future__ import annotations
import warnings
warnings.filterwarnings("ignore")

import yfinance as yf
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from typing import Optional
import csv
import os

# ── Config ────────────────────────────────────────────────────────────────────

SYMBOLS = [
    "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD",
    "JPM", "BAC", "XOM", "UNH", "JNJ", "V", "WMT", "HD", "PG",
    "MA", "ABBV", "MRK", "PEP", "KO", "AVGO", "CSCO", "ACN",
    "TMO", "DHR", "NEE", "LIN", "RTX", "HON", "UPS", "GS", "BLK",
    "SPGI", "CME", "ICE", "CB", "AON", "MMC",
    "SPY", "QQQ", "DIA", "IWM", "ARKK", "SOFI", "PLTR", "COIN", "HOOD", "RBLX",
]

START_DATE = "2015-01-01"
ATR_PERIOD = 14
SWING_LOOKBACK = 10
FIB_OTE_LOW = 0.62
FIB_OTE_HIGH = 0.79
FIB_ENTRY = 0.705
MIN_R = 2.0
RISK_PCT = 0.015
STARTING_EQUITY = 50_000.0
OUTPUT_CSV = "backtest_results.csv"

# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class Trade:
    symbol: str
    date: str
    side: str
    entry: float
    stop: float
    target: float
    exit_price: float
    exit_date: str
    pnl_r: float
    pnl_dollars: float
    win: bool
    sector: str

@dataclass
class SymbolResult:
    symbol: str
    sector: str
    total_trades: int
    wins: int
    losses: int
    win_rate: float
    gross_profit: float
    gross_loss: float
    profit_factor: float
    avg_r: float
    max_drawdown: float
    annual_return: float
    best_year: int
    best_year_return: float
    worst_year: int
    worst_year_return: float
    trades: list[Trade] = field(default_factory=list)

# ── Indicators ────────────────────────────────────────────────────────────────

def calc_atr(df: pd.DataFrame, period: int = ATR_PERIOD) -> pd.Series:
    high = df["High"]
    low = df["Low"]
    close = df["Close"].shift(1)
    tr = pd.concat([
        high - low,
        (high - close).abs(),
        (low - close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def get_sector(symbol: str) -> str:
    try:
        info = yf.Ticker(symbol).info
        return info.get("sector", "Unknown")
    except Exception:
        return "Unknown"

# ── Strategy simulation ───────────────────────────────────────────────────────

def run_symbol(symbol: str, df: pd.DataFrame, sector: str) -> SymbolResult:
    df = df.copy()
    df["ATR"] = calc_atr(df)
    df.dropna(subset=["ATR"], inplace=True)
    df.reset_index(inplace=True)

    trades: list[Trade] = []
    equity_curve: list[float] = [STARTING_EQUITY]
    equity = STARTING_EQUITY
    year_returns: dict[int, float] = {}
    year_start: dict[int, float] = {}

    for i in range(SWING_LOOKBACK + ATR_PERIOD, len(df) - 1):
        bar = df.iloc[i]
        next_bar = df.iloc[i + 1]

        atr = bar["ATR"]
        if pd.isna(atr) or atr == 0:
            continue

        body_size = abs(bar["Close"] - bar["Open"])
        if body_size < 1.5 * atr:
            continue

        lookback = df.iloc[max(0, i - SWING_LOOKBACK):i]
        swing_high = lookback["High"].max()
        swing_low = lookback["Low"].min()

        # Determine displacement direction
        if bar["Close"] > bar["Open"] and bar["High"] > swing_high:
            direction = "bullish"
            origin = swing_low
            terminus = bar["Close"]
        elif bar["Close"] < bar["Open"] and bar["Low"] < swing_low:
            direction = "bearish"
            origin = swing_high
            terminus = bar["Close"]
        else:
            continue

        # Daily bias: check midpoint vs current close (using previous day bar as proxy)
        if i > 0:
            prev = df.iloc[i - 1]
            midpoint = (prev["High"] + prev["Low"]) / 2
            price = bar["Close"]
            if direction == "bullish" and price < midpoint:
                continue
            if direction == "bearish" and price > midpoint:
                continue

        # OTE zone
        rng = abs(terminus - origin)
        if rng == 0:
            continue

        if direction == "bullish":
            ote_high = terminus - rng * FIB_OTE_LOW
            ote_low = terminus - rng * FIB_OTE_HIGH
            entry_price = terminus - rng * FIB_ENTRY
        else:
            ote_low = terminus + rng * FIB_OTE_LOW
            ote_high = terminus + rng * FIB_OTE_HIGH
            entry_price = terminus + rng * FIB_ENTRY

        # Check if next bar enters the OTE zone (proxy for limit fill)
        next_low = next_bar["Low"]
        next_high = next_bar["High"]

        if direction == "bullish":
            filled = next_low <= entry_price <= next_high or next_low <= ote_high
        else:
            filled = next_low <= ote_low <= next_high or ote_low <= next_high

        if not filled:
            continue

        # Stop: swing point, capped at 2×ATR
        if direction == "bullish":
            raw_stop = swing_low
            stop_dist = min(abs(entry_price - raw_stop), 2 * atr)
            stop_price = entry_price - stop_dist
            target_price = entry_price + stop_dist * MIN_R
        else:
            raw_stop = swing_high
            stop_dist = min(abs(entry_price - raw_stop), 2 * atr)
            stop_price = entry_price + stop_dist
            target_price = entry_price - stop_dist * MIN_R

        if stop_dist == 0:
            continue

        r_reward = abs(target_price - entry_price) / stop_dist
        if r_reward < MIN_R:
            continue

        # Simulate exit: scan forward up to 20 bars
        pnl_r = 0.0
        exit_price = entry_price
        exit_date = str(next_bar["Date"])
        win = False

        for j in range(i + 2, min(i + 22, len(df))):
            future = df.iloc[j]
            if direction == "bullish":
                if future["Low"] <= stop_price:
                    exit_price = stop_price
                    exit_date = str(future["Date"])
                    pnl_r = -1.0
                    break
                if future["High"] >= target_price:
                    exit_price = target_price
                    exit_date = str(future["Date"])
                    pnl_r = MIN_R
                    win = True
                    break
            else:
                if future["High"] >= stop_price:
                    exit_price = stop_price
                    exit_date = str(future["Date"])
                    pnl_r = -1.0
                    break
                if future["Low"] <= target_price:
                    exit_price = target_price
                    exit_date = str(future["Date"])
                    pnl_r = MIN_R
                    win = True
                    break
        else:
            # Timed out — exit at last bar
            last = df.iloc[min(i + 21, len(df) - 1)]
            exit_price = last["Close"]
            exit_date = str(last["Date"])
            pnl_r = (exit_price - entry_price) / stop_dist if direction == "bullish" else (entry_price - exit_price) / stop_dist
            win = pnl_r > 0

        risk_dollars = equity * RISK_PCT
        qty = risk_dollars / stop_dist if stop_dist > 0 else 0
        pnl_dollars = pnl_r * risk_dollars

        equity += pnl_dollars
        equity_curve.append(equity)

        trade_year = pd.Timestamp(str(bar["Date"])).year
        if trade_year not in year_start:
            year_start[trade_year] = equity - pnl_dollars

        trades.append(Trade(
            symbol=symbol,
            date=str(bar["Date"]),
            side=direction,
            entry=round(entry_price, 4),
            stop=round(stop_price, 4),
            target=round(target_price, 4),
            exit_price=round(exit_price, 4),
            exit_date=exit_date,
            pnl_r=round(pnl_r, 3),
            pnl_dollars=round(pnl_dollars, 2),
            win=win,
            sector=sector,
        ))

    # Year-by-year returns
    for year, start_eq in year_start.items():
        end_eq_trades = [t for t in trades if pd.Timestamp(t.date).year == year]
        if end_eq_trades:
            end_eq = start_eq + sum(t.pnl_dollars for t in end_eq_trades)
            year_returns[year] = (end_eq - start_eq) / start_eq * 100

    total = len(trades)
    wins = sum(1 for t in trades if t.win)
    losses = total - wins
    win_rate = wins / total * 100 if total > 0 else 0
    gross_profit = sum(t.pnl_dollars for t in trades if t.pnl_dollars > 0)
    gross_loss = abs(sum(t.pnl_dollars for t in trades if t.pnl_dollars < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")
    avg_r = np.mean([t.pnl_r for t in trades]) if trades else 0

    # Max drawdown
    eq_arr = np.array(equity_curve)
    peak = np.maximum.accumulate(eq_arr)
    drawdown = (eq_arr - peak) / peak * 100
    max_dd = float(drawdown.min()) if len(drawdown) > 1 else 0

    # Annual return (CAGR proxy)
    years = len(year_returns)
    final_equity = equity_curve[-1]
    annual_return = ((final_equity / STARTING_EQUITY) ** (1 / max(years, 1)) - 1) * 100 if years > 0 else 0

    best_year = max(year_returns, key=year_returns.get) if year_returns else 0  # type: ignore[arg-type]
    worst_year = min(year_returns, key=year_returns.get) if year_returns else 0  # type: ignore[arg-type]

    return SymbolResult(
        symbol=symbol,
        sector=sector,
        total_trades=total,
        wins=wins,
        losses=losses,
        win_rate=round(win_rate, 1),
        gross_profit=round(gross_profit, 2),
        gross_loss=round(gross_loss, 2),
        profit_factor=round(profit_factor, 3),
        avg_r=round(float(avg_r), 3),
        max_drawdown=round(max_dd, 2),
        annual_return=round(annual_return, 2),
        best_year=best_year,
        best_year_return=round(year_returns.get(best_year, 0), 1),
        worst_year=worst_year,
        worst_year_return=round(year_returns.get(worst_year, 0), 1),
        trades=trades,
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Downloading data for {len(SYMBOLS)} symbols from {START_DATE}...")
    all_data = yf.download(
        SYMBOLS,
        start=START_DATE,
        auto_adjust=True,
        group_by="ticker",
        progress=True,
        threads=True,
    )

    print("\nFetching sector info...")
    sectors: dict[str, str] = {}
    for sym in SYMBOLS:
        sectors[sym] = get_sector(sym)
        print(f"  {sym}: {sectors[sym]}")

    print("\nRunning backtest simulations...")
    results: list[SymbolResult] = []
    all_trades: list[Trade] = []

    for sym in SYMBOLS:
        try:
            if len(SYMBOLS) == 1:
                df = all_data.copy()
            else:
                df = all_data[sym].copy() if sym in all_data.columns.get_level_values(0) else pd.DataFrame()

            if df.empty or len(df) < 50:
                print(f"  {sym}: insufficient data, skipping")
                continue

            df.index = pd.to_datetime(df.index)
            df.reset_index(inplace=True)
            df.rename(columns={"index": "Date", "Price": "Date"}, inplace=True)

            # Ensure date column exists
            if "Date" not in df.columns:
                df["Date"] = df.index

            res = run_symbol(sym, df, sectors.get(sym, "Unknown"))
            results.append(res)
            all_trades.extend(res.trades)
            print(f"  {sym}: {res.total_trades} trades, PF={res.profit_factor}, WR={res.win_rate}%")
        except Exception as e:
            print(f"  {sym}: ERROR — {e}")

    if not results:
        print("No results generated.")
        return

    # ── Summary table ─────────────────────────────────────────────────────────
    results.sort(key=lambda r: r.profit_factor, reverse=True)

    try:
        from tabulate import tabulate
        headers = [
            "Symbol", "Sector", "Trades", "WR%", "PF", "AvgR",
            "MaxDD%", "AnnRet%", "BestYr", "WorstYr",
        ]
        rows = [
            [
                r.symbol, r.sector[:15], r.total_trades, f"{r.win_rate}%",
                f"{r.profit_factor:.2f}", f"{r.avg_r:.3f}",
                f"{r.max_drawdown:.1f}%", f"{r.annual_return:.1f}%",
                f"{r.best_year}({r.best_year_return:+.0f}%)",
                f"{r.worst_year}({r.worst_year_return:+.0f}%)",
            ]
            for r in results
        ]
        print("\n" + "═" * 90)
        print("OTE STRATEGY BACKTEST RESULTS (sorted by Profit Factor)")
        print("═" * 90)
        print(tabulate(rows, headers=headers, tablefmt="grid"))
    except ImportError:
        print("\nSymbol | Trades | WR% | PF | AvgR | MaxDD% | AnnRet%")
        for r in results:
            print(f"{r.symbol:8s} | {r.total_trades:6d} | {r.win_rate:5.1f}% | {r.profit_factor:5.2f} | {r.avg_r:6.3f} | {r.max_drawdown:6.1f}% | {r.annual_return:6.1f}%")

    # ── Sector aggregation ────────────────────────────────────────────────────
    sector_map: dict[str, list[SymbolResult]] = {}
    for r in results:
        sector_map.setdefault(r.sector, []).append(r)

    print("\n" + "═" * 60)
    print("SECTOR SUMMARY")
    print("═" * 60)
    for sector, sym_results in sorted(sector_map.items()):
        total_trades = sum(r.total_trades for r in sym_results)
        avg_pf = np.mean([r.profit_factor for r in sym_results if r.profit_factor != float("inf")])
        avg_wr = np.mean([r.win_rate for r in sym_results])
        avg_ret = np.mean([r.annual_return for r in sym_results])
        print(f"{sector[:25]:25s}: {len(sym_results)} symbols, {total_trades} trades, "
              f"avg PF={avg_pf:.2f}, avg WR={avg_wr:.1f}%, avg ann return={avg_ret:.1f}%")

    # ── Top 10 year-by-year with $50k account ────────────────────────────────
    valid_results = [r for r in results[:10] if r.total_trades > 0]
    print("\n" + "═" * 60)
    print("TOP 10 SYMBOLS — YEAR-BY-YEAR ($50,000 ACCOUNT)")
    print("═" * 60)

    year_equity: dict[int, float] = {}
    equity = STARTING_EQUITY
    years = sorted({pd.Timestamp(t.date).year for res in valid_results for t in res.trades})

    for yr in years:
        yr_trades = [t for res in valid_results for t in res.trades if pd.Timestamp(t.date).year == yr]
        yr_pnl = sum(t.pnl_dollars * (RISK_PCT / 0.015) for t in yr_trades)
        equity += yr_pnl
        year_equity[yr] = equity
        yr_ret = yr_pnl / (equity - yr_pnl) * 100 if (equity - yr_pnl) > 0 else 0
        print(f"  {yr}: {len(yr_trades):3d} trades  PnL=${yr_pnl:+10,.2f}  Equity=${equity:12,.2f}  Return={yr_ret:+.1f}%")

    # ── Save CSV ──────────────────────────────────────────────────────────────
    if all_trades:
        with open(OUTPUT_CSV, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "symbol", "date", "side", "entry", "stop", "target",
                "exit_price", "exit_date", "pnl_r", "pnl_dollars", "win", "sector",
            ])
            for t in all_trades:
                writer.writerow([
                    t.symbol, t.date, t.side, t.entry, t.stop, t.target,
                    t.exit_price, t.exit_date, t.pnl_r, t.pnl_dollars, t.win, t.sector,
                ])
        print(f"\nFull trade log saved to {OUTPUT_CSV} ({len(all_trades)} trades)")

    print("\nBacktest complete.")


if __name__ == "__main__":
    main()
