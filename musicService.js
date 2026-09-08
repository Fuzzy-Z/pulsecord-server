import play_dl from 'play-dl';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

// yt-dlp discovery with strict OS separation (never execute .exe on Linux)
function getYtDlpBin() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const localWin = path.resolve('yt-dlp.exe');
    if (fs.existsSync(localWin)) return localWin;
    const serverWin = path.resolve('server', 'yt-dlp.exe');
    if (fs.existsSync(serverWin)) return serverWin;
    return 'yt-dlp.exe';
  } else {
    // Linux / Darwin: NEVER execute Windows .exe binaries!
    const sysLocal = '/usr/local/bin/yt-dlp';
    if (fs.existsSync(sysLocal)) return sysLocal;
    const sysBin = '/usr/bin/yt-dlp';
    if (fs.existsSync(sysBin)) return sysBin;
    const localLinux = path.resolve('yt-dlp');
    if (fs.existsSync(localLinux) && !localLinux.endsWith('.exe')) return localLinux;
    const serverLinux = path.resolve('server', 'yt-dlp');
    if (fs.existsSync(serverLinux) && !serverLinux.endsWith('.exe')) return serverLinux;
    return 'yt-dlp';
  }
}

export function resolveYtDlp(queryOrUrl) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpBin();
    const isUrl = queryOrUrl.startsWith('http://') || queryOrUrl.startsWith('https://');
    const arg = isUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;

    execFile(bin, ['-j', '-f', 'bestaudio/best', '--no-warnings', arg], { timeout: 18000 }, (err, stdout) => {
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

// -------------------------------------------------------------
// Layer 1: Metadata Extraction (Spotify, Apple Music, Deezer)
// -------------------------------------------------------------

export async function parseSpotifyUrl(url) {
  try {
    const cleanUrl = (url || '').trim().split('?')[0];

    // 1. Primary: Spotify Official oEmbed API (High precision, no API key required)
    try {
      const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        let title = oembed.title || '';
        let artist = '';
        const cover = oembed.thumbnail_url || '';

        // Extract artist from the lightweight iframe embed
        if (oembed.iframe_url) {
          try {
            const embRes = await fetch(oembed.iframe_url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            if (embRes.ok) {
              const embHtml = await embRes.text();
              const nextDataMatch = embHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
              if (nextDataMatch) {
                const data = JSON.parse(nextDataMatch[1]);
                const entity = data.props?.pageProps?.state?.data?.entity;
                if (entity?.artists && Array.isArray(entity.artists)) {
                  artist = entity.artists.map((a) => a.name).join(', ');
                }
              }
              if (!artist) {
                const byMatch = embHtml.match(/by\s+([^<|"]+)/i);
                if (byMatch) artist = byMatch[1].trim();
              }
            }
          } catch (e) {}
        }

        if (title) {
          title = title.replace(/\s*[-–]\s*Album.*$/i, '').replace(/\s*\|\s*Spotify.*$/i, '').trim();
          const query = artist ? `${artist} - ${title}` : title;
          console.log(`[MusicBot] Extracted Spotify track via oEmbed: "${query}"`);
          return { title, artist, cover, query };
        }
      }
    } catch (oembedErr) {
      console.warn('[MusicBot] Spotify oEmbed error:', oembedErr.message);
    }

    // 2. Fallback: Direct HTML scraping
    const res = await fetch(cleanUrl, {
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

    const query = artist ? `${artist} - ${title}` : title;
    return {
      title,
      artist,
      cover,
      query
    };
  } catch (err) {
    console.warn('[MusicBot] parseSpotifyUrl error:', err.message);
    return null;
  }
}

export async function parseAppleMusicUrl(url) {
  try {
    const cleanUrl = (url || '').trim().split('?')[0];
    const res = await fetch(cleanUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
    const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                      html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i);
    const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);

    let title = titleMatch ? titleMatch[1].replace(/\s*[-–]\s*Single.*$/i, '').replace(/\s*[-–]\s*Album.*$/i, '').trim() : '';
    let artist = '';
    const desc = descMatch ? descMatch[1] : '';
    const cover = imageMatch ? imageMatch[1] : '';

    if (desc) {
      const byMatch = desc.match(/by\s+([^·\.\n]+)/i);
      if (byMatch) artist = byMatch[1].trim();
    }
    const query = artist ? `${artist} - ${title}` : title;
    return { title, artist, cover, query };
  } catch (e) {
    return null;
  }
}

export async function parseDeezerUrl(url) {
  try {
    const cleanUrl = (url || '').trim().split('?')[0];
    const res = await fetch(`https://api.deezer.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const title = data.title || '';
    const artist = data.author_name || '';
    const cover = data.thumbnail_url || '';
    const query = artist ? `${artist} - ${title}` : title;
    return { title, artist, cover, query };
  } catch (e) {
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

// -------------------------------------------------------------
// Layer 2: Scoring & Candidate Matching Algorithm
// -------------------------------------------------------------
function scoreTrack(track, targetTitle, targetArtist, userWantsRemix) {
  let score = 0;
  const name = (track.name || '').toLowerCase();
  const user = (track.user?.name || '').toLowerCase();
  const tLower = (targetTitle || '').toLowerCase();
  const aLower = (targetArtist || '').toLowerCase();

  // 1. Duration check: SoundCloud Go+ previews are typically <= 45s
  if (track.durationInSec && track.durationInSec <= 45) {
    score -= 200; // Drop 30-second previews
  } else if (track.durationInSec && track.durationInSec >= 60 && track.durationInSec <= 600) {
    score += 50; // Standard full-length song
  }

  // 2. Title matching
  if (tLower && name.includes(tLower)) score += 40;
  // 3. Artist matching
  if (aLower && (name.includes(aLower) || user.includes(aLower))) score += 30;

  // 4. Anti-remix / fan-edit filters
  if (!userWantsRemix) {
    if (/remix|flip|mashup|tribute|sped\s*up|speed\s*up|slowed|nightcore|reverb|karaoke|instrumental|edit/i.test(name)) {
      score -= 60;
    }
    if (/cover/i.test(name) && !tLower.includes('cover')) {
      score -= 80;
    }
  }

  // 5. Official / original bonus
  if (/original|official|audio/i.test(name)) {
    score += 15;
  }

  return score;
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

  // -------------------------------------------------------------
  // Layer 3: Audio Stream Resolution Engine
  // -------------------------------------------------------------
  async resolveMetadata(query) {
    const q = (query || '').trim();

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
    let originalTitle = '';
    let originalArtist = '';
    let fallbackCover = '';
    let sourcePlatform = 'search';

    // 2. Metadata Extraction Layer (Spotify / Apple Music / Deezer)
    if (q.includes('open.spotify.com/')) {
      sourcePlatform = 'spotify';
      try {
        const spotifyData = await parseSpotifyUrl(q);
        if (spotifyData && spotifyData.title) {
          originalTitle = spotifyData.title;
          originalArtist = spotifyData.artist;
          searchTitle = spotifyData.query || spotifyData.title;
          fallbackCover = spotifyData.cover || '';
        }
      } catch (err) {
        console.warn('[MusicBot] Spotify parse error:', err.message);
      }
    } else if (q.includes('music.apple.com/')) {
      sourcePlatform = 'apple';
      try {
        const appleData = await parseAppleMusicUrl(q);
        if (appleData && appleData.title) {
          originalTitle = appleData.title;
          originalArtist = appleData.artist;
          searchTitle = appleData.query || appleData.title;
          fallbackCover = appleData.cover || '';
        }
      } catch (err) {
        console.warn('[MusicBot] Apple Music parse error:', err.message);
      }
    } else if (q.includes('deezer.com/')) {
      sourcePlatform = 'deezer';
      try {
        const deezerData = await parseDeezerUrl(q);
        if (deezerData && deezerData.title) {
          originalTitle = deezerData.title;
          originalArtist = deezerData.artist;
          searchTitle = deezerData.query || deezerData.title;
          fallbackCover = deezerData.cover || '';
        }
      } catch (err) {
        console.warn('[MusicBot] Deezer parse error:', err.message);
      }
    } else if (q.includes('youtube.com/') || q.includes('youtu.be/')) {
      sourcePlatform = 'youtube';
      try {
        const ytTrack = await resolveYtDlp(q);
        if (ytTrack && ytTrack.url) {
          return ytTrack;
        }
      } catch (err) {
        console.warn('[MusicBot] yt-dlp direct url resolution error:', err.message);
      }
    }

    // 3. Audio Streaming Resolution - Provider A: yt-dlp (YouTube stream)
    try {
      const ytTrack = await resolveYtDlp(searchTitle);
      if (ytTrack && ytTrack.url) {
        if (originalTitle) ytTrack.title = originalTitle;
        if (originalArtist) ytTrack.artist = originalArtist;
        if (fallbackCover) ytTrack.cover = fallbackCover;
        ytTrack.source = sourcePlatform !== 'search' ? sourcePlatform : 'youtube';
        return ytTrack;
      }
    } catch (err) {
      console.warn('[MusicBot] yt-dlp search stream skipped (likely IP block / unsupported env):', err.message);
    }

    // 4. Audio Streaming Resolution - Provider B: SoundCloud with Candidate Scoring
    try {
      await ensureSoundCloud();
      const cleanedQuery = cleanMusicTitle(searchTitle);
      const lowerQ = cleanedQuery.toLowerCase();
      const userWantsRemix = /sped\s*up|speed\s*up|slowed|pitch|remix|nightcore|cover|mashup|edit/i.test(lowerQ);

      let scResults = await play_dl.search(cleanedQuery, { source: { soundcloud: 'tracks' }, limit: 12 });
      if (!scResults || scResults.length === 0) {
        scResults = await play_dl.search(cleanMusicTitle(originalTitle || searchTitle), { source: { soundcloud: 'tracks' }, limit: 12 });
      }

      if (scResults && scResults.length > 0) {
        // Score candidate tracks
        const scoredCandidates = scResults.map((t) => ({
          track: t,
          score: scoreTrack(t, originalTitle || cleanedQuery, originalArtist, userWantsRemix)
        }));

        scoredCandidates.sort((a, b) => b.score - a.score);

        // Try candidate streams in scored order (skipping preview/broken ones)
        for (const candidate of scoredCandidates.slice(0, 3)) {
          try {
            const stream = await play_dl.stream(candidate.track.url);
            if (stream && stream.url) {
              const chosen = candidate.track;
              return {
                id: 'sc-' + Date.now(),
                title: originalTitle || chosen.name || searchTitle,
                artist: originalArtist || chosen.user?.name || 'SoundCloud Artist',
                url: stream.url,
                originalUrl: chosen.url || q,
                cover: fallbackCover || chosen.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&h=300&fit=crop',
                duration: chosen.durationInSec || 0,
                source: sourcePlatform !== 'search' ? sourcePlatform : 'soundcloud'
              };
            }
          } catch (stErr) {
            console.warn('[MusicBot] Candidate stream attempt failed:', stErr.message);
          }
        }
      }
    } catch (err) {
      console.warn('[MusicBot] SoundCloud stream resolution error:', err.message);
    }

    // 5. Audio Streaming Resolution - Provider C: Audius Full Tracks
    try {
      const cleanedQuery = cleanMusicTitle(originalTitle || searchTitle);
      const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(cleanedQuery)}&app_name=pulsecord`);
      if (audiusRes.ok) {
        const audiusData = await audiusRes.json();
        if (audiusData.data && audiusData.data.length > 0) {
          const track = audiusData.data[0];
          return {
            id: 'audius-' + track.id,
            title: originalTitle || track.title || searchTitle,
            artist: originalArtist || track.user?.name || 'Audius Artist',
            url: `https://discoveryprovider.audius.co/v1/tracks/${track.id}/stream?app_name=pulsecord`,
            originalUrl: q,
            cover: fallbackCover || track.artwork?.['480x480'] || track.artwork?.['150x150'] || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
            duration: track.duration || 0,
            source: sourcePlatform !== 'search' ? sourcePlatform : 'audius'
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
      title: originalTitle || searchTitle,
      artist: originalArtist || 'PulseCord Radio',
      cover: fallbackCover || randomPreset.cover,
      source: 'radio'
    };
  }

  async searchTracks(query) {
    if (!query || !query.trim()) return [];
    const q = query.trim();

    // If query is already a URL from supported platforms, resolve it directly into 1 track
    if (
      q.includes('open.spotify.com/') ||
      q.includes('music.apple.com/') ||
      q.includes('deezer.com/') ||
      q.includes('youtube.com/') ||
      q.includes('youtu.be/')
    ) {
      try {
        const resolved = await this.resolveMetadata(q);
        if (resolved && resolved.url) {
          return [resolved];
        }
      } catch (e) {}
    }

    const searchTitle = cleanMusicTitle(q);
    const lowerQ = searchTitle.toLowerCase();
    const userWantsRemix = /sped\s*up|speed\s*up|slowed|pitch|remix|nightcore|cover|mashup|edit/i.test(lowerQ);

    // 1. YouTube Search with yt-dlp
    try {
      const ytResults = await searchYtDlp(searchTitle, 8);
      if (ytResults && ytResults.length > 0) {
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

    // 2. SoundCloud search with anti-preview & scoring
    try {
      await ensureSoundCloud();
      const scResults = await play_dl.search(searchTitle, { source: { soundcloud: 'tracks' }, limit: 14 });
      if (scResults && scResults.length > 0) {
        // Discard 30-second previews
        const fullTracks = scResults.filter((t) => !t.durationInSec || t.durationInSec > 45);
        let candidates = fullTracks.length > 0 ? fullTracks : scResults;

        if (!userWantsRemix) {
          const cleanFiltered = candidates.filter((t) => !/sped\s*up|speed\s*up|slowed|nightcore|mashup/i.test(t.name || ''));
          if (cleanFiltered.length > 0) candidates = cleanFiltered;
        }

        return candidates.slice(0, 8).map((track, i) => ({
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

    // 3. Fallback: Search Audius
    try {
      const audiusRes = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(searchTitle)}&app_name=pulsecord`);
      if (audiusRes.ok) {
        const audiusData = await audiusRes.json();
        if (audiusData.data && audiusData.data.length > 0) {
          return audiusData.data.slice(0, 8).map((track) => ({
            id: 'audius-' + track.id,
            title: track.title || searchTitle,
            artist: track.user?.name || 'Audius Artist',
            url: `https://discoveryprovider.audius.co/v1/tracks/${track.id}/stream?app_name=pulsecord`,
            originalUrl: track.permalink || '',
            cover: track.artwork?.['480x480'] || track.artwork?.['150x150'] || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&h=300&fit=crop',
            duration: track.duration || 0,
            source: 'audius'
          }));
        }
      }
    } catch (err) {
      console.warn('[MusicBot] Audius search error:', err.message);
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
