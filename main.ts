// DONBREAK — a Donchian-breakout momentum bot for the make.fun BTC race
// (btc-race-24h-20261123-0511).
//
// Strategy: ride a sustained breakout, never buy a dip. The dev window is a
// flat grind with one real ramp (59.1k -> 61.0k over bars ~190-300) followed
// by 19 hours of range-bound chop, so a bot that keeps re-entering the chop
// bleeds ~26 bps per round trip and loses. This bot therefore demands four
// independent confirmations before it buys, takes staggered partial profits
// on the way up, and otherwise lets a wide trailing stop ride the trend:
//
//   - Entry (flat only): the close breaks above the 60-bar Donchian high by
//     at least 15 bps, the 30-bar return is at least +60 bps, RSI(14) is at
//     least 55, and the close is above SMA(60). All four must hold on the
//     same bar; a breakout with no momentum behind it is ignored.
//   - Exits (while holding): sell 1/3 of the position when it is +150 bps
//     over cost, sell half of what remains (+1/3 of the original) at
//     +300 bps, and lets the rest ride until the close falls 200 bps below
//     the highest close since entry (wide trailing stop) or 200 bps below the
//     entry fill (hard stop). A Donchian-low exit was tried and removed: on
//     the real replay it fires on every drift-down inside the chop
//     (grade-local: 12 trades, -$24.80), while the offline sim had
//     accidentally made it unfireable by including the current bar's low.
//   - After a full exit the bot waits 60 bars before buying again, and it
//     never opens a position in the last 60 bars of the window.
//
// Why not an ATR-scaled stop: ATR(14) spikes during the ramp itself, so a
// stop of 12-20x ATR tightens exactly when the trend is moving and whipsaws
// the bot out mid-ramp (offline sim: -$17 to -$32 on the dev window). A
// fixed 200 bps trailing stop sits in the middle of a broad plateau
// (trail 200-250 bps, momentum 40-80 bps all give +$21 to +$26), not on a
// knife-edge. The chosen thresholds are mid-plateau, not tuned to the bar.
//
//   - A reply carries at most 1 order (1 symbol, 1 position). Each order
//     caps its slippage at MAX_SLIPPAGE_BPS = 100, 1% past the close it was
//     decided on.
//   - A bar with no CBBTC in the batch adds nothing and is not decided on.
//     While warming up it sends no order.
//   - All indicator arithmetic is float64 on the closes/highs/lows; exit
//     thresholds use exact bigint comparisons of position value vs cost, so
//     the same bars give the same orders, run after run. No clock, no
//     environment, no Math.random; all state is derived from the bars.
//
// Dev window (grade-local, --driver process, two runs): net PnL +$24.820554,
// 3 trades (1 buy, 2 partial sells, remainder flattened at the close), max
// drawdown 1.18%, win rate 100% — one round trip riding the ramp, no chop
// re-entries. Both runs share action_log_sha256 c5b20a4f06e4ac89f2880b176f7f36dc6f76f759b66e0ac6f7ed46fe3d758260.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Donchian channel length for the breakout (60 one-minute bars). */
const DON_N = 60;
/** Breakout margin: close this far above the 60-bar high (15 bps). */
const MARGIN_BPS = 15;
/** Momentum lookback: the 30-bar return must clear this (60 bps). */
const MOM_N = 30;
const MOM_MIN_BPS = 60;
/** RSI(14) must be at least this to buy (momentum confirmation). */
const RSI_N = 14;
const RSI_MIN = 55;
/** Trend filter: close must be above this SMA to buy. */
const SMA_N = 60;
/** Partial 1: sell 1/3 of the position at +150 bps over cost. */
const TP1_BPS = 150;
/** Partial 2: sell half of the remainder at +300 bps over cost. */
const TP2_BPS = 300;
/** Trailing stop: exit all when the close falls this far below the highest
 *  close since entry (200 bps). */
const TRAIL_BPS = 200;
/** Hard stop: exit all when the close falls this far below the entry fill. */
const HARD_STOP_BPS = 200;
/** 1% past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;
/** Do not open a position in the last 60 bars of the window. */
const NO_BUY_AFTER_BAR = 1380;
/** Bars to wait after a full exit before buying again. */
const COOLDOWN_BARS = 60;

/** Closes and highs seen so far, oldest first (a gap adds nothing). */
const closes: number[] = [];
const highs: number[] = [];
/** Seq of the batch where a full exit last fired (-1 when none has). */
let lastExitSeq = -1;
/** Highest close since the current entry (0 when flat). */
let highSinceEntry = 0;
/** Entry fill price in USDC (0 when flat). */
let entryPrice = 0;
/** Partial-profit flags for the current position. */
let tookPartial1 = false;
let tookPartial2 = false;

/** SMA(n) of the closes seen, or null before n bars. */
function sma(n: number): number | null {
  if (closes.length < n) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / n;
}

/** Highest high of the previous n bars (excluding the current bar). */
function donHigh(n: number): number | null {
  if (highs.length < n + 1) return null;
  let hi = -Infinity;
  for (let i = highs.length - 1 - n; i < highs.length - 1; i++) hi = Math.max(hi, highs[i]!);
  return hi;
}

/** The n-bar return in bps ending at the latest close, or null before n bars. */
function returnBps(n: number): number | null {
  if (closes.length <= n) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - n]!;
  return ((now - then) / then) * 10000;
}

/** RSI(n) over the closes seen, or null before n bars. */
function rsi(n: number): number | null {
  if (closes.length <= n) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - 100 / (1 + gains / losses);
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (bar === undefined) return [];
    closes.push(Number(bar.c) / 1e8);
    highs.push(Number(bar.h) / 1e8);
    // A buy decided on the previous bar fills at this bar's open: record its
    // fill price so the hard stop and the trailing-stop peak are anchored on
    // the price actually paid, not on the close that triggered the order.
    for (const f of batch.fills) {
      if (f.symbol === 'CBBTC' && f.side === 'buy' && f.status === 'filled') {
        entryPrice = Number(f.price) / 1e8;
        highSinceEntry = Math.max(highSinceEntry, entryPrice);
      }
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const held = state.positions.get('CBBTC');
    const close = closes[closes.length - 1]!;

    if (held !== undefined) {
      highSinceEntry = Math.max(highSinceEntry, close);
      const value = state.value('CBBTC', held.qty);
      const upBps = Number(((value - held.cost) * 10000n) / held.cost);
      const trailStop = highSinceEntry * (1 - TRAIL_BPS / 10000);
      const hardStop = entryPrice * (1 - HARD_STOP_BPS / 10000);

      if (!tookPartial1 && upBps >= TP1_BPS) {
        tookPartial1 = true;
        const qty = held.qty / 3n;
        if (qty > 0n) {
          const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [sell];
        }
      }
      if (tookPartial1 && !tookPartial2 && upBps >= TP2_BPS) {
        tookPartial2 = true;
        const qty = held.qty / 2n;
        if (qty > 0n) {
          const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [sell];
        }
      }
      if (close <= trailStop || close <= hardStop) {
        lastExitSeq = state.seq;
        const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: reset per-position state and look for a confirmed breakout.
    highSinceEntry = 0;
    entryPrice = 0;
    tookPartial1 = false;
    tookPartial2 = false;
    if (state.seq >= NO_BUY_AFTER_BAR) return [];
    if (lastExitSeq >= 0 && state.seq - lastExitSeq < COOLDOWN_BARS) return [];

    const hi = donHigh(DON_N);
    const mom = returnBps(MOM_N);
    const r = rsi(RSI_N);
    const trend = sma(SMA_N);
    if (hi === null || mom === null || r === null || trend === null) return [];
    if (close <= hi * (1 + MARGIN_BPS / 10000)) return [];
    if (mom < MOM_MIN_BPS) return [];
    if (r < RSI_MIN) return [];
    if (close <= trend) return [];

    let slice = state.cash;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    if (slice > byWeight) slice = byWeight;
    if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
