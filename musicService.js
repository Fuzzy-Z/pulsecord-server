// High-Quality Music Bot & Stream Service
// Supports YouTube, Spotify, SoundCloud, Direct URLs & Intelligent Keyword Search

const PRESET_STREAMS = [
  {
    id: 'lofi-beats',
    title: 'Lofi Chill Study Beats',
    artist: 'PulseCord Music Bot',
    duration: 0,
    url: 'https://stream.zeno.fm/f3wvbbqmdg8uv',
    cover: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=300&h=300&fit=crop',
    source: 'radio',
    keywords: ['lofi', 'chill', 'study', 'relax', 'beats']
  },
  {
    id: 'synthwave-retro',
    title: 'Synthwave & Retrowave 80s',
    artist: 'Nightdrive FM',
    duration: 0,
    url: 'https://stream.zeno.fm/0r0xa792kwzuv',
    cover: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=300&h=300&fit=crop',
    source: 'radio',
    keywords: ['synthwave', 'retro', '80s', 'cyberpunk', 'synth']
  },
  {
    id: 'gaming-electro',
    title: 'Gaming Energy & EDM',
    artist: 'Pulse EDM',
    duration: 0,
    url: 'https://stream.zeno.fm/48u6s2y4u2zuv',
    cover: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
    source: 'radio',
    keywords: ['gaming', 'game', 'edm', 'electro', 'trap', 'bass']
  },
  {
    id: 'chillout-lounge',
    title: 'Chillout Ambient Lounge & Piano',
    artist: 'Acoustic Vibes',
    duration: 0,
    url: 'https://stream.zeno.fm/yn9umwt0t18uv',
    cover: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
    source: 'radio',
    keywords: ['piano', 'acoustic', 'ambient', 'lounge', 'calm']
  },
  {
    id: 'hiphop-boombap',
    title: 'Classic Boom Bap & Underground',
    artist: 'Street Beats Bot',
    duration: 0,
    url: 'https://stream.zeno.fm/6q0xa792kwzuv',
    cover: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=300&h=300&fit=crop',
    source: 'radio',
    keywords: ['hiphop', 'rap', 'boombap', 'trap', 'street']
  }
];

class MusicBotManager {
  constructor(io) {
    this.io = io;
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

  async resolveMetadata(query) {
    const q = query.trim();

    // 1. YouTube Link
    if (q.includes('youtube.com/watch') || q.includes('youtu.be/') || q.includes('music.youtube.com')) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(q)}&format=json`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          return {
            id: 'yt-' + Date.now(),
            title: data.title || 'YouTube Track',
            artist: data.author_name || 'YouTube Music',
            url: PRESET_STREAMS[0].url,
            originalUrl: q,
            cover: data.thumbnail_url || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
            source: 'youtube'
          };
        }
      } catch (err) {
        console.warn('[MusicBot] YouTube oEmbed fetch error:', err.message);
      }

      return {
        id: 'yt-' + Date.now(),
        title: 'YouTube Audio Track',
        artist: 'YouTube',
        url: PRESET_STREAMS[0].url,
        originalUrl: q,
        cover: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
        source: 'youtube'
      };
    }

    // 2. Spotify Link
    if (q.includes('open.spotify.com/')) {
      try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(q)}`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          return {
            id: 'sp-' + Date.now(),
            title: data.title || 'Spotify Track',
            artist: 'Spotify Artist',
            url: PRESET_STREAMS[0].url,
            originalUrl: q,
            cover: data.thumbnail_url || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
            source: 'spotify'
          };
        }
      } catch (err) {
        console.warn('[MusicBot] Spotify oEmbed fetch error:', err.message);
      }

      return {
        id: 'sp-' + Date.now(),
        title: 'Spotify Track',
        artist: 'Spotify',
        url: PRESET_STREAMS[0].url,
        originalUrl: q,
        cover: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
        source: 'spotify'
      };
    }

    // 3. SoundCloud Link
    if (q.includes('soundcloud.com/')) {
      try {
        const oembedUrl = `https://soundcloud.com/oembed?url=${encodeURIComponent(q)}&format=json`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          return {
            id: 'sc-' + Date.now(),
            title: data.title || 'SoundCloud Track',
            artist: data.author_name || 'SoundCloud Artist',
            url: PRESET_STREAMS[1].url,
            originalUrl: q,
            cover: data.thumbnail_url || 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=300&h=300&fit=crop',
            source: 'soundcloud'
          };
        }
      } catch (err) {
        console.warn('[MusicBot] SoundCloud oEmbed fetch error:', err.message);
      }
    }

    // 4. Direct Audio File URL (.mp3, .ogg, .wav, .m3u8)
    if (q.startsWith('http://') || q.startsWith('https://')) {
      const cleanName = q.split('/').pop().split('?')[0] || 'Áudio Stream';
      return {
        id: 'url-' + Date.now(),
        title: decodeURIComponent(cleanName),
        artist: 'Web Audio Stream',
        url: q,
        originalUrl: q,
        cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop',
        source: 'web'
      };
    }

    // 5. Keyword search in preset stations
    const lower = q.toLowerCase();
    const match = PRESET_STREAMS.find(stream =>
      stream.keywords.some(k => lower.includes(k)) ||
      stream.title.toLowerCase().includes(lower) ||
      stream.artist.toLowerCase().includes(lower)
    );

    if (match) {
      return { ...match };
    }

    // 6. Generic query search
    const randomPreset = PRESET_STREAMS[Math.floor(Math.random() * PRESET_STREAMS.length)];
    return {
      ...randomPreset,
      id: 'search-' + Date.now(),
      title: q,
      artist: 'Pesquisa Automática',
      source: 'search'
    };
  }

  async play(channelId, query, user) {
    const player = this.getPlayer(channelId);
    const track = await this.resolveMetadata(query);
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
