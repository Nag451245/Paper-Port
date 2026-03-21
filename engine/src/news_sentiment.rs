use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use dashmap::DashMap;
use serde::Serialize;
use tracing::{info, warn};

use crate::rate_limiter::RateLimiter;
use crate::universe::Universe;

// ─── Sentiment Keywords (word, weight) ───────────────────────────────

const POSITIVE_KEYWORDS: &[(&str, f64)] = &[
    ("rally", 0.2), ("surge", 0.2), ("profit", 0.2), ("bullish", 0.2),
    ("breakout", 0.2), ("gain", 0.2), ("growth", 0.2), ("outperform", 0.2),
    ("beat", 0.2), ("strong", 0.2), ("record", 0.2), ("high", 0.2),
    ("positive", 0.2), ("boost", 0.2), ("recover", 0.2), ("buy", 0.2),
    ("overweight", 0.2), ("target raised", 0.2), ("expansion", 0.2),
    ("dividend", 0.2), ("bonus", 0.2), ("merger", 0.2), ("acquisition", 0.2),
    ("approval", 0.2), ("patent", 0.2), ("order win", 0.2),
    ("results beat", 0.2), ("outlook positive", 0.2),
    // Stronger-weight keywords
    ("upgrade", 0.4), ("re-rating", 0.4), ("target upgraded", 0.4),
    ("strong buy", 0.4), ("blockbuster", 0.4),
];

const NEGATIVE_KEYWORDS: &[(&str, f64)] = &[
    ("crash", 0.2), ("plunge", 0.2), ("loss", 0.2), ("bearish", 0.2),
    ("breakdown", 0.2), ("fall", 0.2), ("decline", 0.2), ("underperform", 0.2),
    ("miss", 0.2), ("weak", 0.2), ("low", 0.2), ("negative", 0.2),
    ("drag", 0.2), ("sell-off", 0.2), ("selloff", 0.2), ("sell", 0.2),
    ("underweight", 0.2), ("target cut", 0.2), ("contraction", 0.2),
    ("default", 0.2), ("fraud", 0.2), ("sebi action", 0.2), ("ban", 0.2),
    ("penalty", 0.2), ("shutdown", 0.2), ("results miss", 0.2),
    ("outlook negative", 0.2), ("red flag", 0.2),
    // Stronger-weight keywords
    ("downgrade", 0.4), ("target downgraded", 0.4),
    ("strong sell", 0.4), ("scam", 0.4), ("bankruptcy", 0.4),
];

// ─── Symbol-to-Company-Name Mapping (top 50 NSE) ────────────────────

fn build_symbol_company_map() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("RELIANCE", "Reliance Industries");
    m.insert("TCS", "Tata Consultancy");
    m.insert("INFY", "Infosys");
    m.insert("HDFCBANK", "HDFC Bank");
    m.insert("ICICIBANK", "ICICI Bank");
    m.insert("HINDUNILVR", "Hindustan Unilever");
    m.insert("SBIN", "State Bank of India");
    m.insert("BHARTIARTL", "Bharti Airtel");
    m.insert("ITC", "ITC Limited");
    m.insert("KOTAKBANK", "Kotak Mahindra Bank");
    m.insert("LT", "Larsen & Toubro");
    m.insert("HCLTECH", "HCL Technologies");
    m.insert("AXISBANK", "Axis Bank");
    m.insert("ASIANPAINT", "Asian Paints");
    m.insert("MARUTI", "Maruti Suzuki");
    m.insert("SUNPHARMA", "Sun Pharma");
    m.insert("TITAN", "Titan Company");
    m.insert("BAJFINANCE", "Bajaj Finance");
    m.insert("BAJFINSV", "Bajaj Finserv");
    m.insert("WIPRO", "Wipro");
    m.insert("ULTRACEMCO", "UltraTech Cement");
    m.insert("ONGC", "Oil and Natural Gas");
    m.insert("NTPC", "NTPC Limited");
    m.insert("POWERGRID", "Power Grid");
    m.insert("M&M", "Mahindra & Mahindra");
    m.insert("TATAMOTORS", "Tata Motors");
    m.insert("TATASTEEL", "Tata Steel");
    m.insert("JSWSTEEL", "JSW Steel");
    m.insert("ADANIENT", "Adani Enterprises");
    m.insert("ADANIPORTS", "Adani Ports");
    m.insert("TECHM", "Tech Mahindra");
    m.insert("INDUSINDBK", "IndusInd Bank");
    m.insert("DRREDDY", "Dr Reddys");
    m.insert("CIPLA", "Cipla");
    m.insert("DIVISLAB", "Divis Laboratories");
    m.insert("NESTLEIND", "Nestle India");
    m.insert("BRITANNIA", "Britannia Industries");
    m.insert("GRASIM", "Grasim Industries");
    m.insert("HEROMOTOCO", "Hero MotoCorp");
    m.insert("EICHERMOT", "Eicher Motors");
    m.insert("BAJAJ-AUTO", "Bajaj Auto");
    m.insert("COALINDIA", "Coal India");
    m.insert("BPCL", "Bharat Petroleum");
    m.insert("HDFCLIFE", "HDFC Life");
    m.insert("SBILIFE", "SBI Life Insurance");
    m.insert("APOLLOHOSP", "Apollo Hospitals");
    m.insert("TATACONSUM", "Tata Consumer");
    m.insert("HINDALCO", "Hindalco Industries");
    m.insert("UPL", "UPL Limited");
    m.insert("VEDL", "Vedanta");
    m
}

// ─── Data Structures ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct NewsItem {
    pub title: String,
    pub source: String,
    pub published: String,
    pub symbols_mentioned: Vec<String>,
    pub sentiment: f64,
}

/// Thread-safe news sentiment store with caching.
pub struct NewsSentimentStore {
    items: Mutex<Vec<NewsItem>>,
    symbol_sentiment: DashMap<String, f64>,
    last_fetch: Mutex<Instant>,
    cache_ttl_secs: u64,
}

impl NewsSentimentStore {
    pub fn new(cache_ttl_secs: u64) -> Self {
        Self {
            items: Mutex::new(Vec::new()),
            symbol_sentiment: DashMap::new(),
            last_fetch: Mutex::new(Instant::now() - std::time::Duration::from_secs(cache_ttl_secs + 1)),
            cache_ttl_secs,
        }
    }

    /// Fetch RSS feeds and update sentiment. Rate-limited.
    pub fn fetch_and_update(&self, limiter: &RateLimiter, universe: &Universe) {
        {
            let last = self.last_fetch.lock().unwrap_or_else(|p| p.into_inner());
            if last.elapsed().as_secs() < self.cache_ttl_secs {
                return;
            }
        }

        let feeds = vec![
            ("MoneyControl", "https://www.moneycontrol.com/rss/latestnews.xml"),
            ("EconomicTimes", "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"),
            ("LiveMint", "https://www.livemint.com/rss/markets"),
        ];

        let mut all_items: Vec<NewsItem> = Vec::new();
        let symbols: Vec<String> = universe.symbols();

        for (source, url) in &feeds {
            limiter.acquire();
            match fetch_rss(url) {
                Ok(raw_items) => {
                    for (title, published) in raw_items {
                        let mentioned = match_symbols(&title, &symbols);
                        let sentiment = compute_sentiment(&title);
                        all_items.push(NewsItem {
                            title,
                            source: source.to_string(),
                            published,
                            symbols_mentioned: mentioned,
                            sentiment,
                        });
                    }
                    info!(source = source, "Fetched news RSS feed");
                }
                Err(e) => {
                    warn!(source = source, error = %e, "Failed to fetch RSS feed");
                }
            }
        }

        self.symbol_sentiment.clear();
        let mut article_counts: HashMap<String, usize> = HashMap::new();
        for item in &all_items {
            for sym in &item.symbols_mentioned {
                let mut entry = self.symbol_sentiment.entry(sym.clone()).or_insert(0.0);
                *entry += item.sentiment;
                *article_counts.entry(sym.clone()).or_insert(0) += 1;
            }
        }

        // Normalize by sqrt(article count) to dampen noise from high-volume coverage
        for mut entry in self.symbol_sentiment.iter_mut() {
            let count = article_counts.get(entry.key()).copied().unwrap_or(1).max(1);
            *entry = (*entry / (count as f64).sqrt()).clamp(-1.0, 1.0);
        }

        if let Ok(mut items) = self.items.lock() {
            *items = all_items;
        }
        if let Ok(mut last) = self.last_fetch.lock() {
            *last = Instant::now();
        }
    }

    pub fn get_sentiment(&self, symbol: &str) -> f64 {
        self.symbol_sentiment.get(symbol).map(|v| *v).unwrap_or(0.0)
    }

    pub fn get_sector_sentiment(&self, sector: &str, universe: &Universe) -> f64 {
        let stocks = universe.by_sector(sector);
        if stocks.is_empty() {
            return 0.0;
        }
        let total: f64 = stocks.iter()
            .map(|s| self.get_sentiment(&s.symbol))
            .sum();
        (total / stocks.len() as f64).clamp(-1.0, 1.0)
    }

    pub fn recent_items(&self, limit: usize) -> Vec<NewsItem> {
        self.items.lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn item_count(&self) -> usize {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

// ─── RSS Parsing ─────────────────────────────────────────────────────

/// Minimal RSS XML parser — extracts <item><title> and <pubDate> elements.
fn fetch_rss(url: &str) -> Result<Vec<(String, String)>, String> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("RSS fetch failed: {}", e))?;

    let body = resp.into_string()
        .map_err(|e| format!("RSS body read failed: {}", e))?;

    Ok(parse_rss_items(&body))
}

fn parse_rss_items(xml: &str) -> Vec<(String, String)> {
    let mut items = Vec::new();
    let mut pos = 0;

    while let Some(item_start) = xml[pos..].find("<item>").or_else(|| xml[pos..].find("<item ")) {
        let abs_start = pos + item_start;
        let item_end = match xml[abs_start..].find("</item>") {
            Some(e) => abs_start + e + 7,
            None => break,
        };
        let item_block = &xml[abs_start..item_end];

        let title = extract_tag(item_block, "title").unwrap_or_default();
        let pub_date = extract_tag(item_block, "pubDate").unwrap_or_default();

        if !title.is_empty() {
            items.push((title, pub_date));
        }
        pos = item_end;
    }
    items
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let open_cdata = format!("<{}>", tag);
    let close = format!("</{}>", tag);

    let start = xml.find(&open).or_else(|| xml.find(&open_cdata))?;
    let content_start = start + xml[start..].find('>')? + 1;
    let end = xml[content_start..].find(&close)?;
    let content = &xml[content_start..content_start + end];

    // Strip CDATA wrappers
    let cleaned = content
        .trim()
        .trim_start_matches("<![CDATA[")
        .trim_end_matches("]]>")
        .trim();

    Some(html_decode(cleaned))
}

fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

// ─── Symbol Matching ─────────────────────────────────────────────────

fn match_symbols(headline: &str, symbols: &[String]) -> Vec<String> {
    let upper = headline.to_uppercase();
    let lower = headline.to_lowercase();
    let company_map = build_symbol_company_map();

    symbols.iter()
        .filter(|sym| {
            let s = sym.to_uppercase();
            if s.len() < 3 { return false; }
            let ticker_match = upper.contains(&format!(" {} ", s))
                || upper.starts_with(&format!("{} ", s))
                || upper.ends_with(&format!(" {}", s))
                || upper.contains(&format!("{}:", s))
                || upper.contains(&format!("{},", s))
                || upper == s;
            if ticker_match { return true; }
            if let Some(company_name) = company_map.get(sym.as_str()) {
                lower.contains(&company_name.to_lowercase())
            } else {
                false
            }
        })
        .cloned()
        .collect()
}

// ─── Sentiment Scoring ───────────────────────────────────────────────

fn compute_sentiment(text: &str) -> f64 {
    let lower = text.to_lowercase();
    let mut score = 0.0_f64;

    for &(word, weight) in POSITIVE_KEYWORDS {
        if lower.contains(word) {
            score += weight;
        }
    }
    for &(word, weight) in NEGATIVE_KEYWORDS {
        if lower.contains(word) {
            score -= weight;
        }
    }

    score.clamp(-1.0, 1.0)
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sentiment_positive() {
        let score = compute_sentiment("Reliance stock surges to record high on strong profit growth");
        assert!(score > 0.0, "Expected positive sentiment, got {}", score);
    }

    #[test]
    fn test_sentiment_negative() {
        let score = compute_sentiment("Market crash as SEBI penalty causes massive sell-off and losses");
        assert!(score < 0.0, "Expected negative sentiment, got {}", score);
    }

    #[test]
    fn test_sentiment_neutral() {
        let score = compute_sentiment("Budget session starts today in parliament");
        assert_eq!(score, 0.0);
    }

    #[test]
    fn test_match_symbols() {
        let symbols = vec!["RELIANCE".into(), "TCS".into(), "IT".into()];
        let matches = match_symbols("RELIANCE shares surge 5% as TCS results beat estimates", &symbols);
        assert!(matches.contains(&"RELIANCE".to_string()));
        assert!(matches.contains(&"TCS".to_string()));
        assert!(!matches.contains(&"IT".to_string())); // "IT" is too short (< 3 chars check)
    }

    #[test]
    fn test_parse_rss() {
        let xml = r#"
        <rss><channel>
            <item><title>Test headline one</title><pubDate>Mon, 01 Jan 2024</pubDate></item>
            <item><title><![CDATA[Test headline two]]></title><pubDate>Tue, 02 Jan 2024</pubDate></item>
        </channel></rss>
        "#;
        let items = parse_rss_items(xml);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, "Test headline one");
        assert_eq!(items[1].0, "Test headline two");
    }

    #[test]
    fn test_store_get_sentiment_default() {
        let store = NewsSentimentStore::new(900);
        assert_eq!(store.get_sentiment("RELIANCE"), 0.0);
    }

    #[test]
    fn test_html_decode() {
        assert_eq!(html_decode("A &amp; B"), "A & B");
        assert_eq!(html_decode("&lt;div&gt;"), "<div>");
    }
}
