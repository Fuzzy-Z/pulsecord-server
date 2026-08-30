import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { setupSignaling } from './signaling.js';

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

setupSignaling(io);

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`🚀 PulseCord Signaling Server running on port ${PORT}`);
});
