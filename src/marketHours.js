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

// End-of-day flatten window: 15:55–15:59 ET  ==  2:55–2:59 PM Central.
// Everything is closed here so the account is flat before the 16:00 ET
// (3:00 PM Central) close.
function isFlattenWindow(date = new Date()) {
  const { weekday, hour, minute } = nyParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = hour * 60 + minute;
  return mins >= 15 * 60 + 55 && mins < 16 * 60;
}

// YYYY-MM-DD in New York — used as a once-per-day guard.
function nyDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = { isMarketOpen, isFlattenWindow, nyParts, nyDateKey };
