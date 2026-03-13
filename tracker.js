const fs = require('fs');
const path = require('path');

const TRACKER_FILE = path.join(__dirname, 'signal_tracker.json');

function loadTracker() {
  try {
    if (fs.existsSync(TRACKER_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
    }
  } catch(e) {}
  return { signals: [], stats: { total: 0, wins: 0, losses: 0, pending: 0, win_rate: 0 } };
}

function saveTracker(data) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
}

function recordSignal(symbol, timeframe, action, entry, sl, tp1, confidence) {
  if (action === 'WAIT') return null;
  const tracker = loadTracker();
  const id = Date.now().toString();
  const signal = {
    id, symbol, timeframe, action,
    entry: parseFloat(entry),
    sl: parseFloat(sl),
    tp1: parseFloat(tp1),
    confidence,
    timestamp: new Date().toISOString(),
    status: 'PENDING',
    result: null,
    checked_at: null
  };
  tracker.signals.unshift(signal);
  if (tracker.signals.length > 200) tracker.signals = tracker.signals.slice(0, 200);
  tracker.stats.pending = tracker.signals.filter(s => s.status === 'PENDING').length;
  saveTracker(tracker);
  console.log(`📊 Signal recorded: ${action} ${symbol} | Entry: ${entry} | TP: ${tp1} | SL: ${sl}`);
  return id;
}

async function checkPendingSignals() {
  const tracker = loadTracker();
  const pending = tracker.signals.filter(s => s.status === 'PENDING');
  if (pending.length === 0) return tracker.stats;

  const BINANCE = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT'];
  const TWELVE_MAP = {
    'EURUSD':'EUR/USD','GBPUSD':'GBP/USD','USDJPY':'USD/JPY','AUDUSD':'AUD/USD',
    'USDCAD':'USD/CAD','USDCHF':'USD/CHF','NZDUSD':'NZD/USD','EURJPY':'EUR/JPY',
    'GBPJPY':'GBP/JPY','EURGBP':'EUR/GBP','AUDJPY':'AUD/JPY','EURCAD':'EUR/CAD',
    'XAUUSD':'XAU/USD','XAGUSD':'XAG/USD',
    'US30':'DJI','NAS100':'NDX','SPX500':'SPX','GER40':'DAX','UK100':'FTSE','JPN225':'N225'
  };
  const TWELVE_KEY = process.env.TWELVE_DATA_API_KEY || 'd47da60966684915bebbb5a15b9ff795';

  for (const sig of pending) {
    try {
      const age = (Date.now() - new Date(sig.timestamp).getTime()) / 1000 / 60;
      if (age < 15) continue;

      let currentPrice = null;

      if (BINANCE.includes(sig.symbol)) {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sig.symbol}`);
        const d = await r.json();
        currentPrice = parseFloat(d.price);
      } else if (TWELVE_MAP[sig.symbol]) {
        const td = TWELVE_MAP[sig.symbol];
        const r = await fetch(`https://api.twelvedata.com/price?symbol=${td}&apikey=${TWELVE_KEY}`);
        const d = await r.json();
        currentPrice = parseFloat(d.price);
      }

      if (!currentPrice) continue;

      let result = null;
      if (sig.action === 'BUY') {
        if (currentPrice >= sig.tp1) result = 'WIN';
        else if (currentPrice <= sig.sl) result = 'LOSS';
      } else if (sig.action === 'SELL') {
        if (currentPrice <= sig.tp1) result = 'WIN';
        else if (currentPrice >= sig.sl) result = 'LOSS';
      }

      if (!result && age > 1440) {
        result = currentPrice > sig.entry
          ? (sig.action === 'BUY' ? 'WIN' : 'LOSS')
          : (sig.action === 'SELL' ? 'WIN' : 'LOSS');
      }

      if (result) {
        sig.status = 'CLOSED';
        sig.result = result;
        sig.exit_price = currentPrice;
        sig.checked_at = new Date().toISOString();
        console.log(`✅ Signal closed: ${sig.action} ${sig.symbol} → ${result} | Exit: ${currentPrice}`);
      }

    } catch(e) {
      console.log(`Tracker check error ${sig.symbol}:`, e.message);
    }
  }

  const closed = tracker.signals.filter(s => s.status === 'CLOSED');
  tracker.stats = {
    total: closed.length,
    wins: closed.filter(s => s.result === 'WIN').length,
    losses: closed.filter(s => s.result === 'LOSS').length,
    pending: tracker.signals.filter(s => s.status === 'PENDING').length,
    win_rate: closed.length > 0
      ? Math.round(closed.filter(s => s.result === 'WIN').length / closed.length * 100)
      : 0
  };

  saveTracker(tracker);
  return tracker.stats;
}

function getStats() {
  return loadTracker().stats;
}

function getRecentSignals(n = 20) {
  return loadTracker().signals.slice(0, n);
}

module.exports = { recordSignal, checkPendingSignals, getStats, getRecentSignals };
