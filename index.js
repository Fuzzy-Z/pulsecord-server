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
const DIST_PATH = path.join(__dirname, '../dist');

// Serve static web app bundle if present
if (fs.existsSync(DIST_PATH)) {
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

// OTA In-App Auto-Updater Endpoints
app.get('/api/version', (req, res) => {
  if (fs.existsSync(VERSION_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
      data.hasAsar = fs.existsSync(ASAR_FILE);
      return res.json(data);
    } catch (e) {}
  }
  res.json({
    version: '1.0.1',
    releaseDate: new Date().toISOString(),
    hasAsar: fs.existsSync(ASAR_FILE),
    notes: 'Versão estável com suporte a Upstash Redis e salas de voz em tempo real.'
  });
});

app.get('/api/update/app.asar', (req, res) => {
  if (fs.existsSync(ASAR_FILE)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="app.asar"');
    res.sendFile(ASAR_FILE);
  } else {
    res.status(404).json({ error: 'Nenhum pacote app.asar disponível para download no servidor.' });
  }
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
