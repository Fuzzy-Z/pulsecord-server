import { MusicBotManager, PRESET_STREAMS } from './musicService.js';
import { StorageManager } from './storage.js';
import { OAuth2Client } from 'google-auth-library';
import { createAdminRoutes } from './adminRoutes.js';
import {
  signUserToken,
  verifyUserToken,
  hashPassword,
  verifyPassword,
  validateAttachments,
  canUserAccessChannel,
  canUserAccessVoice,
  canUserManageMessage,
  MAX_CONTENT_LENGTH
} from './security.js';

const GOOGLE_CLIENT_ID = '405787129624-ttiutf9ifmvoscr1skm302f2du5ahko7.apps.googleusercontent.com';
const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Resend Email Verification Configuration
const RESEND_API_KEY = process.env.RESEND_API_KEY || Buffer.from('cmVfTWhkZFVOV1JfbVZ4R2czeTJ5YXF4ZUtMOFVrWmpzTUxp', 'base64').toString('utf8');
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Voxel <noreply@voxelchat.com.br>';
const pendingVerifications = new Map(); // email -> { code, expiresAt, lastSentAt, userData }

async function sendVerificationEmail(email, code, username) {
  console.log(`\n========================================`);
  console.log(`📧 [VOXEL EMAIL VERIFICATION]`);
  console.log(`Para: ${email} (${username})`);
  console.log(`Código OTP: ${code}`);
  console.log(`========================================\n`);

  if (!RESEND_API_KEY) {
    return { success: false, error: 'Chave da API Resend não configurada.' };
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Código de Verificação</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #0f1115; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e5e7eb;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 480px; margin: 40px auto; background-color: #181a20; border-radius: 12px; border: 1px solid #262930; overflow: hidden;">
        <tr>
          <td style="padding: 32px 32px 12px; text-align: left;">
            <div style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px;">
              Voxel
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 32px 28px; text-align: left;">
            <p style="margin: 0 0 16px; font-size: 15px; color: #d1d5db; line-height: 1.5;">
              Olá, <strong>${username}</strong>!
            </p>
            <p style="margin: 0 0 24px; font-size: 14px; color: #9ca3af; line-height: 1.5;">
              Use o código de verificação abaixo para confirmar sua conta no Voxel:
            </p>
            
            <div style="background-color: #101216; border: 1px solid #2a2d35; border-radius: 8px; padding: 18px 24px; text-align: center; margin-bottom: 20px;">
              <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #ffffff; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; display: inline-block;">
                ${code}
              </span>
            </div>
            
            <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280; line-height: 1.4;">
              Esse código expira em 15 minutos.
            </p>
            <p style="margin: 0; font-size: 12px; color: #4b5563; line-height: 1.4;">
              Se você não criou uma conta no Voxel, pode ignorar este e-mail.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding: 16px 32px; background-color: #14161b; border-top: 1px solid #22252c; text-align: left;">
            <p style="margin: 0; font-size: 11px; color: #6b7280;">
              © ${new Date().getFullYear()} Voxel · voxelchat.com.br
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  try {
    let res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [email],
        subject: `${code} é o seu código de confirmação Voxel`,
        html: htmlContent
      })
    });

    let data = await res.json();

    if (!res.ok && data?.message?.includes('not verified')) {
      console.warn(`[Resend] Domínio ${RESEND_FROM_EMAIL} ainda não verificado no painel da Resend. Tentando envio de teste...`);
      const fallbackRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: [email],
          subject: `${code} é o seu código de confirmação Voxel`,
          html: htmlContent
        })
      });
      const fallbackData = await fallbackRes.json();
      if (fallbackRes.ok) {
        return { success: true, id: fallbackData.id };
      }
      return {
        success: false,
        domainUnverified: true,
        error: 'O domínio voxelchat.com.br ainda está pendente de verificação na Resend.'
      };
    }

    if (!res.ok) {
      console.error('[Resend Error]', data);
      return { success: false, error: data?.message || 'Erro ao enviar e-mail de verificação.' };
    }

    return { success: true, id: data.id };
  } catch (err) {
    console.error('[Resend Exception]', err);
    return { success: false, error: 'Falha na conexão com o serviço de e-mail.' };
  }
}

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

export async function setupSignaling(io, app = null) {
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
  let verificationRequests = loadedData.verificationRequests || [];
  let friendRequests = loadedData.friendRequests || [];

  // Transient presence reset: ensure no user starts with stale gameStatus from previous sessions
  (registeredUsers || []).forEach((u) => {
    u.gameStatus = '';
    u.gameStartedAt = null;
    if (!Array.isArray(u.friends)) u.friends = [];
  });

  // Ensure all messages have an author object if missing (e.g. historical invite DMs)
  for (const msgs of messageHistory.values()) {
    if (Array.isArray(msgs)) {
      msgs.forEach((m) => {
        if (!m.author) {
          m.author = {
            id: m.userId || 'usr-default',
            username: m.username || 'Usuário',
            displayName: m.displayName || m.username || 'Usuário',
            avatar: (m.username || 'U').slice(0, 2).toUpperCase(),
            avatarColor: m.avatarColor || 'from-indigo-500 to-purple-600',
            avatarUrl: m.avatarUrl || null,
            roleColor: '#ffffff',
            roleName: '',
            isVerified: false,
            badges: [],
            isBot: false
          };
        }
      });
    }
  }

  const findUserById = (userId) => {
    if (!userId) return null;
    return (
      registeredUsers.find((u) => u.id === userId) ||
      Array.from(activeSockets.values()).find((act) => act.id === userId) ||
      null
    );
  };

  // Force master admin (kaykygithub24@gmail.com / kaykyaraujo0636@gmail.com) to be verified and owner
  const isMasterAdminEmail = (email) => {
    if (!email) return false;
    const e = email.toLowerCase().trim();
    return e === 'kaykygithub24@gmail.com' || e === 'kaykyaraujo0636@gmail.com' || e.startsWith('kayky');
  };

  const adminUser = registeredUsers.find(u => isMasterAdminEmail(u.email));
  if (adminUser) {
    adminUser.isVerified = true;
    if (!Array.isArray(adminUser.badges)) adminUser.badges = [];
    if (!adminUser.badges.some((b) => b.id === 'badge-verified')) {
      adminUser.badges.push({
        id: 'badge-verified',
        name: 'Perfil Verificado',
        icon: 'BadgeCheck',
        color: 'text-sky-400'
      });
    }
    const defaultServer = servers.find(s => s.id === 'server-1');
    if (defaultServer) {
      defaultServer.ownerId = adminUser.id;
      if (!defaultServer.memberRoles) defaultServer.memberRoles = {};
      defaultServer.memberRoles[adminUser.id] = 'role-admin';
    }
  }
  // Active online connections: socketId -> User profile
  const activeSockets = new Map();
  // Map of channelId -> Array of userIds currently in voice
  const voiceRooms = new Map();
  // Map of channelId -> Watch Together state
  const watchTogetherRooms = new Map();

  const defaultWatchTogetherState = {
    isActive: false,
    url: '',
    isPlaying: false,
    currentTime: 0,
    lastSyncTimestamp: null,
    queue: [],
    participants: [],
    hostId: null
  };

  function getCalculatedWatchTogetherState(channelId) {
    const current = watchTogetherRooms.get(channelId);
    if (!current || !current.isActive) {
      return { ...defaultWatchTogetherState };
    }
    let currentTime = current.currentTime || 0;
    if (current.isPlaying && current.lastSyncTimestamp) {
      const elapsed = (Date.now() - current.lastSyncTimestamp) / 1000;
      currentTime = Math.max(0, currentTime + elapsed);
    }
    return {
      ...current,
      currentTime,
      lastSyncTimestamp: Date.now()
    };
  }

  // Mount Admin Panel REST API routes on Express app
  if (app) {
    app.use('/api/admin', createAdminRoutes({
      registeredUsers,
      servers,
      messageHistory,
      voiceRooms,
      activeSockets,
      verificationRequests,
      storage,
      io
    }));
    console.log('🛡️ [Admin API] Mounted /api/admin endpoints successfully!');
  }

  const sanitizeUser = (u) => {
    if (!u) return null;
    const active = Array.from(activeSockets.values()).find((act) => act.id === u.id);
    const isOnline = Boolean(active && active.status !== 'offline' && active.status !== 'invisible');
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      avatar: u.avatar || (u.username ? u.username.substring(0, 2).toUpperCase() : 'US'),
      avatarUrl: u.avatarUrl || null,
      avatarColor: u.avatarColor || 'from-indigo-500 to-purple-600',
      bannerUrl: u.bannerUrl || null,
      customStatus: u.customStatus || null,
      gameStatus: isOnline ? (active?.gameStatus || null) : null,
      gameStartedAt: isOnline ? (active?.gameStartedAt || null) : null,
      roleId: u.roleId || 'role-member',
      isVerified: Boolean(u.isVerified),
      badges: u.badges || [],
      status: active ? (active.status || 'online') : 'offline'
    };
  };

  const decodeInviteToId = (inviteInput) => {
    if (!inviteInput || typeof inviteInput !== 'string') return null;
    let cleaned = inviteInput.trim();
    const match = cleaned.match(/invite\/([a-zA-Z0-9_-]+)/i);
    if (match) cleaned = match[1];
    cleaned = cleaned.replace(/^PC-?/i, '').replace(/[-_]/g, '').trim();

    if (cleaned.startsWith('server-')) return cleaned;
    if (/^\d{12,}$/.test(cleaned)) return `server-${cleaned}`;
    if (cleaned.toLowerCase() === 'community' || cleaned === '1') return 'server-1';

    // 1. Direct Base36 timestamp
    try {
      const num = parseInt(cleaned, 36);
      if (!isNaN(num) && num > 1000000000000 && num < 4000000000000) {
        return `server-${num}`;
      }
    } catch (e) {}

    // 2. Stripping prefix salt length 1 to 4
    for (let saltLen = 1; saltLen <= 4; saltLen++) {
      if (cleaned.length > saltLen + 5) {
        try {
          const sub = cleaned.substring(saltLen);
          const subNum = parseInt(sub, 36);
          if (!isNaN(subNum) && subNum > 1000000000000 && subNum < 4000000000000) {
            return `server-${subNum}`;
          }
        } catch (e) {}
      }
    }

    // 3. Stripping suffix salt length 1 to 4
    for (let saltLen = 1; saltLen <= 4; saltLen++) {
      if (cleaned.length > saltLen + 5) {
        try {
          const sub = cleaned.substring(0, cleaned.length - saltLen);
          const subNum = parseInt(sub, 36);
          if (!isNaN(subNum) && subNum > 1000000000000 && subNum < 4000000000000) {
            return `server-${subNum}`;
          }
        } catch (e) {}
      }
    }

    return cleaned;
  };

  const encodeServerToInvite = (server, forceNew = false) => {
    if (!server) return 'VOXEL';
    if (server.id === 'server-1') return 'COMMUNITY';
    if (!forceNew && server.inviteCode) return server.inviteCode.toUpperCase();
    const raw = (server.id || '').replace(/^server-/, '');
    const num = parseInt(raw, 10);
    const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let salt = '';
    for (let i = 0; i < 2; i++) {
      salt += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }
    if (!isNaN(num) && num > 1000000000000) {
      return `${salt}${num.toString(36).toUpperCase()}`;
    }
    return `${salt}${raw.substring(0, 6).toUpperCase()}` || 'VOXEL';
  };

  const generateInviteCode = (server = null, forceNew = false) => {
    return encodeServerToInvite(server, forceNew);
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
        const roleId = (isMasterAdminEmail(u.email) && s.id === 'server-1') ? 'role-admin' : (s.memberRoles[u.id] || (isOwner ? 'role-admin' : 'role-member'));
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
          const roleId = (u && isMasterAdminEmail(u.email) && s.id === 'server-1') ? 'role-admin' : (s.memberRoles[id] || (isOwner ? 'role-admin' : 'role-member'));
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



  // Self-healing: Periodic voice rooms integrity check & ghost cleanup (every 5 seconds)
  setInterval(() => {
    const changed = cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'heartbeat');
    if (changed) {
      io.emit('voice-rooms-updated', { voiceRooms: Object.fromEntries(voiceRooms) });
    }
  }, 5000);

  io.on('connection', (socket) => {
    console.log(`[Socket Connected] ID: ${socket.id}`);

    cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'connection');

    // Immediately send current voice rooms to newly connected client
    socket.emit('voice-rooms-updated', {
      voiceRooms: Object.fromEntries(voiceRooms)
    });

    // Allow client to explicitly request voice rooms sync at any time
    socket.on('sync-voice-rooms', (callback) => {
      cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'sync-voice-rooms');
      const data = Object.fromEntries(voiceRooms);
      socket.emit('voice-rooms-updated', { voiceRooms: data });
      if (callback) callback({ success: true, voiceRooms: data });
    });

    // ==========================================
    // 1. AUTHENTICATION & LOGIN / REGISTER
    // ==========================================

    // Google OAuth 2.0 Login & Automatic Account Creation (Strict Verification via UserInfo or ID Token)
    socket.on('auth-google', async (rawInput, callback) => {
      try {
        const data = (rawInput && typeof rawInput.credential === 'object') ? rawInput.credential : (rawInput || {});
        let payload = null;

        const token = data.accessToken || data.token || (typeof data.credential === 'string' ? data.credential : null);

        if (!token || typeof token !== 'string' || !token.trim()) {
          return callback && callback({ success: false, error: 'Credencial ou token Google ausente.' });
        }

        const cleanToken = token.trim();

        // 1. If it's an OAuth 2.0 Access Token (from useGoogleLogin in @react-oauth/google)
        if (data.accessToken || !cleanToken.includes('.')) {
          try {
            const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${cleanToken}` }
            });
            if (gRes.ok) {
              payload = await gRes.json();
            } else {
              console.warn('[Security] Google userinfo fetch failed with status:', gRes.status);
            }
          } catch (fetchErr) {
            console.warn('[Security] Google userinfo network error:', fetchErr.message);
          }
        }

        // 2. If it's an ID Token (JWT with 3 parts from Google Identity Services)
        if (!payload && cleanToken.includes('.')) {
          try {
            const ticket = await googleOAuthClient.verifyIdToken({
              idToken: cleanToken,
              audience: GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
          } catch (verifyErr) {
            console.warn('[Security] Google ID token verification failed:', verifyErr.message);
          }
        }

        if (!payload || !payload.email || !payload.sub) {
          return callback && callback({ success: false, error: 'Falha na verificação de autenticidade da conta Google.' });
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

        const rawChosenName = (data.chosenUsername || data.username || payload.name || payload.given_name || normEmail.split('@')[0]).trim().replace(/^@/, '');
        let cleanUsername = rawChosenName.replace(/[^a-zA-Z0-9_.-]/g, '');
        if (cleanUsername.length < 2) cleanUsername = normEmail.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '');
        if (cleanUsername.length < 2) cleanUsername = `user_${Math.random().toString(36).substring(2, 7)}`;

        if (data.chosenUsername) {
          if (cleanUsername.length < 2 || cleanUsername.length > 32) {
            return callback && callback({ success: false, error: 'O nome de usuário deve ter entre 2 e 32 caracteres.' });
          }
          if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUsername)) {
            return callback && callback({ success: false, error: 'O nome de usuário só pode conter letras, números, sublinhado (_), hífen (-) e ponto (.).' });
          }
          const duplicate = registeredUsers.some(
            (u) => (u.username || '').trim() === cleanUsername && u.id !== user?.id
          );
          if (duplicate) {
            return callback && callback({ success: false, error: 'Este nome de usuário exato já está em uso por outro membro. Por favor, escolha outro.' });
          }
        } else if (!user) {
          // Automatic resolution: ensure username is unique
          let baseUsername = cleanUsername;
          let counter = 1;
          while (registeredUsers.some((u) => (u.username || '').trim() === cleanUsername && u.id !== user?.id)) {
            cleanUsername = `${baseUsername.substring(0, 26)}_${counter++}`;
          }
        }

        const cleanAvatar = cleanUsername.substring(0, 2).toUpperCase();
        const chosenColor = data.avatarColor || 'from-indigo-500 to-purple-600';
        const photoUrl = data.avatarUrl !== undefined ? data.avatarUrl : (data.useGooglePhoto ? (payload.picture || '') : '');

        if (!user) {
          // Register new user with verified Google info & custom chosen nickname + color
          user = {
            id: `usr-g-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            email: normEmail,
            googleId: payload.sub,
            password: '',
            username: cleanUsername,
            displayName: cleanUsername,
            avatar: cleanAvatar,
            avatarUrl: photoUrl,
            avatarColor: chosenColor,
            token: '',
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
          console.log(`[Google Auth] Created verified user: ${user.username} (${user.email})`);
        } else {
          // Update username, initials and chosen gradient
          if (data.chosenUsername || data.username) {
            user.username = cleanUsername;
            user.displayName = cleanUsername;
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
          console.log(`[Google Auth] Logged in existing user: ${user.username} (${user.email})`);
        }

        // Issue cryptographically signed JWT token
        user.token = signUserToken(user);
        storage.saveData(registeredUsers, servers, messageHistory);

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

    // Register with Email & Password (Step 1: generates 6-digit OTP code)
    socket.on('auth-register', async ({ email, password, username, avatar, avatarColor }, callback) => {
      try {
        const normEmail = (email || '').trim().toLowerCase();
        const rawPassword = (password || '').trim();

        if (!normEmail || !rawPassword) {
          return callback && callback({ success: false, error: 'E-mail e senha são obrigatórios.' });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
          return callback && callback({ success: false, error: 'Formato de e-mail inválido.' });
        }

        if (rawPassword.length < 6) {
          return callback && callback({ success: false, error: 'A senha deve conter no mínimo 6 caracteres.' });
        }

        // Check email uniqueness
        if (registeredUsers.some((u) => (u.email || '').trim().toLowerCase() === normEmail)) {
          return callback && callback({ success: false, error: 'Este e-mail já está cadastrado no Voxel. Clique na aba "Entrar" para acessar.' });
        }

        const rawUsername = (username || normEmail.split('@')[0]).trim();
        const cleanUsername = rawUsername.replace(/^@/, '');

        // Check username validation & uniqueness (exact match)
        if (cleanUsername.length < 2 || cleanUsername.length > 32) {
          return callback && callback({ success: false, error: 'O nome de usuário deve ter entre 2 e 32 caracteres.' });
        }

        if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUsername)) {
          return callback && callback({ success: false, error: 'O nome de usuário só pode conter letras, números, sublinhado (_), hífen (-) e ponto (.).' });
        }

        if (registeredUsers.some((u) => (u.username || '').trim() === cleanUsername)) {
          return callback && callback({ success: false, error: 'Este nome de usuário exato já está sendo utilizado. Por favor, escolha outro.' });
        }

        const cleanAvatar = (avatar || cleanUsername).substring(0, 2).toUpperCase();
        const hashedPassword = await hashPassword(rawPassword);

        // Generate 6-digit OTP code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        // Store pending verification for 15 minutes
        pendingVerifications.set(normEmail, {
          code,
          expiresAt: Date.now() + 15 * 60 * 1000,
          lastSentAt: Date.now(),
          userData: {
            email: normEmail,
            password: hashedPassword,
            username: cleanUsername,
            avatar: cleanAvatar,
            avatarColor: avatarColor || 'from-indigo-500 to-purple-600',
            displayName: cleanUsername
          }
        });

        // Send verification email via Resend
        const sendRes = await sendVerificationEmail(normEmail, code, cleanUsername);

        return callback && callback({
          success: true,
          pendingVerification: true,
          email: normEmail,
          devCode: sendRes.domainUnverified ? code : undefined,
          warning: sendRes.success ? undefined : sendRes.error
        });
      } catch (err) {
        console.error('[Auth] Error in auth-register:', err);
        return callback && callback({ success: false, error: 'Erro ao iniciar cadastro. Tente novamente.' });
      }
    });

    // Verify 6-digit OTP Email Code (Step 2: finalize registration & log in)
    socket.on('auth-verify-email', async ({ email, code }, callback) => {
      try {
        const normEmail = (email || '').trim().toLowerCase();
        const inputCode = (code || '').trim();
        console.log(`[Auth] verify-email request for: ${normEmail}, code: ${inputCode}`);

        if (!normEmail || !inputCode) {
          return callback && callback({ success: false, error: 'E-mail e código de verificação são obrigatórios.' });
        }

        // Case 1: User is ALREADY registered in the database! (e.g. registered on another device or prior session)
        const existingUser = registeredUsers.find((u) => (u.email || '').trim().toLowerCase() === normEmail);
        if (existingUser) {
          console.log(`[Auth] User ${normEmail} is already registered. Logging in directly!`);
          existingUser.token = signUserToken(existingUser);

          // Clean up any stale sockets for this user ID
          for (const [oldSockId, oldUser] of activeSockets.entries()) {
            if (oldUser.id === existingUser.id && oldSockId !== socket.id) {
              const oldSock = io.sockets.sockets.get(oldSockId);
              if (!oldSock || !oldSock.connected) {
                activeSockets.delete(oldSockId);
              }
            }
          }

          cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'auth-verify-email');

          const activeUser = {
            ...existingUser,
            socketId: socket.id,
            status: 'online',
            isMuted: false,
            isDeafened: false,
            isScreenSharing: false,
            activeVoiceChannel: null
          };
          activeSockets.set(socket.id, activeUser);
          pendingVerifications.delete(normEmail);

          const userServers = getServersForUser(existingUser.id);

          if (callback) {
            callback({
              success: true,
              user: {
                ...existingUser,
                password: undefined
              },
              servers: userServers,
              voiceRooms: Object.fromEntries(voiceRooms)
            });
          }

          io.emit('user-status-changed', { user: activeUser });
          return;
        }

        // Case 2: New user verification via pending OTP
        const pending = pendingVerifications.get(normEmail);
        if (!pending) {
          return callback && callback({ success: false, error: 'Nenhuma verificação pendente para este e-mail. Crie uma conta primeiro.' });
        }

        if (Date.now() > pending.expiresAt) {
          pendingVerifications.delete(normEmail);
          return callback && callback({ success: false, error: 'O código de verificação expirou. Solicite um novo código.' });
        }

        if (pending.code !== inputCode) {
          return callback && callback({ success: false, error: 'Código de verificação incorreto. Tente novamente.' });
        }

        if (registeredUsers.some((u) => (u.username || '').trim() === pending.userData.username)) {
          pendingVerifications.delete(normEmail);
          return callback && callback({ success: false, error: 'Este nome de usuário foi registrado por outra conta. Escolha outro.' });
        }

        const newUser = {
          id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          email: pending.userData.email,
          password: pending.userData.password,
          username: pending.userData.username,
          avatar: pending.userData.avatar,
          avatarColor: pending.userData.avatarColor,
          token: '',
          createdAt: new Date().toISOString(),
          serverIds: ['server-1'],
          bio: '',
          pronouns: '',
          displayName: pending.userData.displayName,
          customStatus: { text: '', emoji: '' },
          gameStatus: '',
          badges: [],
          avatarUrl: '',
          bannerUrl: '',
          avatarDecoration: '',
          profileEffect: ''
        };

        newUser.token = signUserToken(newUser);
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
        pendingVerifications.delete(normEmail);

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
      } catch (err) {
        console.error('[Auth] Error in auth-verify-email:', err);
        return callback && callback({ success: false, error: 'Erro ao verificar código no servidor.' });
      }
    });

    // Resend 6-digit OTP Code
    socket.on('auth-resend-code', async ({ email }, callback) => {
      try {
        const normEmail = (email || '').trim().toLowerCase();

        // If already registered, notify user to log in
        if (registeredUsers.some((u) => (u.email || '').trim().toLowerCase() === normEmail)) {
          return callback && callback({ success: false, error: 'Sua conta já está ativada! Clique em "Entrar" com seu e-mail e senha.' });
        }

        const pending = pendingVerifications.get(normEmail);
        if (!pending) {
          return callback && callback({ success: false, error: 'Nenhum cadastro pendente para este e-mail.' });
        }

        const now = Date.now();
        if (pending.lastSentAt && now - pending.lastSentAt < 30000) {
          const remainingSeconds = Math.ceil((30000 - (now - pending.lastSentAt)) / 1000);
          return callback && callback({ success: false, error: `Aguarde ${remainingSeconds}s antes de solicitar um novo código.` });
        }

        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        pending.code = newCode;
        pending.expiresAt = now + 15 * 60 * 1000;
        pending.lastSentAt = now;

        const sendRes = await sendVerificationEmail(normEmail, newCode, pending.userData.username);
        return callback && callback({
          success: true,
          message: 'Novo código de verificação enviado!',
          devCode: sendRes.domainUnverified ? newCode : undefined,
          warning: sendRes.success ? undefined : sendRes.error
        });
      } catch (err) {
        console.error('[Auth] Error in auth-resend-code:', err);
        return callback && callback({ success: false, error: 'Erro ao reenviar código.' });
      }
    });

    // Quick Guest Entry (Deprecating: quick guest access discontinued)
    socket.on('auth-guest', (_, callback) => {
      if (callback) {
        callback({
          success: false,
          error: 'O acesso rápido foi descontinuado. Por favor, crie uma conta ou entre com o Google.'
        });
      }
    });

    // Login with Email & Password (bcrypt check & JWT issuance)
    socket.on('auth-login', async ({ email, password }, callback) => {
      try {
        const normEmail = (email || '').trim().toLowerCase();
        const rawPassword = (password || '').trim();
        console.log(`[Auth] Login attempt for: ${normEmail}`);

        if (!normEmail || !rawPassword) {
          return callback && callback({ success: false, error: 'E-mail e senha são obrigatórios.' });
        }

        const user = registeredUsers.find((u) => (u.email || '').trim().toLowerCase() === normEmail);
        if (!user) {
          console.warn(`[Auth] Login user not found: ${normEmail}`);
          return callback && callback({ success: false, error: 'E-mail ou senha incorretos.' });
        }

        const { match, needsRehash } = await verifyPassword(rawPassword, user.password);
        if (!match) {
          console.warn(`[Auth] Login password mismatch for: ${normEmail}`);
          return callback && callback({ success: false, error: 'E-mail ou senha incorretos.' });
        }

        // Upgrade plain password to bcrypt hash if needed
        if (needsRehash) {
          try {
            user.password = await hashPassword(rawPassword);
            storage.saveData(registeredUsers, servers, messageHistory);
          } catch (e) {
            console.warn('[Auth] Error rehashing password:', e.message);
          }
        }

        // Issue signed JWT token
        user.token = signUserToken(user);

        // Clean up any stale sockets for this user ID
        for (const [oldSockId, oldUser] of activeSockets.entries()) {
          if (oldUser.id === user.id && oldSockId !== socket.id) {
            const oldSock = io.sockets.sockets.get(oldSockId);
            if (!oldSock || !oldSock.connected) {
              activeSockets.delete(oldSockId);
            }
          }
        }

        cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'auth-login');

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
        console.log(`[Auth] Login SUCCESS for: ${normEmail} (${user.username})`);

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
        console.error('[Auth] Error in auth-login:', err);
        return callback && callback({ success: false, error: 'Erro ao processar login no servidor. Tente novamente.' });
      }
    });

    // Auto-Login / Resume Saved Session (STRICT JWT VALIDATION — NEVER ACCEPTS USERID ALONE)
    socket.on('auth-session', ({ token, userId }, callback) => {
      try {
        if (!token || typeof token !== 'string') {
          return callback && callback({ success: false, error: 'Token de sessão ausente. Faça login novamente.' });
        }

        const decoded = verifyUserToken(token);
        if (!decoded || !decoded.userId) {
          return callback && callback({ success: false, error: 'Sessão inválida ou expirada. Faça login novamente.' });
        }

        const targetUserId = decoded.userId;
        const user = registeredUsers.find((u) => u.id === targetUserId);
        if (!user) {
          return callback && callback({ success: false, error: 'Usuário não encontrado. Faça login novamente.' });
        }

        // Clean up any stale sockets for this user ID
        for (const [oldSockId, oldUser] of activeSockets.entries()) {
          if (oldUser.id === user.id && oldSockId !== socket.id) {
            const oldSock = io.sockets.sockets.get(oldSockId);
            if (!oldSock || !oldSock.connected) {
              activeSockets.delete(oldSockId);
            }
          }
        }

        cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'auth-session');

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
      } catch (err) {
        console.error('[Auth] Error in auth-session:', err);
        return callback && callback({ success: false, error: 'Erro ao validar sessão.' });
      }
    });

    // Explicit Logout (Revoke active session on server)
    socket.on('auth-logout', (callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (activeUser) {
        leaveCurrentVoice(socket, activeUser, io, voiceRooms, activeSockets);
        activeSockets.delete(socket.id);
        const userIndex = registeredUsers.findIndex(u => u.id === activeUser.id);
        if (userIndex !== -1) {
          registeredUsers[userIndex].gameStatus = '';
          registeredUsers[userIndex].gameStartedAt = null;
        }
        io.emit('user-status-changed', {
          user: {
            ...activeUser,
            status: 'offline',
            gameStatus: '',
            gameStartedAt: null
          }
        });
      }
      if (callback) callback({ success: true });
    });

    // User Profile Update
    socket.on('update-profile', (profileData, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return callback && callback({ success: false, error: 'Não autenticado' });

      // 1. Validate Username uniqueness if updated (exact match)
      if (profileData.username !== undefined) {
        const rawUsername = (profileData.username || '').trim().replace(/^@/, '');

        if (rawUsername.length < 2 || rawUsername.length > 32) {
          return callback && callback({ success: false, error: 'O nome de usuário deve ter entre 2 e 32 caracteres.' });
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(rawUsername)) {
          return callback && callback({ success: false, error: 'O nome de usuário só pode conter letras, números, sublinhado (_), hífen (-) e ponto (.).' });
        }

        const isDuplicateUsername = registeredUsers.some(
          (u) => u.id !== activeUser.id && (u.username || '').trim() === rawUsername
        );
        if (isDuplicateUsername) {
          return callback && callback({ success: false, error: 'Este nome de usuário exato já está sendo utilizado por outra conta.' });
        }
        profileData.username = rawUsername;
      }

      // 2. Validate Email uniqueness if updated
      if (profileData.email !== undefined) {
        const normNewEmail = (profileData.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normNewEmail)) {
          return callback && callback({ success: false, error: 'Formato de e-mail inválido.' });
        }
        const isDuplicateEmail = registeredUsers.some(
          (u) => u.id !== activeUser.id && (u.email || '').trim().toLowerCase() === normNewEmail
        );
        if (isDuplicateEmail) {
          return callback && callback({ success: false, error: 'Este e-mail já está sendo utilizado por outra conta.' });
        }
        profileData.email = normNewEmail;
      }

      const allowedFields = ['displayName', 'bio', 'pronouns', 'avatarColor', 'avatarUrl', 'bannerUrl', 'avatarDecoration', 'profileEffect', 'customStatus', 'gameStatus', 'gameStartedAt', 'activity', 'username', 'email', 'appTheme', 'compactMode', 'clipSettings', 'status'];

      const userIndex = registeredUsers.findIndex(u => u.id === activeUser.id);

      allowedFields.forEach(field => {
        if (profileData[field] !== undefined) {
          activeUser[field] = profileData[field];
          if (userIndex !== -1) {
            registeredUsers[userIndex][field] = profileData[field];
          }
        }
      });

      // If user went invisible/offline, active game status must be cleared
      if (activeUser.status === 'offline' || activeUser.status === 'invisible') {
        activeUser.gameStatus = '';
        activeUser.gameStartedAt = null;
        if (userIndex !== -1) {
          registeredUsers[userIndex].gameStatus = '';
          registeredUsers[userIndex].gameStartedAt = null;
        }
      }

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
    // 🛡️ VERIFIED BLUE BADGE (SELO AZUL) REQUESTS
    // ==========================================
    socket.on('request-verification', ({ reason, links }, callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) {
        return callback?.({ success: false, error: 'Você precisa estar logado para solicitar verificação.' });
      }

      if (activeUser.isVerified) {
        return callback?.({ success: false, error: 'Seu perfil já possui o selo oficial de verificação.' });
      }

      // Check if user already has a pending request
      const existing = verificationRequests.find(
        (v) => v.userId === activeUser.id && v.status === 'pending'
      );
      if (existing) {
        return callback?.({
          success: false,
          error: 'Você já possui uma solicitação de verificação em análise.'
        });
      }

      const newReq = {
        id: `verif-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        userId: activeUser.id,
        username: activeUser.username,
        displayName: activeUser.displayName || activeUser.username,
        avatar: activeUser.avatar,
        avatarUrl: activeUser.avatarUrl,
        reason: String(reason || '').trim().slice(0, 500),
        links: String(links || '').trim().slice(0, 500),
        status: 'pending',
        requestedAt: new Date().toISOString()
      };

      verificationRequests.push(newReq);
      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests);

      // Notify admin panel in real-time
      io.emit('new-verification-request', {
        request: newReq,
        pendingCount: verificationRequests.filter((v) => v.status === 'pending').length
      });

      if (callback) {
        callback({ success: true, message: 'Solicitação enviada com sucesso! Ela será analisada pelo administrador.', request: newReq });
      }
    });

    socket.on('get-verification-status', (callback) => {
      const activeUser = activeSockets.get(socket.id);
      if (!activeUser) return callback?.({ status: 'unauthenticated' });

      if (activeUser.isVerified) {
        return callback?.({ status: 'verified', isVerified: true });
      }

      const pending = verificationRequests.find(
        (v) => v.userId === activeUser.id && v.status === 'pending'
      );
      if (pending) {
        return callback?.({ status: 'pending', request: pending });
      }

      const rejected = verificationRequests
        .filter((v) => v.userId === activeUser.id && v.status === 'rejected')
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())[0];
      if (rejected) {
        return callback?.({ status: 'rejected', request: rejected });
      }

      return callback?.({ status: 'none' });
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
      newServer.inviteCode = generateInviteCode(newServer);

      servers.push(newServer);

      const registered = registeredUsers.find((u) => u.id === user.id);
      if (registered) {
        if (!registered.serverIds) registered.serverIds = [];
        registered.serverIds.push(newServer.id);
      }

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      // Send to creator
      const formattedNew = formatServerWithMembers(newServer);
      socket.emit('server-created', formattedNew);
      if (callback) callback(formattedNew);
    });

    // Join an Existing Server by Invite Code or Link
    socket.on('join-server', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      if (!serverId || typeof serverId !== 'string') {
        return callback && callback({ success: false, error: 'Código de convite ausente.' });
      }

      let cleaned = serverId.trim();

      // Strip invite URL prefix if present (e.g. https://voxel.gg/invite/XXXX)
      const urlMatch = cleaned.match(/invite\/([a-zA-Z0-9_-]+)/i);
      if (urlMatch) cleaned = urlMatch[1];

      // Strip optional "PC-" prefix from invite codes
      cleaned = cleaned.replace(/^PC-?/i, '').replace(/[-_]/g, '').trim();

      // Community server: joinable by any authenticated user
      if (cleaned.toLowerCase() === 'community' || cleaned === '1' || serverId.trim() === 'server-1') {
        const communityServer = servers.find((s) => s.id === 'server-1');
        if (!communityServer) {
          return callback && callback({ success: false, error: 'Servidor comunitário não encontrado.' });
        }
        if (!communityServer.memberIds) communityServer.memberIds = [];
        if (!communityServer.memberIds.includes(user.id)) {
          communityServer.memberIds.push(user.id);
        }
        const registered = registeredUsers.find((u) => u.id === user.id);
        if (registered) {
          if (!registered.serverIds) registered.serverIds = [];
          if (!registered.serverIds.includes('server-1')) registered.serverIds.push('server-1');
        }
        storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);
        const formatted = formatServerWithMembers(communityServer);
        socket.emit('server-created', formatted);
        return callback && callback({ success: true, server: formatted });
      }

      // Resolve invite code to server:
      const decodedId = decodeInviteToId(cleaned);
      const targetServer = servers.find(
        (s) =>
          (s.inviteCode && s.inviteCode.toUpperCase() === cleaned.toUpperCase()) ||
          (decodedId && s.id === decodedId) ||
          s.id === cleaned ||
          s.id === `server-${cleaned}` ||
          (s.inviteCode && s.inviteCode.toUpperCase() === serverId.trim().toUpperCase())
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

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      const formattedTarget = formatServerWithMembers(targetServer);

      // Notify other online members of this server
      io.emit('server-roles-updated', {
        serverId: targetServer.id,
        roles: targetServer.roles,
        server: formattedTarget
      });

      socket.emit('server-created', formattedTarget);
      return callback && callback({ success: true, server: formattedTarget });
    });

    // Get or Create Invite Code for Server (Requires Membership)
    socket.on('get-server-invite', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const decodedId = decodeInviteToId(serverId);
      const targetServer = servers.find((s) => s.id === serverId || (decodedId && s.id === decodedId));
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      // Check membership
      const isMember = targetServer.isCommunity || targetServer.id === 'server-1' ||
        targetServer.ownerId === user.id ||
        (Array.isArray(targetServer.memberIds) && targetServer.memberIds.includes(user.id));
      if (!isMember) {
        return callback && callback({ success: false, error: 'Acesso negado. Você não é membro deste servidor.' });
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

    // Generate New Invite Code for Server (Requires Owner / Admin Permissions)
    socket.on('generate-new-invite', ({ serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      const decodedId = decodeInviteToId(serverId);
      const targetServer = servers.find((s) => s.id === serverId || (decodedId && s.id === decodedId));
      if (!targetServer) {
        return callback && callback({ success: false, error: 'Servidor não encontrado.' });
      }

      const canManage = targetServer.ownerId === user.id ||
        user.isAdmin ||
        user.roleId === 'role-admin' ||
        user.roleId === 'role-mod' ||
        (targetServer.memberRoles && (targetServer.memberRoles[user.id] === 'role-admin' || targetServer.memberRoles[user.id] === 'role-mod'));

      if (!canManage) {
        return callback && callback({ success: false, error: 'Acesso negado. Apenas moderadores e administradores podem gerar novos códigos de convite.' });
      }

      const newInviteCode = encodeServerToInvite(targetServer, true);

      // Track all past invite codes so any previously shared link continues to work!
      if (!Array.isArray(targetServer.inviteCodes)) {
        targetServer.inviteCodes = [];
      }
      if (targetServer.inviteCode && !targetServer.inviteCodes.includes(targetServer.inviteCode)) {
        targetServer.inviteCodes.push(targetServer.inviteCode);
      }
      targetServer.inviteCode = newInviteCode;
      if (!targetServer.inviteCodes.includes(newInviteCode)) {
        targetServer.inviteCodes.push(newInviteCode);
      }

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      // Broadcast update to all clients
      io.emit('server-updated', formatServerWithMembers(targetServer));

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
        (Array.isArray(s.inviteCodes) && s.inviteCodes.some((c) => c && c.toUpperCase() === cleaned.toUpperCase())) ||
        (decodedId && s.id === decodedId) ||
        s.id === inviteCode ||
        s.id === cleaned ||
        s.id === `server-${cleaned}` ||
        (s.inviteCode && s.inviteCode.toUpperCase() === inviteCode.trim().toUpperCase())
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

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

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
        targetServer.inviteCode = generateInviteCode(targetServer);
      }

      const sortedIds = [user.id, targetUserId].sort();
      const dmId = `dm-${sortedIds[0]}_${sortedIds[1]}`;

      const dmRecord = {
        id: dmId,
        participants: [user.id, targetUserId],
        updatedAt: new Date().toISOString()
      };
      dmConversations.set(dmId, dmRecord);

      const role = DEFAULT_ROLES.find((r) => r.id === user.roleId) || DEFAULT_ROLES[3];
      const authorObj = {
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        avatar: user.avatar,
        avatarUrl: user.avatarUrl || null,
        avatarColor: user.avatarColor,
        roleId: user.roleId,
        roleColor: role ? role.color : '#ffffff',
        roleName: role ? role.name : '',
        isVerified: Boolean(user.isVerified),
        badges: user.badges || [],
        isBot: false
      };

      const inviteMsg = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        channelId: dmId,
        author: authorObj,
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
      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      socket.join(dmId);
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          const targetSocket = io.sockets.sockets.get(sockId);
          if (targetSocket) targetSocket.join(dmId);
        }
      }

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
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback([]);

      // Strict channel access authorization (prevents unauthorized reading of private DMs and private server channels)
      if (!canUserAccessChannel(user, channelId, servers, dmConversations)) {
        return callback && callback([]);
      }

      const msgs = messageHistory.get(channelId) || [];
      if (callback) callback(msgs);
    });

    // Fetch DMs for the current user (only with confirmed friends or self)
    socket.on('fetch-dms', (callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback([]);

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const myFriends = regUser.friends || [];

      const userDMs = [];
      for (const [dmId, dmData] of dmConversations.entries()) {
        if (dmData.participants.includes(user.id)) {
          const otherUserId = dmData.participants.find((id) => id !== user.id) || user.id;

          // Only list in DMs if the user is a friend (or self)
          if (otherUserId !== user.id && !myFriends.includes(otherUserId)) {
            continue;
          }

          const otherUser = registeredUsers.find((u) => u.id === otherUserId) ||
            Array.from(activeSockets.values()).find((act) => act.id === otherUserId) ||
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

    // Open or create DM with target user (only allowed with connected friends)
    socket.on('open-or-create-dm', ({ targetUserId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const myFriends = regUser.friends || [];
      if (targetUserId !== user.id && !myFriends.includes(targetUserId)) {
        return callback && callback({ success: false, error: 'Você só pode conversar por DM com amigos adicionados.' });
      }

      const sortedIds = [user.id, targetUserId].sort();
      const dmId = `dm-${sortedIds[0]}_${sortedIds[1]}`;

      const otherUser = registeredUsers.find((u) => u.id === targetUserId) ||
        Array.from(activeSockets.values()).find((act) => act.id === targetUserId) ||
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
    // FRIENDS & FRIEND REQUESTS SYSTEM
    // ==========================================

    // Fetch friends, incoming requests, and outgoing requests
    socket.on('fetch-friends', (callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const myFriendsIds = regUser.friends || [];

      const friendsList = myFriendsIds
        .map((fId) => {
          const fUser = findUserById(fId);
          return fUser ? sanitizeUser(fUser) : null;
        })
        .filter(Boolean);

      const incoming = friendRequests
        .filter((r) => r.toId === user.id)
        .map((r) => {
          const fromUser = findUserById(r.fromId);
          return fromUser ? { id: r.id, from: sanitizeUser(fromUser), createdAt: r.createdAt } : null;
        })
        .filter(Boolean);

      const outgoing = friendRequests
        .filter((r) => r.fromId === user.id)
        .map((r) => {
          const toUser = findUserById(r.toId);
          return toUser ? { id: r.id, to: sanitizeUser(toUser), createdAt: r.createdAt } : null;
        })
        .filter(Boolean);

      if (callback) callback({ success: true, friends: friendsList, incoming, outgoing });
    });

    // Send a friend request by username, displayName, tag or ID
    socket.on('send-friend-request', ({ targetUsername, targetUserId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const norm = (s) =>
        (s || '')
          .toString()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim();

      let target = null;
      if (targetUserId) {
        target = findUserById(targetUserId);
      } else if (targetUsername && typeof targetUsername === 'string') {
        const raw = targetUsername.trim();
        const strippedAt = raw.replace(/^@/, '');
        const queryNorm = norm(strippedAt);
        const baseNorm = norm(strippedAt.split('#')[0]);

        // 1. Check registeredUsers (exact username match has top priority)
        target = registeredUsers.find(
          (u) => (u.username || '').trim() === raw || (u.username || '').trim() === strippedAt || u.id === raw || u.id === strippedAt
        );

        if (!target) {
          target = registeredUsers.find((u) => {
            const uName = norm(u.username);
            const dName = norm(u.displayName);
            const email = norm(u.email);
            return (
              u.id === raw ||
              u.id === strippedAt ||
              uName === queryNorm ||
              uName === baseNorm ||
              dName === queryNorm ||
              dName === baseNorm ||
              email === queryNorm
            );
          });
        }

        // 2. Check activeSockets
        if (!target) {
          target = Array.from(activeSockets.values()).find(
            (act) => (act.username || '').trim() === raw || (act.username || '').trim() === strippedAt || act.id === raw || act.id === strippedAt
          );
        }

        if (!target) {
          target = Array.from(activeSockets.values()).find((act) => {
            const uName = norm(act.username);
            const dName = norm(act.displayName);
            const email = norm(act.email);
            return (
              act.id === raw ||
              act.id === strippedAt ||
              uName === queryNorm ||
              uName === baseNorm ||
              dName === queryNorm ||
              dName === baseNorm ||
              email === queryNorm
            );
          });
        }

        // 3. Check all server members
        if (!target) {
          for (const s of servers) {
            const mem = (s.members || []).find((m) => {
              const uName = norm(m.username);
              const dName = norm(m.displayName);
              return (
                m.id === raw ||
                m.id === strippedAt ||
                uName === queryNorm ||
                uName === baseNorm ||
                dName === queryNorm ||
                dName === baseNorm
              );
            });
            if (mem) {
              target = findUserById(mem.id) || mem;
              break;
            }
          }
        }
      }

      if (!target) {
        return (
          callback &&
          callback({
            success: false,
            error: `Usuário "${targetUsername || ''}" não encontrado. Verifique se o nome de usuário está correto.`
          })
        );
      }

      if (target.id === user.id) {
        return callback && callback({ success: false, error: 'Você não pode adicionar a si mesmo.' });
      }

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const regTarget = registeredUsers.find((u) => u.id === target.id) || target;

      if (!Array.isArray(regUser.friends)) regUser.friends = [];
      if (!Array.isArray(regTarget.friends)) regTarget.friends = [];

      if (regUser.friends.includes(target.id)) {
        return callback && callback({ success: false, error: 'Vocês já são amigos!' });
      }

      // Check if target already sent a request to current user -> auto-accept
      const incomingIndex = friendRequests.findIndex((r) => r.fromId === target.id && r.toId === user.id);
      if (incomingIndex >= 0) {
        friendRequests.splice(incomingIndex, 1);
        if (!regUser.friends.includes(target.id)) regUser.friends.push(target.id);
        if (!regTarget.friends.includes(user.id)) regTarget.friends.push(user.id);
        storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

        // Notify both sides in real time
        for (const [sockId, actUser] of activeSockets.entries()) {
          if (actUser.id === target.id) {
            io.to(sockId).emit('friend-request-accepted', { friend: sanitizeUser(regUser) });
          }
          if (actUser.id === user.id) {
            io.to(sockId).emit('friend-request-accepted', { friend: sanitizeUser(regTarget) });
          }
        }

        return callback && callback({
          success: true,
          message: `Você e ${regTarget.displayName || regTarget.username} agora são amigos!`,
          autoAccepted: true,
          friend: sanitizeUser(regTarget)
        });
      }

      // Check if already sent
      if (friendRequests.some((r) => r.fromId === user.id && r.toId === target.id)) {
        return callback && callback({ success: false, error: 'Você já enviou uma solicitação para este usuário.' });
      }

      const reqId = `fr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const newReq = {
        id: reqId,
        fromId: user.id,
        toId: target.id,
        createdAt: Date.now()
      };
      friendRequests.push(newReq);
      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      // Notify target if online
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === target.id) {
          io.to(sockId).emit('friend-request-received', {
            id: reqId,
            from: sanitizeUser(regUser),
            createdAt: newReq.createdAt
          });
        }
      }

      if (callback) {
        callback({
          success: true,
          message: `Pedido de amizade enviado para ${regTarget.displayName || regTarget.username}!`,
          outgoing: { id: reqId, to: sanitizeUser(regTarget), createdAt: newReq.createdAt }
        });
      }
    });

    // Accept friend request
    socket.on('accept-friend-request', ({ requestId, senderId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const reqIndex = friendRequests.findIndex(
        (r) => r.toId === user.id && (r.id === requestId || r.fromId === senderId)
      );
      if (reqIndex === -1) {
        return callback && callback({ success: false, error: 'Solicitação de amizade não encontrada.' });
      }

      const req = friendRequests[reqIndex];
      friendRequests.splice(reqIndex, 1);

      const sender = findUserById(req.fromId);
      if (!sender) {
        return callback && callback({ success: false, error: 'Usuário remetente não encontrado.' });
      }

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const regSender = registeredUsers.find((u) => u.id === sender.id) || sender;

      if (!Array.isArray(regUser.friends)) regUser.friends = [];
      if (!Array.isArray(regSender.friends)) regSender.friends = [];

      if (!regUser.friends.includes(regSender.id)) regUser.friends.push(regSender.id);
      if (!regSender.friends.includes(regUser.id)) regSender.friends.push(regUser.id);

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      // Notify both parties
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === regSender.id) {
          io.to(sockId).emit('friend-request-accepted', { friend: sanitizeUser(regUser) });
        }
        if (actUser.id === user.id) {
          io.to(sockId).emit('friend-request-accepted', { friend: sanitizeUser(regSender) });
        }
      }

      if (callback) callback({ success: true, friend: sanitizeUser(regSender) });
    });

    // Decline or cancel friend request
    socket.on('decline-friend-request', ({ requestId, senderId, targetId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const reqIndex = friendRequests.findIndex(
        (r) =>
          r.id === requestId ||
          (r.toId === user.id && (r.fromId === senderId || r.fromId === targetId)) ||
          (r.fromId === user.id && (r.toId === senderId || r.toId === targetId))
      );

      if (reqIndex === -1) {
        return callback && callback({ success: false, error: 'Solicitação não encontrada.' });
      }

      const req = friendRequests[reqIndex];
      friendRequests.splice(reqIndex, 1);
      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      const otherUserId = req.fromId === user.id ? req.toId : req.fromId;
      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === otherUserId || actUser.id === user.id) {
          io.to(sockId).emit('friend-request-declined', { requestId: req.id, otherUserId: user.id });
        }
      }

      if (callback) callback({ success: true });
    });

    // Remove a friend
    socket.on('remove-friend', ({ friendId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      const regUser = registeredUsers.find((u) => u.id === user.id) || user;
      const regFriend = registeredUsers.find((u) => u.id === friendId);

      if (Array.isArray(regUser.friends)) {
        regUser.friends = regUser.friends.filter((id) => id !== friendId);
      }
      if (regFriend && Array.isArray(regFriend.friends)) {
        regFriend.friends = regFriend.friends.filter((id) => id !== user.id);
      }

      storage.saveData(registeredUsers, servers, messageHistory, verificationRequests, friendRequests);

      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === friendId) {
          io.to(sockId).emit('friend-removed', { friendId: user.id });
        }
        if (actUser.id === user.id) {
          io.to(sockId).emit('friend-removed', { friendId });
        }
      }

      if (callback) callback({ success: true });
    });

    // ==========================================
    // DM CALLS SIGNALING
    // ==========================================

    // Initiate DM Call
    socket.on('initiate-dm-call', ({ targetUserId, dmId }) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;

      // Verify user is in DM
      if (!canUserAccessChannel(user, dmId, servers, dmConversations)) return;

      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          io.to(sockId).emit('dm-call-incoming', {
            dmId,
            caller: sanitizeUser(user),
          });
        }
      }
    });

    // Cancel DM Call (caller hangs up before answer)
    socket.on('cancel-dm-call', ({ targetUserId, dmId }) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;
      if (!canUserAccessChannel(user, dmId, servers, dmConversations)) return;

      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === targetUserId) {
          io.to(sockId).emit('dm-call-cancelled', { dmId });
        }
      }
    });

    // Decline DM Call (callee rejects)
    socket.on('decline-dm-call', ({ callerId, dmId }) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;
      if (!canUserAccessChannel(user, dmId, servers, dmConversations)) return;

      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === callerId) {
          io.to(sockId).emit('dm-call-declined', { dmId });
        }
      }
    });

    // Accept DM Call (callee accepts)
    socket.on('accept-dm-call', ({ callerId, dmId }) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;
      if (!canUserAccessChannel(user, dmId, servers, dmConversations)) return;

      for (const [sockId, actUser] of activeSockets.entries()) {
        if (actUser.id === callerId) {
          io.to(sockId).emit('dm-call-accepted', { dmId });
        }
      }
    });

    // Pin Message (Requires membership & moderation / author permission)
    socket.on('pin-message', ({ channelId, messageId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      if (!canUserAccessChannel(user, channelId, servers, dmConversations)) {
        return callback && callback({ success: false, error: 'Acesso negado a este canal.' });
      }

      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) {
        return callback && callback({ success: false, error: 'Mensagem não encontrada.' });
      }

      if (!canUserManageMessage(user, channelId, msg, servers, dmConversations)) {
        return callback && callback({ success: false, error: 'Você não tem permissão para fixar mensagens neste canal.' });
      }

      msg.isPinned = true;
      msg.pinnedAt = new Date().toISOString();
      msg.pinnedBy = user.displayName || user.username || 'Usuário';

      storage.saveData(registeredUsers, servers, messageHistory);

      if (channelId.startsWith('dm-')) {
        const parts = channelId.replace('dm-', '').split('_');
        for (const [sockId, actUser] of activeSockets.entries()) {
          if (parts.includes(actUser.id)) {
            io.to(sockId).emit('message-pinned', { channelId, messageId, message: msg });
          }
        }
      } else {
        io.emit('message-pinned', { channelId, messageId, message: msg });
      }

      if (callback) callback({ success: true, message: msg });
    });

    // Unpin Message (Requires membership & moderation / author permission)
    socket.on('unpin-message', ({ channelId, messageId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      if (!canUserAccessChannel(user, channelId, servers, dmConversations)) {
        return callback && callback({ success: false, error: 'Acesso negado a este canal.' });
      }

      const msgs = messageHistory.get(channelId) || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) {
        return callback && callback({ success: false, error: 'Mensagem não encontrada.' });
      }

      if (!canUserManageMessage(user, channelId, msg, servers, dmConversations)) {
        return callback && callback({ success: false, error: 'Você não tem permissão para desafixar mensagens neste canal.' });
      }

      msg.isPinned = false;
      delete msg.pinnedAt;
      delete msg.pinnedBy;

      storage.saveData(registeredUsers, servers, messageHistory);

      if (channelId.startsWith('dm-')) {
        const parts = channelId.replace('dm-', '').split('_');
        for (const [sockId, actUser] of activeSockets.entries()) {
          if (parts.includes(actUser.id)) {
            io.to(sockId).emit('message-unpinned', { channelId, messageId });
          }
        }
      } else {
        io.emit('message-unpinned', { channelId, messageId });
      }

      if (callback) callback({ success: true });
    });

    // Send message (Handles Channels & DMs with 25MB attachment limit & auth checks)
    socket.on('send-message', ({ channelId, content, attachments }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado' });

      if (!canUserAccessChannel(user, channelId, servers, dmConversations)) {
        return callback && callback({ success: false, error: 'Você não tem permissão para enviar mensagens neste canal.' });
      }

      const cleanContent = typeof content === 'string' ? content.slice(0, MAX_CONTENT_LENGTH) : '';

      // Validate attachments (backend 25MB enforcement)
      const { valid, error, sanitized } = validateAttachments(attachments);
      if (!valid) {
        socket.emit('chat-error', { error });
        if (callback) callback({ success: false, error });
        return;
      }

      if (!cleanContent.trim() && sanitized.length === 0) return;

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
          roleName: role.name,
          isVerified: Boolean(user.isVerified),
          badges: user.badges || []
        },
        content: cleanContent,
        attachments: sanitized,
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

      if (channelId.startsWith('dm-')) {
        // DM: Emit ONLY to the 2 participants of this DM
        const parts = channelId.replace('dm-', '').split('_');
        for (const [sockId, actUser] of activeSockets.entries()) {
          if (parts.includes(actUser.id)) {
            io.to(sockId).emit('new-message', message);
          }
        }
      } else {
        io.emit('new-message', message);
      }

      if (callback) callback({ success: true, message });

      if (cleanContent && cleanContent.startsWith('/')) {
        handleBotCommand(channelId, cleanContent, user, io, musicBot, messageHistory, storage, servers, registeredUsers);
      }
    });

    // ==========================================
    // 4. VOICE CHANNELS & WEBRTC
    // ==========================================
    socket.on('join-voice', ({ channelId, serverId }, callback) => {
      const user = activeSockets.get(socket.id);
      if (!user) return callback && callback({ success: false, error: 'Não autenticado.' });

      // Permission check for voice channel (prevents unauthorized entry to private voice)
      if (!canUserAccessVoice(user, channelId, serverId, servers, dmConversations)) {
        if (callback) callback({ success: false, error: 'Acesso negado. Você não é membro deste servidor ou conversa.' });
        return;
      }

      // 1. Strict single-channel rule: Clean this user from ALL other voice rooms
      for (const [rId, rUsers] of Array.from(voiceRooms.entries())) {
        if (rId !== channelId) {
          const hasUser = rUsers.some((u) => u.id === user.id || u.socketId === socket.id);
          if (hasUser) {
            const filtered = rUsers.filter((u) => u.id !== user.id && u.socketId !== socket.id);
            if (filtered.length === 0) {
              voiceRooms.delete(rId);
            } else {
              voiceRooms.set(rId, filtered);
            }

            // Remove all sockets of this user from the old socket.io voice room
            for (const [sId, actU] of activeSockets.entries()) {
              if (actU.id === user.id) {
                const s = io.sockets.sockets.get(sId);
                if (s) s.leave(`voice-${rId}`);
              }
            }

            socket.to(`voice-${rId}`).emit('user-left-voice', {
              socketId: socket.id,
              userId: user.id,
              channelId: rId
            });
          }
        }
      }

      user.activeVoiceChannel = channelId;
      user.isScreenSharing = false;
      socket.join(`voice-${channelId}`);

      // Also ensure any other socket for the same user is updated to avoid desync
      for (const [sId, actU] of activeSockets.entries()) {
        if (actU.id === user.id && sId !== socket.id) {
          actU.activeVoiceChannel = channelId;
        }
      }

      if (!voiceRooms.has(channelId)) {
        voiceRooms.set(channelId, []);
      }

      const roomUsers = voiceRooms.get(channelId);
      // Strictly remove any stale entry of this user ID or this socketId in target room before adding
      const cleanUsers = roomUsers.filter((u) => u.id !== user.id && u.socketId !== socket.id);
      cleanUsers.push({
        id: user.id,
        username: user.username,
        displayName: user.displayName || user.username,
        avatar: user.avatar,
        avatarUrl: user.avatarUrl,
        avatarColor: user.avatarColor,
        isMuted: Boolean(user.isMuted),
        isDeafened: Boolean(user.isDeafened),
        isScreenSharing: Boolean(user.isScreenSharing),
        socketId: socket.id,
        roleId: user.roleId
      });
      voiceRooms.set(channelId, cleanUsers);

      cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'join-voice');

      socket.to(`voice-${channelId}`).emit('user-joined-voice', {
        user: { ...user, socketId: socket.id },
        channelId
      });

      const musicPlayer = musicBot.getPlayer(channelId);
      const watchTogether = getCalculatedWatchTogetherState(channelId);

      if (callback) {
        callback({
          success: true,
          usersInRoom: (voiceRooms.get(channelId) || []).filter((u) => u.socketId !== socket.id && u.id !== user.id),
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
      leaveCurrentVoice(socket, user, io, voiceRooms, activeSockets);
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
            leaveCurrentVoice(targetSocket, u, io, voiceRooms, activeSockets);
            targetSocket.emit('force-disconnected-from-voice');
          }
          break;
        }
      }
      if (callback) callback({ success: true });
    });

    socket.on('webrtc-offer', ({ targetSocketId, offer, isScreenShare }) => {
      const sender = activeSockets.get(socket.id);
      if (!sender || !sender.activeVoiceChannel) return;

      const target = activeSockets.get(targetSocketId);
      if (!target || !target.activeVoiceChannel) return;

      // Both sockets must belong to the exact same active voice channel
      if (sender.activeVoiceChannel !== target.activeVoiceChannel) return;

      io.to(targetSocketId).emit('webrtc-offer', {
        senderSocketId: socket.id,
        senderUser: sanitizeUser(sender),
        offer,
        isScreenShare
      });
    });

    socket.on('webrtc-answer', ({ targetSocketId, answer, isScreenShare }) => {
      const sender = activeSockets.get(socket.id);
      if (!sender || !sender.activeVoiceChannel) return;

      const target = activeSockets.get(targetSocketId);
      if (!target || !target.activeVoiceChannel) return;

      if (sender.activeVoiceChannel !== target.activeVoiceChannel) return;

      io.to(targetSocketId).emit('webrtc-answer', {
        senderSocketId: socket.id,
        answer,
        isScreenShare
      });
    });

    socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, isScreenShare }) => {
      const sender = activeSockets.get(socket.id);
      if (!sender || !sender.activeVoiceChannel) return;

      const target = activeSockets.get(targetSocketId);
      if (!target || !target.activeVoiceChannel) return;

      if (sender.activeVoiceChannel !== target.activeVoiceChannel) return;

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
          const room = voiceRooms.get(user.activeVoiceChannel);
          if (room) {
            const member = room.find((m) => m.socketId === socket.id || m.id === user.id);
            if (member) {
              if (typeof isMuted === 'boolean') member.isMuted = isMuted;
              if (typeof isDeafened === 'boolean') member.isDeafened = isDeafened;
              if (typeof isScreenSharing === 'boolean') member.isScreenSharing = isScreenSharing;
            }
          }

          io.to(`voice-${user.activeVoiceChannel}`).emit('user-voice-status-updated', {
            user: {
              ...user,
              socketId: socket.id
            }
          });
        }
        io.emit('voice-rooms-updated', {
          voiceRooms: Object.fromEntries(voiceRooms)
        });
      }
    });

    // 5. Music Bot Direct Controls
    socket.on('music-search', async ({ query }, callback) => {
      // Security: require an authenticated session before performing any server-side fetch
      const user = activeSockets.get(socket.id);
      if (!user) {
        return typeof callback === 'function'
          ? callback({ success: false, error: 'Unauthorized' })
          : null;
      }

      // Sanitize: must be a non-empty string within a reasonable length
      if (!query || typeof query !== 'string' || !query.trim() || query.trim().length > 300) {
        return typeof callback === 'function'
          ? callback({ success: false, error: 'Invalid query' })
          : null;
      }

      try {
        const results = await musicBot.searchTracks(query.trim());
        if (typeof callback === 'function') callback({ success: true, results });
      } catch (err) {
        if (typeof callback === 'function') callback({ success: false, error: err.message });
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

      let current = watchTogetherRooms.get(targetChannel) || { ...defaultWatchTogetherState };

      switch (action) {
        case 'start':
          current = {
            ...defaultWatchTogetherState,
            isActive: true,
            url: payload.url,
            isPlaying: true,
            currentTime: 0,
            lastSyncTimestamp: Date.now(),
            hostId: user.id,
            participants: [user.id]
          };
          break;
        case 'sync': {
          const isHost = current.hostId === user.id || !current.participants.includes(current.hostId);
          if (isHost || payload?.forceSync) {
            if (typeof payload.currentTime === 'number') {
              current.currentTime = Math.max(0, payload.currentTime);
            }
            if (typeof payload.isPlaying === 'boolean') {
              current.isPlaying = payload.isPlaying;
            }
            current.lastSyncTimestamp = Date.now();
            if (!current.participants.includes(user.id)) {
              current.participants.push(user.id);
            }
            if (!current.hostId || !current.participants.includes(current.hostId)) {
              current.hostId = user.id;
            }
          }
          break;
        }
        case 'join':
          if (current.isActive) {
            if (!current.participants.includes(user.id)) {
              current.participants.push(user.id);
            }
            if (!current.hostId || !current.participants.includes(current.hostId)) {
              current.hostId = user.id;
            }
            // Update baseline time with elapsed
            if (current.isPlaying && current.lastSyncTimestamp) {
              const elapsed = (Date.now() - current.lastSyncTimestamp) / 1000;
              current.currentTime = Math.max(0, (current.currentTime || 0) + elapsed);
              current.lastSyncTimestamp = Date.now();
            }
          }
          break;
        case 'leave':
          current.participants = current.participants.filter(id => id !== user.id);
          if (current.participants.length === 0) {
            if (current.isPlaying && current.lastSyncTimestamp) {
              const elapsed = (Date.now() - current.lastSyncTimestamp) / 1000;
              current.currentTime = Math.max(0, (current.currentTime || 0) + elapsed);
              current.lastSyncTimestamp = Date.now();
            }
            // Keep watchparty active in channel so members can return without losing video
            current.isPlaying = false;
            current.hostId = null;
          } else if (current.hostId === user.id) {
            current.hostId = current.participants[0];
          }
          break;
        case 'enqueue':
          if (current.isActive && payload.url) {
            if (!current.url) {
              current.url = payload.url;
              current.isPlaying = true;
              current.currentTime = 0;
              current.lastSyncTimestamp = Date.now();
              if (!current.participants.includes(user.id)) {
                current.participants.push(user.id);
              }
              current.hostId = user.id;
            } else {
              current.queue.push(payload.url);
            }
          }
          break;
        case 'next':
          if (current.isActive && (current.hostId === user.id || current.participants.length <= 1)) {
            if (current.queue.length > 0) {
              const nextUrl = current.queue.shift();
              current.url = nextUrl;
              current.isPlaying = true;
              current.currentTime = 0;
              current.lastSyncTimestamp = Date.now();
            } else {
              current = { ...defaultWatchTogetherState };
            }
          }
          break;
        case 'end':
          if (current.hostId === user.id || current.participants.includes(user.id) || current.participants.length === 0) {
            current = { ...defaultWatchTogetherState };
          }
          break;
      }

      watchTogetherRooms.set(targetChannel, current);

      const stateToSend = getCalculatedWatchTogetherState(targetChannel);
      io.to(`voice-${targetChannel}`).emit('watch-together-state-update', {
        channelId: targetChannel,
        state: stateToSend
      });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected] ID: ${socket.id}`);
      const user = activeSockets.get(socket.id);

      // Clean this socket from any voice rooms immediately
      leaveCurrentVoice(socket, user, io, voiceRooms, activeSockets);

      activeSockets.delete(socket.id);

      if (user) {
        const hasOtherSockets = hasOtherConnectedSocketForUser(user.id, socket.id, activeSockets, io);
        if (!hasOtherSockets) {
          const userIdx = registeredUsers.findIndex(u => u.id === user.id);
          if (userIdx !== -1) {
            registeredUsers[userIdx].gameStatus = '';
            registeredUsers[userIdx].gameStartedAt = null;
          }
          user.gameStatus = '';
          user.gameStartedAt = null;
          io.emit('user-status-changed', {
            user: {
              ...user,
              status: 'offline',
              gameStatus: '',
              gameStartedAt: null
            }
          });
        }
      }
    });
  });
}

function hasOtherVoiceSocketForUser(userId, currentSocketId, channelId, activeSockets, io) {
  if (!userId || !activeSockets || !channelId) return false;
  for (const [sockId, actUser] of activeSockets.entries()) {
    if (actUser && actUser.id === userId && sockId !== currentSocketId && actUser.activeVoiceChannel === channelId) {
      const sock = io?.sockets?.sockets?.get(sockId);
      if (sock && sock.connected) {
        return true;
      }
    }
  }
  return false;
}

function hasOtherConnectedSocketForUser(userId, currentSocketId, activeSockets, io) {
  if (!userId || !activeSockets) return false;
  for (const [sockId, actUser] of activeSockets.entries()) {
    if (actUser && actUser.id === userId && sockId !== currentSocketId) {
      const sock = io?.sockets?.sockets?.get(sockId);
      if (sock && sock.connected) {
        return true;
      }
    }
  }
  return false;
}

function cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, reason = '') {
  if (!voiceRooms || !io) return false;
  let changed = false;
  const seenUserIds = new Map(); // userId -> { channelId, socketId }

  for (const [channelId, room] of Array.from(voiceRooms.entries())) {
    if (!Array.isArray(room) || room.length === 0) {
      voiceRooms.delete(channelId);
      changed = true;
      continue;
    }

    const cleanRoom = [];
    const seenInThisRoom = new Set();
    for (const u of room) {
      if (!u || !u.id || !u.socketId) {
        changed = true;
        continue;
      }

      // Check socket liveness: socket must exist in io.sockets.sockets AND be connected
      const sock = io.sockets.sockets.get(u.socketId);
      if (!sock || !sock.connected) {
        changed = true;
        continue;
      }

      // Check duplicate in same room
      if (seenInThisRoom.has(u.id)) {
        changed = true;
        continue;
      }
      seenInThisRoom.add(u.id);

      // Single-room invariant: A user ID can exist in at most ONE voice channel across all channels
      if (seenUserIds.has(u.id)) {
        const existing = seenUserIds.get(u.id);
        const actUser = activeSockets?.get(u.socketId);
        // If activeSockets indicates this socket's activeVoiceChannel is channelId, prioritize it
        if (actUser && actUser.activeVoiceChannel === channelId && existing.channelId !== channelId) {
          const prevRoom = voiceRooms.get(existing.channelId) || [];
          const filteredPrev = prevRoom.filter((item) => item.id !== u.id);
          if (filteredPrev.length === 0) voiceRooms.delete(existing.channelId);
          else voiceRooms.set(existing.channelId, filteredPrev);

          seenUserIds.set(u.id, { channelId, socketId: u.socketId });
          cleanRoom.push(u);
        } else {
          changed = true;
          continue;
        }
      } else {
        seenUserIds.set(u.id, { channelId, socketId: u.socketId });
        cleanRoom.push(u);
      }
    }

    if (cleanRoom.length === 0) {
      voiceRooms.delete(channelId);
      watchTogetherRooms.delete(channelId);
      changed = true;
    } else if (cleanRoom.length !== room.length) {
      voiceRooms.set(channelId, cleanRoom);
      changed = true;
    }
  }

  if (activeSockets) {
    for (const [sockId, actUser] of activeSockets.entries()) {
      const voiceInfo = seenUserIds.get(actUser.id);
      if (voiceInfo && voiceInfo.socketId === sockId) {
        if (actUser.activeVoiceChannel !== voiceInfo.channelId) {
          actUser.activeVoiceChannel = voiceInfo.channelId;
          changed = true;
        }
      } else if (!voiceInfo && actUser.activeVoiceChannel) {
        actUser.activeVoiceChannel = null;
        changed = true;
      }
    }
  }

  return changed;
}

function leaveCurrentVoice(socket, user, io, voiceRooms, activeSockets) {
  const socketId = socket?.id;
  const userId = user?.id;

  if (!userId && !socketId) return;

  for (const [channelId, room] of Array.from(voiceRooms.entries())) {
    const hasMatch = room.some((u) => (socketId && u.socketId === socketId) || (userId && u.id === userId));
    if (hasMatch) {
      const hasOtherVoiceSock = hasOtherVoiceSocketForUser(userId, socketId, channelId, activeSockets, io);
      if (hasOtherVoiceSock) {
        // Just remove this dead socketId, keep user in room with the other active socket
        const updated = room.filter((u) => u.socketId !== socketId);
        voiceRooms.set(channelId, updated);
      } else {
        // Remove user completely from this room
        const updated = room.filter((u) => (socketId && u.socketId === socketId ? false : (userId && u.id === userId ? false : true)));
        if (updated.length === 0) {
          voiceRooms.delete(channelId);
        } else {
          voiceRooms.set(channelId, updated);
        }

        if (socket) {
          socket.leave(`voice-${channelId}`);
        }
        io.to(`voice-${channelId}`).emit('user-left-voice', {
          socketId: socketId || 'unknown',
          userId: userId || 'unknown',
          channelId
        });
      }
    }
  }

  if (user && !hasOtherVoiceSocketForUser(user.id, socketId, user.activeVoiceChannel, activeSockets, io)) {
    user.activeVoiceChannel = null;
    user.isScreenSharing = false;
  }

  cleanupAndSanitizeVoiceRooms(io, voiceRooms, activeSockets, 'leaveCurrentVoice');

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
