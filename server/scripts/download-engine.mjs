import https from 'https';
import fs from 'fs';
import path from 'path';

const RELEASE_URL = 'https://github.com/Nag451245/Paper-Port/releases/download/engine-latest/capital-guard-engine';
const OUT_PATH = path.resolve('bin', 'capital-guard-engine');

function download(url, redirectCount = 0) {
  if (redirectCount > 5) {
    console.error('Too many redirects');
    process.exit(1);
  }

  https.get(url, { headers: { 'User-Agent': 'CapitalGuard/1.0' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      console.log(`Redirect ${res.statusCode} -> ${res.headers.location.substring(0, 80)}...`);
      download(res.headers.location, redirectCount + 1);
      return;
    }

    if (res.statusCode !== 200) {
      console.error(`Download failed: HTTP ${res.statusCode}`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const file = fs.createWriteStream(OUT_PATH);
    res.pipe(file);

    file.on('finish', () => {
      file.close();
      fs.chmodSync(OUT_PATH, 0o755);
      const size = fs.statSync(OUT_PATH).size;
      console.log(`Rust engine downloaded: ${size} bytes -> ${OUT_PATH}`);
      if (size < 10000) {
        console.error('Binary too small, likely an error page. Removing.');
        fs.unlinkSync(OUT_PATH);
        process.exit(1);
      }
    });
  }).on('error', (err) => {
    console.error('Download error:', err.message);
    process.exit(1);
  });
}

console.log(`Downloading Rust engine from: ${RELEASE_URL}`);
download(RELEASE_URL);
