export function visibleServerToUser(server, user) {
  return server.ownerId === user.id || (!user.leftServerIds?.includes(server.id) &&
    (server.memberIds?.includes(user.id) || server.id === 'server-1' || server.isCommunity));
}

export function installServerLifecycle({io,activeSockets,getServers,getUsers,messageHistory,storage,save,leaveVoice,onDelete,onUpdate}) {
  const busy=new Set();
  io.on('connection',socket=>{
    for(const action of ['leave','delete'])socket.on(`${action}-server`,async(payload,callback)=>{
      const {serverId}=payload||{};
      const done=result=>typeof callback==='function'&&callback(result),user=activeSockets.get(socket.id),servers=getServers();
      const server=servers.find(s=>s.id===serverId);
      if(!user||!server)return done({success:false,error:'Servidor não encontrado.'});
      const owner=server.ownerId===user.id;
      if(action==='delete'&&!owner)return done({success:false,error:'Somente o dono pode excluir o servidor.'});
      if(action==='leave'&&owner)return done({success:false,error:'O dono deve excluir o servidor ou transferir a propriedade.'});
      if(action==='leave'&&!visibleServerToUser(server,user))return done({success:false,error:'Você não participa desse servidor.'});
      if(busy.has(serverId))return done({success:false,error:'Aguarde a alteração anterior.'});
      busy.add(serverId);
      try{
        const channels=new Set((server.channels||[]).map(c=>c.id));
        const targets=[...activeSockets].filter(([,member])=>action==='delete'?(visibleServerToUser(server,member)||channels.has(member.activeVoiceChannel)):member.id===user.id);
        for(const [id,member]of targets){
          const peer=io.sockets.sockets.get(id);
          if(channels.has(member.activeVoiceChannel)){
            peer?.emit('force-disconnected-from-voice',{channelId:member.activeVoiceChannel,reason:action==='delete'?'Servidor excluído.':'Você saiu do servidor.'});
            if(peer)leaveVoice(peer,member);
          }
        }
        const affected=action==='delete'?getUsers().filter(u=>visibleServerToUser(server,u)):getUsers().filter(u=>u.id===user.id);
        for(const member of [...affected,...targets.map(([,u])=>u)]){
          member.serverIds=(member.serverIds||[]).filter(id=>id!==serverId);
          member.leftServerIds=[...new Set([...(member.leftServerIds||[]),serverId])];
        }
        if(action==='delete'){
          storage.removedServerIds=[...new Set([...(storage.removedServerIds||[]),serverId])];
          servers.splice(servers.indexOf(server),1);
          for(const id of channels)messageHistory.delete(id);
          onDelete?.(server);
        }else{
          server.memberIds=(server.memberIds||[]).filter(id=>id!==user.id);
          server.members=(server.members||[]).filter(u=>u.id!==user.id);
          server.leftMemberIds=[...new Set([...(server.leftMemberIds||[]),user.id])];
          if(server.memberRoles)delete server.memberRoles[user.id];
        }
        await save();
        if(action==='leave')onUpdate?.(server);
        for(const [id]of targets)io.to(id).emit('server-removed',{serverId});
        done({success:true,serverId});
      }catch(error){console.error('[Server lifecycle]',error);done({success:false,error:'Não foi possível concluir a alteração.'})}
      finally{busy.delete(serverId)}
    });
  });
}
