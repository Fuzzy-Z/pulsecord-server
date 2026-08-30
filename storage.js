import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'pulsecord-db.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[Storage] Could not create data directory:', err.message);
  }
}

export class StorageManager {
  constructor() {
    this.redisClient = null;
    this.useRedis = false;
    this.initRedis();
  }

  async initRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        console.log(`[Storage] REDIS_URL detected. Attempting to connect...`);
        const { createClient } = await import('redis');
        this.redisClient = createClient({ url: redisUrl });
        this.redisClient.on('error', (err) => console.warn('[Redis Error]', err.message));
        await this.redisClient.connect();
        this.useRedis = true;
        console.log('[Storage] Connected to Redis successfully!');
      } catch (e) {
        console.warn('[Storage] Redis connection failed, falling back to local JSON database:', e.message);
        this.useRedis = false;
      }
    }
  }

  async loadInitialData(defaultServers, defaultHistory) {
    let users = [];
    let servers = defaultServers;
    let messageHistory = defaultHistory;

    if (this.useRedis && this.redisClient) {
      try {
        const rawUsers = await this.redisClient.get('pulsecord:users');
        const rawServers = await this.redisClient.get('pulsecord:servers');
        const rawHistory = await this.redisClient.get('pulsecord:history');

        if (rawUsers) users = JSON.parse(rawUsers);
        if (rawServers) servers = JSON.parse(rawServers);
        if (rawHistory) messageHistory = new Map(Object.entries(JSON.parse(rawHistory)));

        return { users, servers, messageHistory };
      } catch (err) {
        console.warn('[Storage] Error loading from Redis:', err.message);
      }
    }

    // Local JSON DB
    if (fs.existsSync(DB_FILE)) {
      try {
        const content = fs.readFileSync(DB_FILE, 'utf-8');
        const data = JSON.parse(content);
        if (data.users && Array.isArray(data.users)) users = data.users;
        if (data.servers && data.servers.length > 0) servers = data.servers;
        if (data.messageHistory) messageHistory = new Map(Object.entries(data.messageHistory));
      } catch (e) {
        console.warn('[Storage] Failed to read pulsecord-db.json, using defaults:', e.message);
      }
    }

    return {
      users,
      servers,
      messageHistory
    };
  }

  async saveData(users, servers, messageHistoryMap) {
    const historyObj = Object.fromEntries(messageHistoryMap);

    if (this.useRedis && this.redisClient) {
      try {
        await this.redisClient.set('pulsecord:users', JSON.stringify(users));
        await this.redisClient.set('pulsecord:servers', JSON.stringify(servers));
        await this.redisClient.set('pulsecord:history', JSON.stringify(historyObj));
        return;
      } catch (err) {
        console.warn('[Storage] Failed saving to Redis:', err.message);
      }
    }

    // Save to local file
    try {
      const payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        users,
        servers,
        messageHistory: historyObj
      }, null, 2);

      fs.writeFileSync(DB_FILE, payload, 'utf-8');
    } catch (err) {
      console.warn('[Storage] Failed saving to JSON file:', err.message);
    }
  }
}
