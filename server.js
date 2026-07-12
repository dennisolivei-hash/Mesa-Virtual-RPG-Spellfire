// server.js — Mesa Virtual de Spellfire
// Roda com: node server.js (ou via PM2, mesmo esquema do Escritório Virtual)

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();

// ======================= CONFIGURAÇÃO =======================
// Troque pela URL real do seu site na Vercel (pode ter mais de uma na lista)
const ALLOWED_ORIGINS = [
  'https://SEU-PROJETO.vercel.app',
  'http://localhost:5500',
];
// ===============================================================

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.get('/', (req, res) => {
  res.send('Servidor da Mesa Virtual de Spellfire está no ar.');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

const players = {};   // socket.id -> { name, baralho:[img], mao:[img] }
const mesa = {};       // cartaId -> { img, x, y, girada, dono }
let proximoIdMesa = 1;

function embaralhar(lista){
  const copia = lista.slice();
  for(let i = copia.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

function estadoPublico(){
  const jogadores = {};
  for(const id of Object.keys(players)){
    const p = players[id];
    jogadores[id] = {
      name: p.name,
      baralhoCount: p.baralho.length,
      maoCount: p.mao.length,
      camLigada: p.camLigada,
      ausente: p.ausente,
    };
  }
  return { jogadores, mesa };
}

function broadcastEstado(){
  io.emit('estado', estadoPublico());
}

function enviarMaoPrivada(socket){
  const p = players[socket.id];
  if(p) socket.emit('minha-mao', p.mao);
}

io.on('connection', (socket) => {
  socket.on('entrar', (dados) => {
    const nome = (dados && dados.nome) ? String(dados.nome).slice(0, 20) : 'Visitante';
    players[socket.id] = {
      name: nome,
      baralho: [],
      mao: [],
      camLigada: false,
      ausente: false,
    };
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  // Recebe a lista de cartas escolhidas (nomes de arquivo) e monta/embaralha o baralho
  socket.on('montar-baralho', (cartas) => {
    const p = players[socket.id];
    if(!p || !Array.isArray(cartas) || cartas.length === 0) return;
    p.baralho = embaralhar(cartas);
    p.mao = [];
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('embaralhar-baralho', () => {
    const p = players[socket.id];
    if(!p) return;
    p.baralho = embaralhar(p.baralho);
    broadcastEstado();
  });

  socket.on('comprar-carta', () => {
    const p = players[socket.id];
    if(!p || p.baralho.length === 0) return;
    const carta = p.baralho.pop();
    p.mao.push(carta);
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  // Joga uma carta da mão pra mesa (visível pra todo mundo)
  socket.on('jogar-carta', ({ indice, x, y } = {}) => {
    const p = players[socket.id];
    if(!p || typeof indice !== 'number' || indice < 0 || indice >= p.mao.length) return;
    const [carta] = p.mao.splice(indice, 1);
    const id = 'c' + (proximoIdMesa++);
    mesa[id] = { img: carta, x: x || 400, y: y || 300, girada: false, dono: socket.id };
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('mover-carta-mesa', ({ cartaId, x, y } = {}) => {
    const carta = mesa[cartaId];
    if(!carta || typeof x !== 'number' || typeof y !== 'number') return;
    carta.x = x;
    carta.y = y;
    broadcastEstado();
  });

  socket.on('girar-carta-mesa', ({ cartaId } = {}) => {
    const carta = mesa[cartaId];
    if(!carta) return;
    carta.girada = !carta.girada;
    broadcastEstado();
  });

  // Só o dono pode devolver a própria carta da mesa pra mão
  socket.on('devolver-carta-mesa', ({ cartaId } = {}) => {
    const carta = mesa[cartaId];
    const p = players[socket.id];
    if(!carta || !p || carta.dono !== socket.id) return;
    p.mao.push(carta.img);
    delete mesa[cartaId];
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  // Descarta uma carta da mesa (sai de jogo) — qualquer um pode descartar a própria carta
  socket.on('descartar-carta-mesa', ({ cartaId } = {}) => {
    const carta = mesa[cartaId];
    if(!carta || carta.dono !== socket.id) return;
    delete mesa[cartaId];
    broadcastEstado();
  });

  // Descarta direto da mão, sem passar pela mesa
  socket.on('descartar-da-mao', ({ indice } = {}) => {
    const p = players[socket.id];
    if(!p || typeof indice !== 'number' || indice < 0 || indice >= p.mao.length) return;
    p.mao.splice(indice, 1);
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('status', ({ ausente } = {}) => {
    const p = players[socket.id];
    if(!p) return;
    p.ausente = !!ausente;
    broadcastEstado();
  });

  socket.on('cam-estado', ({ ligada } = {}) => {
    const p = players[socket.id];
    if(!p) return;
    p.camLigada = !!ligada;
    broadcastEstado();
  });

  // Chat — mesa única, então a mensagem vale pra todo mundo
  socket.on('mensagem', (texto) => {
    const p = players[socket.id];
    if(!p || !texto) return;
    io.emit('mensagem', { autor: p.name, texto: String(texto).slice(0, 300) });
  });

  // Sinalização WebRTC (áudio/vídeo) — o servidor só repassa
  socket.on('webrtc-offer', ({ to, offer } = {}) => {
    if(!to) return;
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });
  socket.on('webrtc-answer', ({ to, answer } = {}) => {
    if(!to) return;
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });
  socket.on('webrtc-ice', ({ to, candidate } = {}) => {
    if(!to) return;
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    // Remove as cartas dessa pessoa que estavam na mesa também, pra não sobrar "lixo"
    for(const id of Object.keys(mesa)){
      if(mesa[id].dono === socket.id) delete mesa[id];
    }
    delete players[socket.id];
    broadcastEstado();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Servidor da Mesa Virtual de Spellfire rodando na porta ' + PORT));
