const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const tracker = require('./tracker');
const ANTHROPIC_API_KEY = 'process.env.ANTHROPIC_API_KEY';
const PERPLEXITY_API_KEY = 'process.env.PERPLEXITY_API_KEY';

const CRYPTO   = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'];
const FOREX    = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURJPY','GBPJPY','EURGBP','AUDJPY','EURAUD','GBPAUD','CADJPY','EURCAD','GBPCAD','CHFJPY','NZDJPY'];
const METALS   = ['XAUUSD','XAGUSD'];
const INDICES  = ['US30','NAS100','SPX500','GER40','UK100','JPN225'];

function formatSymbolDisplay(symbol) {
  if (CRYPTO.includes(symbol)) return symbol.replace('USDT', '/USDT');
  if (symbol.length === 6) return symbol.slice(0,3) + '/' + symbol.slice(3);
  return symbol;
}

function getMarketType(symbol) {
  if (CRYPTO.includes(symbol)) return 'Crypto · Binance';
  if (FOREX.includes(symbol)) return 'Forex · Twelve Data';
  if (METALS.includes(symbol)) return 'Metals · Twelve Data';
  if (INDICES.includes(symbol)) return 'Index · Twelve Data';
  return 'Market';
}

let signalHistory = [];

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

async function fetchCryptoPrices() {
  try {
    const prices = {};
    for (const sym of ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT']) {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
      const d = await r.json();
      prices[sym] = parseFloat(d.price).toLocaleString('en-US', {maximumFractionDigits: 2});
    }
    broadcast({ type: 'ticker', prices });
  } catch(e) {}
}

setInterval(fetchCryptoPrices, 5000);
fetchCryptoPrices();

wss.on('connection', () => { fetchCryptoPrices(); });

// Fetch market news from Perplexity
async function fetchMarketNews(symbol, displaySymbol) {
  try {
    let query = '';
    if (['EURUSD','EURGBP','EURJPY','EURAUD','EURCAD'].includes(symbol)) {
      query = `Latest ECB European Central Bank decisions and EUR/USD fundamental news today ${new Date().toISOString().slice(0,10)}. Include ECB rate decisions, inflation data, Euro zone economic data. 3 sentences max.`;
    } else if (['GBPUSD','GBPJPY','GBPAUD','GBPCAD'].includes(symbol)) {
      query = `Latest Bank of England BOE decisions and GBP fundamental news today ${new Date().toISOString().slice(0,10)}. Include BOE rate decisions, UK inflation, economic data. 3 sentences max.`;
    } else if (['USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'].includes(symbol)) {
      query = `Latest Federal Reserve Fed decisions and USD fundamental news today ${new Date().toISOString().slice(0,10)}. Include Fed rate decisions, US inflation CPI, NFP jobs data. 3 sentences max.`;
    } else if (symbol === 'XAUUSD') {
      query = `Latest Gold XAU price drivers today ${new Date().toISOString().slice(0,10)}. Include Fed rate expectations, USD strength, safe haven demand, inflation data. 3 sentences max.`;
    } else if (symbol === 'XAGUSD') {
      query = `Latest Silver XAG price drivers today ${new Date().toISOString().slice(0,10)}. Include industrial demand, Fed policy, USD strength. 3 sentences max.`;
    } else if (['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'].includes(symbol)) {
      query = `Latest ${displaySymbol} crypto news today ${new Date().toISOString().slice(0,10)}. Include regulatory news, institutional flows, market sentiment. 3 sentences max.`;
    } else if (['US30','NAS100','SPX500'].includes(symbol)) {
      query = `Latest US stock market ${displaySymbol} news today ${new Date().toISOString().slice(0,10)}. Include Fed policy, earnings, economic data impact. 3 sentences max.`;
    } else {
      query = `Latest news and fundamental factors affecting ${displaySymbol} today ${new Date().toISOString().slice(0,10)}. Include central bank decisions, economic data. 3 sentences max.`;
    }

    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: query }],
        max_tokens: 200
      })
    });

    const data = await r.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e) {
    console.log('Perplexity error:', e.message);
    return null;
  }
}

app.post('/api/analyze', async (req, res) => {
  try {
    let { symbol, timeframe } = req.body;
    if (!symbol || !timeframe) return res.status(400).json({ error: 'Missing symbol or timeframe' });
    symbol = symbol.toUpperCase();
    timeframe = timeframe.toLowerCase();

    const cmd = `python3 analyze.py ${symbol} ${timeframe}`;
    let rawOutput;
    try {
      rawOutput = execSync(cmd, { cwd: __dirname, timeout: 30000 }).toString().trim();
    } catch (e) {
      const errOut = e.stdout?.toString() || e.stderr?.toString() || e.message;
      try { return res.status(500).json({ error: JSON.parse(errOut).error }); }
      catch { return res.status(500).json({ error: errOut }); }
    }

    const market = JSON.parse(rawOutput);
    if (market.error) return res.status(500).json({ error: market.error });

    const displaySymbol = formatSymbolDisplay(symbol);
    const marketType = getMarketType(symbol);

    // Fetch news from Perplexity in parallel
    const newsContext = await fetchMarketNews(symbol, displaySymbol);
    console.log(`📰 News for ${displaySymbol}: ${newsContext ? 'fetched' : 'unavailable'}`);

    // ── Build enriched prompt with ALL new data from analyze.py ──
    const confluenceList = (market.confluence_reasons || []).join('\n- ');

    const prompt = `You are KOM FORGE, an elite institutional trading analyst with 20+ years experience.

Market: ${displaySymbol} | Timeframe: ${timeframe.toUpperCase()} | Type: ${marketType}

TECHNICAL DATA:
- Price: ${market.current_price}
- Trend: ${market.trend}
- Market Structure: ${market.market_structure}
- Price vs EMA200: ${market.price_vs_ema200}

EMAs:
- EMA20: ${market.ema20} | EMA50: ${market.ema50} | EMA200: ${market.ema200}

MOMENTUM:
- RSI(14): ${market.rsi} ${market.rsi > 70 ? '⚠️ OVERBOUGHT' : market.rsi < 30 ? '⚠️ OVERSOLD' : '(neutral)'}
- Stoch RSI K: ${market.stoch_rsi_k} | D: ${market.stoch_rsi_d}
- MACD: ${market.macd_signal} | Histogram: ${market.macd_histogram} | Momentum increasing: ${market.macd_increasing}

BOLLINGER BANDS:
- Upper: ${market.bb_upper} | Mid: ${market.bb_middle} | Lower: ${market.bb_lower}
- Width: ${market.bb_width}% | Position: ${market.bb_position} | Squeeze: ${market.bb_squeeze}

VOLUME:
- Relative Volume: ${market.relative_volume}x average | Signal: ${market.volume_signal}

LEVELS:
- Support: ${market.nearest_support} | Resistance: ${market.nearest_resistance}
- ATR: ${market.atr} | Volatility: ${market.volatility}

DYNAMIC TP/SL (ATR-based, R:R 1:2):
- If BUY → TP: ${market.tp_buy} | SL: ${market.sl_buy}
- If SELL → TP: ${market.tp_sell} | SL: ${market.sl_sell}

PRE-ANALYSIS (${market.confluence_count} confluences detected):
- System suggestion: ${market.action_hint} (Bull: ${market.bull_score} / Bear: ${market.bear_score})
- Key observation: ${market.key_observation}
- Confluences:
${confluenceList ? '- ' + confluenceList : '- None strong enough'}

${newsContext ? `FUNDAMENTAL NEWS (Perplexity AI - Real Time):
${newsContext}` : ''}

STRICT RULES:
1. BUY only if: uptrend + price above EMA200 + MACD bullish + at least 3 confluences
2. SELL only if: downtrend + price below EMA200 + MACD bearish + at least 3 confluences
3. WAIT if: RSI between 40-60 with no strong confluence, OR volume weak (< 0.7x), OR signals conflicting
4. If BB squeeze detected → mention breakout setup in explanation
5. Use the dynamic TP/SL from ATR if no better S/R levels available
6. If news contradicts technicals → prefer WAIT
7. Risk/Reward minimum 1:1.5
8. Respond ONLY with valid JSON

{
  "action": "BUY" or "SELL" or "WAIT",
  "confidence": 0-100,
  "entry": "price or null",
  "stop_loss": "price or null",
  "take_profit_1": "price or null",
  "take_profit_2": "price or null",
  "risk_reward": "e.g. 1:2.3 or null",
  "setup": "short setup name",
  "explanation": "2-3 precise sentences combining technical + fundamental",
  "invalidation": "what invalidates this setup",
  "news_sentiment": "bullish" or "bearish" or "neutral" or "mixed"
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content?.[0]) return res.status(500).json({ error: 'Claude API failed' });

    let signalText = claudeData.content[0].text.trim().replace(/```json|```/g, '').trim();
    const signal = JSON.parse(signalText);

    const now = new Date();
    const date = now.toLocaleDateString('fr-FR', { timeZone: 'Indian/Mauritius' });
    const time = now.toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius', hour12: false });

    const result = {
      symbol: displaySymbol, rawSymbol: symbol, timeframe, marketType,
      date, time, market, signal,
      news: newsContext || null
    };

    // Track signal for live win rate
    if (signal.action !== 'WAIT' && signal.entry && signal.stop_loss && signal.take_profit_1) {
      tracker.recordSignal(symbol, timeframe, signal.action, signal.entry, signal.stop_loss, signal.take_profit_1, signal.confidence);
    }

    signalHistory.unshift(result);
    if (signalHistory.length > 50) signalHistory = signalHistory.slice(0, 50);

    broadcast({ type: 'signal', data: result });
    console.log(`Signal: ${signal.action} | ${displaySymbol} ${timeframe} | Confidence: ${signal.confidence}% | Confluences: ${market.confluence_count} | News: ${signal.news_sentiment || 'N/A'}`);
    res.json(result);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals', (req, res) => res.json(signalHistory));

// Check pending signals every 30 minutes
setInterval(async () => {
  try {
    const stats = await tracker.checkPendingSignals();
    if (stats) console.log('Tracker update:', stats);
  } catch(e) {}
}, 30 * 60 * 1000);

// Tracker API endpoints
app.get('/api/tracker/stats', (req, res) => res.json(tracker.getStats()));
app.get('/api/tracker/signals', (req, res) => res.json(tracker.getRecentSignals(50)));

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚡ KOM FORGE v2.2 running on http://localhost:${PORT}\n  📡 WebSocket + Perplexity AI + Enhanced Analysis enabled\n`);
});
