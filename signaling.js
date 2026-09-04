import { MusicBotManager, PRESET_STREAMS } from './musicService.js';
import { StorageManager } from './storage.js';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = '405787129624-ttiutf9ifmvoscr1skm302f2du5ahko7.apps.googleusercontent.com';
const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// In-Memory & Persistent Database
const DEFAULT_ROLES = [
  {
    id: 'role-admin',
    name: 'Dono / Admin',
    color: '#f43f5e',
    permissions: {
      administrator: true,
      manageServer: true,
      manageRoles: true,
      manageChannels: true,
      kickMembers: true,
      sendMessages: true,
      connectVoice: true,
      shareScreen: true,
      controlMusic: true
    }
  },
  {
    id: 'role-mod',
    name: 'Moderador',
    color: '#6366f1',
    permissions: {
      administrator: false,
      manageServer: false,
      manageRoles: false,
      manageChannels: true,
      kickMembers: true,
      sendMessages: true,
      connectVoice: true,
      shareScreen: true,
      controlMusic: true
    }
  },
  {
    id: 'role-vip',
    name: 'VIP / DJ',
    color: '#f59e0b',
    permissions: {
      administrator: false,
      manageServer: false,
      manageRoles: false,
      manageChannels: false,
      kickMembers: false,
      sendMessages: true,
      connectVoice: true,
      shareScreen: true,
      controlMusic: true
    }
  },
  {
    id: 'role-member',
    name: 'Membro',
    color: '#94a3b8',
    permissions: {
      administrator: false,
      manageServer: false,
      manageRoles: false,
      manageChannels: false,
      kickMembers: false,
      sendMessages: true,
      connectVoice: true,
      shareScreen: true,
      controlMusic: false
    }
  }
];

const INITIAL_SERVERS = [
  {
    id: 'server-1',
    name: 'PulseCord Community',
    icon: 'PC',
    ownerId: 'system-owner',
    memberIds: [],
    roles: DEFAULT_ROLES,
    channels: [
      { id: 'c-general', name: 'geral', type: 'text', topic: 'Conversa geral e novidades' },
      { id: 'c-bot', name: 'comandos', type: 'text', topic: 'Use /play, /skip, /queue aqui' },
      { id: 'c-screens', name: 'compartilhamento', type: 'text', topic: 'Prints e links' },
      { id: 'v-lounge', name: 'Sala Principal', type: 'voice', userLimit: 0 },
      { id: 'v-gaming', name: 'Jogos & Squad', type: 'voice', userLimit: 10 },
      { id: 'v-music', name: 'Estúdio de Áudio', type: 'voice', userLimit: 0 }
    ],
    members: []
  }
];

export async function setupSignaling(io) {
  const musicBot = new MusicBotManager(io);
  const storage = new StorageManager();

  // Initial welcome message history
  const initialHistory = new Map();
  initialHistory.set('c-general', [
    {
      id: 'msg-welcome',
      author: {
        id: 'bot-voxel',
        username: 'VoxelBot',
        avatar: 'VX',
        roleColor: '#6366f1',
        roleName: 'SISTEMA',
        isBot: true
      },
      content: 'Bem-vindo ao **Voxel**! Voz em tempo real com supressão de ruído inteligente, compartilhamento em 60fps e bot de música integrado (Spotify, YouTube, SoundCloud).',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      attachments: []
    }
  ]);

  initialHistory.set('c-bot', [
    {
      id: 'msg-bot-intro',
      author: {
        id: 'bot-music',
        username: 'MusicBot',
        avatar: 'MB',
        roleColor: '#f59e0b',
        roleName: 'MUSIC BOT',
        isBot: true
      },
      content: '**Bot de Música Ativo**\nComandos disponíveis:\n- `/play <link do Spotify / YouTube / SoundCloud ou nome>`\n- `/pause` e `/resume`\n- `/skip` para pular faixa\n- `/queue` para ver a fila\n- `/stop` para encerrar',
      timestamp: new Date().toISOString(),
      attachments: []
    }
  ]);

  // Initialize storage connection
  await storage.initStorage();

  // Load persisted database directly from Redis / Upstash
  const loadedData = await storage.loadInitialData(INITIAL_SERVERS, initialHistory);
  let registeredUsers = loadedData.users || [];
  let servers = loadedData.servers || INITIAL_SERVERS;
  let messageHistory = loadedData.messageHistory || initialHistory;

  // Active online connections: socketId -> User profile
  const activeSockets = new Map();
  // Map of channelId -> Array of userIds currently in voice
  const voiceRooms = new Map();
  // Map of channelId -> Watch Together state
  const watchTogetherRooms = new Map();

  const sanitizeUser = (u) => {
    if (!u) return null;
    const active = Array.from(activeSockets.values()).find((act) => act.id === u.id);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      avatar: u.avatar || (u.username ? u.username.substring(0, 2).toUpperCase() : 'US'),
      avatarUrl: u.avatarUrl || null,
      avatarColor: u.avatarColor || 'from-indigo-500 to-purple-600',
      bannerUrl: u.bannerUrl || null,
      customStatus: u.customStatus || null,
      gameStatus: u.gameStatus || null,
      roleId: u.roleId || 'role-member',
      status: active ? (active.status || 'online') : 'offline'
    };
  };

  const decodeInviteToId = (inviteInput) => {
    if (!inviteInput || typeof inviteInput !== 'string') return null;
    let cleaned = inviteInput.trim();
    const match = cleaned.match(/invite\/([a-zA-Z0-9_-]+)/i);
    if (match) cleaned = match[1];
    cleaned = cleaned.replace(/^PC-?/i, '').trim();

    if (cleaned.startsWith('server-')) return cleaned;
    if (/^\d{12,}$/.test(cleaned)) return `server-${cleaned}`;
    if (cleaned.toLowerCase() === 'community' || cleaned === '1') return 'server-1';

    try {
      const num = parseInt(cleaned, 36);
      if (!isNaN(num) && num > 1000000000000) {
        return `server-${num}`;
      }
    } catch (e) {}

    return cleaned;
  };

  const encodeServerToInvite = (server) => {
    if (!server) return 'VOXEL';
    if (server.id === 'server-1') return 'COMMUNITY';
    if (server.inviteCode) return server.inviteCode.toUpperCase();
    const raw = (server.id || '').replace(/^server-/, '');
    const num = parseInt(raw, 10);
    if (!isNaN(num) && num > 1000000000000) {
      return num.toString(36).toUpperCase();
    }
    return raw.substring(0, 8).toUpperCase() || 'VOXEL';
  };

  const generateInviteCode = (server = null) => {
    return encodeServerToInvite(server);
  };

  const formatServerWithMembers = (s) => {
    s.memberRoles = s.memberRoles || {};
    if (!s.inviteCode) {
      s.inviteCode = encodeServerToInvite(s);
    }
    let memberList = [];
    if (s.id === 'server-1') {
      const allKnown = [...registeredUsers];
      for (const act of activeSockets.values()) {
        if (!allKnown.some((u) => u.id === act.id)) {
          allKnown.push(act);
        }
      }
      memberList = allKnown.map((u) => {
        const sanitized = sanitizeUser(u);
        if (!sanitized) return null;
        const isOwner = u.id === s.ownerId;
        const roleId = s.memberRoles[u.id] || (isOwner ? 'role-admin' : 'role-member');
        return {
          ...sanitized,
          roleId
        };
      }).filter(Boolean);
    } else {
      const ids = new Set([s.ownerId, ...(s.memberIds || [])]);
      memberList = Array.from(ids)
        .map((id) => {
          const u = registeredUsers.find((r) => r.id === id) || Array.from(activeSockets.values()).find((act) => act.id === id);
          const sanitized = sanitizeUser(u);
          if (!sanitized) return null;
          const isOwner = id === s.ownerId;
          const roleId = s.memberRoles[id] || (isOwner ? 'role-admin' : 'role-member');
          return {
            ...sanitized,
            roleId
          };
        })
        .filter(Boolean);
    }

    return {
      ...s,
      members: memberList
    };
  };

  // Helper to filter only servers that the user owns or is a member of
  const getServersForUser = (userId) => {
    return servers
      .filter(
        (s) =>
          s.ownerId === userId ||
          (s.memberIds && s.memberIds.includes(userId)) ||
          s.id === 'server-1' // Community server is visible to all registered users
      )
      .map(formatServerWithMembers);
  };

  // In-memory DM Conversations: dmId -> { id, participants: [userId1, userId2], updatedAt }
  const dmConversations = new Map();

  // 1-Hour Temporary Messages Auto-Deletion routine (Preserves Pinned Messages)
  const pruneOldMessages = () => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    let prunedMessagesCount = 0;

    for (const [channelId, msgs] of messageHistory.entries()) {
      const remaining = msgs.filter((msg) => {
        // Pinned messages are PERMANENT and will never be deleted
        if (msg.isPinned || msg.pinned) {
          return true;
        }

        const msgTime = new Date(msg.timestamp).getTime();
        const isExpired = now - msgTime > ONE_HOUR;
        if (isExpired) {
          prunedMessagesCount++;
          return false;
        }
        return true;
      });

      if (remaining.length !== msgs.length) {
        messageHistory.set(channelId, remaining);
      }
    }

    if (prunedMessagesCount > 0) {
      console.log(`[Lifecycle] Pruned ${prunedMessagesCount} expired message(s) older than 1 hour (Pinned messages kept).`);
      storage.saveData(registeredUsers, servers, messageHistory);
      io.emit('messages-pruned');
    }
  };

  // Run cleanup every 30 seconds
  setInterval(pruneOldMessages, 30 * 1000);

  io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // Immediately send current voice rooms to newly connected client
    socket.emit('voice-rooms-updated', {
      voiceRooms: Object.fromEntries(voiceRooms)
    });

    // Allow client to explicitly request voice rooms sync at any time
    socket.on('sync-voice-rooms', (callback) => {
      const data = Object.fromEntries(voiceRooms);
      socket.emit('voice-rooms-updated', { voiceRooms: data });
      if (callback) callback({ success: true, voiceRooms: data });
    });

    // ==========================================
    // 1. AUTHENTICATION & LOGIN / REGISTER
    // ==========================================

    // Google OAuth 2.0 Login & Automatic Account Creation
    socket.on('auth-google', async (rawInput, callback) => {
      try {
        const data = (rawInput && typeof rawInput.credential === 'object') ? rawInput.credential : (rawInput || {});
        let payload = null;

        if (typeof data.credential === 'string') {
          try {
            const ticket = await googleOAuthClient.verifyIdToken({
              idToken: data.credential,
              audience: GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
          } catch (verifyErr) {
            const parts = data.credential.split('.');
            if (parts.length === 3) {
              payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            }
          }
        } else if (data.email) {
          payload = {
            email: data.email,
            name: data.name || data.email.split('@')[0],
            picture: data.picture || '',
            sub: data.sub || `g-${Date.now()}`
          };
        }

        if (!payload || !payload.email) {
          return callback && callback({ success: false, error: 'Não foi possível obter dados da conta Google.' });
        }

        const normEmail = payload.email.trim().toLowerCase();
        let user = registeredUsers.find(
          (u) => u.email === normEmail || (u.googleId && u.googleId === payload.sub)
        );

        // If this is an initial check and the user is NOT registered yet, request onboarding
        if (!user && data.isInitialCheck) {
          return callback && callback({
            success: false,
            needOnboarding: true,
            email: normEmail,
            name: (payload.name || payload.given_name || normEmail.split('@')[0]).trim(),
            picture: payload.picture || '',
            sub: payload.sub
          });
        }

        const chosenName = (data.chosenUsername || data.username || payload.name || payload.given_name || normEmail.split('@')[0]).trim();
        const cleanAvatar = chosenName.substring(0, 2).toUpperCase();
        const chosenColor = data.avatarColor || 'from-indigo-500 to-purple-600';
        const photoUrl = data.avatarUrl !== undefined ? data.avatarUrl : (data.useGooglePhoto ? (payload.picture || '') : '');

        if (!user) {
          // Register new user with verified Google info & custom chosen nickname + color
          user = {
            id: `usr-g-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            email: normEmail,
            googleId: payload.sub,
            password: '',
            username: chosenName,
            displayName: chosenName,
            avatar: cleanAvatar,
            avatarUrl: photoUrl,
            avatarColor: chosenColor,
            token: `tok-g-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
            createdAt: new Date().toISOString(),
            serverIds: ['server-1'],
            isGoogleAuth: true,
            isVerified: true,
            bio: '',
            pronouns: '',
            customStatus: { text: '', emoji: '' },
            gameStatus: '',
            badges: [{ id: 'badge-verified', name: 'Verificado Google', icon: 'BadgeCheck', color: 'text-sky-400' }],
            bannerUrl: '',
            avatarDecoration: '',
            profileEffect: ''
          };

          registeredUsers.push(user);

          // Add to default community server
          const defaultServer = servers.find((s) => s.id === 'server-1');
          if (defaultServer) {
            if (!defaultServer.memberIds) defaultServer.memberIds = [];
            if (!defaultServer.memberIds.includes(user.id)) {
              defaultServer.memberIds.push(user.id);
            }
          }

          storage.saveData(registeredUsers, servers, messageHistory);
          console.log(`[Google Auth] Created new user: ${user.username} (${user.email})`);
        } else {
          // Update username, initials and chosen gradient
          if (data.chosenUsername || data.username) {
            user.username = chosenName;
            user.displayName = chosenName;
            user.avatar = cleanAvatar;
          }
          if (data.avatarColor) {
            user.avatarColor = chosenColor;
          }
          if (data.avatarUrl !== undefined) {
            user.avatarUrl = data.avatarUrl;
          } else if (data.useGooglePhoto) {
            user.avatarUrl = payload.picture || '';
          }
          if (!user.googleId) {
            user.googleId = payload.sub;
          }
          storage.saveData(registeredUsers, servers, messageHistory);
          console.log(`[Google Auth] Logged in existing user: ${user.username} (${user.email})`);
        }

        // Activate session for this socket
        const activeUser = {
          ...user,
          socketId: socket.id,
          status: 'online',
          isMuted: false,
          isDeafened: false,
          isScreenSharing: false,
          activeVoiceChannel: null
        };
        activeSockets.set(socket.id, activeUser);

        const userServers = getServersForUser(user.id);

        if (callback) {
          callback({
            success: true,
            user: {
              ...user,
              password: undefined
            },
            servers: userServers,
            voiceRooms: Object.fromEntries(voiceRooms)
          });
        }

        io.emit('user-status-changed', { user: activeUser });
      } catch (err) {
        console.error('[Google Auth Error]:', err);
        if (callback) callback({ success: false, error: 'Erro ao autenticar com o Google.' });
      }
    });

    // Register New Account
    socket.on('auth-register', ({ email, password, username, avatar, avatarColor }, callback) => {
      const normEmail = (email || '').trim().toLowerCase();
      if (!normEmail || !password) {
        return callback && callback({ success: false, error: 'E-mail e senha são obrigatórios.' });
      }

      if (registeredUsers.some((u) => u.email === normEmail)) {
        return callback && callback({ success: false, error: 'Este e-mail já está cadastrado no PulseCord.' });
      }

      const cleanUsername = (username || normEmail.split('@')[0]).trim();
      const cleanAvatar = (avatar || cleanUsername).substring(0, 2).toUpperCase();

      const newUser = {
        id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        email: normEmail,
        password: password.trim(),
        username: cleanUsername,
        avatar: cleanAvatar,
        avatarColor: avatarColor || 'from-indigo-500 to-purple-600',
        token: `tok-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
        createdAt: new Date().toISOString(),
        serverIds: ['server-1'],
        bio: '',
        pronouns: '',
        displayName: cleanUsername,
        customStatus: { text: '', emoji: '' },
        gameStatus: '',
        badges: [],
        avatarUrl: '',
        bannerUrl: '',
        avatarDecoration: '',
        profileEffect: ''
      };

      registeredUsers.push(newUser);

      // Add to default community server
      const defaultServer = servers.find((s) => s.id === 'server-1');
      if (defaultServer) {
        if (!defaultServer.memberIds) defaultServer.memberIds = [];
        if (!defaultServer.memberIds.includes(newUser.id)) {
          defaultServer.memberIds.push(newUser.id);
        }
      }

      storage.saveData(registeredUsers, servers, messageHistory);

      // Activate session for this socket
      const activeUser = {
        ...newUser,
        socketId: socket.id,
        status: 'online',
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        activeVoiceChannel: null
      };
      activeSockets.set(socket.id, activeUser);

      const userServers = getServersForUser(newUser.id);

      if (callback) {
        callback({
          success: true,
          user: {
            ...newUser,
            password: undefined
          },
          servers: userServers,
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }

      io.emit('user-status-changed', { user: activeUser });
    });

    // Quick Guest Entry (Nickname only, 1-click test)
    socket.on('auth-guest', ({ username, avatarColor }, callback) => {
      const cleanUsername = (username || `User_${Math.floor(1000 + Math.random() * 9000)}`).trim();
      const cleanAvatar = cleanUsername.substring(0, 2).toUpperCase();

      const guestUser = {
        id: `usr-guest-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        email: `${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '') || 'guest'}@pulsecord.guest`,
        password: '',
        username: cleanUsername,
        avatar: cleanAvatar,
        avatarColor: avatarColor || 'from-indigo-500 to-purple-600',
        token: `tok-guest-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        createdAt: new Date().toISOString(),
        serverIds: ['server-1'],
        isGuest: true,
        bio: '',
        pronouns: '',
        displayName: cleanUsername,
        customStatus: { text: '', emoji: '' },
        gameStatus: '',
        badges: [],
        avatarUrl: '',
        bannerUrl: '',
        avatarDecoration: '',
        profileEffect: ''
      };

      // Add to default server
      const defaultServer = servers.find((s) => s.id === 'server-1');
      if (defaultServer) {
        if (!defaultServer.memberIds) defaultServer.memberIds = [];
        if (!defaultServer.memberIds.includes(guestUser.id)) {
          defaultServer.memberIds.push(guestUser.id);
        }
      }

      const activeUser = {
        ...guestUser,
        socketId: socket.id,
        status: 'online',
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        activeVoiceChannel: null
      };
      activeSockets.set(socket.id, activeUser);

      const userServers = getServersForUser(guestUser.id);

      if (callback) {
        callback({
          success: true,
          user: {
            ...guestUser,
            password: undefined
          },
          servers: userServers,
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }

      io.emit('user-status-changed', { user: activeUser });
    });

    // Login with Email & Password
    socket.on('auth-login', ({ email, password }, callback) => {
      const normEmail = (email || '').trim().toLowerCase();
      const user = registeredUsers.find(
        (u) => u.email === normEmail && u.password === (password || '').trim()
      );

      if (!user) {
        return callback && callback({ success: false, error: 'E-mail ou senha incorretos.' });
      }

      const activeUser = {
        ...user,
        socketId: socket.id,
        status: user.status || 'online',
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        activeVoiceChannel: null
      };
      activeSockets.set(socket.id, activeUser);

      const userServers = getServersForUser(user.id);

      if (callback) {
        callback({
          success: true,
          user: {
            ...user,
            password: undefined
          },
          servers: userServers,
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }

      io.emit('user-status-changed', { user: activeUser });
    });

    // Auto-Login / Resume Saved Session (Remember Me)
    socket.on('auth-session', ({ token, userId }, callback) => {
      const user = registeredUsers.find((u) => u.token === token || u.id === userId);
      if (!user) {
        return callback && callback({ success: false, error: 'Sessão expirada. Faça login novamente.' });
      }

      const activeUser = {
        ...user,
        socketId: socket.id,
        status: user.status || 'online',
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        activeVoiceChannel: null
      };
      activeSockets.set(socket.id, activeUser);

      const userServers = getServersForUser(user.id);

      if (callback) {
        callback({
          success: true,
          user: {
            ...user,
            password: undefined
          },
          servers: userServers,
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }

      io.emit('user-status-changed', { user: activeUser });
    });

    // User Profile Update
    socket.on('update-profile', (profileData, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return callback && callback({ success: false, error: 'Not authenticated' });

      const allowedFields = ['displayName', 'bio', 'pronouns', 'avatarColor', 'avatarUrl', 'bannerUrl', 'avatarDecoration', 'profileEffect', 'customStatus', 'gameStatus', 'username', 'appTheme', 'compactMode', 'clipSettings', 'status'];

      const userIndex = registeredUsers.findIndex(u => u.id === activeUser.id);

      allowedFields.forEach(field => {
        if (profileData[field] !== undefined) {
          activeUser[field] = profileData[field];
          if (userIndex !== -1) {
            registeredUsers[userIndex][field] = profileData[field];
          }
        }
      });

      // Generate monogram avatar if display name changed and no custom URL
      if (profileData.displayName && !activeUser.avatarUrl) {
        activeUser.avatar = profileData.displayName.substring(0, 2).toUpperCase();
        if (userIndex !== -1) {
          registeredUsers[userIndex].avatar = activeUser.avatar;
        }
      }

      if (userIndex !== -1) {
        storage.saveData(registeredUsers, servers, messageHistory);
      }

      // Broadcast to everyone
      io.emit('user-profile-updated', { user: activeUser });
      io.emit('user-status-changed', { user: activeUser });

      if (callback) {
        if (userIndex !== -1) {
          callback({
            success: true,
            user: {
              ...registeredUsers[userIndex],
              password: undefined,
              status: activeUser.status || 'online'
            }
          });
        } else {
          callback({ success: true, user: activeUser });
        }
      }
    });

    // ==========================================
    // DELETE ACCOUNT & CASCADE DATA PURGE
    // ==========================================
    socket.on('delete-account', ({ confirmUsername }, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) {
        return callback && callback({ success: false, error: 'Usuário não autenticado.' });
      }

      if (!confirmUsername || confirmUsername.trim() !== activeUser.username) {
        return callback && callback({
          success: false,
          error: `O nome digitado não confere. Digite exatamente "${activeUser.username}".`
        });
      }

      const userId = activeUser.id;

      try {
        // 1. Remove user from registered users
        const userIndex = registeredUsers.findIndex((u) => u.id === userId);
        if (userIndex !== -1) {
          registeredUsers.splice(userIndex, 1);
        }

        // 2. Identify owned servers and delete them completely
        const ownedServers = servers.filter((s) => s.ownerId === userId);
        ownedServers.forEach((ownedServer) => {
          if (ownedServer.channels) {
            ownedServer.channels.forEach((c) => {
              messageHistory.delete(c.id);
            });
          }
          io.emit('server-deleted', { serverId: ownedServer.id });
        });

        // Retain only servers not owned by this user
        const remainingServers = servers.filter((s) => s.ownerId !== userId);
        servers.length = 0;
        servers.push(...remainingServers);

        // 3. Remove user membership and roles from all remaining servers
        servers.forEach((s) => {
          if (s.memberIds) {
            s.memberIds = s.memberIds.filter((id) => id !== userId);
          }
          if (s.members) {
            s.members = s.members.filter((m) => m.id !== userId);
          }
        });

        // 4. Delete all messages authored by this user across all channels and DMs
        for (const [channelId, msgs] of messageHistory.entries()) {
          const filtered = msgs.filter((m) => m.author?.id !== userId && m.authorId !== userId);
          messageHistory.set(channelId, filtered);
        }

        // 5. Remove user from voice rooms if currently in a voice call
        if (activeUser.activeVoiceChannel) {
          const roomUsers = voiceRooms.get(activeUser.activeVoiceChannel) || [];
          const updatedRoom = roomUsers.filter((u) => u.id !== userId);
          if (updatedRoom.length > 0) {
            voiceRooms.set(activeUser.activeVoiceChannel, updatedRoom);
          } else {
            voiceRooms.delete(activeUser.activeVoiceChannel);
          }
          io.emit('voice-room-updated', {
            channelId: activeUser.activeVoiceChannel,
            users: updatedRoom
          });
        }

        // 6. Delete all direct message conversations involving this user
        for (const [dmId, dm] of dmConversations.entries()) {
          if (dm.participants?.includes(userId)) {
            dmConversations.delete(dmId);
            messageHistory.delete(dmId);
          }
        }

        // 7. Save clean state to persistent storage (Redis & JSON)
        storage.saveData(registeredUsers, servers, messageHistory);

        // 8. Remove active socket
        activeSockets.delete(socket.id);

        console.log(`[Account Deleted] User ${activeUser.username} (${userId}) and all associated data permanently deleted.`);

        if (callback) {
          callback({ success: true, message: 'Conta excluída com sucesso.' });
        }

        io.emit('user-deleted', { userId });
        io.emit('user-status-changed', { user: { ...activeUser, status: 'offline' } });
      } catch (err) {
        console.error('[Delete Account Error]:', err);
        if (callback) {
          callback({ success: false, error: 'Erro ao excluir conta do servidor.' });
        }
      }
    });

    // ==========================================
    // 2. ISOLATED SERVERS & CHANNELS
    // ==========================================

    // Create Server (Owner only, only visible to creator and invited members)
    socket.on('create-server', ({ name, icon }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ error: 'Não autenticado' });

      const newServer = {
        id: `server-${Date.now()}`,
        name: name || 'Novo Espaço',
        icon: icon || (name ? name.substring(0, 2).toUpperCase() : 'PC'),
        ownerId: user.id,
        memberIds: [user.id],
        memberRoles: {
          [user.id]: 'role-admin'
        },
        roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
        channels: [
          { id: `c-${Date.now()}-1`, name: 'geral', type: 'text', topic: 'Boas vindas ao novo servidor!' },
          { id: `v-${Date.now()}-1`, name: 'Sala Principal', type: 'voice', userLimit: 0 }
        ],
        members: [user]
      };

      servers.push(newServer);

      const registered = registeredUsers.find((u) => u.id === user.id);
      if (registered) {
        if (!registered.serverIds) registered.serverIds = [];
        registered.serverIds.push(newServer.id);
      }

      storage.saveData(registeredUsers, servers, messageHistory);

      // Send to creator
      const formattedNew = formatServerWithMembers(newServer);
      socket.emit('server-created', formattedNew);
      if (callback) callback(formattedNew);
    });

    // Join an Existing Server by Server ID or Invite Code
    socket.on('join-server', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const decodedId = decodeInviteToId(serverId);
      let cleaned = (serverId || '').trim();
      const match = cleaned.match(/invite\/([a-zA-Z0-9_-]+)/i);
      if (match) cleaned = match[1];
      cleaned = cleaned.replace(/^PC-?/i, '').trim();

      const targetServer = servers.find((s) =>
        s.id === serverId ||
        (decodedId && s.id === decodedId) ||
        (s.inviteCode && s.inviteCode.toUpperCase() === cleaned.toUpperCase()) ||
        s.id === cleaned
      );

      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado ou convite expirado.' });
      }

      if (!targetServer.memberIds) targetServer.memberIds = [];
      if (!targetServer.memberIds.includes(user.id)) {
        targetServer.memberIds.push(user.id);
      }

      const registered = registeredUsers.find((u) => u.id === user.id);
      if (registered) {
        if (!registered.serverIds) registered.serverIds = [];
        if (!registered.serverIds.includes(targetServer.id)) {
          registered.serverIds.push(targetServer.id);
        }
      }

      storage.saveData(registeredUsers, servers, messageHistory);

      const formattedTarget = formatServerWithMembers(targetServer);

      io.emit('server-roles-updated', {
        serverId: targetServer.id,
        roles: targetServer.roles,
        server: formattedTarget
      });

      socket.emit('server-created', formattedTarget);
      if (callback) callback({ success: true, server: formattedTarget });
    });

    // Get or Create Invite Code for Server
    socket.on('get-server-invite', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const decodedId = decodeInviteToId(serverId);
      const targetServer = servers.find((s) => s.id === serverId || (decodedId && s.id === decodedId));
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      if (!targetServer.inviteCode) {
        targetServer.inviteCode = encodeServerToInvite(targetServer);
        storage.saveData(registeredUsers, servers, messageHistory);
      }

      const memberCount = (targetServer.memberIds?.length || 1);
      callback && callback({
        success: true,
        inviteCode: targetServer.inviteCode,
        inviteUrl: `https://voxel.gg/invite/${targetServer.inviteCode}`,
        serverId: targetServer.id,
        serverName: targetServer.name,
        serverIcon: targetServer.icon,
        memberCount
      });
    });

    // Generate New Invite Code for Server
    socket.on('generate-new-invite', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const decodedId = decodeInviteToId(serverId);
      const targetServer = servers.find((s) => s.id === serverId || (decodedId && s.id === decodedId));
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      targetServer.inviteCode = encodeServerToInvite(targetServer);
      storage.saveData(registeredUsers, servers, messageHistory);

      const memberCount = (targetServer.memberIds?.length || 1);
      callback && callback({
        success: true,
        inviteCode: targetServer.inviteCode,
        inviteUrl: `https://voxel.gg/invite/${targetServer.inviteCode}`,
        serverId: targetServer.id,
        serverName: targetServer.name,
        serverIcon: targetServer.icon,
        memberCount
      });
    });

    // Join Server via Invite Code or Link
    socket.on('join-server-invite', ({ inviteCode }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      if (!inviteCode || typeof inviteCode !== 'string') {
        return callback && callback({ success: false, error: 'Código de convite inválido.' });
      }

      const decodedId = decodeInviteToId(inviteCode);
      let cleaned = inviteCode.trim();
      const urlMatch = cleaned.match(/invite\/([a-zA-Z0-9_-]+)/i);
      if (urlMatch) {
        cleaned = urlMatch[1];
      } else {
        cleaned = cleaned.replace(/^PC-?/i, '').trim();
      }

      const targetServer = servers.find((s) =>
        (s.inviteCode && s.inviteCode.toUpperCase() === cleaned.toUpperCase()) ||
        (decodedId && s.id === decodedId) ||
        s.id === inviteCode ||
        s.id === cleaned
      );

      if (!targetServer) {
        return callback && callback({ success: false, error: 'Convite inválido ou servidor não encontrado.' });
      }

      if (!targetServer.memberIds) targetServer.memberIds = [];
      if (!targetServer.memberIds.includes(user.id)) {
        targetServer.memberIds.push(user.id);
      }

      const registered = registeredUsers.find((u) => u.id === user.id);
      if (registered) {
        if (!registered.serverIds) registered.serverIds = [];
        if (!registered.serverIds.includes(targetServer.id)) {
          registered.serverIds.push(targetServer.id);
        }
      }

      storage.saveData(registeredUsers, servers, messageHistory);

      const formattedTarget = formatServerWithMembers(targetServer);

      // Notify other online members of this server
      io.emit('server-roles-updated', {
        serverId: targetServer.id,
        roles: targetServer.roles,
        server: formattedTarget
      });

      socket.emit('server-created', formattedTarget);
      if (callback) callback({ success: true, server: formattedTarget });
    });

    // Send Server Invite directly via DM to a friend/user
    socket.on('send-server-invite-dm', ({ targetUserId, serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const targetServer = servers.find((s) => s.id === serverId);
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      if (!targetServer.inviteCode) {
        targetServer.inviteCode = generateInviteCode();
      }

      const sortedIds = [user.id, targetUserId].sort();
      const dmId = `dm-${sortedIds[0]}_${sortedIds[1]}`;

      const inviteMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        channelId: dmId,
        userId: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        avatarUrl: user.avatarUrl,
        avatarColor: user.avatarColor,
        content: `Você foi convidado para participar de **${targetServer.name}**!\nhttps://voxel.gg/invite/${targetServer.inviteCode}`,
        invite: {
          code: targetServer.inviteCode,
          serverId: targetServer.id,
          serverName: targetServer.name,
          serverIcon: targetServer.icon,
          memberCount: (targetServer.memberIds?.length || 1)
        },
        timestamp: new Date().toISOString()
      };

      let history = messageHistory.get(dmId);
      if (!history) {
        history = [];
        messageHistory.set(dmId, history);
      }
      history.push(inviteMsg);
      storage.saveData(registeredUsers, servers, messageHistory);

      io.emit('new-message', { channelId: dmId, message: inviteMsg });
      if (callback) callback({ success: true, message: inviteMsg });
    });

    socket.on('create-channel', ({ serverId, name, type, topic, userLimit }, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return;
      const server = servers.find((s) => s.id === serverId);
      if (!server) return;

      const isOwner = server.ownerId === activeUser.id;
      const callerRoleId = server.memberRoles?.[activeUser.id] || (isOwner ? 'role-admin' : 'role-member');
      const callerRoleObj = (server.roles || []).find(r => r.id === callerRoleId);
      const canManageChannels = isOwner || callerRoleObj?.permissions?.administrator || callerRoleObj?.permissions?.manageChannels;

      if (!canManageChannels) {
        return callback && callback({ error: 'Sem permissão para criar canais.' });
      }

      const newChannel = {
        id: `${type[0]}-${Date.now()}`,
        name: name.toLowerCase().replace(/\s+/g, '-'),
        type: type || 'text',
        topic: topic || '',
        userLimit: userLimit || 0
      };

      server.channels.push(newChannel);
      storage.saveData(registeredUsers, servers, messageHistory);

      io.emit('channel-created', { serverId, channel: newChannel });
      if (callback) callback(newChannel);
    });

    socket.on('update-roles', ({ serverId, roles }, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return;
      const server = servers.find((s) => s.id === serverId);
      if (!server) return;

      const isOwner = server.ownerId === activeUser.id;
      const callerRoleId = server.memberRoles?.[activeUser.id] || (isOwner ? 'role-admin' : 'role-member');
      const callerRoleObj = (server.roles || []).find(r => r.id === callerRoleId);
      const hasPermission = isOwner || callerRoleObj?.permissions?.administrator || callerRoleObj?.permissions?.manageRoles;

      if (!hasPermission) {
        return callback && callback({ success: false, error: 'Sem permissão para alterar cargos.' });
      }

      server.roles = roles;
      storage.saveData(registeredUsers, servers, messageHistory);

      const formattedServer = formatServerWithMembers(server);
      io.emit('server-roles-updated', { serverId, roles, server: formattedServer });
      if (callback) callback({ success: true, server: formattedServer });
    });

    socket.on('assign-member-role', ({ serverId, targetUserId, roleId }, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return callback && callback({ success: false, error: 'Não autenticado' });

      const server = servers.find((s) => s.id === serverId);
      if (!server) return callback && callback({ success: false, error: 'Servidor não encontrado' });

      // Permission check: Owner or role with administrator / manageRoles permission
      const isOwner = server.ownerId === activeUser.id;
      const callerRoleId = server.memberRoles?.[activeUser.id] || (isOwner ? 'role-admin' : 'role-member');
      const callerRoleObj = (server.roles || []).find(r => r.id === callerRoleId);
      const hasPermission = isOwner || callerRoleObj?.permissions?.administrator || callerRoleObj?.permissions?.manageRoles;

      if (!hasPermission) {
        return callback && callback({ success: false, error: 'Apenas o Dono ou Administradores com permissão podem alterar cargos.' });
      }

      if (!server.memberRoles) server.memberRoles = {};
      server.memberRoles[targetUserId] = roleId || 'role-member';

      storage.saveData(registeredUsers, servers, messageHistory);

      const formattedServer = formatServerWithMembers(server);
      io.emit('server-roles-updated', { serverId, roles: server.roles, server: formattedServer });
      io.emit('server-member-role-updated', { serverId, targetUserId, roleId, server: formattedServer });

      if (callback) callback({ success: true, server: formattedServer });
    });

    // ==========================================
    // 3. TEXT CHAT, DIRECT MESSAGES & PINNING
    // ==========================================
    socket.on('fetch-messages', ({ channelId }, callback) => {
      const msgs = messageHistory.get(channelId) || [];
      if (callback) callback(msgs);
    });

    // Fetch DMs for the current user
    socket.on('fetch-dms', (callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback([]);

      const userDMs = [];
      for (const [dmId, dmData] of dmConversations.entries()) {
        if (dmData.participants.includes(user.id)) {
          const otherUserId = dmData.participants.find(id => id !== user.id) || user.id;
          const otherUser = registeredUsers.find(u => u.id === otherUserId) ||
            Array.from(activeSockets.values()).find(act => act.id === otherUserId) ||
            { id: otherUserId, username: 'Usuário', displayName: 'Usuário' };

          const msgs = messageHistory.get(dmId) || [];
          const lastMsg = msgs[msgs.length - 1];

          userDMs.push({
            id: dmId,
            type: 'dm',
            name: otherUser.displayName || otherUser.username,
            recipient: sanitizeUser(otherUser),
            participants: dmData.participants,
            lastMessage: lastMsg ? lastMsg.content || (lastMsg.attachments?.length ? 'Arquivo anexo' : '') : '',
            updatedAt: dmData.updatedAt
          });
        }
      }

      // Sort by most recent
      userDMs.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      if (callback) callback(userDMs);
    });

    // Open or create DM with target user
    socket.on('open-or-create-dm', ({ targetUserId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const sortedIds = [user.id, targetUserId].sort();
      const dmId = `dm-${sortedIds[0]}_${sortedIds[1]}`;

      const otherUser = registeredUsers.find(u => u.id === targetUserId) ||
        Array.from(activeSockets.values()).find(act => act.id === targetUserId) ||
        { id: targetUserId, username: 'Usuário', displayName: 'Usuário' };

      const dmRecord = {
        id: dmId,
        participants: [user.id, targetUserId],
        updatedAt: new Date().toISOString()
      };
      dmConversations.set(dmId, dmRecord);

      const dmPayload = {
        id: dmId,
        type: 'dm',
        name: otherUser.displayName || otherUser.username,
        recipient: sanitizeUser(otherUser),
        participants: [user.id, targetUserId]
      };

      socket.join(dmId);

      // Also join target user's active sockets if online
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          const targetSocket = io.sockets.sockets.get(sockId);
          if (targetSocket) {
            targetSocket.join(dmId);
            targetSocket.emit('dm-received', {
              id: dmId,
              type: 'dm',
              name: user.displayName || user.username,
              recipient: sanitizeUser(user),
              participants: [user.id, targetUserId]
            });
          }
        }
      }

      if (callback) callback({ success: true, dm: dmPayload });
    });

    // ==========================================
    // DM CALLS SIGNALING
    // ==========================================

    // Initiate DM Call
    socket.on('initiate-dm-call', ({ targetUserId, dmId }) => {
      console.log(`[DM Call] Recebido initiate-dm-call de socket ${socket.id} para alvo ${targetUserId} na DM ${dmId}`);
      const user = activeSockets.get(socket.id);
      if (!user) {
        console.log(`[DM Call] ERRO: Usuário não encontrado no activeSockets para o socket ${socket.id}`);
        return;
      }
      
      let foundTarget = false;
      // Find target user's active sockets and notify them
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          console.log(`[DM Call] Alvo encontrado online no socket ${sockId}! Emitindo dm-call-incoming.`);
          io.to(sockId).emit('dm-call-incoming', {
            dmId,
            caller: sanitizeUser(user),
          });
          foundTarget = true;
        }
      }
      
      if (!foundTarget) {
        console.log(`[DM Call] AVISO: Alvo ${targetUserId} não possui nenhum socket ativo no momento.`);
      }
    });

    // Cancel DM Call (caller hangs up before answer)
    socket.on('cancel-dm-call', ({ targetUserId, dmId }) => {
      console.log(`[DM Call] Cancelando chamada na DM ${dmId} para alvo ${targetUserId}`);
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          io.to(sockId).emit('dm-call-cancelled', { dmId });
        }
      }
    });

    // Decline DM Call (callee rejects)
    socket.on('decline-dm-call', ({ callerId, dmId }) => {
      console.log(`[DM Call] Recusando chamada na DM ${dmId} do chamador ${callerId}`);
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === callerId) {
          io.to(sockId).emit('dm-call-declined', { dmId });
        }
      }
    });

    // Accept DM Call (callee accepts)
    socket.on('accept-dm-call', ({ callerId, dmId }) => {
      console.log(`[DM Call] Aceitando chamada na DM ${dmId} do chamador ${callerId}`);
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === callerId) {
          io.to(sockId).emit('dm-call-accepted', { dmId });
        }
      }
    });

    // Pin Message (Permanent, survives 1h auto-deletion)
    socket.on('pin-message', ({ channelId, messageId }, callback) => {
      const user = activeSockets.get(socket.id);
      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find(m => m.id === messageId);

      if (msg) {
        msg.isPinned = true;
        msg.pinnedAt = new Date().toISOString();
        msg.pinnedBy = user?.username || 'Usuário';

        storage.saveData(registeredUsers, servers, messageHistory);
        io.emit('message-pinned', { channelId, messageId, message: msg });
        if (callback) callback({ success: true, message: msg });
      } else {
        if (callback) callback({ success: false, error: 'Mensagem não encontrada' });
      }
    });

    // Unpin Message
    socket.on('unpin-message', ({ channelId, messageId }, callback) => {
      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find(m => m.id === messageId);

      if (msg) {
        msg.isPinned = false;
        delete msg.pinnedAt;
        delete msg.pinnedBy;

        storage.saveData(registeredUsers, servers, messageHistory);
        io.emit('message-unpinned', { channelId, messageId });
        if (callback) callback({ success: true });
      } else {
        if (callback) callback({ success: false, error: 'Mensagem não encontrada' });
      }
    });

    // Send message (Handles Channels & DMs)
    socket.on('send-message', ({ channelId, content, attachments }) => {
      const user = activeSockets.get(socket.id);
      if (!user || (!content?.trim() && (!attachments || attachments.length === 0))) return;

      const role = DEFAULT_ROLES.find((r) => r.id === user.roleId) || DEFAULT_ROLES[3];

      const message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        channelId,
        author: {
          id: user.id,
          username: user.username,
          displayName: user.displayName || user.username,
          avatar: user.avatar,
          avatarUrl: user.avatarUrl || null,
          avatarColor: user.avatarColor,
          roleId: user.roleId,
          roleColor: role.color,
          roleName: role.name
        },
        content: content || '',
        attachments: attachments || [],
        timestamp: new Date().toISOString(),
        isPinned: false,
        reactions: []
      };

      if (!messageHistory.has(channelId)) {
        messageHistory.set(channelId, []);
      }
      messageHistory.get(channelId).push(message);

      if (messageHistory.get(channelId).length > 250) {
        messageHistory.get(channelId).shift();
      }

      // Update DM timestamp if it's a DM
      if (channelId.startsWith('dm-') && dmConversations.has(channelId)) {
        dmConversations.get(channelId).updatedAt = new Date().toISOString();
      }

      storage.saveData(registeredUsers, servers, messageHistory);
      io.emit('new-message', message);

      if (content && content.startsWith('/')) {
        handleBotCommand(channelId, content, user, io, musicBot, messageHistory, storage, servers, registeredUsers);
      }
    });

    // Pin Message
    socket.on('pin-message', ({ channelId, messageId }) => {
      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (msg) {
        msg.isPinned = true;
        msg.pinnedAt = new Date().toISOString();
        const user = activeSockets.get(socket.id);
        msg.pinnedBy = user ? (user.displayName || user.username) : 'Usuário';
        storage.saveData(registeredUsers, servers, messageHistory);
        io.emit('message-pinned', { channelId, messageId, message: msg });
      }
    });

    // Unpin Message
    socket.on('unpin-message', ({ channelId, messageId }) => {
      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (msg) {
        msg.isPinned = false;
        delete msg.pinnedAt;
        delete msg.pinnedBy;
        storage.saveData(registeredUsers, servers, messageHistory);
        io.emit('message-unpinned', { channelId, messageId });
      }
    });

    // ==========================================
    // 4. VOICE CHANNELS & WEBRTC
    // ==========================================
    socket.on('join-voice', ({ channelId, serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;

      // Clean this user from ANY voice room they might previously be in
      for (const [rId, rUsers] of voiceRooms.entries()) {
        const hasUser = rUsers.some((u) => u.id === user.id || u.socketId === socket.id);
        if (hasUser) {
          const filtered = rUsers.filter((u) => u.id !== user.id && u.socketId !== socket.id);
          if (filtered.length === 0) {
            voiceRooms.delete(rId);
          } else {
            voiceRooms.set(rId, filtered);
          }
          socket.leave(`voice-${rId}`);
          socket.to(`voice-${rId}`).emit('user-left-voice', {
            socketId: socket.id,
            userId: user.id,
            channelId: rId
          });
        }
      }

      user.activeVoiceChannel = channelId;
      socket.join(`voice-${channelId}`);

      if (!voiceRooms.has(channelId)) {
        voiceRooms.set(channelId, []);
      }

      const roomUsers = voiceRooms.get(channelId);
      const existingIdx = roomUsers.findIndex((u) => u.id === user.id || u.socketId === socket.id);
      if (existingIdx !== -1) roomUsers.splice(existingIdx, 1);

      roomUsers.push(user);

      socket.to(`voice-${channelId}`).emit('user-joined-voice', {
        user,
        channelId
      });

      const musicPlayer = musicBot.getPlayer(channelId);
      const defaultState = { isActive: false, url: '', isPlaying: false, currentTime: 0, queue: [], participants: [], hostId: null };
      const watchTogether = watchTogetherRooms.get(channelId) || defaultState;

      if (callback) {
        callback({
          success: true,
          usersInRoom: roomUsers.filter((u) => u.socketId !== socket.id && u.id !== user.id),
          musicPlayer,
          watchTogether
        });
      }

      io.emit('voice-rooms-updated', {
        voiceRooms: Object.fromEntries(voiceRooms)
      });
    });

    socket.on('leave-voice', () => {
      const user = activeSockets.get(socket.id);
      leaveCurrentVoice(socket, user, io, voiceRooms);
    });

    // Move a user to another voice channel (Permissions: Server Owner, Admin, or Move/Manage Members role)
    socket.on('move-voice-user', ({ targetUserId, targetChannelId, serverId }, callback) => {
      const caller = activeSockets.get(socket.id);
      if (!caller) return callback && callback({ success: false, error: 'Não autenticado' });

      // Permission check: Owner or role with permission (administrator, manageChannels, kickMembers) or self
      const server = servers.find((s) => s.id === serverId);
      const isOwner = server && server.ownerId === caller.id;
      const callerRoleId = server?.memberRoles?.[caller.id] || (isOwner ? 'role-admin' : 'role-member');
      const callerRoleObj = (server?.roles || []).find(r => r.id === callerRoleId);
      const canMove = isOwner || Boolean(callerRoleObj?.permissions?.administrator || callerRoleObj?.permissions?.manageChannels || callerRoleObj?.permissions?.kickMembers) || caller.id === targetUserId;

      if (!canMove) {
        return callback && callback({ success: false, error: 'Sem permissão para mover membros de canal.' });
      }

      // Find target user
      let targetSockId = null;
      let targetUser = null;
      for (const [sockId, u] of activeSockets.entries()) {
        if (u.id === targetUserId || u.socketId === targetUserId) {
          targetSockId = sockId;
          targetUser = u;
          break;
        }
      }

      if (!targetUser || !targetSockId) {
        return callback && callback({ success: false, error: 'Usuário não encontrado ou offline' });
      }

      // Clean old room from voiceRooms
      for (const [rId, rUsers] of voiceRooms.entries()) {
        const hasTarget = rUsers.some((u) => u.id === targetUser.id || u.socketId === targetSockId);
        if (hasTarget) {
          const filtered = rUsers.filter((u) => u.id !== targetUser.id && u.socketId !== targetSockId);
          if (filtered.length === 0) {
            voiceRooms.delete(rId);
          } else {
            voiceRooms.set(rId, filtered);
          }
          const tSock = io.sockets.sockets.get(targetSockId);
          if (tSock) {
            tSock.leave(`voice-${rId}`);
          }
          io.to(`voice-${rId}`).emit('user-left-voice', {
            socketId: targetSockId,
            userId: targetUser.id,
            channelId: rId
          });
        }
      }

      // Add to new room in voiceRooms
      targetUser.activeVoiceChannel = targetChannelId;
      if (!voiceRooms.has(targetChannelId)) {
        voiceRooms.set(targetChannelId, []);
      }
      const newRoom = voiceRooms.get(targetChannelId).filter((u) => u.id !== targetUser.id && u.socketId !== targetSockId);
      newRoom.push(targetUser);
      voiceRooms.set(targetChannelId, newRoom);

      const targetSock = io.sockets.sockets.get(targetSockId);
      if (targetSock) {
        targetSock.join(`voice-${targetChannelId}`);
      }

      // Broadcast new room state immediately to everyone
      io.emit('voice-rooms-updated', {
        voiceRooms: Object.fromEntries(voiceRooms)
      });

      // Command target client to switch voice streams
      io.to(targetSockId).emit('moved-to-voice-channel', { channelId: targetChannelId, serverId });

      if (callback) callback({ success: true });
    });

    // Disconnect a user from voice channel (Owner / Admin / Mod)
    socket.on('disconnect-voice-user', ({ targetUserId, serverId }, callback) => {
      const caller = activeSockets.get(socket.id);
      if (!caller) return;
      const server = servers.find((s) => s.id === serverId);
      const isOwner = server && server.ownerId === caller.id;
      const callerRoleId = server?.memberRoles?.[caller.id] || (isOwner ? 'role-admin' : 'role-member');
      const callerRoleObj = (server?.roles || []).find(r => r.id === callerRoleId);
      const canDisconnect = isOwner || Boolean(callerRoleObj?.permissions?.administrator || callerRoleObj?.permissions?.kickMembers);

      if (!canDisconnect) {
        return callback && callback({ success: false, error: 'Sem permissão.' });
      }

      for (const [sockId, u] of activeSockets.entries()) {
        if (u.id === targetUserId || u.socketId === targetUserId) {
          const targetSocket = io.sockets.sockets.get(sockId);
          if (targetSocket) {
            leaveCurrentVoice(targetSocket, u, io, voiceRooms);
            targetSocket.emit('force-disconnected-from-voice');
          }
          break;
        }
      }
      if (callback) callback({ success: true });
    });

    socket.on('webrtc-offer', ({ targetSocketId, offer, isScreenShare }) => {
      const sender = activeSockets.get(socket.id);
      io.to(targetSocketId).emit('webrtc-offer', {
        senderSocketId: socket.id,
        senderUser: sender,
        offer,
        isScreenShare
      });
    });

    socket.on('webrtc-answer', ({ targetSocketId, answer, isScreenShare }) => {
      io.to(targetSocketId).emit('webrtc-answer', {
        senderSocketId: socket.id,
        answer,
        isScreenShare
      });
    });

    socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, isScreenShare }) => {
      io.to(targetSocketId).emit('webrtc-ice-candidate', {
        senderSocketId: socket.id,
        candidate,
        isScreenShare
      });
    });

    socket.on('speaking-state', ({ isSpeaking }) => {
      const user = activeSockets.get(socket.id);
      if (user && user.activeVoiceChannel) {
        socket.to(`voice-${user.activeVoiceChannel}`).emit('user-speaking', {
          socketId: socket.id,
          userId: user.id,
          isSpeaking
        });
      }
    });

    socket.on('update-voice-status', ({ isMuted, isDeafened, isScreenSharing }) => {
      const user = activeSockets.get(socket.id);
      if (user) {
        if (typeof isMuted === 'boolean') user.isMuted = isMuted;
        if (typeof isDeafened === 'boolean') user.isDeafened = isDeafened;
        if (typeof isScreenSharing === 'boolean') user.isScreenSharing = isScreenSharing;

        if (user.activeVoiceChannel) {
          io.to(`voice-${user.activeVoiceChannel}`).emit('user-voice-status-updated', {
            user
          });
        }
        io.emit('voice-rooms-updated', {
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }
    });

    // 5. Music Bot Direct Controls
    socket.on('music-search', async ({ query }, callback) => {
      try {
        const results = await musicBot.searchTracks(query);
        callback({ success: true, results });
      } catch (err) {
        callback({ success: false, error: err.message });
      }
    });

    socket.on('music-control', async ({ action, channelId, query, volume }) => {
      const user = activeSockets.get(socket.id);
      const targetChannel = channelId || (user ? user.activeVoiceChannel : null);
      if (!targetChannel || !user) return;

      switch (action) {
        case 'play':
          await musicBot.play(targetChannel, query || 'lofi', user);
          break;
        case 'pause':
          musicBot.pause(targetChannel);
          break;
        case 'resume':
          musicBot.resume(targetChannel);
          break;
        case 'skip':
          musicBot.skip(targetChannel);
          break;
        case 'stop':
          musicBot.stop(targetChannel);
          break;
        case 'volume':
          musicBot.setVolume(targetChannel, volume);
          break;
      }
    });

    // 6. Watch Together Realtime Sync
    socket.on('watch-together-action', ({ channelId, action, payload }) => {
      const user = activeSockets.get(socket.id);
      const targetChannel = channelId || (user ? user.activeVoiceChannel : null);
      if (!targetChannel || !user) return;

      const defaultState = { isActive: false, url: '', isPlaying: false, currentTime: 0, queue: [], participants: [], hostId: null };
      let current = watchTogetherRooms.get(targetChannel) || { ...defaultState };

      switch (action) {
        case 'start':
          current = {
            ...defaultState,
            isActive: true,
            url: payload.url,
            isPlaying: true,
            hostId: user.id,
            participants: [user.id]
          };
          break;
        case 'sync':
          // Only host should sync playback state to avoid conflicts
          if (current.hostId === user.id) {
            current = { ...current, ...payload };
          }
          break;
        case 'join':
          if (current.isActive && !current.participants.includes(user.id)) {
            current.participants.push(user.id);
          }
          break;
        case 'leave':
          current.participants = current.participants.filter(id => id !== user.id);
          if (current.participants.length === 0) {
            current = { ...defaultState }; // End watchparty if empty
          } else if (current.hostId === user.id) {
            // Pass host to someone else
            current.hostId = current.participants[0];
          }
          break;
        case 'enqueue':
          if (current.isActive && payload.url) {
            if (!current.url) {
              current.url = payload.url;
              current.isPlaying = true;
              current.currentTime = 0;
            } else {
              current.queue.push(payload.url);
            }
          }
          break;
        case 'next':
          if (current.isActive && current.hostId === user.id) {
            if (current.queue.length > 0) {
              const nextUrl = current.queue.shift();
              current.url = nextUrl;
              current.isPlaying = true;
              current.currentTime = 0;
            } else {
              current = { ...defaultState }; // Queue ended, stop watchparty
            }
          }
          break;
        case 'end':
          if (current.hostId === user.id) {
            current = { ...defaultState };
          }
          break;
      }

      watchTogetherRooms.set(targetChannel, current);

      io.to(`voice-${targetChannel}`).emit('watch-together-state-update', {
        channelId: targetChannel,
        state: current
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected] ID: ${socket.id}`);
      const user = activeSockets.get(socket.id);
      if (user) {
        if (user.activeVoiceChannel) {
          leaveCurrentVoice(socket, user, io, voiceRooms);
        }
        activeSockets.delete(socket.id);
        io.emit('user-status-changed', { user: { ...user, status: 'offline' } });
      }
    });
  });
}

function leaveCurrentVoice(socket, user, io, voiceRooms) {
  const socketId = socket?.id;
  const userId = user?.id;

  for (const [channelId, room] of voiceRooms.entries()) {
    const hasMatch = room.some((u) => (socketId && u.socketId === socketId) || (userId && u.id === userId));
    if (hasMatch) {
      const updated = room.filter((u) => (!socketId || u.socketId !== socketId) && (!userId || u.id !== userId));
      if (updated.length === 0) {
        voiceRooms.delete(channelId);
      } else {
        voiceRooms.set(channelId, updated);
      }

      if (socket) {
        socket.leave(`voice-${channelId}`);
        socket.to(`voice-${channelId}`).emit('user-left-voice', {
          socketId: socketId,
          userId: userId || 'unknown',
          channelId
        });
      }
    }
  }

  if (user) {
    user.activeVoiceChannel = null;
    user.isScreenSharing = false;
  }

  io.emit('voice-rooms-updated', {
    voiceRooms: Object.fromEntries(voiceRooms)
  });
}

async function handleBotCommand(channelId, content, user, io, musicBot, messageHistory, storage, servers, registeredUsers) {
  const parts = content.trim().split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  let botReply = null;
  const targetVoiceChannel = user.activeVoiceChannel || 'v-music';

  switch (command) {
    case '/play':
    case '/p':
      if (!args) {
        botReply = 'Uso correto: `/play <link do YouTube / Spotify / SoundCloud ou nome>`';
      } else {
        const res = await musicBot.play(targetVoiceChannel, args, user);
        botReply =
          res.status === 'playing'
            ? `Reproduzindo agora: **${res.track.title}** (${res.track.artist || 'Música'})`
            : `Adicionado à fila: **${res.track.title}** (Posição #${res.queuePosition})`;
      }
      break;

    case '/skip':
    case '/s':
      const skipped = musicBot.skip(targetVoiceChannel);
      botReply = skipped.currentTrack
        ? `Faixa pulada. Reproduzindo: **${skipped.currentTrack.title}**`
        : 'Fila finalizada. O reprodutor foi parado.';
      break;

    case '/pause':
      musicBot.pause(targetVoiceChannel);
      botReply = 'Reprodução pausada. Digite `/resume` para continuar.';
      break;

    case '/resume':
      musicBot.resume(targetVoiceChannel);
      botReply = 'Reprodução continuada.';
      break;

    case '/stop':
      musicBot.stop(targetVoiceChannel);
      botReply = 'Reprodução finalizada e fila limpa.';
      break;

    case '/queue':
    case '/q':
      const player = musicBot.getPlayer(targetVoiceChannel);
      if (!player.currentTrack) {
        botReply = 'Nenhuma faixa sendo reproduzida no momento.';
      } else {
        let text = `Tocando agora: **${player.currentTrack.title}**\n\nFila:\n`;
        if (player.queue.length === 0) {
          text += '_Nenhuma outra música na fila._';
        } else {
          player.queue.forEach((t, i) => {
            text += `${i + 1}. **${t.title}** (Pedido por: ${t.requestedBy})\n`;
          });
        }
        botReply = text;
      }
      break;

    case '/help':
      botReply = `**Comandos do PulseCord:**
- \`/play <busca ou link>\` - Toca música do YouTube, Spotify, SoundCloud ou estações
- \`/pause\` / \`/resume\` - Pausa ou despausa a reprodução
- \`/skip\` - Pula para a próxima faixa
- \`/queue\` - Exibe as faixas na fila
- \`/stop\` - Para e limpa a fila`;
      break;
  }

  if (botReply) {
    const replyMsg = {
      id: `msg-bot-${Date.now()}`,
      channelId,
      author: {
        id: 'bot-music',
        username: 'MusicBot',
        avatar: 'MB',
        avatarColor: 'from-amber-500 to-orange-600',
        roleColor: '#f59e0b',
        roleName: 'MUSIC BOT',
        isBot: true
      },
      content: botReply,
      attachments: [],
      timestamp: new Date().toISOString(),
      reactions: []
    };

    if (!messageHistory.has(channelId)) {
      messageHistory.set(channelId, []);
    }
    messageHistory.get(channelId).push(replyMsg);
    storage.saveData(registeredUsers, servers, messageHistory);

    io.emit('new-message', replyMsg);
  }
}
