// Діагностичний скрипт для перевірки voice connection
// Запуск: node voice-debug.js
// Потребує .env з DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DEBUG_GUILD_ID || process.argv[2];
const CHANNEL_ID = process.env.DEBUG_VOICE_CHANNEL_ID || process.argv[3];

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('Використання: node voice-debug.js <GUILD_ID> <VOICE_CHANNEL_ID>');
  console.error('Або задай DEBUG_GUILD_ID / DEBUG_VOICE_CHANNEL_ID в .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async () => {
  console.log('✅ Бот залогінений як', client.user.tag);

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(CHANNEL_ID);
  console.log('🎯 Канал:', channel.name, '| Тип:', channel.type);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  // Логуємо ВСІ зміни стану з'єднання
  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔌 Connection: ${oldState.status} -> ${newState.status}`);

    // Якщо є networking об'єкт - підписуємось на його події теж
    if (newState.networking && newState.status !== oldState.status) {
      newState.networking.on('stateChange', (oldNet, newNet) => {
        console.log(`   🌐 Networking: ${oldNet.code ?? oldNet.status} -> ${newNet.code ?? newNet.status}`);
        if (newNet.udp) {
          console.log('   📡 UDP socket створено');
        }
        if (newNet.connectionData) {
          console.log('   🔑 Connection data отримано (encryption ready)');
        }
        // Логуємо WS об'єкт, якщо він є
        if (newNet.ws) {
          newNet.ws.on('close', (...args) => {
            console.log(`   ❗ Voice WS closed, args:`, args.map(a => {
              if (Buffer.isBuffer(a)) return a.toString();
              if (typeof a === 'object') return JSON.stringify(a);
              return a;
            }));
          });
          newNet.ws.on('error', err => {
            console.log(`   ❗ Voice WS error:`, err.message);
          });
        }
        if (newNet.code === 6) {
          console.log('   ❗ Closed full state dump:', JSON.stringify(newNet, (k,v) => {
            if (k === 'ws' || k === 'udp') return '[object]';
            if (Buffer.isBuffer(v)) return v.toString();
            return v;
          }, 2));
        }
      });

      // Підписуємось одразу на ws поточного стану, якщо є
      if (newState.networking.state?.ws) {
        newState.networking.state.ws.on('close', (...args) => {
          console.log(`   ❗ [initial] Voice WS closed, args:`, args.map(a => {
            if (Buffer.isBuffer(a)) return a.toString();
            if (typeof a === 'object') return JSON.stringify(a);
            return a;
          }));
        });
      }

      if (newState.networking.state) {
        console.log('   📊 Поточний networking state code:', newState.networking.state.code);
      }
    }
  });

  console.log('⏳ Очікуємо стан Ready (60 секунд)...');

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    console.log('🎉🎉🎉 ГОТОВО! Connection стало Ready!');
  } catch (e) {
    console.error('❌ ТАЙМАУТ:', e.message);
    console.log('📋 Останній відомий стан:', connection.state.status);
    if (connection.state.networking) {
      console.log('📋 Networking state:', JSON.stringify(connection.state.networking.state, (k,v) => k === 'udp' || k === 'ws' ? '[object]' : v, 2));
    }
  }

  setTimeout(() => process.exit(0), 3000);
});

client.on('error', e => console.error('Client error:', e));
client.login(TOKEN);
