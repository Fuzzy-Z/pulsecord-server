const PRIVATE_FIELDS = new Set(['password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'email', 'verificationCode']);

export function publicPayload(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return value;
  if (seen.has(value)) return seen.get(value);
  const output = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    if (!PRIVATE_FIELDS.has(key)) Object.defineProperty(output, key, { value: publicPayload(item, seen), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

/** Keep server-only email available for authorization without serializing it. */
export function socketUser(user) {
  const output = publicPayload(user);
  if (typeof user.email === 'string') Object.defineProperty(output, 'email', { value: user.email, writable: true, configurable: true, enumerable: false });
  return output;
}

const protectedEncoders = new WeakSet();
export function protectPublicEvents(io) {
  const encoder = io.encoder;
  if (protectedEncoders.has(encoder)) return;
  const encode = encoder.encode.bind(encoder);
  encoder.encode = packet => encode(packet.type === 2 || packet.type === 5 ? { ...packet, data: publicPayload(packet.data) } : packet);
  protectedEncoders.add(encoder);
}

const SCOPED_EVENTS = new Set(['new-message', 'message-pinned', 'message-unpinned', 'message-edited', 'message-deleted', 'new-verification-request']);
const protectedAdapters = new WeakSet();
/** Intersect existing rooms with authenticated recipients; an empty audience must not broadcast. */
export function protectScopedBroadcasts(io, mayReceive) {
  const adapter = io.sockets.adapter;
  if (protectedAdapters.has(adapter)) return;
  const broadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = (packet, options) => {
    const event = packet.data?.[0];
    if (!SCOPED_EVENTS.has(event)) return broadcast(packet, options);
    const eligible = new Set();
    let targeted;
    if (options.rooms?.size) {
      targeted = new Set();
      for (const room of options.rooms) for (const id of adapter.rooms.get(room) || []) targeted.add(id);
    }
    for (const id of io.sockets.sockets.keys()) {
      if ((!targeted || targeted.has(id)) && mayReceive(id, event, packet.data?.[1])) eligible.add(id);
    }
    if (!eligible.size) return;
    return broadcast(packet, { ...options, rooms: eligible });
  };
  protectedAdapters.add(adapter);
}
