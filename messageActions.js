// References are created from server history, never from a client-supplied quote.
export function resolveMessageReply(history, replyToId) {
  if (replyToId == null) return null;
  if (typeof replyToId !== 'string') throw new Error('Referência de resposta inválida.');
  const original = history.find(message => message.id === replyToId);
  if (!original) throw new Error('A mensagem original não está mais disponível.');
  const { id, username, displayName, avatarUrl, avatarColor } = original.author || {};
  return {
    messageId: original.id,
    author: { id, username, displayName, avatarUrl, avatarColor },
    content: String(original.content || '').slice(0, 300),
    hasAttachments: Boolean(original.attachments?.length)
  };
}

export function registerMessageActions({ socket, io, getUser, canAccess, messageHistory, save }) {
  socket.on('delete-message', (input, callback) => {
    const respond = result => { if (typeof callback === 'function') callback(result); };
    const user = getUser();
    if (!user) return respond({ success: false, error: 'Não autenticado.' });
    const { channelId, messageId } = input || {};
    if (typeof channelId !== 'string' || typeof messageId !== 'string' || !canAccess(channelId)) {
      return respond({ success: false, error: 'Acesso negado a este canal.' });
    }
    const history = messageHistory.get(channelId) || [];
    const message = history.find(item => item.id === messageId);
    if (!message) return respond({ success: false, error: 'Mensagem não encontrada.' });
    if (message.author?.id !== user.id) return respond({ success: false, error: 'Você só pode excluir suas próprias mensagens.' });
    messageHistory.set(channelId, history.filter(item => item.id !== messageId).map(item => (
      item.replyTo?.messageId === messageId
        ? { ...item, replyTo: { messageId, deleted: true } }
        : item
    )));
    save();
    // Production's scoped adapter restricts this event to channel/DM viewers.
    io.emit('message-deleted', { channelId, messageId });
    respond({ success: true });
  });
}
