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
        console.log('[Storage] Connecting to Upstash Redis REST...');
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
        console.error('[Storage] Upstash REST connection failed:', e.message);
      }
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
      console.warn('[Storage] No active Redis credentials found. Running in-memory mode without local fallback.');
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
        if (rawServers && (Array.isArray(rawServers) ? rawServers.length > 0 : Object.keys(rawServers).length > 0)) {
          servers = typeof rawServers === 'string' ? JSON.parse(rawServers) : rawServers;
        }
        if (rawHistory) {
          const histObj = typeof rawHistory === 'string' ? JSON.parse(rawHistory) : rawHistory;
          messageHistory = new Map(Object.entries(histObj));
        }

        console.log(`[Storage] Loaded data from Upstash Redis (${users.length} users, ${servers.length} servers)`);
        return { users, servers, messageHistory };
      } catch (err) {
        console.error('[Storage] Error loading from Upstash Redis:', err.message);
      }
    }

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
        console.error('[Storage] Failed saving to Upstash Redis:', err.message);
      }
    }

    if (this.useRedis && this.redisClient) {
      try {
        await this.redisClient.set('pulsecord:users', JSON.stringify(users));
        await this.redisClient.set('pulsecord:servers', JSON.stringify(servers));
        await this.redisClient.set('pulsecord:history', JSON.stringify(historyObj));
        return;
      } catch (err) {
        console.error('[Storage] Failed saving to Redis:', err.message);
      }
    }
  }
}
