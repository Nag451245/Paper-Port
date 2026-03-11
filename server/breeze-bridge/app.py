"""
Breeze Bridge — Lightweight Python microservice for ICICI Breeze API.
Handles option chain data using the official Python SDK.
Runs on port 8001, called internally by the Node.js backend.
"""

import os
import json
import sys
import signal
from datetime import datetime, timedelta
from math import log, sqrt, exp, erf
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

try:
    from breeze_connect import BreezeConnect
    from breeze_connect.breeze_connect import ApificationBreeze
except ImportError:
    print("ERROR: breeze-connect not installed. Run: pip install breeze-connect")
    sys.exit(1)

import urllib.request
import csv
import io

import threading

breeze_instance = None
session_expiry = None
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_FILE = os.path.join(SCRIPT_DIR, ".breeze_session.json")
LOT_SIZE_FILE = os.path.join(SCRIPT_DIR, ".lot_sizes.json")

# In-memory response cache to avoid hammering Breeze API
_response_cache = {}
_response_cache_lock = threading.Lock()
CACHE_TTL_SECONDS = 3

# ── Symbol translation: Standard NSE tickers → ICICI Breeze stock codes ──────
# The Breeze API uses ICICI-internal short names, NOT standard NSE tickers.
# e.g. Bank Nifty = "CNXBAN" (not "BANKNIFTY"), Reliance = "RELING" (not "RELIANCE")

_HARDCODED_BREEZE_CODES = {
    # ─── Indices ───
    "NIFTY": "NIFTY", "BANKNIFTY": "CNXBAN", "FINNIFTY": "NIFFIN",
    "MIDCPNIFTY": "NIFSEL", "NIFTYNXT50": "NIFNEX", "SENSEX": "SENSEX",
    # ─── Direct-match stocks (NSE ticker = Breeze NFO code) ───
    "TCS": "TCS", "ITC": "ITC", "WIPRO": "WIPRO", "MARUTI": "MARUTI",
    "NTPC": "NTPC", "ONGC": "ONGC", "CIPLA": "CIPLA", "GRASIM": "GRASIM",
    "TRENT": "TRENT", "BHEL": "BHEL", "MCX": "MCX", "GAIL": "GAIL",
    "SAIL": "SAIL", "SRF": "SRF", "BSE": "BSE", "CDSL": "CDSL",
    "NBCC": "NBCC", "NHPC": "NHPC", "LUPIN": "LUPIN", "ABB": "ABB",
    "BIOCON": "BIOCON", "COLPAL": "COLPAL", "CONCOR": "CONCOR",
    "PIIND": "PIIND", "HUDCO": "HUDCO", "VOLTAS": "VOLTAS",
    # ─── Major stocks (NSE ticker ≠ Breeze code) ───
    "RELIANCE": "RELIND", "HDFCBANK": "HDFBAN", "ICICIBANK": "ICIBAN",
    "INFY": "INFTEC", "SBIN": "STABAN", "HINDUNILVR": "HINLEV",
    "BHARTIARTL": "BHAAIR", "KOTAKBANK": "KOTMAH", "LT": "LARTOU",
    "AXISBANK": "AXIBAN", "BAJFINANCE": "BAJFI", "HCLTECH": "HCLTEC",
    "TATAMOTORS": "TATMOT", "SUNPHARMA": "SUNPHA", "TITAN": "TITIND",
    "ASIANPAINT": "ASIPAI", "ADANIENT": "ADAENT", "TATASTEEL": "TATSTE",
    "POWERGRID": "POWGRI", "JSWSTEEL": "JSWSTE", "M&M": "MAHMAH",
    "BAJAJFINSV": "BAFINS", "ULTRACEMCO": "ULTCEM", "NESTLEIND": "NESIND",
    "DRREDDY": "DRREDD", "DIVISLAB": "DIVLAB", "HEROMOTOCO": "HERHON",
    "HINDALCO": "HINDAL", "TATACONSUM": "TATGLO", "TATAPOWER": "TATPOW",
    "EICHERMOT": "EICMOT", "INDIGO": "INTAVI", "DLF": "DLFLIM",
    "APOLLOHOSP": "APOHOS", "BRITANNIA": "BRIIND", "COALINDIA": "COALIN",
    "HAL": "HINAER", "HAVELLS": "HAVIND", "LICI": "LIC",
    "PNB": "PUNBAN", "INDUSINDBK": "INDIBA", "SBILIFE": "SBILIF",
    "TECHM": "TECMAH", "BAJAJ-AUTO": "BAAUTO", "BPCL": "BHAPET",
    "HINDZINC": "HINZIN",
    # ─── Extended F&O stocks ───
    "ADANIGREEN": "ADAGRE", "ADANIPORTS": "ADAPOR",
    "AMBUJACEM": "AMBCE", "AUROPHARMA": "AURPHA",
    "ASHOKLEY": "ASHLEY", "BANKBARODA": "BANBAR",
    "BANKINDIA": "BANIND", "BANDHANBNK": "BANBAN",
    "BEL": "BHAELE", "BHARATFORG": "BHAFOR",
    "CANBK": "CANBAN", "CHOLAFIN": "CHOINV",
    "CROMPTON": "CROGR", "CUMMINSIND": "CUMIND",
    "DABUR": "DABIND", "DELHIVERY": "DELLIM",
    "DIXON": "DIXTEC", "EXIDEIND": "EXIIND",
    "FEDERALBNK": "FEDBAN", "GLENMARK": "GLEPHA",
    "GMRAIRPORT": "GMRINF", "GODREJCP": "GODCON",
    "GODREJPROP": "GODPRO", "HDFCAMC": "HDFAMC",
    "HDFCLIFE": "HDFSTA", "ICICIPRULI": "ICIPRU",
    "IDFCFIRSTB": "IDFBAN", "INDHOTEL": "INDHOT",
    "IOC": "INDOIL", "JINDALSTEL": "JINSP",
    "JIOFIN": "JIOFIN", "JSWENERGY": "JSWENE",
    "JUBLFOOD": "JUBFOO", "KALYANKJIL": "KALJEW",
    "KPITTECH": "KPITE", "LICHSGFIN": "LICHF",
    "LTIM": "LTINFO", "MANAPPURAM": "MANAFI",
    "MAXHEALTH": "MAXHEA", "MUTHOOTFIN": "MUTFIN",
    "NATIONALUM": "NATALU", "NMDC": "NATMIN",
    "OBEROIRLTY": "OBEREA", "OFSS": "ORAFIN",
    "PAGEIND": "PAGIND", "PERSISTENT": "PERSYS",
    "PETRONET": "PETLNG", "PFC": "POWFIN",
    "PIDILITIND": "PIDIND", "POLYCAB": "POLI",
    "RBLBANK": "RBLBAN", "RECLTD": "RURELE",
    "SBICARD": "SBICAR", "SHREECEM": "SHRCEM",
    "SHRIRAMFIN": "SHRTRA", "SIEMENS": "SIEMEN",
    "SONACOMS": "SONBLW", "TATAELXSI": "TATELX",
    "TATATECH": "TATTEC", "TORNTPHARM": "TORPHA",
    "TORNTPOWER": "TORPOW", "TVSMOTOR": "TVSMOT",
    "UPL": "UNIP", "VEDL": "VEDLIM",
    "YESBANK": "YESBAN", "ZOMATO": "ZOMLIM",
    "ETERNAL": "ZOMLIM", "BDL": "BHADYN",
    "FORTIS": "FORHEA", "HINDPETRO": "HINPET",
    "KAYNES": "KAYTEC", "ABBPOWER": "ABBPOW",
}

_dynamic_nfo_codes = set()
_symbol_map_lock = threading.Lock()


def _build_symbol_map():
    """Extract valid NFO codes from loaded stock script data."""
    global _dynamic_nfo_codes

    if not breeze_instance or not breeze_instance.stock_script_dict_list:
        return

    nfo_dict = breeze_instance.stock_script_dict_list[4]
    nfo_codes = set()
    for key in nfo_dict.keys():
        parts = key.split("-")
        if len(parts) >= 2:
            nfo_codes.add(parts[1])

    _dynamic_nfo_codes = nfo_codes
    print(f"[Breeze Bridge] NFO underlying codes loaded: {len(nfo_codes)}")

    mapped = 0
    unmapped = []
    lot_sizes = get_lot_sizes()
    for ticker in sorted(lot_sizes.keys()):
        t = ticker.upper()
        code = _HARDCODED_BREEZE_CODES.get(t)
        if code:
            if code in nfo_codes or code == "SENSEX":
                mapped += 1
            else:
                print(f"[Breeze Bridge] WARNING: hardcoded {t}→{code} but {code} not in NFO codes!")
        elif t in nfo_codes:
            mapped += 1
        else:
            unmapped.append(t)

    print(f"[Breeze Bridge] Symbol coverage: {mapped} mapped, {len(unmapped)} unmapped")
    if unmapped:
        print(f"[Breeze Bridge] Unmapped tickers: {', '.join(unmapped[:30])}")


def _resolve_stock_code(symbol):
    """Translate standard NSE ticker to ICICI Breeze stock_code for NFO."""
    sym = symbol.upper()
    if sym in _HARDCODED_BREEZE_CODES:
        return _HARDCODED_BREEZE_CODES[sym]
    if sym in _dynamic_nfo_codes:
        return sym
    print(f"[Breeze Bridge] WARNING: No Breeze code mapping for '{sym}', using as-is")
    return sym


def _cache_get(key):
    with _response_cache_lock:
        entry = _response_cache.get(key)
        if entry and (datetime.now() - entry["at"]).total_seconds() < CACHE_TTL_SECONDS:
            return entry["data"]
    return None


def _cache_set(key, data):
    with _response_cache_lock:
        _response_cache[key] = {"data": data, "at": datetime.now()}
        if len(_response_cache) > 50:
            oldest = min(_response_cache, key=lambda k: _response_cache[k]["at"])
            del _response_cache[oldest]

PI = 3.141592653589793
RISK_FREE_RATE = 0.07

# ── Lot-size management ────────────────────────────────────────────────────

_lot_size_cache = {}
_lot_size_cache_time = None
_LOT_SIZE_CACHE_HOURS = 6

FALLBACK_LOT_SIZES = {
    # Indices — updated as of SEBI Nov-2024 circular
    "NIFTY": 75, "BANKNIFTY": 30, "FINNIFTY": 25, "MIDCPNIFTY": 75,
    "NIFTYNXT50": 25, "SENSEX": 20,
    # Top stocks — approximate lot sizes (NSE CSV is authoritative)
    "RELIANCE": 250, "TCS": 175, "HDFCBANK": 550, "INFY": 400,
    "ICICIBANK": 700, "HINDUNILVR": 300, "SBIN": 750, "BHARTIARTL": 475,
    "KOTAKBANK": 400, "ITC": 1600, "LT": 150, "AXISBANK": 625,
    "BAJFINANCE": 125, "WIPRO": 1500, "HCLTECH": 350, "MARUTI": 50,
    "TATAMOTORS": 575, "SUNPHARMA": 350, "TITAN": 175, "ASIANPAINT": 250,
    "ADANIENT": 250, "TATASTEEL": 5500, "NTPC": 1500, "POWERGRID": 1900,
    "ONGC": 2250, "JSWSTEEL": 675, "M&M": 200, "BAJAJFINSV": 250,
    "ULTRACEMCO": 50, "NESTLEIND": 50, "DRREDDY": 125, "CIPLA": 375,
    "DIVISLAB": 100, "HEROMOTOCO": 150, "HINDALCO": 700, "TATACONSUM": 550,
    "TATAPOWER": 1450, "EICHERMOT": 100, "INDIGO": 150, "DLF": 825,
    "APOLLOHOSP": 125, "BRITANNIA": 125, "COALINDIA": 1350, "GRASIM": 250,
    "HAL": 150, "HAVELLS": 500, "LICI": 700, "PNB": 8000,
    "INDUSINDBK": 700, "SBILIFE": 375, "TECHM": 600, "TRENT": 100,
    "BAJAJ-AUTO": 75, "BPCL": 1975, "ETERNAL": 2425,
}


def _parse_nse_csv(raw):
    """Parse NSE fo_mktlots.csv — tolerant of header variations."""
    lot_sizes = {}
    reader = csv.reader(io.StringIO(raw))
    for row in reader:
        if len(row) < 3:
            continue
        sym = row[1].strip().upper() if len(row) > 1 else ""
        if not sym or sym in ("SYMBOL", ""):
            continue
        if any(c.isalpha() for c in sym) and not sym.startswith("LOT"):
            for cell in row[2:]:
                cell = cell.strip().replace(",", "")
                if cell.isdigit() and int(cell) > 0:
                    lot_sizes[sym] = int(cell)
                    break
    return lot_sizes


def _save_lot_sizes_to_disk(sizes):
    try:
        with open(LOT_SIZE_FILE, "w") as f:
            json.dump({"sizes": sizes, "saved_at": datetime.now().isoformat()}, f)
    except Exception as e:
        print(f"[Breeze Bridge] Failed to save lot sizes to disk: {e}")


def _load_lot_sizes_from_disk():
    if not os.path.exists(LOT_SIZE_FILE):
        return None
    try:
        with open(LOT_SIZE_FILE, "r") as f:
            data = json.load(f)
        saved_at = datetime.fromisoformat(data["saved_at"])
        if (datetime.now() - saved_at).total_seconds() > 86400:
            return None
        return data.get("sizes", {})
    except Exception:
        return None


def get_lot_sizes(force_refresh=False):
    """Fetch lot sizes: NSE CSV → disk cache → fallback defaults."""
    global _lot_size_cache, _lot_size_cache_time

    if not force_refresh and _lot_size_cache and _lot_size_cache_time:
        age_hrs = (datetime.now() - _lot_size_cache_time).total_seconds() / 3600
        if age_hrs < _LOT_SIZE_CACHE_HOURS:
            return _lot_size_cache

    # Try NSE archive CSV (nsearchives works; archives.nseindia returns PDF now)
    nse_urls = [
        "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv",
        "https://archives.nseindia.com/content/fo/fo_mktlots.csv",
    ]
    for url in nse_urls:
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/csv,text/plain,*/*",
            })
            resp = urllib.request.urlopen(req, timeout=15)
            raw = resp.read().decode("utf-8", errors="replace")
            if raw.startswith("%PDF"):
                print(f"[Breeze Bridge] Skipping {url} — returned a PDF, not CSV")
                continue
            sizes = _parse_nse_csv(raw)
            if sizes and len(sizes) >= 10:
                _lot_size_cache = sizes
                _lot_size_cache_time = datetime.now()
                _save_lot_sizes_to_disk(sizes)
                print(f"[Breeze Bridge] Fetched {len(sizes)} lot sizes from NSE ({url})")
                return sizes
        except Exception as e:
            print(f"[Breeze Bridge] NSE lot size fetch failed ({url}): {e}")

    # Try disk cache
    disk = _load_lot_sizes_from_disk()
    if disk and len(disk) >= 10:
        _lot_size_cache = disk
        _lot_size_cache_time = datetime.now()
        print(f"[Breeze Bridge] Loaded {len(disk)} lot sizes from disk cache")
        return disk

    # Fallback defaults
    _lot_size_cache = dict(FALLBACK_LOT_SIZES)
    _lot_size_cache_time = datetime.now()
    print("[Breeze Bridge] Using fallback lot sizes")
    return _lot_size_cache


def norm_cdf(x):
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def norm_pdf(x):
    return exp(-0.5 * x * x) / sqrt(2.0 * PI)


def calc_greeks(spot, strike, tte_days, iv_pct, right="call"):
    """Black-Scholes Greeks. iv_pct is IV in percentage (e.g. 18.5 for 18.5%)."""
    if iv_pct <= 0 or tte_days <= 0 or spot <= 0 or strike <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    tte = tte_days / 365.0
    sigma = iv_pct / 100.0
    sqrt_tte = sqrt(tte)
    r = RISK_FREE_RATE

    d1 = (log(spot / strike) + (r + sigma * sigma / 2.0) * tte) / (sigma * sqrt_tte)
    d2 = d1 - sigma * sqrt_tte

    nd1 = norm_pdf(d1)
    gamma = nd1 / (spot * sigma * sqrt_tte)
    vega = spot * nd1 * sqrt_tte / 100.0

    if right == "call":
        delta = norm_cdf(d1)
        theta = (
            -spot * nd1 * sigma / (2.0 * sqrt_tte)
            - r * strike * exp(-r * tte) * norm_cdf(d2)
        ) / 365.0
    else:
        delta = norm_cdf(d1) - 1.0
        theta = (
            -spot * nd1 * sigma / (2.0 * sqrt_tte)
            + r * strike * exp(-r * tte) * norm_cdf(-d2)
        ) / 365.0

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
    }


def implied_vol_bs(spot, strike, tte_days, price, right="call"):
    """Estimate IV (as percentage) from option price using Newton-Raphson."""
    if price <= 0 or spot <= 0 or strike <= 0 or tte_days <= 0:
        return 0.0
    tte = tte_days / 365.0
    r = RISK_FREE_RATE
    intrinsic = max(spot - strike, 0.0) if right == "call" else max(strike - spot, 0.0)
    if price <= intrinsic + 0.01:
        return 0.0
    sigma = 0.3
    for _ in range(50):
        try:
            sqrt_tte = sqrt(tte)
            d1 = (log(spot / strike) + (r + sigma * sigma / 2.0) * tte) / (sigma * sqrt_tte)
            d2 = d1 - sigma * sqrt_tte
            if right == "call":
                model = spot * norm_cdf(d1) - strike * exp(-r * tte) * norm_cdf(d2)
            else:
                model = strike * exp(-r * tte) * norm_cdf(-d2) - spot * norm_cdf(-d1)
            diff = model - price
            if abs(diff) < 0.01:
                return round(sigma * 100.0, 2)
            vega_val = spot * norm_pdf(d1) * sqrt_tte
            if vega_val < 1e-10:
                break
            sigma -= diff / vega_val
            if sigma <= 0.001:
                sigma = 0.001
            if sigma > 5.0:
                break
        except (ValueError, ZeroDivisionError):
            break
    return round(sigma * 100.0, 2) if 0.001 < sigma < 5.0 else 0.0


def save_session_to_disk(api_key, api_secret, user_id, session_key):
    try:
        with open(SESSION_FILE, "w") as f:
            json.dump({
                "api_key": api_key,
                "api_secret": api_secret,
                "user_id": user_id,
                "session_key": session_key,
                "saved_at": datetime.now().isoformat(),
            }, f)
        print(f"[Breeze Bridge] Session persisted to disk")
    except Exception as e:
        print(f"[Breeze Bridge] Failed to persist session: {e}")


def restore_session_from_disk():
    global breeze_instance, session_expiry
    if not os.path.exists(SESSION_FILE):
        return False

    try:
        with open(SESSION_FILE, "r") as f:
            data = json.load(f)

        saved_at = datetime.fromisoformat(data["saved_at"])
        if datetime.now() - saved_at > timedelta(hours=23):
            print("[Breeze Bridge] Saved session expired, removing file")
            os.remove(SESSION_FILE)
            return False

        b = BreezeConnect(api_key=data["api_key"])
        b.user_id = data["user_id"]
        b.session_key = data["session_key"]
        b.secret_key = data["api_secret"]
        b.get_stock_script_list()
        b.api_handler = ApificationBreeze(b)

        test = b.get_option_chain_quotes(
            stock_code="NIFTY", exchange_code="NFO",
            product_type="options", right="call", strike_price="24000",
        )
        if test and test.get("Status") == 200:
            breeze_instance = b
            session_expiry = saved_at + timedelta(hours=23)
            _build_symbol_map()
            print(f"[Breeze Bridge] Session restored from disk (user_id={data['user_id']})")
            return True

        print(f"[Breeze Bridge] Restored session failed test call, removing file")
        os.remove(SESSION_FILE)
        return False
    except Exception as e:
        print(f"[Breeze Bridge] Failed to restore session: {e}")
        try:
            os.remove(SESSION_FILE)
        except OSError:
            pass
        return False


def _test_breeze_instance(b):
    """Make a test API call to verify the Breeze session works."""
    try:
        test = b.get_option_chain_quotes(
            stock_code="NIFTY", exchange_code="NFO",
            product_type="options", right="call", strike_price="24000",
        )
        return test and test.get("Status") == 200, test
    except Exception as e:
        return False, {"error": str(e)}


def init_breeze(api_key, api_secret, session_token):
    """Initialize Breeze session. Tries two strategies:
    1. generate_session() — for raw apisession tokens from the login popup
    2. Direct session_key assignment — for already-exchanged tokens from DB
    """
    global breeze_instance, session_expiry
    errors = []

    # Strategy 1: generate_session() (raw one-time token from login popup)
    try:
        b = BreezeConnect(api_key=api_key)
        print(f"[Breeze Bridge] Strategy 1: generate_session (token length={len(session_token)})")
        b.generate_session(api_secret=api_secret, session_token=session_token)
        print(f"[Breeze Bridge] generate_session OK, user_id={b.user_id}, key length={len(b.session_key or '')}")

        ok, test_result = _test_breeze_instance(b)
        if ok:
            breeze_instance = b
            session_expiry = datetime.now() + timedelta(hours=23)
            _build_symbol_map()
            save_session_to_disk(api_key, api_secret, b.user_id, b.session_key)
            print(f"[Breeze Bridge] Session initialized via generate_session, user_id={b.user_id}")
            return {"success": True, "message": "Session initialized", "session_key": b.session_key}
        else:
            msg = f"generate_session succeeded but test call failed: {test_result}"
            print(f"[Breeze Bridge] {msg}")
            errors.append(msg)
    except Exception as e:
        msg = f"generate_session failed: {e}"
        print(f"[Breeze Bridge] {msg}")
        errors.append(msg)

    # Strategy 2: Direct assignment (already-exchanged token from DB)
    try:
        b2 = BreezeConnect(api_key=api_key)
        b2.session_key = session_token
        b2.secret_key = api_secret
        b2.api_util()
        b2.get_stock_script_list()
        b2.api_handler = ApificationBreeze(b2)
        print(f"[Breeze Bridge] Strategy 2: direct session_key assignment")

        ok, test_result = _test_breeze_instance(b2)
        if ok:
            breeze_instance = b2
            session_expiry = datetime.now() + timedelta(hours=23)
            _build_symbol_map()
            save_session_to_disk(api_key, api_secret, b2.user_id, b2.session_key)
            print(f"[Breeze Bridge] Session initialized via direct assignment, user_id={b2.user_id}")
            return {"success": True, "message": "Session initialized (direct)", "session_key": b2.session_key}
        else:
            msg = f"Direct assignment test call failed: {test_result}"
            print(f"[Breeze Bridge] {msg}")
            errors.append(msg)
    except Exception as e2:
        msg = f"Direct assignment failed: {e2}"
        print(f"[Breeze Bridge] {msg}")
        errors.append(msg)

    breeze_instance = None
    combined = " | ".join(errors)
    print(f"[Breeze Bridge] Both strategies failed: {combined}")
    return {"success": False, "error": combined}


def _safe_float(val, default=0.0):
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _safe_int(val, default=0):
    if val is None:
        return default
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default


def get_option_chain(symbol, expiry=None, right_filter=None):
    if not breeze_instance:
        return {"error": "Breeze session not initialized", "strikes": []}

    cache_key = f"oc:{symbol}:{expiry}:{right_filter}"
    cached = _cache_get(cache_key)
    if cached:
        print(f"[Breeze Bridge] Cache hit for {cache_key}")
        return cached

    try:
        all_strikes = {}
        spot_price = 0.0
        expiry_dates = set()
        logged_sample = False
        lot_sizes = get_lot_sizes()

        breeze_code = _resolve_stock_code(symbol)
        sides = [right_filter] if right_filter else ["call", "put"]

        for r in sides:
            params = {
                "stock_code": breeze_code,
                "exchange_code": "NFO",
                "product_type": "options",
                "right": r,
            }
            if expiry:
                params["expiry_date"] = f"{expiry}T06:00:00.000Z"
                params["strike_price"] = ""
            else:
                params["strike_price"] = _guess_strike(symbol)

            print(f"[Breeze Bridge] {symbol}({breeze_code}) {r}: calling API with params={params}")
            result = breeze_instance.get_option_chain_quotes(**params)

            _has_data = (
                result and result.get("Status") == 200
                and isinstance(result.get("Success"), list)
                and len(result.get("Success", [])) > 0
            )
            n = len(result.get("Success", []) if result and isinstance(result.get("Success"), list) else [])
            print(f"[Breeze Bridge] {symbol}({breeze_code}) {r}: Status={result.get('Status') if result else None}, Records={n}, Error={result.get('Error','') if result else 'None'}")

            if not _has_data and not expiry:
                guess = _guess_strike(symbol)
                if guess:
                    base = int(guess)
                    step = _get_strike_step(symbol.upper())
                    params["strike_price"] = str(base)
                    print(f"[Breeze Bridge] {symbol} {r}: retry with ATM strike {base}")
                    result = breeze_instance.get_option_chain_quotes(**params)
                    _has_data = (
                        result and result.get("Status") == 200
                        and isinstance(result.get("Success"), list)
                        and len(result.get("Success", [])) > 0
                    )
                    if not _has_data:
                        for offset_mult in [-5, 5, -10, 10]:
                            alt_strike = str(base + offset_mult * step)
                            params["strike_price"] = alt_strike
                            result = breeze_instance.get_option_chain_quotes(**params)
                            if result and result.get("Status") == 200 and result.get("Success"):
                                print(f"[Breeze Bridge] {symbol} {r}: found data at strike {alt_strike}")
                                break

            if not result or result.get("Status") != 200 or result.get("Error"):
                err_msg = result.get("Error") if result else "no result"
                status = result.get("Status") if result else None
                print(f"[Breeze Bridge] {symbol} {r} API error: Status={status}, Error={err_msg}")
                continue

            records = result.get("Success", [])
            if not isinstance(records, list):
                continue

            if records and not logged_sample:
                sample = records[0]
                print(f"[Breeze Bridge] Sample keys: {sorted(sample.keys())}")
                non_zero = {k: v for k, v in sample.items() if v and v != "0" and v != 0}
                print(f"[Breeze Bridge] Sample non-zero: {non_zero}")
                logged_sample = True

            for rec in records:
                strike = _safe_float(rec.get("strike_price"))
                if strike <= 0:
                    continue

                if not spot_price:
                    spot_price = _safe_float(rec.get("spot_price"))

                exp_date = rec.get("expiry_date", "")
                if exp_date:
                    try:
                        parsed = datetime.strptime(exp_date, "%d-%b-%Y")
                        expiry_dates.add(parsed.strftime("%Y-%m-%d"))
                    except ValueError:
                        expiry_dates.add(exp_date.split("T")[0])

                new_strike = {
                    "strike": strike,
                    "callOI": 0, "callOIChange": 0, "callVolume": 0,
                    "callIV": 0.0, "callLTP": 0.0, "callNetChange": 0.0,
                    "callBidPrice": 0.0, "callAskPrice": 0.0,
                    "callDelta": 0.0, "callGamma": 0.0, "callTheta": 0.0, "callVega": 0.0,
                    "putOI": 0, "putOIChange": 0, "putVolume": 0,
                    "putIV": 0.0, "putLTP": 0.0, "putNetChange": 0.0,
                    "putBidPrice": 0.0, "putAskPrice": 0.0,
                    "putDelta": 0.0, "putGamma": 0.0, "putTheta": 0.0, "putVega": 0.0,
                }
                existing = all_strikes.get(strike, new_strike)

                ltp = _safe_float(rec.get("ltp"))
                oi_raw = _safe_float(rec.get("open_interest"))
                volume_raw = _safe_int(rec.get("total_quantity_traded"))
                iv = _safe_float(
                    rec.get("implied_volatility") or rec.get("iv") or rec.get("volatility")
                )
                oi_change_raw = _safe_float(
                    rec.get("chnge_oi") or rec.get("change_oi") or rec.get("oi_change")
                )

                # Breeze returns raw quantity; NSE displays contracts (lots)
                lot = lot_sizes.get(symbol.upper(), FALLBACK_LOT_SIZES.get(symbol.upper(), 1)) or 1
                oi = int(oi_raw / lot) if lot > 1 else int(oi_raw)
                volume = int(volume_raw / lot) if lot > 1 else int(volume_raw)
                oi_change = round(oi_change_raw / lot, 2) if lot > 1 else oi_change_raw
                prev_close = _safe_float(
                    rec.get("close_price") or rec.get("previous_close") or rec.get("close")
                )
                net_change = round(ltp - prev_close, 2) if ltp > 0 and prev_close > 0 else 0.0
                bid = _safe_float(rec.get("best_bid_price") or rec.get("bid_price"))
                ask = _safe_float(rec.get("best_offer_price") or rec.get("ask_price"))

                side = (rec.get("right") or rec.get("option_type") or r).lower()
                if side == "call":
                    existing["callOI"] = oi
                    existing["callOIChange"] = oi_change
                    existing["callVolume"] = volume
                    existing["callIV"] = iv
                    existing["callLTP"] = ltp
                    existing["callNetChange"] = net_change
                    existing["callBidPrice"] = bid
                    existing["callAskPrice"] = ask
                else:
                    existing["putOI"] = oi
                    existing["putOIChange"] = oi_change
                    existing["putVolume"] = volume
                    existing["putIV"] = iv
                    existing["putLTP"] = ltp
                    existing["putNetChange"] = net_change
                    existing["putBidPrice"] = bid
                    existing["putAskPrice"] = ask

                all_strikes[strike] = existing

        if not all_strikes:
            print(f"[Breeze Bridge] {symbol} expiry={expiry}: no strikes returned from API")
            return {"symbol": symbol, "strikes": [], "expiry": expiry or "", "expiries": sorted(expiry_dates)}

        # Calculate time to expiry
        tte_days = 7
        if expiry:
            try:
                exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
                now = datetime.now().replace(hour=15, minute=30)
                tte_days = max(0.5, (exp_dt - now).total_seconds() / 86400.0)
            except ValueError:
                pass

        # Calculate IV from price when API doesn't provide it, then compute Greeks
        if spot_price > 0:
            iv_calculated = 0
            for sd in all_strikes.values():
                s = sd["strike"]
                # Call side: compute IV if missing, then Greeks
                if sd["callIV"] <= 0 and sd["callLTP"] > 0:
                    sd["callIV"] = implied_vol_bs(spot_price, s, tte_days, sd["callLTP"], "call")
                    if sd["callIV"] > 0:
                        iv_calculated += 1
                if sd["callIV"] > 0:
                    cg = calc_greeks(spot_price, s, tte_days, sd["callIV"], "call")
                    sd["callDelta"] = cg["delta"]
                    sd["callGamma"] = cg["gamma"]
                    sd["callTheta"] = cg["theta"]
                    sd["callVega"] = cg["vega"]

                # Put side: compute IV if missing, then Greeks
                if sd["putIV"] <= 0 and sd["putLTP"] > 0:
                    sd["putIV"] = implied_vol_bs(spot_price, s, tte_days, sd["putLTP"], "put")
                    if sd["putIV"] > 0:
                        iv_calculated += 1
                if sd["putIV"] > 0:
                    pg = calc_greeks(spot_price, s, tte_days, sd["putIV"], "put")
                    sd["putDelta"] = pg["delta"]
                    sd["putGamma"] = pg["gamma"]
                    sd["putTheta"] = pg["theta"]
                    sd["putVega"] = pg["vega"]

            if iv_calculated > 0:
                print(f"[Breeze Bridge] Calculated IV for {iv_calculated} legs (API didn't provide)")

        strikes = sorted(all_strikes.values(), key=lambda s: s["strike"])
        total_call_oi = sum(s["callOI"] for s in strikes)
        total_put_oi = sum(s["putOI"] for s in strikes)
        pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0

        max_pain_strike = 0
        min_pain = float("inf")
        for st in strikes:
            pain = 0
            for s2 in strikes:
                if s2["strike"] < st["strike"]:
                    pain += (st["strike"] - s2["strike"]) * s2["putOI"]
                if s2["strike"] > st["strike"]:
                    pain += (s2["strike"] - st["strike"]) * s2["callOI"]
            if pain < min_pain:
                min_pain = pain
                max_pain_strike = st["strike"]

        active_count = sum(
            1 for s in strikes if s["callOI"] > 0 or s["putOI"] > 0 or s["callLTP"] > 0 or s["putLTP"] > 0
        )
        print(f"[Breeze Bridge] {symbol} expiry={expiry}: {len(strikes)} total strikes, {active_count} with data, spot={spot_price}")

        sym_upper = symbol.upper()
        lot = lot_sizes.get(sym_upper, FALLBACK_LOT_SIZES.get(sym_upper, 0))

        result = {
            "symbol": sym_upper,
            "expiry": expiry or (sorted(expiry_dates)[0] if expiry_dates else ""),
            "underlyingValue": spot_price,
            "spotPrice": spot_price,
            "strikes": strikes,
            "pcr": pcr,
            "maxPain": max_pain_strike,
            "totalCallOI": total_call_oi,
            "totalPutOI": total_put_oi,
            "expiries": sorted(expiry_dates),
            "lotSize": lot,
            "source": "breeze-python",
        }
        _cache_set(cache_key, result)
        return result
    except Exception as e:
        print(f"[Breeze Bridge] get_option_chain error: {e}")
        return {"error": str(e), "strikes": []}


_spot_price_cache = {}
_spot_price_cache_lock = threading.Lock()

def _fetch_spot_from_yahoo(symbol):
    """Fetch live spot price from Yahoo Finance for dynamic ATM calculation."""
    yahoo_map = {
        "NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
        "MIDCPNIFTY": "NIFTY_MID_SELECT.NS", "SENSEX": "^BSESN", "NIFTYNXT50": "^NSMIDCP",
    }
    ticker = yahoo_map.get(symbol.upper(), f"{symbol.upper()}.NS")
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1d"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        resp = urllib.request.urlopen(req, timeout=8)
        data = json.loads(resp.read().decode())
        price = data.get("chart", {}).get("result", [{}])[0].get("meta", {}).get("regularMarketPrice", 0)
        if price and price > 0:
            with _spot_price_cache_lock:
                _spot_price_cache[symbol.upper()] = {"price": price, "at": datetime.now()}
            return price
    except Exception as e:
        print(f"[Breeze Bridge] Yahoo spot fetch for {symbol}: {e}")
    return None


def _fetch_spot_from_breeze(symbol):
    """Fetch live spot price from Breeze API itself — most reliable source."""
    if not breeze_instance:
        return None
    indices = {"NIFTY", "BANKNIFTY", "CNXBAN", "FINNIFTY", "FNXFIN", "NIFFIN",
               "MIDCPNIFTY", "MCDNTY", "NIFSEL", "SENSEX", "NIFTYNXT50", "NIFNXT", "NIFNEX"}
    if symbol.upper() in indices:
        return None
    breeze_code = _resolve_stock_code(symbol)
    try:
        result = breeze_instance.get_quotes(
            stock_code=breeze_code, exchange_code="NSE", product_type="cash",
        )
        if result and result.get("Status") == 200 and isinstance(result.get("Success"), list):
            records = result["Success"]
            if records and len(records) > 0:
                ltp = _safe_float(records[0].get("ltp"))
                if ltp > 0:
                    with _spot_price_cache_lock:
                        _spot_price_cache[symbol.upper()] = {"price": ltp, "at": datetime.now()}
                    print(f"[Breeze Bridge] Live spot for {symbol}: {ltp} (from Breeze API)")
                    return ltp
    except Exception as e:
        print(f"[Breeze Bridge] Breeze spot fetch for {symbol}: {e}")
    return None


def _guess_strike(symbol):
    """Return ATM strike: cache → Breeze API → Yahoo → hardcoded fallback."""
    sym = symbol.upper()

    # 1. Check cache (valid for 30 seconds)
    with _spot_price_cache_lock:
        cached = _spot_price_cache.get(sym)
        if cached and (datetime.now() - cached["at"]).total_seconds() < 30:
            spot = cached["price"]
            step = _get_strike_step(sym)
            atm = round(spot / step) * step
            return str(int(atm))

    # 2. Try Breeze API live quote
    spot = _fetch_spot_from_breeze(sym)

    # 3. Try Yahoo Finance
    if not spot:
        spot = _fetch_spot_from_yahoo(sym)

    if spot:
        step = _get_strike_step(sym)
        atm = round(spot / step) * step
        return str(int(atm))

    # 4. Hardcoded fallback — updated periodically, better than nothing
    fallback = {
        "NIFTY": "23800", "BANKNIFTY": "55700", "FINNIFTY": "25000",
        "MIDCPNIFTY": "13000", "NIFTYNXT50": "24000", "SENSEX": "78000",
        "RELIANCE": "1250", "TCS": "3400", "HDFCBANK": "1800", "INFY": "1550",
        "ICICIBANK": "1350", "SBIN": "750", "BHARTIARTL": "1700", "KOTAKBANK": "1950",
        "ITC": "420", "LT": "3300", "AXISBANK": "1100", "BAJFINANCE": "8500",
        "WIPRO": "250", "HCLTECH": "1600", "MARUTI": "11500", "TATAMOTORS": "650",
        "SUNPHARMA": "1700", "TITAN": "3100", "ADANIENT": "2300", "HINDUNILVR": "2300",
        "TATASTEEL": "140", "NTPC": "340", "POWERGRID": "290", "ONGC": "250",
        "JSWSTEEL": "1000", "M&M": "2700", "BAJAJFINSV": "1800",
        "ULTRACEMCO": "11000", "NESTLEIND": "2300",
    }
    result = fallback.get(sym, "")
    if result:
        print(f"[Breeze Bridge] Using fallback strike {result} for {sym} (live sources unavailable)")
    return result


def _get_strike_step(symbol):
    """Return strike price step size for a symbol. Uses spot price for stocks."""
    index_steps = {
        "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25,
        "NIFTYNXT50": 50, "SENSEX": 100,
    }
    sym = symbol.upper()
    if sym in index_steps:
        return index_steps[sym]

    # For stocks, step size depends on the price range
    with _spot_price_cache_lock:
        cached = _spot_price_cache.get(sym)
    if cached:
        price = cached["price"]
        if price > 5000:
            return 50
        if price > 1000:
            return 20
        if price > 500:
            return 10
        return 5
    return 50


def get_expiries(symbol):
    if not breeze_instance:
        return {"error": "Breeze session not initialized", "expiries": []}

    cache_key = f"exp:{symbol}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    try:
        sym = symbol.upper()
        breeze_code = _resolve_stock_code(sym)
        strike = _guess_strike(sym)
        result = breeze_instance.get_option_chain_quotes(
            stock_code=breeze_code, exchange_code="NFO",
            product_type="options", right="call", strike_price=strike,
        )

        # Retry with alternative strikes if first attempt fails
        if not result or result.get("Status") != 200 or not result.get("Success"):
            base = int(strike) if strike else 0
            step = _get_strike_step(sym)
            for offset_mult in [-5, 5, -10, 10, -20, 20, -30, 30, -50, 50]:
                alt_strike = str(base + offset_mult * step)
                result = breeze_instance.get_option_chain_quotes(
                    stock_code=breeze_code, exchange_code="NFO",
                    product_type="options", right="call", strike_price=alt_strike,
                )
                if result and result.get("Status") == 200 and result.get("Success"):
                    print(f"[Breeze Bridge] Expiries {sym}: succeeded with alternate strike {alt_strike}")
                    break

        if not result or result.get("Status") != 200:
            print(f"[Breeze Bridge] Expiries {sym}: status={result.get('Status') if result else None}, err={result.get('Error') if result else ''}")
            return {"expiries": [], "error": f"API status {result.get('Status') if result else 'None'}"}

        records = result.get("Success", [])
        if not isinstance(records, list):
            return {"expiries": []}

        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        expiry_set = set()
        for rec in records:
            raw = rec.get("expiry_date", "")
            if not raw:
                continue
            try:
                parsed = datetime.strptime(raw, "%d-%b-%Y")
                if parsed >= today:
                    expiry_set.add(parsed.strftime("%Y-%m-%d"))
            except ValueError:
                date_str = raw.split("T")[0]
                if date_str:
                    expiry_set.add(date_str)

        print(f"[Breeze Bridge] Expiries {sym}: {len(expiry_set)} found")
        result_data = {"expiries": sorted(expiry_set)}
        _cache_set(cache_key, result_data)
        return result_data
    except Exception as e:
        print(f"[Breeze Bridge] get_expiries error for {symbol}: {e}")
        return {"expiries": [], "error": str(e)}


def get_historical_data(symbol, interval="5minute", from_date=None, to_date=None, exchange="NSE"):
    """Fetch historical candle data via Breeze API."""
    if not breeze_instance:
        return {"error": "Breeze session not initialized", "bars": []}

    cache_key = f"hist:{symbol}:{interval}:{from_date}:{to_date}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    if not from_date:
        from_date = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    if not to_date:
        to_date = datetime.now().strftime("%Y-%m-%d")

    interval_map = {
        "1minute": "1minute", "1m": "1minute",
        "5minute": "5minute", "5m": "5minute",
        "15minute": "15minute", "15m": "15minute",
        "30minute": "30minute", "30m": "30minute",
        "1hour": "1hour", "1h": "1hour",
        "1day": "1day", "1d": "1day",
    }
    breeze_interval = interval_map.get(interval, "5minute")

    exchange_code = "MCX" if exchange == "MCX" else "NSE"
    product_type = "futures" if exchange == "MCX" else "cash"

    breeze_code = _resolve_stock_code(symbol)
    try:
        result = breeze_instance.get_historical_data_v2(
            interval=breeze_interval,
            from_date=f"{from_date}T07:00:00.000Z",
            to_date=f"{to_date}T07:00:00.000Z",
            stock_code=breeze_code,
            exchange_code=exchange_code,
            product_type=product_type,
        )

        if not result or result.get("Status") != 200:
            err = result.get("Error", "Unknown") if result else "No response"
            print(f"[Breeze Bridge] Historical {symbol} {interval}: Status={result.get('Status') if result else None}, Error={err}")
            return {"symbol": symbol, "bars": [], "error": str(err)}

        records = result.get("Success", [])
        if not isinstance(records, list):
            return {"symbol": symbol, "bars": []}

        bars = []
        for rec in records:
            o = _safe_float(rec.get("open"))
            h = _safe_float(rec.get("high"))
            l = _safe_float(rec.get("low"))
            c = _safe_float(rec.get("close"))
            v = _safe_int(rec.get("volume", rec.get("total_quantity_traded", 0)))
            ts = rec.get("datetime", rec.get("date", rec.get("timestamp", "")))
            if o > 0:
                bars.append({"timestamp": str(ts)[:19], "open": o, "high": h, "low": l, "close": c, "volume": v})

        print(f"[Breeze Bridge] Historical {symbol} {interval} {from_date}→{to_date}: {len(bars)} bars")
        result_data = {"symbol": symbol, "bars": bars, "count": len(bars)}
        if len(bars) > 0:
            _cache_set(cache_key, result_data)
        return result_data
    except Exception as e:
        print(f"[Breeze Bridge] Historical {symbol} error: {e}")
        return {"symbol": symbol, "bars": [], "error": str(e)}


class BreezeHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[Breeze Bridge] {args[0]}")

    def send_json(self, data, status=200):
        try:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except BrokenPipeError:
            print("[Breeze Bridge] Client disconnected (BrokenPipeError) — ignoring")
        except ConnectionResetError:
            print("[Breeze Bridge] Client reset connection — ignoring")
        except Exception as e:
            print(f"[Breeze Bridge] Error sending response: {e}")

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")
            params = parse_qs(parsed.query)

            if path == "/health":
                self.send_json({
                    "status": "ok",
                    "session_active": breeze_instance is not None,
                    "session_expiry": session_expiry.isoformat() if session_expiry else None,
                })

            elif path.startswith("/option-chain/"):
                symbol = path.split("/")[-1]
                expiry = params.get("expiry", [None])[0]
                data = get_option_chain(symbol, expiry)
                self.send_json(data)

            elif path.startswith("/expiries/"):
                symbol = path.split("/")[-1]
                data = get_expiries(symbol)
                self.send_json(data)

            elif path == "/lot-sizes":
                force = params.get("force", ["0"])[0] == "1"
                sizes = get_lot_sizes(force_refresh=force)
                self.send_json({
                    "lotSizes": sizes,
                    "count": len(sizes),
                    "source": "nse" if _lot_size_cache_time and (datetime.now() - _lot_size_cache_time).total_seconds() < 86400 else "fallback",
                    "cachedAt": _lot_size_cache_time.isoformat() if _lot_size_cache_time else None,
                })

            elif path.startswith("/lot-size/"):
                sym = path.split("/")[-1].upper()
                sizes = get_lot_sizes()
                lot = sizes.get(sym, FALLBACK_LOT_SIZES.get(sym, 0))
                self.send_json({"symbol": sym, "lotSize": lot, "source": "nse" if lot else "unknown"})

            elif path.startswith("/order/status/"):
                order_id = path.split("/")[-1]
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.get_order_detail(
                        exchange_code="NSE",
                        order_id=order_id,
                    )
                    orders = result.get("Success", []) if isinstance(result, dict) else []
                    if orders and len(orders) > 0:
                        o = orders[0] if isinstance(orders, list) else orders
                        status_map = {"Executed": "FILLED", "Cancelled": "CANCELLED", "Rejected": "REJECTED"}
                        raw_status = o.get("order_status", o.get("status", "UNKNOWN"))
                        self.send_json({
                            "status": status_map.get(raw_status, raw_status),
                            "filled_qty": int(o.get("filled_quantity", o.get("quantity", 0))),
                            "avg_price": float(o.get("average_price", o.get("price", 0))),
                        })
                    else:
                        self.send_json({"status": "UNKNOWN", "filled_qty": 0, "avg_price": 0})
                except Exception as e:
                    self.send_json({"error": str(e)}, 500)

            elif path == "/positions":
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.get_portfolio_positions()
                    positions = result.get("Success", []) if isinstance(result, dict) else []
                    formatted = []
                    if isinstance(positions, list):
                        for p in positions:
                            formatted.append({
                                "stock_code": p.get("stock_code", ""),
                                "quantity": p.get("quantity", 0),
                                "average_price": p.get("average_price", 0),
                                "ltp": p.get("ltp", 0),
                                "pnl": p.get("pnl", 0),
                                "product": p.get("product", "cash"),
                            })
                    self.send_json({"positions": formatted})
                except Exception as e:
                    self.send_json({"error": str(e), "positions": []}, 500)

            elif path == "/margin":
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.get_margin(exchange_code="NSE")
                    margin_data = result.get("Success", {}) if isinstance(result, dict) else {}
                    if isinstance(margin_data, list) and len(margin_data) > 0:
                        margin_data = margin_data[0]
                    available = float(margin_data.get("cash_available", margin_data.get("available_margin", 0)))
                    used = float(margin_data.get("margin_used", 0))
                    self.send_json({"available": available, "used": used, "total": available + used})
                except Exception as e:
                    self.send_json({"error": str(e), "available": 0, "used": 0, "total": 0}, 500)

            elif path.startswith("/quote/"):
                symbol = path.split("/")[-1]
                exchange = params.get("exchange", ["NSE"])[0]
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                breeze_code = _resolve_stock_code(symbol)
                try:
                    result = breeze_instance.get_quotes(
                        stock_code=breeze_code,
                        exchange_code=exchange,
                        product_type="cash",
                    )
                    quotes = result.get("Success", []) if isinstance(result, dict) else []
                    if quotes and isinstance(quotes, list) and len(quotes) > 0:
                        q = quotes[0]
                        self.send_json({
                            "symbol": symbol,
                            "ltp": float(q.get("ltp", 0)),
                            "change": float(q.get("ltp_change", q.get("change", 0))),
                            "changePercent": float(q.get("ltp_percent_change", q.get("percent_change", 0))),
                            "volume": int(q.get("total_quantity_traded", q.get("volume", 0))),
                            "timestamp": datetime.now().isoformat(),
                        })
                    else:
                        self.send_json({"symbol": symbol, "ltp": 0, "change": 0, "changePercent": 0, "volume": 0, "timestamp": datetime.now().isoformat()})
                except Exception as e:
                    self.send_json({"error": str(e)}, 500)

            elif path == "/debug/symbol-map":
                self.send_json({
                    "hardcoded": len(_HARDCODED_BREEZE_CODES),
                    "nfo_codes_count": len(_dynamic_nfo_codes),
                    "mappings": _HARDCODED_BREEZE_CODES,
                })

            elif path.startswith("/historical/"):
                symbol = path.split("/")[-1].upper()
                interval = params.get("interval", ["5minute"])[0]
                from_date = params.get("from", [None])[0]
                to_date = params.get("to", [None])[0]
                exchange = params.get("exchange", ["NSE"])[0]
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active", "bars": []}, 503)
                    return
                data = get_historical_data(symbol, interval, from_date, to_date, exchange)
                self.send_json(data)

            else:
                self.send_json({"error": "Not found"}, 404)
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f"[Breeze Bridge] GET error: {e}")
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/")

            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}

            if path == "/init":
                api_key = body.get("api_key", "")
                api_secret = body.get("api_secret", "")
                session_token = body.get("session_token", "")

                if not all([api_key, api_secret, session_token]):
                    self.send_json({"error": "api_key, api_secret, and session_token required"}, 400)
                    return

                result = init_breeze(api_key, api_secret, session_token)
                self.send_json(result, 200 if result.get("success") else 500)

            elif path == "/order/place":
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.place_order(
                        stock_code=body.get("stock_code", ""),
                        exchange_code=body.get("exchange_code", "NSE"),
                        product=body.get("product", "cash"),
                        action=body.get("action", "buy"),
                        order_type=body.get("order_type", "market"),
                        quantity=str(body.get("quantity", 1)),
                        price=str(body.get("price", 0)),
                        stoploss=str(body.get("stoploss", 0)),
                        validity=body.get("validity", "day"),
                    )
                    order_id = ""
                    if isinstance(result, dict):
                        success = result.get("Success")
                        if isinstance(success, dict):
                            order_id = success.get("order_id", "")
                        elif isinstance(success, str):
                            order_id = success
                    self.send_json({"order_id": order_id, "raw": result})
                except Exception as e:
                    self.send_json({"error": str(e)}, 500)

            elif path == "/order/modify":
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.modify_order(
                        order_id=body.get("order_id", ""),
                        exchange_code=body.get("exchange_code", "NSE"),
                        quantity=str(body.get("qty", 0)) if body.get("qty") else None,
                        price=str(body.get("price", 0)) if body.get("price") else None,
                        stoploss=str(body.get("triggerPrice", 0)) if body.get("triggerPrice") else None,
                    )
                    self.send_json({"message": "Order modified", "raw": result})
                except Exception as e:
                    self.send_json({"error": str(e)}, 500)

            elif path == "/order/cancel":
                if breeze_instance is None:
                    self.send_json({"error": "Breeze session not active"}, 503)
                    return
                try:
                    result = breeze_instance.cancel_order(
                        order_id=body.get("order_id", ""),
                        exchange_code=body.get("exchange_code", "NSE"),
                    )
                    self.send_json({"message": "Order cancelled", "raw": result})
                except Exception as e:
                    self.send_json({"error": str(e)}, 500)

            else:
                self.send_json({"error": "Not found"}, 404)
        except BrokenPipeError:
            pass
        except Exception as e:
            print(f"[Breeze Bridge] POST error: {e}")
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass


if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)


if __name__ == "__main__":
    port = int(os.environ.get("BREEZE_BRIDGE_PORT", 8001))

    print(f"[Breeze Bridge] Starting on http://127.0.0.1:{port}", flush=True)

    try:
        restore_session_from_disk()
    except Exception as e:
        print(f"[Breeze Bridge] Session restore failed (non-fatal): {e}", flush=True)

    try:
        lot_sizes = get_lot_sizes()
        print(f"[Breeze Bridge] Lot sizes loaded: {len(lot_sizes)} symbols", flush=True)
    except Exception as e:
        print(f"[Breeze Bridge] Lot size fetch failed (non-fatal): {e}", flush=True)

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
        request_queue_size = 10
        allow_reuse_address = True

    try:
        server = ThreadedHTTPServer(("127.0.0.1", port), BreezeHandler)
    except OSError as e:
        print(f"[Breeze Bridge] FATAL: Cannot bind to port {port}: {e}", flush=True)
        print(f"[Breeze Bridge] Try: sudo fuser -k {port}/tcp", flush=True)
        sys.exit(1)

    print(f"[Breeze Bridge] Ready (threaded). Session active: {breeze_instance is not None}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Breeze Bridge] Shutting down.", flush=True)
        server.server_close()
