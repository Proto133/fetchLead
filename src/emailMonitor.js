import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import { logger } from './logger.js';
import { config } from './config.js';

export class EmailMonitor {
  constructor(discordClient) {
    this.discordClient = discordClient;
    this.imap = new Imap(config.email);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.imap.on('ready', () => this.onReady());
    this.imap.on('error', (err) => this.onError(err));
    this.imap.on('end', () => this.onEnd());
  }

  start() {
    logger.info('Starting email monitor...');
    this.imap.connect();
  }

  onReady() {
    logger.info('IMAP connection established');
    this.openMailbox();
  }

  onError(err) {
    logger.error('IMAP error:', err);
    setTimeout(() => {
      logger.info('Attempting to reconnect...');
      this.start();
    }, 60000); // Retry after 1 minute
  }

  onEnd() {
    logger.info('IMAP connection ended');
  }

  openMailbox() {
    this.imap.openBox(config.email.folder, false, (err, box) => {
      if (err) {
        logger.error('Error opening mailbox:', err);
        return;
      }

      logger.info(`Monitoring ${config.email.folder} for new emails`);
      this.monitorEmails(box);
    });
  }

  monitorEmails(box) {
    this.imap.on('mail', (numNew) => {
      logger.info(`${numNew} new emails received`);
      this.fetchNewEmails(box);
    });
  }

  async fetchNewEmails(box) {
    const fetch = this.imap.seq.fetch(`${box.messages.total}:*`, {
      bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)', 'TEXT'],
      struct: true
    });

    fetch.on('message', (msg) => {
      const parser = new simpleParser();
      
      msg.on('body', (stream) => {
        stream.pipe(parser);
      });

      parser.on('end', async (parsedEmail) => {
        try {
          await this.sendToDiscord(parsedEmail);
        } catch (error) {
          logger.error('Error sending to Discord:', error);
        }
      });
    });

    fetch.on('error', (err) => {
      logger.error('Fetch error:', err);
    });
  }

  async sendToDiscord(email) {
    const channel = this.discordClient.channels.cache.get(config.discord.channelId);
    if (!channel) {
      logger.error('Discord channel not found');
      return;
    }

    const embed = {
      color: 0x0099ff,
      title: email.subject || 'No Subject',
      description: this.truncateText(email.text, 4096),
      fields: [
        {
          name: 'From',
          value: email.from.text,
          inline: true
        },
        {
          name: 'Date',
          value: email.date.toLocaleString(),
          inline: true
        }
      ],
      footer: {
        text: 'Email Monitor Bot'
      },
      timestamp: email.date
    };

    if (email.attachments.length > 0) {
      embed.fields.push({
        name: 'Attachments',
        value: email.attachments.map(att => att.filename).join('\n')
      });
    }

    await channel.send({ embeds: [embed] });
    logger.info(`Sent email "${email.subject}" to Discord`);
  }

  truncateText(text, maxLength) {
    if (!text) return 'No content';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }
}