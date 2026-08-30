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
  maxHttpBufferSize: 1e8
});

const VERSION_FILE = path.join(__dirname, 'version.json');
const ASAR_FILE = path.join(__dirname, 'app.asar');

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'PulseCord WebRTC & Signaling Server',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    version: '1.0.0',
    releaseDate: new Date().toISOString(),
    hasAsar: fs.existsSync(ASAR_FILE),
    notes: 'Versão inicial do PulseCord com voz em tempo real e compartilhamento 60fps.'
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

setupSignaling(io);

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`🚀 PulseCord Signaling Server running on port ${PORT}`);
});
