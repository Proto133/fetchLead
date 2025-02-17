import Imap from "node-imap";
import { simpleParser } from "mailparser";
import { logger } from "./logger.js";
import { config } from "./config.js";

export class EmailMonitor {
  constructor(discordClient) {
    this.discordClient = discordClient;
    this.imap = new Imap(config.email);
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.imap.on("ready", () => this.onReady());
    this.imap.on("error", (err) => this.onError(err));
    this.imap.on("end", () => this.onEnd());
  }

  start() {
    logger.info("Starting email monitor...");
    this.imap.connect();
  }

  onReady() {
    logger.info("IMAP connection established");
    this.openMailbox();
  }

  onError(err) {
    logger.error("IMAP error:", err);
    setTimeout(() => {
      logger.info("Attempting to reconnect...");
      this.start();
    }, 60000); // Retry after 1 minute
  }

  onEnd() {
    logger.info("IMAP connection ended");
  }

  openMailbox() {
    this.imap.openBox(config.email.folder, false, (err, box) => {
      if (err) {
        logger.error("Error opening mailbox:", err);
        return;
      }

      logger.info(`Monitoring ${config.email.folder} for new emails`);
      this.monitorEmails(box);
    });
  }

  monitorEmails(box) {
    this.imap.on("mail", (numNew) => {
      logger.info(`${numNew} new emails received`);
      this.fetchNewEmails(box);
    });
  }

  async fetchNewEmails(box) {
    const fetch = this.imap.seq.fetch(`${box.messages.total}:*`, {
      bodies: ["HEADER.FIELDS (FROM SUBJECT DATE)", "TEXT"],
      struct: true,
    });

    fetch.on("message", (msg) => {
      let chunks = [];

      msg.on("body", (stream) => {
        stream.on("data", (chunk) => {
          chunks.push(chunk);
        });
      });

      msg.on("end", async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const parsedEmail = await simpleParser(buffer);
          if (this.isLeadEmail(parsedEmail)) {
            await this.sendToDiscord(parsedEmail);
          }
        } catch (error) {
          logger.error("Error processing email:", error);
        }
      });
    });

    fetch.on("error", (err) => {
      logger.error("Fetch error:", err);
    });
  }

  isLeadEmail(email) {
    const from = email.from.text.toLowerCase();
    const subject = email.subject.toLowerCase();

    return (
      from.includes("facetinquiries@gmail.com") ||
      from.includes("angi.com") ||
      from.includes("homeadvisor.com") ||
      subject.includes("new lead") ||
      subject.includes("new web inquiry") ||
      subject.includes("service request")
    );
  }

  extractLeadInfo(emailText) {
    const info = {
      name: "",
      phone: "",
      email: "",
      address: "",
      description: "",
    };

    // Check if this is a Facet Inquiries email
    if (emailText.includes("New Inquiry from Facet website:")) {
      // Extract using Facet's HTML structure
      const nameMatch = emailText.match(
        /<strong>Name:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/
      );
      const phoneMatch = emailText.match(
        /<strong>Phone:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/
      );
      const emailMatch = emailText.match(
        /<strong>Email:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/
      );
      const inquiryMatch = emailText.match(
        /<strong>Inquiry:<\/strong>\s*<span[^>]*>([^<]+)<\/span>/
      );
      const anchorMatch = emailText.match(/<a[^>]*>([^<]+)<\/a>/);

      if (nameMatch) info.name = nameMatch[1].trim();
      if (phoneMatch) info.phone = phoneMatch[1].trim();
      if (emailMatch) info.email = emailMatch[1].trim();
      if (inquiryMatch) info.description = inquiryMatch[1].trim();
      if (anchorMatch && !emailMatch) info.email = anchorMatch[1].trim();

      return info;
    }
    // Check if this is an Angi/HomeAdvisor lead
    if (emailText.includes("Customer Information")) {
      // Extract name - specific to Angi format
      const nameMatch = emailText.match(/font-weight: 700[^>]*>([^<]+)<\/td>/);
      if (nameMatch) {
        info.name = nameMatch[1].trim();
      }

      // Extract phone with extension
      const phoneMatch = emailText.match(
        /href="tel:\/\/([^"]+)"[^>]*>([^<]+)<\/a>([^<]*)/
      );
      if (phoneMatch) {
        let phone = phoneMatch[2];
        // If there's an extension, add it
        const extension = phoneMatch[3]?.trim();
        if (extension && extension.toLowerCase().includes("ext")) {
          phone += ` ${extension}`;
        }
        info.phone = phone;
      }

      // Extract email - specific to Angi format
      const emailMatch = emailText.match(
        /href="mailto:([^"]+)"[^>]*>([^<]+)<\/a>/
      );
      if (emailMatch) {
        info.email = emailMatch[1].trim();
      }

      // Extract address
      const addressMatch = emailText.match(
        /maps\.google\.com\?q=([^"]+)"[^>]*>([^<]+)<\/a>/
      );
      if (addressMatch) {
        info.address = addressMatch[2].trim();
      }

      // Extract project details
      const sections = [];

      // Get service type
      const serviceMatch = emailText.match(
        /font-weight: 700[^>]*>([^<]+)<\/p>/
      );
      if (serviceMatch) {
        sections.push(`Service: ${serviceMatch[1].trim()}`);
      }

      // Get comments
      const commentsMatch = emailText.match(
        /Comments:<\/b><\/p>\s*<p[^>]*>([^<]+)<\/p>/
      );
      if (commentsMatch) {
        sections.push(`Comments: ${commentsMatch[1].trim()}`);
      }

      // Get additional details
      const detailsPattern = /<p[^>]*>([^:]+):<\/p><p[^>]*>([^<]+)<\/p>/g;
      let match;
      while ((match = detailsPattern.exec(emailText)) !== null) {
        sections.push(`${match[1].trim()}: ${match[2].trim()}`);
      }

      info.description = sections.join("\n");

      return info;
    }

    // Fallback to original parsing for other email types
    const phoneRegex = /(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
    const phones = emailText.match(phoneRegex);
    if (phones) {
      info.phone = phones[0];
    }

    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/g;
    const emails = emailText.match(emailRegex);
    if (emails) {
      const customerEmail = emails.find(
        (email) =>
          !email.toLowerCase().includes("facetinquiries@gmail.com") &&
          !email.toLowerCase().includes("homeadvisor.com") &&
          !email.toLowerCase().includes("angi.com")
      );
      info.email = customerEmail || emails[0];
    }

    const namePatterns = [
      /Customer Name:[\s\n]+([^\n]+)/i,
      /Name:[\s\n]+([^\n]+)/i,
      /Customer:[\s\n]+([^\n]+)/i,
    ];

    for (const pattern of namePatterns) {
      const match = emailText.match(pattern);
      if (match) {
        info.name = match[1].trim();
        break;
      }
    }

    const descriptionPatterns = [
      /Project Description:[\s\n]+([^\n]+)/i,
      /Description:[\s\n]+([^\n]+)/i,
      /Details:[\s\n]+([^\n]+)/i,
    ];

    for (const pattern of descriptionPatterns) {
      const match = emailText.match(pattern);
      if (match) {
        info.description = match[1].trim();
        break;
      }
    }

    return info;
  }

  async sendToDiscord(email) {
    const channel = this.discordClient.channels.cache.get(
      config.discord.channelId
    );
    if (!channel) {
      logger.error("Discord channel not found");
      return;
    }

    const leadInfo = this.extractLeadInfo(email.text);
    let source = "Other";
    if (email.from.text.toLowerCase().includes("angi.com")) {
      source = "Angi";
    } else if (email.from.text.toLowerCase().includes("homeadvisor.com")) {
      source = "HomeAdvisor";
    } else if (
      email.from.text.toLowerCase().includes("facetinquiries@gmail.com")
    ) {
      source = "Facet Inquiries";
    }

    const embed = {
      color:
        source === "Angi"
          ? 0x00ff00
          : source === "HomeAdvisor"
          ? 0x0099ff
          : 0xff9900,
      title: `New Lead from ${source}`,
      fields: [
        {
          name: "👤 Customer Name",
          value: leadInfo.name || "Not provided",
          inline: true,
        },
        {
          name: "📞 Phone",
          value: leadInfo.phone || "Not provided",
          inline: true,
        },
        {
          name: "📧 Email",
          value: leadInfo.email || "Not provided",
          inline: true,
        },
      ],
      footer: {
        text: `Received: ${email.date.toLocaleString()}`,
      },
    };

    if (leadInfo.address) {
      embed.fields.push({
        name: "📍 Address",
        value: leadInfo.address,
        inline: false,
      });
    }

    if (leadInfo.description) {
      embed.fields.push({
        name: "📝 Project Details",
        value: this.truncateText(leadInfo.description, 1024),
      });
    }

    await channel.send({ embeds: [embed] });
    logger.info(`Sent ${source} lead to Discord`);
  }

  truncateText(text, maxLength) {
    if (!text) return "No content";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }
}
