use std::sync::Mutex;
use std::time::Instant;
use dashmap::DashMap;
use serde::Serialize;
use tracing::{info, warn};

use crate::rate_limiter::RateLimiter;
use crate::universe::Universe;

// ─── Sentiment Keywords ──────────────────────────────────────────────

const POSITIVE_WORDS: &[&str] = &[
    "rally", "surge", "profit", "upgrade", "bullish", "breakout", "gain",
    "growth", "outperform", "beat", "strong", "record", "high", "positive",
    "boost", "recover", "buy", "overweight", "target raised", "expansion",
    "dividend", "bonus", "merger", "acquisition", "approval", "patent",
    "order win", "results beat", "outlook positive",
];

const NEGATIVE_WORDS: &[&str] = &[
    "crash", "plunge", "loss", "downgrade", "bearish", "breakdown", "fall",
    "decline", "underperform", "miss", "weak", "low", "negative", "drag",
    "sell-off", "selloff", "sell", "underweight", "target cut", "contraction",
    "default", "fraud", "sebi action", "ban", "penalty", "shutdown",
    "results miss", "outlook negative", "red flag",
];

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
        for item in &all_items {
            for sym in &item.symbols_mentioned {
                let mut entry = self.symbol_sentiment.entry(sym.clone()).or_insert(0.0);
                *entry += item.sentiment;
            }
        }

        // Normalize: clamp to [-1.0, 1.0]
        for mut entry in self.symbol_sentiment.iter_mut() {
            *entry = entry.clamp(-1.0, 1.0);
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
    symbols.iter()
        .filter(|sym| {
            let s = sym.to_uppercase();
            if s.len() < 3 { return false; }
            upper.contains(&format!(" {} ", s))
                || upper.starts_with(&format!("{} ", s))
                || upper.ends_with(&format!(" {}", s))
                || upper.contains(&format!("{}:", s))
                || upper.contains(&format!("{},", s))
                || upper == s
        })
        .cloned()
        .collect()
}

// ─── Sentiment Scoring ───────────────────────────────────────────────

fn compute_sentiment(text: &str) -> f64 {
    let lower = text.to_lowercase();
    let mut score = 0.0_f64;

    for word in POSITIVE_WORDS {
        if lower.contains(word) {
            score += 0.2;
        }
    }
    for word in NEGATIVE_WORDS {
        if lower.contains(word) {
            score -= 0.2;
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
