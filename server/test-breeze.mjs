import https from 'https';

console.log('Testing connectivity to api.icicidirect.com...');
const start = Date.now();

const req = https.request({
  hostname: 'api.icicidirect.com',
  path: '/breezeapi/api/v1/customerdetails',
  method: 'GET',
  headers: { 'Content-Type': 'application/json' },
  rejectUnauthorized: false,
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log(`Response in ${Date.now() - start}ms`);
    console.log('Status:', res.statusCode);
    console.log('Body:', d.substring(0, 500));
    process.exit(0);
  });
});

req.on('error', e => {
  console.log(`Error after ${Date.now() - start}ms:`, e.code, e.message);
  process.exit(1);
});

req.setTimeout(30000, () => {
  console.log(`Timeout after ${Date.now() - start}ms`);
  req.destroy();
  process.exit(1);
});

req.write(JSON.stringify({ SessionToken: 'test', AppKey: 'test' }));
req.end();
