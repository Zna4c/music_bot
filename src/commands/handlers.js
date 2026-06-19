const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

// ── Хелпер: перевірити голосовий канал ───────────────────────────────────────
function checkVoice(interaction) {
  const member = interaction.member;
  const channel = member.voice?.channel;
  if (!channel) {
    interaction.reply({ content: '❌ Ти маєш бути в голосовому каналі!', ephemeral: true });
    return null;
  }
  return channel;
}

async function checkVoiceAsync(interaction) {
  try {
    // Примусово отримуємо свіжі дані учасника
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const channel = member.voice?.channel;
    if (!channel) {
      await interaction.reply({ content: '❌ Ти маєш бути в голосовому каналі!', ephemeral: true });
      return null;
    }
    return channel;
  } catch (e) {
    await interaction.reply({ content: '❌ Не вдалось отримати дані голосового каналу!', ephemeral: true });
    return null;
  }
}

// ── /play ─────────────────────────────────────────────────────────────────────
async function play(interaction) {
  const voiceChannel = await checkVoiceAsync(interaction);
  if (!voiceChannel) return;

  await interaction.deferReply();
  const query = interaction.options.getString('query');
  const manager = interaction.client.musicManager;

  try {
    const tracks = await manager.addTrack(
      interaction.guildId,
      query,
      interaction.user.username
    );

    const queue = manager.getQueue(interaction.guildId);
    const isFirst = queue.tracks.length === tracks.length;

    if (isFirst || !queue.isPlaying) {
      await manager.play(interaction.guildId, voiceChannel, interaction.channel);
    }

    if (tracks.length === 1) {
      const t = tracks[0];
      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('➕ Додано до черги')
        .setDescription(`**[${t.title}](${t.url})**`)
        .setThumbnail(t.thumbnail)
        .addFields(
          { name: '⏱️', value: t.durationFormatted, inline: true },
          { name: '👤', value: t.author || '—', inline: true },
          { name: '📋 Позиція', value: `#${queue.tracks.length}`, inline: true }
        );
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.editReply({
        embeds: [{
          color: 0x1DB954,
          title: '📂 Плейлист додано',
          description: `Додано **${tracks.length}** треків до черги`,
        }]
      });
    }
  } catch (error) {
    await interaction.editReply(`❌ Помилка: ${error.message}`);
  }
}

// ── /skip ─────────────────────────────────────────────────────────────────────
async function skip(interaction) {
  checkVoice(interaction);
  const count = interaction.options.getInteger('count') || 1;
  const manager = interaction.client.musicManager;

  try {
    await manager.skip(interaction.guildId, count);
    await interaction.reply(`⏭️ Пропущено **${count}** трек(ів)`);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /previous ─────────────────────────────────────────────────────────────────
async function previous(interaction) {
  checkVoice(interaction);
  try {
    await interaction.client.musicManager.previous(interaction.guildId);
    await interaction.reply('⏮️ Повернення до попереднього треку');
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /pause ────────────────────────────────────────────────────────────────────
async function pause(interaction) {
  checkVoice(interaction);
  try {
    const isPlaying = interaction.client.musicManager.togglePause(interaction.guildId);
    await interaction.reply(isPlaying ? '▶️ Відтворення продовжено' : '⏸️ Пауза');
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /stop ─────────────────────────────────────────────────────────────────────
async function stop(interaction) {
  checkVoice(interaction);
  interaction.client.musicManager.stop(interaction.guildId);
  await interaction.reply('⏹️ Відтворення зупинено, черга очищена');
}

// ── /queue ────────────────────────────────────────────────────────────────────
async function queue(interaction) {
  const manager = interaction.client.musicManager;
  const q = manager.getQueue(interaction.guildId);
  const page = (interaction.options.getInteger('page') || 1) - 1;
  const perPage = 10;

  if (!q.tracks.length) {
    return interaction.reply({ content: '📭 Черга порожня!', ephemeral: true });
  }

  const pages = Math.ceil(q.tracks.length / perPage);
  const start = page * perPage;
  const slice = q.tracks.slice(start, start + perPage);

  const list = slice.map((t, i) => {
    const idx = start + i;
    const current = idx === q.currentIndex ? '▶️ ' : `${idx + 1}. `;
    return `${current}**${t.title}** [${t.durationFormatted}]`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Черга відтворення')
    .setDescription(list)
    .setFooter({ text: `Сторінка ${page + 1}/${pages} • Всього ${q.tracks.length} треків` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('queue_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('queue_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId('btn_shuffle').setLabel('🔀 Перемішати').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_stop').setLabel('⏹️ Стоп').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ── /nowplaying ───────────────────────────────────────────────────────────────
async function nowplaying(interaction) {
  const manager = interaction.client.musicManager;
  const q = manager.getQueue(interaction.guildId);

  if (!q?.currentTrack) {
    return interaction.reply({ content: '🔇 Зараз нічого не грає', ephemeral: true });
  }

  const t = q.currentTrack;
  const loopEmoji = { none: '➡️', track: '🔂', queue: '🔁' }[q.loop];

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setAuthor({ name: '🎵 Зараз грає' })
    .setTitle(t.title)
    .setURL(t.url)
    .setThumbnail(t.thumbnail)
    .addFields(
      { name: '👤 Виконавець', value: t.author || '—', inline: true },
      { name: '⏱️ Тривалість', value: t.durationFormatted, inline: true },
      { name: '🔊 Гучність', value: `${Math.round(q.volume * 100)}%`, inline: true },
      { name: '🔁 Повтор', value: loopEmoji + ' ' + q.loop, inline: true },
      { name: '🤖 Autoplay', value: q.autoplay ? '✅' : '❌', inline: true },
      { name: '📋 Черга', value: `${q.currentIndex + 1}/${q.tracks.length}`, inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_prev').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_pause').setLabel(q.isPlaying ? '⏸️' : '▶️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

// ── /volume ───────────────────────────────────────────────────────────────────
async function volume(interaction) {
  const level = interaction.options.getInteger('level');
  try {
    const actual = interaction.client.musicManager.setVolume(interaction.guildId, level);
    const bar = '█'.repeat(Math.floor(actual / 10)) + '░'.repeat(10 - Math.floor(actual / 10));
    await interaction.reply(`🔊 Гучність: \`${bar}\` **${actual}%**`);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /loop ─────────────────────────────────────────────────────────────────────
async function loop(interaction) {
  const mode = interaction.options.getString('mode');
  try {
    interaction.client.musicManager.setLoop(interaction.guildId, mode);
    const msgs = { none: '➡️ Повтор вимкнено', track: '🔂 Повтор треку увімкнено', queue: '🔁 Повтор черги увімкнено' };
    await interaction.reply(msgs[mode]);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /shuffle ──────────────────────────────────────────────────────────────────
async function shuffle(interaction) {
  try {
    interaction.client.musicManager.shuffle(interaction.guildId);
    await interaction.reply('🔀 Чергу перемішано!');
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /remove ───────────────────────────────────────────────────────────────────
async function remove(interaction) {
  const index = interaction.options.getInteger('index') - 1;
  try {
    const removed = interaction.client.musicManager.removeTrack(interaction.guildId, index);
    await interaction.reply(`🗑️ Видалено: **${removed.title}**`);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /jump ─────────────────────────────────────────────────────────────────────
async function jump(interaction) {
  const index = interaction.options.getInteger('index') - 1;
  try {
    await interaction.client.musicManager.jumpTo(interaction.guildId, index);
    const q = interaction.client.musicManager.getQueue(interaction.guildId);
    await interaction.reply(`⏩ Перехід до **${q.tracks[index].title}**`);
  } catch (e) {
    await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
}

// ── /search ───────────────────────────────────────────────────────────────────
async function search(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const query = interaction.options.getString('query');
  
  try {
    const results = await interaction.client.musicManager.searchTrack(query);
    if (!results.length) return interaction.editReply('❌ Нічого не знайдено');

    const options = results.slice(0, 5).map((t, i) => ({
      label: t.title.slice(0, 100),
      description: `${t.author || '—'} • ${t.durationFormatted}`,
      value: t.url,
      emoji: ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'][i],
    }));

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('search_select')
        .setPlaceholder('Обери трек для відтворення...')
        .addOptions(options)
    );

    await interaction.editReply({
      content: `🔍 Результати для: **${query}**`,
      components: [row],
    });
  } catch (e) {
    await interaction.editReply(`❌ ${e.message}`);
  }
}

// ── /playfile ─────────────────────────────────────────────────────────────────
async function playfile(interaction) {
  const voiceChannel = await checkVoiceAsync(interaction);
  if (!voiceChannel) return;

  await interaction.deferReply();
  const filePath = interaction.options.getString('path');
  const fs = require('fs');

  if (!fs.existsSync(filePath)) {
    return interaction.editReply('❌ Файл не знайдено! Перевір шлях.\nПриклад: `C:/music/song.mp3`');
  }

  const allowed = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma'];
  const ext = require('path').extname(filePath).toLowerCase();
  if (!allowed.includes(ext)) {
    return interaction.editReply(`❌ Непідтримуваний формат \`${ext}\`\nПідтримуються: ${allowed.join(', ')}`);
  }

  const manager = interaction.client.musicManager;
  try {
    const tracks = await manager.addTrack(interaction.guildId, filePath, interaction.user.username);
    const queue  = manager.getQueue(interaction.guildId);
    if (!queue.isPlaying) {
      await manager.play(interaction.guildId, voiceChannel, interaction.channel);
    }
    const embed = new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('➕ Локальний файл додано')
      .setDescription(`**${tracks[0].title}**`)
      .addFields(
        { name: '📁 Формат', value: ext.toUpperCase().replace('.',''), inline: true },
        { name: '🎧 Запитав', value: interaction.user.username, inline: true },
        { name: '📋 Позиція', value: `#${queue.tracks.length}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    await interaction.editReply(`❌ Помилка: ${e.message}`);
  }
}

// ── /autoplay ─────────────────────────────────────────────────────────────────
async function autoplay(interaction) {
  const enabled = interaction.client.musicManager.toggleAutoplay(interaction.guildId);
  await interaction.reply(enabled
    ? '🤖 Autoplay увімкнено — буду додавати схожі треки!'
    : '🤖 Autoplay вимкнено'
  );
}

// ── /webpanel ─────────────────────────────────────────────────────────────────
async function webpanel(interaction) {
  const port = process.env.WEB_PORT || 3000;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌐 Веб-панель керування')
    .setDescription(`Відкрий веб-панель для зручного керування музикою!\n\n🔗 **http://localhost:${port}**\n\n> Якщо бот на сервері, замініть \`localhost\` на IP сервера`)
    .addFields({ name: '🎵 Можливості панелі', value: '• Черга треків\n• Пошук\n• Керування плеєром\n• Гучність\n• Режими повтору' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { play, skip, previous, pause, stop, queue, nowplaying, volume, loop, shuffle, remove, jump, search, autoplay, webpanel, playfile, setchannel };

async function setchannel(interaction) {
  const manager = interaction.client.musicManager;
  const guildId = interaction.guildId;
  const q = manager.getQueue(guildId);

  // Встановлюємо поточний канал як фіксований
  q.textChannel = interaction.channel;
  q.fixedTextChannel = true;

  await interaction.reply({
    content: `✅ Тепер всі повідомлення бота будуть надходити в цей канал: ${interaction.channel}`,
    ephemeral: false,
  });
}
