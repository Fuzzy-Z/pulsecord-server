import crypto from 'node:crypto';
import { MEDALS, missionSnapshot, validateMedia } from './communityCatalog.js';

export function installCommunityFeatures({ io, activeSockets, voiceRooms, getUsers, getServers, save, canAccessChannel, now = Date.now, publicProfile = user => ({ id: user.id, medals: user.medals || [], equippedMedal: user.equippedMedal || null }) }) {
  const playTimes = new Map();
  const userFor = socket => getUsers().find(u => u.id === activeSockets.get(socket.id)?.id);
  const serverFor = (socket, id) => {
    const user = userFor(socket), server = getServers().find(s => s.id === id);
    if (!user || !server || !(server.ownerId === user.id || (server.memberIds || []).includes(user.id))) throw new Error('Você não tem acesso a este servidor.');
    return { user, server };
  };
  const mayManage = (server, user) => server.ownerId === user.id || (server.roles || []).some(r => r.id === server.memberRoles?.[user.id] && (r.permissions?.administrator || r.permissions?.manageServer));
  const publishProfile = user => {
    for (const live of activeSockets.values()) if (live.id === user.id) { live.medals = user.medals; live.equippedMedal = user.equippedMedal; }
    io.emit('user-profile-updated', { user: publicProfile(user) });
  };
  io.on('connection', socket => {
    const handle = (event, fn) => socket.on(event, async (input, ack) => {
      try { if (!userFor(socket)) throw new Error('Não autenticado.'); const response = await fn(input || {}); if (typeof ack === 'function') ack({ success: true, ...response }); }
      catch (e) { if (typeof ack === 'function') ack({ success: false, error: e.message }); }
    });
    handle('fetch-missions', () => missionSnapshot(userFor(socket), getServers()));
    handle('claim-medal', ({ medalId }) => {
      const user = userFor(socket), mission = missionSnapshot(user, getServers()).missions.find(m => m.id === medalId);
      if (!mission?.complete) throw new Error('Conclua a missão antes de resgatar a medalha.');
      user.medals = [...new Set([...(user.medals || []), medalId])]; save(); publishProfile(user);
      return missionSnapshot(user, getServers());
    });
    handle('equip-medal', ({ medalId }) => {
      const user = userFor(socket);
      if (medalId !== null && (!(user.medals || []).includes(medalId) || !MEDALS.some(m => m.id === medalId))) throw new Error('Essa medalha ainda não foi desbloqueada.');
      user.equippedMedal = medalId; save(); publishProfile(user); return missionSnapshot(user, getServers());
    });
    handle('fetch-server-media', ({ serverId }) => { const { server } = serverFor(socket, serverId); return { emojis: server.emojis || [], sounds: server.sounds || [] }; });
    handle('add-server-media', ({ serverId, kind, name, dataUrl, duration }) => {
      const { user, server } = serverFor(socket, serverId);
      if (!mayManage(server, user)) throw new Error('Somente quem gerencia o servidor pode enviar arquivos.');
      const media = validateMedia(kind, name, dataUrl), field = kind === 'emoji' ? 'emojis' : 'sounds';
      const list = server[field] || [];
      if (list.length >= (kind === 'emoji' ? 50 : 16)) throw new Error('Todos os espaços disponíveis estão ocupados.');
      if (list.some(m => m.name.toLowerCase() === media.name.toLowerCase())) throw new Error('Esse nome já está em uso.');
      if (kind === 'sound' && (!Number.isFinite(duration) || duration <= 0 || duration > 5)) throw new Error('Escolha um som com até 5 segundos.');
      const item = { ...media, id: crypto.randomUUID(), authorId: user.id, authorName: user.displayName || user.username, ...(kind === 'sound' ? { duration } : {}) };
      server[field] = [...list, item]; save(); io.emit('server-media-updated', { serverId }); return { item };
    });
    handle('delete-server-media', ({ serverId, kind, mediaId }) => {
      const { user, server } = serverFor(socket, serverId);
      if (!mayManage(server, user)) throw new Error('Sem permissão para excluir arquivos.');
      if (!['emoji', 'sound'].includes(kind)) throw new Error('Tipo inválido.');
      const field = kind === 'emoji' ? 'emojis' : 'sounds'; server[field] = (server[field] || []).filter(m => m.id !== mediaId);
      save(); io.emit('server-media-updated', { serverId }); return {};
    });
    handle('play-server-sound', ({ serverId, channelId, soundId }) => {
      const { user, server } = serverFor(socket, serverId);
      const active = activeSockets.get(socket.id);
      if (!server.channels?.some(c => c.id === channelId && c.type === 'voice') || active.activeVoiceChannel !== channelId || !canAccessChannel(user, channelId, serverId)) throw new Error('Entre em uma call deste servidor para tocar um som.');
      const peer = voiceRooms.get(channelId)?.find(p => p.socketId === socket.id);
      if (!peer || peer.canSpeak === false) throw new Error('Você não tem permissão para transmitir áudio nesta call.');
      const role = server.roles?.find(r => r.id === server.memberRoles?.[user.id]);
      if (role?.permissions?.useSoundboard === false && !mayManage(server, user)) throw new Error('Seu cargo não permite usar o painel de sons.');
      const sound = server.sounds?.find(s => s.id === soundId); if (!sound) throw new Error('Som não encontrado.');
      const key = `${channelId}:${user.id}`;
      if (playTimes.has(key) && now() - playTimes.get(key) < 5000) throw new Error('Aguarde 5 segundos entre sons.');
      playTimes.set(key, now()); io.to(`voice-${channelId}`).emit('server-sound-play', { channelId, soundId, dataUrl: sound.dataUrl, authorId: user.id }); return {};
    });
  });
  const presence = new Map();
  const tick = () => {
    const current = now(); let changed = false;
    for (const [id, entry] of presence) {
      const delta = Math.min(60, Math.max(0, (current - entry.since) / 1000));
      const user = getUsers().find(u => u.id === id);
      if (!user || !delta) continue;
      user.communityProgress ||= {};
      user.communityProgress.voiceSeconds = (user.communityProgress.voiceSeconds || 0) + delta;
      if (entry.screen) user.communityProgress.screenSeconds = (user.communityProgress.screenSeconds || 0) + delta;
      changed = true;
    }
    presence.clear();
    for (const people of voiceRooms.values()) {
      const real = people.filter(p => activeSockets.has(p.socketId) && !String(p.id).startsWith('bot-'));
      if (new Set(real.map(p => p.id)).size < 2) continue;
      for (const peer of real) {
        const old = presence.get(peer.id);
        presence.set(peer.id, { since: current, screen: Boolean(old?.screen || peer.isScreenSharing) });
      }
    }
    if (changed) save();
  };
  const timer = setInterval(tick, 30000); timer.unref?.();
  return { recordMessage(userId) { const user = getUsers().find(u => u.id === userId); if (user) { user.communityProgress ||= {}; user.communityProgress.messages = (user.communityProgress.messages || 0) + 1; } }, tick, close() { clearInterval(timer); playTimes.clear(); presence.clear(); } };
}
