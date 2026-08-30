// Built-in high-quality royalty-free streams & curated tracks for Music Bot
const PRESET_STREAMS = [
  {
    id: 'lofi-hiphop',
    title: 'Lofi Chill Study Beats',
    artist: 'PulseCord Music Bot',
    duration: 0, // live stream
    url: 'https://stream.zeno.fm/f3wvbbqmdg8uv',
    cover: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=300&h=300&fit=crop',
    keywords: ['lofi', 'chill', 'study', 'relax', 'beats']
  },
  {
    id: 'synthwave-retro',
    title: 'Synthwave & Retrowave 80s',
    artist: 'Nightdrive FM',
    duration: 0,
    url: 'https://stream.zeno.fm/0r0xa792kwzuv',
    cover: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=300&h=300&fit=crop',
    keywords: ['synthwave', 'retro', '80s', 'cyberpunk', 'synth']
  },
  {
    id: 'gaming-electro',
    title: 'Gaming Energy & Electronic Drops',
    artist: 'Pulse EDM',
    duration: 0,
    url: 'https://stream.zeno.fm/48u6s2y4u2zuv',
    cover: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
    keywords: ['gaming', 'game', 'edm', 'electro', 'trap', 'bass']
  },
  {
    id: 'chillout-lounge',
    title: 'Chillout Ambient Lounge & Piano',
    artist: 'Acoustic Vibes',
    duration: 0,
    url: 'https://stream.zeno.fm/yn9umwt0t18uv',
    cover: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
    keywords: ['piano', 'acoustic', 'ambient', 'lounge', 'calm']
  },
  {
    id: 'hiphop-boombap',
    title: 'Classic Boom Bap & Underground Hip Hop',
    artist: 'Street Beats Bot',
    duration: 0,
    url: 'https://stream.zeno.fm/6q0xa792kwzuv',
    cover: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=300&h=300&fit=crop',
    keywords: ['hiphop', 'rap', 'boombap', 'trap', 'street']
  }
];

class MusicBotManager {
  constructor(io) {
    this.io = io;
    // Map of channelId -> { currentTrack, queue: [], isPlaying: false, volume: 80, progress: 0, startedAt: null }
    this.channelPlayers = new Map();
  }

  getPlayer(channelId) {
    if (!this.channelPlayers.has(channelId)) {
      this.channelPlayers.set(channelId, {
        channelId,
        currentTrack: null,
        queue: [],
        isPlaying: false,
        volume: 70,
        pausedAt: 0,
        startedAt: null,
        requestedBy: null
      });
    }
    return this.channelPlayers.get(channelId);
  }

  searchTrack(query) {
    const q = query.trim().toLowerCase();

    // If it's a direct URL
    if (query.startsWith('http://') || query.startsWith('https://')) {
      return {
        id: 'url-' + Date.now(),
        title: query.split('/').pop().split('?')[0] || 'Custom Audio Stream',
        artist: 'Web Audio URL',
        duration: 0,
        url: query,
        cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop',
        keywords: []
      };
    }

    // Match keywords from presets
    const match = PRESET_STREAMS.find(stream => 
      stream.keywords.some(k => q.includes(k)) || 
      stream.title.toLowerCase().includes(q) ||
      stream.artist.toLowerCase().includes(q)
    );

    if (match) {
      return { ...match };
    }

    // Default to first preset if no exact match, but customize title
    const randomPreset = PRESET_STREAMS[Math.floor(Math.random() * PRESET_STREAMS.length)];
    return {
      ...randomPreset,
      title: `${query} (Pulse Auto-Radio)`
    };
  }

  play(channelId, query, user) {
    const player = this.getPlayer(channelId);
    const track = this.searchTrack(query);
    track.requestedBy = user ? user.username : 'User';

    if (!player.currentTrack || !player.isPlaying) {
      player.currentTrack = track;
      player.isPlaying = true;
      player.startedAt = Date.now();
      player.pausedAt = 0;
    } else {
      player.queue.push(track);
    }

    this.broadcastState(channelId);
    return {
      status: player.currentTrack === track ? 'playing' : 'queued',
      track,
      queuePosition: player.queue.length
    };
  }

  pause(channelId) {
    const player = this.getPlayer(channelId);
    if (player.isPlaying) {
      player.isPlaying = false;
      this.broadcastState(channelId);
    }
    return player;
  }

  resume(channelId) {
    const player = this.getPlayer(channelId);
    if (player.currentTrack && !player.isPlaying) {
      player.isPlaying = true;
      this.broadcastState(channelId);
    }
    return player;
  }

  skip(channelId) {
    const player = this.getPlayer(channelId);
    if (player.queue.length > 0) {
      player.currentTrack = player.queue.shift();
      player.isPlaying = true;
      player.startedAt = Date.now();
    } else {
      player.currentTrack = null;
      player.isPlaying = false;
    }
    this.broadcastState(channelId);
    return player;
  }

  stop(channelId) {
    const player = this.getPlayer(channelId);
    player.currentTrack = null;
    player.queue = [];
    player.isPlaying = false;
    this.broadcastState(channelId);
    return player;
  }

  setVolume(channelId, volume) {
    const player = this.getPlayer(channelId);
    player.volume = Math.max(0, Math.min(100, volume));
    this.broadcastState(channelId);
    return player;
  }

  broadcastState(channelId) {
    const player = this.getPlayer(channelId);
    this.io.to(`voice-${channelId}`).emit('music-state-update', {
      channelId,
      player
    });
  }
}

export { MusicBotManager, PRESET_STREAMS };
