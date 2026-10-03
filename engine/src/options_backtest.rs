//! Multi-leg options strategy backtest on past option prices.
//!
//! The server prepares one "cycle" per expiry: which contracts were traded,
//! when to enter and exit, the charges in force on that date, and each leg's
//! 5-minute candles. This module plays every cycle bar by bar:
//!   - enters at the open of the first candle at or after the entry time,
//!     buying a little above and selling a little below the price (slippage);
//!   - marks the position at every candle close, after the charges already
//!     paid and the charges closing would cost, and exits at the target or stop
//!     (measured after charges) or at the exit time;
//!   - held to expiry, settles at the last price with no closing orders, and
//!     charges STT on long options that finish in the money.
//! It returns every trade and totals over these and any earlier trades, so the
//! server can send long backtests in pieces.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::utils::round2;

#[derive(Deserialize, Clone)]
struct Rates {
    per_order: f64,
    stt_sell: f64,
    stt_exercise: f64,
    exchange: f64,
    stamp_buy: f64,
    sebi: f64,
    gst: f64,
}

#[derive(Deserialize)]
struct LegIn {
    label: String,
    option_type: String,
    strike: f64,
    /// + bought, - sold
    qty: i64,
    /// [bar start epoch seconds, open, close]
    bars: Vec<[f64; 3]>,
}

#[derive(Deserialize)]
struct Cycle {
    id: String,
    expiry: String,
    entry_ts: i64,
    exit_ts: i64,
    #[serde(default)]
    settle: bool,
    spot: f64,
    rates: Rates,
    legs: Vec<LegIn>,
}

#[derive(Deserialize, Clone)]
struct Limit {
    /// "pct" of the premium paid or received, or "rupees"
    kind: String,
    value: f64,
}

#[derive(Deserialize)]
struct Rules {
    target: Option<Limit>,
    stop: Option<Limit>,
    #[serde(default)]
    slippage_pct: f64,
}

#[derive(Deserialize)]
struct Input {
    cycles: Vec<Cycle>,
    rules: Rules,
    #[serde(default)]
    prior_trades: Vec<Trade>,
    #[serde(default)]
    prior_skipped: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct TradeLeg {
    label: String,
    qty: i64,
    entry: f64,
    exit: f64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Charges {
    brokerage: f64,
    stt: f64,
    other: f64,
    total: f64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Trade {
    id: String,
    expiry: String,
    entry_time: i64,
    exit_time: i64,
    /// target | stop | time | expiry
    exit_reason: String,
    spot: f64,
    legs: Vec<TradeLeg>,
    /// + = credit received at entry
    entry_premium: f64,
    gross: f64,
    charges: Charges,
    slippage: f64,
    net: f64,
    /// Worst and best P&L after charges while the trade was open
    max_adverse: f64,
    max_favourable: f64,
    margin: f64,
    return_on_margin: f64,
}

fn order_charges(r: &Rates, buy: bool, price: f64, qty: f64, acc: &mut Charges) -> f64 {
    let turnover = price.max(0.0) * qty.abs();
    let brokerage = r.per_order;
    let stt = if buy { 0.0 } else { turnover * r.stt_sell };
    let exchange = turnover * r.exchange;
    let sebi = turnover * r.sebi;
    let stamp = if buy { turnover * r.stamp_buy } else { 0.0 };
    let gst = (brokerage + exchange + sebi) * r.gst;
    acc.brokerage += brokerage;
    acc.stt += stt;
    acc.other += exchange + sebi + stamp + gst;
    brokerage + stt + exchange + sebi + stamp + gst
}

/// What closing every leg at these prices would cost, without recording it.
fn exit_cost(r: &Rates, legs: &[LegIn], prices: &[f64]) -> f64 {
    let mut scratch = Charges::default();
    legs.iter().zip(prices).map(|(l, p)| order_charges(r, l.qty < 0, *p, l.qty as f64, &mut scratch)).sum()
}

fn slipped(price: f64, buy: bool, pct: f64) -> f64 {
    if buy { price * (1.0 + pct / 100.0) } else { (price * (1.0 - pct / 100.0)).max(0.0) }
}

fn limit_rupees(l: &Option<Limit>, base: f64) -> Option<f64> {
    l.as_ref().filter(|l| l.value > 0.0).map(|l| if l.kind == "pct" { base * l.value / 100.0 } else { l.value })
}

fn margin_for(c: &Cycle, entry: &[f64]) -> f64 {
    let legs: Vec<Value> = c.legs.iter().zip(entry).map(|(l, p)| json!({
        "option_type": l.option_type, "strike": l.strike, "premium": p, "quantity": l.qty,
    })).collect();
    crate::options_strategy::compute(json!({ "legs": legs, "spot": c.spot }))
        .ok()
        .and_then(|v| v.pointer("/risk_metrics/capital_required").and_then(|x| x.as_f64()))
        .unwrap_or(0.0)
}

fn simulate(c: &Cycle, rules: &Rules) -> Result<Trade, String> {
    if c.legs.is_empty() { return Err("no legs".into()); }
    let slip = rules.slippage_pct.max(0.0);

    // Entry: the open of each leg's first candle at or after the entry time.
    let mut entry = Vec::with_capacity(c.legs.len());
    let mut entry_time = i64::MAX;
    for l in &c.legs {
        let bar = l.bars.iter().find(|b| b[0] as i64 >= c.entry_ts && (b[0] as i64) < c.exit_ts)
            .ok_or_else(|| format!("no price for {} at entry", l.label))?;
        entry.push(bar[1]);
        entry_time = entry_time.min(bar[0] as i64);
    }
    let mut charges = Charges::default();
    let mut slippage = 0.0;
    let mut entry_eff = Vec::with_capacity(entry.len());
    for (l, p) in c.legs.iter().zip(&entry) {
        let buy = l.qty > 0;
        let e = slipped(*p, buy, slip);
        slippage += (e - p).abs() * l.qty.abs() as f64;
        order_charges(&c.rates, buy, e, l.qty as f64, &mut charges);
        entry_eff.push(e);
    }
    let entry_charges = charges.brokerage + charges.stt + charges.other;
    let entry_premium: f64 = -c.legs.iter().zip(&entry_eff).map(|(l, e)| l.qty as f64 * e).sum::<f64>();
    let base = entry_premium.abs();
    let target = limit_rupees(&rules.target, base);
    let stop = limit_rupees(&rules.stop, base);

    // Walk every candle close after entry, carrying each leg's last price.
    let mut times: Vec<i64> = c.legs.iter()
        .flat_map(|l| l.bars.iter().map(|b| b[0] as i64))
        .filter(|t| *t > entry_time && *t < c.exit_ts)
        .collect();
    times.sort_unstable();
    times.dedup();
    let mut last = entry.clone();
    let mut idx = vec![0usize; c.legs.len()];
    let (mut worst, mut best) = (0.0f64, 0.0f64);
    let mut exit: Option<(i64, String)> = None;
    for t in &times {
        for (i, l) in c.legs.iter().enumerate() {
            while idx[i] < l.bars.len() && (l.bars[idx[i]][0] as i64) <= *t {
                if (l.bars[idx[i]][0] as i64) > entry_time { last[i] = l.bars[idx[i]][2]; }
                idx[i] += 1;
            }
        }
        let gross: f64 = c.legs.iter().zip(&last).zip(&entry_eff).map(|((l, p), e)| l.qty as f64 * (p - e)).sum();
        let net_now = gross - entry_charges - exit_cost(&c.rates, &c.legs, &last);
        worst = worst.min(net_now);
        best = best.max(net_now);
        if target.map_or(false, |v| net_now >= v) { exit = Some((*t, "target".into())); break; }
        if stop.map_or(false, |v| net_now <= -v) { exit = Some((*t, "stop".into())); break; }
    }

    let mut exit_prices = last.clone();
    let (exit_time, reason, settled) = match exit {
        Some((t, r)) => (t + 300, r, false),                       // at that candle's close
        None if c.settle => (c.exit_ts, "expiry".to_string(), true),
        None => {
            // The open of the first candle at or after the exit time, else the last close.
            for (i, l) in c.legs.iter().enumerate() {
                if let Some(b) = l.bars.iter().find(|b| b[0] as i64 >= c.exit_ts) {
                    if barday(b[0] as i64) == barday(c.exit_ts) { exit_prices[i] = b[1]; }
                }
            }
            (c.exit_ts, "time".to_string(), false)
        }
    };

    let mut legs_out = Vec::with_capacity(c.legs.len());
    let mut gross = 0.0;
    for (i, l) in c.legs.iter().enumerate() {
        let x = if settled {
            // Cash-settled at expiry: no closing order. A long option that ends
            // in the money (worth more than a rupee) pays STT on its value.
            if l.qty > 0 && exit_prices[i] > 1.0 {
                let stt = exit_prices[i] * l.qty as f64 * c.rates.stt_exercise;
                charges.stt += stt;
            }
            exit_prices[i]
        } else {
            let buy = l.qty < 0;                                     // closing a sold leg buys it back
            let x = slipped(exit_prices[i], buy, slip);
            slippage += (x - exit_prices[i]).abs() * l.qty.abs() as f64;
            order_charges(&c.rates, buy, x, l.qty as f64, &mut charges);
            x
        };
        gross += l.qty as f64 * (x - entry_eff[i]);
        legs_out.push(TradeLeg { label: l.label.clone(), qty: l.qty, entry: round2(entry_eff[i]), exit: round2(x) });
    }
    charges.total = charges.brokerage + charges.stt + charges.other;
    let net = gross - charges.total;
    let margin = margin_for(c, &entry);
    Ok(Trade {
        id: c.id.clone(),
        expiry: c.expiry.clone(),
        entry_time,
        exit_time,
        exit_reason: reason,
        spot: round2(c.spot),
        legs: legs_out,
        entry_premium: round2(entry_premium),
        gross: round2(gross),
        charges: Charges { brokerage: round2(charges.brokerage), stt: round2(charges.stt), other: round2(charges.other), total: round2(charges.total) },
        slippage: round2(slippage),
        net: round2(net),
        max_adverse: round2(worst.min(net)),
        max_favourable: round2(best.max(net)),
        margin: round2(margin),
        return_on_margin: if margin > 0.0 { round2(net / margin * 100.0) } else { 0.0 },
    })
}

fn barday(t: i64) -> i64 { (t + 19_800).div_euclid(86_400) }

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

fn summarize(trades: &[Trade], skipped: usize) -> Value {
    let n = trades.len();
    let wins: Vec<&Trade> = trades.iter().filter(|t| t.net > 0.0).collect();
    let losses: Vec<&Trade> = trades.iter().filter(|t| t.net <= 0.0).collect();
    let sum = |f: &dyn Fn(&Trade) -> f64| trades.iter().map(f).sum::<f64>();
    let won: f64 = wins.iter().map(|t| t.net).sum();
    let lost: f64 = losses.iter().map(|t| t.net).sum();

    let mut ordered: Vec<&Trade> = trades.iter().collect();
    ordered.sort_by_key(|t| t.exit_time);
    let (mut cum, mut peak, mut dd) = (0.0f64, 0.0f64, 0.0f64);
    let mut equity = Vec::with_capacity(n);
    for t in &ordered {
        cum += t.net;
        peak = peak.max(cum);
        dd = dd.max(peak - cum);
        equity.push(json!({ "t": t.exit_time, "cum": round2(cum), "net": t.net, "id": t.id }));
    }

    let mut by_day: BTreeMap<usize, (usize, usize, f64)> = BTreeMap::new();
    for t in trades {
        let wd = ((t.entry_time + 19_800).div_euclid(86_400) + 4).rem_euclid(7) as usize;
        let e = by_day.entry(wd).or_insert((0, 0, 0.0));
        e.0 += 1;
        if t.net > 0.0 { e.1 += 1; }
        e.2 += t.net;
    }
    let mut by_reason: BTreeMap<String, usize> = BTreeMap::new();
    for t in trades { *by_reason.entry(t.exit_reason.clone()).or_insert(0) += 1; }
    let with_margin: Vec<f64> = trades.iter().filter(|t| t.margin > 0.0).map(|t| t.return_on_margin).collect();

    json!({
        "trades": n,
        "skipped": skipped,
        "wins": wins.len(),
        "losses": losses.len(),
        "win_rate": if n > 0 { round2(wins.len() as f64 / n as f64 * 100.0) } else { 0.0 },
        "gross": round2(sum(&|t: &Trade| t.gross)),
        "charges": round2(sum(&|t: &Trade| t.charges.total)),
        "stt": round2(sum(&|t: &Trade| t.charges.stt)),
        "brokerage": round2(sum(&|t: &Trade| t.charges.brokerage)),
        "slippage": round2(sum(&|t: &Trade| t.slippage)),
        "net": round2(sum(&|t: &Trade| t.net)),
        "avg_win": if wins.is_empty() { 0.0 } else { round2(won / wins.len() as f64) },
        "avg_loss": if losses.is_empty() { 0.0 } else { round2(lost / losses.len() as f64) },
        "profit_factor": if lost < 0.0 { round2(won / lost.abs()) } else if won > 0.0 { 99.0 } else { 0.0 },
        "expectancy": if n > 0 { round2(sum(&|t: &Trade| t.net) / n as f64) } else { 0.0 },
        "max_drawdown": round2(dd),
        "best": trades.iter().map(|t| t.net).fold(None, |a: Option<f64>, x| Some(a.map_or(x, |a| a.max(x)))).map(round2),
        "worst": trades.iter().map(|t| t.net).fold(None, |a: Option<f64>, x| Some(a.map_or(x, |a| a.min(x)))).map(round2),
        "avg_return_on_margin": if with_margin.is_empty() { 0.0 } else { round2(with_margin.iter().sum::<f64>() / with_margin.len() as f64) },
        "by_weekday": by_day.iter().map(|(d, (n, w, net))| json!({ "day": WEEKDAYS[*d], "trades": n, "wins": w, "net": round2(*net) })).collect::<Vec<_>>(),
        "by_exit": by_reason,
        "equity": equity,
    })
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: Input = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;
    let mut trades = Vec::new();
    let mut skipped = Vec::new();
    for c in &input.cycles {
        match simulate(c, &input.rules) {
            Ok(t) => trades.push(t),
            Err(reason) => skipped.push(json!({ "id": c.id, "expiry": c.expiry, "reason": reason })),
        }
    }
    let mut all = input.prior_trades.clone();
    all.extend(trades.iter().cloned());
    let summary = summarize(&all, input.prior_skipped + skipped.len());
    Ok(json!({ "trades": trades, "skipped": skipped, "summary": summary }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rates() -> Value {
        json!({ "per_order": 20.0, "stt_sell": 0.0015, "stt_exercise": 0.0015, "exchange": 0.0003503,
                "stamp_buy": 0.00003, "sebi": 0.000001, "gst": 0.18 })
    }
    // 5-minute bars from 09:15 IST on 2026-10-01 (epoch 1790825700 = 09:15 IST)
    const T0: f64 = 1_790_825_700.0;
    fn bars(prices: &[(f64, f64)]) -> Value {
        json!(prices.iter().enumerate().map(|(i, (o, c))| [T0 + 300.0 * i as f64, *o, *c]).collect::<Vec<_>>())
    }
    fn straddle(ce: &[(f64, f64)], pe: &[(f64, f64)], settle: bool, rules: Value) -> Value {
        compute(json!({
            "cycles": [{ "id": "c1", "expiry": "2026-10-01", "entry_ts": T0 as i64, "exit_ts": T0 as i64 + 300 * 10,
                "settle": settle, "spot": 22400.0, "rates": rates(),
                "legs": [
                    { "label": "22400 CE", "option_type": "call", "strike": 22400.0, "qty": -65, "bars": bars(ce) },
                    { "label": "22400 PE", "option_type": "put", "strike": 22400.0, "qty": -65, "bars": bars(pe) }
                ] }],
            "rules": rules,
        })).unwrap()
    }

    #[test]
    fn time_exit_counts_both_sides_of_charges() {
        let flat = [(100.0, 100.0); 12];
        let r = straddle(&flat, &flat, false, json!({ "slippage_pct": 0.0 }));
        let t = &r["trades"][0];
        assert_eq!(t["exit_reason"], "time");
        assert_eq!(t["gross"], 0.0);
        // 4 orders x ₹20 brokerage, STT 0.15% on the two sells of ₹6,500 each.
        assert_eq!(t["charges"]["brokerage"], 80.0);
        assert!((t["charges"]["stt"].as_f64().unwrap() - 2.0 * 6500.0 * 0.0015).abs() < 0.01);
        assert!(t["net"].as_f64().unwrap() < -100.0, "flat market still loses the charges");
    }

    #[test]
    fn target_is_measured_after_charges() {
        // Both legs decay from 100 to 60: gross +5,200.
        let decay: Vec<(f64, f64)> = (0..12).map(|i| (100.0 - 4.0 * i as f64, 100.0 - 4.0 * (i + 1) as f64)).collect();
        let r = straddle(&decay, &decay, false, json!({ "slippage_pct": 0.0, "target": { "kind": "rupees", "value": 3000.0 } }));
        let t = &r["trades"][0];
        assert_eq!(t["exit_reason"], "target");
        assert!(t["net"].as_f64().unwrap() >= 3000.0 - 1.0);
    }

    #[test]
    fn stop_as_percent_of_premium_received() {
        let up: Vec<(f64, f64)> = (0..12).map(|i| (100.0 + 10.0 * i as f64, 100.0 + 10.0 * (i + 1) as f64)).collect();
        let flat = [(100.0, 100.0); 12];
        let r = straddle(&up, &flat, false, json!({ "slippage_pct": 0.0, "stop": { "kind": "pct", "value": 50.0 } }));
        let t = &r["trades"][0];
        assert_eq!(t["exit_reason"], "stop");
        // 50% of the ₹13,000 received.
        assert!(t["net"].as_f64().unwrap() <= -6500.0);
    }

    #[test]
    fn settles_at_expiry_without_closing_orders() {
        let ce = [(100.0, 100.0), (100.0, 90.0), (90.0, 120.0)];
        let pe = [(100.0, 100.0), (100.0, 80.0), (80.0, 0.05)];
        let r = straddle(&ce, &pe, true, json!({ "slippage_pct": 0.0 }));
        let t = &r["trades"][0];
        assert_eq!(t["exit_reason"], "expiry");
        assert_eq!(t["charges"]["brokerage"], 40.0, "only the two opening orders");
    }

    #[test]
    fn slippage_costs_money_and_missing_prices_skip_the_cycle() {
        let flat = [(100.0, 100.0); 12];
        let r = straddle(&flat, &flat, false, json!({ "slippage_pct": 1.0 }));
        assert!(r["trades"][0]["slippage"].as_f64().unwrap() > 250.0);
        let none = compute(json!({ "cycles": [{ "id": "c2", "expiry": "2026-10-01", "entry_ts": T0 as i64, "exit_ts": T0 as i64 + 600,
            "spot": 22400.0, "rates": rates(), "legs": [{ "label": "x", "option_type": "call", "strike": 1.0, "qty": 1, "bars": [] }] }],
            "rules": { "slippage_pct": 0.0 } })).unwrap();
        assert_eq!(none["trades"].as_array().unwrap().len(), 0);
        assert_eq!(none["summary"]["skipped"], 1);
    }

    #[test]
    fn summary_adds_earlier_pieces() {
        let flat = [(100.0, 100.0); 12];
        let first = straddle(&flat, &flat, false, json!({ "slippage_pct": 0.0 }));
        let prior = first["trades"].clone();
        let second = compute(json!({ "cycles": [], "rules": { "slippage_pct": 0.0 }, "prior_trades": prior, "prior_skipped": 2 })).unwrap();
        assert_eq!(second["summary"]["trades"], 1);
        assert_eq!(second["summary"]["skipped"], 2);
        assert_eq!(second["summary"]["losses"], 1);
    }
}
