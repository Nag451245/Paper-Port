import http from 'http';

// First need to get a valid JWT token by logging in
// Let's try the auto-session endpoint directly

const loginBody = JSON.stringify({ email: 'test@test.com', password: 'test' });

// We need an auth token first. Let's check if we can get the breeze diag without auth.
const req = http.request({
  hostname: '127.0.0.1',
  port: 8000,
  path: '/api/market/breeze-diag',
  method: 'GET',
  headers: { 'Content-Type': 'application/json' },
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(d);
      console.log(JSON.stringify(j, null, 2).substring(0, 2000));
    } catch {
      console.log(d.substring(0, 2000));
    }
    process.exit(0);
  });
});
req.on('error', e => { console.log('Error:', e.message); process.exit(1); });
req.setTimeout(120000, () => { console.log('Timeout'); req.destroy(); process.exit(1); });
req.end();
