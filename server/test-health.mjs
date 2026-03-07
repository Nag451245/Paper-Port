import http from 'http';
const req = http.get('http://127.0.0.1:8000/health', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log(d.substring(0, 1000));
    process.exit(0);
  });
});
req.on('error', e => { console.log('Error:', e.message); process.exit(1); });
req.setTimeout(120000, () => { console.log('Timed out after 120s'); req.destroy(); process.exit(1); });
