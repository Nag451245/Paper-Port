"""
Quick test for Breeze Bridge — initializes session and pulls NIFTY option chain.
Usage: python test_bridge.py
"""

import json
import urllib.request
import urllib.parse
from getpass import getpass
from datetime import datetime, timedelta

BRIDGE_URL = "http://127.0.0.1:8001"


def post_json(url, data):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def get_json(url):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    print("=" * 50)
    print("  Breeze Bridge — Test Script")
    print("=" * 50)

    # Check health first
    try:
        health = get_json(f"{BRIDGE_URL}/health")
        print(f"\nBridge status: {health['status']}")
        print(f"Session active: {health['session_active']}")
    except Exception as e:
        print(f"\nERROR: Bridge not reachable at {BRIDGE_URL}")
        print(f"Start it first: python app.py")
        return

    if not health["session_active"]:
        print("\nSession not active. Enter your ICICI Breeze credentials:")
        api_key = input("  API Key: ").strip()
        api_secret = getpass("  API Secret: ").strip()

        print(f"\n  To get a session token, open this URL in browser:")
        encoded_key = urllib.parse.quote_plus(api_key)
        print(f"  https://api.icicidirect.com/apiuser/login?api_key={encoded_key}")
        print(f"  Log in, and copy the session token from the redirected URL.\n")
        session_token = input("  Session Token: ").strip()

        print("\nInitializing session...")
        result = post_json(f"{BRIDGE_URL}/init", {
            "api_key": api_key,
            "api_secret": api_secret,
            "session_token": session_token,
        })
        print(f"Result: {json.dumps(result, indent=2)}")
        if not result.get("success"):
            print("Session initialization failed. Check credentials.")
            return

    # Get expiries
    print("\n--- Fetching NIFTY expiry dates ---")
    expiries = get_json(f"{BRIDGE_URL}/expiries/NIFTY")
    print(f"Available expiries: {json.dumps(expiries, indent=2)}")

    if expiries.get("expiries"):
        # Find next week's expiry (next Thursday)
        today = datetime.now()
        days_until_next_thu = (3 - today.weekday()) % 7
        if days_until_next_thu == 0:
            days_until_next_thu = 7
        next_thursday = today + timedelta(days=days_until_next_thu)
        target_expiry = next_thursday.strftime("%Y-%m-%d")

        # Find closest expiry to next Thursday
        closest = min(expiries["expiries"], key=lambda d: abs(
            datetime.strptime(d, "%Y-%m-%d") - next_thursday
        ))
        print(f"\nTarget (next Thursday): {target_expiry}")
        print(f"Closest available expiry: {closest}")

        # Fetch option chain
        print(f"\n--- Fetching NIFTY option chain for {closest} ---")
        chain = get_json(f"{BRIDGE_URL}/option-chain/NIFTY?expiry={closest}")

        if chain.get("strikes"):
            print(f"Spot Price: {chain.get('spotPrice')}")
            print(f"Total Strikes: {len(chain['strikes'])}")
            print(f"PCR: {chain.get('pcr')}")
            print(f"Max Pain: {chain.get('maxPain')}")
            print(f"Source: {chain.get('source')}")
            print(f"\nTop 10 strikes near ATM:")
            spot = chain.get("spotPrice", 0)
            sorted_strikes = sorted(chain["strikes"], key=lambda s: abs(s["strike"] - spot))
            for s in sorted_strikes[:10]:
                print(
                    f"  Strike {s['strike']:>8.0f}  |"
                    f"  CE: LTP={s['callLTP']:>8.2f}  OI={s['callOI']:>10.0f}  IV={s['callIV']:>6.2f}"
                    f"  |  PE: LTP={s['putLTP']:>8.2f}  OI={s['putOI']:>10.0f}  IV={s['putIV']:>6.2f}"
                )
        else:
            print(f"No strikes returned: {json.dumps(chain, indent=2)}")
    else:
        print("No expiries returned.")


if __name__ == "__main__":
    main()
