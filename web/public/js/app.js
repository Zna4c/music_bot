const socket = io();
let currentGuildId = null;
let state = null;

// FIX: зберігаємо позицію скролу щоб сторінка не з'їжджала
let savedScrollTop = 0;
const mainEl = () => document.querySelector('.main');

document.addEventListener('DOMContentLoaded', async () => {
  await loadGuilds();
  setupControls();
  setupSearch();
  setupProgressBar();

  // FIX: зберігаємо скрол перед оновленням
  mainEl()?.addEventListener('scroll', () => {
    savedScrollTop = mainEl().scrollTop;
  });

  socket.on('stateUpdate', (newState) => {
    state = newState;
    renderPlayer();
  });
});

// ── Load Guilds ───────────────────────────────────────────────────────────────
async function loadGuilds() {
  const list = document.getElementById('guild-list');
  try {
    const guilds = await api('/guilds');
    list.innerHTML = '';
    if (!guilds.length) { list.innerHTML = '<div class="loading-spinner">Немає серверів</div>'; return; }

    guilds.forEach(g => {
      const item = document.createElement('div');
      item.className = 'guild-item';
      item.dataset.id = g.id;
      item.innerHTML = `
        ${g.icon ? `<img class="guild-icon" src="${g.icon}" alt="${g.name}">` : `<div class="guild-icon-placeholder">${g.name[0]}</div>`}
        <span class="guild-name">${g.name}</span>
        ${g.hasQueue ? '<span class="guild-playing"></span>' : ''}
      `;
      item.addEventListener('click', () => selectGuild(g.id));
      list.appendChild(item);
    });

    const withMusic = guilds.find(g => g.hasQueue);
    if (withMusic) selectGuild(withMusic.id);
  } catch (e) {
    list.innerHTML = '<div class="loading-spinner">Помилка завантаження</div>';
  }
}

// ── Select Guild ──────────────────────────────────────────────────────────────
async function selectGuild(guildId) {
  if (currentGuildId) socket.emit('leaveGuild', currentGuildId);
  currentGuildId = guildId;

  document.querySelectorAll('.guild-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === guildId);
  });

  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('player-panel').classList.remove('hidden');

  socket.emit('joinGuild', guildId);
  state = await api(`/guild/${guildId}/state`);
  renderPlayer();
  await loadVoiceChannels(guildId);
  await loadPlaylists();
  await loadLikes();
  await loadLocalMusic();
}

// ── loadLikes stub (якщо не реалізовано окремо) ───────────────────────────────
async function loadLikes() {
  // Заглушка — якщо є своя реалізація, вона її перекриє
}

// ── Load Voice Channels ───────────────────────────────────────────────────────
async function loadVoiceChannels(guildId) {
  const select = document.getElementById('vc-select');
  const prev = select.value;
  select.innerHTML = '<option value="">Оберіть канал...</option>';
  const channels = await api(`/guild/${guildId}/voice-channels`).catch(() => []);
  channels.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `🔊 ${ch.name} (${ch.memberCount})`;
    select.appendChild(opt);
  });
  // Відновлюємо вибраний канал
  if (prev) select.value = prev;
  // Або вибираємо поточний канал бота
  if (!select.value && state?.voiceChannelId) select.value = state.voiceChannelId;
}

// ── Render Player ─────────────────────────────────────────────────────────────
function renderPlayer() {
  if (!state) return;

  // FIX: запам'ятовуємо скрол до рендеру
  const scroll = mainEl()?.scrollTop ?? savedScrollTop;

  const t = state.currentTrack;
  if (t) {
    document.getElementById('track-title').textContent = t.title;
    document.getElementById('track-author').textContent = t.author || '—';
    document.getElementById('track-thumb').src = t.thumbnail || '';
    document.getElementById('track-duration').textContent = `⏱️ ${t.durationFormatted}`;
    document.getElementById('playing-indicator').style.opacity = state.isPlaying ? '1' : '0';
  } else {
    document.getElementById('track-title').textContent = '—';
    document.getElementById('track-author').textContent = 'Немає активного треку';
    document.getElementById('track-thumb').src = '';
    document.getElementById('playing-indicator').style.opacity = '0';
  }

  document.getElementById('voice-channel').textContent = state.voiceChannel ? `🔊 ${state.voiceChannel}` : '—';

  // Progress bar
  const duration = state.currentTrack?.duration || 0;
  const current  = state.currentTime || 0;
  const pct      = duration > 0 ? Math.min((current / duration) * 100, 100) : 0;
  document.getElementById('current-time').textContent = formatTime(current);
  document.getElementById('total-time').textContent   = formatTime(duration);
  document.getElementById('progress-bar-fill').style.width = pct + '%';
  document.getElementById('progress-bar-thumb').style.left = pct + '%';

  // Pause button
  document.getElementById('btn-pause').textContent = state.isPlaying ? '⏸️' : '▶️';

  // Volume — не перезаписуємо якщо юзер тягне слайдер
  if (document.activeElement !== document.getElementById('volume-slider')) {
    const vol = state.volume ?? 50;
    document.getElementById('volume-slider').value = vol;
    document.getElementById('vol-display').textContent = vol;
  }

  // Loop
  document.querySelectorAll('.loop-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.loop === state.loop);
  });

  // Autoplay
  const autoBtn = document.getElementById('btn-autoplay');
  autoBtn.classList.toggle('on', !!state.autoplay);
  autoBtn.title = state.autoplay ? 'Autoplay: Увімкнено' : 'Autoplay: Вимкнено';

  renderQueue();

  // FIX: відновлюємо скрол після рендеру
  requestAnimationFrame(() => {
    if (mainEl()) mainEl().scrollTop = scroll;
  });
}

// ── Render Queue ──────────────────────────────────────────────────────────────
function renderQueue() {
  const list       = document.getElementById('queue-list');
  const countEl    = document.getElementById('queue-count');
  const tracks     = state?.tracks || [];
  const currentIdx = state?.currentIndex ?? -1;

  countEl.textContent = tracks.length;

  if (!tracks.length) {
    list.innerHTML = '<div class="queue-empty">Черга порожня — додай треки через пошук!</div>';
    return;
  }

  // FIX: зберігаємо скрол черги
  const qScroll = list.scrollTop;

  list.innerHTML = '';
  tracks.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item' + (i === currentIdx ? ' current' : '');
    item.innerHTML = `
      <span class="qi-num">${i === currentIdx ? '▶' : i + 1}</span>
      <img class="qi-thumb" src="${t.thumbnail || ''}" alt="">
      <div class="qi-info">
        <div class="qi-title">${escHtml(t.title)}</div>
        <div class="qi-meta">${escHtml(t.author || '—')} • ${t.durationFormatted} • ${escHtml(t.requestedBy || '—')}</div>
      </div>
      <button class="qi-remove" data-index="${i}" title="Видалити">✕</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('qi-remove')) return;
      jumpToTrack(i);
    });
    item.querySelector('.qi-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeTrack(i);
    });
    list.appendChild(item);
  });

  // FIX: відновлюємо скрол черги, не стрибаємо до current автоматично
  requestAnimationFrame(() => { list.scrollTop = qScroll; });
}

// ── Setup Controls ────────────────────────────────────────────────────────────
function setupControls() {
  document.getElementById('btn-pause').addEventListener('click', () => apiPost(`/guild/${currentGuildId}/pause`));
  document.getElementById('btn-skip').addEventListener('click', () => apiPost(`/guild/${currentGuildId}/skip`));
  document.getElementById('btn-prev').addEventListener('click', () => apiPost(`/guild/${currentGuildId}/previous`));
  document.getElementById('btn-stop').addEventListener('click', () => {
    if (confirm('Зупинити відтворення і очистити чергу?')) apiPost(`/guild/${currentGuildId}/stop`);
  });
  document.getElementById('btn-shuffle').addEventListener('click', () => {
    apiPost(`/guild/${currentGuildId}/shuffle`);
    toast('🔀 Чергу перемішано!');
  });
  document.getElementById('btn-autoplay').addEventListener('click', async () => {
    const res = await apiPost(`/guild/${currentGuildId}/autoplay`);
    toast(res.autoplay ? '🤖 Autoplay увімкнено!' : '🤖 Autoplay вимкнено');
  });
  document.getElementById('btn-clear-queue').addEventListener('click', () => {
    if (confirm('Очистити всю чергу?')) apiPost(`/guild/${currentGuildId}/stop`);
  });

  // Seek buttons
  document.getElementById('btn-seek-back').addEventListener('click', () => {
    const pos = Math.max(0, (state?.currentTime || 0) - 10);
    apiPost(`/guild/${currentGuildId}/seek`, { seconds: pos });
  });
  document.getElementById('btn-seek-fwd').addEventListener('click', () => {
    const dur = state?.currentTrack?.duration || 0;
    const pos = Math.min(dur - 1, (state?.currentTime || 0) + 10);
    apiPost(`/guild/${currentGuildId}/seek`, { seconds: pos });
  });

  // Volume
  const volSlider = document.getElementById('volume-slider');
  let volTimer;
  volSlider.addEventListener('input', (e) => {
    document.getElementById('vol-display').textContent = e.target.value;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      apiPost(`/guild/${currentGuildId}/volume`, { volume: parseInt(e.target.value) });
    }, 300);
  });

  // Loop
  document.querySelectorAll('.loop-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      apiPost(`/guild/${currentGuildId}/loop`, { mode: btn.dataset.loop });
    });
  });
}

// ── Progress Bar ──────────────────────────────────────────────────────────────
function setupProgressBar() {
  const bg = document.getElementById('progress-bar-bg');
  let isDragging = false;

  function seek(e) {
    const rect = bg.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur  = state?.currentTrack?.duration || 0;
    if (dur > 0) {
      // FIX: оптимістично оновлюємо UI одразу
      const secs = Math.floor(pct * dur);
      document.getElementById('progress-bar-fill').style.width = (pct * 100) + '%';
      document.getElementById('current-time').textContent = formatTime(secs);
      apiPost(`/guild/${currentGuildId}/seek`, { seconds: secs });
    }
  }

  bg.addEventListener('mousedown', (e) => { isDragging = true; seek(e); });
  document.addEventListener('mousemove', (e) => { if (isDragging) seek(e); });
  document.addEventListener('mouseup', () => { isDragging = false; });
  bg.addEventListener('touchstart', (e) => { isDragging = true; seek(e.touches[0]); });
  document.addEventListener('touchmove', (e) => { if (isDragging) seek(e.touches[0]); });
  document.addEventListener('touchend', () => { isDragging = false; });
}

// ── Search ────────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = document.getElementById('search-input');
  document.getElementById('search-btn').addEventListener('click', performSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') performSearch(); });
}

async function performSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = '<div style="color:var(--text2);font-size:13px;padding:8px;">Пошук...</div>';

  try {
    const results = await api(`/search?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      resultsEl.innerHTML = '<div style="color:var(--text2);font-size:13px;padding:8px;">Нічого не знайдено</div>';
      return;
    }
    resultsEl.innerHTML = '';
    results.forEach(t => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <img class="sr-thumb" src="${t.thumbnail || ''}" alt="">
        <div class="sr-info">
          <div class="sr-title">${escHtml(t.title)}</div>
          <div class="sr-meta">${escHtml(t.author || '—')} • ${t.durationFormatted}</div>
        </div>
        <button class="sr-add">➕ Додати</button>
      `;
      item.querySelector('.sr-add').addEventListener('click', () => addToQueue(t.url, t.title));
      resultsEl.appendChild(item);
    });
  } catch (e) {
    resultsEl.innerHTML = '<div style="color:var(--danger);font-size:13px;padding:8px;">Помилка пошуку</div>';
  }
}

async function addToQueue(url, title) {
  const vcId = document.getElementById('vc-select').value;
  if (!vcId) { toast('⚠️ Обери голосовий канал!'); return; }
  try {
    await apiPost(`/guild/${currentGuildId}/play`, { query: url, voiceChannelId: vcId });
    toast(`✅ Додано: ${title.slice(0, 40)}`);
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
}

async function removeTrack(index) {
  await fetch(`/api/guild/${currentGuildId}/track/${index}`, { method: 'DELETE' });
}

async function jumpToTrack(index) {
  await apiPost(`/guild/${currentGuildId}/jump/${index}`);
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(path, body = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function formatTime(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Logs Panel ────────────────────────────────────────────────────────────────
(function () {
  const modal     = document.getElementById('logs-modal');
  const body      = document.getElementById('logs-body');
  const btnOpen   = document.getElementById('btn-show-logs');
  const btnClose  = document.getElementById('btn-logs-close');
  const btnClear  = document.getElementById('btn-logs-clear');
  const autoScroll = document.getElementById('logs-autoscroll');

  function addLogEntry(entry) {
    const d = document.createElement('div');
    d.className = 'log-entry ' + (entry.level || 'info');
    const t = new Date(entry.time);
    const ts = t.toLocaleTimeString('uk-UA', { hour12: false });
    d.innerHTML = `<span class="log-time">[${ts}]</span><span class="log-text">${escHtml(entry.text)}</span>`;
    body.appendChild(d);
    if (autoScroll && autoScroll.checked) body.scrollTop = body.scrollHeight;
    // Підсвічуємо кнопку якщо модал закритий
    if (modal.classList.contains('hidden')) {
      btnOpen.classList.add('has-new');
    }
  }

  // Отримуємо історію при підключенні
  socket.on('logHistory', (logs) => {
    body.innerHTML = '';
    logs.forEach(addLogEntry);
  });

  // Нові логи в реалтаймі
  socket.on('log', (entry) => {
    addLogEntry(entry);
  });

  btnOpen.addEventListener('click', () => {
    modal.classList.remove('hidden');
    btnOpen.classList.remove('has-new');
    setTimeout(() => { if (autoScroll.checked) body.scrollTop = body.scrollHeight; }, 50);
  });

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));

  // Закриття кліком на фон
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  btnClear.addEventListener('click', () => { body.innerHTML = ''; });
})();

// ── Bot Status ────────────────────────────────────────────────────────────────
(async function loadBotStatus() {
  try {
    const s = await api('/status');
    if (s.tag) {
      document.getElementById('bot-tag').textContent = s.tag;
    }
  } catch (e) { /* тихо */ }
})();

// ── Плейлисти ─────────────────────────────────────────────────────────────────
let playlistsData = [];

async function loadPlaylists() {
  try {
    playlistsData = await api('/playlists');
    renderPlaylists();
  } catch {}
}

function renderPlaylists() {
  const el = document.getElementById('playlist-list');
  if (!el) return;
  if (!playlistsData.length) {
    el.innerHTML = '<div class="queue-empty">Немає плейлистів</div>';
    return;
  }
  el.innerHTML = '';
  playlistsData.forEach(p => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.innerHTML = `
      <span class="pl-icon">📂</span>
      <div class="pl-info">
        <div class="pl-name">${escHtml(p.name)}</div>
        <div class="pl-meta">${p.count} треків</div>
      </div>
      <button class="pl-play" data-id="${p.id}" title="Відтворити">▶</button>
      <button class="pl-del" data-id="${p.id}" title="Видалити">✕</button>
    `;
    item.querySelector('.pl-play').addEventListener('click', () => playPlaylist(p.id));
    item.querySelector('.pl-del').addEventListener('click', () => deletePlaylist(p.id));
    el.appendChild(item);
  });
}

async function playPlaylist(id) {
  const vcId = document.getElementById('vc-select').value;
  if (!vcId) { toast('⚠️ Обери голосовий канал!'); return; }
  try {
    const res = await apiPost(`/guild/${currentGuildId}/playlist/${id}`, { voiceChannelId: vcId });
    toast(`✅ Плейлист завантажено (${res.added} треків)`);
  } catch (e) { toast(`❌ ${e.message}`); }
}

async function deletePlaylist(id) {
  if (!confirm('Видалити плейлист?')) return;
  await fetch(`/api/playlist/${id}`, { method: 'DELETE' });
  await loadPlaylists();
}

async function createPlaylist() {
  const name = document.getElementById('pl-name-input')?.value?.trim();
  if (!name) { toast('⚠️ Введи назву плейлиста'); return; }
  await apiPost('/playlists', { name });
  document.getElementById('pl-name-input').value = '';
  await loadPlaylists();
  toast(`✅ Плейлист "${name}" створено`);
}

async function saveQueueAsPlaylist() {
  const name = prompt('Назва плейлиста:');
  if (!name) return;
  try {
    const res = await apiPost(`/guild/${currentGuildId}/save-queue`, { name });
    await loadPlaylists();
    toast(`✅ Збережено "${res.name}" (${res.count} треків)`);
  } catch (e) { toast(`❌ ${e.message}`); }
}

// Додати трек до плейлиста з черги
async function addTrackToPlaylist(track) {
  if (!playlistsData.length) { toast('⚠️ Спочатку створи плейлист'); return; }
  const options = playlistsData.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const choice = prompt(`Обери плейлист:\n${options}\n\nВведи номер:`);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || !playlistsData[idx]) return;
  await apiPost(`/api/playlist/${playlistsData[idx].id}/add`, { track });
  toast(`✅ Додано до "${playlistsData[idx].name}"`);
}

// Ініціалізація після DOMContentLoaded вже є, але плейлисти треба підключити
document.addEventListener('DOMContentLoaded', () => {
  loadPlaylists();

  document.getElementById('btn-save-queue')?.addEventListener('click', saveQueueAsPlaylist);
  document.getElementById('btn-create-playlist')?.addEventListener('click', createPlaylist);

  // Завантажити YouTube плейлист URL
  document.getElementById('btn-load-yt-playlist')?.addEventListener('click', async () => {
    const url = document.getElementById('yt-playlist-url')?.value?.trim();
    if (!url || !url.includes('list=')) { toast('⚠️ Введи URL плейлиста YouTube'); return; }
    const vcId = document.getElementById('vc-select').value;
    if (!vcId) { toast('⚠️ Обери голосовий канал!'); return; }
    try {
      await apiPost(`/guild/${currentGuildId}/play`, { query: url, voiceChannelId: vcId });
      toast('✅ Плейлист YouTube додано до черги!');
    } catch (e) { toast(`❌ ${e.message}`); }
  });

  document.getElementById('btn-refresh-local')?.addEventListener('click', loadLocalMusic);
});

// ── Локальна музика ───────────────────────────────────────────────────────────
async function loadLocalMusic() {
  const listEl   = document.getElementById('local-music-list');
  const folderEl = document.getElementById('local-music-folder');
  if (!listEl) return;

  listEl.innerHTML = '<div class="queue-empty">Завантаження...</div>';

  try {
    // Показуємо шлях до папки
    const folderInfo = await api('/local-music/folder').catch(() => null);
    if (folderEl && folderInfo?.path) {
      folderEl.textContent = '📂 ' + folderInfo.path;
    }

    const files = await api('/local-music');

    if (!files.length) {
      listEl.innerHTML = `
        <div class="queue-empty">
          Папка <b>music/</b> порожня.<br>
          <span style="font-size:12px;opacity:.7;">Поклади туди MP3, FLAC, WAV, OGG або інші аудіо файли і натисни 🔄 Оновити</span>
        </div>`;
      return;
    }

    listEl.innerHTML = '';
    files.forEach(f => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      item.style.cursor = 'pointer';
      item.innerHTML = `
        <span class="qi-num" style="font-size:18px;">🎵</span>
        <div class="qi-info" style="flex:1;">
          <div class="qi-title">${escHtml(f.title)}</div>
          <div class="qi-meta">${f.ext} • ${f.size}</div>
        </div>
        <button class="sr-add" data-file="${escHtml(f.name)}" title="Додати до черги">➕ Грати</button>
      `;
      item.querySelector('.sr-add').addEventListener('click', (e) => {
        e.stopPropagation();
        playLocalFile(f.name, f.title);
      });
      listEl.appendChild(item);
    });
  } catch (e) {
    listEl.innerHTML = `<div class="queue-empty" style="color:var(--danger);">Помилка: ${escHtml(e.message)}</div>`;
  }
}

async function playLocalFile(filename, title) {
  const vcId = document.getElementById('vc-select').value;
  if (!vcId) { toast('⚠️ Обери голосовий канал!'); return; }
  try {
    await apiPost(`/guild/${currentGuildId}/play-local`, { filename, voiceChannelId: vcId });
    toast(`✅ Додано: ${title.slice(0, 40)}`);
  } catch (e) {
    toast(`❌ ${e.message}`);
  }
}
