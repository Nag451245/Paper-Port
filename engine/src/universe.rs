use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapCategory {
    LargeCap,
    MidCap,
    SmallCap,
}

impl CapCategory {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "large" | "largecap" | "large_cap" => Self::LargeCap,
            "mid" | "midcap" | "mid_cap" => Self::MidCap,
            _ => Self::SmallCap,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LargeCap => "LargeCap",
            Self::MidCap => "MidCap",
            Self::SmallCap => "SmallCap",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockInfo {
    pub symbol: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sector: String,
    #[serde(default)]
    pub cap: String,
    #[serde(default)]
    pub is_fno: bool,
    #[serde(default)]
    pub lot_size: Option<i64>,
}

impl StockInfo {
    pub fn cap_category(&self) -> CapCategory {
        CapCategory::from_str_loose(&self.cap)
    }
}

/// Dynamic stock universe — can be refreshed daily from the Breeze bridge.
/// Uses interior mutability (Mutex) so the universe can be updated while
/// other components hold an `Arc<Universe>` reference.
pub struct Universe {
    stocks: Mutex<Vec<StockInfo>>,
    seed_path: String,
}

impl Universe {
    pub fn load(path: &str) -> Result<Self, String> {
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read universe file {}: {}", path, e))?;
        let stocks: Vec<StockInfo> = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse universe JSON: {}", e))?;
        if stocks.is_empty() {
            return Err("Universe file is empty".into());
        }
        info!(count = stocks.len(), path = path, "Loaded stock universe from seed file");
        Ok(Self { stocks: Mutex::new(stocks), seed_path: path.to_string() })
    }

    pub fn load_or_empty(path: &str) -> Self {
        match Self::load(path) {
            Ok(u) => u,
            Err(e) => {
                warn!(error = %e, "Failed to load universe, using empty");
                Self { stocks: Mutex::new(Vec::new()), seed_path: path.to_string() }
            }
        }
    }

    fn with_stocks<F, R>(&self, f: F) -> R
    where F: FnOnce(&[StockInfo]) -> R {
        let guard = self.stocks.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard)
    }

    pub fn len(&self) -> usize {
        self.with_stocks(|s| s.len())
    }

    pub fn is_empty(&self) -> bool {
        self.with_stocks(|s| s.is_empty())
    }

    pub fn by_sector(&self, sector: &str) -> Vec<StockInfo> {
        let s = sector.to_lowercase();
        self.with_stocks(|stocks| {
            stocks.iter().filter(|st| st.sector.to_lowercase() == s).cloned().collect()
        })
    }

    pub fn by_cap(&self, cap: CapCategory) -> Vec<StockInfo> {
        self.with_stocks(|stocks| {
            stocks.iter().filter(|st| st.cap_category() == cap).cloned().collect()
        })
    }

    pub fn by_sector_and_cap(&self, sector: &str, cap: CapCategory) -> Vec<StockInfo> {
        let s = sector.to_lowercase();
        self.with_stocks(|stocks| {
            stocks.iter()
                .filter(|st| st.sector.to_lowercase() == s && st.cap_category() == cap)
                .cloned()
                .collect()
        })
    }

    pub fn fno_stocks(&self) -> Vec<StockInfo> {
        self.with_stocks(|stocks| {
            stocks.iter().filter(|st| st.is_fno).cloned().collect()
        })
    }

    pub fn sector_list(&self) -> Vec<String> {
        self.with_stocks(|stocks| {
            let mut sectors: Vec<String> = stocks.iter()
                .map(|s| s.sector.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            sectors.sort();
            sectors
        })
    }

    pub fn symbols(&self) -> Vec<String> {
        self.with_stocks(|stocks| stocks.iter().map(|s| s.symbol.clone()).collect())
    }

    pub fn get(&self, symbol: &str) -> Option<StockInfo> {
        let sym = symbol.to_uppercase();
        self.with_stocks(|stocks| stocks.iter().find(|s| s.symbol == sym).cloned())
    }

    /// Refresh the universe from the Breeze bridge `/stocks` endpoint.
    /// Merges new stocks with existing sector/cap data: bridge-provided data wins
    /// for new stocks, but existing seed data is preserved if bridge has no sector info.
    /// Persists the merged result to `data/nse_universe.json` for next startup.
    pub fn refresh_from_bridge(&self, bridge_url: &str) -> Result<usize, String> {
        let url = format!("{}/stocks", bridge_url);
        let resp = ureq::get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .map_err(|e| format!("Bridge /stocks request failed: {}", e))?;

        let data: serde_json::Value = resp.into_json()
            .map_err(|e| format!("Failed to parse /stocks response: {}", e))?;

        let bridge_stocks = data.get("stocks")
            .and_then(|v| v.as_array())
            .ok_or("No 'stocks' array in bridge response")?;

        if bridge_stocks.is_empty() {
            return Err("Bridge returned empty stock list".into());
        }

        let new_stocks: Vec<StockInfo> = bridge_stocks.iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect();

        if new_stocks.len() < 50 {
            return Err(format!("Bridge returned too few stocks ({}), keeping existing", new_stocks.len()));
        }

        // Merge: keep existing seed data for stocks that the bridge doesn't classify
        let merged = {
            let existing = self.stocks.lock().unwrap_or_else(|p| p.into_inner());
            let mut map: std::collections::HashMap<String, StockInfo> = std::collections::HashMap::new();
            for s in existing.iter() {
                map.insert(s.symbol.clone(), s.clone());
            }
            for s in new_stocks {
                let existing_entry = map.get(&s.symbol);
                let sector = if s.sector == "Other" || s.sector.is_empty() {
                    existing_entry.map(|e| e.sector.clone()).unwrap_or(s.sector)
                } else {
                    s.sector
                };
                let cap = if s.cap.is_empty() {
                    existing_entry.map(|e| e.cap.clone()).unwrap_or(s.cap)
                } else {
                    s.cap
                };
                map.insert(s.symbol.clone(), StockInfo {
                    symbol: s.symbol,
                    name: s.name,
                    sector,
                    cap,
                    is_fno: s.is_fno,
                    lot_size: s.lot_size,
                });
            }
            let mut result: Vec<StockInfo> = map.into_values().collect();
            result.sort_by(|a, b| a.symbol.cmp(&b.symbol));
            result
        };

        let count = merged.len();

        // Persist to disk for next startup
        let persist_path = if self.seed_path.is_empty() { "data/nse_universe.json" } else { &self.seed_path };
        if let Ok(json) = serde_json::to_string_pretty(&merged) {
            if let Err(e) = std::fs::write(persist_path, &json) {
                warn!(error = %e, "Failed to persist refreshed universe to disk");
            } else {
                info!(path = persist_path, count = count, "Persisted refreshed universe to disk");
            }
        }

        // Update in-memory
        let mut guard = self.stocks.lock().unwrap_or_else(|p| p.into_inner());
        *guard = merged;

        info!(count = count, "Universe refreshed from bridge");
        Ok(count)
    }

    /// Try to refresh from bridge, fall back to seed file silently.
    pub fn try_refresh(&self, bridge_url: &str) {
        match self.refresh_from_bridge(bridge_url) {
            Ok(count) => info!(count = count, "Dynamic universe refresh succeeded"),
            Err(e) => warn!(error = %e, "Dynamic universe refresh failed, using seed data"),
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_universe() -> Universe {
        Universe {
            stocks: Mutex::new(vec![
                StockInfo { symbol: "RELIANCE".into(), name: "Reliance".into(), sector: "Energy".into(), cap: "large".into(), is_fno: true, lot_size: Some(250) },
                StockInfo { symbol: "TCS".into(), name: "TCS".into(), sector: "IT".into(), cap: "large".into(), is_fno: true, lot_size: Some(175) },
                StockInfo { symbol: "HDFCBANK".into(), name: "HDFC Bank".into(), sector: "Banking".into(), cap: "large".into(), is_fno: true, lot_size: Some(550) },
                StockInfo { symbol: "PERSISTENT".into(), name: "Persistent".into(), sector: "IT".into(), cap: "mid".into(), is_fno: true, lot_size: Some(100) },
                StockInfo { symbol: "RBLBANK".into(), name: "RBL Bank".into(), sector: "Banking".into(), cap: "small".into(), is_fno: true, lot_size: Some(3200) },
                StockInfo { symbol: "CROMPTON".into(), name: "Crompton".into(), sector: "Consumer".into(), cap: "small".into(), is_fno: true, lot_size: None },
                StockInfo { symbol: "CESC".into(), name: "CESC".into(), sector: "Power".into(), cap: "small".into(), is_fno: false, lot_size: None },
            ]),
            seed_path: String::new(),
        }
    }

    #[test]
    fn test_by_sector() {
        let u = sample_universe();
        let it = u.by_sector("IT");
        assert_eq!(it.len(), 2);
        assert!(it.iter().all(|s| s.sector == "IT"));
    }

    #[test]
    fn test_by_cap() {
        let u = sample_universe();
        let large = u.by_cap(CapCategory::LargeCap);
        assert_eq!(large.len(), 3);
        let small = u.by_cap(CapCategory::SmallCap);
        assert_eq!(small.len(), 3);
    }

    #[test]
    fn test_by_sector_and_cap() {
        let u = sample_universe();
        let banking_large = u.by_sector_and_cap("Banking", CapCategory::LargeCap);
        assert_eq!(banking_large.len(), 1);
        assert_eq!(banking_large[0].symbol, "HDFCBANK");
    }

    #[test]
    fn test_fno_stocks() {
        let u = sample_universe();
        let fno = u.fno_stocks();
        assert_eq!(fno.len(), 6);
        assert!(fno.iter().all(|s| s.is_fno));
    }

    #[test]
    fn test_sector_list() {
        let u = sample_universe();
        let sectors = u.sector_list();
        assert!(sectors.contains(&"IT".to_string()));
        assert!(sectors.contains(&"Banking".to_string()));
        assert!(sectors.contains(&"Energy".to_string()));
    }

    #[test]
    fn test_get_symbol() {
        let u = sample_universe();
        assert!(u.get("reliance").is_some());
        assert!(u.get("NONEXIST").is_none());
    }

    #[test]
    fn test_cap_category_parse() {
        assert_eq!(CapCategory::from_str_loose("large"), CapCategory::LargeCap);
        assert_eq!(CapCategory::from_str_loose("MidCap"), CapCategory::MidCap);
        assert_eq!(CapCategory::from_str_loose("xyz"), CapCategory::SmallCap);
    }

    #[test]
    fn test_load_nonexistent() {
        assert!(Universe::load("/nonexistent/path.json").is_err());
    }

    #[test]
    fn test_load_or_empty_fallback() {
        let u = Universe::load_or_empty("/nonexistent/path.json");
        assert!(u.is_empty());
    }
}
