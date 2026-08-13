/**
 * Capital Guard — k6 Performance Test Suite
 *
 * Run: k6 run server/tests/performance/load-test.js
 *
 * Prerequisites:
 *   - Server running on http://localhost:8000
 *   - At least one user registered (or use the signup flow)
 *   - npm install -g k6  (or download from https://k6.io)
 *
 * Environment variables:
 *   - BASE_URL: Server URL (default: http://localhost:8000)
 *   - AUTH_TOKEN: Pre-generated JWT token for authenticated requests
 *   - PORTFOLIO_ID: UUID of the test portfolio
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ═══════════════════════════════════════════════════════════════════════
// Custom Metrics
// ═══════════════════════════════════════════════════════════════════════

const orderPlacementTime = new Trend('order_placement_time', true);
const summaryFetchTime = new Trend('summary_fetch_time', true);
const orderErrorRate = new Rate('order_error_rate');
const wsMessageRate = new Counter('ws_messages_received');
const slaViolations = new Counter('sla_violations');

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const PORTFOLIO_ID = __ENV.PORTFOLIO_ID || '00000000-0000-0000-0000-000000000001';

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${AUTH_TOKEN}`,
};

// ═══════════════════════════════════════════════════════════════════════
// Scenarios
// ═══════════════════════════════════════════════════════════════════════

export const options = {
  scenarios: {
    // Scenario 1: Normal Trading (steady state)
    normal_trading: {
      executor: 'constant-vus',
      vus: 5,
      duration: '10m',
      exec: 'normalTradingFlow',
      tags: { scenario: 'normal' },
    },

    // Scenario 2: Market Open Burst (spike at open)
    market_open_burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },   // Ramp to 50 users in 30s (market open rush)
        { duration: '5m', target: 50 },    // Sustain 50 users for 5 min
        { duration: '30s', target: 0 },    // Ramp down
      ],
      exec: 'marketOpenBurst',
      startTime: '11m',
      tags: { scenario: 'burst' },
    },

    // Scenario 3: Stress Test (10x normal)
    stress_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },    // Ramp to 10x
        { duration: '3m', target: 50 },    // Hold at 10x
        { duration: '1m', target: 0 },     // Ramp down
      ],
      exec: 'stressTest',
      startTime: '18m',
      tags: { scenario: 'stress' },
    },

    // Scenario 4: Portfolio Summary Under Load
    portfolio_load: {
      executor: 'constant-vus',
      vus: 20,
      duration: '5m',
      exec: 'portfolioSummaryLoad',
      startTime: '23m',
      tags: { scenario: 'portfolio' },
    },
  },

  thresholds: {
    // SLA Thresholds — auto-fail conditions
    'order_placement_time': [
      'p(95)<500',    // P95 order placement < 500ms
      'p(99)<2000',   // P99 < 2s
      'max<10000',    // No single order > 10s
    ],
    'summary_fetch_time': [
      'p(95)<1000',   // P95 getSummary < 1s
      'p(99)<2000',   // P99 < 2s
    ],
    'order_error_rate': [
      'rate<0.05',    // < 5% error rate
    ],
    'http_req_duration': [
      'p(95)<1000',   // Overall P95 < 1s
    ],
    'http_req_failed': [
      'rate<0.01',    // < 1% HTTP failures
    ],
    'sla_violations': [
      'count<10',     // Max 10 SLA violations before test fails
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════

const SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'WIPRO', 'ITC', 'LT', 'TATAMOTORS',
  'SUNPHARMA', 'MARUTI', 'KOTAKBANK', 'AXISBANK', 'HINDUNILVR',
];

function randomSymbol() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
}

function randomQty() {
  return Math.floor(Math.random() * 10) + 1; // 1-10
}

function randomPrice() {
  return Math.floor(Math.random() * 3000) + 500; // 500-3500
}

function login() {
  if (AUTH_TOKEN) return AUTH_TOKEN;

  const loginRes = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
    email: 'trader@test.com',
    password: 'TestPass123!',
  }), { headers: { 'Content-Type': 'application/json' } });

  if (loginRes.status === 200) {
    const body = JSON.parse(loginRes.body);
    return body.access_token;
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario 1: Normal Trading Flow
// ═══════════════════════════════════════════════════════════════════════

export function normalTradingFlow() {
  const token = AUTH_TOKEN || login();
  const headers = { ...HEADERS, 'Authorization': `Bearer ${token}` };

  group('Normal Trading', () => {

    // Step 1: Fetch portfolio summary
    group('Fetch Summary', () => {
      const summaryStart = Date.now();
      const res = http.get(`${BASE_URL}/api/portfolio`, { headers });

      const elapsed = Date.now() - summaryStart;
      summaryFetchTime.add(elapsed);

      check(res, {
        'summary returns 200': (r) => r.status === 200,
        'summary < 1s': (r) => r.timings.duration < 1000,
      });

      if (elapsed > 1000) slaViolations.add(1);
    });

    sleep(1);

    // Step 2: Place a market order
    group('Place Order', () => {
      const orderStart = Date.now();
      const orderPayload = JSON.stringify({
        portfolio_id: PORTFOLIO_ID,
        symbol: randomSymbol(),
        side: Math.random() > 0.5 ? 'BUY' : 'SELL',
        order_type: 'MARKET',
        qty: randomQty(),
        price: randomPrice(),
        exchange: 'NSE',
      });

      const res = http.post(`${BASE_URL}/api/trades/orders`, orderPayload, { headers });

      const elapsed = Date.now() - orderStart;
      orderPlacementTime.add(elapsed);

      const success = check(res, {
        'order accepted (not 400)': (r) => r.status !== 400,
        'order not server error': (r) => r.status < 500,
        'order < 500ms': (r) => r.timings.duration < 500,
      });

      orderErrorRate.add(!success);
      if (elapsed > 500) slaViolations.add(1);
    });

    sleep(2);

    // Step 3: Check orders list
    group('List Orders', () => {
      const res = http.get(`${BASE_URL}/api/trades/orders`, { headers });
      check(res, {
        'orders list returns 200': (r) => r.status === 200,
      });
    });

    sleep(1);

    // Step 4: Check positions
    group('List Positions', () => {
      const res = http.get(`${BASE_URL}/api/trades/positions`, { headers });
      check(res, {
        'positions returns 200': (r) => r.status === 200,
      });
    });

    sleep(3);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario 2: Market Open Burst
// ═══════════════════════════════════════════════════════════════════════

export function marketOpenBurst() {
  const token = AUTH_TOKEN || login();
  const headers = { ...HEADERS, 'Authorization': `Bearer ${token}` };

  group('Market Open Burst', () => {
    // Rapid-fire orders simulating market open
    for (let i = 0; i < 3; i++) {
      const orderStart = Date.now();
      const res = http.post(`${BASE_URL}/api/trades/orders`, JSON.stringify({
        portfolio_id: PORTFOLIO_ID,
        symbol: randomSymbol(),
        side: 'BUY',
        order_type: 'MARKET',
        qty: randomQty(),
        price: randomPrice(),
        exchange: 'NSE',
      }), { headers });

      const elapsed = Date.now() - orderStart;
      orderPlacementTime.add(elapsed);

      check(res, {
        'burst order not 500': (r) => r.status < 500,
        'burst order < 2s': (r) => r.timings.duration < 2000,
      });

      if (res.status === 429) {
        sleep(5); // Back off on rate limit
      } else {
        sleep(0.5);
      }
    }

    // Simultaneous summary + orders (contention test)
    const responses = http.batch([
      ['GET', `${BASE_URL}/api/portfolio`, null, { headers }],
      ['GET', `${BASE_URL}/api/trades/orders`, null, { headers }],
      ['GET', `${BASE_URL}/api/trades/positions`, null, { headers }],
    ]);

    for (const res of responses) {
      check(res, {
        'batch request succeeds': (r) => r.status < 500,
      });
    }

    sleep(2);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario 3: Stress Test (10x Normal)
// ═══════════════════════════════════════════════════════════════════════

export function stressTest() {
  const token = AUTH_TOKEN || login();
  const headers = { ...HEADERS, 'Authorization': `Bearer ${token}` };

  group('Stress Test', () => {
    // Heavy order load
    const res = http.post(`${BASE_URL}/api/trades/orders`, JSON.stringify({
      portfolio_id: PORTFOLIO_ID,
      symbol: randomSymbol(),
      side: Math.random() > 0.5 ? 'BUY' : 'SELL',
      order_type: 'MARKET',
      qty: randomQty(),
      price: randomPrice(),
      exchange: 'NSE',
    }), { headers });

    check(res, {
      'stress: no crash': (r) => r.status < 500,
      'stress: responds in time': (r) => r.timings.duration < 5000,
    });

    if (res.status >= 500) slaViolations.add(1);

    // Hammer portfolio summary
    const summaryRes = http.get(`${BASE_URL}/api/portfolio`, { headers });
    check(summaryRes, {
      'stress summary: no crash': (r) => r.status < 500,
    });

    sleep(0.5);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario 4: Portfolio Summary Under Load
// ═══════════════════════════════════════════════════════════════════════

export function portfolioSummaryLoad() {
  const token = AUTH_TOKEN || login();
  const headers = { ...HEADERS, 'Authorization': `Bearer ${token}` };

  group('Portfolio Summary Load', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/portfolio`, { headers });
    const elapsed = Date.now() - start;

    summaryFetchTime.add(elapsed);

    check(res, {
      'summary returns 200': (r) => r.status === 200,
      'summary has valid data': (r) => {
        if (r.status !== 200) return false;
        try {
          const body = JSON.parse(r.body);
          return body !== null;
        } catch {
          return false;
        }
      },
    });

    if (elapsed > 2000) slaViolations.add(1);

    // Also test risk endpoint under load
    const riskRes = http.get(`${BASE_URL}/api/risk/daily-summary`, { headers });
    check(riskRes, {
      'risk summary: no crash': (r) => r.status < 500,
    });

    sleep(1);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// WebSocket Test (run separately: k6 run --env SCENARIO=ws load-test.js)
// ═══════════════════════════════════════════════════════════════════════

export function websocketTest() {
  const token = AUTH_TOKEN || login();
  const wsUrl = BASE_URL.replace('http', 'ws') + `/ws?token=${token}`;

  const res = ws.connect(wsUrl, {}, function (socket) {
    socket.on('open', () => {
      // Subscribe to symbols
      socket.send(JSON.stringify({
        type: 'subscribe',
        symbols: SYMBOLS.slice(0, 10),
      }));
    });

    socket.on('message', (msg) => {
      wsMessageRate.add(1);
      try {
        const data = JSON.parse(msg);
        check(data, {
          'ws message has type': (d) => d.type !== undefined,
          'ws price is positive': (d) => !d.ltp || d.ltp > 0,
        });
      } catch {
        // Non-JSON message
      }
    });

    socket.on('error', (e) => {
      slaViolations.add(1);
    });

    // Keep connection alive for 60 seconds
    socket.setTimeout(() => {
      socket.close();
    }, 60000);
  });

  check(res, {
    'ws connected': (r) => r && r.status === 101,
  });
}
