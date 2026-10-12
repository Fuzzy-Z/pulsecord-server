import crypto from 'node:crypto';
export function installPlatformConnections({ io, app, activeSockets, getUsers, save, fetcher = fetch, baseUrl = process.env.PUBLIC_APP_URL || 'https://app.voxelchat.com.br', publicProfile = user => ({ id: user.id, connections: user.connections || [] }) }) {
  baseUrl = baseUrl.replace(/\/$/, '');
  const reply = (ack, value) => { if (typeof ack === 'function') ack(value); };
  const pending = new Map();
  const current = socket => getUsers().find(u => u.id === activeSockets.get(socket.id)?.id);
  const providers = [
    { id:'steam',name:'Steam',available:true,description:'Verifique sua identidade Steam e mostre o perfil no Voxel.' },
    { id:'github',name:'GitHub',available:false,description:'Pode vincular identidade e repositórios públicos. Requer cadastrar um aplicativo OAuth.' },
    { id:'spotify',name:'Spotify',available:false,description:'Pode compartilhar a música em reprodução. Requer aplicativo, consentimento e permissões Spotify.' },
    { id:'twitch',name:'Twitch',available:false,description:'Pode vincular o canal e indicar transmissões. Requer aplicativo e consentimento Twitch.' },
  ];
  io.on('connection', socket => {
    socket.on('fetch-platform-connections', (_, ack) => { const user=current(socket); reply(ack,user?{success:true,providers,connections:user.connections||[]}:{success:false,error:'Não autenticado.'}); });
    socket.on('start-platform-connection', ({ provider }={}, ack) => {
      const user=current(socket);if(!user)return reply(ack,{success:false,error:'Não autenticado.'});
      if(provider!=='steam')return reply(ack,{success:false,error:'Essa plataforma ainda precisa de configuração OAuth.'});
      for(const [key,value]of pending)if(value.expires<Date.now()||value.userId===user.id)pending.delete(key);
      const state=crypto.randomUUID(),returnTo=`${baseUrl}/api/platform-connections/steam/callback?state=${state}`;
      pending.set(state,{userId:user.id,expires:Date.now()+600000,returnTo});
      const url=new URL('https://steamcommunity.com/openid/login');
      for(const [key,value]of Object.entries({'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'checkid_setup','openid.return_to':returnTo,'openid.realm':baseUrl+'/','openid.identity':'http://specs.openid.net/auth/2.0/identifier_select','openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'}))url.searchParams.set(key,value);
      reply(ack,{success:true,url:url.toString()});
    });
    socket.on('remove-platform-connection', ({ provider }={}, ack) => {const user=current(socket);if(!user)return reply(ack,{success:false,error:'Não autenticado.'});user.connections=(user.connections||[]).filter(c=>c.provider!==provider);save();for(const live of activeSockets.values())if(live.id===user.id)live.connections=user.connections;io.emit('user-profile-updated',{user:publicProfile(user)});reply(ack,{success:true,connections:user.connections});socket.emit('platform-connections-updated');});
  });
  app?.get('/api/platform-connections/steam/callback',async(req,res)=>{
    const state=String(req.query.state||''),session=pending.get(state);pending.delete(state);
    const fail=(code,message)=>res.status(code).type('text/plain').send(message);
    if(!session||session.expires<Date.now())return fail(400,'Conexão expirada. Volte ao Voxel e tente novamente.');
    const q=req.query;
    if(q['openid.mode']!=='id_res'||q['openid.return_to']!==session.returnTo||q['openid.op_endpoint']!=='https://steamcommunity.com/openid/login')return fail(400,'Resposta Steam inválida.');
    const match=String(q['openid.claimed_id']||'').match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
    if(!match||q['openid.identity']!==q['openid.claimed_id'])return fail(400,'Identidade Steam inválida.');
    try {
      const body=new URLSearchParams();for(const [key,value]of Object.entries(q))if(key.startsWith('openid.')&&typeof value==='string')body.set(key,value);body.set('openid.mode','check_authentication');
      const reply=await fetcher('https://steamcommunity.com/openid/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(15000)});
      if(!reply.ok||!(await reply.text()).split(/\r?\n/).includes('is_valid:true'))return fail(400,'Não foi possível verificar sua conta Steam.');
      const user=getUsers().find(u=>u.id===session.userId);if(!user)return fail(400,'Conta Voxel não encontrada.');
      const connection={provider:'steam',id:match[1],profileUrl:`https://steamcommunity.com/profiles/${match[1]}`,verified:true,connectedAt:new Date().toISOString()};
      user.connections=[...(user.connections||[]).filter(c=>c.provider!=='steam'),connection];save();
      for(const [id,live]of activeSockets)if(live.id===user.id){live.connections=user.connections;io.to(id).emit('platform-connections-updated');}
      io.emit('user-profile-updated', { user: publicProfile(user) });
      res.type('text/html').send('<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conta conectada · Voxel</title><body style="background:#15191f;color:#d8dde3;font:16px system-ui;padding:48px"><h1>Conta Steam conectada.</h1><p>Você pode voltar ao Voxel. A conexão aparecerá no seu perfil.</p></body></html>');
    }catch{fail(502,'A Steam não respondeu. Volte ao Voxel e tente novamente.');}
  });
  return { pending };
}
