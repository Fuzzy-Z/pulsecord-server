import { randomUUID } from 'node:crypto';

const REQUEST_MS = 30_000;
const GRANT_MS = 10 * 60_000;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
const publicController = user => ({ id: user.id, username: user.username, displayName: user.displayName || user.username });
const publicRequest = ({ roomId, hostUserId, controllerUserId, ...request }) => request;
const publicGrant = ({ roomId, hostUserId, controllerUserId, ...grant }) => grant;

/** Ephemeral consent only. Input is never accepted or executed by this server. */
export function installPlayTogether({ io, activeSockets, voiceRooms, canPresent = () => true, now = Date.now }) {
  const hosts = new Map(), pending = new Map(), grants = new Map(), attempts = new Map();
  const seat = socketId => {
    const user = activeSockets.get(socketId);
    if (!user?.id || !user.activeVoiceChannel || !io.sockets.sockets.has(socketId)) return null;
    const member = voiceRooms.get(user.activeVoiceChannel)?.find(item => item.socketId === socketId && item.id === user.id);
    return member ? { user, member, roomId: user.activeVoiceChannel } : null;
  };
  const hostValid = (socketId, host) => {
    const current = seat(socketId);
    return current && current.roomId === host.roomId && current.user.id === host.userId && current.user.isScreenSharing === true &&
      current.member.canPresent !== false && canPresent(current.user, current.roomId, socketId) === true;
  };
  const pairValid = record => {
    const host = hosts.get(record.hostSocketId), controller = seat(record.controllerSocketId), current = seat(record.hostSocketId);
    return Boolean(host && host.streamId === record.streamId && host.roomId === record.roomId && hostValid(record.hostSocketId, host) &&
      controller && current && controller.roomId === record.roomId && controller.user.id === record.controllerUserId &&
      current.user.id === record.hostUserId && controller.user.id !== current.user.id);
  };
  const notifyPair = (record, event, data) => {
    io.to(record.hostSocketId).emit(event, data);
    io.to(record.controllerSocketId).emit(event, data);
  };
  const finishRequest = (request, reason) => {
    pending.delete(request.id);
    notifyPair(request, 'play-together-request-ended', { requestId: request.id, reason });
  };
  const revoke = (grant, reason) => {
    grants.delete(grant.id);
    notifyPair(grant, 'play-together-revoked', { grantId: grant.id, reason });
  };
  const publishHost = (socketId, host, available) => {
    const payload = { hostSocketId: socketId, streamId: host.streamId, available };
    for (const id of io.sockets.sockets.keys()) if (seat(id)?.roomId === host.roomId) io.to(id).emit('play-together-available', payload);
  };
  const clearHost = (socketId, reason) => {
    const host = hosts.get(socketId);
    hosts.delete(socketId);
    for (const request of [...pending.values()]) if (request.hostSocketId === socketId) finishRequest(request, reason);
    for (const grant of [...grants.values()]) if (grant.hostSocketId === socketId) revoke(grant, reason);
    if (host) publishHost(socketId, host, false);
  };
  const sweep = () => {
    const time = now();
    for (const [id, host] of [...hosts]) if (!hostValid(id, host)) clearHost(id, 'A transmissão não está mais disponível para controle.');
    for (const request of [...pending.values()]) {
      if (request.expiresAt <= time) finishRequest(request, 'O pedido de controle expirou.');
      else if (!pairValid(request)) finishRequest(request, 'A chamada ou a transmissão mudou.');
    }
    for (const grant of [...grants.values()]) {
      if (grant.expiresAt <= time) revoke(grant, 'A autorização de controle expirou.');
      else if (!pairValid(grant)) revoke(grant, 'A chamada ou a transmissão mudou.');
    }
    for (const [id, times] of attempts) {
      const recent = times.filter(time => time > now() - 10_000);
      if (recent.length) attempts.set(id, recent); else attempts.delete(id);
    }
  };
  const timer = setInterval(sweep, 1000);
  timer.unref?.();

  const connection = socket => {
    const bind = (event, handler) => socket.on(event, (input, callback) => {
      const respond = result => { if (typeof callback === 'function') callback(result); };
      if (!activeSockets.get(socket.id)?.id) return respond({ success: false, error: 'Não autenticado.' });
      sweep();
      handler(input && typeof input === 'object' && !Array.isArray(input) ? input : {}, respond);
    });
    bind('play-together-host-state', (input, respond) => {
      if (input.available === false) {
        clearHost(socket.id, 'O transmissor encerrou o controle.');
        return respond({ success: true });
      }
      const current = seat(socket.id);
      if (input.available !== true || !identifier(input.streamId) || !current || !hostValid(socket.id, { roomId: current.roomId, userId: current.user.id })) {
        return respond({ success: false, error: 'Inicie uma transmissão autorizada antes de oferecer controle.' });
      }
      const previous = hosts.get(socket.id);
      if (previous && previous.streamId === input.streamId && previous.roomId === current.roomId && previous.userId === current.user.id) return respond({ success: true });
      if (previous && (previous.streamId !== input.streamId || previous.roomId !== current.roomId)) clearHost(socket.id, 'A janela ou a transmissão foi alterada.');
      const host = { streamId: input.streamId, roomId: current.roomId, userId: current.user.id };
      hosts.set(socket.id, host);
      publishHost(socket.id, host, true);
      respond({ success: true });
    });
    bind('play-together-list', (_, respond) => {
      const current = seat(socket.id);
      if (!current) return respond({ success: false, error: 'Entre em uma chamada para usar o Voxel Play Together.' });
      respond({ success: true, hosts: [...hosts].filter(([, host]) => host.roomId === current.roomId).map(([hostSocketId, host]) => ({ hostSocketId, streamId: host.streamId, available: true })) });
    });
    bind('play-together-request', (input, respond) => {
      if (!identifier(input.hostSocketId) || !identifier(input.streamId)) return respond({ success: false, error: 'Transmissão inválida.' });
      const host = hosts.get(input.hostSocketId), controller = seat(socket.id), hostSeat = seat(input.hostSocketId);
      if (!host || !controller || !hostSeat || host.streamId !== input.streamId || !hostValid(input.hostSocketId, host) || host.roomId !== controller.roomId || hostSeat.user.id === controller.user.id) {
        return respond({ success: false, error: 'O controle desta transmissão não está disponível nesta chamada.' });
      }
      const recent = (attempts.get(socket.id) || []).filter(time => time > now() - 10_000);
      if (recent.length >= 3) return respond({ success: false, error: 'Aguarde alguns segundos antes de pedir controle novamente.' });
      if ([...pending.values()].filter(r => r.hostSocketId === input.hostSocketId).length >= 8) return respond({ success: false, error: 'O transmissor já possui vários pedidos pendentes. Tente novamente em instantes.' });
      attempts.set(socket.id, [...recent, now()]);
      for (const request of [...pending.values()]) if (request.controllerSocketId === socket.id) finishRequest(request, 'O pedido anterior foi substituído.');
      const request = { id: `ptr-${randomUUID()}`, hostSocketId: input.hostSocketId, controllerSocketId: socket.id,
        streamId: host.streamId, roomId: host.roomId, hostUserId: hostSeat.user.id, controllerUserId: controller.user.id,
        controller: publicController(controller.user), expiresAt: now() + REQUEST_MS };
      pending.set(request.id, request);
      io.to(request.hostSocketId).emit('play-together-requested', publicRequest(request));
      respond({ success: true, request: publicRequest(request) });
    });
    bind('play-together-approve', (input, respond) => {
      const request = identifier(input.requestId) ? pending.get(input.requestId) : null;
      if (!request || request.hostSocketId !== socket.id || !pairValid(request)) return respond({ success: false, error: 'Pedido de controle indisponível ou sem permissão.' });
      for (const grant of [...grants.values()]) if (grant.hostSocketId === request.hostSocketId || grant.controllerSocketId === request.controllerSocketId) revoke(grant, 'O transmissor concedeu uma nova autorização.');
      pending.delete(request.id);
      const grant = { id: `ptg-${randomUUID()}`, hostSocketId: request.hostSocketId, controllerSocketId: request.controllerSocketId,
        streamId: request.streamId, roomId: request.roomId, hostUserId: request.hostUserId, controllerUserId: request.controllerUserId,
        controller: request.controller, expiresAt: now() + GRANT_MS };
      grants.set(grant.id, grant);
      finishRequest(request, 'O pedido de controle foi aprovado.');
      notifyPair(grant, 'play-together-granted', publicGrant(grant));
      respond({ success: true, grant: publicGrant(grant) });
    });
    bind('play-together-cancel-request', (input, respond) => {
      const request = identifier(input.requestId) ? pending.get(input.requestId) : null;
      if (!request || (request.hostSocketId !== socket.id && request.controllerSocketId !== socket.id)) return respond({ success: false, error: 'Pedido de controle indisponível ou sem permissão.' });
      finishRequest(request, 'O pedido de controle foi encerrado.');
      respond({ success: true });
    });
    bind('play-together-revoke', (input, respond) => {
      const grant = identifier(input.grantId) ? grants.get(input.grantId) : null;
      if (!grant || (grant.hostSocketId !== socket.id && grant.controllerSocketId !== socket.id)) return respond({ success: false, error: 'Autorização indisponível ou sem permissão.' });
      revoke(grant, 'O controle foi encerrado.');
      respond({ success: true });
    });
    socket.on('disconnect', () => {
      clearHost(socket.id, 'O transmissor desconectou.');
      for (const request of [...pending.values()]) if (request.controllerSocketId === socket.id) finishRequest(request, 'O convidado desconectou.');
      for (const grant of [...grants.values()]) if (grant.controllerSocketId === socket.id) revoke(grant, 'O convidado desconectou.');
      attempts.delete(socket.id);
    });
    // Existing voice handlers mutate room membership synchronously. Inspect the
    // resulting state after those handlers, as well as once per second for roles.
    socket.onAny(event => {
      if (['join-voice', 'leave-voice', 'update-voice-status', 'auth-login', 'auth-session', 'move-voice-user', 'disconnect-voice-user'].includes(event)) queueMicrotask(sweep);
    });
  };
  io.on('connection', connection);
  return { sweep, close() { clearInterval(timer); io.off('connection', connection); } };
}
