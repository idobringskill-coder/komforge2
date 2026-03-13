require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();

// ── CORS ──
app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://komforge.vercel.app',
    /\.vercel\.app$/,
    /\.railway\.app$/
  ],
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SESSION ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'komforge-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// ── DATABASE ──
const db = new Database(process.env.DB_PATH || './komforge.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    plan TEXT DEFAULT 'beta',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── API KEYS ──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const ADMIN_KEY = process.env.KOMFORGE_ADMIN_KEY || 'KOMFORGE_ADMIN_2025';

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const tracker = require('./tracker');

const CRYPTO  = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'];
const FOREX   = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURJPY','GBPJPY','EURGBP','AUDJPY','EURAUD','GBPAUD','CADJPY','EURCAD','GBPCAD','CHFJPY','NZDJPY'];
const METALS  = ['XAUUSD','XAGUSD'];
const INDICES = ['US30','NAS100','SPX500','GER40','UK100','JPN225'];

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
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

async function fetchCryptoPrices() {
  try {
    const prices = {};
    for (const sym of ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT']) {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
      const d = await r.json();
      prices[sym] = parseFloat(d.price).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    broadcast({ type: 'ticker', prices });
  } catch(e) {}
}

setInterval(fetchCryptoPrices, 5000);
fetchCryptoPrices();
wss.on('connection', () => { fetchCryptoPrices(); });

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── AUTH ROUTES ──
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password, email, plan) VALUES (?, ?, ?, ?)').run(username, hash, email || null, 'beta');
    const user = { id: result.lastInsertRowid, username, plan: 'beta' };
    req.session.user = user;
    res.json({ success: true, user });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, row.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const user = { id: row.id, username: row.username, plan: row.plan, email: row.email };
    req.session.user = user;
    res.json({ success: true, user });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

app.post('/api/admin/create-user', async (req, res) => {
  try {
    const { username, password, email, plan, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already exists' });
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password, email, plan) VALUES (?, ?, ?, ?)').run(username, hash, email || null, plan || 'beta');
    res.json({ success: true, userId: result.lastInsertRowid, username, plan: plan || 'beta' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NEWS ──
async function fetchMarketNews(symbol, displaySymbol) {
  try {
    let query = '';
    if (['EURUSD','EURGBP','EURJPY','EURAUD','EURCAD'].includes(symbol)) {
      query = `Latest ECB European Central Bank decisions and EUR fundamental news today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    } else if (['GBPUSD','GBPJPY','GBPAUD','GBPCAD'].includes(symbol)) {
      query = `Latest Bank of England BOE decisions and GBP fundamental news today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    } else if (['USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'].includes(symbol)) {
      query = `Latest Federal Reserve Fed decisions and USD fundamental news today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    } else if (symbol === 'XAUUSD') {
      query = `Latest Gold XAU price drivers today ${new Date().toISOString().slice(0,10)}. Include Fed rate expectations, USD strength. 3 sentences max.`;
    } else if (symbol === 'XAGUSD') {
      query = `Latest Silver XAG price drivers today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    } else if (CRYPTO.includes(symbol)) {
      query = `Latest ${displaySymbol} crypto news today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    } else {
      query = `Latest news affecting ${displaySymbol} today ${new Date().toISOString().slice(0,10)}. 3 sentences max.`;
    }
    const r = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PERPLEXITY_API_KEY}` },
      body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }], max_tokens: 200 })
    });
    const data = await r.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e) {
    console.log('Perplexity error:', e.message);
    return null;
  }
}

// ── ANALYZE ──
app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    let { symbol, timeframe } = req.body;
    if (!symbol || !timeframe) return res.status(400).json({ error: 'Missing symbol or timeframe' });
    symbol = symbol.toUpperCase();
    timeframe = timeframe.toLowerCase();

    // Use absolute path for venv python3
    const pythonBin = process.env.PYTHON_BIN || 'python3';
    const cmd = `${pythonBin} analyze.py ${symbol} ${timeframe}`;
    let rawOutput;
    try {
      rawOutput = execSync(cmd, { cwd: __dirname, timeout: 30000 }).toString().trim();
    } catch(e) {
      const errOut = e.stdout?.toString() || e.stderr?.toString() || e.message;
      try { return res.status(500).json({ error: JSON.parse(errOut).error }); }
      catch { return res.status(500).json({ error: errOut }); }
    }

    const market = JSON.parse(rawOutput);
    if (market.error) return res.status(500).json({ error: market.error });

    const displaySymbol = formatSymbolDisplay(symbol);
    const marketType = getMarketType(symbol);
    const newsContext = await fetchMarketNews(symbol, displaySymbol);
    const confluenceList = (market.confluence_reasons || []).join('\n- ');

    const prompt = `You are KOM FORGE, an elite institutional trading analyst with 20+ years experience.

Market: ${displaySymbol} | Timeframe: ${timeframe.toUpperCase()} | Type: ${marketType}

TECHNICAL DATA:
- Price: ${market.current_price}
- Trend: ${market.trend}
- Market Structure: ${market.market_structure}
- Price vs EMA200: ${market.price_vs_ema200}

EMAs: EMA20: ${market.ema20} | EMA50: ${market.ema50} | EMA200: ${market.ema200}

MOMENTUM:
- RSI(14): ${market.rsi} ${market.rsi > 70 ? '⚠️ OVERBOUGHT' : market.rsi < 30 ? '⚠️ OVERSOLD' : '(neutral)'}
- Stoch RSI K: ${market.stoch_rsi_k} | D: ${market.stoch_rsi_d}
- MACD: ${market.macd_signal} | Histogram: ${market.macd_histogram} | Momentum increasing: ${market.macd_increasing}

BOLLINGER BANDS:
- Upper: ${market.bb_upper} | Mid: ${market.bb_middle} | Lower: ${market.bb_lower}
- Width: ${market.bb_width}% | Position: ${market.bb_position} | Squeeze: ${market.bb_squeeze}

VOLUME: Relative Volume: ${market.relative_volume}x | Signal: ${market.volume_signal}

LEVELS:
- Support: ${market.nearest_support} | Resistance: ${market.nearest_resistance}
- ATR: ${market.atr} | Volatility: ${market.volatility}

DYNAMIC TP/SL (ATR-based, R:R 1:2):
- If BUY → TP: ${market.tp_buy} | SL: ${market.sl_buy}
- If SELL → TP: ${market.tp_sell} | SL: ${market.sl_sell}

PRE-ANALYSIS (${market.confluence_count} confluences):
- System suggestion: ${market.action_hint} (Bull: ${market.bull_score} / Bear: ${market.bear_score})
- Key observation: ${market.key_observation}
- Confluences:\n${confluenceList ? '- ' + confluenceList : '- None strong enough'}

${newsContext ? `FUNDAMENTAL NEWS (Real Time):\n${newsContext}` : ''}

STRICT RULES:
1. BUY only if: uptrend + price above EMA200 + MACD bullish + at least 3 confluences
2. SELL only if: downtrend + price below EMA200 + MACD bearish + at least 3 confluences
3. WAIT if: RSI 40-60 no strong confluence, OR volume weak < 0.7x, OR signals conflicting
4. If BB squeeze detected → mention breakout setup
5. Use dynamic TP/SL from ATR if no better S/R levels
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
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });

    const claudeData = await claudeRes.json();
    if (!claudeData.content?.[0]) return res.status(500).json({ error: 'Claude API failed' });

    let signalText = claudeData.content[0].text.trim().replace(/```json|```/g, '').trim();
    const signal = JSON.parse(signalText);

    const now = new Date();
    const date = now.toLocaleDateString('fr-FR', { timeZone: 'Indian/Mauritius' });
    const time = now.toLocaleTimeString('en-GB', { timeZone: 'Indian/Mauritius', hour12: false });

    const result = { symbol: displaySymbol, rawSymbol: symbol, timeframe, marketType, date, time, market, signal, news: newsContext || null };

    if (signal.action !== 'WAIT' && signal.entry && signal.stop_loss && signal.take_profit_1) {
      tracker.recordSignal(symbol, timeframe, signal.action, signal.entry, signal.stop_loss, signal.take_profit_1, signal.confidence);
    }

    signalHistory.unshift(result);
    if (signalHistory.length > 50) signalHistory = signalHistory.slice(0, 50);

    broadcast({ type: 'signal', data: result });
    console.log(`✅ Signal: ${signal.action} | ${displaySymbol} ${timeframe} | Confidence: ${signal.confidence}% | User: ${req.session.user.username}`);
    res.json(result);

  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/signals', requireAuth, (req, res) => res.json(signalHistory));
app.get('/api/tracker/stats', requireAuth, (req, res) => res.json(tracker.getStats()));
app.get('/api/tracker/signals', requireAuth, (req, res) => res.json(tracker.getRecentSignals(50)));

setInterval(async () => {
  try {
    const stats = await tracker.checkPendingSignals();
    if (stats) console.log('Tracker update:', stats);
  } catch(e) {}
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ⚡ KOM FORGE v2.2 running on port ${PORT}\n  🔐 Auth enabled · 📡 WebSocket · 🤖 Claude + Perplexity\n`);
});
