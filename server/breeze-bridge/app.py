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
from urllib.parse import urlparse, parse_qs

try:
    from breeze_connect import BreezeConnect
    from breeze_connect.breeze_connect import ApificationBreeze
except ImportError:
    print("ERROR: breeze-connect not installed. Run: pip install breeze-connect")
    sys.exit(1)

breeze_instance = None
session_expiry = None
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_FILE = os.path.join(SCRIPT_DIR, ".breeze_session.json")

PI = 3.141592653589793
RISK_FREE_RATE = 0.07


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
        b.api_handler = ApificationBreeze(b)

        test = b.get_option_chain_quotes(
            stock_code="NIFTY", exchange_code="NFO",
            product_type="options", right="call", strike_price="24000",
        )
        if test and test.get("Status") == 200:
            breeze_instance = b
            session_expiry = saved_at + timedelta(hours=23)
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


def init_breeze(api_key, api_secret, session_token):
    global breeze_instance, session_expiry

    try:
        b = BreezeConnect(api_key=api_key)
        b.session_key = session_token
        b.secret_key = api_secret
        b.api_util()
        b.api_handler = ApificationBreeze(b)

        test = b.get_option_chain_quotes(
            stock_code="NIFTY", exchange_code="NFO",
            product_type="options", right="call", strike_price="24000",
        )
        if test and test.get("Status") == 200:
            breeze_instance = b
            session_expiry = datetime.now() + timedelta(hours=23)
            save_session_to_disk(api_key, api_secret, b.user_id, b.session_key)
            print(f"[Breeze Bridge] Session initialized, user_id={b.user_id}")
            return {"success": True, "message": "Session initialized"}

        print(f"[Breeze Bridge] Test call returned: {test}")
        breeze_instance = None
        return {"success": False, "error": f"Test call failed: {test}"}
    except Exception as e:
        breeze_instance = None
        print(f"[Breeze Bridge] Init failed: {e}")
        return {"success": False, "error": str(e)}


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

    try:
        all_strikes = {}
        spot_price = 0.0
        expiry_dates = set()
        logged_sample = False

        for r in ["call", "put"]:
            params = {
                "stock_code": symbol.upper(),
                "exchange_code": "NFO",
                "product_type": "options",
                "right": right_filter or r,
            }
            if expiry:
                params["expiry_date"] = f"{expiry}T06:00:00.000Z"

            result = breeze_instance.get_option_chain_quotes(**params)

            if not result or result.get("Status") != 200 or result.get("Error"):
                print(f"[Breeze Bridge] {r} API error: Status={result.get('Status') if result else None}, Error={result.get('Error') if result else 'no result'}")
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
                oi = _safe_float(rec.get("open_interest"))
                volume = _safe_int(rec.get("total_quantity_traded"))
                iv = _safe_float(rec.get("implied_volatility"))
                oi_change = _safe_float(
                    rec.get("chnge_oi") or rec.get("change_oi") or rec.get("oi_change")
                )
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

            if right_filter:
                break

        if not all_strikes:
            return {"symbol": symbol, "strikes": [], "expiry": expiry or "", "expiries": sorted(expiry_dates)}

        # Calculate Greeks using Black-Scholes
        tte_days = 7
        if expiry:
            try:
                exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
                now = datetime.now().replace(hour=15, minute=30)
                tte_days = max(0.5, (exp_dt - now).total_seconds() / 86400.0)
            except ValueError:
                pass

        if spot_price > 0:
            for sd in all_strikes.values():
                s = sd["strike"]
                if sd["callIV"] > 0:
                    cg = calc_greeks(spot_price, s, tte_days, sd["callIV"], "call")
                    sd["callDelta"] = cg["delta"]
                    sd["callGamma"] = cg["gamma"]
                    sd["callTheta"] = cg["theta"]
                    sd["callVega"] = cg["vega"]
                if sd["putIV"] > 0:
                    pg = calc_greeks(spot_price, s, tte_days, sd["putIV"], "put")
                    sd["putDelta"] = pg["delta"]
                    sd["putGamma"] = pg["gamma"]
                    sd["putTheta"] = pg["theta"]
                    sd["putVega"] = pg["vega"]

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

        return {
            "symbol": symbol.upper(),
            "expiry": expiry or (sorted(expiry_dates)[0] if expiry_dates else ""),
            "underlyingValue": spot_price,
            "spotPrice": spot_price,
            "strikes": strikes,
            "pcr": pcr,
            "maxPain": max_pain_strike,
            "totalCallOI": total_call_oi,
            "totalPutOI": total_put_oi,
            "expiries": sorted(expiry_dates),
            "source": "breeze-python",
        }
    except Exception as e:
        print(f"[Breeze Bridge] get_option_chain error: {e}")
        return {"error": str(e), "strikes": []}


def get_expiries(symbol):
    if not breeze_instance:
        return {"error": "Breeze session not initialized", "expiries": []}

    try:
        default_strikes = {
            "NIFTY": "24000", "BANKNIFTY": "50000",
            "FINNIFTY": "23000", "MIDCPNIFTY": "12000",
        }
        strike = default_strikes.get(symbol.upper(), "20000")

        result = breeze_instance.get_option_chain_quotes(
            stock_code=symbol.upper(), exchange_code="NFO",
            product_type="options", right="call", strike_price=strike,
        )

        if not result or result.get("Status") != 200:
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

        return {"expiries": sorted(expiry_set)}
    except Exception as e:
        return {"expiries": [], "error": str(e)}


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

    print(f"[Breeze Bridge] Starting on http://127.0.0.1:{port}")
    restore_session_from_disk()

    server = HTTPServer(("127.0.0.1", port), BreezeHandler)
    print(f"[Breeze Bridge] Ready. Session active: {breeze_instance is not None}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Breeze Bridge] Shutting down.")
        server.server_close()
