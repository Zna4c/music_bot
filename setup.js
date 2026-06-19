const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const ROOT = __dirname;

function log(msg) { process.stdout.write(msg + '\n'); }
function ok(msg)  { log('[OK] ' + msg); }
function err(msg) { log('[!!] ' + msg); }
function info(msg){ log('[..] ' + msg); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    info('Downloading: ' + path.basename(dest));
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
        }
        const total = parseInt(res.headers['content-length'] || '0');
        let got = 0;
        res.on('data', chunk => {
          got += chunk.length;
          if (total) {
            const pct = Math.round(got / total * 100);
            process.stdout.write('\r    ' + pct + '% (' + Math.round(got/1024/1024) + ' MB)   ');
          }
        });
        res.pipe(file);
        res.on('end', () => { process.stdout.write('\n'); file.close(resolve); });
      }).on('error', reject);
    };
    get(url);
  });
}

function unzipFfmpeg() {
  return new Promise((resolve, reject) => {
    info('Extracting ffmpeg.exe...');
    const ps = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      $zip = [System.IO.Compression.ZipFile]::OpenRead('${path.join(ROOT,'ffmpeg-temp.zip').replace(/\\/g,'/')}');
      $entry = $zip.Entries | Where-Object { $_.Name -eq 'ffmpeg.exe' } | Select-Object -First 1;
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${path.join(ROOT,'ffmpeg.exe').replace(/\\/g,'/')}', $true);
      $zip.Dispose();
    `;
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps.replace(/\n/g,' ') + '"', (e) => {
      if (e) reject(e); else resolve();
    });
  });
}

async function main() {
  log('');
  log('================================================');
  log('  Discord Music Bot - Setup');
  log('================================================');
  log('');

  // 1. Node check (already running)
  ok('Node.js ' + process.version);

  // 2. npm install
  log('');
  info('Installing npm packages...');
  try {
    execSync('npm install --ignore-scripts', { cwd: ROOT, stdio: 'inherit' });
    ok('npm packages installed');
  } catch(e) {
    err('npm install failed!'); process.exit(1);
  }

  // 3. yt-dlp
  log('');
  const ytdlp = path.join(ROOT, 'yt-dlp.exe');
  if (fs.existsSync(ytdlp)) {
    ok('yt-dlp.exe already exists, skipping');
  } else {
    try {
      await download(
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        ytdlp
      );
      ok('yt-dlp.exe downloaded');
    } catch(e) {
      err('Failed to download yt-dlp: ' + e.message); process.exit(1);
    }
  }

  // 4. ffmpeg
  log('');
  const ffmpeg = path.join(ROOT, 'ffmpeg.exe');
  if (fs.existsSync(ffmpeg)) {
    ok('ffmpeg.exe already exists, skipping');
  } else {
    const tmp = path.join(ROOT, 'ffmpeg-temp.zip');
    try {
      await download(
        'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
        tmp
      );
      await unzipFfmpeg();
      fs.unlinkSync(tmp);
      ok('ffmpeg.exe ready');
    } catch(e) {
      try { fs.unlinkSync(tmp); } catch {}
      err('Failed to get ffmpeg: ' + e.message); process.exit(1);
    }
  }

  // 5. .env
  log('');
  const envFile = path.join(ROOT, '.env');
  const envExample = path.join(ROOT, '.env.example');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(envExample, envFile);
    log('[!!] .env created - open it and add your DISCORD_TOKEN!');
    exec('notepad "' + envFile + '"');
  } else {
    ok('.env exists');
  }

  // 6. logs dir
  const logsDir = path.join(ROOT, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

  log('');
  log('================================================');
  log('  Setup complete! Now run start.bat');
  log('================================================');
  log('');
}

main().catch(e => { err(e.message); process.exit(1); });
