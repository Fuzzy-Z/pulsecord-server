import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'voxel-pulsecord-jwt-secret-key-2026-production-secure';
const DEFAULT_EXPIRY_DAYS = 30;

/**
 * Encodes string/object to standard URL-safe Base64.
 */
function base64UrlEncode(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(str).toString('base64url');
}

/**
 * Decodes URL-safe Base64 to string.
 */
function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

/**
 * Signs a standard RFC 7519 JSON Web Token (HS256) using Node.js native crypto.
 * No external npm dependencies required.
 */
export function signUserToken(user, expiresInDays = DEFAULT_EXPIRY_DAYS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + (expiresInDays * 24 * 60 * 60);
  const payload = {
    userId: user.id,
    email: user.email || '',
    username: user.username || '',
    exp
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(payload);
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signatureInput)
    .digest('base64url');

  return `${signatureInput}.${signature}`;
}

/**
 * Cryptographically verifies a JWT session token using constant-time comparison.
 * Returns decoded payload if valid and unexpired, or null otherwise.
 */
export function verifyUserToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
    const parts = cleanToken.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signature] = parts;
    const signatureInput = `${headerB64}.${payloadB64}`;

    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(signatureInput)
      .digest('base64url');

    // Constant-time check to prevent timing attacks
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null; // Token expired
    }

    return payload;
  } catch (err) {
    return null;
  }
}

/**
 * Securely hashes a password using Node.js native scrypt.
 * Output format: scrypt$<salt>$<hash>
 */
export async function hashPassword(plainPassword) {
  if (!plainPassword) return '';
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString('hex')}`;
}

/**
 * Verifies a plain-text password against a stored hash.
 * Supports:
 * 1. Native scrypt ($scrypt$...)
 * 2. Bcrypt ($2a$, $2b$) if available
 * 3. Legacy plain-text fallback (automatically triggers rehash)
 */
export async function verifyPassword(plainPassword, storedPassword) {
  if (!storedPassword || !plainPassword) return { match: false, needsRehash: false };

  // 1. Native Node.js Scrypt
  if (storedPassword.startsWith('scrypt$')) {
    const parts = storedPassword.split('$');
    if (parts.length === 3) {
      const salt = parts[1];
      const hash = parts[2];
      try {
        const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
        const match = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey);
        return { match, needsRehash: false };
      } catch (e) {
        return { match: false, needsRehash: false };
      }
    }
  }

  // 2. Bcrypt hash check (transparently check if bcryptjs is available)
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(storedPassword)) {
    try {
      const bcryptModule = await import('bcryptjs');
      const bcrypt = bcryptModule.default || bcryptModule;
      const match = await bcrypt.compare(plainPassword, storedPassword);
      return { match, needsRehash: true }; // Rehash to native scrypt on match
    } catch (e) {
      // bcryptjs not available in current environment
    }
  }

  // 3. Legacy plain-text fallback (upgrade to scrypt on first successful login)
  if (storedPassword === plainPassword) {
    return { match: true, needsRehash: true };
  }

  return { match: false, needsRehash: false };
}

/**
 * Sanitizes a user object, removing sensitive credentials.
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const copy = { ...user };
  delete copy.password;
  return copy;
}

/**
 * Validates message attachments to prevent oversized payloads / DoS.
 * Maximum 25MB per file (binary or base64 dataUrl).
 */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_ATTACHMENTS_PER_MSG = 10;
export const MAX_CONTENT_LENGTH = 4000;

export function validateAttachments(attachments) {
  if (!attachments) return { valid: true, sanitized: [] };
  if (!Array.isArray(attachments)) return { valid: false, error: 'Formato de anexo inválido.' };
  if (attachments.length > MAX_ATTACHMENTS_PER_MSG) {
    return { valid: false, error: `Máximo de ${MAX_ATTACHMENTS_PER_MSG} anexos por mensagem.` };
  }

  const sanitized = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;

    // Check size declared by client
    if (att.size && att.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return { valid: false, error: `Arquivo ${att.name || ''} excede o limite máximo de 25MB.` };
    }

    // Check base64 string length (~35 million characters for 25MB binary)
    if (typeof att.dataUrl === 'string') {
      const b64Len = att.dataUrl.length;
      if (b64Len > 35 * 1024 * 1024) {
        return { valid: false, error: `Arquivo ${att.name || ''} excede o limite máximo de 25MB.` };
      }
    }

    sanitized.push({
      name: String(att.name || 'arquivo').slice(0, 100),
      type: String(att.type || 'application/octet-stream').slice(0, 50),
      size: Number(att.size) || 0,
      dataUrl: att.dataUrl || null,
      isImage: Boolean(att.isImage),
      isVideo: Boolean(att.isVideo),
      isAudio: Boolean(att.isAudio)
    });
  }

  return { valid: true, sanitized };
}

/**
 * Checks if a user has permission to read / access a text channel or DM.
 */
export function canUserAccessChannel(user, channelId, servers, dmConversations) {
  if (!user || !channelId) return false;

  // 1. Direct Message checks
  if (channelId.startsWith('dm-')) {
    const dm = dmConversations.get(channelId);
    if (dm && dm.participants) {
      return dm.participants.includes(user.id);
    }
    const parts = channelId.replace('dm-', '').split('_');
    return parts.includes(user.id);
  }

  // 2. Server Channel checks
  const targetServer = servers.find((s) => s.channels && s.channels.some((c) => c.id === channelId));
  if (!targetServer) {
    return true;
  }

  // Public community servers allow all authenticated users
  if (targetServer.isCommunity || targetServer.id === 'server-1') {
    return true;
  }

  // Private server: user MUST be an explicit member or owner
  const isMember = targetServer.ownerId === user.id ||
    (Array.isArray(targetServer.memberIds) && targetServer.memberIds.includes(user.id));

  return isMember;
}

/**
 * Checks if a user has permission to join a voice channel.
 */
export function canUserAccessVoice(user, channelId, serverId, servers, dmConversations) {
  if (!user || !channelId) return false;

  // 1. DM Voice Call
  if (channelId.startsWith('dm-')) {
    const dm = dmConversations.get(channelId);
    if (dm && dm.participants) {
      return dm.participants.includes(user.id);
    }
    const parts = channelId.replace('dm-', '').split('_');
    return parts.includes(user.id);
  }

  // 2. Server Voice Channel
  const targetServer = servers.find(
    (s) => (serverId && s.id === serverId) || (s.channels && s.channels.some((c) => c.id === channelId))
  );

  if (!targetServer) return true;

  if (targetServer.isCommunity || targetServer.id === 'server-1') {
    return true;
  }

  const isMember = targetServer.ownerId === user.id ||
    (Array.isArray(targetServer.memberIds) && targetServer.memberIds.includes(user.id));

  return isMember;
}

/**
 * Checks if a user has permission to pin/unpin messages in a channel.
 */
export function canUserManageMessage(user, channelId, message, servers, dmConversations) {
  if (!user || !channelId) return false;

  // In DM: any participant can pin/unpin
  if (channelId.startsWith('dm-')) {
    return canUserAccessChannel(user, channelId, servers, dmConversations);
  }

  // In Server: owner, moderator, administrator, or author of message
  const targetServer = servers.find((s) => s.channels && s.channels.some((c) => c.id === channelId));
  if (!targetServer) return true;

  if (targetServer.ownerId === user.id) return true;

  // Check if author
  if (message && message.author && message.author.id === user.id) return true;

  // Check role permissions (admin / moderator)
  if (user.roleId === 'role-admin' || user.roleId === 'role-mod') return true;
  if (user.isAdmin || user.isModerator) return true;

  return false;
}
