// Background scanner: runs the same engine as the app and pushes new signals to your phone with ntfy.
// Run by GitHub Actions a few minutes after every 4-hour candle closes (see .github/workflows/scan.yml).
import { createRequire } from 'node:module';
const MC = createRequire(import.meta.url)('./engine.js');

const env = process.env;
const topic = env.NTFY_TOPIC;
if (!topic) { console.error('Set the NTFY_TOPIC secret first.'); process.exit(1); }

const cfg = {
  accountSize: +(env.ACCOUNT_SIZE || 100), riskPct: +(env.RISK_PCT || 1),
  minScore: +(env.MIN_SCORE || 7), minProb: +(env.MIN_PROB || 60) / 100,
  twelveKey: env.TWELVE_KEY || '', newsKey: env.NEWS_KEY || '',
};
const fmt = p => { const a = Math.abs(p); return p.toFixed(a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8); };

const res = await MC.scan(cfg, msg => console.log(msg));
const fresh = res.signals.filter(s => s.grade === 'go' && s.fresh);
console.log(`Scanned ${res.coins.length} coins. ${res.signals.filter(s => s.grade === 'go').length} meet the filter, ${fresh.length} are new.`);

async function push(title, body, tags, click) {
  const r = await fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
    method: 'POST', body,
    headers: { Title: title, Tags: tags, Priority: '4', ...(click ? { Click: click } : {}), ...(env.APP_URL ? { Actions: `view, Open app, ${env.APP_URL}` } : {}) },
  });
  if (!r.ok) console.error('ntfy error', r.status, await r.text());
}

for (const s of fresh.slice(0, 8)) {
  const p = s.plan, a = s.asset;
  const title = `${s.side.toUpperCase()} ${a.base} · ${Math.round(s.prob * 100)}% hit chance · ${s.score}/10`;
  const body = [
    `Entry ${fmt(p.entry)}  Stop ${fmt(p.stop)}`,
    `Target 1 ${fmt(p.tp1)}  Target 2 ${fmt(p.tp2)}`,
    `Past 80 days: ${s.history.wins}W / ${s.history.losses}L`,
    `Size for ${cfg.riskPct}% risk: ${s.sizing.qty.toPrecision(4)} (~$${s.sizing.notional.toFixed(0)})`,
    ...s.warnings.map(w => '⚠ ' + w),
  ].join('\n');
  const click = a.kind === 'crypto' ? `https://www.tradingview.com/chart/?symbol=BINANCE:${a.symbol}` : '';
  await push(title, body, s.side === 'long' ? 'green_circle' : 'red_circle', click);
}

if (env.DAILY_SUMMARY === '1' && new Date().getUTCHours() < 4) {
  const btc = res.coins.find(c => c.base === 'BTC');
  const top = res.signals.filter(s => s.grade === 'go').slice(0, 5).map(s => `${s.side === 'long' ? '▲' : '▼'} ${s.asset.base} ${Math.round(s.prob * 100)}%`).join('\n') || 'No setups meet your filter.';
  await push('Market Compass daily summary', `BTC ${btc?.trend || '?'}trend · Mood ${res.fng ? res.fng.value + ' ' + res.fng.label : 'n/a'}\n${top}`, 'compass', env.APP_URL || '');
}
