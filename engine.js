/* Market Compass signal engine.
 * Shared by the iPhone web app (browser global `MC`) and the background scanner (Node module).
 * Every number it reports comes from public market data and a replay of the same rules on past candles.
 * Nothing here is a guarantee. Markets can and do move against any signal.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com'];

  const DEFAULTS = {
    interval: '4h',
    candles: 500,          // ~83 days of 4h candles
    minScore: 7,           // out of 10
    minProb: 0.6,          // estimated chance TP1 is hit before the stop
    stopAtr: 1.5,          // stop distance in ATRs
    tp1Atr: 1.5,           // first target (1:1 reward/risk)
    tp2Atr: 3.0,           // second target (2:1)
    horizon: 18,           // candles a trade is given (18 x 4h = 3 days)
    cooldown: 6,           // candles between two signals on one asset
    priorWeight: 8,        // how strongly the market-wide rate pulls a coin's own rate
    accountSize: 100,
    riskPct: 1,
  };

  const STABLE = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EUR', 'AEUR', 'USDE', 'PYUSD', 'USD1',
    'XUSD', 'BFUSD', 'RLUSD', 'UST', 'USTC', 'GBP', 'TRY', 'BRL', 'EURI', 'USDS', 'PAXG', 'XAUT', 'WBTC', 'WBETH', 'BETH', 'BNSOL']);

  // ---------- data ----------
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('?')[0]);
    return r.json();
  }

  async function binance(path) {
    let lastErr;
    for (const h of BINANCE_HOSTS) {
      try { return await getJSON(h + path); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function topSymbols(n) {
    const all = await binance('/api/v3/ticker/24hr');
    return all
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({ ...t, base: t.symbol.slice(0, -4) }))
      .filter(t => !STABLE.has(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base) && +t.quoteVolume > 0 && +t.count > 0)
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, n)
      .map(t => ({
        symbol: t.symbol, base: t.base, price: +t.lastPrice, change24h: +t.priceChangePercent,
        volume24h: +t.quoteVolume, high24h: +t.highPrice, low24h: +t.lowPrice,
      }));
  }

  async function binanceCandles(symbol, interval, limit) {
    const raw = await binance(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    raw.pop(); // drop the candle that is still forming
    return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }

  // Twelve Data (optional free key) for oil, gold spot and the euro/dollar rate
  async function twelveCandles(symbol, key, limit) {
    const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=${limit}&apikey=${key}`);
    if (j.status === 'error' || !j.values) throw new Error(j.message || 'Twelve Data error for ' + symbol);
    const rows = j.values.slice().reverse().map(v => ({
      t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0),
    }));
    rows.pop();
    return rows;
  }

  async function fearGreed() {
    try {
      const j = await getJSON('https://api.alternative.me/fng/?limit=2');
      return { value: +j.data[0].value, label: j.data[0].value_classification, prev: +j.data[1].value };
    } catch (e) { return null; }
  }

  async function news(key) {
    try {
      const url = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN' + (key ? '&api_key=' + key : '');
      const j = await getJSON(url);
      if (!Array.isArray(j.Data)) return [];
      return j.Data.slice(0, 60).map(n => ({
        title: n.title, url: n.url, source: n.source_info?.name || n.source, time: n.published_on * 1000,
        tags: ((n.categories || '') + '|' + (n.tags || '')).toUpperCase().split('|').filter(Boolean),
        tone: tone(n.title + ' ' + (n.body || '').slice(0, 300)),
      }));
    } catch (e) { return []; }
  }

  const POS = ['surge', 'soar', 'rally', 'record', 'approval', 'approved', 'adopt', 'partnership', 'inflow', 'bullish', 'gain', 'jump', 'breakout', 'upgrade', 'launch', 'etf', 'buy'];
  const NEG = ['hack', 'exploit', 'crash', 'plunge', 'lawsuit', 'sue', 'ban', 'outflow', 'bearish', 'drop', 'fall', 'liquidat', 'fraud', 'delist', 'sell-off', 'selloff', 'probe', 'fine', 'warning'];
  function tone(text) {
    const s = text.toLowerCase();
    let x = 0;
    POS.forEach(w => { if (s.includes(w)) x++; });
    NEG.forEach(w => { if (s.includes(w)) x--; });
    return x > 0 ? 1 : x < 0 ? -1 : 0;
  }

  // ---------- indicators ----------
  function ema(xs, p) {
    const out = new Array(xs.length).fill(NaN), k = 2 / (p + 1);
    let prev;
    for (let i = 0; i < xs.length; i++) {
      if (i === p - 1) { let s = 0; for (let j = 0; j < p; j++) s += xs[j]; prev = s / p; out[i] = prev; }
      else if (i >= p) { prev = xs[i] * k + prev * (1 - k); out[i] = prev; }
    }
    return out;
  }
  function sma(xs, p) {
    const out = new Array(xs.length).fill(NaN); let s = 0;
    for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= p) s -= xs[i - p]; if (i >= p - 1) out[i] = s / p; }
    return out;
  }
  function wilder(xs, p, start) { // Wilder smoothing beginning at index `start`
    const out = new Array(xs.length).fill(NaN);
    if (xs.length < start + p) return out;
    let s = 0; for (let i = start; i < start + p; i++) s += xs[i];
    let prev = s / p; out[start + p - 1] = prev;
    for (let i = start + p; i < xs.length; i++) { prev = (prev * (p - 1) + xs[i]) / p; out[i] = prev; }
    return out;
  }
  function rsi(c, p = 14) {
    const g = [0], l = [0];
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
    const ag = wilder(g, p, 1), al = wilder(l, p, 1);
    return c.map((_, i) => isNaN(ag[i]) ? NaN : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]));
  }
  function indicators(cs) {
    const c = cs.map(x => x.c), h = cs.map(x => x.h), l = cs.map(x => x.l), v = cs.map(x => x.v);
    const tr = cs.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]), Math.abs(x.l - c[i - 1])));
    const pdm = cs.map((x, i) => { if (!i) return 0; const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; return up > dn && up > 0 ? up : 0; });
    const ndm = cs.map((x, i) => { if (!i) return 0; const up = h[i] - h[i - 1], dn = l[i - 1] - l[i]; return dn > up && dn > 0 ? dn : 0; });
    const atr = wilder(tr, 14, 1), sp = wilder(pdm, 14, 1), sn = wilder(ndm, 14, 1);
    const pdi = sp.map((x, i) => 100 * x / atr[i]), ndi = sn.map((x, i) => 100 * x / atr[i]);
    const dx = pdi.map((x, i) => (x + ndi[i]) === 0 ? 0 : 100 * Math.abs(x - ndi[i]) / (x + ndi[i]));
    const firstDx = dx.findIndex(x => !isNaN(x));
    const adx = firstDx < 0 ? dx.map(() => NaN) : wilder(dx.map(x => isNaN(x) ? 0 : x), 14, firstDx);
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const macd = c.map((_, i) => e12[i] - e26[i]);
    const firstM = macd.findIndex(x => !isNaN(x));
    const sigPart = ema(macd.slice(firstM), 9);
    const signal = macd.map((_, i) => i < firstM ? NaN : sigPart[i - firstM]);
    return {
      c, o: cs.map(x => x.o), h, l, t: cs.map(x => x.t),
      e20: ema(c, 20), e50: ema(c, 50), e120: ema(c, 120),
      rsi: rsi(c), atr, adx, pdi, ndi,
      hist: macd.map((x, i) => x - signal[i]),
      volAvg: sma(v, 20), v,
    };
  }

  // ---------- scoring ----------
  // Returns a 0-10 score for a long and a short at candle i, with the reasons behind it.
  function scoreAt(d, i, regime) {
    const c = d.c[i], atr = d.atr[i];
    if ([c, atr, d.e120[i], d.rsi[i], d.adx[i], d.hist[i - 1], d.volAvg[i]].some(x => x === undefined || isNaN(x))) return null;
    const L = [], S = [];
    let long = 0, short = 0;
    const add = (side, pts, why) => { if (side === 'L') { long += pts; L.push([pts, why]); } else { short += pts; S.push([pts, why]); } };

    // 1. Big-picture trend (about 20 days)
    if (c > d.e120[i]) add('L', 2, 'Price above its 20-day trend line'); else add('S', 2, 'Price below its 20-day trend line');
    if (d.e50[i] > d.e120[i]) add('L', 1, 'Medium trend pointing up'); else add('S', 1, 'Medium trend pointing down');
    // 2. Short-term trend
    if (d.e20[i] > d.e50[i]) add('L', 1, 'Short-term trend pointing up'); else add('S', 1, 'Short-term trend pointing down');
    // 3. Momentum (MACD)
    if (d.hist[i] > 0 && d.hist[i] > d.hist[i - 1]) add('L', 1, 'Momentum rising (MACD)');
    if (d.hist[i] < 0 && d.hist[i] < d.hist[i - 1]) add('S', 1, 'Momentum falling (MACD)');
    // 4. RSI: room to run, not stretched
    const r = d.rsi[i];
    if (r >= 45 && r <= 68) add('L', 1, `RSI ${r.toFixed(0)}: strong but not overbought`);
    if (r <= 55 && r >= 32) add('S', 1, `RSI ${r.toFixed(0)}: weak but not oversold`);
    if (r > 75) add('L', -2, `RSI ${r.toFixed(0)}: overbought, late to buy`);
    if (r < 25) add('S', -2, `RSI ${r.toFixed(0)}: oversold, late to sell`);
    // 5. Trend strength (ADX)
    if (d.adx[i] > 22 && d.pdi[i] > d.ndi[i]) add('L', 1, `Strong trend (ADX ${d.adx[i].toFixed(0)}) led by buyers`);
    if (d.adx[i] > 22 && d.ndi[i] > d.pdi[i]) add('S', 1, `Strong trend (ADX ${d.adx[i].toFixed(0)}) led by sellers`);
    // 6. Volume confirmation
    const vr = d.v[i] / d.volAvg[i];
    if (vr > 1.3 && c > d.o[i]) add('L', 1, `Buying volume ${vr.toFixed(1)}x normal`);
    if (vr > 1.3 && c < d.o[i]) add('S', 1, `Selling volume ${vr.toFixed(1)}x normal`);
    // 7. Not chasing: close to the short-term average
    const stretch = (c - d.e20[i]) / atr;
    if (stretch >= -0.3 && stretch <= 1.2) add('L', 1, 'Entry near support, not chasing');
    if (stretch <= 0.3 && stretch >= -1.2) add('S', 1, 'Entry near resistance, not chasing');
    if (stretch > 3) add('L', -1, 'Price far above average, stretched');
    if (stretch < -3) add('S', -1, 'Price far below average, stretched');
    // 8. Bitcoin's direction (crypto moves with BTC)
    if (regime === 1) { add('L', 1, 'Bitcoin trend is up'); add('S', -2, 'Bitcoin trend is up, shorts fight the market'); }
    if (regime === -1) { add('S', 1, 'Bitcoin trend is down'); add('L', -2, 'Bitcoin trend is down, longs fight the market'); }

    return { long: Math.max(0, Math.min(10, long)), short: Math.max(0, Math.min(10, short)), L, S, rsi: r, adx: d.adx[i], atr, vr };
  }

  function regimeSeries(btc) {
    const d = indicators(btc), m = new Map();
    d.t.forEach((t, i) => {
      if (isNaN(d.e120[i])) return;
      const up = d.c[i] > d.e120[i] && d.e50[i] > d.e120[i];
      const dn = d.c[i] < d.e120[i] && d.e50[i] < d.e120[i];
      m.set(t, up ? 1 : dn ? -1 : 0);
    });
    return m;
  }

  function plan(side, entry, atr, cfg) {
    const s = side === 'long' ? 1 : -1;
    return {
      entry, stop: entry - s * cfg.stopAtr * atr, tp1: entry + s * cfg.tp1Atr * atr, tp2: entry + s * cfg.tp2Atr * atr,
    };
  }

  // Replay the rules on past candles: whenever the score reached the bar, did TP1 come before the stop?
  function backtest(d, regimeAt, cfg) {
    const res = { long: { w: 0, l: 0, x: 0, r: 0 }, short: { w: 0, l: 0, x: 0, r: 0 } };
    const last = { long: -1e9, short: -1e9 };
    for (let i = 130; i < d.c.length - 1; i++) {
      const sc = scoreAt(d, i, regimeAt(d.t[i]));
      if (!sc) continue;
      for (const side of ['long', 'short']) {
        if (sc[side] < cfg.minScore || i - last[side] < cfg.cooldown) continue;
        last[side] = i;
        const p = plan(side, d.c[i], sc.atr, cfg), risk = Math.abs(p.entry - p.stop);
        let outcome = null;
        for (let j = i + 1; j <= Math.min(i + cfg.horizon, d.c.length - 1); j++) {
          const hitStop = side === 'long' ? d.l[j] <= p.stop : d.h[j] >= p.stop;
          const hitTp = side === 'long' ? d.h[j] >= p.tp1 : d.l[j] <= p.tp1;
          if (hitStop) { outcome = -1; break; }          // same-candle tie counts as a loss (conservative)
          if (hitTp) { outcome = 1; break; }
          if (j === i + cfg.horizon) outcome = ((d.c[j] - p.entry) * (side === 'long' ? 1 : -1)) / risk;
        }
        if (outcome === null) continue;                 // not enough future candles yet
        const b = res[side];
        if (outcome === 1) { b.w++; b.r += cfg.tp1Atr / cfg.stopAtr; }
        else if (outcome === -1) { b.l++; b.r -= 1; }
        else { b.x++; b.r += outcome; }
      }
    }
    return res;
  }

  function analyzeAsset(asset, candles, regimeMap, cfg) {
    const d = indicators(candles);
    const isCrypto = asset.kind === 'crypto' && asset.base !== 'BTC';
    const regimeAt = t => (isCrypto && regimeMap ? regimeMap.get(t) || 0 : 0);
    const i = d.c.length - 1;
    const now = scoreAt(d, i, regimeAt(d.t[i]));
    if (!now) return null;
    const prev = scoreAt(d, i - 1, regimeAt(d.t[i - 1])) || { long: 0, short: 0 };
    return {
      prevScore: { long: prev.long, short: prev.short },
      ...asset, price: asset.price ?? d.c[i], lastClose: d.c[i], closedAt: d.t[i], now,
      bt: backtest(d, regimeAt, cfg),
      spark: d.c.slice(-42),
      trend: d.c[i] > d.e120[i] ? 'up' : 'down',
    };
  }

  // Combine every asset's history into a market-wide rate, then blend it with each asset's own record.
  function rank(results, cfg, context) {
    const pool = { long: { w: 0, l: 0 }, short: { w: 0, l: 0 } };
    results.forEach(a => ['long', 'short'].forEach(s => { pool[s].w += a.bt[s].w; pool[s].l += a.bt[s].l; }));
    const poolRate = s => (pool[s].w + 1) / (pool[s].w + pool[s].l + 2);
    const signals = [];
    results.forEach(a => {
      for (const side of ['long', 'short']) {
        const b = a.bt[side], n = b.w + b.l;
        const prob = (b.w + cfg.priorWeight * poolRate(side)) / (n + cfg.priorWeight);
        const trades = b.w + b.l + b.x;
        a[side + 'Prob'] = prob;
        if (a.now[side] < cfg.minScore - 1) continue;
        const p = plan(side, a.lastClose, a.now.atr, cfg);
        const riskPerUnit = Math.abs(p.entry - p.stop);
        const riskUsd = cfg.accountSize * cfg.riskPct / 100;
        const qty = riskUsd / riskPerUnit;
        const notional = qty * p.entry;
        const warnings = [];
        if (context?.fng) {
          if (side === 'long' && context.fng.value >= 80) warnings.push('Market mood is extreme greed. Crowded longs often get flushed.');
          if (side === 'short' && context.fng.value <= 20) warnings.push('Market mood is extreme fear. Sharp bounces are common.');
        }
        const nTone = (context?.news || []).filter(n => n.tags.includes(a.base) || n.title.toUpperCase().includes(' ' + a.base + ' '));
        const toneSum = nTone.reduce((s, n) => s + n.tone, 0);
        if (side === 'long' && toneSum < 0) warnings.push('Recent headlines about this asset lean negative.');
        if (side === 'short' && toneSum > 0) warnings.push('Recent headlines about this asset lean positive.');
        if (n < 5) warnings.push(`Only ${n} past signals on this asset, so the estimate leans on the market-wide rate.`);
        signals.push({
          id: `${a.symbol}-${side}-${a.closedAt}`,
          asset: a, side, score: a.now[side], reasons: side === 'long' ? a.now.L : a.now.S,
          prob, history: { wins: b.w, losses: b.l, expired: b.x, trades, avgR: trades ? b.r / trades : 0 },
          plan: p, sizing: { riskUsd, qty, notional, leverage: notional / cfg.accountSize },
          headlines: nTone.slice(0, 3), warnings,
          grade: a.now[side] >= cfg.minScore && prob >= cfg.minProb ? 'go' : 'watch',
          fresh: (a.prevScore?.[side] ?? 0) < cfg.minScore,
        });
      }
    });
    signals.sort((x, y) => (y.grade === 'go') - (x.grade === 'go') || y.prob - x.prob || y.score - x.score);
    return { signals, pool: { long: poolRate('long'), short: poolRate('short'), longN: pool.long.w + pool.long.l, shortN: pool.short.w + pool.short.l } };
  }

  async function pool(items, n, fn, onProgress) {
    const out = new Array(items.length); let next = 0, done = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (next < items.length) {
        const k = next++;
        try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message, item: items[k] }; }
        done++; onProgress && onProgress(done, items.length);
      }
    }));
    return out;
  }

  const MACRO = [
    { label: 'Gold', binance: 'PAXGUSDT', twelve: 'XAU/USD', note: 'PAX Gold token, backed 1:1 by physical gold' },
    { label: 'EUR/USD (Dollar)', binance: 'EURUSDT', twelve: 'EUR/USD', note: 'A short here is a bet on a stronger US dollar' },
    { label: 'Crude Oil (WTI)', twelve: 'WTI/USD', note: 'Needs a free Twelve Data key in Settings' },
  ];

  async function scan(userCfg, onProgress) {
    const cfg = { ...DEFAULTS, ...userCfg };
    const step = (msg, f) => onProgress && onProgress(msg, f);
    step('Loading the top 100 coins on Binance', 0.02);
    const [tops, fng, headlines] = await Promise.all([topSymbols(100), fearGreed(), news(cfg.newsKey)]);
    step('Loading Bitcoin trend', 0.05);
    const btc = await binanceCandles('BTCUSDT', cfg.interval, cfg.candles);
    const regime = regimeSeries(btc);
    const coins = await pool(tops, 8, async a => {
      const cs = a.symbol === 'BTCUSDT' ? btc : await binanceCandles(a.symbol, cfg.interval, cfg.candles);
      if (cs.length < 200) return null;
      return analyzeAsset({ ...a, kind: 'crypto' }, cs, regime, cfg);
    }, (d, t) => step(`Reading charts ${d}/${t}`, 0.05 + 0.8 * d / t));

    step('Loading gold, dollar and oil', 0.88);
    const macro = [];
    for (const m of MACRO) {
      try {
        let cs;
        if (cfg.twelveKey && m.twelve) cs = await twelveCandles(m.twelve, cfg.twelveKey, cfg.candles);
        else if (m.binance) cs = await binanceCandles(m.binance, cfg.interval, cfg.candles);
        else { macro.push({ label: m.label, note: m.note, missing: true }); continue; }
        const r = analyzeAsset({ symbol: m.label, base: m.label, kind: 'macro', label: m.label, note: m.note }, cs, null, cfg);
        if (r) macro.push(r);
      } catch (e) { macro.push({ label: m.label, note: m.note, missing: true, error: e.message }); }
    }

    const ok = coins.filter(x => x && !x.error);
    const context = { fng, news: headlines };
    const ranked = rank(ok.concat(macro.filter(m => !m.missing)), cfg, context);
    step('Done', 1);
    return {
      at: Date.now(), cfg, fng, news: headlines, coins: ok, macro, ...ranked,
      failed: coins.filter(x => x && x.error).length,
    };
  }

  return { DEFAULTS, scan, indicators, scoreAt, backtest, analyzeAsset, rank, plan, regimeSeries, tone };
});
