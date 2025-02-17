import { Client, GatewayIntentBits } from 'discord.js';
import { EmailMonitor } from './emailMonitor.js';
import { config } from './config.js';
import { logger } from './logger.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

client.once('ready', () => {
  logger.info(`Logged in as ${client.user.tag}`);
  const emailMonitor = new EmailMonitor(client);
  emailMonitor.start();
});

client.on('error', (error) => {
  logger.error('Discord client error:', error);
});

client.login(config.discord.token).catch((error) => {
  logger.error('Failed to login to Discord:', error);
  process.exit(1);
});