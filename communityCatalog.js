export const MEDALS = [
  { id: 'alpha-tester', name: 'Explorador', material: 'silver', symbol: 'cube', description: 'Comece uma conversa e participe da comunidade.', mission: 'Envie 10 mensagens', metric: 'messages', target: 10, unit: 'mensagens' },
  { id: 'founder-gold', name: 'Arquiteto', material: 'gold', symbol: 'tower', description: 'Construa um espaço para outras pessoas.', mission: 'Tenha um servidor com 3 membros', metric: 'members', target: 3, unit: 'membros' },
  { id: 'security-hunter', name: 'Cronista', material: 'titanium', symbol: 'shield', description: 'Deixe sua marca nas conversas do Voxel.', mission: 'Envie 100 mensagens', metric: 'messages', target: 100, unit: 'mensagens' },
  { id: 'black-obsidian', name: 'Elo', material: 'obsidian', symbol: 'link', description: 'A comunidade começa com quem está ao seu lado.', mission: 'Adicione 3 amigos', metric: 'friends', target: 3, unit: 'amigos' },
  { id: 'sound-master', name: 'Frequência', material: 'bronze', symbol: 'wave', description: 'Reserve tempo para ouvir e conversar.', mission: 'Converse por 60 minutos em calls com outra pessoa', metric: 'voiceSeconds', target: 3600, unit: 'minutos' },
  { id: 'crimson-champion', name: 'Projeção', material: 'copper', symbol: 'play', description: 'Compartilhe um momento com a call.', mission: 'Transmita por 15 minutos com outra pessoa na call', metric: 'screenSeconds', target: 900, unit: 'minutos' },
];

export function missionSnapshot(user, servers = []) {
  const metrics = {
    messages: Math.max(0, Number(user.communityProgress?.messages) || 0),
    voiceSeconds: Math.max(0, Number(user.communityProgress?.voiceSeconds) || 0),
    screenSeconds: Math.max(0, Number(user.communityProgress?.screenSeconds) || 0),
    friends: new Set(user.friends || []).size,
    members: Math.max(0, ...servers.filter(s => s.ownerId === user.id).map(s => new Set(s.memberIds || s.members?.map(m => m.id) || []).size)),
  };
  const earned = (user.medals || []).filter(id => MEDALS.some(m => m.id === id));
  return { earned, equippedMedal: earned.includes(user.equippedMedal) ? user.equippedMedal : null,
    missions: MEDALS.map(m => ({ ...m, progress: Math.min(m.target, metrics[m.metric]), complete: metrics[m.metric] >= m.target, claimed: earned.includes(m.id) })) };
}

export function validateMedia(kind, name, dataUrl) {
  if (!['emoji', 'sound'].includes(kind)) throw new Error('Tipo de arquivo inválido.');
  const cleanName = String(name || '').trim();
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(cleanName)) throw new Error('Use um nome de 2 a 32 letras, números, hífens ou sublinhados.');
  if (typeof dataUrl !== 'string') throw new Error('Arquivo ausente.');
  const formats = kind === 'emoji' ? '(?:image/(?:png|jpeg|webp|gif))' : '(?:audio/(?:mpeg|mp3|wav|x-wav|ogg|webm|mp4|aac))';
  const match = dataUrl.match(new RegExp(`^data:(${formats});base64,([A-Za-z0-9+/]+={0,2})$`));
  if (!match) throw new Error('Formato de arquivo não suportado.');
  const bytes = Buffer.from(match[2], 'base64');
  const max = kind === 'emoji' ? 256 * 1024 : 1024 * 1024;
  if (bytes.length < 16 || bytes.length > max) throw new Error(kind === 'emoji' ? 'O emoji deve ter até 256 KB.' : 'O som deve ter até 1 MB.');
  // Reject disguised HTML/SVG/executables rather than trusting the browser MIME.
  const hex = bytes.subarray(0, 12).toString('hex');
  const validImage = hex.startsWith('89504e470d0a1a0a') || hex.startsWith('ffd8ff') || bytes.subarray(0,3).toString() === 'GIF' || (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP');
  const validAudio = bytes.subarray(0,3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || bytes.subarray(0,4).toString() === 'OggS' || (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WAVE') || hex.startsWith('1a45dfa3') || bytes.subarray(4,8).toString() === 'ftyp';
  if (kind === 'emoji' ? !validImage : !validAudio) throw new Error('O conteúdo do arquivo não corresponde a uma imagem ou áudio válido.');
  return { name: cleanName, dataUrl, size: bytes.length };
}
