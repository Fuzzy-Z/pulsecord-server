import play_dl from 'play-dl';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

// yt-dlp discovery and auto-downloader
function getYtDlpBin() {
  const localWin = path.resolve('yt-dlp.exe');
  if (fs.existsSync(localWin)) return localWin;
  const localLinux = path.resolve('yt-dlp');
  if (fs.existsSync(localLinux)) return localLinux;
  const serverWin = path.resolve('server', 'yt-dlp.exe');
  if (fs.existsSync(serverWin)) return serverWin;
  const serverLinux = path.resolve('server', 'yt-dlp');
  if (fs.existsSync(serverLinux)) return serverLinux;
  return 'yt-dlp';
}

export function resolveYtDlp(queryOrUrl) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBin();
    const isUrl = queryOrUrl.startsWith('http://') || queryOrUrl.startsWith('https://');
    const arg = isUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;

    execFile(bin, ['-j', '-f', 'bestaudio/best', '--no-warnings', arg], { timeout: 18000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const line = stdout.trim().split('\n')[0];
        if (!line) return reject(new Error('No output from yt-dlp'));
        const data = JSON.parse(line);
        let audioUrl = data.url;
        if (!audioUrl && data.requested_formats) {
          const af = data.requested_formats.find(f => f.audio_ext !== 'none' || f.acodec !== 'none');
          if (af) audioUrl = af.url;
        }

        if (!audioUrl) return reject(new Error('Could not extract direct stream URL'));

        resolve({
          id: 'yt-' + (data.id || Date.now()),
          title: data.fulltitle || data.title,
          artist: data.uploader || data.channel || 'YouTube',
          url: audioUrl,
          originalUrl: data.webpage_url || data.original_url || queryOrUrl,
          cover: data.thumbnail || (data.thumbnails && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1].url : ''),
          duration: data.duration || 0,
          source: 'youtube'
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function searchYtDlp(query, limit = 8) {
  return new Promise((resolve) => {
    const bin = getYtDlpBin();
    execFile(bin, ['-j', '--flat-playlist', '--no-warnings', `ytsearch${limit}:${query}`], { timeout: 12000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const results = [];
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            const thumb = data.thumbnails && data.thumbnails.length > 0
              ? data.thumbnails[data.thumbnails.length - 1].url
              : (data.thumbnail || '');
            results.push({
              id: 'yt-' + (data.id || Date.now()),
              title: data.title,
              artist: data.uploader || data.channel || 'YouTube',
              url: data.url || `https://www.youtube.com/watch?v=${data.id}`,
              originalUrl: data.url || `https://www.youtube.com/watch?v=${data.id}`,
              cover: thumb || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
              duration: data.duration || 0,
              source: 'youtube'
            });
          } catch (e) {}
        }
        resolve(results);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

export async function parseSpotifyUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i);
    const artistMatch = html.match(/<meta\s+name=["']music:musician_description["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']music:musician_description["']/i);
    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);

    let title = titleMatch ? titleMatch[1] : '';
    let artist = artistMatch ? artistMatch[1] : '';
    const desc = descMatch ? descMatch[1] : '';
    const cover = imageMatch ? imageMatch[1] : '';

    if (!artist && desc && desc.includes('·')) {
      const parts = desc.split('·').map(s => s.trim());
      if (parts.length > 0 && parts[0]) artist = parts[0];
    }

    if (!artist) {
      const titleTag = html.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
      const byMatch = titleTag.match(/by\s+([^|]+)/i);
      if (byMatch) artist = byMatch[1].trim();
    }

    if (title && (title.includes('Album') || title.includes('Spotify'))) {
      title = title.replace(/\s*[-–]\s*Album.*$/i, '').replace(/\s*\|\s*Spotify.*$/i, '').trim();
    }

    return {
      title,
      artist,
      cover,
      query: artist ? `${artist} - ${title}` : title
    };
  } catch (err) {
    console.warn('[MusicBot] parseSpotifyUrl error:', err.message);
    return null;
  }
}

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

export function cleanMusicTitle(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\[\s*(official\s*(music\s*)?video|video\s*oficial|clipe\s*oficial|music\s*video|official\s*audio|audio\s*oficial|lyric\s*video|video\s*com\s*letra|visualizer|audio|hd|hq|4k|1080p)\s*\]/gi, '')
    .replace(/\(\s*(official\s*(music\s*)?video|video\s*oficial|clipe\s*oficial|music\s*video|official\s*audio|audio\s*oficial|lyric\s*video|video\s*com\s*letra|visualizer|audio|hd|hq|4k|1080p)\s*\)/gi, '')
    .replace(/\|\s*.*$/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

    // 2. Spotify Link: Extract title, artist, and high-res cover via Spotify page scraping
    if (q.includes('open.spotify.com/')) {
      isSpotify = true;
      try {
        const spotifyData = await parseSpotifyUrl(q);
        if (spotifyData && spotifyData.title) {
          searchTitle = spotifyData.query || spotifyData.title;
          fallbackArtist = spotifyData.artist || 'Spotify';
          fallbackCover = spotifyData.cover || '';
        }
      } catch (err) {
        console.warn('[MusicBot] Spotify parse error:', err.message);
      }
    }

    // 3. YouTube Link: Direct resolution with yt-dlp
    if (q.includes('youtube.com/') || q.includes('youtu.be/')) {
      isYouTube = true;
      try {
        const ytTrack = await resolveYtDlp(q);
        if (ytTrack && ytTrack.url) {
          return ytTrack;
        }
      } catch (err) {
        console.warn('[MusicBot] yt-dlp direct url resolution error:', err.message);
      }
    }

    // 4. Primary: Try streaming high-fidelity audio via yt-dlp (Original Official Tracks)
    try {
      const ytTrack = await resolveYtDlp(searchTitle);
      if (ytTrack && ytTrack.url) {
        if (fallbackCover) ytTrack.cover = fallbackCover;
        if (fallbackArtist && fallbackArtist !== 'YouTube') ytTrack.artist = fallbackArtist;
        ytTrack.source = isSpotify ? 'spotify' : isYouTube ? 'youtube' : 'youtube';
        return ytTrack;
      }
    } catch (err) {
      console.warn('[MusicBot] yt-dlp search resolution error:', err.message);
    }

    // 5. Secondary: Try streaming via SoundCloud with strict anti-remix / anti-spedup filter
    try {
      await ensureSoundCloud();
      const cleanedQuery = cleanMusicTitle(searchTitle);
      const scResults = await play_dl.search(cleanedQuery, { source: { soundcloud: 'tracks' }, limit: 12 });
      if (scResults && scResults.length > 0) {
        const lowerQ = cleanedQuery.toLowerCase();
        const userWantsRemix = /sped\s*up|speed\s*up|slowed|pitch|remix|nightcore|cover|mashup|edit/i.test(lowerQ);

        // Filter out fan edits unless user explicitly asked for them
        let candidateTracks = scResults;
        if (!userWantsRemix) {
          const cleanFiltered = scResults.filter((t) => {
            const name = (t.name || '').toLowerCase();
            return !/sped\s*up|speed\s*up|slowed|pitch|remix|nightcore|cover|mashup|edit/i.test(name);
          });
          if (cleanFiltered.length > 0) candidateTracks = cleanFiltered;
        }

        const queryWords = lowerQ.split(/[\s-]+/).filter((w) => w.length > 2);
        let bestTrack = candidateTracks[0];

        for (const t of candidateTracks) {
          const tName = (t.name || '').toLowerCase();
          const tUser = (t.user?.name || '').toLowerCase();
          const matchCount = queryWords.filter((w) => tName.includes(w) || tUser.includes(w)).length;
          if (matchCount >= 2 || (queryWords.length <= 1 && matchCount >= 1)) {
            bestTrack = t;
            break;
          }
        }

        const stream = await play_dl.stream(bestTrack.url);
        if (stream && stream.url) {
          return {
            id: 'sc-' + Date.now(),
            title: bestTrack.name || searchTitle,
            artist: bestTrack.user?.name || fallbackArtist || 'SoundCloud Artist',
            url: stream.url,
            originalUrl: bestTrack.url || q,
            cover: bestTrack.thumbnail || fallbackCover || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
            duration: bestTrack.durationInSec || 0,
            source: isSpotify ? 'spotify' : isYouTube ? 'youtube' : 'soundcloud'
          };
        }
      }
    } catch (err) {
      console.warn('[MusicBot] SoundCloud stream resolution error:', err.message);
    }

    // 6. Full Streaming Fallback: Search Audius (Full length tracks)
    try {
      const cleanedQuery = cleanMusicTitle(searchTitle);
      const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(cleanedQuery)}&app_name=pulsecord`);
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

    // 7. Check preset keywords
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

    // 8. Ultimate fallback: Preset radio
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
    const searchTitle = cleanMusicTitle(query.trim());
    const lowerQ = searchTitle.toLowerCase();
    const userWantsRemix = /sped\s*up|speed\s*up|slowed|pitch|remix|nightcore|cover|mashup|edit/i.test(lowerQ);

    // 1. YouTube Search with yt-dlp (Original Official Videos & High Quality Metadata)
    try {
      const ytResults = await searchYtDlp(searchTitle, 8);
      if (ytResults && ytResults.length > 0) {
        // Filter out fan edits if user didn't ask for them
        let cleanYt = ytResults;
        if (!userWantsRemix) {
          const filtered = ytResults.filter((t) => !/sped\s*up|speed\s*up|slowed|nightcore|mashup/i.test(t.title || ''));
          if (filtered.length > 0) cleanYt = filtered;
        }
        return cleanYt;
      }
    } catch (err) {
      console.warn('[MusicBot] YouTube search error:', err.message);
    }

    // 2. Fast SoundCloud search with Anti-Spedup/Slowed filtering
    try {
      await ensureSoundCloud();
      const scResults = await play_dl.search(searchTitle, { source: { soundcloud: 'tracks' }, limit: 12 });
      if (scResults && scResults.length > 0) {
        let cleanSc = scResults;
        if (!userWantsRemix) {
          const filtered = scResults.filter((t) => !/sped\s*up|speed\s*up|slowed|nightcore|mashup/i.test(t.name || ''));
          if (filtered.length > 0) cleanSc = filtered;
        }

        return cleanSc.slice(0, 8).map((track, i) => ({
          id: 'sc-' + (track.id || Date.now() + '-' + i),
          title: track.name || searchTitle,
          artist: track.user?.name || 'SoundCloud Artist',
          url: track.url,
          originalUrl: track.url,
          cover: track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
          duration: track.durationInSec || 0,
          source: 'soundcloud'
        }));
      }
    } catch (err) {
      console.warn('[MusicBot] SoundCloud search error:', err.message);
    }

    // 3. Fallback: Search iTunes (High quality metadata & instant response)
    try {
      const iTunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTitle)}&media=music&limit=8`;
      const res = await fetch(iTunesUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          return data.results.map((track, i) => ({
            id: 'itunes-' + track.trackId + '-' + i,
            title: track.trackName || searchTitle,
            artist: track.artistName || 'Artista',
            url: track.previewUrl || `${track.artistName} - ${track.trackName}`,
            originalUrl: track.trackViewUrl,
            cover: track.artworkUrl100?.replace('100x100bb', '600x600bb') || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
            duration: 30,
            source: 'itunes'
          }));
        }
      }
    } catch (err) {
      console.warn('[MusicBot] iTunes search error:', err.message);
    }

    return [];
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
