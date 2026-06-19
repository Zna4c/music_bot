const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function findFFmpeg() {
  const candidates = [
    path.join(process.cwd(), 'ffmpeg.exe'),
    path.join(process.cwd(), 'ffmpeg'),
    path.join(__dirname, '..', '..', 'ffmpeg.exe'),
    path.join(__dirname, '..', '..', 'ffmpeg'),
  ];
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); } catch {}
  for (const c of candidates) {
    if (fs.existsSync(c)) { console.log('✅ FFmpeg:', c); return c; }
  }
  console.log('⚠️ ffmpeg не знайдено локально, спробуємо системний');
  return 'ffmpeg';
}

function findYtDlp() {
  const candidates = [
    path.join(process.cwd(), 'yt-dlp.exe'),
    path.join(process.cwd(), 'yt-dlp'),
    path.join(__dirname, '..', '..', 'yt-dlp.exe'),
    path.join(__dirname, '..', '..', 'yt-dlp'),
  ];
  try {
    const YTDlpWrap = require('yt-dlp-wrap').default;
    const w = new YTDlpWrap();
    if (w.binaryPath && fs.existsSync(w.binaryPath)) candidates.unshift(w.binaryPath);
  } catch {}
  // Шукаємо в системному PATH (Linux/Railway)
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    const w = execSync(cmd, { encoding: 'utf8' }).trim().split(require('os').EOL)[0];
    if (w && fs.existsSync(w)) { console.log('✅ yt-dlp (system):', w); return w; }
  } catch {}
  for (const c of candidates) {
    if (fs.existsSync(c)) { console.log('✅ yt-dlp:', c); return c; }
  }
  throw new Error('yt-dlp не знайдено! На Railway він встановлюється автоматично через nixpacks.toml');
}

const FFMPEG = findFFmpeg();
const YTDLP  = findYtDlp();

class MusicQueue {
  constructor(guildId) {
    this.guildId       = guildId;
    this.tracks        = [];
    this.currentIndex  = 0;
    this.loop          = 'none';
    this.volume        = 0.5;
    this.connection    = null;
    this.player        = null;
    this.textChannel   = null;
    this.voiceChannel  = null;
    this.currentTrack  = null;
    this.isPlaying     = false;
    this.autoplay      = false;
    this.autoplayAnchor = null;
    this.manualSeek    = false;
    this.ytProc        = null;
    this.ffProc        = null;
    this.currentTime   = 0;
    this.positionTimer = null;
    this.seekOffset    = 0;
    this.commandLock   = false; // захист від одночасних команд
    this.audioUrlCache = new Map();
    this.isStarting    = false; // 🔒 захист від паралельного запуску
    this.playId        = 0;     // 🔒 унікальний ID кожного відтворення
  }
}

class MusicManager {
  constructor(client) {
    this.client     = client;
    this.queues     = new Map();
    this.webEmitter = null;
  }

  getQueue(guildId) {
    if (!this.queues.has(guildId)) this.queues.set(guildId, new MusicQueue(guildId));
    return this.queues.get(guildId);
  }

  // ── Пошук ─────────────────────────────────────────────────────────────────
  async searchTrack(query, returnFirst = false) {
    try {
      const isUrl      = query.startsWith('http://') || query.startsWith('https://');
      const isPlaylist = isUrl && query.includes('list=') && !query.includes('watch?v=');

      if (isPlaylist) {
        const info = await this.ytdlpJSON(['--flat-playlist','--no-warnings','--no-progress', query]);
        return (info.entries || []).slice(0, 50).map(e => this.entryToTrack(e));
      }

      if (isUrl) {
        const info = await this.ytdlpJSON(['--no-warnings','--no-progress','--no-playlist', query]);
        return [this.infoToTrack(info, query)];
      }

      // Шукаємо більше щоб після фільтрації залишилось достатньо
      const count = returnFirst ? 3 : 10;
      const info  = await this.ytdlpJSON([
        '--flat-playlist','--no-warnings','--no-progress',
        `ytsearch${count}:${query}`,
      ]);

      // FIX: фільтруємо канали і плейлисти — тільки відео
      const entries = (info.entries || []).filter(e => {
        const id  = e.id || '';
        const url = e.url || '';
        if (id.startsWith('@') || id.startsWith('UC') || id.startsWith('PL')) return false;
        if (url.includes('/channel/') || url.includes('/@') || url.includes('/c/')) return false;
        if (url.includes('/playlist')) return false;
        return true;
      }).slice(0, returnFirst ? 1 : 5);

      // FIX: якщо duration = 0 — отримуємо повну інфо для треку
      const tracks = [];
      for (const e of entries) {
        if (!e.duration && e.id) {
          try {
            const videoUrl = `https://www.youtube.com/watch?v=${e.id}`;
            const full = await this.ytdlpJSON(['--no-warnings','--no-progress','--no-playlist', videoUrl]);
            tracks.push(this.infoToTrack(full, videoUrl));
          } catch {
            tracks.push(this.entryToTrack(e));
          }
        } else {
          tracks.push(this.entryToTrack(e));
        }
        if (returnFirst && tracks.length >= 1) break;
      }
      return tracks;
    } catch (err) {
      console.error('searchTrack error:', err.message);
      return [];
    }
  }

  entryToTrack(e) {
    const id  = e.id || '';
    const url = e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${id}`;
    return {
      title:             e.title || 'Невідомо',
      url,
      duration:          e.duration || 0,
      thumbnail:         e.thumbnail || e.thumbnails?.[0]?.url || '',
      author:            e.uploader || e.channel || '—',
      durationFormatted: this.formatDuration(e.duration || 0),
    };
  }

  infoToTrack(info, url) {
    return {
      title:             info.title || 'Невідомо',
      url,
      duration:          info.duration || 0,
      thumbnail:         info.thumbnail || '',
      author:            info.uploader || info.channel || '—',
      durationFormatted: this.formatDuration(info.duration || 0),
    };
  }

  ytdlpJSON(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(YTDLP, ['-J', ...args], { stdio: ['ignore','pipe','pipe'] });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        try { resolve(JSON.parse(out)); }
        catch { reject(new Error(err.slice(0,300) || `yt-dlp exit ${code}`)); }
      });
      proc.on('error', reject);
      setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('yt-dlp timeout')); }, 30000);
    });
  }

  // FIX: кеш прямих URL для швидкої перемотки
  async getAudioUrl(track, queue) {
    if (queue.audioUrlCache.has(track.url)) return queue.audioUrlCache.get(track.url);
    const info    = await this.ytdlpJSON(['--no-warnings','--no-progress','--no-playlist', '-f', 'bestaudio/best', track.url]);
    const formats = info.formats || [];
    const audioFmts = formats.filter(f => f.acodec !== 'none' && (f.vcodec === 'none' || !f.vcodec));
    audioFmts.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const directUrl = audioFmts[0]?.url || info.url;
    if (directUrl) {
      queue.audioUrlCache.set(track.url, directUrl);
      setTimeout(() => queue.audioUrlCache.delete(track.url), 4 * 60 * 60 * 1000);
    }
    return directUrl;
  }

  async addTrack(guildId, query, requestedBy) {
    const queue = this.getQueue(guildId);
    if (queue.tracks.length >= 100) throw new Error('Черга переповнена!');

    // ── Локальний файл ────────────────────────────────────────────────────────
    const isLocalFile = !query.startsWith('http') && fs.existsSync(query);
    if (isLocalFile) {
      const fname = path.basename(query);
      const now   = new Date();
      const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      const track = {
        title:             fname.replace(/\.[^.]+$/, ''),
        url:               query,
        duration:          0,
        thumbnail:         '',
        author:            'Локальний файл',
        durationFormatted: '—',
        isLocal:           true,
        requestedBy,
        requestedAt:       timeStr,
      };
      queue.tracks.push(track);
      this.emitUpdate(guildId);
      return [track];
    }
    // ─────────────────────────────────────────────────────────────────────────

    const isUrl      = query.startsWith('http://') || query.startsWith('https://');
    const isPlaylist = isUrl && query.includes('list=') && !query.includes('watch?v=');
    const tracks = await this.searchTrack(query, !isUrl && !isPlaylist);
    if (!tracks.length) throw new Error('Нічого не знайдено!');
    const now = new Date(); const timeStr = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0"); const withMeta = tracks.map(t => ({ ...t, requestedBy, requestedAt: timeStr }));
    queue.tracks.push(...withMeta);
    this.emitUpdate(guildId);
    return withMeta;
  }

  async play(guildId, voiceChannel, textChannel) {
    const queue = this.getQueue(guildId);
    if (!queue.tracks.length) return;

    // 🔒 Якщо вже запускається — ігноруємо дублікат виклику
    if (queue.isStarting) {
      console.warn(`⚠️ [play] Вже запускається для ${guildId}, ігноруємо дублікат`);
      return;
    }
    queue.isStarting = true;

    if (voiceChannel) queue.voiceChannel = voiceChannel;
    if (textChannel)  queue.textChannel  = textChannel;

    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
      queue.connection = joinVoiceChannel({
        channelId: queue.voiceChannel.id,
        guildId,
        adapterCreator: queue.voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch { this.stop(guildId); }
      });
    }

    // Retry-логіка: до 3 спроб підключення по 20 секунд кожна
    let connected = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔌 [Voice] Спроба підключення ${attempt}/3 до "${queue.voiceChannel?.name}"...`);
        await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
        connected = true;
        console.log(`✅ [Voice] Підключено до "${queue.voiceChannel?.name}" (спроба ${attempt})`);
        break;
      } catch (e) {
        console.warn(`⚠️ [Voice] Спроба ${attempt}/3 невдала: ${e.message}`);
        if (attempt < 3) {
          try { queue.connection.destroy(); } catch {}
          await new Promise(r => setTimeout(r, 1000));
          queue.connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId,
            adapterCreator: queue.voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: true,
          });
          queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
              await Promise.race([
                entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
              ]);
            } catch { this.stop(guildId); }
          });
        }
      }
    }

    if (!connected) {
      console.error(`❌ [Voice] Всі 3 спроби невдалі | канал: ${queue.voiceChannel?.name}`);
      queue.textChannel?.send('❌ Не вдалося підключитись після 3 спроб. Спробуй пізніше або перевір налаштування голосового каналу.').catch(() => {});
      try { queue.connection.destroy(); } catch {}
      queue.connection = null;
      queue.isStarting = false;
      return;
    }

    await this.playCurrentTrack(guildId);
    queue.isStarting = false;
  }

  async moveToChannel(guildId, voiceChannel) {
    const queue = this.getQueue(guildId);
    queue.voiceChannel = voiceChannel;
    if (queue.connection) { queue.connection.destroy(); queue.connection = null; queue.player = null; }
    queue.connection = joinVoiceChannel({
      channelId: voiceChannel.id, guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: true,
    });
    try { await entersState(queue.connection, VoiceConnectionStatus.Ready, 15_000); }
    catch { throw new Error('Не вдалося підключитись'); }
    if (queue.currentTrack) await this.playCurrentTrack(guildId);
  }

  async playCurrentTrack(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue.tracks.length || queue.currentIndex >= queue.tracks.length) return;

    const track = queue.tracks[queue.currentIndex];
    queue.currentTrack = track;
    queue.isPlaying    = true;
    queue.currentTime  = 0;
    queue.seekOffset   = 0;
    this.killProcesses(queue);
    this.stopPositionTimer(guildId);

    // Кешуємо URL наступного треку завчасно
    const nextTrack = queue.tracks[queue.currentIndex + 1];
    if (nextTrack) this.getAudioUrl(nextTrack, queue).catch(() => {});

    try {
      let audioSource;

      if (track.isLocal) {
        // ── Локальний файл ────────────────────────────────────────────────────
        console.log(`🎵 [local] Відтворюю локальний файл: ${track.url}`);
        const ffProc = spawn(FFMPEG, [
          '-i', track.url,
          '-f', 's16le', '-ar', '48000', '-ac', '2',
          '-af', 'aresample=async=1',
          '-loglevel', 'warning',
          'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        queue.ffProc = ffProc;
        ffProc.on('error', e => console.error('ffmpeg local:', e.message));
        ffProc.stderr.on('data', d => console.error('[ffmpeg local stderr]', d.toString().trim()));
        audioSource = ffProc.stdout;
      } else {
        // ── YouTube через yt-dlp ──────────────────────────────────────────────
        const ytProc = spawn(YTDLP, [
          '-f', 'bestaudio/best',
          '--no-playlist', '--no-warnings', '--no-progress',
          '--buffer-size', '16K',
          '-o', '-', track.url,
        ], { stdio: ['ignore','pipe','pipe'] });
        queue.ytProc = ytProc;

        // FIX: aresample усуває мікро-переривання
        const ffProc = spawn(FFMPEG, [
          '-re',
          '-i', 'pipe:0',
          '-f', 's16le', '-ar', '48000', '-ac', '2',
          '-af', 'aresample=async=1',
          '-loglevel', 'warning',
          'pipe:1',
        ], { stdio: ['pipe','pipe','pipe'] });
        queue.ffProc = ffProc;

        ytProc.stdout.pipe(ffProc.stdin, { end: true });
        ytProc.stdout.on('error', e => { if (e.code !== 'EPIPE') console.error('[yt-dlp]', e.message); });
        ffProc.stdin.on('error',  e => { if (e.code !== 'EPIPE') console.error('[ffmpeg]', e.message); });
        ytProc.on('error', e => console.error('yt-dlp spawn:', e.message));
        ffProc.on('error', e => console.error('ffmpeg spawn:', e.message));
        ytProc.stderr.on('data', d => console.error('[yt-dlp stderr]', d.toString().trim()));
        ffProc.stderr.on('data', d => console.error('[ffmpeg stderr]', d.toString().trim()));
        audioSource = ffProc.stdout;
      }

      const resource = createAudioResource(audioSource, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume?.setVolume(queue.volume);

      if (!queue.player) {
        queue.player = createAudioPlayer();
        queue.connection.subscribe(queue.player);
        queue.player.on(AudioPlayerStatus.Idle, () => this.handleTrackEnd(guildId));
        queue.player.on('error', err => {
          console.error(`Player error на треку "${track.title}":`, err.message);
          this.handleTrackEnd(guildId, { failed: true });
        });
      }

      queue.player.play(resource);
      this.startPositionTimer(guildId);

      queue.textChannel?.send({
        embeds: [{
          color: 0x1DB954,
          author: { name: '▶️ Зараз грає' },
          title: track.title, url: track.url,
          thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
          fields: [
            { name: '⏱️ Тривалість', value: track.durationFormatted, inline: true },
            { name: '👤 Виконавець',  value: track.author,            inline: true },
            { name: '🎧 Запитав',     value: track.requestedBy || '—', inline: true },
            { name: '📋 Черга',       value: `${queue.currentIndex+1}/${queue.tracks.length}`, inline: true },
          ],
        }]
      }).catch(() => {});

      this.emitUpdate(guildId);

      // Autoplay: підтримуємо запас треків попереду (мінімум 2),
      // запит будуємо на основі ПЕРШОГО треку поточної "сесії", щоб не дрейфувати
      if (queue.autoplay) {
        const tracksAhead = queue.tracks.length - 1 - queue.currentIndex;
        if (tracksAhead < 2) {
          const anchor = queue.autoplayAnchor || track;
          this.autoAddRelated(guildId, anchor).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`playCurrentTrack error на треку "${track.title}":`, err.message);
      queue.textChannel?.send(`❌ Не вдалося відтворити: **${track.title}**`).catch(() => {});
      this.handleTrackEnd(guildId, { failed: true });
    }
  }

  async handleTrackEnd(guildId, opts = {}) {
    const queue = this.getQueue(guildId);
    this.killProcesses(queue);
    this.stopPositionTimer(guildId);

    if (queue.loop === 'track' && !opts.failed && !queue.manualSeek) { await this.playCurrentTrack(guildId); return; }

    if (queue.manualSeek) {
      // Ручний перехід (jump/skip/previous) вже встановив currentIndex - не змінюємо його
      queue.manualSeek = false;
    } else if (opts.failed && queue.tracks[queue.currentIndex]) {
      // Якщо трек провалився і це autoplay-трек - видаляємо його з черги,
      // щоб він не залишався "якорем" для нескінченного пошуку
      console.log(`🤖 [autoplay] Видаляю трек, що не відтворився: "${queue.tracks[queue.currentIndex].title}"`);
      queue.tracks.splice(queue.currentIndex, 1);
      // currentIndex залишається тим самим - тепер вказує на наступний трек
    } else {
      queue.currentIndex = queue.loop === 'queue'
        ? (queue.currentIndex + 1) % queue.tracks.length
        : queue.currentIndex + 1;
    }

    if (queue.currentIndex < queue.tracks.length) {
      await this.playCurrentTrack(guildId);
    } else {
      // Якщо autoplay — запускаємо пошук схожих і чекаємо до 5 секунд
      if (queue.autoplay) {
        const anchor = queue.autoplayAnchor || queue.tracks[queue.tracks.length - 1];
        console.log(`🤖 [autoplay] Черга закінчена, currentIndex=${queue.currentIndex}, tracks.length=${queue.tracks.length}. Шукаю схожі треки для якоря "${anchor?.title}"...`);
        this.autoAddRelated(guildId, anchor).catch(() => {});

        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (queue.tracks.length > queue.currentIndex) {
            console.log('🤖 [autoplay] Знайдено новий трек, відтворюю!');
            await this.playCurrentTrack(guildId);
            return;
          }
        }
        console.log('🤖 [autoplay] Час вийшов, треків не додано.');
      }
      queue.isPlaying    = false;
      queue.currentTrack = null;
      queue.textChannel?.send('✅ Черга завершена!').catch(() => {});
      this.emitUpdate(guildId);
    }
  }

  // FIX: autoplay використовує YouTube Mix (Radio) - дає різноманітні, але тематично схожі треки
  async autoAddRelated(guildId, track) {
    try {
      const queue = this.getQueue(guildId);

      // Витягуємо video ID з URL для побудови Mix-плейлиста
      const match = track.url.match(/[?&]v=([^&]+)/);
      const videoId = match ? match[1] : null;

      let entries = [];

      if (videoId) {
        const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
        console.log(`🤖 [autoplay] Шукаю через YouTube Mix для: "${track.title}"`);
        try {
          const info = await this.ytdlpJSON([
            '--flat-playlist', '--no-warnings', '--no-progress',
            '--playlist-end', '15',
            mixUrl,
          ]);
          entries = info.entries || [];
          console.log(`🤖 [autoplay] Mix повернув ${entries.length} результатів:`,
            entries.map(e => `${e.uploader || e.channel || '?'} - ${e.title}`).join(' | '));
        } catch (e) {
          console.log('🤖 [autoplay] Mix недоступний, fallback на текстовий пошук:', e.message);
        }
      }

      // Fallback: якщо Mix не дав результатів - текстовий пошук
      if (!entries.length) {
        const query = `${track.title} ${track.author}`.slice(0, 80);
        console.log(`🤖 [autoplay] Шукаю схожі треки для: "${query}"`);
        const info = await this.ytdlpJSON([
          '--flat-playlist','--no-warnings','--no-progress',
          `ytsearch5:${query}`,
        ]);
        entries = info.entries || [];
        console.log(`🤖 [autoplay] yt-dlp повернув ${entries.length} результатів`);
      }

      const existing = new Set(queue.tracks.map(t => t.url));

      // Рахуємо, скільки треків кожного автора вже є в черзі
      const authorCounts = {};
      for (const t of queue.tracks) {
        const a = (t.author || '').toLowerCase().trim();
        if (a) authorCounts[a] = (authorCounts[a] || 0) + 1;
      }

      // Перемішуємо, щоб не завжди брати перші (часто це той самий трек/найпопулярніше)
      const shuffled = [...entries].sort(() => Math.random() - 0.5);

      const candidates = shuffled
        .filter(e => {
          const id  = e.id || '';
          const url = e.url || '';
          if (id.startsWith('@') || id.startsWith('UC') || id.startsWith('PL')) return false;
          if (url.includes('/channel/') || url.includes('/@') || url.includes('/c/')) return false;
          const trackUrl = e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${id}`;
          return !existing.has(trackUrl) && trackUrl !== track.url;
        })
        .map(e => ({ ...this.entryToTrack(e), requestedBy: '🤖 Autoplay' }));

      // Спочатку беремо треки авторів, яких ще НЕ було (макс 1 трек кожного autoplay-доданого автора підряд)
      const newOnes = [];
      const usedAuthorsThisBatch = new Set();
      for (const c of candidates) {
        if (newOnes.length >= 3) break;
        const a = (c.author || '').toLowerCase().trim();
        const existingCount = authorCounts[a] || 0;
        // Пропускаємо, якщо цього автора вже >=2 в черзі, або вже взяли його в цій партії
        if (existingCount >= 2 || usedAuthorsThisBatch.has(a)) continue;
        newOnes.push(c);
        usedAuthorsThisBatch.add(a);
        authorCounts[a] = existingCount + 1;
      }

      // Якщо не набрали 3 через жорсткий фільтр - доповнюємо з решти кандидатів
      if (newOnes.length < 3) {
        for (const c of candidates) {
          if (newOnes.length >= 3) break;
          if (newOnes.includes(c)) continue;
          newOnes.push(c);
        }
      }

      console.log(`🤖 [autoplay] Після фільтрації залишилось ${newOnes.length} треків:`,
        newOnes.map(t => `${t.author} - ${t.title}`).join(' | '));

      if (newOnes.length) {
        queue.tracks.push(...newOnes);
        this.emitUpdate(guildId);
        console.log(`🤖 Autoplay додав ${newOnes.length} треків`);
      } else {
        console.log('🤖 [autoplay] Нічого не додано (0 треків після фільтрації)');
      }
    } catch (e) {
      console.error('🤖 [autoplay] autoAddRelated error:', e.message);
    }
  }

  startPositionTimer(guildId) {
    const queue = this.getQueue(guildId);
    if (queue.positionTimer) clearInterval(queue.positionTimer);
    queue.currentTime   = queue.seekOffset || 0;
    queue.positionTimer = setInterval(() => {
      const q = this.queues.get(guildId);
      if (!q) return;
      if (q.isPlaying) {
        q.currentTime++;
        if (q.currentTime % 2 === 0) this.emitUpdate(guildId);
      }
    }, 1000);
  }

  stopPositionTimer(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    if (queue.positionTimer) { clearInterval(queue.positionTimer); queue.positionTimer = null; }
  }

  async seekTo(guildId, seconds) {
    const queue = this.getQueue(guildId);
    if (!queue.currentTrack) throw new Error('Нічого не грає!');
    const pos = Math.max(0, Math.min(seconds, (queue.currentTrack.duration || 0) - 1));

    this.killProcesses(queue);
    this.stopPositionTimer(guildId);
    queue.seekOffset  = pos;
    queue.currentTime = pos;

    const track = queue.currentTrack;
    let audioSource;

    const cachedUrl = queue.audioUrlCache.get(track.url);
    if (cachedUrl) {
      // Швидка перемотка через прямий URL
      const ffProc = spawn(FFMPEG, [
        '-ss', String(pos), '-i', cachedUrl,
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1', '-loglevel', 'warning', 'pipe:1',
      ], { stdio: ['ignore','pipe','pipe'] });
      queue.ffProc = ffProc;
      ffProc.on('error', e => console.error('ffmpeg seek:', e.message));
      audioSource = ffProc.stdout;
    } else {
      const ytProc = spawn(YTDLP, [
        '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--no-progress', '-o', '-', track.url,
      ], { stdio: ['ignore','pipe','ignore'] });
      const ffProc = spawn(FFMPEG, [
        '-ss', String(pos), '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1', '-loglevel', 'warning', 'pipe:1',
      ], { stdio: ['pipe','pipe','ignore'] });
      queue.ytProc = ytProc;
      queue.ffProc = ffProc;
      ytProc.stdout.pipe(ffProc.stdin, { end: true });
      ytProc.stdout.on('error', e => { if (e.code !== 'EPIPE') console.error(e.message); });
      ffProc.stdin.on('error',  e => { if (e.code !== 'EPIPE') console.error(e.message); });
      audioSource = ffProc.stdout;
      this.getAudioUrl(track, queue).catch(() => {});
    }

    const resource = createAudioResource(audioSource, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(queue.volume);
    if (queue.player) queue.player.play(resource);
    this.startPositionTimer(guildId);
    this.emitUpdate(guildId);
  }

  killProcesses(queue) {
    try { queue.ytProc?.kill('SIGKILL'); } catch {}
    try { queue.ffProc?.kill('SIGKILL'); } catch {}
    queue.ytProc = null;
    queue.ffProc = null;
  }

  // Захист від одночасних команд
  async withLock(guildId, fn) {
    const queue = this.getQueue(guildId);
    if (queue.commandLock) throw new Error('Зачекай, виконується попередня команда...');
    queue.commandLock = true;
    try { return await fn(); }
    finally { queue.commandLock = false; }
  }

  async skip(guildId, count = 1) {
    return this.withLock(guildId, async () => {
      const queue = this.getQueue(guildId);
      if (!queue.isPlaying) throw new Error('Нічого не грає!');
      queue.currentIndex = Math.min(queue.currentIndex + count, queue.tracks.length - 1);
      queue.manualSeek = true;
      if (queue.autoplay) queue.autoplayAnchor = queue.tracks[queue.currentIndex] || null;
      queue.player?.stop();
    });
  }

  async previous(guildId) {
    return this.withLock(guildId, async () => {
      const queue = this.getQueue(guildId);
      if (queue.currentIndex <= 0) throw new Error('Це перший трек!');
      queue.currentIndex--;
      queue.manualSeek = true;
      if (queue.autoplay) queue.autoplayAnchor = queue.tracks[queue.currentIndex] || null;
      queue.player?.stop();
    });
  }

  togglePause(guildId) {
    const queue = this.getQueue(guildId);
    if (!queue.player) throw new Error('Нічого не грає!');
    if (queue.player.state.status === AudioPlayerStatus.Paused) {
      queue.player.unpause(); queue.isPlaying = true;
    } else {
      queue.player.pause(); queue.isPlaying = false;
    }
    this.emitUpdate(guildId);
    return queue.isPlaying;
  }

  setVolume(guildId, vol) {
    const queue = this.getQueue(guildId);
    queue.volume = Math.max(0, Math.min(1, vol / 100));
    try { queue.player?.state?.resource?.volume?.setVolume(queue.volume); } catch {}
    this.emitUpdate(guildId);
    return Math.round(queue.volume * 100);
  }

  setLoop(guildId, mode) {
    const queue = this.getQueue(guildId);
    if (!['none','track','queue'].includes(mode)) throw new Error('none / track / queue');
    queue.loop = mode;
    this.emitUpdate(guildId);
  }

  shuffle(guildId) {
    const queue = this.getQueue(guildId);
    const cur   = queue.tracks[queue.currentIndex];
    const rest  = queue.tracks.filter((_, i) => i !== queue.currentIndex);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    queue.tracks       = [cur, ...rest];
    queue.currentIndex = 0;
    this.emitUpdate(guildId);
  }

  removeTrack(guildId, index) {
    const queue = this.getQueue(guildId);
    if (index < 0 || index >= queue.tracks.length) throw new Error('Невірний номер!');
    const removed = queue.tracks.splice(index, 1)[0];
    if (index < queue.currentIndex) queue.currentIndex--;
    this.emitUpdate(guildId);
    return removed;
  }

  stop(guildId) {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    this.stopPositionTimer(guildId);
    this.killProcesses(queue);
    queue.player?.stop();
    queue.connection?.destroy();
    this.queues.delete(guildId);
    this.emitUpdate(guildId);
  }

  async jumpTo(guildId, index) {
    return this.withLock(guildId, async () => {
      const queue = this.getQueue(guildId);
      if (index < 0 || index >= queue.tracks.length) throw new Error('Невірний номер!');
      queue.currentIndex = index;
      queue.manualSeek = true;
      // Оновлюємо якір автоплею на трек до якого стрибаємо
      if (queue.autoplay) queue.autoplayAnchor = queue.tracks[index] || null;
      queue.player?.stop();
    });
  }

  toggleAutoplay(guildId) {
    const queue = this.getQueue(guildId);
    queue.autoplay = !queue.autoplay;
    if (queue.autoplay) {
      // Якір = ПОТОЧНИЙ трек (той що грає зараз), а не той що грав коли вмикали
      queue.autoplayAnchor = queue.currentTrack || queue.tracks[queue.currentIndex] || null;
      console.log(`🤖 [autoplay] Увімкнено, якір: ${queue.autoplayAnchor?.title}`);
    } else {
      queue.autoplayAnchor = null;
      console.log('🤖 [autoplay] Вимкнено');
    }
    this.emitUpdate(guildId);
    return queue.autoplay;
  }

  getState(guildId) {
    const q = this.queues.get(guildId);
    if (!q) return null;
    return {
      guildId,
      currentTrack:   q.currentTrack,
      tracks:         q.tracks,
      currentIndex:   q.currentIndex,
      isPlaying:      q.isPlaying,
      loop:           q.loop,
      volume:         Math.round(q.volume * 100),
      autoplay:       q.autoplay,
      voiceChannel:   q.voiceChannel?.name || null,
      voiceChannelId: q.voiceChannel?.id   || null,
      currentTime:    q.currentTime || 0,
    };
  }

  emitUpdate(guildId) {
    if (this.webEmitter) this.webEmitter.emit('musicUpdate', { guildId, state: this.getState(guildId) });
  }

  formatDuration(sec) {
    sec = Math.floor(sec || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }
}

module.exports = MusicManager;
