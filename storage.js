import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');
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
    this.upstashClient = null;
    this.useRedis = false;
  }

  async initStorage() {
    // 1. Check Upstash REST credentials (UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN)
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (upstashUrl && upstashToken) {
      try {
        console.log('[Storage] UPSTASH_REDIS credentials detected. Initializing Upstash client...');
        const { Redis } = await import('@upstash/redis');
        this.upstashClient = new Redis({
          url: upstashUrl,
          token: upstashToken
        });
        await this.upstashClient.ping();
        this.useRedis = true;
        console.log('[Storage] Connected to Upstash Redis via REST successfully!');
        return;
      } catch (e) {
        console.warn('[Storage] Upstash REST connection failed, attempting REDIS_URL fallback:', e.message);
      }
    }

    // 2. Check standard REDIS_URL (e.g. rediss://...)
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
        return;
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

    if (this.upstashClient) {
      try {
        const rawUsers = await this.upstashClient.get('pulsecord:users');
        const rawServers = await this.upstashClient.get('pulsecord:servers');
        const rawHistory = await this.upstashClient.get('pulsecord:history');

        if (rawUsers) users = typeof rawUsers === 'string' ? JSON.parse(rawUsers) : rawUsers;
        if (rawServers) servers = typeof rawServers === 'string' ? JSON.parse(rawServers) : rawServers;
        if (rawHistory) {
          const histObj = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : rawHistory;
          messageHistory = new Map(Object.entries(histObj));
        }

        console.log(`[Storage] Loaded data from Upstash Redis (${users.length} users, ${servers.length} servers)`);
        return { users, servers, messageHistory };
      } catch (err) {
        console.warn('[Storage] Error loading from Upstash Redis:', err.message);
      }
    }

    if (this.useRedis && this.redisClient) {
      try {
        const rawUsers = await this.redisClient.get('pulsecord:users');
        const rawServers = await this.redisClient.get('pulsecord:servers');
        const rawHistory = await this.redisClient.get('pulsecord:history');

        if (rawUsers) users = JSON.parse(rawUsers);
        if (rawServers) servers = JSON.parse(rawServers);
        if (rawHistory) messageHistory = new Map(Object.entries(JSON.parse(rawHistory)));

        console.log(`[Storage] Loaded data from Redis (${users.length} users, ${servers.length} servers)`);
        return { users, servers, messageHistory };
      } catch (err) {
        console.warn('[Storage] Error loading from Redis:', err.message);
      }
    }

    // Local JSON DB fallback
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

    if (this.upstashClient) {
      try {
        await this.upstashClient.set('pulsecord:users', users);
        await this.upstashClient.set('pulsecord:servers', servers);
        await this.upstashClient.set('pulsecord:history', historyObj);
        return;
      } catch (err) {
        console.warn('[Storage] Failed saving to Upstash Redis:', err.message);
      }
    }

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
