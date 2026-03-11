use serde::{Deserialize, Serialize};
use tracing::info;

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

pub struct Universe {
    stocks: Vec<StockInfo>,
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
        info!(count = stocks.len(), path = path, "Loaded stock universe");
        Ok(Self { stocks })
    }

    pub fn load_or_empty(path: &str) -> Self {
        match Self::load(path) {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to load universe, using empty");
                Self { stocks: Vec::new() }
            }
        }
    }

    pub fn all(&self) -> &[StockInfo] {
        &self.stocks
    }

    pub fn len(&self) -> usize {
        self.stocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.stocks.is_empty()
    }

    pub fn by_sector(&self, sector: &str) -> Vec<&StockInfo> {
        let s = sector.to_lowercase();
        self.stocks.iter().filter(|st| st.sector.to_lowercase() == s).collect()
    }

    pub fn by_cap(&self, cap: CapCategory) -> Vec<&StockInfo> {
        self.stocks.iter().filter(|st| st.cap_category() == cap).collect()
    }

    pub fn by_sector_and_cap(&self, sector: &str, cap: CapCategory) -> Vec<&StockInfo> {
        let s = sector.to_lowercase();
        self.stocks.iter()
            .filter(|st| st.sector.to_lowercase() == s && st.cap_category() == cap)
            .collect()
    }

    pub fn fno_stocks(&self) -> Vec<&StockInfo> {
        self.stocks.iter().filter(|st| st.is_fno).collect()
    }

    pub fn sector_list(&self) -> Vec<String> {
        let mut sectors: Vec<String> = self.stocks.iter()
            .map(|s| s.sector.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        sectors.sort();
        sectors
    }

    /// Returns the i-th sector name and the stocks belonging to it.
    /// Wraps around if index exceeds sector count.
    pub fn sector_slice(&self, index: usize) -> Option<(String, Vec<&StockInfo>)> {
        let sectors = self.sector_list();
        if sectors.is_empty() {
            return None;
        }
        let sector = &sectors[index % sectors.len()];
        let stocks = self.by_sector(sector);
        Some((sector.clone(), stocks))
    }

    pub fn symbols(&self) -> Vec<String> {
        self.stocks.iter().map(|s| s.symbol.clone()).collect()
    }

    pub fn get(&self, symbol: &str) -> Option<&StockInfo> {
        let sym = symbol.to_uppercase();
        self.stocks.iter().find(|s| s.symbol == sym)
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_universe() -> Universe {
        Universe {
            stocks: vec![
                StockInfo { symbol: "RELIANCE".into(), name: "Reliance".into(), sector: "Energy".into(), cap: "large".into(), is_fno: true, lot_size: Some(250) },
                StockInfo { symbol: "TCS".into(), name: "TCS".into(), sector: "IT".into(), cap: "large".into(), is_fno: true, lot_size: Some(175) },
                StockInfo { symbol: "HDFCBANK".into(), name: "HDFC Bank".into(), sector: "Banking".into(), cap: "large".into(), is_fno: true, lot_size: Some(550) },
                StockInfo { symbol: "PERSISTENT".into(), name: "Persistent".into(), sector: "IT".into(), cap: "mid".into(), is_fno: true, lot_size: Some(100) },
                StockInfo { symbol: "RBLBANK".into(), name: "RBL Bank".into(), sector: "Banking".into(), cap: "small".into(), is_fno: true, lot_size: Some(3200) },
                StockInfo { symbol: "CROMPTON".into(), name: "Crompton".into(), sector: "Consumer".into(), cap: "small".into(), is_fno: true, lot_size: None },
                StockInfo { symbol: "CESC".into(), name: "CESC".into(), sector: "Power".into(), cap: "small".into(), is_fno: false, lot_size: None },
            ],
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
    fn test_sector_slice_wraps() {
        let u = sample_universe();
        let count = u.sector_list().len();
        let (s1, _) = u.sector_slice(0).unwrap();
        let (s2, _) = u.sector_slice(count).unwrap();
        assert_eq!(s1, s2);
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
