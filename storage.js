import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
      const { PrismaClient } = await import('@prisma/client');
      this.prisma = new PrismaClient();
      await this.prisma.$connect();
      console.log('[Storage] Connected to PostgreSQL via Prisma!');
    } catch (e) {
      console.warn('[Storage] Prisma PostgreSQL not available or connection failed:', e.message);
      this.prisma = null;
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
    let friendRequests = [];

    // Step 1: Always load from database.json (or backup) first as safe baseline
    const dbPath = path.join(DATA_DIR, 'database.json');
    const backupPath = path.join(DATA_DIR, 'database.backup.json');

    const tryReadFile = (filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          const raw = fs.readFileSync(filePath, 'utf8');
          if (raw && raw.trim().length > 0) {
            return JSON.parse(raw);
          }
        }
      } catch (e) {
        console.warn(`[Storage] Failed reading ${filePath}:`, e.message);
      }
      return null;
    };

    const diskData = tryReadFile(dbPath) || tryReadFile(backupPath);

    if (diskData) {
      if (Array.isArray(diskData.users) && diskData.users.length > 0) {
        users = diskData.users;
      }
      if (Array.isArray(diskData.servers) && diskData.servers.length > 0) {
        servers = diskData.servers;
      }
      if (diskData.messageHistory && typeof diskData.messageHistory === 'object') {
        messageHistory = new Map(Object.entries(diskData.messageHistory));
      }
      if (Array.isArray(diskData.verificationRequests)) {
        verificationRequests = diskData.verificationRequests;
      }
      if (Array.isArray(diskData.friendRequests)) {
        friendRequests = diskData.friendRequests;
      }
      console.log(`[Storage] Loaded snapshot from disk: ${users.length} users, ${servers.length} servers, ${messageHistory.size} channels`);
    }

    // Step 2: If Prisma is connected, load and merge from PostgreSQL
    if (this.prisma) {
      try {
        // Load Users
        const pgUsers = await this.prisma.user.findMany({
          include: { badges: true }
        });
        if (pgUsers.length > 0) {
          const userMap = new Map(users.map(u => [u.id, u]));
          for (const u of pgUsers) {
            const existing = userMap.get(u.id) || {};
            userMap.set(u.id, {
              ...existing,
              ...u,
              badges: u.badges?.length ? u.badges : (existing.badges || [])
            });
          }
          users = Array.from(userMap.values());
        }

        // Load Servers
        const pgServers = await this.prisma.server.findMany({
          include: {
            channels: true,
            roles: true,
            members: true
          }
        });

        if (pgServers.length > 0) {
          const serverMap = new Map(servers.map(s => [s.id, s]));
          for (const s of pgServers) {
            const existing = serverMap.get(s.id) || {};
            const srv = {
              ...existing,
              ...s,
              channels: s.channels?.length ? s.channels : (existing.channels || []),
              roles: s.roles?.length ? s.roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions || '{}') })) : (existing.roles || []),
              memberIds: s.members?.length ? s.members.map(m => m.userId) : (existing.memberIds || []),
              memberRoles: existing.memberRoles || {}
            };
            if (s.members) {
              s.members.forEach(m => {
                srv.memberRoles[m.userId] = m.roleId;
              });
            }
            serverMap.set(s.id, srv);
          }
          servers = Array.from(serverMap.values());
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
          for (const msg of pgMessages) {
            if (!messageHistory.has(msg.channelId)) {
              messageHistory.set(msg.channelId, []);
            }
            const chanMsgs = messageHistory.get(msg.channelId);
            if (!chanMsgs.some(m => m.id === msg.id)) {
              chanMsgs.push({
                ...msg,
                author: msg.author ? {
                  id: msg.author.id,
                  username: msg.author.username,
                  avatar: msg.author.avatar,
                  isBot: msg.author.isGoogleAuth
                } : { id: msg.authorId, username: 'Unknown' }
              });
            }
          }
        }

        // Load Verifications
        const pgVerif = await this.prisma.verificationRequest.findMany();
        if (pgVerif.length > 0) {
          verificationRequests = pgVerif;
        }

        console.log(`[Storage] Synced data with PostgreSQL (${users.length} users, ${servers.length} servers, ${messageHistory.size} channels)`);
      } catch (err) {
        console.error('[Storage] Error loading from PostgreSQL, preserving disk snapshot:', err.message);
      }
    }

    return {
      users,
      servers,
      messageHistory,
      verificationRequests,
      friendRequests
    };
  }

  async saveData(users, servers, messageHistoryMap, verificationRequests = [], friendRequests = []) {
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

    const dbPath = path.join(DATA_DIR, 'database.json');
    const backupPath = path.join(DATA_DIR, 'database.backup.json');
    const tmpPath = path.join(DATA_DIR, `database.tmp.${Date.now()}`);

    // Safeguard: Never write empty users/servers over existing data
    if (safeUsers.length === 0 && (!servers || servers.length === 0)) {
      console.warn('[Storage] Safeguard triggered: refusing to write empty state over database.json!');
      return;
    }

    // 0. Always persist to local database.json with atomic write & rolling backup
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

      const payload = JSON.stringify({
        users: safeUsers,
        servers,
        messageHistory: historyObj,
        verificationRequests,
        friendRequests,
        updatedAt: new Date().toISOString()
      }, null, 2);

      // Write temp file first
      fs.writeFileSync(tmpPath, payload, 'utf8');

      // Backup previous database.json before replacement
      if (fs.existsSync(dbPath)) {
        try {
          fs.copyFileSync(dbPath, backupPath);
        } catch (_) {}
      }

      // Atomic file replacement
      fs.renameSync(tmpPath, dbPath);
    } catch (e) {
      console.warn('[Storage] Local database.json write error:', e.message);
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {}
    }

    // 1. Sync to Postgres (Prisma)
    if (this.prisma) {
      try {
        // Sync Users
        for (const u of safeUsers) {
          try {
            await this.prisma.user.upsert({
              where: { id: u.id },
              update: {
                customStatus: typeof u.customStatus === 'object' ? JSON.stringify(u.customStatus) : (u.customStatus || null),
                gameStatus: u.gameStatus || null,
                isVerified: u.isVerified || false
              },
              create: {
                id: u.id,
                email: u.email || `${u.id}@voxelchat.com`,
                username: u.username || 'User',
                password: u.password || '',
                avatar: u.avatar || null,
                avatarColor: u.avatarColor || null
              }
            });
          } catch (_) {}
        }

        // Sync Servers, Channels, Roles, Members
        const validChannelIds = new Set();
        for (const s of (servers || [])) {
          try {
            await this.prisma.server.upsert({
              where: { id: s.id },
              update: {
                name: s.name,
                icon: s.icon || null,
                banner: s.banner || null,
                ownerId: s.ownerId,
                inviteCode: s.inviteCode || null
              },
              create: {
                id: s.id,
                name: s.name,
                icon: s.icon || null,
                banner: s.banner || null,
                ownerId: s.ownerId,
                inviteCode: s.inviteCode || null
              }
            });

            // Channels
            for (const ch of (s.channels || [])) {
              validChannelIds.add(ch.id);
              try {
                await this.prisma.channel.upsert({
                  where: { id: ch.id },
                  update: {
                    name: ch.name,
                    type: ch.type || 'text',
                    topic: ch.topic || null,
                    userLimit: ch.userLimit || null
                  },
                  create: {
                    id: ch.id,
                    serverId: s.id,
                    name: ch.name,
                    type: ch.type || 'text',
                    topic: ch.topic || null,
                    userLimit: ch.userLimit || null
                  }
                });
              } catch (_) {}
            }

            // Roles
            for (const r of (s.roles || [])) {
              try {
                await this.prisma.serverRole.upsert({
                  where: { id: r.id },
                  update: {
                    name: r.name,
                    color: r.color || null,
                    permissions: typeof r.permissions === 'object' ? JSON.stringify(r.permissions) : (r.permissions || '{}')
                  },
                  create: {
                    id: r.id,
                    serverId: s.id,
                    name: r.name,
                    color: r.color || null,
                    permissions: typeof r.permissions === 'object' ? JSON.stringify(r.permissions) : (r.permissions || '{}')
                  }
                });
              } catch (_) {}
            }

            // Members
            const memberIds = Array.isArray(s.memberIds) ? s.memberIds : [];
            for (const mId of memberIds) {
              const roleId = (s.memberRoles && s.memberRoles[mId]) || 'role-default';
              try {
                await this.prisma.serverMember.upsert({
                  where: { userId_serverId: { userId: mId, serverId: s.id } },
                  update: { roleId },
                  create: { userId: mId, serverId: s.id, roleId }
                });
              } catch (_) {}
            }
          } catch (_) {}
        }

        // Sync Messages (Only for channels registered in PostgreSQL to prevent FK violations)
        for (const [channelId, messages] of messageHistoryMap.entries()) {
          if (!validChannelIds.has(channelId)) continue; // Keep DM messages in disk snapshot
          for (const msg of messages) {
            try {
              const authorId = msg.author?.id || msg.authorId || 'usr-default';
              await this.prisma.message.upsert({
                where: { id: msg.id },
                update: { pinned: msg.pinned || msg.isPinned || false },
                create: {
                  id: msg.id,
                  channelId: channelId,
                  authorId: authorId,
                  content: msg.content || '',
                  timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
                  pinned: msg.pinned || msg.isPinned || false
                }
              });
            } catch (_) {}
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
