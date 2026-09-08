import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const JWT_SECRET = process.env.JWT_SECRET || 'voxel-pulsecord-jwt-secret-key-2026-production-secure';
const JWT_EXPIRES_IN = '30d';

/**
 * Signs a standard JSON Web Token for authenticated sessions.
 */
export function signUserToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email || '',
      username: user.username || ''
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Cryptographically verifies a JWT session token.
 * Returns decoded payload if valid, or null if invalid/expired.
 */
export function verifyUserToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
    return jwt.verify(cleanToken, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Securely hashes a plain-text password with bcrypt (cost factor 10).
 */
export async function hashPassword(plainPassword) {
  if (!plainPassword) return '';
  return await bcrypt.hash(plainPassword, 10);
}

/**
 * Compares plain-text password with stored hash.
 * Supports transparent upgrade for legacy plain-text passwords.
 */
export async function verifyPassword(plainPassword, storedPassword) {
  if (!storedPassword || !plainPassword) return { match: false, needsRehash: false };

  // Check if stored password is a bcrypt hash ($2a$, $2b$, $2y$)
  const isBcrypt = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(storedPassword);

  if (isBcrypt) {
    const match = await bcrypt.compare(plainPassword, storedPassword);
    return { match, needsRehash: false };
  }

  // Legacy plain-text fallback (allows seamless migration)
  if (storedPassword === plainPassword) {
    return { match: true, needsRehash: true };
  }

  return { match: false, needsRehash: false };
}

/**
 * Sanitizes a user object, stripping sensitive credentials.
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
      // Approx base64: 4 chars = 3 bytes -> 25MB = ~34.9M chars
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
    // Channel not associated with any server (fallback / orphaned)
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

  // If member has permission in server roles
  return false;
}
