// src/services/structure.service.ts
// Detects real institutional market structure: swing points, BOS, CHOCH,
// liquidity sweeps, order blocks, and fair value gaps (FVGs).

import { IOHLCV } from '../types/chart.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwingPoint {
  index: number;
  price: number;
  time:  number;
  type:  'high' | 'low';
}

export interface StructureBreak {
  type:       'BOS' | 'CHOCH';
  direction:  'bullish' | 'bearish';
  price:      number;
  time:       number;
  brokenAt:   number; // candle index that broke the level
}

export interface OrderBlock {
  direction: 'bullish' | 'bearish';
  open:      number;
  close:     number;
  high:      number;
  low:       number;
  time:      number;
  mitigated: boolean; // price has returned into this block
}

export interface FairValueGap {
  direction: 'bullish' | 'bearish';
  top:       number;
  bottom:    number;
  time:      number;
  filled:    boolean;
}

export interface LiquiditySweep {
  direction:   'bullish' | 'bearish'; // direction of the sweep candle
  sweptLevel:  number;                // the swing high/low that was raided
  wickHigh:    number;
  wickLow:     number;
  time:        number;
  reversed:    boolean; // closed back inside the range (trap)
}

export interface MarketStructure {
  swingHighs:       SwingPoint[];
  swingLows:        SwingPoint[];
  recentBreaks:     StructureBreak[];  // last 3 structure breaks
  latestBOS:        StructureBreak | null;
  latestCHOCH:      StructureBreak | null;
  orderBlocks:      OrderBlock[];      // last 2 relevant OBs
  fairValueGaps:    FairValueGap[];    // last 3 unfilled FVGs
  liquiditySweeps:  LiquiditySweep[]; // last 2 sweeps
  trend:            'bullish' | 'bearish' | 'ranging';
  inPremium:        boolean;  // price above 50% of range = premium
  inDiscount:       boolean;  // price below 50% of range = discount
  summary:          string;   // human-readable for the Groq prompt
}

// ─── Swing point detection ─────────────────────────────────────────────────────

function detectSwingPoints(candles: IOHLCV[], lookback = 3): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows:  SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];

    let isHigh = true;
    let isLow  = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low  <= c.low)  isLow  = false;
    }

    if (isHigh) highs.push({ index: i, price: c.high, time: c.time, type: 'high' });
    if (isLow)  lows.push({ index: i, price: c.low,   time: c.time, type: 'low'  });
  }

  return { highs, lows };
}

// ─── BOS / CHOCH detection ─────────────────────────────────────────────────────
// BOS = trend continuation: price breaks the same-direction swing high/low
// CHOCH = trend reversal: price breaks the opposite-direction swing high/low

function detectStructureBreaks(
  candles: IOHLCV[],
  highs: SwingPoint[],
  lows:  SwingPoint[],
): StructureBreak[] {
  const breaks: StructureBreak[] = [];

  if (highs.length < 2 || lows.length < 2) return breaks;

  // Track whether we're in an uptrend or downtrend based on swing sequence
  let inUptrend = highs[highs.length - 1].index > lows[lows.length - 1].index;

  // Check last N candles for closes that break a significant swing
  const checkFrom = Math.max(0, candles.length - 30);

  for (let i = checkFrom + 1; i < candles.length; i++) {
    const c = candles[i];

    // Check if this candle breaks above a recent swing high
    const prevHighs = highs.filter((h) => h.index < i);
    const prevLows  = lows.filter((l)  => l.index < i);

    if (prevHighs.length === 0 || prevLows.length === 0) continue;

    const lastSwingHigh = prevHighs[prevHighs.length - 1];
    const lastSwingLow  = prevLows[prevLows.length - 1];

    // Bullish break: close above the last swing high
    if (c.close > lastSwingHigh.price) {
      const type: 'BOS' | 'CHOCH' = inUptrend ? 'BOS' : 'CHOCH';
      breaks.push({
        type,
        direction: 'bullish',
        price:     lastSwingHigh.price,
        time:      lastSwingHigh.time,
        brokenAt:  i,
      });
      inUptrend = true;
    }

    // Bearish break: close below the last swing low
    if (c.close < lastSwingLow.price) {
      const type: 'BOS' | 'CHOCH' = !inUptrend ? 'BOS' : 'CHOCH';
      breaks.push({
        type,
        direction: 'bearish',
        price:     lastSwingLow.price,
        time:      lastSwingLow.time,
        brokenAt:  i,
      });
      inUptrend = false;
    }
  }

  // Deduplicate — keep only one break per candle index
  const seen = new Set<number>();
  return breaks.filter((b) => {
    if (seen.has(b.brokenAt)) return false;
    seen.add(b.brokenAt);
    return true;
  });
}

// ─── Order block detection ─────────────────────────────────────────────────────
// A bullish OB = last bearish candle before a displacement move upward (BOS bullish)
// A bearish OB = last bullish candle before a displacement move downward (BOS bearish)

function detectOrderBlocks(
  candles: IOHLCV[],
  breaks: StructureBreak[],
): OrderBlock[] {
  const blocks: OrderBlock[] = [];

  for (const brk of breaks) {
    // Look back from the break candle to find the last opposing candle
    const lookStart = Math.max(0, brk.brokenAt - 10);

    if (brk.direction === 'bullish') {
      // Find the last bearish candle before the bullish BOS/CHOCH
      for (let i = brk.brokenAt - 1; i >= lookStart; i--) {
        const c = candles[i];
        if (c.close < c.open) { // bearish candle
          blocks.push({
            direction: 'bullish',
            open:      c.open,
            close:     c.close,
            high:      c.high,
            low:       c.low,
            time:      c.time,
            mitigated: false,
          });
          break;
        }
      }
    } else {
      // Find the last bullish candle before the bearish BOS/CHOCH
      for (let i = brk.brokenAt - 1; i >= lookStart; i--) {
        const c = candles[i];
        if (c.close > c.open) { // bullish candle
          blocks.push({
            direction: 'bearish',
            open:      c.open,
            close:     c.close,
            high:      c.high,
            low:       c.low,
            time:      c.time,
            mitigated: false,
          });
          break;
        }
      }
    }
  }

  // Mark as mitigated if price has returned into the block
  const last = candles[candles.length - 1];
  for (const ob of blocks) {
    const obTop    = Math.max(ob.open, ob.close);
    const obBottom = Math.min(ob.open, ob.close);
    if (last.low <= obTop && last.high >= obBottom) {
      ob.mitigated = true;
    }
  }

  // Return most recent 2 unmitigated blocks (most relevant to current price)
  return blocks
    .filter((b) => !b.mitigated)
    .slice(-2);
}

// ─── Fair Value Gap detection ──────────────────────────────────────────────────
// A 3-candle FVG: candle[i-2].high < candle[i].low  (bullish imbalance)
//                  candle[i-2].low  > candle[i].high (bearish imbalance)

function detectFairValueGaps(candles: IOHLCV[]): FairValueGap[] {
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    // Bullish FVG: gap up — c1 high < c3 low
    if (c3.low > c1.high) {
      gaps.push({
        direction: 'bullish',
        top:       c3.low,
        bottom:    c1.high,
        time:      candles[i - 1].time, // candle in the middle owns the gap
        filled:    false,
      });
    }

    // Bearish FVG: gap down — c1 low > c3 high
    if (c3.high < c1.low) {
      gaps.push({
        direction: 'bearish',
        top:       c1.low,
        bottom:    c3.high,
        time:      candles[i - 1].time,
        filled:    false,
      });
    }
  }

  // Mark filled if price has traded through them
  const last = candles[candles.length - 1];
  for (const gap of gaps) {
    if (last.low <= gap.bottom || last.high >= gap.top) {
      gap.filled = true;
    }
  }

  return gaps
    .filter((g) => !g.filled)
    .slice(-3);
}

// ─── Liquidity sweep detection ─────────────────────────────────────────────────
// A sweep = wick pierces a swing high/low but candle closes back inside the range
// Classic "stop hunt" that often precedes a reversal

function detectLiquiditySweeps(
  candles: IOHLCV[],
  highs: SwingPoint[],
  lows:  SwingPoint[],
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  const checkFrom = Math.max(0, candles.length - 20);

  for (let i = checkFrom + 1; i < candles.length; i++) {
    const c = candles[i];

    // Check for sweep of a recent swing high
    const prevHighs = highs.filter((h) => h.index < i);
    if (prevHighs.length > 0) {
      const lastH = prevHighs[prevHighs.length - 1];
      // Wick went above but closed back below
      if (c.high > lastH.price && c.close < lastH.price) {
        sweeps.push({
          direction:  'bearish',
          sweptLevel: lastH.price,
          wickHigh:   c.high,
          wickLow:    c.low,
          time:       c.time,
          reversed:   true,
        });
      }
    }

    // Check for sweep of a recent swing low
    const prevLows = lows.filter((l) => l.index < i);
    if (prevLows.length > 0) {
      const lastL = prevLows[prevLows.length - 1];
      // Wick went below but closed back above
      if (c.low < lastL.price && c.close > lastL.price) {
        sweeps.push({
          direction:  'bullish',
          sweptLevel: lastL.price,
          wickHigh:   c.high,
          wickLow:    c.low,
          time:       c.time,
          reversed:   true,
        });
      }
    }
  }

  return sweeps.slice(-2);
}

// ─── Overall trend from structure ─────────────────────────────────────────────

function determineTrend(
  highs: SwingPoint[],
  lows:  SwingPoint[],
  breaks: StructureBreak[],
): 'bullish' | 'bearish' | 'ranging' {
  if (breaks.length === 0) return 'ranging';

  // Use the last 3 breaks to determine trend
  const recent = breaks.slice(-3);
  const bullish = recent.filter((b) => b.direction === 'bullish').length;
  const bearish = recent.filter((b) => b.direction === 'bearish').length;

  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';

  // Tiebreak: are we making higher highs and higher lows?
  if (highs.length >= 2 && lows.length >= 2) {
    const risingHighs = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const risingLows  = lows[lows.length - 1].price  > lows[lows.length - 2].price;
    if (risingHighs && risingLows) return 'bullish';
    if (!risingHighs && !risingLows) return 'bearish';
  }

  return 'ranging';
}

// ─── Premium / Discount zones ──────────────────────────────────────────────────

function getPremiumDiscount(
  candles: IOHLCV[],
): { inPremium: boolean; inDiscount: boolean } {
  const lookback = candles.slice(-50);
  const rangeHigh = Math.max(...lookback.map((c) => c.high));
  const rangeLow  = Math.min(...lookback.map((c) => c.low));
  const equilibrium = (rangeHigh + rangeLow) / 2;
  const current = candles[candles.length - 1].close;

  return {
    inPremium:  current > equilibrium,
    inDiscount: current < equilibrium,
  };
}

// ─── Human-readable summary ───────────────────────────────────────────────────

function buildSummary(ms: Omit<MarketStructure, 'summary'>): string {
  const lines: string[] = [];

  lines.push(`Structure Trend: ${ms.trend.toUpperCase()}`);
  lines.push(`Price Zone: ${ms.inPremium ? 'PREMIUM (above equilibrium — favour SELL entries)' : ms.inDiscount ? 'DISCOUNT (below equilibrium — favour BUY entries)' : 'EQUILIBRIUM'}`);

  if (ms.latestCHOCH) {
    lines.push(`⚠ CHOCH detected: ${ms.latestCHOCH.direction.toUpperCase()} reversal signal @ ${ms.latestCHOCH.price.toFixed(5)}`);
  }
  if (ms.latestBOS) {
    lines.push(`BOS: ${ms.latestBOS.direction.toUpperCase()} continuation @ ${ms.latestBOS.price.toFixed(5)}`);
  }

  if (ms.liquiditySweeps.length > 0) {
    const s = ms.liquiditySweeps[ms.liquiditySweeps.length - 1];
    lines.push(`Liquidity Sweep: ${s.direction.toUpperCase()} (swept ${s.sweptLevel.toFixed(5)}, wick ${s.wickLow.toFixed(5)}–${s.wickHigh.toFixed(5)}) — potential reversal zone`);
  }

  if (ms.orderBlocks.length > 0) {
    for (const ob of ms.orderBlocks) {
      lines.push(`${ob.direction.toUpperCase()} Order Block: ${ob.low.toFixed(5)}–${ob.high.toFixed(5)} (OB zone, expect reaction)`);
    }
  }

  if (ms.fairValueGaps.length > 0) {
    for (const gap of ms.fairValueGaps) {
      lines.push(`${gap.direction.toUpperCase()} FVG (imbalance): ${gap.bottom.toFixed(5)}–${gap.top.toFixed(5)}`);
    }
  }

  return lines.join('\n');
}

// ─── Main export ───────────────────────────────────────────────────────────────

export function analyzeMarketStructure(candles: IOHLCV[], lookback = 3): MarketStructure {
  if (candles.length < 20) {
    return {
      swingHighs:      [],
      swingLows:       [],
      recentBreaks:    [],
      latestBOS:       null,
      latestCHOCH:     null,
      orderBlocks:     [],
      fairValueGaps:   [],
      liquiditySweeps: [],
      trend:           'ranging',
      inPremium:       false,
      inDiscount:      false,
      summary:         'Insufficient candles for structure analysis',
    };
  }

  const { highs, lows } = detectSwingPoints(candles, lookback);
  const breaks           = detectStructureBreaks(candles, highs, lows);
  const recentBreaks     = breaks.slice(-3);
  const latestBOS        = [...breaks].reverse().find((b) => b.type === 'BOS') ?? null;
  const latestCHOCH      = [...breaks].reverse().find((b) => b.type === 'CHOCH') ?? null;
  const orderBlocks      = detectOrderBlocks(candles, recentBreaks);
  const fairValueGaps    = detectFairValueGaps(candles);
  const liquiditySweeps  = detectLiquiditySweeps(candles, highs, lows);
  const trend            = determineTrend(highs, lows, breaks);
  const { inPremium, inDiscount } = getPremiumDiscount(candles);

  const partial = {
    swingHighs:      highs.slice(-5),
    swingLows:       lows.slice(-5),
    recentBreaks,
    latestBOS,
    latestCHOCH,
    orderBlocks,
    fairValueGaps,
    liquiditySweeps,
    trend,
    inPremium,
    inDiscount,
  };

  return { ...partial, summary: buildSummary(partial) };
}
