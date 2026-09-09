import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupSignaling } from './signaling.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 15000,
  maxHttpBufferSize: 1e8 // 100 MB for images & attachments
});

const VERSION_FILE = path.join(__dirname, 'version.json');
const ASAR_FILE = path.join(__dirname, 'app.asar');
const DIST_PATH = fs.existsSync(path.join(__dirname, 'dist'))
  ? path.join(__dirname, 'dist')
  : path.join(__dirname, '../dist');

// Serve static web app bundle if present
if (fs.existsSync(DIST_PATH)) {
  console.log(`[Voxel Web] Serving static frontend from: ${DIST_PATH}`);
  app.use(express.static(DIST_PATH, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Voxel WebRTC & Signaling Server',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// REST Health and info endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PulseCord Signaling & Realtime Server',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// WebRTC ICE & TURN Servers configuration endpoint
app.get('/api/ice-servers', (req, res) => {
  const coturnHost = process.env.COTURN_HOST || '150.230.73.46';
  const coturnPort = process.env.COTURN_PORT || '3478';
  const coturnUser = process.env.COTURN_USER || 'voxeluser';
  const coturnPass = process.env.COTURN_PASS || 'voxelpass2026';

  res.json({
    iceServers: [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
          'stun:stun3.l.google.com:19302',
          'stun:stun4.l.google.com:19302',
          'stun:stun.cloudflare.com:3478'
        ]
      },
      {
        urls: [
          `turn:${coturnHost}:${coturnPort}?transport=udp`,
          `turn:${coturnHost}:${coturnPort}?transport=tcp`
        ],
        username: coturnUser,
        credential: coturnPass
      },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10
  });
});

// =========================================================================
// FEEDBACK & BUG REPORT SYSTEM (Endpoint Oracle VM)
// =========================================================================
const DATA_DIR = path.join(__dirname, 'data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedbacks.json');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function readFeedbacks() {
  if (fs.existsSync(FEEDBACK_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function writeFeedbacks(feedbacks) {
  try {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedbacks, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Feedback] Error saving feedbacks:', e);
  }
}

// 1. Envio de Feedback direto da página (sem precisar abrir Instagram)
app.post('/api/feedback', (req, res) => {
  const { name, contact, message, source } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mensagem é obrigatória.' });
  }

  const feedbacks = readFeedbacks();
  const newFeedback = {
    id: 'fb_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: (name || 'Anônimo').trim(),
    contact: (contact || '').trim(),
    message: message.trim(),
    source: source || 'landing-page',
    createdAt: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
  };

  feedbacks.unshift(newFeedback);
  writeFeedbacks(feedbacks);

  console.log(`[Feedback Recebido] ${newFeedback.name} (${newFeedback.contact}): ${newFeedback.message}`);
  return res.json({ success: true, message: 'Feedback recebido com sucesso!', feedback: newFeedback });
});

function isAuthorizedAdmin(req) {
  const userEmail = (req.headers['x-user-email'] || req.query.email || '').toLowerCase().trim();
  const adminSecret = (req.headers['x-admin-secret'] || req.query.secret || '').toLowerCase().trim();

  if (adminSecret === 'kaykyadmin' || adminSecret === 'admin' || adminSecret === 'kayky') return true;

  if (
    userEmail === 'kaykygithub24@gmail.com' ||
    userEmail === 'kaykyaraujo0636@gmail.com' ||
    userEmail.startsWith('kayky') ||
    userEmail.includes('kayky')
  ) {
    return true;
  }

  return false;
}

// 2. Página Visual do Admin direto na Oracle VM (/admin)
app.get('/admin', (req, res) => {
  const feedbacks = readFeedbacks();
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel de Feedbacks // Voxel Admin</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f15; color: #f1f5f9; padding: 2rem 1rem; margin: 0; }
    .container { max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1.25rem; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
    h1 { font-size: 1.4rem; margin: 0; color: #86efac; display: flex; align-items: center; gap: 0.5rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem; }
    .name { font-weight: bold; color: #fff; font-size: 0.95rem; }
    .contact { color: #86efac; font-family: monospace; background: rgba(134,239,172,0.12); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(134,239,172,0.25); }
    .msg { font-size: 0.92rem; line-height: 1.6; white-space: pre-wrap; background: #0f172a; padding: 0.85rem; border-radius: 8px; margin-top: 0.6rem; border: 1px solid #1e293b; color: #e2e8f0; }
    .btn-reload { padding: 8px 16px; background: #86efac; color: #0b0f15; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .btn-reload:hover { background: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>🛡️ Feedbacks & Bugs // Voxel Admin</h1>
        <small style="color: #94a3b8;">Total de mensagens recebidas: <b>${feedbacks.length}</b></small>
      </div>
      <button onclick="location.reload()" class="btn-reload">Atualizar Lista</button>
    </div>
    ${feedbacks.length === 0 ? '<p style="color: #94a3b8; text-align: center; padding: 3rem;">Nenhum feedback recebido ainda.</p>' : ''}
    ${feedbacks.map(f => `
      <div class="card">
        <div class="meta">
          <div>
            <span class="name">${f.name || 'Anônimo'}</span>
            ${f.contact ? `<span class="contact">${f.contact}</span>` : ''}
          </div>
          <span style="font-family: monospace;">${new Date(f.createdAt).toLocaleString('pt-BR')}</span>
        </div>
        <div class="msg">${f.message}</div>
      </div>
    `).join('')}
  </div>
</body>
</html>`;
  res.send(html);
});

// 3. Consulta de Feedbacks para o Admin (JSON)
app.get('/api/feedback', (req, res) => {
  // Se for acesso direto pelo navegador, redireciona para a tela visual /admin
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/admin');
  }

  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }

  const feedbacks = readFeedbacks();
  return res.json({ success: true, count: feedbacks.length, feedbacks });
});

// 4. Exclusão de Feedback
app.delete('/api/feedback/:id', (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }

  const { id } = req.params;
  let feedbacks = readFeedbacks();
  feedbacks = feedbacks.filter(f => f.id !== id);
  writeFeedbacks(feedbacks);
  return res.json({ success: true, message: 'Feedback removido com sucesso.' });
});


// OTA In-App Auto-Updater Endpoints
const GITHUB_CDN_ASAR = 'https://raw.githubusercontent.com/Fuzzy-Z/pulsecord-server/main/app.asar';

app.get('/api/version', (req, res) => {
  if (fs.existsSync(VERSION_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
      data.hasAsar = true;
      data.asarUrl = GITHUB_CDN_ASAR;
      return res.json(data);
    } catch (e) {}
  }
  res.json({
    version: '1.0.43',
    releaseDate: new Date().toISOString(),
    hasAsar: true,
    asarUrl: GITHUB_CDN_ASAR,
    notes: 'Atualização com melhorias de voz e estabilidade no Voxel.'
  });
});

app.get('/api/update/app.asar', (req, res) => {
  if (fs.existsSync(ASAR_FILE)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="app.asar"');
    return res.sendFile(ASAR_FILE);
  }
  // Redirect to GitHub CDN where app.asar is reliably hosted
  res.redirect(302, GITHUB_CDN_ASAR);
});

// SPA fallback for web browser access
if (fs.existsSync(DIST_PATH)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
}

// Initialize Socket.io signaling & music bot
setupSignaling(io);

const PORT = process.env.PORT || 4000;
let isListening = false;

export function startServer(port = PORT) {
  if (isListening) return Promise.resolve(server);
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      isListening = true;
      console.log(`🚀 PulseCord Signaling Server running on 0.0.0.0:${port}`);
      resolve(server);
    });
  });
}

// Auto start
startServer(PORT);

export { app, server, io };
