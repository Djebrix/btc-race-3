# DONBREAK — a Donchian-breakout momentum cbBTC trading bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Djebrix/btc-race-3/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Djebrix/btc-race-3/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

DONBREAK trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on
the make.fun [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511)
competition. Simulation only — paper money, nothing traded for real.

## Strategy

A breakout-momentum bot: it rides a sustained breakout and never buys a dip.
The dev window is a flat grind with one real ramp (about $59.1k to $61.0k over
bars ~190–300) followed by 19 hours of range-bound chop, so a bot that keeps
re-entering the chop pays ~26 bps per round trip and loses. DONBREAK therefore
demands four independent confirmations before it buys:

- the close breaks above the 60-bar Donchian high by at least 15 bps,
- the 30-bar return is at least +60 bps,
- RSI(14) is at least 55,
- the close is above SMA(60).

While holding, it sells a third of the position at +150 bps over cost, half of
what remains at +300 bps, and lets the rest ride until the close falls 200 bps
below the highest close since entry (wide trailing stop), 200 bps below the
entry fill (hard stop), or below the prior 20-bar Donchian low. After a full
exit it waits 60 bars before buying again, and it never opens a position in
the last 60 bars of the window.

An ATR-scaled trailing stop was tested and rejected: ATR(14) spikes during the
ramp itself, so a stop of 12–20x ATR tightens exactly when the trend is moving
and whipsaws the bot out mid-ramp. The fixed 200 bps trailing stop sits in the
middle of a broad plateau (trail 200–250 bps, momentum 40–80 bps all give
+$21 to +$26 on the dev window), not on a knife-edge.

## Dev-window result (grade-local, `--driver process`, two runs)

- Net PnL: +$24.820554 (return +2.48%; +$24.00 at 2x fees)
- Trades: 3 (1 buy, 2 partial sells; the remainder is flattened at the close)
- Win rate: 100%, max drawdown: 1.18%, fees: $0.81
- Deterministic: two grade-local runs give the same action-log hash
  (`c5b20a4f06e4ac89f2880b176f7f36dc6f76f759b66e0ac6f7ed46fe3d758260`),
  and each run's internal regrade reproduces byte for byte

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only plus the
  vendored SDK shim). Speaks `agent-fun/bars-replay/v1`: one `hello`, then one
  batch per minute, exactly one reply per batch echoing its `seq`.
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's SDK shim.
- `LICENSE` — MIT.
