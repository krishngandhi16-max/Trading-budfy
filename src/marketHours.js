/**
 * US equity regular-trading-hours helper (09:30–16:00 America/New_York, Mon–Fri).
 * Does not account for market holidays — the scanner also relies on Alpaca simply
 * returning no fresh bars on closed days, so a holiday just yields no signals.
 */

function nyParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,                       // 'Mon'..'Sun'
    hour:    parseInt(parts.hour, 10),
    minute:  parseInt(parts.minute, 10),
  };
}

function isMarketOpen(date = new Date()) {
  const { weekday, hour, minute } = nyParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;    // 09:30 ≤ t < 16:00 ET
}

module.exports = { isMarketOpen, nyParts };
