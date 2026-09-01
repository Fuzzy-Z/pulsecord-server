import { MusicBotManager, PRESET_STREAMS } from './musicService.js';
import { StorageManager } from './storage.js';

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
        id: 'bot-pulse',
        username: 'PulseBot',
        avatar: 'PB',
        roleColor: '#6366f1',
        roleName: 'SISTEMA',
        isBot: true
      },
      content: 'Bem-vindo ao **PulseCord**! Voz em tempo real com supressão de ruído inteligente, compartilhamento em 60fps e bot de música integrado (Spotify, YouTube, SoundCloud).',
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

  // Load persisted database (from Redis if available, or pulsecord-db.json)
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

  const formatServerWithMembers = (s) => {
    let memberList = [];
    if (s.id === 'server-1') {
      const allKnown = [...registeredUsers];
      for (const act of activeSockets.values()) {
        if (!allKnown.some((u) => u.id === act.id)) {
          allKnown.push(act);
        }
      }
      memberList = allKnown.map(sanitizeUser).filter(Boolean);
    } else {
      const ids = new Set([s.ownerId, ...(s.memberIds || [])]);
      memberList = Array.from(ids)
        .map((id) => {
          const u = registeredUsers.find((r) => r.id === id) || Array.from(activeSockets.values()).find((act) => act.id === id);
          return sanitizeUser(u);
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

  // 1-Hour Image Attachment Auto-Deletion routine
  const pruneOldAttachments = () => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    let prunedCount = 0;

    for (const [channelId, msgs] of messageHistory.entries()) {
      msgs.forEach((msg) => {
        if (msg.attachments && msg.attachments.length > 0) {
          const msgTime = new Date(msg.timestamp).getTime();
          if (now - msgTime > ONE_HOUR) {
            msg.attachments = [];
            msg.attachmentExpired = true;
            prunedCount++;
          }
        }
      });
    }

    if (prunedCount > 0) {
      console.log(`[Storage] Auto-pruned ${prunedCount} image attachment(s) older than 1 hour.`);
      storage.saveData(registeredUsers, servers, messageHistory);
      io.emit('attachments-pruned');
    }
  };

  setInterval(pruneOldAttachments, 60 * 1000);

  io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // ==========================================
    // 1. AUTHENTICATION & LOGIN / REGISTER
    // ==========================================

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
    });

    // User Profile Update
    socket.on('update-profile', (profileData, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return callback && callback({ success: false, error: 'Not authenticated' });

      const allowedFields = ['displayName', 'bio', 'pronouns', 'avatarColor', 'avatarUrl', 'bannerUrl', 'avatarDecoration', 'profileEffect', 'customStatus', 'gameStatus', 'username', 'appTheme', 'compactMode', 'clipSettings'];
      
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

      if (callback) {
        if (userIndex !== -1) {
          callback({ success: true, user: { ...registeredUsers[userIndex], password: undefined } });
        } else {
          callback({ success: true, user: activeUser });
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

    // Join an Existing Server by Server ID
    socket.on('join-server', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;

      const targetServer = servers.find((s) => s.id === serverId);
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      if (!targetServer.memberIds) targetServer.memberIds = [];
      if (!targetServer.memberIds.includes(user.id)) {
        targetServer.memberIds.push(user.id);
      }

      storage.saveData(registeredUsers, servers, messageHistory);

      const formattedTarget = formatServerWithMembers(targetServer);
      socket.emit('server-created', formattedTarget);
      if (callback) callback({ success: true, server: formattedTarget });
    });

    socket.on('create-channel', ({ serverId, name, type, topic, userLimit }, callback) => {
      const server = servers.find((s) => s.id === serverId);
      if (!server) return;

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
      const server = servers.find((s) => s.id === serverId);
      if (server) {
        server.roles = roles;
        storage.saveData(registeredUsers, servers, messageHistory);

        io.emit('server-roles-updated', { serverId, roles });
        if (callback) callback({ success: true });
      }
    });

    // ==========================================
    // 3. TEXT CHAT & MESSAGES
    // ==========================================
    socket.on('fetch-messages', ({ channelId }, callback) => {
      const msgs = messageHistory.get(channelId) || [];
      if (callback) callback(msgs);
    });

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
          avatar: user.avatar,
          avatarColor: user.avatarColor,
          roleId: user.roleId,
          roleColor: role.color,
          roleName: role.name
        },
        content: content || '',
        attachments: attachments || [],
        timestamp: new Date().toISOString(),
        reactions: []
      };

      if (!messageHistory.has(channelId)) {
        messageHistory.set(channelId, []);
      }
      messageHistory.get(channelId).push(message);

      if (messageHistory.get(channelId).length > 250) {
        messageHistory.get(channelId).shift();
      }

      storage.saveData(registeredUsers, servers, messageHistory);
      io.emit('new-message', message);

      if (content && content.startsWith('/')) {
        handleBotCommand(channelId, content, user, io, musicBot, messageHistory, storage, servers, registeredUsers);
      }
    });

    // ==========================================
    // 4. VOICE CHANNELS & WEBRTC
    // ==========================================
    socket.on('join-voice', ({ channelId, serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;

      if (user.activeVoiceChannel && user.activeVoiceChannel !== channelId) {
        leaveCurrentVoice(socket, user, io, voiceRooms);
      }

      user.activeVoiceChannel = channelId;
      socket.join(`voice-${channelId}`);

      if (!voiceRooms.has(channelId)) {
        voiceRooms.set(channelId, []);
      }

      const roomUsers = voiceRooms.get(channelId);
      const existingIdx = roomUsers.findIndex((u) => u.id === user.id);
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
          usersInRoom: roomUsers.filter((u) => u.socketId !== socket.id),
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
      if (user && user.activeVoiceChannel) {
        leaveCurrentVoice(socket, user, io, voiceRooms);
      }
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
        if (callback) callback({ success: true, results });
      } catch (err) {
        if (callback) callback({ success: false, error: err.message });
      }
    });

    socket.on('music-control', async ({ action, channelId, query, volume }) => {
      const user = activeSockets.get(socket.id);
      const targetChannel = channelId || (user ? user.activeVoiceChannel : null);
      if (!targetChannel) return;

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
  const channelId = user.activeVoiceChannel;
  if (!channelId) return;

  socket.leave(`voice-${channelId}`);
  user.activeVoiceChannel = null;
  user.isScreenSharing = false;

  if (voiceRooms.has(channelId)) {
    const room = voiceRooms.get(channelId);
    const updated = room.filter((u) => u.socketId !== socket.id);
    if (updated.length === 0) {
      voiceRooms.delete(channelId);
    } else {
      voiceRooms.set(channelId, updated);
    }
  }

  socket.to(`voice-${channelId}`).emit('user-left-voice', {
    socketId: socket.id,
    userId: user.id,
    channelId
  });

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
