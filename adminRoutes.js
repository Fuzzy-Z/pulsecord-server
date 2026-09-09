import express from 'express';
import jwt from 'jsonwebtoken';
import os from 'os';

export function createAdminRoutes({
  registeredUsers,
  servers,
  messageHistory,
  voiceRooms,
  activeSockets,
  verificationRequests,
  storage,
  io
}) {
  const router = express.Router();

  const ADMIN_SECRET = process.env.VOXEL_ADMIN_KEY || 'voxel_admin_2026!';
  const JWT_SECRET = process.env.JWT_SECRET || 'pulsecord-super-secret-key-2026';

  // Helper to persist state
  const saveState = () => {
    storage.saveData(registeredUsers, servers, messageHistory, verificationRequests);
  };

  // Middleware to authenticate admin requests
  const requireAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const secretHeader = req.headers['x-admin-key'];

    // Direct secret key check
    if (secretHeader && secretHeader === ADMIN_SECRET) {
      return next();
    }

    // Bearer token check
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'superadmin') {
          req.admin = decoded;
          return next();
        }
      } catch (err) {
        return res.status(401).json({ error: 'Token de administrador expirado ou inválido.' });
      }
    }

    return res.status(401).json({ error: 'Acesso negado: autenticação de administrador necessária.' });
  };

  // 1. Admin Login
  router.post('/login', (req, res) => {
    const { key, username } = req.body;
    if (!key || key !== ADMIN_SECRET) {
      return res.status(403).json({ error: 'Chave mestra de administrador incorreta.' });
    }

    const token = jwt.sign(
      { role: 'superadmin', username: username || 'Owner', timestamp: Date.now() },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        username: username || 'Proprietário Voxel',
        role: 'superadmin'
      }
    });
  });

  // Verify Token
  router.get('/verify-token', requireAdmin, (req, res) => {
    res.json({ valid: true, admin: req.admin || { role: 'superadmin' } });
  });

  // 2. Metrics & System Overview
  router.get('/metrics', requireAdmin, (req, res) => {
    let totalMessages = 0;
    for (const msgs of messageHistory.values()) {
      totalMessages += msgs.length;
    }

    let activeVoiceUsers = 0;
    for (const room of voiceRooms.values()) {
      activeVoiceUsers += (room.participants || []).length;
    }

    const verifiedUsersCount = registeredUsers.filter((u) => u.isVerified).length;
    const pendingVerificationsCount = verificationRequests.filter((v) => v.status === 'pending').length;

    res.json({
      uptime: process.uptime(),
      memory: {
        totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
        freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
        processMemMb: Math.round(process.memoryUsage().rss / (1024 * 1024))
      },
      counts: {
        registeredUsers: registeredUsers.length,
        onlineUsers: activeSockets.size,
        verifiedUsers: verifiedUsersCount,
        pendingVerifications: pendingVerificationsCount,
        servers: servers.length,
        activeVoiceRooms: voiceRooms.size,
        activeVoiceUsers,
        totalMessages
      }
    });
  });

  // 3. Verification Requests Management
  router.get('/verifications', requireAdmin, (req, res) => {
    const sorted = [...verificationRequests].sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    });
    res.json({ verifications: sorted });
  });

  router.post('/verifications/:id/approve', requireAdmin, (req, res) => {
    const { id } = req.params;
    const request = verificationRequests.find((v) => v.id === id);
    if (!request) {
      return res.status(404).json({ error: 'Pedido de verificação não encontrado.' });
    }

    request.status = 'approved';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = req.admin?.username || 'Admin';

    // Grant isVerified to the target user
    const user = registeredUsers.find((u) => u.id === request.userId);
    if (user) {
      user.isVerified = true;
      if (!Array.isArray(user.badges)) user.badges = [];
      if (!user.badges.some((b) => b.id === 'badge-verified')) {
        user.badges.push({
          id: 'badge-verified',
          name: 'Perfil Verificado',
          icon: 'BadgeCheck',
          color: 'text-sky-400'
        });
      }
    }

    // Update active socket if online
    for (const [socketId, activeUser] of activeSockets.entries()) {
      if (activeUser.id === request.userId) {
        activeUser.isVerified = true;
        if (!Array.isArray(activeUser.badges)) activeUser.badges = [];
        if (!activeUser.badges.some((b) => b.id === 'badge-verified')) {
          activeUser.badges.push({
            id: 'badge-verified',
            name: 'Perfil Verificado',
            icon: 'BadgeCheck',
            color: 'text-sky-400'
          });
        }
        io.to(socketId).emit('verification-status-updated', {
          status: 'approved',
          user: activeUser
        });
      }
    }

    saveState();

    // Broadcast user update so all clients re-render the blue badge immediately
    io.emit('user-profile-updated', {
      userId: request.userId,
      isVerified: true,
      badges: user?.badges || []
    });

    res.json({ success: true, message: 'Perfil verificado com sucesso! O selo azul já está ativo.', request });
  });

  router.post('/verifications/:id/reject', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const request = verificationRequests.find((v) => v.id === id);
    if (!request) {
      return res.status(404).json({ error: 'Pedido de verificação não encontrado.' });
    }

    request.status = 'rejected';
    request.rejectionReason = reason || 'Critérios de verificação não atendidos.';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = req.admin?.username || 'Admin';

    // Notify user if online
    for (const [socketId, activeUser] of activeSockets.entries()) {
      if (activeUser.id === request.userId) {
        io.to(socketId).emit('verification-status-updated', {
          status: 'rejected',
          reason: request.rejectionReason
        });
      }
    }

    saveState();
    res.json({ success: true, message: 'Pedido recusado.', request });
  });

  // 4. Users Management
  router.get('/users', requireAdmin, (req, res) => {
    const search = (req.query.search || '').toLowerCase().trim();
    const filterVerified = req.query.verified; // 'true' or 'false'

    let filtered = registeredUsers;

    if (search) {
      filtered = filtered.filter(
        (u) =>
          u.username?.toLowerCase().includes(search) ||
          u.displayName?.toLowerCase().includes(search) ||
          u.email?.toLowerCase().includes(search) ||
          u.id?.toLowerCase().includes(search)
      );
    }

    if (filterVerified === 'true') {
      filtered = filtered.filter((u) => u.isVerified);
    } else if (filterVerified === 'false') {
      filtered = filtered.filter((u) => !u.isVerified);
    }

    const onlineUserIds = new Set(Array.from(activeSockets.values()).map((s) => s.id));

    const usersWithOnlineState = filtered.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      email: u.email || '—',
      avatar: u.avatar,
      avatarUrl: u.avatarUrl,
      avatarColor: u.avatarColor,
      isVerified: Boolean(u.isVerified),
      isBanned: Boolean(u.isBanned),
      isGoogleAuth: Boolean(u.isGoogleAuth),
      badges: u.badges || [],
      createdAt: u.createdAt,
      bio: u.bio,
      isOnline: onlineUserIds.has(u.id)
    }));

    res.json({ users: usersWithOnlineState });
  });

  // Direct toggle or modify user
  router.patch('/users/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { isVerified, isBanned, username, displayName, bio, customBadges } = req.body;

    const user = registeredUsers.find((u) => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    if (typeof isVerified === 'boolean') {
      user.isVerified = isVerified;
      if (!Array.isArray(user.badges)) user.badges = [];
      if (isVerified) {
        if (!user.badges.some((b) => b.id === 'badge-verified')) {
          user.badges.push({
            id: 'badge-verified',
            name: 'Perfil Verificado',
            icon: 'BadgeCheck',
            color: 'text-sky-400'
          });
        }
      } else {
        user.badges = user.badges.filter((b) => b.id !== 'badge-verified');
      }
    }

    if (typeof isBanned === 'boolean') {
      user.isBanned = isBanned;
      if (isBanned) {
        // Disconnect their socket immediately
        for (const [socketId, activeUser] of activeSockets.entries()) {
          if (activeUser.id === userId) {
            io.to(socketId).emit('account-banned', { reason: 'Sua conta foi suspensa pela administração.' });
            io.sockets.sockets.get(socketId)?.disconnect(true);
          }
        }
      }
    }

    if (username && typeof username === 'string') user.username = username.trim();
    if (displayName && typeof displayName === 'string') user.displayName = displayName.trim();
    if (bio !== undefined) user.bio = String(bio).slice(0, 300);
    if (Array.isArray(customBadges)) user.badges = customBadges;

    // Update active socket if online
    for (const [, activeUser] of activeSockets.entries()) {
      if (activeUser.id === userId) {
        Object.assign(activeUser, {
          isVerified: user.isVerified,
          isBanned: user.isBanned,
          username: user.username,
          displayName: user.displayName,
          badges: user.badges
        });
      }
    }

    saveState();

    io.emit('user-profile-updated', {
      userId,
      isVerified: user.isVerified,
      isBanned: user.isBanned,
      badges: user.badges,
      username: user.username,
      displayName: user.displayName
    });

    res.json({ success: true, user });
  });

  // Delete user permanently
  router.delete('/users/:userId', requireAdmin, (req, res) => {
    const { userId } = req.params;
    const index = registeredUsers.findIndex((u) => u.id === userId);
    if (index === -1) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    registeredUsers.splice(index, 1);

    // Disconnect active socket
    for (const [socketId, activeUser] of activeSockets.entries()) {
      if (activeUser.id === userId) {
        io.to(socketId).emit('account-deleted');
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }

    // Remove from server member lists
    for (const s of servers) {
      if (s.memberIds) s.memberIds = s.memberIds.filter((id) => id !== userId);
    }

    saveState();
    res.json({ success: true, message: 'Conta de usuário excluída com sucesso.' });
  });

  // 5. Servers (Espaços) Management
  router.get('/servers', requireAdmin, (req, res) => {
    const serverList = servers.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      membersCount: (s.memberIds || []).length,
      channelsCount: (s.channels || []).length,
      rolesCount: (s.roles || []).length
    }));
    res.json({ servers: serverList });
  });

  router.delete('/servers/:serverId', requireAdmin, (req, res) => {
    const { serverId } = req.params;
    if (serverId === 'server-1') {
      return res.status(400).json({ error: 'Não é permitido excluir o servidor padrão da comunidade.' });
    }

    const idx = servers.findIndex((s) => s.id === serverId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Servidor não encontrado.' });
    }

    servers.splice(idx, 1);
    saveState();

    io.emit('server-deleted', { serverId });
    res.json({ success: true, message: 'Servidor excluído permanentemente.' });
  });

  // 6. Real-time Voice Rooms Monitor
  router.get('/voice-rooms', requireAdmin, (req, res) => {
    const rooms = [];
    for (const [channelId, room] of voiceRooms.entries()) {
      rooms.push({
        channelId,
        channelName: room.channelName || channelId,
        serverId: room.serverId,
        participantsCount: (room.participants || []).length,
        participants: (room.participants || []).map((p) => ({
          userId: p.userId,
          username: p.username,
          avatar: p.avatar,
          isMuted: p.isMuted,
          isDeafened: p.isDeafened,
          isScreenSharing: p.isScreenSharing,
          joinedAt: p.joinedAt
        }))
      });
    }
    res.json({ rooms });
  });

  // Kick user from voice channel
  router.post('/voice-rooms/disconnect-user', requireAdmin, (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId é obrigatório.' });
    }

    let foundSocketId = null;
    for (const [socketId, activeUser] of activeSockets.entries()) {
      if (activeUser.id === targetUserId) {
        foundSocketId = socketId;
        break;
      }
    }

    if (foundSocketId) {
      io.to(foundSocketId).emit('voice-force-disconnected', {
        reason: 'Você foi desconectado da chamada pela moderação.'
      });
      res.json({ success: true, message: 'Usuário desconectado da chamada.' });
    } else {
      res.status(404).json({ error: 'Usuário não está conectado a nenhuma sala de voz ativa.' });
    }
  });

  // 7. Global Broadcast Announcement
  router.post('/broadcast', requireAdmin, (req, res) => {
    const { title, message } = req.body;
    if (!title || !message) {
      return res.status(400).json({ error: 'Título e mensagem são obrigatórios.' });
    }

    io.emit('global-announcement', {
      title,
      message,
      author: req.admin?.username || 'Equipe Voxel',
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Anúncio transmitido com sucesso para todos os usuários online!' });
  });

  return router;
}
