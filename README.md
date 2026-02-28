# ZeroLoss AI

AI-powered paper trading platform for the Indian stock market. Practice trading with virtual capital, get AI-driven insights from Claude, and connect to ICICI Direct via the Breeze API — all without risking real money.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Python 3.11+, FastAPI, SQLAlchemy (async), APScheduler |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **Database** | PostgreSQL (Supabase) via PgBouncer |
| **Cache** | Upstash Redis |
| **AI** | Anthropic Claude API |
| **Broker** | ICICI Breeze API (market data + paper trading) |
| **Auth** | JWT (python-jose) + bcrypt (passlib) |

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier works)
- An [Upstash](https://upstash.com) Redis instance (free tier works)

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # fill in your keys
uvicorn app.main:app --reload
```

The API will be available at `http://localhost:8000`. Interactive docs at `http://localhost:8000/docs`.

### Frontend

```bash
cd frontend
npm install

cp .env.example .env.local      # fill in your values
npm run dev
```

The dev server will start at `http://localhost:5173`.

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anonymous/public key |
| `SUPABASE_DB_URL` | PostgreSQL connection string (PgBouncer port 6543) |
| `UPSTASH_REDIS_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_TOKEN` | Upstash Redis REST token |
| `BREEZE_API_KEY` | ICICI Breeze API key |
| `BREEZE_SECRET_KEY` | ICICI Breeze secret key |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `NEWS_API_KEY` | NewsAPI.org key |
| `GNEWS_API_KEY` | GNews API key |
| `JWT_SECRET_KEY` | Secret for signing JWTs (generate with `openssl rand -hex 32`) |
| `JWT_ALGORITHM` | JWT signing algorithm (default: `HS256`) |
| `JWT_ACCESS_TOKEN_EXPIRE_MINUTES` | Token TTL in minutes (default: `1440`) |
| `CORS_ORIGINS` | Comma-separated allowed origins |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API base URL |
| `VITE_WS_URL` | WebSocket base URL |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key |

## Project Structure

```
Capital Guard/
├── backend/
│   ├── app/
│   │   ├── config.py              # Pydantic settings
│   │   ├── database.py            # Async SQLAlchemy engine
│   │   ├── main.py                # FastAPI app, lifespan, WebSocket
│   │   ├── models/                # SQLAlchemy ORM models
│   │   │   ├── user.py            # User, BreezeCredential
│   │   │   ├── portfolio.py       # Portfolio, Holding
│   │   │   ├── trade.py           # Order, Trade
│   │   │   ├── strategy.py        # AIAgentConfig
│   │   │   └── watchlist.py       # Watchlist, WatchlistItem
│   │   ├── schemas/               # Pydantic request/response schemas
│   │   ├── routers/               # FastAPI route handlers
│   │   │   ├── auth.py            # Register, login, profile, Breeze creds
│   │   │   ├── portfolio.py       # Portfolio CRUD
│   │   │   ├── trades.py          # Order placement + history
│   │   │   ├── market_data.py     # Quotes, charts, screener
│   │   │   ├── watchlist.py       # Watchlist management
│   │   │   └── ai_agent.py        # AI insights + recommendations
│   │   ├── services/              # Business logic layer
│   │   │   ├── auth_service.py    # Auth, JWT, password hashing
│   │   │   ├── breeze_client.py   # Rate-limited ICICI Breeze wrapper
│   │   │   ├── trading_engine.py  # Paper trading engine
│   │   │   ├── portfolio_service.py
│   │   │   ├── market_data_service.py
│   │   │   ├── news_service.py
│   │   │   └── ai_agent_service.py
│   │   ├── tasks/                 # APScheduler jobs
│   │   ├── utils/                 # Cache, rate limiter, timezone
│   │   └── ws/                    # WebSocket handlers
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   ├── package.json
│   └── .env.example
├── .gitignore
└── README.md
```

## Development Workflow

1. **Fork & clone** the repository.
2. Create a feature branch: `git checkout -b feat/your-feature`.
3. Copy `.env.example` files and fill in your credentials.
4. Start the backend (`uvicorn`) and frontend (`npm run dev`) in separate terminals.
5. Make changes, write tests, and ensure linting passes.
6. Open a pull request against `main`.

## License

This project is private and not licensed for redistribution.
