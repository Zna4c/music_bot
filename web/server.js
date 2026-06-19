const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

// ── Папка з локальною музикою ─────────────────────────────────────────────────
const MUSIC_DIR = path.join(process.cwd(), 'music');
if (!fs.existsSync(MUSIC_DIR)) {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  console.log('📁 Створено папку music/ — поклади туди свої MP3/FLAC/WAV файли');
}
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma']);

const webEmitter = new EventEmitter();

// ── Система логів ─────────────────────────────────────────────────────────────
const logBuffer = []; // зберігаємо останні 200 рядків
const MAX_LOGS = 200;
let ioInstance = null;

function pushLog(level, args) {
  const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
  const entry = { time: new Date().toISOString(), level, text };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  if (ioInstance) ioInstance.emit('log', entry);
}

// Перехоплюємо console.log / console.error / console.warn
const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

console.log   = (...a) => { _log(...a);   pushLog('info',  a); };
console.error = (...a) => { _error(...a); pushLog('error', a); };
console.warn  = (...a) => { _warn(...a);  pushLog('warn',  a); };

function startWebServer(discordClient) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  ioInstance = io;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  discordClient.musicManager.webEmitter = webEmitter;
  webEmitter.on('musicUpdate', ({ guildId, state }) => {
    io.to(`guild:${guildId}`).emit('stateUpdate', state);
  });

  // Список серверів
  app.get('/api/guilds', (req, res) => {
    const guilds = discordClient.guilds.cache.map(g => ({
      id: g.id, name: g.name,
      icon: g.iconURL({ size: 64 }),
      memberCount: g.memberCount,
      hasQueue: discordClient.musicManager.queues.has(g.id),
    }));
    res.json(guilds);
  });

  // Стан плеєра
  app.get('/api/guild/:guildId/state', (req, res) => {
    const state = discordClient.musicManager.getState(req.params.guildId);
    res.json(state || { empty: true });
  });

  // Пошук
  app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
      const results = await discordClient.musicManager.searchTrack(q);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Додати трек
  app.post('/api/guild/:guildId/play', async (req, res) => {
    const { guildId } = req.params;
    const { query, voiceChannelId } = req.body;
    try {
      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Сервер не знайдено' });

      const manager = discordClient.musicManager;
      const tracks = await manager.addTrack(guildId, query, '🌐 Web Panel');
      const q = manager.getQueue(guildId);

      // Завжди беремо канал з запиту (якщо вказано), інакше поточний
      const targetChannel = voiceChannelId
        ? guild.channels.cache.get(voiceChannelId)
        : q.voiceChannel;
      if (!targetChannel) return res.status(400).json({ error: 'Вибери голосовий канал!' });

      if (!q.isPlaying) {
        // Починаємо з нового треку, а не з початку черги
        q.currentIndex = q.tracks.length - tracks.length;
        const textChannel = guild.channels.cache.find(c => c.type === 0);
        await manager.play(guildId, targetChannel, textChannel);
      } else if (voiceChannelId && q.voiceChannel?.id !== voiceChannelId) {
        // Якщо бот вже грає але треба перемістити в інший канал
        await manager.moveToChannel(guildId, targetChannel);
      }

      res.json({ success: true, tracks });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Переключити голосовий канал
  app.post('/api/guild/:guildId/move', async (req, res) => {
    const { guildId } = req.params;
    const { voiceChannelId } = req.body;
    try {
      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Сервер не знайдено' });
      const voiceChannel = guild.channels.cache.get(voiceChannelId);
      if (!voiceChannel) return res.status(404).json({ error: 'Канал не знайдено' });
      await discordClient.musicManager.moveToChannel(guildId, voiceChannel);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Пауза
  app.post('/api/guild/:guildId/pause', (req, res) => {
    try {
      const isPlaying = discordClient.musicManager.togglePause(req.params.guildId);
      res.json({ isPlaying });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Пропустити
  app.post('/api/guild/:guildId/skip', async (req, res) => {
    try {
      await discordClient.musicManager.skip(req.params.guildId);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Попередній
  app.post('/api/guild/:guildId/previous', async (req, res) => {
    try {
      await discordClient.musicManager.previous(req.params.guildId);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Зупинити
  app.post('/api/guild/:guildId/stop', (req, res) => {
    discordClient.musicManager.stop(req.params.guildId);
    res.json({ success: true });
  });

  // Гучність
  app.post('/api/guild/:guildId/volume', (req, res) => {
    try {
      const vol = discordClient.musicManager.setVolume(req.params.guildId, req.body.volume);
      res.json({ volume: vol });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Loop
  app.post('/api/guild/:guildId/loop', (req, res) => {
    try {
      discordClient.musicManager.setLoop(req.params.guildId, req.body.mode);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Перемішати
  app.post('/api/guild/:guildId/shuffle', (req, res) => {
    discordClient.musicManager.shuffle(req.params.guildId);
    res.json({ success: true });
  });

  // Видалити трек
  app.delete('/api/guild/:guildId/track/:index', (req, res) => {
    try {
      const removed = discordClient.musicManager.removeTrack(req.params.guildId, parseInt(req.params.index));
      res.json({ removed });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Перейти до треку
  app.post('/api/guild/:guildId/jump/:index', async (req, res) => {
    try {
      await discordClient.musicManager.jumpTo(req.params.guildId, parseInt(req.params.index));
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Autoplay
  app.post('/api/guild/:guildId/autoplay', (req, res) => {
    const enabled = discordClient.musicManager.toggleAutoplay(req.params.guildId);
    res.json({ autoplay: enabled });
  });

  // Голосові канали
  app.get('/api/guild/:guildId/voice-channels', (req, res) => {
    const guild = discordClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Не знайдено' });
    const channels = guild.channels.cache
      .filter(c => c.type === 2)
      .map(c => ({ id: c.id, name: c.name, memberCount: c.members.size }));
    res.json(channels);
  });

  // Перемотування
  app.post('/api/guild/:guildId/seek', async (req, res) => {
    try {
      await discordClient.musicManager.seekTo(req.params.guildId, req.body.seconds);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Локальна музика ────────────────────────────────────────────────────────

  // Список файлів у папці music/
  app.get('/api/local-music', (req, res) => {
    try {
      const files = fs.readdirSync(MUSIC_DIR)
        .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
        .map(f => ({
          name: f,
          title: f.replace(/\.[^.]+$/, ''),
          ext: path.extname(f).slice(1).toUpperCase(),
          size: (() => {
            try { const s = fs.statSync(path.join(MUSIC_DIR, f)).size; return (s / 1024 / 1024).toFixed(1) + ' MB'; } catch { return '—'; }
          })(),
          path: path.join(MUSIC_DIR, f),
        }));
      res.json(files);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Відтворити файл з папки music/
  app.post('/api/guild/:guildId/play-local', async (req, res) => {
    const { guildId } = req.params;
    const { filename, voiceChannelId } = req.body;
    try {
      const filePath = path.join(MUSIC_DIR, path.basename(filename)); // basename — захист від path traversal
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не знайдено' });
      if (!AUDIO_EXTS.has(path.extname(filePath).toLowerCase())) return res.status(400).json({ error: 'Непідтримуваний формат' });

      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Сервер не знайдено' });

      const manager = discordClient.musicManager;
      const tracks = await manager.addTrack(guildId, filePath, '🌐 Web Panel');
      const q = manager.getQueue(guildId);

      const targetChannel = voiceChannelId
        ? guild.channels.cache.get(voiceChannelId)
        : q.voiceChannel;
      if (!targetChannel) return res.status(400).json({ error: 'Вибери голосовий канал!' });

      if (!q.isPlaying) {
        q.currentIndex = q.tracks.length - 1;
        const textChannel = guild.channels.cache.find(c => c.type === 0);
        await manager.play(guildId, targetChannel, textChannel);
      }

      res.json({ success: true, track: tracks[0] });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Шлях до папки music/
  app.get('/api/local-music/folder', (req, res) => {
    res.json({ path: MUSIC_DIR });
  });

  // ── Плейлисти ──────────────────────────────────────────────────────────────
  const playlists = new Map();

  app.get('/api/playlists', (req, res) => {
    res.json([...playlists.values()].map(p => ({ id: p.id, name: p.name, count: p.tracks.length })));
  });

  app.get('/api/playlist/:id', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Плейлист не знайдено' });
    res.json(p);
  });

  app.post('/api/playlists', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Назва обов\'язкова' });
    const id = Date.now().toString(36);
    playlists.set(id, { id, name, tracks: [] });
    res.json({ id, name, tracks: [] });
  });

  app.delete('/api/playlist/:id', (req, res) => {
    playlists.delete(req.params.id);
    res.json({ success: true });
  });

  app.post('/api/playlist/:id/add', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Плейлист не знайдено' });
    const { track } = req.body;
    if (!track?.url) return res.status(400).json({ error: 'Немає треку' });
    if (!p.tracks.find(t => t.url === track.url)) p.tracks.push(track);
    res.json({ success: true, count: p.tracks.length });
  });

  app.delete('/api/playlist/:id/track/:idx', (req, res) => {
    const p = playlists.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Плейлист не знайдено' });
    p.tracks.splice(parseInt(req.params.idx), 1);
    res.json({ success: true });
  });

  app.post('/api/guild/:guildId/playlist/:playlistId', async (req, res) => {
    const p = playlists.get(req.params.playlistId);
    if (!p || !p.tracks.length) return res.status(404).json({ error: 'Плейлист порожній' });
    const { guildId } = req.params;
    const { voiceChannelId } = req.body;
    try {
      const guild = discordClient.guilds.cache.get(guildId);
      if (!guild) return res.status(404).json({ error: 'Сервер не знайдено' });
      const manager = discordClient.musicManager;
      const q = manager.getQueue(guildId);
      const tracks = p.tracks.map(t => ({ ...t, requestedBy: '📋 ' + p.name }));
      q.tracks.push(...tracks);
      manager.emitUpdate(guildId);
      if (!q.isPlaying) {
        const vc = voiceChannelId ? guild.channels.cache.get(voiceChannelId) : q.voiceChannel;
        if (!vc) return res.status(400).json({ error: 'Вибери голосовий канал!' });
        const tc = guild.channels.cache.find(c => c.type === 0);
        await manager.play(guildId, vc, tc);
      }
      res.json({ success: true, added: tracks.length });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/guild/:guildId/save-queue', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Назва обов\'язкова' });
    const q = discordClient.musicManager.queues.get(req.params.guildId);
    if (!q?.tracks.length) return res.status(400).json({ error: 'Черга порожня' });
    const id = Date.now().toString(36);
    const tracks = q.tracks.map(({ title, url, duration, thumbnail, author, durationFormatted }) =>
      ({ title, url, duration, thumbnail, author, durationFormatted }));
    playlists.set(id, { id, name, tracks });
    res.json({ id, name, count: tracks.length });
  });

  // Логи — отримати буфер
  app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
  });

  // Статус бота
  app.get('/api/status', (req, res) => {
    res.json({
      tag: discordClient.user ? discordClient.user.tag : null,
      uptime: process.uptime(),
      guildCount: discordClient.guilds.cache.size,
    });
  });

  // WebSocket
  io.on('connection', (socket) => {
    // Відправляємо буфер логів одразу при підключенні
    socket.emit('logHistory', logBuffer);

    socket.on('joinGuild', (guildId) => {
      socket.join(`guild:${guildId}`);
      const state = discordClient.musicManager.getState(guildId);
      socket.emit('stateUpdate', state);
    });
    socket.on('leaveGuild', (guildId) => socket.leave(`guild:${guildId}`));
  });

  return server;
}

module.exports = { startWebServer };
