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
  app.use(express.static(DIST_PATH));
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

// 2. Consulta de Feedbacks para o Admin (kaykygithub24@gmail.com)
app.get('/api/feedback', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.query.email;
  const adminSecret = req.headers['x-admin-secret'] || req.query.secret;

  if (userEmail !== 'kaykygithub24@gmail.com' && adminSecret !== 'kaykyadmin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }

  const feedbacks = readFeedbacks();
  return res.json({ success: true, count: feedbacks.length, feedbacks });
});

// 3. Exclusão de Feedback
app.delete('/api/feedback/:id', (req, res) => {
  const userEmail = req.headers['x-user-email'] || req.query.email;
  const adminSecret = req.headers['x-admin-secret'] || req.query.secret;

  if (userEmail !== 'kaykygithub24@gmail.com' && adminSecret !== 'kaykyadmin') {
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
