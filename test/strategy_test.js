/* Synthetic-bar tests for the three strategy modules. Run: node scratchpad/strategy_test.js */
const sweep = require('../src/strategies/liquiditySweep');
const vp    = require('../src/strategies/volumeProfile');
const master = require('../src/strategies/master');

function bar(o, h, l, c, v) { return { time: '', open: o, high: h, low: l, close: c, volume: v }; }

// Daily bars: prev day low = 100, high = 111 (PDL/PDH). Last bar = forming today.
const daily = [
  bar(105, 112, 99, 108, 1e6),   // older
  bar(108, 111, 100, 104, 1e6),  // "yesterday" (prev day) → PDL 100, PDH 111
  bar(104, 106, 101, 103, 1e6),  // today forming (ignored by prevDayLevels)
];

// Build a long sweep→BOS→FVG→pullback sequence on 5m, ending on the pullback bar.
function buildLongSetup({ bosVolume = 2600, pullbackVolume = 600 } = {}) {
  const bars = [];
  for (let i = 0; i < 20; i++) bars.push(bar(104, 104.5, 103.5, 104, 1000)); // warmup
  for (const px of [103.2, 102.4, 101.6, 100.9, 100.3]) bars.push(bar(px + 0.5, px + 0.6, px - 0.2, px, 1100)); // decline
  bars.push(bar(100.2, 100.3, 99.2, 99.5, 900));   // sweep bar 1 (below PDL 100, vol fading)
  bars.push(bar(99.5, 99.6, 98.4, 98.8, 700));     // sweep bar 2 (lower low, vol fading)
  bars.push(bar(98.8, 99.4, 98.6, 99.2, 800));     // base
  bars.push(bar(99.2, 101.6, 99.0, 101.5, bosVolume)); // BOS candle (body closes > sweep struct & PDL)
  bars.push(bar(101.5, 102.3, 101.4, 102.1, 1500));    // continuation
  bars.push(bar(102.1, 102.9, 101.9, 102.7, 1200));    // low 101.9 > high[2]=101.6 → bullish FVG 101.6–101.9
  bars.push(bar(102.7, 103.0, 102.4, 102.6, 900));     // drift
  bars.push(bar(102.6, 102.7, 101.35, 102.2, pullbackVolume)); // pullback touches FVG (fresh, last bar)
  return bars;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name); }
}

console.log('Strategy 1 — Liquidity Sweep');
const s1 = sweep.evaluate('TEST', buildLongSetup(), daily);
check('fires BUY on textbook long setup', s1 && s1.direction === 'long');
check('entry is a limit inside FVG (~101.6)', s1 && s1.entryType === 'limit' && Math.abs(s1.entryPrice - 101.6) < 0.5);
check('stop at sweep low (~98.4)', s1 && Math.abs(s1.stopLoss - 98.4) < 0.3);
check('R:R ≥ 2.5', s1 && s1.meta.rr >= 2.5);
const s1none = sweep.evaluate('TEST', buildLongSetup().slice(0, -1), daily); // no pullback yet
check('silent before the pullback bar', s1none === null);

console.log('Strategy 3 — Master');
const m1 = master.evaluate('TEST', buildLongSetup({ bosVolume: 2600, pullbackVolume: 600 }), daily);
check('fires BUY when volume spike + low-vol pullback present', m1 && m1.direction === 'long');
check('target is POC', m1 && m1.meta.poc != null && Math.abs(m1.takeProfit - m1.meta.poc) < 0.01);
const m2 = master.evaluate('TEST', buildLongSetup({ bosVolume: 1100 }), daily); // no BOS volume spike
check('silent when BOS has no volume spike', m2 === null);
const m3 = master.evaluate('TEST', buildLongSetup({ pullbackVolume: 5000 }), daily); // pullback high vol
check('silent when pullback is on high volume', m3 === null);

console.log('Strategy 2 — Volume Profile');
// Build a profile with heavy volume around 103, then a fresh close below VAL.
const vpBars = [];
for (const [px, v] of [[100, 500], [101, 800], [102, 1500], [103, 4000], [104, 2000], [105, 900], [106, 400]]) {
  for (let i = 0; i < 10; i++) vpBars.push(bar(px, px + 0.4, px - 0.4, px, v));
}
// prev bar inside value area, last bar closes below VAL
vpBars.push(bar(103, 103.2, 102.8, 103, 1000));       // inside
vpBars.push(bar(103, 103.1, 101.5, 101.6, 1200));     // fresh cross below VAL(~103)
const v1 = vp.evaluate('TEST', vpBars, daily);
check('fires BUY when price closes below VAL', v1 && v1.direction === 'long');
check('target is POC (~103)', v1 && Math.abs(v1.takeProfit - v1.meta.poc) < 0.01 && v1.meta.poc > 102);
check('stop below entry', v1 && v1.stopLoss < v1.entryPrice);
// No fresh cross (already below on prev bar) → silent
const vpBars2 = vpBars.concat([bar(101.6, 101.7, 101.0, 101.2, 1000)]);
const v2 = vp.evaluate('TEST', vpBars2, daily);
check('silent when already outside value area (no fresh cross)', v2 === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
