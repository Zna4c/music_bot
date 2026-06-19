require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { registerCommands } = require('./commands/register');
const { setupEventHandlers } = require('./events');
// const { startWebServer } = require('../web/server'); // Web panel temporarily disabled
const MusicManager = require('./music/MusicManager');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.musicManager = new MusicManager(client);
client.commands = new Collection();

(async () => {
  try {
    await registerCommands(client);
    setupEventHandlers(client);
    await client.login(process.env.DISCORD_TOKEN);

    // Чекаємо поки бот повністю завантажить всі сервери
    await new Promise(resolve => client.once('clientReady', resolve));

    // Примусово завантажуємо всі сервери в кеш
    await client.guilds.fetch();
    console.log(`✅ Завантажено серверів: ${client.guilds.cache.size}`);

    console.log('🎵 Discord Music Bot запущено!');

    // Web panel temporarily disabled to avoid healthcheck issues
    // const webServer = startWebServer(client);
    // const port = process.env.WEB_PORT || 3000;
    // webServer.listen(port, () => {
    //   console.log(`🌐 Веб-панель: http://localhost:${port}`);
    // });
  } catch (error) {
    console.error('❌ Помилка запуску:', error.message);
    process.exit(1);
  }
})();

process.on('unhandledRejection', err => {
  console.error('Помилка:', err?.message || err);
});
