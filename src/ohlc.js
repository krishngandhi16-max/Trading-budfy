const yahooFinance = require('yahoo-finance2').default;

// Timeframe to Yahoo Finance interval mapping
const INTERVAL_MAP = {
  '1M':  '1m',
  '5M':  '5m',
  '15M': '15m',
  '1H':  '1h',
  '4H':  '1h',  // Yahoo doesn't support 4H; caller must aggregate
  '1D':  '1d',
};

// Number of bars to fetch per timeframe
const PERIOD_MAP = {
  '1M':  { range: '1d' },
  '5M':  { range: '5d' },
  '15M': { range: '5d' },
  '1H':  { range: '1mo' },
  '4H':  { range: '3mo' },
  '1D':  { range: '1y' },
};

// Market-type to Yahoo Finance symbol conventions
const MARKET_TYPES = {
  stocks:  { suffix: '' },
  crypto:  { suffix: '-USD' },
  futures: { suffix: '=F' },
  forex:   { suffix: '=X' },
  metals:  { suffix: '=F' },
};

/**
 * Normalise a raw Yahoo Finance quote into { time, open, high, low, close, volume }.
 */
function normaliseQuote(q) {
  return {
    time:   q.date instanceof Date ? q.date.toISOString() : q.date,
    open:   q.open,
    high:   q.high,
    low:    q.low,
    close:  q.close,
    volume: q.volume ?? 0,
  };
}

/**
 * Aggregate 1H bars into 4H bars (groups of 4, aligned from bar[0]).
 */
function aggregateTo4H(bars) {
  const result = [];
  for (let i = 0; i + 3 < bars.length; i += 4) {
    const group = bars.slice(i, i + 4);
    result.push({
      time:   group[0].time,
      open:   group[0].open,
      high:   Math.max(...group.map((b) => b.high)),
      low:    Math.min(...group.map((b) => b.low)),
      close:  group[group.length - 1].close,
      volume: group.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

/**
 * Build the Yahoo Finance ticker from a base symbol and market type.
 *
 * @param {string} symbol     e.g. 'AAPL', 'BTC', 'GC', 'EURUSD'
 * @param {string} marketType one of: stocks | crypto | futures | forex | metals
 */
function buildTicker(symbol, marketType) {
  const config = MARKET_TYPES[marketType];
  if (!config) throw new Error(`Unknown market type: ${marketType}`);
  // If the caller already appended the suffix, don't double-append.
  const upper = symbol.toUpperCase();
  if (upper.endsWith(config.suffix)) return upper;
  return upper + config.suffix;
}

/**
 * Fetch OHLC bars for a symbol from Yahoo Finance.
 *
 * @param {string} symbol      Base symbol (e.g. 'AAPL', 'BTC', 'GC', 'EURUSD', 'XAU')
 * @param {string} marketType  'stocks' | 'crypto' | 'futures' | 'forex' | 'metals'
 * @param {string} timeframe   '1M' | '5M' | '15M' | '1H' | '4H' | '1D'
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
async function fetchOHLC(symbol, marketType, timeframe) {
  if (!INTERVAL_MAP[timeframe]) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  const ticker   = buildTicker(symbol, marketType);
  const interval = INTERVAL_MAP[timeframe];
  const { range } = PERIOD_MAP[timeframe];

  const result = await yahooFinance.chart(ticker, { interval, range });

  if (!result || !result.quotes || result.quotes.length === 0) {
    throw new Error(`No data returned for ${ticker} on ${timeframe}`);
  }

  let bars = result.quotes
    .filter((q) => q.open != null && q.close != null)
    .map(normaliseQuote);

  if (timeframe === '4H') {
    bars = aggregateTo4H(bars);
  }

  return bars;
}

module.exports = { fetchOHLC, buildTicker, MARKET_TYPES, INTERVAL_MAP };
