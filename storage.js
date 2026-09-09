import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

export class StorageManager {
  constructor() {
    this.redisClient = null;
    this.upstashClient = null;
    this.useRedis = false;
  }

  async initStorage() {
    // Ensure local data directory exists for disk persistence
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (err) {
      console.error('[Storage] Error ensuring data directory exists:', err.message);
    }

    // 2. Check standard REDIS_URL (e.g. rediss://...)
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        console.log('[Storage] Connecting to standard Redis via REDIS_URL...');
        const { createClient } = await import('redis');
        this.redisClient = createClient({ url: redisUrl });
        this.redisClient.on('error', (err) => console.warn('[Redis Error]', err.message));
        await this.redisClient.connect();
        this.useRedis = true;
        console.log('[Storage] Connected to Redis successfully!');
        return;
      } catch (e) {
        console.error('[Storage] Redis connection failed:', e.message);
        this.useRedis = false;
      }
    }

    if (!this.useRedis) {
      console.log(`[Storage] Running with local disk persistence enabled at: ${DB_FILE}`);
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
        if (rawServers && (Array.isArray(rawServers) ? rawServers.length > 0 : Object.keys(rawServers).length > 0)) {
          servers = JSON.parse(rawServers);
        }
        if (rawHistory) messageHistory = new Map(Object.entries(JSON.parse(rawHistory)));

        console.log(`[Storage] Loaded data from Redis (${users.length} users, ${servers.length} servers)`);
        return { users, servers, messageHistory };
      } catch (err) {
        console.error('[Storage] Error loading from Redis:', err.message);
      }
    }

    let verificationRequests = [];

    // Disk persistence fallback (ideal for standalone VM without Redis, keeps pinned photos/videos)
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const diskDb = JSON.parse(raw);
        if (diskDb.users && Array.isArray(diskDb.users)) {
          users = diskDb.users;
        }
        if (diskDb.servers && Array.isArray(diskDb.servers) && diskDb.servers.length > 0) {
          servers = diskDb.servers;
        }
        if (diskDb.messageHistory && typeof diskDb.messageHistory === 'object') {
          messageHistory = new Map(Object.entries(diskDb.messageHistory));
        }
        if (diskDb.verificationRequests && Array.isArray(diskDb.verificationRequests)) {
          verificationRequests = diskDb.verificationRequests;
        }
        console.log(`[Storage] Loaded data from local disk database (${users.length} users, ${servers.length} servers, ${messageHistory.size} channels, ${verificationRequests.length} verifications)`);
      } catch (err) {
        console.error('[Storage] Error reading local disk database.json:', err.message);
      }
    }

    return {
      users,
      servers,
      messageHistory,
      verificationRequests
    };
  }

  async saveData(users, servers, messageHistoryMap, verificationRequests = []) {
    const historyObj = Object.fromEntries(messageHistoryMap);
    const bcrypt = await import('bcryptjs');

    // Cryptographically protect stored passwords using native bcrypt
    const safeUsers = (users || []).map((u) => {
      const copy = { ...u };
      if (copy.password && typeof copy.password === 'string' && !copy.password.startsWith('$2') && !copy.password.startsWith('scrypt$')) {
        try {
          copy.password = bcrypt.hashSync(copy.password, 10);
        } catch (e) {
          console.error('[Storage] Error hashing password for user:', copy.id, e.message);
        }
      }
      return copy;
    });

    // 1. Always save to local disk database file (persists pinned messages, photos, videos reliably)
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const dataPayload = JSON.stringify({
        users: safeUsers,
        servers,
        messageHistory: historyObj,
        verificationRequests,
        updatedAt: new Date().toISOString()
      });
      fs.writeFileSync(DB_FILE, dataPayload, 'utf-8');
    } catch (err) {
      console.error('[Storage] Failed to persist data to local disk:', err.message);
    }

    if (this.useRedis && this.redisClient) {
      try {
        await this.redisClient.set('pulsecord:users', JSON.stringify(safeUsers));
        await this.redisClient.set('pulsecord:servers', JSON.stringify(servers));
        await this.redisClient.set('pulsecord:history', JSON.stringify(historyObj));
      } catch (err) {
        console.error('[Storage] Failed saving to Redis:', err.message);
      }
    }
  }
}
