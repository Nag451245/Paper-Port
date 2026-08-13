# Capital Guard — Maintenance Plan

**Version:** 1.0  
**Prepared:** March 2026  
**Review Cadence:** Quarterly

---

## 1. Architecture Overview

Capital Guard is a multi-service trading platform with 5 core services:

| Service | Tech | Port | Criticality |
|---------|------|------|-------------|
| Frontend (React 19 SPA) | Vite 7, Tailwind 4, Zustand | 5173/80 | High |
| Backend API (Fastify 5) | Node.js 20, TypeScript 5.9, Prisma 6 | 8000 | Critical |
| Rust Engine | Axum 0.8, Tokio, Rayon | 8400 | High |
| Breeze Bridge (Python) | http.server, breeze-connect | 8001 | Medium |
| ML Service (Python) | FastAPI, XGBoost, LightGBM | 8002 | Medium |

**Infrastructure:** PostgreSQL 16 (Supabase), Redis 7, Nginx, PM2

---

## 2. Bugs Fixed in This Review

### Critical (P0)
| ID | Description | Fix Applied |
|----|-------------|-------------|
| BUG-1 | Route ordering collision: `/consolidated/summary` shadowed by `/:portfolioId` | Moved consolidated route before parametric route |
| BUG-2 | Race condition: `handleFill` swapped `this.prisma` with tx client (not thread-safe) | Pass `db` parameter through call chain instead |
| BUG-3 | Order modify only allowed PENDING, should also allow SUBMITTED | Added SUBMITTED to modify status check |
| BUG-4 | Portfolio `set-default` not transactional — could leave no default | Wrapped in `$transaction()` |

### Security (P1)
| ID | Description | Fix Applied |
|----|-------------|-------------|
| SEC-1 | `/metrics` endpoint unauthenticated — leaked operational data | Added JWT auth guard |
| SEC-2 | JWT_SECRET min length only 1 char | Enforced 32-char minimum |
| SEC-3 | No pagination limit cap on list APIs | Capped at 200 records max |
| SEC-4 | Breeze Bridge stored creds in plaintext on disk | Flagged; recommend env-based encryption |
| SEC-5 | Breeze Bridge had no auth + wildcard CORS | Added bearer token auth + restricted CORS origin |

### Tech Upgrades
| ID | Description | Action |
|----|-------------|--------|
| TECH-1 | Python `breeze-connect` unpinned | Pinned to `>=1.0.30,<2.0.0` |
| TECH-2 | Server TypeScript outdated (5.7) | Updated to `~5.9.3` |
| TECH-3 | Server vitest outdated (2.1) | Updated to `^3.0.0` |
| TECH-4 | Dynamic import in health check added latency | Moved to top-level import |

---

## 3. Known Pre-Existing Test Failures (38/472)

These existed before this review and are non-blocking:

| Test File | Count | Root Cause | Recommended Fix |
|-----------|-------|------------|-----------------|
| `intelligence.test.ts` | 25 | Auth token not injected in test setup | Add auth header to inject calls |
| `trades.test.ts` | 2 | Tests run outside market hours | Add `skipMarketCheck: true` in test or mock calendar |
| `market-data.service.test.ts` | 2 | Search returns more results than expected | Update assertions for fuzzy search |
| `pentest.test.ts` | 1 | Rate limit threshold mismatch (5000 vs test expectation) | Align test with configured 5000/min |
| `bot-engine.test.ts` | 1 | MAX_CONCURRENT_BOTS assertion wrong | Update test assertion |
| `intelligence.service.test.ts` | 1 | Property name mismatch (`fiiBuy` vs actual key) | Update test to match service response shape |
| `auth.test.ts` | 1 | Health check returns `error` (no DB in test) | Mock DB health check |
| Others | 5 | Various assertion mismatches | Review individually |

---

## 4. Scheduled Maintenance Calendar

### Weekly (Every Monday)
- [ ] Check PM2 process status: `pm2 status`
- [ ] Review server logs for ERROR/WARN: `pm2 logs capital-guard-api --lines 500`
- [ ] Verify Breeze session auto-renewal is working
- [ ] Check Redis memory usage: `redis-cli INFO memory`
- [ ] Monitor PostgreSQL connection pool: `SELECT count(*) FROM pg_stat_activity`

### Bi-Weekly (1st and 15th)
- [ ] Run full test suite: `npm test` (server + frontend)
- [ ] Check npm audit: `npm audit` (both server and frontend)
- [ ] Review Supabase dashboard for query performance
- [ ] Check disk usage on GCP VM
- [ ] Verify SSL certificate validity (Let's Encrypt auto-renews at 30 days)

### Monthly (1st of each month)
- [ ] Dependency audit and updates:
  - `npm outdated` in server/ and frontend/
  - `pip list --outdated` in breeze-bridge/ and ml-service/
  - `cargo outdated` in engine/
- [ ] Review and rotate secrets:
  - JWT_SECRET
  - ENCRYPTION_KEY
  - Breeze API credentials (if compromised)
- [ ] Database maintenance:
  - Vacuum analyze: `VACUUM ANALYZE;`
  - Check table sizes: `SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relkind='r' ORDER BY pg_total_relation_size(oid) DESC LIMIT 20;`
  - Archive old trades/orders (>6 months)
- [ ] Review Rate Limiting thresholds
- [ ] Check Rust engine binary freshness

### Quarterly (Jan, Apr, Jul, Oct)
- [ ] Major dependency upgrades:
  - Node.js LTS version
  - React major versions
  - Fastify major versions
  - Prisma major versions
  - Rust toolchain update
- [ ] Security audit:
  - Run OWASP ZAP scan against API
  - Review CORS origins
  - Review JWT expiry policy
  - Check for leaked secrets in git history
- [ ] Performance review:
  - API response time P95/P99
  - WebSocket connection stability
  - Database query performance (slow query log)
  - Memory usage trends
- [ ] Backup verification:
  - Test database restore from Supabase backup
  - Verify engine state snapshot restore

### Annually
- [ ] Full architecture review
- [ ] Disaster recovery drill
- [ ] SSL certificate authority review
- [ ] Compliance review (trading regulations)

---

## 5. Monitoring & Alerting

### Health Checks
```
GET /health         → Server, DB, Engine status
GET /metrics        → Prometheus metrics (auth required)
GET :8001/health    → Breeze Bridge status
GET :8002/health    → ML Service status
```

### Key Metrics to Monitor
| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| API latency P95 | > 500ms | > 2000ms |
| Error rate | > 1% | > 5% |
| Memory (RSS) | > 400MB | > 512MB |
| WebSocket connections | > 100 | > 500 |
| DB connection pool | > 80% | > 95% |
| Redis memory | > 200MB | > 500MB |
| Order fill latency | > 100ms | > 500ms |
| Breeze session age | > 20h | > 23h |

### Recommended Alerting Stack
- **Prometheus + Grafana** for metrics visualization
- **PagerDuty/Opsgenie** for on-call alerts
- **Sentry** for error tracking (frontend + backend)

---

## 6. Backup & Recovery

### Database (PostgreSQL)
- **Supabase:** Automatic daily backups (7-day retention)
- **Manual:** `pg_dump` weekly to GCS bucket
- **RTO:** 15 minutes (Supabase point-in-time recovery)
- **RPO:** < 1 hour

### Application State
- **Rust Engine:** `engine_state.json` snapshot every 60s
- **Redis:** RDB snapshots every 5 minutes
- **Git:** All code in GitHub with CI/CD

### Recovery Procedure
1. Restore database from Supabase backup
2. Rebuild and deploy from latest `main` branch
3. Verify Breeze session renewal
4. Run `POST /api/portfolio/:id/reconcile` for all portfolios
5. Verify health checks pass

---

## 7. Dependency Upgrade Schedule

### Immediate (This Quarter)
| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| TypeScript (server) | ^5.7.0 | ~5.9.3 | **Done** |
| vitest (server) | ^2.1.0 | ^3.0.0 | **Done** |
| breeze-connect | unpinned | >=1.0.30,<2.0.0 | **Done** |

### Next Quarter (Q3 2026)
| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| Node.js | 20 LTS | 22 LTS | Test all services |
| @prisma/client | ^6.0.0 | ^6.x latest | Minor version update |
| React | ^19.2.0 | ^19.x latest | Minor only |
| Rust | stable | latest stable | Update Cargo.lock |

### Future (Q4 2026+)
| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| Fastify | ^5.0.0 | ^6.0.0 (when available) | Major — review breaking changes |
| Python | 3.12 | 3.13 | Test ML models compatibility |
| PostgreSQL | 16 | 17 | Test Prisma compatibility |

---

## 8. Security Hardening Roadmap

### Done
- [x] JWT secret minimum 32 characters
- [x] Prometheus metrics endpoint auth-protected
- [x] Pagination limits enforced (max 200)
- [x] Breeze Bridge auth token support
- [x] Breeze Bridge CORS restricted

### Recommended Next Steps
- [ ] Move login lockout from in-memory to Redis (survives restarts, works multi-instance)
- [ ] Add request body size limit on WebSocket messages
- [ ] Implement CSRF tokens for state-changing operations
- [ ] Add API key rotation endpoint
- [ ] Encrypt `.breeze_session.json` on disk (use `ENCRYPTION_KEY` from env)
- [ ] Add IP allowlist for Breeze Bridge (beyond localhost)
- [ ] Implement audit logging for all credential operations
- [ ] Add 2FA for Capital Guard user accounts (not just Breeze)
- [ ] Rate limit WebSocket message frequency

---

## 9. Performance Optimization Roadmap

### Quick Wins
- [ ] Add Redis caching for portfolio summary (30s TTL)
- [ ] Batch market data quotes in parallel (already done for getSummary)
- [ ] Add database connection pooling configuration tuning
- [ ] Enable Prisma query logging in development for slow query detection

### Medium-Term
- [ ] Implement server-sent events (SSE) as WebSocket fallback
- [ ] Add database read replicas for analytics queries
- [ ] Implement candle data aggregation pipeline (avoid re-fetching)
- [ ] Add materialized views for portfolio performance snapshots

### Long-Term
- [ ] Migrate heavy analytics to Rust engine
- [ ] Implement event sourcing for trade audit trail
- [ ] Add GraphQL layer for flexible frontend queries
- [ ] Consider moving to Kubernetes for auto-scaling

---

## 10. On-Call Runbook

### Server Down
1. Check PM2: `pm2 status && pm2 logs capital-guard-api --lines 100`
2. Check memory: `free -m && pm2 monit`
3. Restart: `pm2 restart capital-guard-api`
4. If OOM: increase heap `--max-old-space-size=1024`

### Database Connection Issues
1. Check Supabase status dashboard
2. Verify `DATABASE_URL` in `.env`
3. Check connection count: `SELECT count(*) FROM pg_stat_activity`
4. Restart if connection pool exhausted

### Breeze Session Expired
1. Check bridge health: `curl http://127.0.0.1:8001/health`
2. Re-init session via Settings page or API
3. Check auto-renewal logs: `pm2 logs capital-guard-api | grep "Breeze"`

### NAV Drift Detected
1. Run reconciliation: `POST /api/portfolio/:id/reconcile`
2. Compare before/after values
3. If drift > ₹100, investigate recent trades
4. Check for failed order executions in audit logs

### Kill Switch Activated
1. Check Rust engine: `curl http://127.0.0.1:8400/health`
2. Deactivate: `POST /api/risk/kill-switch/deactivate`
3. Review triggering risk event
4. Monitor for 15 minutes after deactivation

---

## 11. Contact & Escalation

| Level | Response Time | Who |
|-------|---------------|-----|
| L1 (Monitoring) | < 15 min | On-call engineer |
| L2 (Application) | < 1 hour | Development team |
| L3 (Infrastructure) | < 4 hours | DevOps/SRE |
| L4 (Security incident) | Immediate | Security lead + CTO |

---

*This document should be reviewed and updated quarterly. All team members should be familiar with the on-call runbook.*
