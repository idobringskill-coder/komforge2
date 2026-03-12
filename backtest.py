import sys
import json
import requests
import pandas as pd
import numpy as np
from datetime import datetime

TWELVE_DATA_KEY = "d47da60966684915bebbb5a15b9ff795"

BINANCE_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","DOGEUSDT"]
TWELVE_DATA_SYMBOLS = {
    "EURUSD":"EUR/USD","GBPUSD":"GBP/USD","USDJPY":"USD/JPY",
    "XAUUSD":"XAU/USD","XAGUSD":"XAG/USD",
    "US30":"DJI","NAS100":"NDX","SPX500":"SPX"
}

def fetch_binance(symbol, timeframe="1h", limit=500):
    tf_map = {"1h":"1h","4h":"4h","1d":"1d"}
    tf = tf_map.get(timeframe, "1h")
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={tf}&limit={limit}"
    r = requests.get(url, timeout=15)
    data = r.json()
    df = pd.DataFrame(data, columns=["time","open","high","low","close","volume","ct","qv","t","tbb","tbq","i"])
    df[["open","high","low","close","volume"]] = df[["open","high","low","close","volume"]].astype(float)
    return df

def fetch_twelvedata(symbol_key, timeframe="1h", limit=500):
    td_symbol = TWELVE_DATA_SYMBOLS.get(symbol_key)
    tf_map = {"1h":"1h","4h":"4h","1d":"1day"}
    tf = tf_map.get(timeframe, "1h")
    url = f"https://api.twelvedata.com/time_series?symbol={td_symbol}&interval={tf}&outputsize={limit}&apikey={TWELVE_DATA_KEY}"
    r = requests.get(url, timeout=15)
    data = r.json()
    if "values" not in data:
        raise Exception(f"No data: {data.get('message','unknown')}")
    df = pd.DataFrame(data["values"])
    df = df.rename(columns={"datetime":"time"})
    df[["open","high","low","close"]] = df[["open","high","low","close"]].astype(float)
    if "volume" not in df.columns:
        df["volume"] = 0
    df = df.iloc[::-1].reset_index(drop=True)
    return df

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()

def rsi_wilder(s, n=14):
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.rolling(window=n, min_periods=n).mean()
    avg_loss = loss.rolling(window=n, min_periods=n).mean()
    for i in range(n, len(avg_gain)):
        avg_gain.iloc[i] = (avg_gain.iloc[i-1] * (n-1) + gain.iloc[i]) / n
        avg_loss.iloc[i] = (avg_loss.iloc[i-1] * (n-1) + loss.iloc[i]) / n
    rs = avg_gain / avg_loss.replace(0, 1e-10)
    return (100 - (100 / (1 + rs))).fillna(50)

def macd_calc(s, f=12, sl=26, sig=9):
    ml = ema(s,f) - ema(s,sl)
    sl2 = ema(ml, sig)
    return ml, sl2

def atr_calc(df, n=14):
    h, l, c = df["high"], df["low"], df["close"]
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()

def generate_signal(df, i):
    """Generate signal at bar i using previous data only"""
    if i < 210:
        return None
    
    subset = df.iloc[:i+1].copy()
    c = subset["close"]
    
    e20 = float(ema(c, 20).iloc[-1])
    e50 = float(ema(c, 50).iloc[-1])
    e200 = float(ema(c, 200).iloc[-1])
    price = float(c.iloc[-1])
    
    ml, sl2 = macd_calc(c)
    macd_bull = float(ml.iloc[-1]) > float(sl2.iloc[-1])
    
    at = float(atr_calc(subset).iloc[-1])
    
    # Bull/Bear scoring (same as analyze.py)
    bull = 0; bear = 0
    if price > e20: bull += 2
    else: bear += 2
    if price > e50: bull += 3
    else: bear += 3
    if price > e200: bull += 2
    else: bear += 2
    if e20 > e50: bull += 2
    else: bear += 2
    if macd_bull: bull += 3
    else: bear += 3
    
    total = bull + bear
    bull_pct = (bull / total) * 100 if total > 0 else 50
    
    # Generate action
    if bull_pct >= 60:
        action = "BUY"
    elif bull_pct <= 40:
        action = "SELL"
    else:
        return None  # WAIT — skip
    
    # Calculate TP and SL
    sl_dist = at * 1.5
    tp1_dist = at * 1.5
    tp2_dist = at * 3
    
    if action == "BUY":
        sl = price - sl_dist
        tp1 = price + tp1_dist
        tp2 = price + tp2_dist
    else:
        sl = price + sl_dist
        tp1 = price - tp1_dist
        tp2 = price - tp2_dist
    
    return {
        "action": action,
        "entry": price,
        "sl": sl,
        "tp1": tp1,
        "tp2": tp2,
        "atr": at
    }

def evaluate_trade(df, signal_idx, signal):
    """Check if trade hit TP1 or SL in next 20 candles"""
    action = signal["action"]
    entry = signal["entry"]
    sl = signal["sl"]
    tp1 = signal["tp1"]
    
    future = df.iloc[signal_idx+1:signal_idx+21]
    
    for _, candle in future.iterrows():
        high = candle["high"]
        low = candle["low"]
        
        if action == "BUY":
            if low <= sl:
                return "LOSS", abs(entry - sl)
            if high >= tp1:
                return "WIN", abs(tp1 - entry)
        else:  # SELL
            if high >= sl:
                return "LOSS", abs(entry - sl)
            if low <= tp1:
                return "WIN", abs(tp1 - entry)
    
    return "TIMEOUT", 0

def backtest(symbol, timeframe="1h"):
    print(f"\n{'='*50}")
    print(f"BACKTEST: {symbol} {timeframe.upper()}")
    print(f"{'='*50}")
    
    # Fetch data
    try:
        if symbol in BINANCE_SYMBOLS:
            df = fetch_binance(symbol, timeframe, limit=500)
        else:
            df = fetch_twelvedata(symbol, timeframe, limit=500)
    except Exception as e:
        print(f"Error fetching data: {e}")
        return None
    
    print(f"Data: {len(df)} candles")
    
    trades = []
    wins = 0; losses = 0; timeouts = 0
    total_profit = 0; total_loss = 0
    
    # Walk forward — generate signal every 5 bars to avoid overlap
    step = 5
    for i in range(210, len(df) - 21, step):
        signal = generate_signal(df, i)
        if signal is None:
            continue
        
        result, pnl = evaluate_trade(df, i, signal)
        
        trade = {
            "idx": i,
            "action": signal["action"],
            "entry": round(signal["entry"], 5),
            "result": result,
            "pnl": round(pnl, 5)
        }
        trades.append(trade)
        
        if result == "WIN":
            wins += 1
            total_profit += pnl
        elif result == "LOSS":
            losses += 1
            total_loss += pnl
        else:
            timeouts += 1
    
    total_trades = wins + losses
    win_rate = (wins / total_trades * 100) if total_trades > 0 else 0
    profit_factor = (total_profit / total_loss) if total_loss > 0 else 999
    
    results = {
        "symbol": symbol,
        "timeframe": timeframe,
        "total_signals": len(trades),
        "total_trades": total_trades,
        "wins": wins,
        "losses": losses,
        "timeouts": timeouts,
        "win_rate": round(win_rate, 1),
        "profit_factor": round(profit_factor, 2)
    }
    
    print(f"Total Signals : {len(trades)}")
    print(f"Trades (W+L)  : {total_trades}")
    print(f"Wins          : {wins}")
    print(f"Losses        : {losses}")
    print(f"Timeouts      : {timeouts}")
    print(f"WIN RATE      : {win_rate:.1f}%")
    print(f"Profit Factor : {profit_factor:.2f}")
    
    return results

if __name__ == "__main__":
    symbols = ["BTCUSDT", "ETHUSDT", "EURUSD", "GBPUSD", "XAUUSD"]
    timeframe = sys.argv[1] if len(sys.argv) > 1 else "1h"
    
    all_results = []
    for sym in symbols:
        try:
            r = backtest(sym, timeframe)
            if r:
                all_results.append(r)
        except Exception as e:
            print(f"Error {sym}: {e}")
    
    if all_results:
        print(f"\n{'='*50}")
        print("SUMMARY")
        print(f"{'='*50}")
        total_wins = sum(r["wins"] for r in all_results)
        total_losses = sum(r["losses"] for r in all_results)
        total_trades = total_wins + total_losses
        overall_wr = (total_wins / total_trades * 100) if total_trades > 0 else 0
        print(f"Overall Win Rate: {overall_wr:.1f}%")
        print(f"Total Trades    : {total_trades}")
        for r in all_results:
            print(f"  {r['symbol']:10} {r['win_rate']:5.1f}% ({r['wins']}W/{r['losses']}L)")