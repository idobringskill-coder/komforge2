import sys
import json
import requests
import pandas as pd
import numpy as np

TWELVE_DATA_KEY = "d47da60966684915bebbb5a15b9ff795"

BINANCE_SYMBOLS = [
    "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT",
    "XRPUSDT","ADAUSDT","DOGEUSDT"
]

TWELVE_DATA_SYMBOLS = {
    "EURUSD":"EUR/USD","GBPUSD":"GBP/USD","USDJPY":"USD/JPY",
    "AUDUSD":"AUD/USD","USDCAD":"USD/CAD","USDCHF":"USD/CHF","NZDUSD":"NZD/USD",
    "EURJPY":"EUR/JPY","GBPJPY":"GBP/JPY","EURGBP":"EUR/GBP",
    "AUDJPY":"AUD/JPY","EURAUD":"EUR/AUD","GBPAUD":"GBP/AUD",
    "CADJPY":"CAD/JPY","EURCAD":"EUR/CAD","GBPCAD":"GBP/CAD",
    "CHFJPY":"CHF/JPY","NZDJPY":"NZD/JPY",
    "XAUUSD":"XAU/USD","XAGUSD":"XAG/USD",
    "US30":"DJI","NAS100":"NDX","SPX500":"SPX",
    "GER40":"DAX","UK100":"FTSE","JPN225":"N225",
}

BINANCE_TF = {"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","1d":"1d","1w":"1w"}
TWELVE_TF  = {"1m":"1min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","4h":"4h","1d":"1day","1w":"1week","1M":"1month"}

def fetch_binance(symbol, timeframe):
    tf = BINANCE_TF.get(timeframe, "1h")
    url = f"https://api.binance.com/api/v3/klines?symbol={symbol}&interval={tf}&limit=500"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    data = r.json()
    df = pd.DataFrame(data, columns=["time","open","high","low","close","volume","ct","qv","t","tbb","tbq","i"])
    df[["open","high","low","close","volume"]] = df[["open","high","low","close","volume"]].astype(float)
    return df

def fetch_twelvedata(symbol_key, timeframe):
    td_symbol = TWELVE_DATA_SYMBOLS.get(symbol_key)
    if not td_symbol:
        raise Exception(f"Symbol {symbol_key} not supported")
    tf = TWELVE_TF.get(timeframe, "1h")
    url = f"https://api.twelvedata.com/time_series?symbol={td_symbol}&interval={tf}&outputsize=500&apikey={TWELVE_DATA_KEY}"
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    data = r.json()
    if "values" not in data:
        raise Exception(f"Twelve Data: {data.get('message','No data')}")
    df = pd.DataFrame(data["values"])
    df = df.rename(columns={"datetime":"time"})
    df[["open","high","low","close"]] = df[["open","high","low","close"]].astype(float)
    if "volume" not in df.columns:
        df["volume"] = 0
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
    df = df.iloc[::-1].reset_index(drop=True)
    return df

def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()

def rsi_wilder(s, n=14):
    delta = s.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=n-1, adjust=False).mean()
    avg_loss = loss.ewm(com=n-1, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, 1e-10)
    return (100 - (100 / (1 + rs))).fillna(50)

def stoch_rsi(s, rsi_period=14, stoch_period=14, k_period=3, d_period=3):
    r = rsi_wilder(s, rsi_period)
    min_r = r.rolling(stoch_period).min()
    max_r = r.rolling(stoch_period).max()
    diff = (max_r - min_r).replace(0, 1e-10)
    k = ((r - min_r) / diff) * 100
    k_smooth = k.ewm(span=k_period, adjust=False).mean()
    d_smooth = k_smooth.ewm(span=d_period, adjust=False).mean()
    return round(float(k_smooth.iloc[-1]), 2), round(float(d_smooth.iloc[-1]), 2)

def macd(s, f=12, sl=26, sig=9):
    ml = ema(s, f) - ema(s, sl)
    sl2 = ema(ml, sig)
    return ml, sl2, ml - sl2

def atr(df, n=14):
    h, l, c = df["high"], df["low"], df["close"]
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    return tr.rolling(n).mean()

def bollinger_bands(s, n=20, std_dev=2):
    mid = s.rolling(n).mean()
    std = s.rolling(n).std()
    upper = mid + (std * std_dev)
    lower = mid - (std * std_dev)
    cur = float(s.iloc[-1])
    band_width = float((upper.iloc[-1] - lower.iloc[-1]) / mid.iloc[-1]) * 100
    denom = upper.iloc[-1] - lower.iloc[-1]
    pct_b = float((cur - lower.iloc[-1]) / denom) if denom != 0 else 0.5
    if cur >= float(upper.iloc[-1]):
        bb_pos = "upper"
    elif cur <= float(lower.iloc[-1]):
        bb_pos = "lower"
    else:
        bb_pos = "middle"
    squeeze = band_width < 2.0
    return (round(float(upper.iloc[-1]), 5), round(float(mid.iloc[-1]), 5),
            round(float(lower.iloc[-1]), 5), round(band_width, 2),
            round(pct_b, 3), bb_pos, squeeze)

def relative_volume(df, period=20):
    if df["volume"].sum() == 0:
        return 1.0
    avg_vol = df["volume"].tail(period).mean()
    cur_vol = float(df["volume"].iloc[-1])
    if avg_vol == 0:
        return 1.0
    return round(cur_vol / avg_vol, 2)

def market_structure(df, lookback=30):
    recent = df.tail(lookback)
    highs = recent["high"].values
    lows = recent["low"].values
    mid = lookback // 2
    hh = highs[-1] > highs[mid] > highs[0]
    hl = lows[-1] > lows[mid] > lows[0]
    ll = lows[-1] < lows[mid] < lows[0]
    lh = highs[-1] < highs[mid] < highs[0]
    if hh and hl:
        return "bullish_structure"
    elif ll and lh:
        return "bearish_structure"
    else:
        return "consolidation"

def sr(df, lookback=50):
    r = df.tail(lookback); sup=[]; res=[]
    for i in range(2, len(r)-2):
        lo = r.iloc[i]["low"]; hi = r.iloc[i]["high"]
        if lo < r.iloc[i-1]["low"] and lo < r.iloc[i-2]["low"] and lo < r.iloc[i+1]["low"] and lo < r.iloc[i+2]["low"]:
            sup.append(lo)
        if hi > r.iloc[i-1]["high"] and hi > r.iloc[i-2]["high"] and hi > r.iloc[i+1]["high"] and hi > r.iloc[i+2]["high"]:
            res.append(hi)
    cur = df["close"].iloc[-1]
    ns = max([s for s in sup if s < cur], default=round(cur*0.98, 5))
    nr = min([r2 for r2 in res if r2 > cur], default=round(cur*1.02, 5))
    return round(ns, 5), round(nr, 5)

def analyze(symbol, timeframe):
    if symbol in BINANCE_SYMBOLS:
        df = fetch_binance(symbol, timeframe)
    elif symbol in TWELVE_DATA_SYMBOLS:
        df = fetch_twelvedata(symbol, timeframe)
    else:
        raise Exception(f"Symbol {symbol} not supported")

    if len(df) < 50:
        raise Exception(f"Not enough data: {len(df)} candles")

    c = df["close"]
    price = round(float(c.iloc[-1]), 5)

    if symbol == "XAUUSD" and price > 4000:
        factor = price / 2900
        for col in ["open","high","low","close"]: df[col] = df[col] / factor
        c = df["close"]; price = round(float(c.iloc[-1]), 2)
    if symbol == "XAGUSD" and price > 60:
        factor = price / 32
        for col in ["open","high","low","close"]: df[col] = df[col] / factor
        c = df["close"]; price = round(float(c.iloc[-1]), 2)
    # ✅ FIX 2: ATR recalculé APRÈS correction prix Gold/Silver

    e20  = round(float(ema(c, 20).iloc[-1]), 5)
    e50  = round(float(ema(c, 50).iloc[-1]), 5)
    e200 = round(float(ema(c, 200).iloc[-1]), 5)

    rsi_val = round(float(rsi_wilder(c, 14).iloc[-1]), 2)
    rsi_val = max(0, min(100, rsi_val))

    # RSI direction — remonte ou descend ?
    rsi_series = rsi_wilder(c, 14)
    rsi_prev = round(float(rsi_series.iloc[-4]), 2)
    rsi_rising = rsi_val > rsi_prev

    stoch_k, stoch_d = stoch_rsi(c)

    ml, sl2, hist = macd(c)
    msig = "bullish" if float(ml.iloc[-1]) > float(sl2.iloc[-1]) else "bearish"
    macd_histogram = round(float(hist.iloc[-1]), 6)
    macd_increasing = bool(float(hist.iloc[-1]) > float(hist.iloc[-2]))

    at = round(float(atr(df).iloc[-1]), 5)
    bb_upper, bb_middle, bb_lower, bb_width, bb_pct_b, bb_position, bb_squeeze = bollinger_bands(c)
    rel_vol = relative_volume(df)
    volume_signal = "strong" if rel_vol >= 1.5 else "weak" if rel_vol < 0.7 else "normal"
    mkt_structure = market_structure(df)
    ns, nr = sr(df)

    if e20 > e50 and price > e50:
        trend = "uptrend"
    elif e20 < e50 and price < e50:
        trend = "downtrend"
    else:
        trend = "sideways"

    pve = "above" if price > e200 else "below"
    atp = (at / price) * 100 if price > 0 else 0
    vol_label = "high" if atp > 1.5 else "medium" if atp > 0.4 else "low"

    tp_buy  = round(price + at * 2.0, 5)
    sl_buy  = round(price - at * 1.0, 5)
    tp_sell = round(price - at * 2.0, 5)
    sl_sell = round(price + at * 1.0, 5)

    # ── SCORING ──
    bull_score = 0
    bear_score = 0
    confluence_reasons = []

    if price > e20:
        bull_score += 2; confluence_reasons.append("price>EMA20 ✅")
    else:
        bear_score += 2; confluence_reasons.append("price<EMA20 ❌")

    if price > e50:
        bull_score += 3; confluence_reasons.append("price>EMA50 ✅")
    else:
        bear_score += 3; confluence_reasons.append("price<EMA50 ❌")

    if price > e200:
        bull_score += 2; confluence_reasons.append("price>EMA200 ✅")
    else:
        bear_score += 2; confluence_reasons.append("price<EMA200 ❌")

    if e20 > e50:
        bull_score += 2; confluence_reasons.append("EMA20>EMA50 ✅")
    else:
        bear_score += 2; confluence_reasons.append("EMA20<EMA50 ❌")

    if msig == "bullish":
        bull_score += 3; confluence_reasons.append("MACD bullish ✅")
    else:
        bear_score += 3; confluence_reasons.append("MACD bearish ❌")

    if macd_histogram > 0: bull_score += 1
    else: bear_score += 1

    if rsi_val < 30:
        bull_score += 3; confluence_reasons.append(f"RSI oversold ({rsi_val}) ✅")
    elif rsi_val > 70:
        bear_score += 3; confluence_reasons.append(f"RSI overbought ({rsi_val}) ✅")
    elif rsi_val >= 60:
        bull_score += 2; confluence_reasons.append(f"RSI bullish zone ({rsi_val})")
    elif rsi_val <= 40:
        bear_score += 2; confluence_reasons.append(f"RSI bearish zone ({rsi_val})")
    else:
        confluence_reasons.append(f"RSI neutral ({rsi_val}) ⚠️")

    # RSI direction bonus
    if rsi_rising and rsi_val < 50:
        bull_score += 1; confluence_reasons.append(f"RSI rising from low ({rsi_prev}→{rsi_val}) ✅")
    elif not rsi_rising and rsi_val > 50:
        bear_score += 1; confluence_reasons.append(f"RSI falling from high ❌")

    if stoch_k < 20 and stoch_d < 20:
        bull_score += 2; confluence_reasons.append(f"StochRSI oversold ({stoch_k}) ✅")
    elif stoch_k > 80 and stoch_d > 80:
        bear_score += 2; confluence_reasons.append(f"StochRSI overbought ({stoch_k}) ✅")
    elif stoch_k > stoch_d:
        bull_score += 1; confluence_reasons.append(f"StochRSI K>D ✅")
    else:
        bear_score += 1; confluence_reasons.append(f"StochRSI K<D ❌")

    if bb_position == "lower":
        bull_score += 2; confluence_reasons.append("BB lower band — bounce zone ✅")
    elif bb_position == "upper":
        bear_score += 2; confluence_reasons.append("BB upper band — reversal zone ✅")
    if bb_squeeze:
        confluence_reasons.append("BB squeeze — breakout imminent ⚡")

    if rel_vol >= 1.5:
        if bull_score > bear_score:
            bull_score += 2; confluence_reasons.append(f"High volume confirms bull ({rel_vol}x) ✅")
        else:
            bear_score += 2; confluence_reasons.append(f"High volume confirms bear ({rel_vol}x) ✅")
    elif rel_vol < 0.7:
        bull_score = max(0, bull_score - 1)
        bear_score = max(0, bear_score - 1)
        confluence_reasons.append(f"Low volume — weak signal ({rel_vol}x) ⚠️")

    if mkt_structure == "bullish_structure":
        bull_score += 3; confluence_reasons.append("Bullish structure (HH+HL) ✅")
    elif mkt_structure == "bearish_structure":
        bear_score += 3; confluence_reasons.append("Bearish structure (LL+LH) ✅")
    else:
        confluence_reasons.append("Consolidation structure ⚠️")

    total = bull_score + bear_score
    bull_pct = (bull_score / total) * 100 if total > 0 else 50
    confluence_count = len([s for s in confluence_reasons if "✅" in s])

    # ── DÉTECTION DIVERGENCE HAUSSIÈRE ──
    # RSI oversold/bearish zone MAIS MACD bullish + RSI remonte = rebond probable
    bullish_divergence = (
        rsi_val < 45 and
        msig == "bullish" and
        rsi_rising and
        stoch_k > 60
    )

    # RSI overbought/bullish zone MAIS MACD bearish + RSI descend = chute probable
    bearish_divergence = (
        rsi_val > 55 and
        msig == "bearish" and
        not rsi_rising and
        stoch_k < 40
    )

    # ── BB SQUEEZE — forcer WAIT ──
    squeeze_wait = bb_squeeze and rel_vol < 0.8

    # ✅ FIX 1: Volume mort = pas de signal fiable
    dead_volume = rel_vol < 0.5

    rsi_neutral = 40 <= rsi_val <= 60
    weak_signal = confluence_count < 3 or (rsi_neutral and abs(bull_pct - 50) < 15)

    # ── DÉCISION FINALE ──
    if dead_volume:
        action_hint = "WAIT"
        confidence = 35
        obs = f"Volume too low ({rel_vol}x) — no conviction, wait for volume"

    elif squeeze_wait:
        action_hint = "WAIT"
        confidence = 40
        obs = "BB squeeze + low volume — wait for breakout confirmation"

    elif bullish_divergence and bull_pct < 50:
        # EMA bearish mais momentum dit rebond — WAIT, pas SELL
        action_hint = "WAIT"
        confidence = 45
        obs = f"Bullish divergence — RSI rising ({rsi_prev}→{rsi_val}) + MACD bullish despite bearish trend, avoid SELL"
        confluence_reasons.append("⚠️ Bullish divergence detected — SELL blocked")

    elif bearish_divergence and bull_pct > 50:
        action_hint = "WAIT"
        confidence = 45
        obs = "Bearish divergence — RSI falling + MACD bearish despite bullish trend, avoid BUY"
        confluence_reasons.append("⚠️ Bearish divergence detected — BUY blocked")

    elif weak_signal:
        action_hint = "WAIT"
        confidence = max(30, int(30 + abs(bull_pct - 50)))
        obs = "Weak confluence — wait for clearer setup"

    elif bull_pct >= 65:
        action_hint = "BUY"
        confidence = min(92, int(50 + (bull_pct - 50) * 2.2))
        obs = f"Strong bullish confluence ({confluence_count} confirmations)"

    elif bull_pct <= 35:
        action_hint = "SELL"
        confidence = min(92, int(50 + (50 - bull_pct) * 2.2))
        obs = f"Strong bearish confluence ({confluence_count} confirmations)"

    elif bull_pct >= 58:
        action_hint = "BUY"
        confidence = min(72, int(50 + (bull_pct - 50) * 1.8))
        obs = "Moderate bullish setup — monitor closely"

    elif bull_pct <= 42:
        action_hint = "SELL"
        confidence = min(72, int(50 + (50 - bull_pct) * 1.8))
        obs = "Moderate bearish setup — monitor closely"

    else:
        action_hint = "WAIT"
        confidence = max(35, int(35 + abs(bull_pct - 50) * 2))
        obs = "Mixed signals — wait for clarity"

    # ✅ FIX 3: Cap confidence si volume faible
    if rel_vol < 0.5:
        confidence = min(confidence, 55)
    elif rel_vol < 0.7:
        confidence = min(confidence, 70)

    # ── Override observations spécifiques ──
    if rsi_val > 70 and action_hint == "SELL":
        obs = "RSI overbought — reversal risk confirmed"
    elif rsi_val < 30 and action_hint == "BUY":
        obs = "RSI oversold — bounce potential confirmed"
    elif trend == "uptrend" and msig == "bullish" and mkt_structure == "bullish_structure" and action_hint == "BUY":
        obs = "Triple confluence: uptrend + MACD bullish + bullish structure"
    elif trend == "downtrend" and msig == "bearish" and mkt_structure == "bearish_structure" and action_hint == "SELL":
        obs = "Triple confluence: downtrend + MACD bearish + bearish structure"

    print(json.dumps({
        "symbol": symbol,
        "timeframe": timeframe,
        "current_price": price,
        "trend": trend,
        "market_structure": mkt_structure,
        "price_vs_ema200": pve,
        "ema20": e20,
        "ema50": e50,
        "ema200": e200,
        "rsi": rsi_val,
        "rsi_rising": rsi_rising,
        "stoch_rsi_k": stoch_k,
        "stoch_rsi_d": stoch_d,
        "macd_signal": msig,
        "macd_histogram": macd_histogram,
        "macd_increasing": macd_increasing,
        "volatility": vol_label,
        "atr": at,
        "bb_upper": bb_upper,
        "bb_middle": bb_middle,
        "bb_lower": bb_lower,
        "bb_width": bb_width,
        "bb_position": bb_position,
        "bb_squeeze": bb_squeeze,
        "relative_volume": rel_vol,
        "volume_signal": volume_signal,
        "nearest_support": ns,
        "nearest_resistance": nr,
        "tp_buy": tp_buy,
        "sl_buy": sl_buy,
        "tp_sell": tp_sell,
        "sl_sell": sl_sell,
        "action_hint": action_hint,
        "confidence": confidence,
        "bull_score": bull_score,
        "bear_score": bear_score,
        "bull_pct": round(bull_pct, 1),
        "confluence_count": confluence_count,
        "confluence_reasons": confluence_reasons,
        "key_observation": obs,
    }))

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python analyze.py SYMBOL TIMEFRAME"}))
        sys.exit(1)
    try:
        analyze(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)