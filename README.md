# Capital Guard

AI-powered multi-market paper trading platform for Indian financial markets. Practice trading across equities (NSE/BSE), commodities (MCX), currency derivatives (CDS), and F&O (NFO/BFO) using virtual capital — with AI-driven signals, autonomous bot teams, and institutional-grade analytics.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js 20+, Fastify 5, TypeScript, Prisma ORM |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS 4, Zustand |
| **Database** | PostgreSQL 16 (Supabase prod / local Docker dev) |
| **Cache/Queue** | Redis 7 (ioredis, BullMQ) |
| **Compute Engine** | Rust (backtesting, signals, Greeks, risk, Monte Carlo, portfolio optimization) |
| **Broker Bridge** | Python 3.11+ (ICICI Breeze API adapter) |
| **AI** | Google Gemini (primary), OpenAI (fallback) |
| **Broker** | ICICI Breeze API (market data, options chain) |
| **Auth** | JWT (@fastify/jwt) + bcrypt |

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16 (or Docker)
- Redis 7 (optional, for caching)
- Rust toolchain (for the compute engine)
- Python 3.11+ (for the Breeze bridge)

### Quick Start (Docker)

```bash
# Start infrastructure
docker-compose up -d postgres redis

# Backend
cd server
npm install
cp .env.example .env          # fill in your keys
npx prisma migrate deploy
npm run dev                    # http://localhost:8000

# Frontend
cd frontend
npm install
cp .env.example .env.local     # set VITE_API_BASE_URL
npm run dev                    # http://localhost:5173
```

### Full Stack (Docker Compose)

```bash
docker-compose up --build
# Frontend: http://localhost:80
# Backend:  http://localhost:8000
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite)                                     │
│  Port 5173 (dev) / 80 (prod via Nginx)                          │
│  axios → /api, WebSocket → /ws                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend API (Fastify 5, port 8000)                              │
│  150+ REST endpoints, WebSocket hub, cron orchestrator           │
│  JWT auth, rate limiting, Helmet security headers                │
└───────┬───────────────┬───────────────┬─────────────────────────┘
        │               │               │
        ▼               ▼               ▼
   PostgreSQL      Redis 7         Rust Engine
   (port 5432)     (port 6379)     (stdin/stdout JSON-RPC)
                                        │
                                   Breeze Bridge
                                   (Python, port 8001)
```

## Environment Variables

### Backend (`server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing JWTs |
| `ENCRYPTION_KEY` | Yes | AES-256 key for stored credentials |
| `REDIS_URL` | No | Redis connection (caching, queues) |
| `GEMINI_API_KEY` | No | Google Gemini API key (primary AI) |
| `OPENAI_API_KEY` | No | OpenAI API key (fallback AI) |
| `BREEZE_API_KEY` | No | ICICI Breeze API key |
| `BREEZE_SECRET_KEY` | No | ICICI Breeze secret |
| `CORS_ORIGINS` | No | Allowed origins (default: `http://localhost:5173`) |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | Backend API URL (default: `http://localhost:8000/api`) |
| `VITE_WS_URL` | WebSocket URL (auto-derived if not set) |

## Project Structure

```
├── server/                 # Node.js/Fastify backend
│   ├── src/
│   │   ├── routes/         # 16 route groups (auth, trades, ai, etc.)
│   │   ├── services/       # 33 service modules
│   │   ├── middleware/      # JWT auth middleware
│   │   └── lib/            # Redis, Prisma, WebSocket, Rust bridge
│   ├── prisma/
│   │   ├── schema.prisma   # 28 database models
│   │   └── migrations/     # SQL migration history
│   └── breeze-bridge/      # Python ICICI Breeze adapter
├── frontend/               # React 19 SPA
│   ├── src/
│   │   ├── pages/          # 18 pages (Dashboard, Terminal, AI, etc.)
│   │   ├── components/     # UI components
│   │   ├── services/       # API client, WebSocket
│   │   ├── stores/         # Zustand state stores
│   │   └── hooks/          # Custom React hooks
│   └── e2e/                # Playwright E2E tests
├── engine/                 # Rust compute engine
│   └── src/                # 16 modules (backtest, signals, greeks, etc.)
└── docker-compose.yml      # PostgreSQL + Redis + Server + Frontend
```

## Key Features

- **Multi-market paper trading** — NSE, BSE, MCX, CDS with realistic cost structures
- **AI Agent** — 9-gate scoring system (Autonomous / Signal / Advisory modes)
- **Bot Team** — 6 specialized bots (Scanner, Analyst, Executor, Risk Manager, Strategist, Monitor)
- **Rust Engine** — Backtesting, technical signals, Black-Scholes Greeks, IV surface, Monte Carlo, portfolio optimization, walk-forward validation
- **Intelligence Hub** — FII/DII flow, options flow, sector rotation, global macro, earnings calendar
- **Strategy Builder** — Multi-leg options strategies with payoff diagrams and Greeks
- **Command Center** — Natural language trading interface
- **Self-improving Learning** — Nightly strategy review with regime detection

## License

This project is private and not licensed for redistribution.
