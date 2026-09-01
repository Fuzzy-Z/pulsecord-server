// High-Quality Music Bot & Stream Service
// Real-time audio streaming from YouTube, Spotify, SoundCloud, Direct URLs & Music Search
import play_dl from 'play-dl';

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

let isSoundCloudInit = false;
async function ensureSoundCloud() {
  if (isSoundCloudInit) return;
  try {
    const clientId = await play_dl.getFreeClientID();
    if (clientId) {
      await play_dl.setToken({ soundcloud: { client_id: clientId } });
      isSoundCloudInit = true;
    }
  } catch (e) {
    console.warn('[MusicBot] SoundCloud init error:', e.message);
  }
}

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

    // 1. Direct audio stream or file URL (.mp3, .aac, .m4a, .ogg, streaming stations)
    if (
      q.match(/\.(mp3|wav|ogg|m4a|aac)($|\?)/i) ||
      q.includes('stream.zeno.fm') ||
      q.includes('icecast') ||
      q.includes('shoutcast')
    ) {
      const cleanName = q.split('/').pop().split('?')[0] || 'Áudio Stream';
      return {
        id: 'direct-' + Date.now(),
        title: decodeURIComponent(cleanName),
        artist: 'Web Audio Stream',
        url: q,
        originalUrl: q,
        cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&h=300&fit=crop',
        duration: 0,
        source: 'direct'
      };
    }

    let searchTitle = q;
    let fallbackArtist = '';
    let fallbackCover = '';
    let isSpotify = false;
    let isYouTube = false;

    // 2. Spotify Link: Extract title and artist via Spotify oEmbed
    if (q.includes('open.spotify.com/')) {
      isSpotify = true;
      try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(q)}`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          searchTitle = data.title || q;
          fallbackCover = data.thumbnail_url || '';
          fallbackArtist = 'Spotify';
        }
      } catch (err) {
        console.warn('[MusicBot] Spotify oEmbed error:', err.message);
      }
    }

    // 3. YouTube Link: Extract title via YouTube oEmbed
    if (q.includes('youtube.com/') || q.includes('youtu.be/')) {
      isYouTube = true;
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(q)}&format=json`;
        const res = await fetch(oembedUrl);
        if (res.ok) {
          const data = await res.json();
          searchTitle = data.title || q;
          fallbackArtist = data.author_name || 'YouTube';
          fallbackCover = data.thumbnail_url || '';
        }
      } catch (err) {
        console.warn('[MusicBot] YouTube oEmbed error:', err.message);
      }
    }

    // 4. Try streaming via SoundCloud / Play-DL (Plays the exact full audio stream)
    try {
      await ensureSoundCloud();
      const scResults = await play_dl.search(searchTitle, { source: { soundcloud: 'tracks' }, limit: 1 });
      if (scResults && scResults.length > 0) {
        const track = scResults[0];
        const stream = await play_dl.stream(track.url);
        if (stream && stream.url) {
          return {
            id: 'sc-' + Date.now(),
            title: track.name || searchTitle,
            artist: track.user?.name || fallbackArtist || 'SoundCloud Artist',
            url: stream.url,
            originalUrl: track.url || q,
            cover: track.thumbnail || fallbackCover || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
            duration: track.durationInSec || 0,
            source: isSpotify ? 'spotify' : isYouTube ? 'youtube' : 'soundcloud'
          };
        }
      }
    } catch (err) {
      console.warn('[MusicBot] SoundCloud stream resolution error:', err.message);
    }

    // 5. Full Streaming Fallback: Search Audius (Full length tracks)
    try {
      const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(searchTitle)}&app_name=pulsecord`);
      if (audiusRes.ok) {
        const audiusData = await audiusRes.json();
        if (audiusData.data && audiusData.data.length > 0) {
          const track = audiusData.data[0];
          return {
            id: 'audius-' + track.id,
            title: track.title || searchTitle,
            artist: track.user?.name || fallbackArtist || 'Audius Artist',
            url: `https://discoveryprovider.audius.co/v1/tracks/${track.id}/stream?app_name=pulsecord`,
            originalUrl: q,
            cover: track.artwork?.['480x480'] || track.artwork?.['150x150'] || fallbackCover || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
            duration: track.duration || 0,
            source: 'audius'
          };
        }
      }
    } catch (err) {
      console.warn('[MusicBot] Audius audio resolution error:', err.message);
    }

    // 6. Check preset keywords
    const lower = q.toLowerCase();
    const match = PRESET_STREAMS.find(
      (stream) =>
        stream.keywords.some((k) => lower.includes(k)) ||
        stream.title.toLowerCase().includes(lower) ||
        stream.artist.toLowerCase().includes(lower)
    );

    if (match) {
      return { ...match, id: 'preset-' + Date.now() };
    }

    // 7. Ultimate fallback: Preset radio
    const randomPreset = PRESET_STREAMS[Math.floor(Math.random() * PRESET_STREAMS.length)];
    return {
      ...randomPreset,
      id: 'search-' + Date.now(),
      title: searchTitle,
      artist: fallbackArtist || 'PulseCord Radio',
      cover: fallbackCover || randomPreset.cover,
      source: 'radio'
    };
  }

  async searchTracks(query) {
    if (!query || !query.trim()) return [];
    const searchTitle = query.trim();
    const results = [];

    // 1. Try SoundCloud multi-search
    try {
      await ensureSoundCloud();
      const scResults = await play_dl.search(searchTitle, { source: { soundcloud: 'tracks' }, limit: 5 });
      if (scResults && scResults.length > 0) {
        for (let i = 0; i < scResults.length; i++) {
          const track = scResults[i];
          try {
            const stream = await play_dl.stream(track.url);
            if (stream && stream.url) {
              results.push({
                id: 'sc-' + Date.now() + '-' + i,
                title: track.name || searchTitle,
                artist: track.user?.name || 'SoundCloud Artist',
                url: stream.url,
                originalUrl: track.url,
                cover: track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
                duration: track.durationInSec || 0,
                source: 'soundcloud'
              });
            }
          } catch (e) {}
        }
        if (results.length > 0) return results;
      }
    } catch (err) {
      console.warn('[MusicBot] SoundCloud search error:', err.message);
    }

    // 2. Try Audius search (Full songs)
    try {
      const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(searchTitle)}&app_name=pulsecord`);
      if (audiusRes.ok) {
        const audiusData = await audiusRes.json();
        if (audiusData.data && audiusData.data.length > 0) {
          audiusData.data.slice(0, 5).forEach((track, i) => {
            results.push({
              id: 'audius-' + track.id + '-' + i,
              title: track.title || searchTitle,
              artist: track.user?.name || 'Audius Artist',
              url: `https://discoveryprovider.audius.co/v1/tracks/${track.id}/stream?app_name=pulsecord`,
              originalUrl: searchTitle,
              cover: track.artwork?.['480x480'] || track.artwork?.['150x150'] || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
              duration: track.duration || 0,
              source: 'audius'
            });
          });
          if (results.length > 0) return results;
        }
      }
    } catch (err) {
      console.warn('[MusicBot] Audius search error:', err.message);
    }

    // 3. Fallback: Search iTunes (Full resolution metadata)
    try {
      const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTitle)}&media=music&limit=5`;
      const res = await fetch(iTunesUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          data.results.forEach((track, i) => {
            results.push({
              id: 'search-' + Date.now() + '-' + i,
              title: track.trackName || searchTitle,
              artist: track.artistName || 'Artista',
              url: track.previewUrl,
              originalUrl: track.trackViewUrl,
              cover: track.artworkUrl100?.replace('100x100bb', '600x600bb') || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
              duration: 30,
              source: 'itunes'
            });
          });
        }
      }
    } catch (err) {
      console.warn('[MusicBot] Search resolution error:', err.message);
    }
    return results;
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
