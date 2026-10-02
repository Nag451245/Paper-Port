"""
Offline tests for get_historical_data — no Breeze session needed; the SDK is faked.
Usage: python test_historical.py
"""

import unittest
from datetime import datetime, timedelta

import app


class FakeBreeze:
    """Records every get_historical_data_v2 call and serves one bar per day in range."""

    def __init__(self, fail_on=None, no_data_before=None):
        self.calls = []
        self.fail_on = fail_on
        self.no_data_before = no_data_before

    def get_historical_data_v2(self, **kw):
        self.calls.append(kw)
        start = datetime.strptime(kw["from_date"][:10], "%Y-%m-%d")
        end = datetime.strptime(kw["to_date"][:10], "%Y-%m-%d")
        if self.fail_on and kw["from_date"][:10] == self.fail_on:
            return {"Status": 500, "Error": "Rate limit exceeded"}
        if self.no_data_before and end < datetime.strptime(self.no_data_before, "%Y-%m-%d"):
            return {"Status": 500, "Error": "No Data Found"}
        rows, d = [], start
        while d <= end:
            rows.append({"datetime": d.strftime("%Y-%m-%d 09:15:00"), "open": "100", "high": "101",
                         "low": "99", "close": "100.5", "volume": "10"})
            d += timedelta(days=1)
        return {"Status": 200, "Success": rows}


class HistoricalTests(unittest.TestCase):
    def setUp(self):
        app._response_cache.clear()
        app.time.sleep = lambda s: None          # no rate-limit pauses in tests
        self.fake = FakeBreeze()
        app.breeze_instance = self.fake

    def fetch(self, *a, **kw):
        return app.get_historical_data(*a, **kw)

    def test_daily_alias_is_daily_not_5minute(self):
        self.fetch("RELIANCE", "day", "2025-01-01", "2025-01-10")
        self.assertEqual(self.fake.calls[0]["interval"], "1day")

    def test_long_5minute_range_is_split_into_windows_and_stitched(self):
        r = self.fetch("RELIANCE", "5minute", "2025-01-01", "2025-03-31")
        # 900 bars per call / 75 bars per session = 12-day windows over 90 days
        self.assertEqual(len(self.fake.calls), 8)
        self.assertEqual(r["count"], 90)
        stamps = [b["timestamp"] for b in r["bars"]]
        self.assertEqual(stamps, sorted(set(stamps)), "bars must be sorted and unique")
        # windows cover the range with no gap and no overlap
        for prev, cur in zip(self.fake.calls, self.fake.calls[1:]):
            gap = datetime.strptime(cur["from_date"][:10], "%Y-%m-%d") - datetime.strptime(prev["to_date"][:10], "%Y-%m-%d")
            self.assertEqual(gap, timedelta(days=1))

    def test_option_contract_parameters(self):
        self.fetch("NIFTY", "5minute", "2025-02-01", "2025-02-05",
                   product="options", expiry="2025-02-27", strike="24000", right="CALL", exchange="NFO")
        kw = self.fake.calls[0]
        self.assertEqual((kw["exchange_code"], kw["product_type"], kw["right"], kw["strike_price"]),
                         ("NFO", "options", "call", "24000"))
        self.assertTrue(kw["expiry_date"].startswith("2025-02-27"))

    def test_futures_contract_parameters(self):
        self.fetch("NIFTY", "1day", "2025-02-01", "2025-02-20", product="futures", expiry="2025-02-27", exchange="NFO")
        kw = self.fake.calls[0]
        self.assertEqual((kw["exchange_code"], kw["product_type"], kw["right"], kw["strike_price"]),
                         ("NFO", "futures", "others", "0"))

    def test_mcx_futures_windows_are_smaller(self):
        self.fetch("CRUDEOIL", "5minute", "2025-01-01", "2025-01-20", exchange="MCX", expiry="2025-01-20")
        self.assertEqual(self.fake.calls[0]["exchange_code"], "MCX")
        self.assertEqual(len(self.fake.calls), 4)   # 900 / 174 = 5-day windows over 20 days

    def test_derivative_without_expiry_is_refused(self):
        r = self.fetch("NIFTY", "1day", "2025-01-01", "2025-01-10", product="futures")
        self.assertEqual(r["bars"], [])
        self.assertIn("expiry", r["error"])
        self.assertEqual(self.fake.calls, [])

    def test_option_without_strike_is_refused(self):
        r = self.fetch("NIFTY", "1day", "2025-01-01", "2025-01-10", product="options", expiry="2025-01-30", right="call")
        self.assertIn("strike", r["error"])

    def test_failed_window_fails_the_whole_request(self):
        app.breeze_instance = FakeBreeze(fail_on="2025-01-13")
        r = self.fetch("TCS", "5minute", "2025-01-01", "2025-01-31")
        self.assertEqual(r["bars"], [])
        self.assertIn("2025-01-13", r["error"])
        self.assertIn("->", r["error"])

    def test_no_data_windows_are_skipped_not_fatal(self):
        # an expired contract has nothing before it was listed
        app.breeze_instance = FakeBreeze(no_data_before="2025-01-20")
        r = self.fetch("INFY", "5minute", "2025-01-01", "2025-01-31")
        self.assertNotIn("error", r)
        self.assertTrue(all(b["timestamp"] >= "2025-01-13" for b in r["bars"]))

    def test_15minute_and_1hour_are_built_from_5minute(self):
        self.fetch("RELIANCE", "15minute", "2025-01-01", "2025-01-02")
        self.assertEqual(self.fake.calls[0]["interval"], "5minute")

    def test_aggregation_aligns_to_the_session_open(self):
        five = [{"timestamp": f"2025-01-01 {h:02d}:{m:02d}:00", "open": 100 + i, "high": 101 + i,
                 "low": 99 + i, "close": 100.5 + i, "volume": 10}
                for i, (h, m) in enumerate([(9, 15), (9, 20), (9, 25), (9, 30), (10, 10), (10, 15)])]
        q = app._aggregate_bars(five, 15)
        self.assertEqual([b["timestamp"][11:16] for b in q], ["09:15", "09:30", "10:00", "10:15"])
        self.assertEqual((q[0]["open"], q[0]["high"], q[0]["low"], q[0]["close"], q[0]["volume"]), (100, 103, 99, 102.5, 30))
        h = app._aggregate_bars(five, 60)
        self.assertEqual([b["timestamp"][11:16] for b in h], ["09:15", "10:15"])
        self.assertEqual(h[0]["volume"], 50)

    def test_unknown_interval_is_refused(self):
        r = self.fetch("TCS", "7minute", "2025-01-01", "2025-01-05")
        self.assertIn("Unsupported interval", r["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
