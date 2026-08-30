import { MusicBotManager, PRESET_STREAMS } from './musicService.js';

// In-Memory Database (with easy Redis synchronization support)
const DEFAULT_ROLES = [
  {
    id: 'role-admin',
    name: '👑 Dono / Admin',
    color: '#f23f43',
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
    name: '🛡️ Moderador',
    color: '#5865f2',
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
    name: '⭐ VIP / DJ',
    color: '#f0b232',
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
    color: '#949ba4',
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
    icon: '⚡',
    ownerId: 'system-owner',
    roles: DEFAULT_ROLES,
    channels: [
      { id: 'c-general', name: 'geral', type: 'text', topic: 'Conversa geral e boas-vindas' },
      { id: 'c-bot', name: 'comandos-musica', type: 'text', topic: 'Use /play, /skip, /queue aqui' },
      { id: 'c-screens', name: 'compartilhamento', type: 'text', topic: 'Prints, gravações e links' },
      { id: 'v-lounge', name: '🔊 Sala de Estar', type: 'voice', userLimit: 0 },
      { id: 'v-gaming', name: '🎮 Jogos & Squad', type: 'voice', userLimit: 10 },
      { id: 'v-music', name: '🎵 Estúdio Musical 24/7', type: 'voice', userLimit: 0 }
    ],
    members: []
  },
  {
    id: 'server-2',
    name: 'Dev & Games Hub',
    icon: '🚀',
    ownerId: 'system-owner',
    roles: DEFAULT_ROLES,
    channels: [
      { id: 'c-dev-general', name: 'dev-chat', type: 'text', topic: 'Discussões sobre código e WebRTC' },
      { id: 'v-dev-voice', name: '🔊 Pair Programming', type: 'voice', userLimit: 5 }
    ],
    members: []
  }
];

export function setupSignaling(io) {
  const musicBot = new MusicBotManager(io);

  // Global state
  const servers = JSON.parse(JSON.stringify(INITIAL_SERVERS));
  // Map of socketId -> User profile
  const users = new Map();
  // Map of channelId -> Array of userIds currently in voice
  const voiceRooms = new Map();
  // Map of channelId -> Array of messages
  const messageHistory = new Map();

  // Seed some welcome messages
  messageHistory.set('c-general', [
    {
      id: 'msg-welcome',
      author: {
        id: 'bot-pulse',
        username: 'PulseBot',
        avatar: '🤖',
        roleColor: '#5865f2',
        roleName: 'BOT',
        isBot: true
      },
      content: '👋 Bem-vindo ao **PulseCord**! Este aplicativo suporta **voz em tempo real**, **compartilhamento de tela em 60fps**, **cargos configuráveis** e **bot de música**. Conecte-se em um canal de voz para testar!',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      attachments: []
    }
  ]);

  messageHistory.set('c-bot', [
    {
      id: 'msg-bot-intro',
      author: {
        id: 'bot-music',
        username: 'RythmPulse',
        avatar: '🎵',
        roleColor: '#f0b232',
        roleName: 'MUSIC BOT',
        isBot: true
      },
      content: '🎶 **Bot de Música Online!**\nUse os comandos:\n- `/play <música ou lofi/synthwave/gaming/URL>`\n- `/pause` e `/resume`\n- `/skip` para pular\n- `/queue` para ver a fila\n- `/stop` para parar',
      timestamp: new Date().toISOString(),
      attachments: []
    }
  ]);

  io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    // 1. User Join / Init
    socket.on('user-init', (userData, callback) => {
      const user = {
        id: userData.id || socket.id,
        socketId: socket.id,
        username: userData.username || `User_${socket.id.slice(0, 4)}`,
        avatar: userData.avatar || '👤',
        roleId: userData.roleId || 'role-member',
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        activeVoiceChannel: null,
        status: 'online'
      };

      users.set(socket.id, user);

      // Join default server member list
      servers.forEach(s => {
        if (!s.members.some(m => m.id === user.id)) {
          s.members.push(user);
        }
      });

      if (callback) {
        callback({
          user,
          servers,
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }

      // Broadcast user connected
      io.emit('user-status-changed', { user });
    });

    // 2. Server & Channels Management
    socket.on('create-server', ({ name, icon }, callback) => {
      const user = users.get(socket.id);
      const newServer = {
        id: `server-${Date.now()}`,
        name: name || 'Novo Servidor',
        icon: icon || '🛡️',
        ownerId: user ? user.id : socket.id,
        roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
        channels: [
          { id: `c-${Date.now()}-1`, name: 'geral', type: 'text', topic: 'Boas vindas ao novo servidor!' },
          { id: `v-${Date.now()}-1`, name: '🔊 Geral', type: 'voice', userLimit: 0 }
        ],
        members: user ? [user] : []
      };

      servers.push(newServer);
      io.emit('server-created', newServer);
      if (callback) callback(newServer);
    });

    socket.on('create-channel', ({ serverId, name, type, topic, userLimit }, callback) => {
      const server = servers.find(s => s.id === serverId);
      if (!server) return;

      const newChannel = {
        id: `${type[0]}-${Date.now()}`,
        name: name.toLowerCase().replace(/\s+/g, '-'),
        type: type || 'text',
        topic: topic || '',
        userLimit: userLimit || 0
      };

      server.channels.push(newChannel);
      io.emit('channel-created', { serverId, channel: newChannel });
      if (callback) callback(newChannel);
    });

    socket.on('update-roles', ({ serverId, roles }, callback) => {
      const server = servers.find(s => s.id === serverId);
      if (server) {
        server.roles = roles;
        io.emit('server-roles-updated', { serverId, roles });
        if (callback) callback({ success: true });
      }
    });

    socket.on('assign-user-role', ({ serverId, userId, roleId }) => {
      const server = servers.find(s => s.id === serverId);
      if (server) {
        const member = server.members.find(m => m.id === userId);
        if (member) {
          member.roleId = roleId;
          io.emit('user-role-assigned', { serverId, userId, roleId });
        }
      }
    });

    // 3. Text Chat & Messages
    socket.on('fetch-messages', ({ channelId }, callback) => {
      const msgs = messageHistory.get(channelId) || [];
      if (callback) callback(msgs);
    });

    socket.on('send-message', ({ channelId, content, attachments }) => {
      const user = users.get(socket.id);
      if (!user || !content?.trim() && (!attachments || attachments.length === 0)) return;

      // Determine user's role info for badge
      const role = DEFAULT_ROLES.find(r => r.id === user.roleId) || DEFAULT_ROLES[3];

      const message = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        channelId,
        author: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
          roleId: user.roleId,
          roleColor: role.color,
          roleName: role.name
        },
        content,
        attachments: attachments || [],
        timestamp: new Date().toISOString(),
        reactions: []
      };

      if (!messageHistory.has(channelId)) {
        messageHistory.set(channelId, []);
      }
      messageHistory.get(channelId).push(message);

      // Keep history bounded
      if (messageHistory.get(channelId).length > 200) {
        messageHistory.get(channelId).shift();
      }

      io.emit('new-message', message);

      // Check if message is a bot command
      if (content.startsWith('/')) {
        handleBotCommand(channelId, content, user, io, musicBot, messageHistory);
      }
    });

    // 4. Voice Channels & WebRTC Signaling
    socket.on('join-voice', ({ channelId, serverId }, callback) => {
      const user = users.get(socket.id);
      if (!user) return;

      // If user was already in another voice channel, leave it first
      if (user.activeVoiceChannel && user.activeVoiceChannel !== channelId) {
        leaveCurrentVoice(socket, user, io, voiceRooms);
      }

      user.activeVoiceChannel = channelId;
      socket.join(`voice-${channelId}`);

      if (!voiceRooms.has(channelId)) {
        voiceRooms.set(channelId, []);
      }

      const roomUsers = voiceRooms.get(channelId);
      // Remove any duplicate
      const existingIdx = roomUsers.findIndex(u => u.id === user.id);
      if (existingIdx !== -1) roomUsers.splice(existingIdx, 1);

      roomUsers.push(user);

      // Notify others in room
      socket.to(`voice-${channelId}`).emit('user-joined-voice', {
        user,
        channelId
      });

      // Get music bot player state for this channel
      const musicPlayer = musicBot.getPlayer(channelId);

      if (callback) {
        callback({
          success: true,
          usersInRoom: roomUsers.filter(u => u.socketId !== socket.id),
          musicPlayer
        });
      }

      io.emit('voice-rooms-updated', {
        voiceRooms: Object.fromEntries(voiceRooms)
      });
    });

    socket.on('leave-voice', () => {
      const user = users.get(socket.id);
      if (user && user.activeVoiceChannel) {
        leaveCurrentVoice(socket, user, io, voiceRooms);
      }
    });

    // WebRTC Peer-to-Peer Signaling forwarding
    socket.on('webrtc-offer', ({ targetSocketId, offer, isScreenShare }) => {
      const sender = users.get(socket.id);
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

    // Voice speaking state / Mute / Screen share state
    socket.on('speaking-state', ({ isSpeaking }) => {
      const user = users.get(socket.id);
      if (user && user.activeVoiceChannel) {
        socket.to(`voice-${user.activeVoiceChannel}`).emit('user-speaking', {
          socketId: socket.id,
          userId: user.id,
          isSpeaking
        });
      }
    });

    socket.on('update-voice-status', ({ isMuted, isDeafened, isScreenSharing }) => {
      const user = users.get(socket.id);
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
    socket.on('music-control', ({ action, channelId, query, volume }) => {
      const user = users.get(socket.id);
      const targetChannel = channelId || (user ? user.activeVoiceChannel : null);
      if (!targetChannel) return;

      switch (action) {
        case 'play':
          musicBot.play(targetChannel, query || 'lofi', user);
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

    // Disconnect handler
    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected] ID: ${socket.id}`);
      const user = users.get(socket.id);
      if (user) {
        if (user.activeVoiceChannel) {
          leaveCurrentVoice(socket, user, io, voiceRooms);
        }
        users.delete(socket.id);
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
    const updated = room.filter(u => u.socketId !== socket.id);
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

function handleBotCommand(channelId, content, user, io, musicBot, messageHistory) {
  const parts = content.trim().split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  let botReply = null;
  const targetVoiceChannel = user.activeVoiceChannel || 'v-music';

  switch (command) {
    case '/play':
    case '/p':
      if (!args) {
        botReply = '⚠️ **Uso correto:** `/play <nome da música ou lofi / synthwave / gaming / link>`';
      } else {
        const res = musicBot.play(targetVoiceChannel, args, user);
        botReply = res.status === 'playing'
          ? `🎵 **Tocando agora:** \`${res.track.title}\` no canal de voz!`
          : `📋 **Adicionado à fila:** \`${res.track.title}\` (Posição #${res.queuePosition})`;
      }
      break;

    case '/skip':
    case '/s':
      const skipped = musicBot.skip(targetVoiceChannel);
      botReply = skipped.currentTrack
        ? `⏭️ **Música pulada!** Tocando agora: \`${skipped.currentTrack.title}\``
        : '⏹️ **Fila vazia!** O bot parou a reprodução.';
      break;

    case '/pause':
      musicBot.pause(targetVoiceChannel);
      botReply = '⏸️ **Música pausada.** Use `/resume` para continuar.';
      break;

    case '/resume':
      musicBot.resume(targetVoiceChannel);
      botReply = '▶️ **Música retomada!**';
      break;

    case '/stop':
      musicBot.stop(targetVoiceChannel);
      botReply = '⏹️ **Música parada e fila limpa.**';
      break;

    case '/queue':
    case '/q':
      const player = musicBot.getPlayer(targetVoiceChannel);
      if (!player.currentTrack) {
        botReply = '📭 Nenhuma música está tocando no momento.';
      } else {
        let text = `🎶 **Tocando agora:** \`${player.currentTrack.title}\`\n\n📜 **Fila:**\n`;
        if (player.queue.length === 0) {
          text += '_Nenhuma outra música na fila._';
        } else {
          player.queue.forEach((t, i) => {
            text += `${i + 1}. \`${t.title}\` (Pedido por: ${t.requestedBy})\n`;
          });
        }
        botReply = text;
      }
      break;

    case '/help':
      botReply = `📖 **Comandos do PulseCord Bot:**
- \`/play <busca/link>\` - Toca música ou rádio lofi/synthwave
- \`/pause\` / \`/resume\` - Pausa ou despausa
- \`/skip\` - Pula a música atual
- \`/queue\` - Mostra a lista de músicas
- \`/stop\` - Para e limpa a fila
- \`/roles\` - Informações de cargos e permissões`;
      break;

    case '/roles':
      botReply = `🛡️ **Cargos do Servidor:**
1. 👑 **Dono / Admin** (Vermelho): Acesso total
2. 🛡️ **Moderador** (Azul): Gerenciar canais e moderação
3. ⭐ **VIP / DJ** (Dourado): Controle prioritário do bot de música
4. **Membro** (Cinza): Chat, voz e compartilhamento de tela`;
      break;
  }

  if (botReply) {
    setTimeout(() => {
      const replyMsg = {
        id: `msg-bot-${Date.now()}`,
        channelId,
        author: {
          id: 'bot-music',
          username: 'RythmPulse',
          avatar: '🎵',
          roleColor: '#f0b232',
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
      io.emit('new-message', replyMsg);
    }, 400);
  }
}
