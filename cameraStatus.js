// Camera status belongs to this authenticated socket's current voice seat only.
export function updateCameraStatus(user, room, socketId, requested) {
  if (typeof requested !== 'boolean') return;
  const member = room?.find(person => person.socketId === socketId);
  user.isCameraOn = requested && Boolean(member) && member.canPresent !== false;
  if (member) member.isCameraOn = user.isCameraOn;
}
