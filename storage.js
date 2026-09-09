import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');

export class StorageManager {
  constructor() {
    this.redisClient = null;
    this.useRedis = false;
    this.prisma = null;
  }

  async initStorage() {
    try {
      this.prisma = new PrismaClient();
      await this.prisma.$connect();
      console.log('[Storage] Connected to PostgreSQL via Prisma!');
    } catch (e) {
      console.error('[Storage] Prisma PostgreSQL connection failed:', e.message);
    }

    // 2. Check standard REDIS_URL (e.g. rediss://...) for caching (optional)
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
      } catch (e) {
        console.error('[Storage] Redis connection failed:', e.message);
        this.useRedis = false;
      }
    }
  }

  async loadInitialData(defaultServers, defaultHistory) {
    let users = [];
    let servers = defaultServers;
    let messageHistory = defaultHistory;
    let verificationRequests = [];

    if (!this.prisma) {
      console.warn('[Storage] Prisma not initialized, returning defaults.');
      return { users, servers, messageHistory, verificationRequests };
    }

    try {
      // Load Users
      const pgUsers = await this.prisma.user.findMany({
        include: { badges: true }
      });
      users = pgUsers.map(u => ({
        ...u,
        badges: u.badges || []
      }));

      // Load Servers
      const pgServers = await this.prisma.server.findMany({
        include: {
          channels: true,
          roles: true,
          members: true
        }
      });

      if (pgServers.length > 0) {
        servers = pgServers.map(s => {
          const srv = {
            ...s,
            roles: s.roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '{}') })),
            memberIds: s.members.map(m => m.userId),
            memberRoles: {}
          };
          s.members.forEach(m => {
            srv.memberRoles[m.userId] = m.roleId;
          });
          return srv;
        });
      }

      // Load Messages
      const pgMessages = await this.prisma.message.findMany({
        include: {
          attachments: true,
          author: true
        },
        orderBy: { timestamp: 'asc' }
      });

      if (pgMessages.length > 0) {
        const historyMap = new Map();
        for (const msg of pgMessages) {
          if (!historyMap.has(msg.channelId)) {
            historyMap.set(msg.channelId, []);
          }
          
          historyMap.get(msg.channelId).push({
            ...msg,
            author: msg.author ? {
              id: msg.author.id,
              username: msg.author.username,
              avatar: msg.author.avatar,
              isBot: msg.author.isGoogleAuth // Rough approximation for bots in legacy data
            } : { id: msg.authorId, username: 'Unknown' }
          });
        }
        messageHistory = historyMap;
      }

      // Load Verifications
      verificationRequests = await this.prisma.verificationRequest.findMany();

      console.log(`[Storage] Loaded data from PostgreSQL (${users.length} users, ${servers.length} servers, ${messageHistory.size} channels)`);
    } catch (err) {
      console.error('[Storage] Error loading from PostgreSQL:', err.message);
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

    // 1. Sync to Postgres (Prisma)
    if (this.prisma) {
      try {
        // In a real production app with Prisma, we would only update changed records.
        // For this hybrid transition, we do bulk upserts on users/servers to maintain the legacy API.
        
        // Sync Users
        for (const u of safeUsers) {
          await this.prisma.user.upsert({
            where: { id: u.id },
            update: {
              status: u.status,
              customStatus: typeof u.customStatus === 'object' ? JSON.stringify(u.customStatus) : (u.customStatus || null),
              gameStatus: u.gameStatus || null,
              isVerified: u.isVerified || false
            },
            create: {
              id: u.id,
              email: u.email,
              username: u.username,
              password: u.password,
              avatar: u.avatar || null,
              avatarColor: u.avatarColor || null
            }
          });
        }
        
        // Sync Messages (Since memory map grows, we only insert what's missing, but UPSERT handles it cleanly)
        for (const [channelId, messages] of messageHistoryMap.entries()) {
          for (const msg of messages) {
            await this.prisma.message.upsert({
              where: { id: msg.id },
              update: { pinned: msg.pinned || msg.isPinned || false },
              create: {
                id: msg.id,
                channelId: channelId,
                authorId: msg.author?.id || msg.authorId,
                content: msg.content || '',
                timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
                pinned: msg.pinned || msg.isPinned || false
              }
            });
          }
        }
      } catch (err) {
        console.error('[Storage] Failed to persist data to PostgreSQL:', err.message);
      }
    }

    // 2. Also replicate to Redis if available for caching
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
