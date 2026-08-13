# Capital Apex — AI-Powered Multi-Market Trading Platform

### Professional Technical Documentation

**Version:** 2.0  
**Date:** February 26, 2026  
**Platform Type:** Paper Trading & Market Intelligence  
**Markets Supported:** NSE, BSE, MCX (Commodities), CDS (Forex), NFO/BFO (Derivatives)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Market Coverage](#4-market-coverage)
5. [Core Modules & Features](#5-core-modules--features)
6. [API Reference](#6-api-reference)
7. [Database Schema](#7-database-schema)
8. [Security Architecture](#8-security-architecture)
9. [Deployment & Infrastructure](#9-deployment--infrastructure)
10. [User Interface Overview](#10-user-interface-overview)

---

## 1. Executive Summary

**Capital Apex** is a comprehensive, AI-powered multi-market paper trading platform designed for Indian financial markets. It enables traders — from beginners to professionals — to practice trading across **equities (NSE/BSE)**, **commodities (MCX)**, and **currency derivatives (CDS/Forex)** using virtual capital in a zero-risk environment.

The platform combines real-time market data, intelligent AI-driven trade signals, autonomous bot teams, advanced risk management, and deep market intelligence to create an institutional-grade learning and simulation environment.

### Key Highlights

| Capability | Description |
|---|---|
| **Multi-Market Trading** | NSE, BSE, MCX, CDS — equities, commodities, and forex in one platform |
| **AI Agent** | 9-gate scoring system with autonomous, signal, and advisory modes |
| **Bot Team** | 6 specialized bots (Scanner, Analyst, Executor, Risk Manager, Strategist, Monitor) |
| **Intelligence Hub** | Options flow, FII/DII tracking, sector rotation, global indices, smart money |
| **Risk Engine** | Capital preservation rules, stop-loss enforcement, exposure limits |
| **Backtesting** | Strategy backtesting with comprehensive performance metrics |
| **Real-Time Data** | Live quotes, WebSocket streaming, 10-second refresh cycles |
| **Trade Journal** | AI-powered post-trade analysis and improvement suggestions |

---

## 2. System Architecture

### Architecture Diagram

![Capital Apex Architecture](./assets/capital-apex-architecture.png)

### Architecture Layers

The platform follows a **layered architecture** with clear separation of concerns:

#### Layer 1 — Client Layer (Frontend)
- **React 19** single-page application with TypeScript
- **Zustand** for global state management, **React Query** for server-state caching
- **WebSocket client** for real-time market data streaming
- **Lightweight Charts** (TradingView) for candlestick charts, **Recharts** for analytics
- Fully responsive UI with **Tailwind CSS** and dark/light mode support
- Internationalization via **i18next** (English + Hindi)

#### Layer 2 — API Gateway Layer (Backend)
- **Fastify v5** REST API with 12 route groups and 100+ endpoints
- JWT-based authentication with token refresh
- Request validation via **Zod** schemas
- Rate limiting (per-user and per-IP)
- Security headers via **Helmet**
- WebSocket hub for real-time broadcast

#### Layer 3 — Business Logic (Service Layer)
- **Market Data Service** — Fetches live quotes from NSE India API, generates simulated MCX/CDS data for paper trading
- **Trade Engine** — Order execution, cost calculation (STT/CTT/GST/SEBI charges), position management
- **AI Agent Service** — 9-gate signal scoring, pre-market briefings, strategy recommendations
- **Bot Engine** — Multi-bot orchestration with inter-bot communication via OpenAI/Claude
- **Intelligence Service** — Options chain analysis, FII/DII flow, sector rotation, global macro
- **Risk Service** — Capital preservation rules, margin monitoring, exposure limits

#### Layer 4 — Data & Infrastructure
- **PostgreSQL 16** — Primary database for users, trades, portfolios, bots, signals
- **Redis 7** — Caching, job queues (BullMQ), rate limiting, session storage
- **External APIs** — NSE India, ICICI Breeze API, OpenAI/Claude for AI features

---

## 3. Technology Stack

### Backend

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | 20+ |
| Language | TypeScript | 5.7 |
| Framework | Fastify | 5.0 |
| ORM | Prisma | 6.0 |
| Database | PostgreSQL (prod) / SQLite (dev) | 16 |
| Cache | Redis (ioredis) | 7 / 5.4 |
| Queue | BullMQ | 5.70 |
| Auth | @fastify/jwt + bcryptjs | 9.0 |
| Validation | Zod | 3.24 |
| WebSocket | @fastify/websocket | 11.0 |
| Scheduling | node-cron | 3.0 |
| 2FA | otpauth | 9.5 |
| Logging | Pino | 10.3 |
| Testing | Vitest | 2.1 |

### Frontend

| Component | Technology | Version |
|---|---|---|
| Framework | React | 19.2 |
| Language | TypeScript | 5.9 |
| Build Tool | Vite | 7.3 |
| Styling | Tailwind CSS | 4.2 |
| State | Zustand | 5.0 |
| Server State | @tanstack/react-query | 5.90 |
| Routing | react-router-dom | 7.13 |
| HTTP Client | Axios | 1.13 |
| Charts | lightweight-charts + recharts | 5.1 / 3.7 |
| Icons | Lucide React | 0.575 |
| i18n | i18next + react-i18next | 25.8 / 16.5 |
| Effects | canvas-confetti | 1.9 |
| Testing | Vitest + @testing-library/react | 4.0 / 16.3 |

### Infrastructure

| Component | Technology |
|---|---|
| Containerization | Docker + Docker Compose |
| Deployment | Render.com |
| Database | PostgreSQL 16 Alpine |
| Cache/Queue | Redis 7 Alpine |
| CI/CD | Render auto-deploy |

---

## 4. Market Coverage

Capital Apex supports trading across **four major Indian market segments**:

### NSE / BSE — Equities

| Attribute | Detail |
|---|---|
| Exchange | National Stock Exchange / Bombay Stock Exchange |
| Instruments | Stocks, ETFs, Indices |
| Market Hours | 9:15 AM – 3:30 PM IST (Mon–Fri) |
| Data Source | NSE India API (live), ICICI Breeze API (historical) |
| Sample Symbols | RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, SBIN, ITC |
| Cost Structure | Brokerage (0.03%, max Rs.20), STT (0.1% sell), Exchange charges, GST, SEBI, Stamp duty |

### MCX — Commodities

| Attribute | Detail |
|---|---|
| Exchange | Multi Commodity Exchange |
| Instruments | Precious metals, base metals, energy, agricultural |
| Market Hours | 9:00 AM – 11:30 PM IST (Mon–Sat) |
| Data Source | Simulated quotes for paper trading (based on real price ranges) |
| Sample Symbols | GOLD, SILVER, CRUDEOIL, NATURALGAS, COPPER, ZINC, NICKEL, COTTON |
| Cost Structure | Brokerage (0.03%, max Rs.20), CTT (0.01% sell), Exchange charges, GST, SEBI, Stamp duty |

### CDS — Currency Derivatives (Forex)

| Attribute | Detail |
|---|---|
| Exchange | Currency Derivatives Segment (NSE) |
| Instruments | Currency pairs against INR |
| Market Hours | 9:00 AM – 5:00 PM IST (Mon–Fri) |
| Data Source | Simulated quotes for paper trading (based on real FX rates) |
| Sample Symbols | USDINR, EURINR, GBPINR, JPYINR, AUDINR, CADINR, CHFINR |
| Cost Structure | Brokerage (0.03%, max Rs.20), No STT, Exchange charges, GST, SEBI, Stamp duty |

### NFO / BFO — Derivatives

| Attribute | Detail |
|---|---|
| Exchange | NSE Futures & Options / BSE Futures & Options |
| Instruments | Index options, stock futures, currency options |
| Data Source | NSE India API (options chain) |
| Features | Options chain, OI heatmap, Max Pain, IV percentile, Greeks |

---

## 5. Core Modules & Features

### 5.1 Dashboard

The main dashboard provides a bird's-eye view of the entire trading operation:

- **Portfolio Summary Card** — Total NAV, day P&L, total P&L, invested value, available margin
- **AI Agent Status Card** — Current mode, running status, today's signals and trades
- **Pre-Market Briefing Card** — AI-generated daily market outlook with stance, key points, support/resistance
- **Today's Trades Feed** — Live feed of executed trades with P&L
- **Watchlist Widget** — Quick-view watchlist with live prices
- **VIX Widget** — India VIX indicator with volatility assessment
- **Global Indices Strip** — S&P 500, Dow Jones, NASDAQ, FTSE, Nikkei, SGX Nifty

### 5.2 Trading Terminal

The core trading interface with multi-market support:

- **Exchange Filter Tabs** — Switch between All Markets, NSE, BSE, MCX (Commodities), CDS (Forex)
- **Symbol Search** — Debounced autocomplete search across all exchanges with exchange badges
- **Candlestick Chart** — Interactive TradingView-style chart with 90-day historical data
- **Live Price Display** — Real-time LTP with change, change%, bid/ask, timestamp (10s refresh)
- **Order Entry Panel** — BUY/SELL toggle, Market/Limit order type, quantity, price input
- **Positions Tab** — Open positions with live P&L, exchange badge, avg price, LTP
- **Orders Tab** — Order history with status badges, cancel functionality
- **Trades Tab** — Completed trades with entry/exit prices, net P&L, hold duration
- **Portfolio Selector** — Switch between multiple portfolios
- **Estimated Value** — Real-time cost estimation before order placement
- **Cost Structure** — Market-specific fee calculation (equity vs commodity vs currency)

### 5.3 AI Agent Panel

Intelligent trading assistant with three operational modes:

**Modes:**
- **AUTONOMOUS** — AI generates and auto-executes trades within risk limits
- **SIGNAL** — AI generates signals for manual review and execution
- **ADVISORY** — AI provides analysis and recommendations only

**9-Gate Scoring System:**

| Gate | Name | Weight | Description |
|---|---|---|---|
| G1 | Trend | 15% | Multi-timeframe trend analysis |
| G2 | Momentum | 12% | RSI, MACD, Stochastic indicators |
| G3 | Volatility | 10% | VIX, ATR, Bollinger Band analysis |
| G4 | Volume | 12% | Volume confirmation and anomalies |
| G5 | Options Flow | 13% | PCR, OI, max pain analysis |
| G6 | Global Macro | 10% | US markets, Asian cues, commodities |
| G7 | FII/DII | 10% | Institutional flow analysis |
| G8 | Sentiment | 8% | News sentiment, social signals |
| G9 | Risk | 10% | Portfolio risk assessment |

**Features:**
- Pre-market briefings (daily market outlook)
- Post-trade briefings (daily performance review)
- Market Scanner — Scans NSE, MCX & CDS markets every 5 minutes
- Signal execution/rejection workflow with rationale
- Capital preservation rules (max daily loss, position limits)
- Strategy management (enable/disable strategies)

### 5.4 Bot Team Management

Multi-agent bot system with 6 specialized roles:

| Role | Emoji | Purpose |
|---|---|---|
| SCANNER | 🔍 | Identifies trading opportunities across markets |
| ANALYST | 📊 | Deep technical and fundamental analysis |
| EXECUTOR | ⚡ | Order placement and execution management |
| RISK_MANAGER | 🛡️ | Portfolio risk monitoring and alerts |
| STRATEGIST | 🧠 | Strategy formulation and backtesting |
| MONITOR | 👁️ | Position and market condition monitoring |

**Features:**
- Bot creation with custom names, roles, and emoji avatars
- Symbol assignment (across NSE, MCX, CDS)
- Strategy assignment
- Capital allocation per bot
- Bot-to-bot communication feed
- Task assignment and tracking
- Performance tracking (total trades, P&L, win rate)
- Start/stop controls (max 3 concurrent bots)

### 5.5 Intelligence Dashboard

Comprehensive market intelligence with 5 sections:

**FII/DII Flow:**
- Daily buy/sell/net values for Foreign & Domestic Institutional Investors
- Trend analysis with historical data
- Visual bar charts

**Options Intelligence:**
- Put-Call Ratio (PCR) — Sentiment indicator
- Max Pain — Option seller's equilibrium strike
- OI Heatmap — Open interest distribution across strikes
- IV Percentile — Implied volatility ranking
- Options Greeks — Delta, Gamma, Theta, Vega
- Multi-symbol support (NIFTY, BANKNIFTY, CRUDE OIL, GOLD, USDINR)

**Sector Analysis:**
- Sector performance heatmap
- Relative Rotation Graph (RRG)
- Sector rotation alerts
- Performance comparison charts

**Events Calendar:**
- Earnings calendar
- RBI MPC meeting dates
- Macro economic events
- Blackout period alerts
- Event impact analysis

**Global Markets:**
- Global indices (S&P 500, Dow, NASDAQ, FTSE, Nikkei)
- FX rates
- Commodity prices
- US market summary
- SGX Nifty tracking

### 5.6 Portfolio Management

- **Multiple Portfolios** — Create and manage multiple virtual portfolios
- **Portfolio Summary** — NAV, P&L, margins, invested value
- **Equity Curve** — Historical NAV visualization
- **Daily P&L Chart** — Bar chart of daily profit/loss
- **Risk Metrics:**
  - Sharpe Ratio
  - Sortino Ratio
  - Calmar Ratio
  - Maximum Drawdown
  - Win Rate
  - Profit Factor
  - Alpha & Beta
  - Average Win/Loss
- **Capital Management** — Adjust virtual capital
- **Position Tracking** — Live positions with real-time P&L across all exchanges

### 5.7 Strategy Backtesting

- **Strategy Selection** — Choose from available strategies
- **Symbol Input** — Test on any symbol (equities, commodities, forex)
- **Date Range** — Custom backtesting period
- **Initial Capital** — Configurable starting capital
- **Results Dashboard:**
  - CAGR, Sharpe Ratio, Sortino Ratio
  - Max Drawdown, Win Rate, Profit Factor
  - Total Trades, Average Win/Loss
  - Equity Curve Chart
  - Trade Log
  - Monthly Returns Breakdown
- **Compare** — Side-by-side comparison of multiple backtest results

### 5.8 Trade Journal

AI-enhanced trade journaling:

- **Trade History** — Filterable list of all completed trades
- **Filters** — By symbol, strategy, date range, profit/loss
- **Per-Trade Details:**
  - Entry/exit prices and timestamps
  - P&L with cost breakdown
  - Hold duration
  - Strategy tag
  - AI Briefing — AI-generated analysis of the trade
  - Signal Quality Review
  - Market Context
  - Exit Analysis
  - Improvement Suggestions
- **Export** — CSV export of trade data

### 5.9 Settings & Configuration

- **Broker Integration:**
  - ICICI Breeze API credentials (encrypted storage)
  - API Key, Secret Key, TOTP Secret
  - Session token management (auto-generate, popup, manual)
  - Connection status indicator
- **Virtual Capital** — Configure starting capital
- **Profile Management** — Name, email, risk appetite
- **Risk Settings** — Conservative, Moderate, Aggressive profiles

### 5.10 Watchlist Management

- **Multiple Watchlists** — Create and organize watchlists
- **Multi-Exchange Support** — Add symbols from NSE, BSE, MCX, CDS
- **Live Prices** — Real-time LTP, change, volume for all items
- **Quick Actions** — Add to watchlist from trading terminal

### 5.11 Alerts & Notifications

- **Price Alerts** — Set price targets with conditions (above/below)
- **In-App Notifications** — Real-time notification feed
- **Alert Types** — Price alerts, risk events, bot updates, trade confirmations
- **Read/Unread Management** — Mark individual or all as read

### 5.12 Analytics Dashboard

- **Trade Statistics** — Win rate, profit factor, average P&L
- **Symbol Breakdown** — Performance by symbol
- **Strategy Breakdown** — Performance by strategy
- **Equity Curve** — Portfolio growth over time
- **CSV Export** — Download complete trade data

---

## 6. API Reference

The backend exposes **100+ REST API endpoints** organized into 12 route groups:

### Route Groups Summary

| Route Group | Base Path | Endpoints | Auth Required |
|---|---|---|---|
| Authentication | `/api/auth` | 11 | Partial |
| Portfolio | `/api/portfolio` | 8 | Yes |
| Trading | `/api/trades` | 10 | Yes |
| Market Data | `/api/market` | 8 | Partial |
| Watchlist | `/api/watchlist` | 6 | Yes |
| AI Agent | `/api/ai` | 15 | Yes |
| Intelligence | `/api/intelligence` | 22 | Yes |
| Bots | `/api/bots` | 12 | Yes |
| Backtest | `/api/backtest` | 4 | Yes |
| Notifications | `/api/notifications` | 4 | Yes |
| Alerts | `/api/alerts` | 4 | Yes |
| Analytics | `/api/analytics` | 5 | Yes |
| Health | `/health` | 1 | No |

### Key Endpoints

**Trading:**
```
POST   /api/trades/orders              — Place order (NSE/BSE/MCX/CDS)
GET    /api/trades/positions            — List open positions
POST   /api/trades/positions/:id/close  — Close position
GET    /api/trades/trades               — List completed trades
```

**Market Data:**
```
GET    /api/market/quote/:symbol?exchange=MCX   — Get live quote
GET    /api/market/history/:symbol?exchange=CDS  — Historical OHLCV
GET    /api/market/search?q=GOLD&exchange=MCX    — Search symbols
GET    /api/market/indices?exchange=MCX           — Market indices
```

**AI Agent:**
```
POST   /api/ai/start                    — Start AI agent
GET    /api/ai/signals                  — Get trade signals
POST   /api/ai/market-scan/start        — Start multi-market scanner
GET    /api/ai/briefing/pre-market      — Get pre-market briefing
```

---

## 7. Database Schema

The application uses **16 core models** organized across 4 categories:

### Core Trading Models

```
User ──┬── Portfolio ──┬── Position ──── Order
       │               │                  │
       │               └── Trade ─────────┘
       │
       ├── Watchlist ──── WatchlistItem
       └── BreezeCredential
```

### AI & Automation Models

```
User ──┬── AIAgentConfig
       ├── AITradeSignal
       ├── TradingBot ──┬── BotMessage
       │                └── BotTask
       └── TradeJournal ──── Trade
```

### Monitoring Models

```
User ──┬── PriceAlert
       ├── Notification
       ├── RiskEvent
       └── PerformanceSnapshot
```

### System Models

```
AuditLog
BacktestResult
```

### Key Fields — Exchange Support

All trading models include an `exchange` field supporting:
- `NSE` — National Stock Exchange (default)
- `BSE` — Bombay Stock Exchange
- `MCX` — Multi Commodity Exchange
- `CDS` — Currency Derivatives Segment

---

## 8. Security Architecture

### Authentication & Authorization

| Feature | Implementation |
|---|---|
| Authentication | JWT tokens with @fastify/jwt |
| Password Storage | bcrypt hashing (10 rounds) |
| Token Refresh | Automatic session management |
| Route Protection | Pre-handler authentication hooks |

### Data Security

| Feature | Implementation |
|---|---|
| API Credentials | AES-256-CBC encryption for Breeze API keys |
| CORS | Configurable allowed origins |
| Headers | Helmet security headers |
| Input Validation | Zod schema validation on all endpoints |
| Rate Limiting | Per-user and per-IP rate limiting |

### Infrastructure Security

| Feature | Implementation |
|---|---|
| Database | Parameterized queries via Prisma ORM |
| Secrets | Environment variable-based configuration |
| Audit Trail | AuditLog model for all critical actions |
| Session Management | Encrypted session tokens with expiry |

---

## 9. Deployment & Infrastructure

### Local Development

```bash
# Start infrastructure
docker-compose up -d postgres redis

# Backend
cd server
npm install
npx prisma migrate deploy
npm run dev          # http://localhost:8000

# Frontend
cd frontend
npm install
npm run dev          # http://localhost:5173
```

### Docker Compose (Full Stack)

```yaml
Services:
  - PostgreSQL 16 Alpine (port 5432)
  - Redis 7 Alpine (port 6379)
  - Backend Node.js (port 8000)
  - Frontend Nginx (port 80)
```

### Production (Render.com)

```yaml
Services:
  - Backend: Node.js web service
    Build: npm install && npx prisma generate && npm run build
    Start: npx prisma migrate deploy && npm start
    
  - Frontend: Static site
    Build: npm install && npm run build
    Publish: frontend/dist
```

### Health Check

```
GET /health
```

Returns system status including:
- Database connectivity
- Redis connectivity
- Rust engine status
- Active WebSocket connections
- Uptime and version

---

## 10. User Interface Overview

### Page Map

| Page | Route | Description |
|---|---|---|
| Login | `/login` | User authentication |
| Register | `/register` | New account creation |
| Onboarding | `/onboarding` | First-time setup wizard |
| Dashboard | `/dashboard` | Main overview with widgets |
| Trading Terminal | `/terminal` | Chart, order entry, positions |
| AI Agent | `/ai-agent` | AI configuration and signals |
| Bot Team | `/bots` | Bot management and communication |
| Intelligence | `/intelligence` | Market intelligence hub |
| Portfolio | `/portfolio` | Portfolio analytics and risk |
| Backtest | `/backtest` | Strategy backtesting |
| Trade Journal | `/journal` | Trade history and AI analysis |
| Settings | `/settings` | Profile and broker configuration |

### UI Components

| Category | Components |
|---|---|
| Layout | AppShell, Sidebar (collapsible), TopBar (with live indices) |
| Dashboard | PortfolioSummaryCard, AIAgentStatusCard, PreMarketBriefingCard, TodaysTradesFeed, WatchlistWidget, VIXWidget, GlobalIndicesStrip |
| Trading | OrderEntryPanel, PositionsTable, OrdersTable, MarketDepthTable |
| Portfolio | EquityCurveChart, DailyPnLChart, RiskMetricsCards |
| AI Agent | SignalCard, SignalScoreGauges, CapitalPreservationStatus |

### Design System

- **Colors:** Gradient branding (Amber → Teal → Red), Indigo accents
- **Typography:** System fonts with monospace for financial data
- **Icons:** Lucide React icon library
- **Effects:** Confetti animation on profitable trade closure
- **Responsive:** Mobile-first design with breakpoints
- **Accessibility:** Semantic HTML, keyboard navigation, ARIA labels
- **i18n:** English and Hindi language support

---

## Appendix A — Cost Structure by Market

### NSE/BSE Equity

| Charge | Rate |
|---|---|
| Brokerage | 0.03% or Rs.20 (whichever is lower) |
| STT | 0.1% on sell side |
| Exchange Charges | 0.00345% |
| GST | 18% on (brokerage + exchange) |
| SEBI Charges | 0.0001% |
| Stamp Duty | 0.015% on buy side |

### MCX Commodity

| Charge | Rate |
|---|---|
| Brokerage | 0.03% or Rs.20 (whichever is lower) |
| CTT | 0.01% on sell side |
| Exchange Charges | 0.0026% |
| GST | 18% on (brokerage + exchange) |
| SEBI Charges | 0.0001% |
| Stamp Duty | 0.002% on buy side |

### CDS Currency (Forex)

| Charge | Rate |
|---|---|
| Brokerage | 0.03% or Rs.20 (whichever is lower) |
| STT | Nil |
| Exchange Charges | 0.0035% |
| GST | 18% on (brokerage + exchange) |
| SEBI Charges | 0.0001% |
| Stamp Duty | 0.001% on buy side |

---

## Appendix B — Supported Instruments

### MCX Commodities

| Symbol | Name | Lot Size |
|---|---|---|
| GOLD | Gold | 1 kg |
| GOLDM | Gold Mini | 100 gm |
| GOLDPETAL | Gold Petal | 1 gm |
| SILVER | Silver | 30 kg |
| SILVERM | Silver Mini | 5 kg |
| CRUDEOIL | Crude Oil | 100 barrels |
| NATURALGAS | Natural Gas | 1250 MMBtu |
| COPPER | Copper | 2500 kg |
| ZINC | Zinc | 5000 kg |
| LEAD | Lead | 5000 kg |
| ALUMINIUM | Aluminium | 5000 kg |
| NICKEL | Nickel | 1500 kg |
| COTTON | Cotton | 25 bales |
| MENTHAOIL | Mentha Oil | 360 kg |
| CASTORSEED | Castor Seed | 10 MT |

### CDS Currency Pairs

| Symbol | Name |
|---|---|
| USDINR | US Dollar / Indian Rupee |
| EURINR | Euro / Indian Rupee |
| GBPINR | British Pound / Indian Rupee |
| JPYINR | Japanese Yen / Indian Rupee |
| AUDINR | Australian Dollar / Indian Rupee |
| CADINR | Canadian Dollar / Indian Rupee |
| CHFINR | Swiss Franc / Indian Rupee |
| SGDINR | Singapore Dollar / Indian Rupee |
| HKDINR | Hong Kong Dollar / Indian Rupee |
| CNHINR | Chinese Yuan / Indian Rupee |

---

*Capital Apex — Where Intelligence Meets Markets*
