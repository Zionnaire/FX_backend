// Pre-loaded FOREX trading knowledge library.
// Each entry is one logical document that gets chunked and embedded independently.

export interface KnowledgeDoc {
  title: string;
  tag:   string;
  pair:  string;
  text:  string;
}

export const TRADING_KNOWLEDGE_LIBRARY: KnowledgeDoc[] = [

  // ── 01 Moving Averages ───────────────────────────────────────────────────────
  {
    title: 'Moving Averages — Full Strategy Guide',
    tag:   'ma-strategy',
    pair:  'ALL',
    text: `
MOVING AVERAGES — FULL STRATEGY GUIDE
Applicable pairs: XAU/USD, GBP/USD, EUR/USD, USD/JPY and all major pairs.

WHAT IS A MOVING AVERAGE?
A Moving Average (MA) smooths price data by calculating a continuously updated average over a specific period. Smaller period = faster reaction. Larger period = slower.

Period speed ranking (fastest to slowest): 5 > 7 > 10 > 14 > 20 > 32 > 50 > 89 > 200

TYPES:
Simple Moving Average (SMA): Equal weight to all periods. Slower and more stable.
Exponential Moving Average (EMA): More weight to recent prices. Faster. Preferred by active traders.

MA WORKS BEST IN TRENDING MARKETS. Avoid in ranging/sideways conditions — generates false signals.

THE GOLDEN CROSS — ENTRY SIGNAL:
Use 7 MA (fast) and 14 MA (slow) together.
BULLISH GOLDEN CROSS (BUY): Fast MA (7) crosses slow MA (14) from below to above. Signals upward momentum.
BEARISH GOLDEN CROSS (SELL): Fast MA (7) crosses slow MA (14) from above to below. Signals downward momentum.

TREND IDENTIFICATION WITH 89 MA AND 200 MA:
Price ABOVE 200 MA = Uptrend. Look for BUY opportunities only.
Price BELOW 200 MA = Downtrend. Look for SELL opportunities only.
200 MA acts as dynamic support/resistance.
89 MA is an early trend change warning — crossing signals trend beginning.

COMBINED STRATEGY:
Step 1: Use 89 MA + 200 MA to determine trend direction.
Step 2: If uptrend, wait for bullish golden cross on 7+14 MA to time entry.
Step 3: If downtrend, wait for bearish golden cross to time entry.
Step 4: Only trade in the direction of the major trend.

KEY MA LEVELS USED BY INSTITUTIONS:
20 EMA — swing traders short-term trend guide
50 EMA — medium-term. Price holding above = bullish bias
100 EMA — institutional level. Breaks are significant
200 EMA — long-term trend. Most watched MA in the market

MA AS DYNAMIC SUPPORT/RESISTANCE:
In an uptrend, the 20 EMA or 50 EMA often acts as support. Price pullback to MA = high-probability buy entry.

MA CONFLUENCE ZONES:
When multiple MAs cluster at the same price level (e.g., 50 MA + 89 MA), that zone becomes very strong support/resistance.

MISTAKES TO AVOID:
1. Using MA in ranging market — constant false signals
2. Using only one MA without other indicator confirmation
3. Entering immediately on cross without waiting for candle to close
4. Trading counter-trend crosses
5. Moving averages are LAGGING — they confirm trend, never predict it

SUMMARY RULES:
1. The trend is your friend. Never trade against the major trend.
2. Use 200 MA + 89 MA to identify trend direction.
3. Use 7 MA + 14 MA to time entries via golden cross.
4. Only enter in the direction confirmed by the longer MAs.
5. Wait for retracements to end before entering.
6. Never use MA alone — confirm with at least one other indicator.
`.trim(),
  },

  // ── 02 Stochastic ────────────────────────────────────────────────────────────
  {
    title: 'Stochastic Oscillator — Full Strategy Guide',
    tag:   'stochastic-strategy',
    pair:  'ALL',
    text: `
STOCHASTIC OSCILLATOR — FULL STRATEGY GUIDE
Applicable pairs: XAU/USD, GBP/USD, EUR/USD, USD/JPY and all major pairs.

WHAT IS STOCHASTIC?
Momentum indicator measuring whether market is overbought or oversold. Oscillates 0-100.
Lines: %K (green/fast) and %D (red/slow, smoothed average of %K).
Default settings: 14, 3. Leave at default for standard trading.

ZONES:
Overbought: 80-100. Buyers exhausted. Downside reversal more probable.
Oversold: 0-20. Sellers exhausted. Upside reversal more probable.
Neutral zone 20-80: Crosses here are unreliable. AVOID trading neutral zone crosses.

HOW TO ENTER TRADES:
SELL signal: Both lines enter overbought (>80). Green %K crosses red %D DOWNWARD while in overbought zone = SELL.
BUY signal: Both lines enter oversold (<20). Green %K crosses red %D UPWARD while in oversold zone = BUY.
CRITICAL: Cross MUST occur inside overbought/oversold zone. Neutral zone crosses = unreliable.

USING STOCHASTIC AS WARNING/EXIT:
In BUY trade: Lines approaching overbought = warning, start preparing to close or lock profits.
In SELL trade: Lines approaching oversold = warning, start preparing to close or lock profits.

STOCHASTIC + MOVING AVERAGES COMBINED:
Highest reliability: Stochastic cross in extreme zone + MA golden cross in same direction.
If MA says buy but Stochastic says sell: STAY OUT. Wait for alignment.

ADVANCED — STOCHASTIC DIVERGENCE (more powerful than crossover):
Bullish divergence: Price makes lower low but Stochastic makes higher low. Selling momentum weakening. Reversal upward likely.
Bearish divergence: Price makes higher high but Stochastic makes lower high. Buying momentum weakening. Reversal downward likely.

HIDDEN DIVERGENCE — TREND CONTINUATION:
Uptrend: Price makes higher low but Stochastic makes lower low. Uptrend will continue.
Downtrend: Price makes lower high but Stochastic makes higher high. Downtrend will continue.

MULTIPLE TIMEFRAME STOCHASTIC:
Check 4H Stochastic for overall momentum. Use 1H for precise entry timing.
4H in oversold + 1H upward cross in oversold = very high probability buy.

SETTINGS BY TIMEFRAME:
Scalping 1m-5m: 5, 3, 3
Intraday 15m-1h: 14, 3, 3 (default)
Swing 4h-1d: 21, 5, 5

SUMMARY RULES:
1. Buy when oversold (<20) and green crosses red upward.
2. Sell when overbought (>80) and green crosses red downward.
3. Only trade crosses inside overbought/oversold zones.
4. Crosses in neutral zone (20-80) = unreliable, avoid them.
5. Stochastic divergence is stronger than simple crossover.
6. Never use Stochastic alone. Combine with trend indicators like MA.
`.trim(),
  },

  // ── 03 Bollinger Bands ───────────────────────────────────────────────────────
  {
    title: 'Bollinger Bands — Full Strategy Guide',
    tag:   'bollinger-strategy',
    pair:  'ALL',
    text: `
BOLLINGER BANDS — FULL STRATEGY GUIDE
Applicable pairs: XAU/USD, GBP/USD, EUR/USD, USD/JPY and all major pairs.

WHAT ARE BOLLINGER BANDS?
Volatility indicator. Three bands: Upper (Mid + 2 std dev), Middle (20-period SMA), Lower (Mid - 2 std dev).
Default: Period 20, Standard Deviation 2.
Bands EXPAND in volatile markets. CONTRACT in calm markets.

FIRST RULE: NEVER TRADE A QUIET MARKET.
Contracted (narrow) bands = low volatility, minimal price movement. But: quiet market = powerful breakout IMMINENT. Watch closely — do not enter yet.
Wide (expanded) bands = volatile, active market = trade here.

STRATEGY 1 — BOLLINGER BOUNCE (RANGING MARKETS ONLY):
Use in: Ranging (sideways) markets only. NOT in trending markets.
Principle: In ranging markets, price always returns to the middle band.
SELL from upper band: Price touches upper band → bounces downward → enter SELL → TP at middle band.
BUY from lower band: Price touches lower band → bounces upward → enter BUY → TP at middle band.
Why TP at middle band? Guaranteed return to middle is more certain than full band-to-band move.
CONFIRM it's ranging before using bounce. If trending, price can walk along bands — bounce will fail.

STRATEGY 2 — BOLLINGER SQUEEZE (BREAKOUT TRADE):
What is it? Bands contract to minimum width (squeeze). Massive breakout IMMINENT.
Rule: Longer the squeeze, more powerful the eventual breakout.
Most frequent: M15 timeframe, but occurs on any timeframe.
Direction unknown until breakout. Solution: Set alerts at both bands (upper band + 10 pips, lower band - 10 pips).
Upper alert triggers → BUY. Lower alert triggers → SELL.
Why 10 pips? Confirms actual break, not just touch.
Profit target: 20 pips minimum. Breakouts usually produce 50-80 pips.

BOLLINGER BAND WALK (STRONG TREND):
In very strong trend, price walks along upper band (uptrend) or lower band (downtrend) for extended periods.
Do NOT counter-trade a band walk. It signals extreme momentum.

W-PATTERN AT LOWER BAND (strong buy):
Price touches lower band → bounces → retests lower band but second low stays INSIDE bands.
W-shape = strong reversal buy signal. Buyers stepping in.

M-PATTERN AT UPPER BAND (strong sell):
Price touches upper band → pulls back → makes second high INSIDE bands.
M-shape = strong reversal sell signal.

BOLLINGER + RSI CONFLUENCE:
Bounce buy at lower band: Confirm RSI below 40. Higher probability.
Bounce sell at upper band: Confirm RSI above 60. Higher probability.

SQUEEZE WITH DIRECTIONAL BIAS:
Middle band sloping upward before squeeze → breakout more likely upward.
Middle band sloping downward before squeeze → breakout more likely downward.

SUMMARY RULES:
1. Never trade narrow/quiet bands. Wait for volatility.
2. Ranging market: Bounce. Buy lower band → TP middle. Sell upper band → TP middle.
3. Squeeze: Set alerts both sides, trade direction of break. Target 20+ pips.
4. Longer squeeze = bigger eventual move.
5. Trending market: Do not use bounce. Price can walk along bands.
6. Confirm with RSI for higher-probability bounces.
7. Band walk = extreme momentum. Don't fade it.
`.trim(),
  },

  // ── 04 RSI ───────────────────────────────────────────────────────────────────
  {
    title: 'RSI (Relative Strength Index) — Full Strategy Guide',
    tag:   'rsi-strategy',
    pair:  'ALL',
    text: `
RSI — RELATIVE STRENGTH INDEX — FULL STRATEGY GUIDE
Applicable pairs: XAU/USD, GBP/USD, EUR/USD, USD/JPY and all major pairs.

WHAT IS RSI?
Momentum oscillator measuring speed and magnitude of price movements. Oscillates 0-100. Default period: 14.
Two purposes: (1) Identify overbought/oversold conditions. (2) Confirm trend direction.

RSI ZONES:
Overbought: 70-100. Buying pressure may be weakening. Pullback/reversal more likely. Hold off new buys. Consider closing longs.
Oversold: 0-30. Selling pressure may be weakening. Bounce/reversal more likely. Hold off new sells. Consider closing shorts.

RSI AS TREND CONFIRMATION — THE 50 LINE:
RSI crosses ABOVE 50 and moves upward → uptrend confirmed → buy bias.
RSI crosses BELOW 50 and moves downward → downtrend confirmed → sell bias.
Use RSI to confirm signals from MA/Stochastic — if RSI below 50, be cautious even if other indicators say buy.

RSI DIVERGENCE — MOST POWERFUL RSI SIGNAL:
Bullish divergence: Price makes LOWER LOW but RSI makes HIGHER LOW. Selling momentum weakening. Reversal upward likely.
Bearish divergence: Price makes HIGHER HIGH but RSI makes LOWER HIGH. Buying momentum weakening. Reversal downward likely.
Divergence is stronger than simple overbought/oversold signals because it reveals weakening momentum before reversal is obvious.

RSI FAILURE SWINGS:
Bullish failure swing: RSI drops below 30, bounces above 30, pulls back but stays above 30, then breaks above recent high = strong buy.
Bearish failure swing: RSI rises above 70, drops below 70, bounces but stays below 70, breaks below recent low = strong sell.

RSI TREND ZONES (professional interpretation):
Strong uptrend: RSI stays between 40-80 (bull zone). Pullbacks to 40 = buying opportunities.
Strong downtrend: RSI stays between 20-60 (bear zone). Bounces to 60 = selling opportunities.
RSI dropping below 40 in uptrend = possible trend reversal signal.

XAU/USD (GOLD) SPECIFIC RSI RULES:
RSI above 60 on 1H during London/NY session with bullish candles = high-probability buy continuation.
RSI below 45 at key support = excellent buy zone on dips.
London session bullish engulfing with RSI 40-55 at support = highest win rate setup for gold longs.
RSI above 70 at resistance zones pre-Fed = high probability rejection and short-term sell.

COMBINING RSI:
RSI + MA: MA gives direction, RSI confirms via 50-line. Best for trend-following entries.
RSI + Stochastic: Both oversold simultaneously = very high probability buy. Both overbought = very high probability sell.
RSI + Bollinger: Price at lower BB + RSI below 40 = strong buy. Price at upper BB + RSI above 60 = strong sell.

RSI PERIOD ADJUSTMENT:
RSI 7: Scalping (1m-5m). More signals but more false signals.
RSI 14: Default, balanced for intraday and swing.
RSI 21: Swing/position trading. Fewer but stronger signals.

SUMMARY RULES:
1. RSI above 70 = overbought. Hold off buys.
2. RSI below 30 = oversold. Hold off sells.
3. RSI above 50 confirms uptrend. Below 50 confirms downtrend.
4. RSI divergence is stronger than simple overbought/oversold.
5. In strong trends, RSI can stay extreme for long periods. Wait for actual reversal signals.
6. 50-line crossover on higher timeframes is a medium-term trend shift signal.
7. Never use RSI alone — combine with MA for trend, Stochastic for timing.
`.trim(),
  },

  // ── 05 ADX / MACD / ATR / PSAR ──────────────────────────────────────────────
  {
    title: 'ADX, MACD, ATR, Parabolic SAR — Full Strategy Guide',
    tag:   'adx-macd-atr-psar-strategy',
    pair:  'ALL',
    text: `
ADX, MACD, ATR, AND PARABOLIC SAR — FULL STRATEGY GUIDE

ADX — AVERAGE DIRECTIONAL INDEX:
Measures STRENGTH of trend, NOT direction. Oscillates 0-100.
0-20: Weak/no trend. Ranging. Avoid trend-following trades.
20-50: Moderate to strong trend. Suitable for trend entries.
50-100: Very strong trend. Hold positions with confidence.
ADX does NOT show direction — use MA or MACD for direction.

ADX DIRECTIONAL LINES (+DI and -DI):
+DI above -DI = uptrend conditions. Favour buys.
-DI above +DI = downtrend conditions. Favour sells.
+DI crosses above -DI while ADX >25 = confirmed buy signal.
-DI crosses above +DI while ADX >25 = confirmed sell signal.

XAU/USD SPECIFIC ADX: ADX above 28 on 1H for gold = intraday trend strong enough to trade. Gold with ADX <20 on 1H tends to chop — wait for ADX expansion.

ADX TURNING POINTS:
ADX peaks and declines from above 50 = strong trend weakening. Tighten stops.
ADX rises from below 20 through 20 and climbs = new trend forming. Position in emerging direction.

MACD — MOVING AVERAGE CONVERGENCE DIVERGENCE:
Trend-following momentum indicator. Default settings: 12, 26, 9. Optimised for reduced lag: 3, 5, 13.
Histogram: Bars above zero = bullish momentum. Below zero = bearish momentum.
Signal line: Crossing above zero = bullish. Below zero = bearish.

MACD SIGNALS:
Bullish: Signal line crosses above zero + histogram above zero and growing = uptrend developing. Enter/hold BUY.
Bearish: Signal line crosses below zero + histogram below zero and growing = downtrend developing. Enter/hold SELL.
Early warning: Histogram bars SHRINKING = momentum weakening. Prepare for direction change.

MACD DIVERGENCE (very reliable on 4H/Daily):
Bullish: Price makes lower low but MACD histogram makes higher low. Selling momentum dying. Reversal upward likely.
Bearish: Price makes higher high but MACD histogram makes lower high. Buying momentum dying. Reversal downward likely.

Zero-line rejection (continuation signal):
MACD pulls back toward zero but does NOT cross it = continuation. Opportunity to enter or add to trend position.

ATR — AVERAGE TRUE RANGE:
Measures AVERAGE PRICE RANGE (volatility) in pips. Default period: 14. Does NOT indicate direction.

THREE USES OF ATR:
1. Volatility filter: ATR >20 pips/hour = good. ATR <14 = low, consider waiting. ATR <8 = too quiet, do not trade.
   Minimums: XAU/USD >30, GBP/USD >15, EUR/USD >12, USD/JPY >12.
2. Stop loss calculation: SL distance = ATR × 2. Adapts to current conditions automatically.
3. Position sizing: High ATR = reduce lot size. Low ATR = may increase slightly.

ATR TRAILING STOP:
Trail stop at Entry - (ATR × 1.5) for longs. Entry + (ATR × 1.5) for shorts.
Update dynamically as price moves in your favour.

ATR FOR TAKE PROFIT:
Daily ATR = average daily range. If pair moved 70 of 80 pip daily ATR, probability of capturing another 50 pips today is low. Avoid late entries.

ATR EXPANSION = NEW TREND:
ATR was low then suddenly doubles or more = beginning of strong move. Confirms Bollinger Squeeze breakout is genuine.

PARABOLIC SAR (PSAR):
Dots appear above or below price candles.
Dots BELOW candles = uptrend. Bullish. Hold/enter BUY.
Dots ABOVE candles = downtrend. Bearish. Hold/enter SELL.

PSAR EXIT SIGNAL:
In BUY trade: When 2+ dots switch to appear ABOVE candles = exit signal. Trend reversing. Close or lock profits immediately.
In SELL trade: When 2+ dots switch to appear BELOW candles = exit signal.
Why 2 dots? One dot switch can be temporary fluctuation. Two consecutive confirms reversal.

PSAR TRAILING STOP:
Move stop loss to follow PSAR dot position as price moves in your favour. Trade only closes when PSAR reverses — maximises captured trend.

PSAR WEAKNESS: Poor in ranging markets. Dots flip rapidly = false signals. Only use PSAR when ADX >25 (confirms trend).

COMBINED ADX + MACD + ATR + PSAR WORKFLOW:
1. ATR check: Enough volatility to trade? Above minimum threshold?
2. ADX check: Trend present? Above 25?
3. MACD check: Direction? Signal line above zero = uptrend.
4. PSAR check: Confirms direction? Dots below = uptrend.
All four agreeing on same direction = highest confidence entry.

MANAGING OPEN TRADE:
Monitor PSAR for exit signal (2 dots switching sides).
Monitor MACD histogram for momentum weakening (shrinking bars).
Either signal = time to exit or tighten stop.
`.trim(),
  },

  // ── 06 Trade Entry / Exit / Pip Calculation ─────────────────────────────────
  {
    title: 'Trade Entry, Exit, Pip Calculation, Position Sizing, Risk Management',
    tag:   'trade-mechanics',
    pair:  'ALL',
    text: `
TRADE ENTRY, EXIT, PIP CALCULATION, POSITION SIZING, RISK MANAGEMENT

BID AND ASK:
BID = price market buys from you. Used for SELL calculations. Always lower price.
ASK = price market sells to you. Used for BUY calculations. Always higher price.
Spread = ASK - BID = broker fee.

WHAT IS A PIP?
Most forex pairs (EUR/USD, GBP/USD): 1 pip = 0.0001 (4th decimal place).
JPY pairs (USD/JPY): 1 pip = 0.01 (2nd decimal place).
XAU/USD (Gold): 1 pip = $0.01. 100 pips on gold = $1.00 in price.

TAKE PROFIT CALCULATION:
BUY: TP = Entry (Ask) + (Target Pips × pip size)
SELL: TP = Entry (Bid) - (Target Pips × pip size)
EUR/USD BUY example: Entry 1.1342, 60 pip target, TP = 1.1342 + 0.0060 = 1.1402
USD/JPY BUY: Entry 143.82, 50 pips, TP = 143.82 + 0.50 = 144.32

STOP LOSS CALCULATION:
BUY: SL below entry. SL = Entry - (SL pips × pip size).
SELL: SL above entry. SL = Entry + (SL pips × pip size).
ATR method (recommended): SL distance = ATR × 2.
S/R method: Place SL below nearest support (BUY) or above nearest resistance (SELL).

RISK TO REWARD RATIO (R:R):
R:R = TP distance ÷ SL distance.
Example: Entry 1.1342, TP 1.1402 (60 pips), SL 1.1312 (30 pips), R:R = 60/30 = 1:2.
MINIMUM R:R: 1:1.5. PREFERRED: 1:2 or higher. PROFESSIONAL target: 1:2.5 or 1:3.
With 1:2 R:R and 50% win rate: Profitable. With 1:2 R:R and 40% win rate: STILL profitable.

POSITION SIZING:
Standard lot: 100,000 units. Mini lot: 10,000 units (0.1 lot). Micro lot: 1,000 units (0.01 lot).
Pip values (standard lot): EUR/USD = $10/pip. USD/JPY ≈ $9.30/pip. XAU/USD = $10/pip.
Risk-based formula: Lot size = (Account × risk%) ÷ (SL pips × pip value per mini lot).
$5,000 account, 2% risk = $100 max risk. SL 30 pips: 100 ÷ (30 × $1) = 3.33 mini lots = 0.33 lots.
NEVER risk more than 2% ($100 on $5,000 account) per trade.

LOCKING IN PROFITS (TRADE MANAGEMENT):
Once trade moves 1R in your favour: Move SL to breakeven (entry price). Trade becomes risk-free.
Continue moving SL in direction of profit to lock in more profit as price moves.
PSAR trailing: Keep SL at PSAR dot level. Closed when PSAR reverses.
Partial close: Close 30-50% at first TP level. Let remainder run to final target.

MULTIPLE TAKE PROFIT TARGETS:
TP1 at 1R distance (close 30-50%) — guarantee profit.
TP2 at 2R distance (close 30%) — main target.
TP3 let run with trailing stop (remaining 20%) — maximum capture.

MAJOR NEWS EVENTS BY PAIR:
XAU/USD: Fed rate decisions, US CPI, NFP, geopolitical events, DXY direction.
GBP/USD: BoE meetings, UK CPI, UK GDP, PMI data.
EUR/USD: ECB meetings, Eurozone CPI, German Factory Orders.
USD/JPY: BoJ meetings, US NFP, US CPI. WARNING: BoJ intervention risk above 145.00.

THE 30-MINUTE RULE:
Never enter trade within 30 minutes before or after high-impact news for the relevant pair.
Wait for initial volatility to settle, then assess new direction with fresh indicator readings.

SIMULATION TRADING RULES:
1. Minimum 2 indicators must agree before entering.
2. Always set stop loss before entering. No exceptions.
3. Minimum R:R 1:1.5 on every trade. Below 1:1.5 = skip.
4. Maximum 2% account risk per trade.
5. Maximum 3 open trades simultaneously.
6. No trading 30 min before/after high-impact news.
7. Move SL to breakeven at 1R profit.
8. Never move SL further from entry.
9. Log every trade immediately.
10. Review journal weekly.
`.trim(),
  },

  // ── 07 Support / Resistance / Structure ─────────────────────────────────────
  {
    title: 'Support, Resistance, Market Structure, Candlestick Patterns',
    tag:   'sr-structure-candles',
    pair:  'ALL',
    text: `
SUPPORT AND RESISTANCE, MARKET STRUCTURE, CANDLESTICK PATTERNS

SUPPORT AND RESISTANCE BASICS:
Support = floor where buying prevents further decline. Price tends to bounce upward.
Resistance = ceiling where selling prevents further rise. Price tends to reverse downward.
Why they work: Collective market memory — institutions and traders place orders at remembered levels.

IDENTIFYING SUPPORT AND RESISTANCE:
Method 1 — Swing highs/lows: Previous swing highs = resistance. Previous swing lows = support.
Method 2 — Round numbers: EUR/USD 1.1000, 1.1100... GBP/USD 1.3000, 1.3100... USD/JPY 140.00, 141.00... XAU/USD 4400, 4450, 4500...
Method 3 — Previous highs/lows: Daily/weekly/monthly extremes act as S/R for multiple days/weeks.
Method 4 — 200 MA: In uptrend, 200 MA below price = dynamic support. In downtrend, above price = dynamic resistance.

ROLE REVERSAL — BROKEN SUPPORT BECOMES RESISTANCE:
When support is broken decisively → that former support becomes new resistance.
When resistance is broken decisively → that former resistance becomes new support.
Sell setup: Price breaks below 1.1300 → bounces back to 1.1300 → enter SELL at former support (now resistance).
Buy setup: Gold breaks above 4500 → pulls back to 4500 → enter BUY at former resistance (now support).

STRENGTH OF LEVELS:
1. Number of tests: 3+ tests = much stronger than 1 test.
2. Timeframe: Daily level > 15-minute level.
3. Volume at level: High volume = stronger level.
4. Duration of consolidation: Longer = stronger.
5. Clean reversal vs slow grind: Clean reversal = stronger reference.

CONFLUENCE ZONES (strongest):
Multiple factors at same price (e.g., previous daily high + round number + 200 MA + Fibonacci 61.8%) = extremely significant zone. Highest-probability setups.

MARKET STRUCTURE:
Uptrend: Higher Highs (HH) and Higher Lows (HL). Buy on pullbacks to Higher Low zones.
Downtrend: Lower Highs (LH) and Lower Lows (LL). Sell on bounces to Lower High zones.
Break of structure in uptrend: Price breaks below recent Higher Low = bullish structure broken. Exit longs.
Break of structure in downtrend: Price breaks above recent Lower High = bearish structure broken. Exit shorts.
Structure analysis is the backbone of all price action. Indicators confirm what structure tells you.

FIBONACCI RETRACEMENT — KEY LEVELS:
Draw from significant swing low to swing high (uptrend) or high to low (downtrend).
23.6%: Shallow retracement. Strong trend. Aggressive traders only.
38.2%: Moderate retracement. Good entry in confirmed uptrends.
50.0%: Strong psychological level. Widely watched.
61.8%: Golden Ratio. Most important level. Highest probability entry zone. "Golden zone."
78.6%: Deep retracement. Trend may be weakening. Enter with caution.

Trading the 61.8% golden zone:
In uptrend: 61.8% retracement coinciding with previous support or MA = very high-probability buy.
SL below 78.6%. TP at previous high.

BULLISH REVERSAL PATTERNS (at support):
Bullish Engulfing: Previous candle bearish, current candle bullish body engulfs entire previous body. High reliability with RSI <45 at known support.
Hammer: Small body at top, long lower wick (2x+ body size), no upper wick. Sellers rejected. Strong buy signal at support with oversold Stochastic.
Bullish Pin Bar: Very long lower wick, small body near top. Strong rejection of lower prices.
Morning Star (3-candle): Large bearish → small indecision doji → large bullish closing above midpoint of candle 1. Decisive reversal.

BEARISH REVERSAL PATTERNS (at resistance):
Bearish Engulfing: Previous candle bullish, current candle bearish body engulfs previous body. High reliability with RSI >60 at resistance.
Shooting Star: Small body at bottom, long upper wick (2x+). Sellers rejected high. Strong sell at resistance with overbought Stochastic.
Bearish Pin Bar: Long upper wick, small body near bottom. Strong rejection of higher prices.
Evening Star (3-candle): Opposite of Morning Star. Reversal from uptrend.

CONFLUENCE — THE SECRET TO HIGH-PROBABILITY TRADES:
More independent factors pointing to same trade at same price = higher probability.
Maximum confluence (gold buy): Price at support zone + RSI below 45 + Stochastic oversold + bullish engulfing + ADX above 25 + London session + support tested 3+ times + 50 EMA at same level. 5+ factors = maximum confidence.
Minimum: At least 2 factors must align.

KEY LEVELS REFERENCE:
XAU/USD: Major clusters at 4400, 4450, 4500, 4550, 4600, 4650, 4700, 4750, 4800, 4850, 4900. $100 levels particularly significant.
GBP/USD: 1.3000, 1.3100, 1.3200, 1.3300, 1.3400, 1.3500, 1.3600.
EUR/USD: 1.0800, 1.0900, 1.1000, 1.1100, 1.1200, 1.1300, 1.1400, 1.1500.
USD/JPY: 140.00-146.00 whole numbers. CRITICAL: 145.00 is BoJ intervention risk level.
`.trim(),
  },

  // ── 08 Trading Rules / Psychology ───────────────────────────────────────────
  {
    title: 'Personal Trading Rules, Psychology, Risk Management Protocol',
    tag:   'trading-rules-psychology',
    pair:  'ALL',
    text: `
PERSONAL TRADING RULES, PSYCHOLOGY, AND RISK MANAGEMENT

CORE PHILOSOPHY:
Goal = consistent repeatable process, not maximum profit. Three pillars: Edge + Risk Management + Discipline. All three must be present simultaneously.

NON-NEGOTIABLE TRADING RULES:
RULE 1: Always set a stop loss. No stop = gambling, not trading. Determine SL BEFORE entering.
RULE 2: Minimum 2 indicators must confirm before entering. Single indicator = insufficient.
RULE 3: Minimum R:R of 1:1.5. Below 1:1.5 = skip the trade entirely.
RULE 4: Maximum 2% account risk per trade ($100 on $5,000 account).
RULE 5: Maximum 3 open trades simultaneously.
RULE 6: No trading 30 minutes before or after high-impact news (Fed, NFP, CPI, central bank decisions).
RULE 7: Move stop loss to breakeven at 1R profit. Trade becomes risk-free. Missing this is leaving free insurance uncollected.
RULE 8: Never move stop loss FURTHER from entry. Can tighten (closer to profit), never widen.
RULE 9: Log every trade immediately. Pair, direction, entry, exit, SL, TP, lot size, indicators used, reason, outcome, lesson.
RULE 10: Never revenge trade. After loss, take minimum 30-minute break.

PAIR-SPECIFIC RULES:
XAU/USD: Never trade within 30 min of Fed rate decision or US CPI. Best sessions: London (8am-12pm UTC) + NY open (1pm-3pm UTC). Preferred setup: Bullish engulfing at support with RSI <45 during London. ADX must be >25 for gold trend trade. When DXY rising sharply: avoid gold longs (inverse correlation).
GBP/USD: Most active London session (8am-5pm UTC). Avoid around BoE meetings and UK CPI/PMI. RSI below 40 at support in broader uptrend = reliable buy. Do not fight confirmed GBP/USD downtrend — can sustain weeks.
EUR/USD: When ADX <20 (ranging), wait for breakout rather than ranging. ECB days = same caution as Fed. EMA50 on 1H particularly respected.
USD/JPY: 145.00 = critical BoJ intervention risk. Never hold full-size longs above 144.50 without active monitoring. Reduce position 50% or close near 145.00. Strong NFP = USD/JPY bullish. Weak NFP = bearish. Most technically clean during Asian session (11pm-8am UTC).

SESSION TIMING — WHEN TO TRADE:
XAU/USD: London (8am-12pm UTC) + NY open (1pm-4pm UTC). Avoid Asian session.
GBP/USD: London session (8am-5pm UTC). Best 8am-12pm.
EUR/USD: London-NY overlap (1pm-5pm UTC) = peak liquidity.
USD/JPY: Asian session (11pm-8am UTC) for range setups. London open = clean breakouts.
London-NY overlap (1pm-5pm UTC): Highest volatility + liquidity. Most reliable indicator signals.
AVOID: Sunday market open (wide spreads), Fridays after 4pm UTC (liquidity drops), 30 min before/after high-impact news, December last 2 weeks (holiday low liquidity).

TRADING PSYCHOLOGY — MANAGING EMOTIONS:
FOMO (Fear of Missing Out): Price moves sharply, feel compelled to enter without proper setup. Solution: There is always another setup. Missing a trade is not a loss. Chasing a trade is.
Overconfidence after winning streak: Tendency to increase size, relax criteria, feel invincible. Solution: Maintain exact same position sizing and entry criteria regardless of recent results.
Holding losing trades too long: Hope of recovery. Moving SL further away. Adding to losing positions. Solution: Respect your stop loss. Accept small controlled loss and move on.
Cutting winners too early: Closing profitable trades prematurely from fear. Solution: Trust your TP level. Partial exits help psychologically while letting remainder run.
Over-trading: Too many trades, lowering quality criteria, trading from boredom. Solution: Max 3 trades per day. No clear setup = no trade. Going a day without trading is a professional outcome.

THE SINGLE MOST IMPORTANT PRINCIPLE:
Protect your capital above all else.
10% loss → needs 11% gain to recover.
25% loss → needs 33% gain.
50% loss → needs 100% gain.
75% loss → needs 300% gain.
Risk management is not optional — it is everything. Every rule exists to keep drawdowns small and allow compounding gains over time.

DECISION TO GO LIVE CRITERIA:
Minimum 20 closed simulation trades. Win rate above 50%. Average R:R achieved above 1:1.5. No single week with drawdown exceeding 10% of account. Zero trades without proper stop loss. Consistent journal entries for all trades.
`.trim(),
  },

  // ── 09 Setups and Checklists ─────────────────────────────────────────────────
  {
    title: 'Multi-Indicator Setups, Complete Trade Workflows, Checklists',
    tag:   'setups-checklists',
    pair:  'ALL',
    text: `
MULTI-INDICATOR COMBINATIONS, COMPLETE TRADE WORKFLOWS, SETUP CHECKLISTS

COMPLETE PRE-TRADE CHECKLIST:
Answer ALL questions. If any is NO or UNCERTAIN, do not enter.

Step 1 — Market condition: Trending or ranging? (Use 200 MA position + ADX).
If ranging: Bollinger Bounce or Squeeze opportunity?
If trending: Continue to step 2.

Step 2 — Trend direction: Price above/below 200 MA? ADX above 20? MACD signal confirms direction?

Step 3 — Entry timing (at least 2 of 3):
Golden cross on 7+14 MA in correct direction?
Stochastic cross in overbought/oversold zone?
Candlestick pattern at key S/R level?

Step 4 — Risk management:
Stop loss level? (ATR×2 from entry or beyond key S/R)
Take profit level?
R:R at least 1:1.5?
Lot size based on 2% account risk?

Step 5 — External factors:
High-impact news event within 30 minutes?
Correct trading session for this pair?
Maximum 3 trades already open?

SETUP TYPE 1 — TREND CONTINUATION BUY (High probability):
Required: Price above 200 MA + above 89 MA + ADX >25 + RSI >50 + price pulls back to support zone (EMA50, previous R-turned-S, or Fib 61.8%) + bullish candlestick pattern at support + Stochastic approaching/crossing oversold.
Entry: Close of confirming bullish candle at support.
SL: Below support zone (ATR×2 below entry or below candle low).
TP: Previous swing high. Minimum 1:2 R:R.
Move to breakeven: At 1R profit.

SETUP TYPE 2 — TREND CONTINUATION SELL (High probability):
Required: Price below 200 MA + below 89 MA + ADX >25 + RSI <50 + price bounces to resistance (EMA50, previous S-turned-R, or Fib 38.2-61.8%) + bearish candlestick + Stochastic approaching overbought.
Entry: Close of confirming bearish candle at resistance.
SL: Above resistance zone. TP: Previous swing low. Min 1:2 R:R.

SETUP TYPE 3 — BOLLINGER BOUNCE IN RANGING MARKET (Medium-High probability):
Required: ADX <20 + price touches lower/upper BB + Stochastic in oversold/overbought + RSI <35 (buy) or >65 (sell) + confirming candlestick.
BUY: Bullish candle at lower band. SL: ATR×1.5 below. TP: Middle band.
SELL: Bearish candle at upper band. SL: ATR×1.5 above. TP: Middle band.
CAUTION: If ADX starts rising through 20 while in trade, range may be breaking. Tighten stop or close.

SETUP TYPE 4 — BOLLINGER SQUEEZE BREAKOUT (High if squeeze lasted multiple hours):
Preparation: Note upper + lower band prices. Add 10 pips to upper = upper alert. Subtract 10 from lower = lower alert. Set alerts.
On upper alert: Confirm breakout candle closed above band. ATR expanding. Enter BUY.
SL: Below breakout candle low or lower band.
On lower alert: Confirm closed below band. ATR expanding. Enter SELL.
SL: Above breakout candle high or upper band.
TP: 20-40 pips from entry or trail with PSAR.
Probability: HIGH if squeeze lasted multiple hours. MEDIUM if brief (under 1 hour).

SETUP TYPE 5 — SUPPORT/RESISTANCE REVERSAL (High at well-established zones):
BUY at major support: Key zone + bullish reversal candle + RSI <40 or oversold + Stochastic oversold + 200 MA below price (uptrend supportive).
SL: Below support by ATR×1. TP: Next significant resistance.
SELL at major resistance: Key zone + bearish reversal candle + RSI >60 or overbought + Stochastic overbought + 200 MA above price.
SL: Above resistance by ATR×1. TP: Next significant support.

INDICATOR COMBINATIONS:
Combination 1 — Trend trader: MA (7+14 entry, 89+200 trend) + Stochastic + ADX
Combination 2 — Momentum trader: MACD + RSI + Bollinger Bands
Combination 3 — Range trader: Bollinger Bands + Stochastic + RSI
Combination 4 — Breakout trader: Bollinger Bands (squeeze) + ATR + MACD
Combination 5 — Complete system (advanced): 200 MA + ADX + RSI + Stochastic + ATR + PSAR

TIMEFRAME STRATEGY — TOP-DOWN ANALYSIS:
1. Daily chart: Identify macro trend using 200 MA. Note key S/R levels.
2. 4H chart: Confirm trend direction. Is trade setup forming?
3. 1H chart: Execute entry using specific signals (Stochastic cross, golden cross, candlestick).

TIMEFRAME ALIGNMENT BONUS:
Daily + 4H + 1H all showing same directional bias (all above 200 MA, all MA crossed bullish, all RSI >50) = significantly higher probability.

HOLDING PERIODS BY TIMEFRAME:
1m-5m: 5-30 minutes (scalping)
15m: 30 min - 3 hours
1H: 4-24 hours (intraday)
4H: 1-5 days (short-term swing)
Daily: 1-3 weeks (swing trading)

Focus primarily on 1H charts for entries, using 4H and Daily for context. Provides enough signal frequency without ultra-short-term scalping stress.
`.trim(),
  },

  // ── 10 Additional — Currency Correlations ───────────────────────────────────
  {
    title: 'Currency Correlations and Cross-Market Analysis',
    tag:   'correlations',
    pair:  'ALL',
    text: `
CURRENCY CORRELATIONS AND CROSS-MARKET ANALYSIS

WHAT ARE CURRENCY CORRELATIONS?
Currency pairs move in relation to each other. Understanding correlations prevents taking opposing trades that cancel each other out (over-exposure) and identifies confirmation signals from related markets.

POSITIVE CORRELATIONS (pairs tend to move in the same direction):
EUR/USD and GBP/USD: Strong positive correlation (~0.85-0.95). Both are European majors vs USD. When EUR/USD rises, GBP/USD usually rises too. If your EUR/USD signal is BUY and GBP/USD also shows BUY signals, confidence increases.
EUR/USD and AUD/USD: Moderate positive correlation. Both weaken when USD strengthens.
XAU/USD and AUD/USD: Positive correlation (both commodities-linked, both negatively correlated to USD).

NEGATIVE CORRELATIONS (pairs tend to move in opposite directions):
EUR/USD and USD/CHF: Very strong negative correlation (~0.90-0.95). When EUR/USD rises, USD/CHF almost always falls. Near mirror image.
EUR/USD and USD/JPY: Moderate negative correlation. USD strength weakens EUR/USD but strengthens USD/JPY.
XAU/USD and USD/DXY: Strong negative correlation. When USD Index (DXY) rises = gold typically falls. When DXY falls = gold typically rises.

PRACTICAL TRADING APPLICATIONS:
Cross-confirmation: If EUR/USD is showing a strong bullish setup AND GBP/USD is also showing bullish signals, both confirm the dollar weakness theme. Higher confidence.
Divergence warning: If EUR/USD is making new highs but GBP/USD is NOT — divergence between correlated pairs signals potential reversal or USD-specific event.
Risk control: Avoid taking EUR/USD BUY and GBP/USD BUY simultaneously at full size — both are exposed to the same USD weakness risk. You are doubling your USD directional exposure.

XAU/USD SPECIFIC CORRELATIONS:
Gold vs DXY: Watch USD Index direction. Rising DXY = headwind for gold longs. Falling DXY = tailwind.
Gold vs US Real Yields: Rising real yields (10Y TIPS) = bearish for gold. Falling real yields = bullish for gold.
Gold vs Risk Sentiment: During risk-off (market fear/crisis), gold typically rises as safe haven. During risk-on, gold can underperform.
Gold vs Geopolitical Events: Gold spikes sharply on geopolitical escalation (wars, crises). These spikes often retrace after initial panic subsides.

USD/JPY SPECIFIC CORRELATIONS:
USD/JPY and US 10Y Treasury Yield: Very strong positive correlation. Rising US yields = USD/JPY higher. Falling yields = USD/JPY lower.
USD/JPY and Nikkei 225: Moderate positive correlation. Risk-on sessions often see both the Nikkei and USD/JPY rise.
USD/JPY and Risk Sentiment: Risk-on = USD/JPY higher (JPY weakens). Risk-off = USD/JPY lower (JPY safe haven strengthening).

USING CORRELATIONS IN SIGNAL ANALYSIS:
Step 1: Check what DXY is doing before trading any USD pair.
Step 2: For gold longs, confirm DXY is flat or falling.
Step 3: For EUR/USD analysis, check if GBP/USD agrees on dollar direction.
Step 4: For USD/JPY analysis, check US 10Y yield direction for confluence.

CORRELATION BREAKDOWN WARNINGS:
Correlations are not fixed. During extreme events (central bank surprises, geopolitical shocks), normal correlations can break temporarily. Always use correlations as confirmation, not as a primary entry signal.
`.trim(),
  },

  // ── 11 Additional — Session Volatility Profile ──────────────────────────────
  {
    title: 'Trading Session Profiles and Optimal Entry Windows',
    tag:   'session-profiles',
    pair:  'ALL',
    text: `
TRADING SESSION PROFILES AND OPTIMAL ENTRY WINDOWS

THE FOUR MAJOR TRADING SESSIONS (all times UTC):

TOKYO / ASIAN SESSION (11pm - 8am UTC):
Characteristics: Lower volatility. Tighter ranges. JPY pairs most active. Round number support/resistance frequently respected.
Best pairs: USD/JPY (cleanest setups). AUD/USD, NZD/USD.
Avoid: EUR/USD, GBP/USD for trend entries (insufficient range). XAU/USD unless major news event.
Typical range: EUR/USD 40-60 pips. USD/JPY 50-80 pips. GBP/USD 40-60 pips.
Strategy: Range-based entries using Bollinger Bounce and S/R levels. ADX typically below 20 for EUR/USD.

LONDON SESSION (7am - 4pm UTC, peak 8am-12pm):
Characteristics: Most active session. Largest daily moves for EUR and GBP pairs initiated here. Fresh trends established. Institutional traders most active.
Best pairs: ALL, especially EUR/USD, GBP/USD, XAU/USD.
London open (8am-10am UTC): Best window for breakout trades. Previous session range often broken with strong momentum. High spreads first 5-10 minutes, then normalise.
Typical range: EUR/USD 80-120 pips. GBP/USD 80-130 pips. XAU/USD 150-250 pips.
Strategy: Trend following, breakout from Asian session range, S/R level bounces. ADX often rises above 25 quickly after London open.

NEW YORK SESSION (1pm - 10pm UTC, peak 1pm-5pm):
Characteristics: High volatility especially at NY open (1pm). High-impact US data typically released 1:30pm-3pm UTC. Second most active session.
Best pairs: ALL USD pairs. EUR/USD, GBP/USD, XAU/USD.
NY open (1pm-2pm): Can create sharp reversals or extensions of London trends. Most important US data window.
Typical range: Extends London range by 30-50% for most pairs.

LONDON-NEW YORK OVERLAP (1pm-5pm UTC):
THE HIGHEST QUALITY TRADING WINDOW. Both major sessions active simultaneously. Tightest spreads. Highest liquidity. Most reliable technical signals.
Best for: EUR/USD and GBP/USD primary entries. XAU/USD trend continuation.
Indicator signals during this window are MORE RELIABLE than at other times.

SESSION-SPECIFIC STRATEGIES:
Asian session: Bollinger Bounce at S/R. Target middle BB. ADX likely ranging. Smaller lot sizes due to tighter ranges.
London open: Watch for Asian session range breakout. Set alerts at Asian high + 10 pips (buy) and Asian low - 10 pips (sell). Strong breakout candles = trend entry.
London session: Trend continuation entries. Wait for first 30-minute candle to close, then assess direction.
NY open: Check what London trend established. Trade continuation OR NY reversal on exhaustion. Watch USD data releases.
NY session: High impact USD events (1:30pm UTC usually). Avoid entering 30 min before known releases.

OPTIMAL ENTRY WINDOWS BY PAIR:
XAU/USD:
Priority 1: London open reaction (8am-10am UTC) — London often sets the gold direction.
Priority 2: NY open (1pm-2pm UTC) — can produce strong gold moves especially on US data.
Priority 3: Avoid 10am-1pm (overlap lull) and Asian session for fresh entries.

GBP/USD:
Priority 1: London open (8am-10am UTC).
Priority 2: London-NY overlap (1pm-5pm UTC).
Avoid: Asian session entries (tight range, false signals common).

EUR/USD:
Priority 1: London-NY overlap (1pm-5pm UTC) — tightest spreads, most liquidity.
Priority 2: London session (8am-4pm UTC).
Avoid: Asian session except for clearly established range plays.

USD/JPY:
Priority 1: Asian session (11pm-8am UTC) for range setups.
Priority 2: London open (8am-9am UTC) for breakout from Asian range.
Avoid: London-NY overlap for new entries unless following strong trend established earlier.

IMPACT OF US ECONOMIC RELEASES (ALL UTC TIMES):
NFP (First Friday of month, 1:30pm UTC): Highest impact USD event of the month. Affects ALL USD pairs violently. Stay out 30 min before and after.
CPI (Monthly, 1:30pm UTC): Second most important USD release. Same precautions.
Fed Rate Decision (8 meetings/year, 6pm UTC typically): CRITICAL for all USD pairs and gold. Avoid all USD pairs and gold from 5:30pm-7pm UTC on decision days.
FOMC minutes (3 weeks after each meeting, 6pm UTC): Moderate impact. Take caution with USD pairs.
Retail Sales (Monthly, 1:30pm UTC): Moderate USD impact.
ISM PMI (First business day of month, 3pm UTC): USD pairs can react sharply.
`.trim(),
  },

  // ── 12 Additional — Signal Accuracy and Learning Framework ──────────────────
  {
    title: 'AI Signal Interpretation and Continuous Improvement Framework',
    tag:   'signal-framework',
    pair:  'ALL',
    text: `
AI SIGNAL INTERPRETATION AND CONTINUOUS IMPROVEMENT FRAMEWORK

HOW TO INTERPRET AI TRADING SIGNALS:
An AI signal provides a directional bias (BUY/SELL/HOLD) with a confidence percentage based on the current technical indicator readings. It is a probability estimate, not a guarantee.

SIGNAL COMPONENTS AND THEIR MEANING:
Confidence %: Probability score based on indicator alignment. 70%+ = solid setup. 85%+ = very high conviction. Below 65% = marginal — consider passing.
Signal direction: BUY/SELL/HOLD. HOLD means insufficient confluence or unfavourable risk conditions.
Entry: Suggested entry price, usually current market price or a small improvement.
Stop Loss: Placement determined by ATR×1.5 beyond nearest structure level.
Take Profit: Minimum 2:1 R:R from entry. Usually 2.5-3:1 on high-confidence setups.
Risk/Reward: Always verify this is ≥1:1.5 before executing.
Key Risks: Specific factors that could invalidate the signal (upcoming news, weak ADX, counter-trend structure).
Time Horizon: Expected duration of the trade.
Auto-Trade Recommended: Only true when ALL criteria met (BUY/SELL, confidence ≥72, ADX ≥25, higher TF agrees, MACD agrees, R:R ≥1:2, adequate liquidity, no imminent news).

WHEN TO OVERRIDE A SIGNAL:
1. High-impact news within 30 minutes of signal generation — always defer.
2. Spread is unusually wide (>3x normal spread for the pair) — defer until normalises.
3. Your personal R:R calculation differs significantly from signal — trust your calculation.
4. Signal contradicts a very clear structure-level on a higher timeframe — flag and consider manually.
5. Price has already moved significantly from signal entry — recalculate R:R. If <1:1.5, skip.

WHEN TO TRUST A SIGNAL MORE:
1. Signal aligns with your own manual analysis.
2. Session is London or London-NY overlap (highest quality signals).
3. ADX is above 25 (confirmed trend, not noise).
4. Signal direction aligns with the higher timeframe (4H/Daily) trend.
5. Your personal trading history shows positive edge on this pair in this session.
6. Economic calendar shows no major news for next 2+ hours.

TRACKING SIGNAL ACCURACY FOR IMPROVEMENT:
Log each signal taken: Date, pair, direction, entry, exit, outcome, confidence%, session.
Calculate win rate by: Pair (which pairs have your best edge?), Session (which sessions produce best results?), Confidence range (do signals at 80%+ outperform 65-70% signals?), Timeframe (1H vs 4H signals).
Review monthly: Identify your best-performing setups and double down on those.

USING YOUR PERSONAL TRADING HISTORY TO IMPROVE:
If win rate on EUR/USD BUY signals is 70% but EUR/USD SELL is 40% — increase caution on SELL signals, wait for higher confidence threshold before taking them.
If XAU/USD signals during London session have 65% win rate but NY session have 45% — weight London signals more heavily for gold.
After 20+ trades, you will have statistically meaningful data. Let data, not emotion, guide your decision to take or skip signals.

COMMON SIGNAL INTERPRETATION MISTAKES:
Mistake 1: Taking every signal regardless of session. Solution: Apply session filter — prefer London/NY overlap for entries.
Mistake 2: Ignoring R:R because confidence is high. Solution: Always verify R:R ≥1:1.5, regardless of confidence%.
Mistake 3: Entering after price has already moved 50+ pips from signal entry. Solution: If entry is no longer available at stated price, recalculate or skip.
Mistake 4: Not checking economic calendar before entering. Solution: Always check high-impact events for the next 2 hours before placing any trade.
Mistake 5: Treating HOLD as a suggestion rather than a directive. Solution: HOLD means conditions are NOT suitable. Respect it.

SIGNAL CONFIDENCE INTERPRETATION GUIDE:
90-100%: Maximum conviction. All indicators aligned, strong trend, ideal session, no news risk. Execute at full calculated position size.
80-89%: High conviction. Most indicators aligned. Execute at planned size.
72-79%: Good setup. Solid alignment but may have 1-2 neutral indicators. Execute at 75% of planned size.
65-71%: Marginal. Some alignment but missing key confirmation. Consider skipping or use minimum lot size (learning trade only).
Below 65%: Insufficient evidence. HOLD behaviour even if signal says BUY/SELL. Wait for better setup.
`.trim(),
  },

];
