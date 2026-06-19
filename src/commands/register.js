const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('▶️ Відтворити музику').addStringOption(o=>o.setName('query').setDescription('Назва або URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('⏭️ Пропустити трек').addIntegerOption(o=>o.setName('count').setDescription('Кількість').setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName('previous').setDescription('⏮️ Попередній трек'),
  new SlashCommandBuilder().setName('pause').setDescription('⏸️ Пауза / Продовжити'),
  new SlashCommandBuilder().setName('stop').setDescription('⏹️ Зупинити і очистити'),
  new SlashCommandBuilder().setName('queue').setDescription('📋 Черга').addIntegerOption(o=>o.setName('page').setDescription('Сторінка').setMinValue(1)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('🎵 Поточний трек'),
  new SlashCommandBuilder().setName('volume').setDescription('🔊 Гучність 0-100').addIntegerOption(o=>o.setName('level').setDescription('Рівень').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('loop').setDescription('🔁 Повторення').addStringOption(o=>o.setName('mode').setDescription('Режим').setRequired(true).addChoices({name:'❌ Вимк',value:'none'},{name:'🔂 Трек',value:'track'},{name:'🔁 Черга',value:'queue'})),
  new SlashCommandBuilder().setName('shuffle').setDescription('🔀 Перемішати'),
  new SlashCommandBuilder().setName('remove').setDescription('🗑️ Видалити трек').addIntegerOption(o=>o.setName('index').setDescription('Номер').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('jump').setDescription('⏩ Перейти до треку').addIntegerOption(o=>o.setName('index').setDescription('Номер').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('search').setDescription('🔍 Пошук з вибором').addStringOption(o=>o.setName('query').setDescription('Запит').setRequired(true)),
  new SlashCommandBuilder().setName('autoplay').setDescription('🤖 Авто-доповнення'),
  new SlashCommandBuilder().setName('webpanel').setDescription('🌐 Веб-панель'),
  new SlashCommandBuilder().setName('setchannel').setDescription('📌 Встановити канал для повідомлень бота'),
];

async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📝 Реєстрація команд...');
    const body = commands.map(c => c.toJSON());
    // Завжди реєструємо глобально — працює на всіх серверах
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body });
    console.log('✅ Команди зареєстровано глобально!');
    const handlers = require('./handlers');
    for (const [name, fn] of Object.entries(handlers)) client.commands.set(name, fn);
  } catch (e) {
    console.error('❌ Реєстрація:', e.message);
  }
}

module.exports = { registerCommands };
