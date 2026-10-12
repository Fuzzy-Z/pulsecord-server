import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';

const QUIZ = [
  ['Qual é o resultado de 8 × 7?', ['54', '56', '64', '49'], 1],
  ['Quantos lados tem um hexágono?', ['5', '6', '7', '8'], 1],
  ['Qual peça do xadrez se move em L?', ['Bispo', 'Torre', 'Cavalo', 'Rei'], 2],
  ['Qual número é primo?', ['21', '27', '29', '33'], 2],
  ['Quanto vale um quarto de 100?', ['20', '25', '40', '50'], 1],
  ['Qual planeta é conhecido como planeta vermelho?', ['Vênus', 'Marte', 'Júpiter', 'Saturno'], 1],
  ['Quantos segundos tem um minuto?', ['30', '60', '90', '100'], 1],
  ['Qual é a raiz quadrada de 81?', ['7', '8', '9', '10'], 2],
  ['Qual cor resulta de luz vermelha e verde?', ['Amarelo', 'Azul', 'Magenta', 'Preto'], 0],
  ['Qual é a unidade básica de informação digital?', ['Metro', 'Bit', 'Hertz', 'Watt'], 1],
  ['Qual destes animais é um mamífero?', ['Tubarão', 'Golfinho', 'Polvo', 'Sardinha'], 1],
  ['Qual número vem depois de 1, 1, 2, 3, 5?', ['6', '7', '8', '10'], 2],
];
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function serverProfile(user, serverId) {
  const p = user?.serverProfiles?.[serverId] || {};
  return { displayName: p.nickname || user?.displayName || user?.username, avatarUrl: p.avatarUrl || user?.avatarUrl || null, bio: p.bio || user?.bio || '', serverGameIdentity: p.game || '', serverProfileOverrides: [['nickname','displayName'],['avatarUrl','avatarUrl'],['bio','bio'],['game','serverGameIdentity']].filter(([key])=>Boolean(p[key])).map(([,field])=>field) };
}
export function voiceProfile(user, serverId) {
  const { bio, ...profile } = serverProfile(user, serverId);
  profile.serverProfileOverrides = profile.serverProfileOverrides.filter(field => field !== 'bio');
  return profile;
}

export function installLiveCalls({ io, activeSockets, voiceRooms, getServers, getUsers, save, publishServer, canAccess, leaveVoice, now = () => Date.now() }) {
  const sessions = new Map();
  const positionTimes = new Map();
  const serverFor = (user, serverId) => {
    const server = getServers().find(s => s.id === serverId);
    if (!server || !(server.isCommunity || server.id === 'server-1' || server.ownerId === user.id || server.memberIds?.includes(user.id))) throw new Error('Sem acesso a esta comunidade.');
    return server;
  };
  const channelFor = id => {
    const server = getServers().find(s => s.channels?.some(c => c.id === id));
    return { server, channel: server?.channels.find(c => c.id === id) };
  };
  const refreshProfile = (userId, onlyServer = null) => {
    const owner = getUsers().find(u => u.id === userId); if (!owner) return;
    for (const server of getServers()) if ((!onlyServer || server.id === onlyServer) && (server.isCommunity || server.id === 'server-1' || server.ownerId === userId || server.memberIds?.includes(userId))) publishServer(server.id);
    for (const [id, room] of voiceRooms) {
      const serverId = channelFor(id).server?.id;
      if (onlyServer && serverId !== onlyServer) continue;
      for (const person of room) if (person.id === userId) Object.assign(person, voiceProfile(owner, serverId));
    }
    io.emit('voice-rooms-updated', { voiceRooms: Object.fromEntries(voiceRooms) });
  };
  const callFor = (socket, id) => {
    const user = activeSockets.get(socket.id);
    if (!user || user.activeVoiceChannel !== id || !voiceRooms.get(id)?.some(p => p.socketId === socket.id)) throw new Error('Entre nesta call para usar o recurso.');
    const { server, channel } = channelFor(id);
    if (server && !canAccess(user, id, server.id)) throw new Error('Sem acesso a esta call.');
    if (!sessions.has(id)) sessions.set(id, { game: null, scores: {}, positions: {}, lastOccupied: now() });
    return { user, server, channel, session: sessions.get(id) };
  };
  const gameView = game => {
    if (!game) return null;
    const base = { id: game.id, kind: game.kind, host: game.host, status: game.status, result: game.result || null, players: game.players };
    if (game.kind === 'chess') return { ...base, fen: game.chess.fen(), turn: game.chess.turn(), check: game.chess.isCheck(), lastMove: game.lastMove || null,
      legalMoves: game.status === 'playing' ? game.chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion })) : [], history: game.chess.history() };
    const q = game.questions[game.round];
    return { ...base, round: game.round, total: game.questions.length, deadline: game.deadline || null, question: q ? q[0] : null, options: q ? q[1] : [], answered: Object.keys(game.answers), scores: game.scores,
      correctAnswer: game.status === 'reveal' ? q?.[2] : null };
  };
  const view = id => { const s = sessions.get(id); return { channelId: id, game: gameView(s?.game), scores: s?.scores || {}, positions: s?.positions || {}, voiceMode: channelFor(id).channel?.voiceMode || 'standard' }; };
  const broadcast = id => io.to(`voice-${id}`).emit('live-call-state', view(id));
  const finish = (id, result, winners = []) => {
    const session = sessions.get(id), game = session?.game;
    if (!game || game.status === 'finished') return;
    game.status = 'finished'; game.result = result;
    for (const userId of winners) session.scores[userId] = (session.scores[userId] || 0) + 1;
    broadcast(id);
  };
  const advanceQuiz = (id, game) => {
    game.round++;
    if (game.round >= game.questions.length) {
      const high = Math.max(0, ...Object.values(game.scores));
      const winners = Object.keys(game.scores).filter(id => high > 0 && game.scores[id] === high);
      finish(id, high > 0 ? 'Quiz concluído.' : 'Quiz concluído sem respostas corretas.', winners);
    } else { game.status = 'playing'; game.answers = {}; game.deadline = now() + 15000; broadcast(id); }
  };
  const revealQuiz = (id, game) => {
    if (game.status !== 'playing') return;
    const correct = game.questions[game.round][2];
    for (const [id, answer] of Object.entries(game.answers)) if (answer === correct) game.scores[id] = (game.scores[id] || 0) + 100;
    game.status = 'reveal'; game.deadline = now() + 4000; broadcast(id);
  };

  io.on('connection', socket => {
    const handle = (event, action) => socket.on(event, (data, callback) => {
      try {
        const user = activeSockets.get(socket.id); if (!user) throw new Error('Não autenticado.');
        callback?.({ success: true, ...action(data || {}, user) });
      } catch (error) { callback?.({ success: false, error: error.message }); }
    });
    handle('fetch-live-call', ({ channelId }) => { callFor(socket, channelId); return view(channelId); });
    handle('start-call-game', ({ channelId, kind }, user) => {
      const { session } = callFor(socket, channelId);
      if (!['chess', 'quiz'].includes(kind)) throw new Error('Jogo inválido.');
      if (session.game && session.game.status !== 'finished') throw new Error('Encerre o jogo atual antes de iniciar outro.');
      if (kind === 'chess') session.game = { id: randomUUID(), kind, host: user.id, status: 'waiting', chess: new Chess(), players: { w: user.id, b: null }, absent: {} };
      else {
        const questions = [...QUIZ].sort(() => Math.random() - 0.5).slice(0, 5);
        session.game = { id: randomUUID(), kind, host: user.id, status: 'waiting', players: { [user.id]: user.id }, questions, round: 0, answers: {}, scores: { [user.id]: 0 } };
      }
      broadcast(channelId); return view(channelId);
    });
    handle('join-call-game', ({ channelId }, user) => {
      const { session } = callFor(socket, channelId), g = session.game;
      if (!g || g.status !== 'waiting') throw new Error('Esta partida já começou. Você pode assistir.');
      if (g.kind === 'chess') {
        if (g.players.w === user.id || g.players.b === user.id) return view(channelId);
        if (g.players.b) throw new Error('As duas vagas já estão ocupadas.');
        g.players.b = user.id; g.status = 'playing';
      } else { g.players[user.id] = user.id; g.scores[user.id] ||= 0; }
      broadcast(channelId); return view(channelId);
    });
    handle('begin-call-quiz', ({ channelId }, user) => {
      const g = callFor(socket, channelId).session.game;
      if (!g || g.kind !== 'quiz' || g.host !== user.id || g.status !== 'waiting') throw new Error('Somente o organizador pode começar este quiz.');
      g.status = 'playing'; g.deadline = now() + 15000; broadcast(channelId); return view(channelId);
    });
    handle('move-call-chess', ({ channelId, gameId, from, to, promotion = 'q' }, user) => {
      const g = callFor(socket, channelId).session.game;
      if (!g || g.id !== gameId || g.kind !== 'chess' || g.status !== 'playing' || g.players[g.chess.turn()] !== user.id) throw new Error('Não é a sua vez nesta partida.');
      if (!/^[a-h][1-8]$/.test(String(from)) || !/^[a-h][1-8]$/.test(String(to)) || !['q','r','b','n'].includes(promotion)) throw new Error('Movimento inválido.');
      const turn = g.chess.turn();
      const move = g.chess.move({ from, to, promotion }); if (!move) throw new Error('Movimento ilegal.');
      g.lastMove = { from, to, san: move.san };
      if (g.chess.isCheckmate()) finish(channelId, 'Xeque-mate.', [g.players[turn]]);
      else if (g.chess.isGameOver()) finish(channelId, 'Empate.');
      else broadcast(channelId);
      return view(channelId);
    });
    handle('answer-call-quiz', ({ channelId, gameId, round, answer }, user) => {
      const g = callFor(socket, channelId).session.game;
      if (!g || g.id !== gameId || g.kind !== 'quiz' || g.status !== 'playing' || g.round !== round || !g.players[user.id] || now() >= g.deadline) throw new Error('Esta pergunta não está disponível para você.');
      if (!Number.isInteger(answer) || answer < 0 || answer > 3 || Object.hasOwn(g.answers, user.id)) throw new Error('Resposta inválida ou já enviada.');
      g.answers[user.id] = answer;
      if (Object.keys(g.answers).length === Object.keys(g.players).length) revealQuiz(channelId, g); else broadcast(channelId);
      return view(channelId);
    });
    handle('end-call-game', ({ channelId }, user) => {
      const g = callFor(socket, channelId).session.game;
      if (!g || g.status === 'finished' || !(g.host === user.id || Object.values(g.players).includes(user.id))) throw new Error('Você não pode encerrar este jogo.');
      if (g.kind === 'chess' && g.status === 'playing' && Object.values(g.players).includes(user.id)) finish(channelId, 'Partida encerrada por desistência.', Object.values(g.players).filter(id => id && id !== user.id));
      else finish(channelId, 'Jogo encerrado pelo organizador.');
      return view(channelId);
    });
    handle('move-call-avatar', ({ channelId, x, y }, user) => {
      const { channel, session } = callFor(socket, channelId);
      if (channel?.voiceMode !== 'proximity') throw new Error('Esta sala não usa voz por proximidade.');
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('Posição inválida.');
      const key = `${channelId}:${socket.id}`;
      if (now() - (positionTimes.get(key) || 0) < 90) return view(channelId);
      positionTimes.set(key, now()); session.positions[user.id] = { x, y }; broadcast(channelId); return {};
    });
    handle('fetch-server-profile', ({ serverId }, user) => {
      serverFor(user, serverId); const owner = getUsers().find(u => u.id === user.id);
      return { profile: owner?.serverProfiles?.[serverId] || {}, fallback: serverProfile(owner || user, null) };
    });
    handle('save-server-profile', ({ serverId, profile }, user) => {
      serverFor(user, serverId);
      const owner = getUsers().find(u => u.id === user.id); if (!owner) throw new Error('Conta não encontrada.');
      if (!profile || typeof profile !== 'object') throw new Error('Perfil inválido.');
      const avatar = bounded(profile.avatarUrl, 350000);
      if (avatar && !(avatar.startsWith('https://') || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar))) throw new Error('Use uma imagem PNG, JPEG, WebP ou GIF, ou um endereço HTTPS.');
      const value = { nickname: bounded(profile.nickname, 32), bio: bounded(profile.bio, 200), game: bounded(profile.game, 80), avatarUrl: avatar };
      owner.serverProfiles ||= {}; owner.serverProfiles[serverId] = value;
      save(); refreshProfile(user.id, serverId);
      return { profile: value };
    });
    handle('fetch-voice-devices', (_, user) => ({ devices: [...activeSockets].filter(([id, u]) => id !== socket.id && u.id === user.id && u.activeVoiceChannel && voiceRooms.get(u.activeVoiceChannel)?.some(p => p.socketId === id)).map(([id, u]) => {
      const ua = io.sockets.sockets.get(id)?.handshake.headers['user-agent'] || '';
      return { socketId: id, channelId: u.activeVoiceChannel, serverId: channelFor(u.activeVoiceChannel).server?.id || null, channelName: channelFor(u.activeVoiceChannel).channel?.title || 'Call privada', label: /Android/i.test(ua) ? 'Android' : /Electron/i.test(ua) ? 'Desktop' : 'Navegador' };
    }) }));
    handle('configure-temporary-call', ({ channelId, name, userLimit, privateRoom, invitedIds }, user) => {
      const { server, channel } = channelFor(channelId);
      if (!server || channel?.temporaryOwnerId !== user.id) throw new Error('Somente o dono desta sala pode configurá-la.');
      const limit = Number(userLimit); if (!Number.isInteger(limit) || limit < 0 || limit > 99) throw new Error('Limite inválido.');
      const ids = Array.isArray(invitedIds) ? [...new Set(invitedIds)].slice(0, 99) : [];
      if (ids.some(id => typeof id !== 'string' || !(server.isCommunity || server.id === 'server-1' || server.memberIds?.includes(id) || server.ownerId === id) || !getUsers().some(u => u.id === id))) throw new Error('Escolha convidados desta comunidade.');
      channel.title = bounded(name, 48) || channel.title; channel.name = channel.title; channel.userLimit = limit; channel.privateRoom = Boolean(privateRoom); channel.invitedIds = ids; save(); publishServer(server.id);
      if (channel.privateRoom) {
        for (const person of [...(voiceRooms.get(channelId) || [])]) {
          if ([user.id, server.ownerId, ...ids].includes(person.id)) continue;
          const previous = activeSockets.get(person.socketId), previousSocket = io.sockets.sockets.get(person.socketId);
          if (previous && previousSocket && leaveVoice) { leaveVoice(previousSocket, previous); previousSocket.emit('force-disconnected-from-voice', { channelId }); }
        }
      }
      return { channel };
    });
    socket.on('disconnect', () => { for (const key of positionTimes.keys()) if (key.endsWith(`:${socket.id}`)) positionTimes.delete(key); });
  });

  const prepareJoin = (user, channelId, serverId) => {
    const { server, channel } = channelFor(channelId);
    if (serverId && server?.id !== serverId) throw new Error('Canal não pertence a esta comunidade.');
    if (channel?.temporaryOwnerId && channel.privateRoom && channel.temporaryOwnerId !== user.id && !channel.invitedIds?.includes(user.id) && server.ownerId !== user.id) throw new Error('Esta sala é privada. Peça um convite ao dono.');
    if (channel?.voiceMode !== 'temporary-lobby') return channelId;
    serverFor(user, server.id); if (!canAccess(user, channelId, server.id)) throw new Error('Sem acesso a este canal de entrada.');
    const existing = server.channels.find(c => c.temporaryOwnerId === user.id && c.lobbyId === channel.id);
    if (existing) return existing.id;
    if (server.channels.filter(c => c.temporaryOwnerId).length >= 50) throw new Error('Limite de salas temporárias atingido.');
    const room = { id: `voice-${randomUUID()}`, type: 'voice', title: `Sala de ${bounded(user.displayName || user.username, 32)}`, name: `Sala de ${bounded(user.displayName || user.username, 32)}`, topic: '', voiceMode: 'standard', temporaryOwnerId: user.id, lobbyId: channel.id, createdAt: now(), privateRoom: false, invitedIds: [], userLimit: 0, permissions: structuredClone(channel.permissions || {}) };
    server.channels.push(room); save(); publishServer(server.id); return room.id;
  };
  const tick = () => {
    for (const [id, session] of sessions) {
      const occupants = voiceRooms.get(id) || [], ids = new Set(occupants.map(u => u.id));
      if (ids.size) session.lastOccupied = now();
      else if (now() - session.lastOccupied > 30000) { sessions.delete(id); continue; }
      let changed = false;
      for (const id of Object.keys(session.positions)) if (!ids.has(id)) { delete session.positions[id]; changed = true; }
      occupants.forEach((p, i) => { if (!session.positions[p.id]) { session.positions[p.id] = { x: Math.min(.9, .2 + (i % 4) * .18), y: .3 + Math.floor(i / 4) * .1 % .6 }; changed = true; } });
      const g = session.game;
      if (g?.kind === 'quiz' && g.deadline && now() >= g.deadline) {
        if (g.status === 'playing') revealQuiz(id, g); else if (g.status === 'reveal') advanceQuiz(id, g);
      }
      if (g?.kind === 'chess' && g.status === 'playing') {
        for (const player of Object.values(g.players)) {
          if (ids.has(player)) delete g.absent[player]; else g.absent[player] ||= now();
          if (g.absent[player] && now() - g.absent[player] > 30000) finish(id, 'Partida encerrada após saída de um jogador.', Object.values(g.players).filter(p => p && p !== player && ids.has(p)));
        }
      }
      if (changed) broadcast(id);
    }
    for (const server of getServers()) {
      const expired = server.channels?.filter(c => c.temporaryOwnerId && !(voiceRooms.get(c.id)?.length) && now() - c.createdAt > 10000) || [];
      if (!expired.length) continue;
      const ids = new Set(expired.map(c => c.id)); server.channels = server.channels.filter(c => !ids.has(c.id));
      server.removedTemporaryChannels = [...new Set([...(server.removedTemporaryChannels || []), ...ids])];
      for (const id of ids) { sessions.delete(id); io.emit('channel-deleted', { serverId: server.id, channelId: id }); }
      save(); publishServer(server.id);
    }
  };
  const timer = setInterval(tick, 1000); timer.unref?.();
  return { prepareJoin, view, refreshProfile, close: () => clearInterval(timer), tick };
}
