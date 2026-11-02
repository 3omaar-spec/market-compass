# Market Compass

An iPhone web app that reads the 100 most-traded coins on Binance plus gold, the euro/dollar rate and oil. It scores each one every 4 hours and recommends positions with entry, stop, two targets, a position size, and the setup's real track record over the last ~80 days.

## What's in the folder

| File | What it does |
|---|---|
| `index.html` | The app |
| `engine.js` | Signal engine (indicators, scoring, backtest, sizing), used by the app and the scanner |
| `sw.js`, `manifest.json`, `icon-*.png` | Let the app install on your Home Screen and show notifications |
| `scanner.mjs` + `.github/workflows/scan.yml` | Free background scanner that pushes new signals to your phone every 4 hours, even when the app is closed |

## 1. Put the app online (free, about 10 minutes)

1. Create a free account at github.com.
2. Create a new **public** repository, for example `market-compass`.
3. Tap **Add file → Upload files** and upload every file in this folder except `.github`.
4. Tap **Add file → Create new file**, name it `.github/workflows/scan.yml` and paste in the contents of that file.
5. Go to **Settings → Pages**, set Source to **Deploy from a branch**, pick `main` and `/ (root)`, then tap Save.
6. After a minute your app is live at `https://YOUR-NAME.github.io/market-compass/`.

## 2. Install it on your iPhone

1. Open that link in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open Market Compass from the Home Screen, go to **Settings** and tap **Turn on notifications**.

The app re-scans while it's open. iPhone pauses web apps in the background, so for alerts while it's closed, do step 3.

## 3. Background alerts (free)

1. Install the **ntfy** app from the App Store.
2. In ntfy, tap **+** and subscribe to a topic with a long random name nobody can guess, for example `compass-7f3k29xq`.
3. In your GitHub repository go to **Settings → Secrets and variables → Actions**:
   - Under **Secrets**, add `NTFY_TOPIC` = your topic name.
   - Optional secrets: `TWELVE_KEY` (oil and spot gold, free at twelvedata.com) and `NEWS_KEY` (headlines, free at cryptocompare.com).
   - Optional **Variables**: `APP_URL` (your app link), `ACCOUNT_SIZE` (default 100), `RISK_PCT` (default 1), `MIN_SCORE` (default 7), `MIN_PROB` (default 60).
4. Go to **Actions → Market scan → Run workflow** to test it.

From then on it runs 7 minutes after every 4-hour candle closes (00:07, 04:07, 08:07 … UTC). You get a push only when a setup **newly** meets your filter, plus one daily summary.

## How a recommendation is made

1. **Universe:** the top 100 USDT pairs on Binance by 24-hour trading volume. Stablecoins, wrapped tokens and leveraged tokens are excluded.
2. **Score (0–10)** on the last *closed* 4-hour candle, from 8 checks:
   - 20-day trend (EMA 120), medium trend (EMA 50) and short trend (EMA 20)
   - MACD momentum
   - RSI with room to run (penalised when overbought or oversold)
   - ADX trend strength
   - volume above normal
   - not chasing (close to the 20-period average)
   - Bitcoin's own trend (crypto only)
3. **Trade plan:** stop = 1.5 × ATR. Target 1 = 1.5 × ATR (1:1). Target 2 = 3 × ATR (2:1). The trade gets 3 days.
4. **Hit chance:** the same rule is replayed on the last ~80 days of that asset. The figure is the share of past signals where Target 1 was hit before the stop, blended with the rate across all assets so a coin with few past signals isn't over-trusted. If the stop and the target both fall inside one candle, it counts as a loss.
5. **Context warnings:** the Fear & Greed index and headline tone flag crowded or risky trades.
6. **Position size:** sized so that a stopped-out trade loses exactly your chosen risk % of the account.

## Honest limits

- Hit chance is a historical average, not a promise. Expect losing streaks.
- Results ignore fees (about 0.1% per side) and slippage.
- Some days nothing qualifies. That's the filter working.
- Oil needs the free Twelve Data key. Without it, gold uses the PAXG token and the dollar uses Binance's EUR/USDT pair.
- If Binance is blocked in your country, the app tries backup Binance hosts. If all of them fail, a scan will show an error.

This is an information tool, not financial advice.
