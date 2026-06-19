function setupEventHandlers(client) {
  // ── Ready ──────────────────────────────────────────────────────────────────
  client.once('clientReady', () => {
    console.log(`✅ Увійшов як ${client.user.tag}`);
    client.user.setActivity('🎵 музику | /play', { type: 2 }); // LISTENING
  });

  // ── Slash команди ──────────────────────────────────────────────────────────
  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const handler = client.commands.get(interaction.commandName);
      if (!handler) return;
      try {
        // Якщо є фіксований канал — оновлюємо textChannel тільки якщо команда /setchannel
        // або якщо фіксованого каналу ще немає
        const q = client.musicManager.getQueue(interaction.guildId);
        if (!q.fixedTextChannel) {
          q.textChannel = interaction.channel;
        }
        await handler(interaction);
      } catch (error) {
        console.error(`Помилка команди ${interaction.commandName}:`, error);
        const msg = { content: '❌ Сталася помилка!', ephemeral: true };
        if (interaction.deferred) await interaction.editReply(msg);
        else await interaction.reply(msg).catch(() => {});
      }
      return;
    }

    // ── Кнопки ──────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const manager = client.musicManager;
      const guildId = interaction.guildId;

      try {
        switch (interaction.customId) {
          case 'btn_pause':
            manager.togglePause(guildId);
            await interaction.reply({ content: '⏸️ Пауза/Відтворення', ephemeral: true });
            break;
          case 'btn_skip':
            await manager.skip(guildId);
            await interaction.reply({ content: '⏭️ Пропущено', ephemeral: true });
            break;
          case 'btn_prev':
            await manager.previous(guildId);
            await interaction.reply({ content: '⏮️ Попередній', ephemeral: true });
            break;
          case 'btn_stop':
            manager.stop(guildId);
            await interaction.reply({ content: '⏹️ Зупинено', ephemeral: true });
            break;
          case 'btn_shuffle':
            manager.shuffle(guildId);
            await interaction.reply({ content: '🔀 Перемішано!', ephemeral: true });
            break;
          case 'queue_prev':
          case 'queue_next':
            await interaction.reply({ content: 'Використай /queue з параметром page', ephemeral: true });
            break;
        }
      } catch (e) {
        await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
      }
      return;
    }

    // ── Select Menu (пошук) ──────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'search_select') {
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: '❌ Зайди в голосовий канал!', ephemeral: true });
      }

      await interaction.deferUpdate();
      const url = interaction.values[0];
      const manager = client.musicManager;

      try {
        const tracks = await manager.addTrack(guildId, url, interaction.user.username);
        const q = manager.getQueue(guildId);
        if (!q.isPlaying) {
          await manager.play(guildId, voiceChannel, interaction.channel);
        }
        await interaction.followUp({
          content: `✅ Додано: **${tracks[0].title}**`,
          ephemeral: true,
        });
      } catch (e) {
        await interaction.followUp({ content: `❌ ${e.message}`, ephemeral: true });
      }
    }
  });

  // ── Голосові стани ─────────────────────────────────────────────────────────
  client.on('voiceStateUpdate', (oldState, newState) => {
    const manager = client.musicManager;
    const queue = manager.queues.get(oldState.guildId);
    if (!queue?.connection) return;

    // Якщо бот залишився сам у каналі — відключитись
    const channel = oldState.channel || newState.channel;
    if (!channel) return;

    const members = channel.members.filter(m => !m.user.bot);
    if (members.size === 0 && queue.voiceChannel?.id === channel.id) {
      setTimeout(() => {
        const q = manager.queues.get(oldState.guildId);
        if (!q) return;
        const ch = q.voiceChannel;
        const alone = ch?.members.filter(m => !m.user.bot).size === 0;
        if (alone) {
          if (q.textChannel) {
            q.textChannel.send('👋 Всі вийшли з каналу — відключаюсь').catch(() => {});
          }
          manager.stop(oldState.guildId);
        }
      }, 30_000); // 30 секунд таймаут
    }
  });
}

module.exports = { setupEventHandlers };
