// server.js — Mesa Virtual de Spellfire
// Roda com: node server.js (ou via PM2, mesmo esquema do Escritório Virtual)

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();

// ======================= CONFIGURAÇÃO =======================
// Troque pela URL real do seu site na Vercel (pode ter mais de uma na lista)
const ALLOWED_ORIGINS = [
  'https://mesa-virtual-rpg-spellfire.vercel.app',
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

// ======================= DADOS DAS CARTAS (Regra Brasil 6) =======================
let CARTAS_META = {};
try {
  CARTAS_META = JSON.parse(fs.readFileSync(path.join(__dirname, 'cartas_meta.json'), 'utf8'));
} catch (e) {
  console.warn('Não foi possível carregar cartas_meta.json — validação de baralho ficará limitada.', e.message);
}

const CATEGORIA_POR_TIPO = {
  'Reino': 'reino',
  'Fortaleza': 'fortaleza',
  'Herói': 'campeao',
  'Monstro': 'campeao',
  'Clérigo': 'campeao',
  'Mago': 'campeao',
  'Psiônico': 'campeao',
  'Regente': 'campeao',
  'Artefato': 'artefato',
  'Item Mágico': 'itemMagico',
  'Evento': 'evento',
  'Regra': 'cartaRegra',
  'Aliado': 'qualquer',
  'Feitiço de Mago': 'qualquer',
  'Feitiço de Clérigo': 'qualquer',
  'Poder Psiônico': 'qualquer',
  'Habilidade de Ladrão': 'qualquer',
  'Habilidade de Sangue': 'qualquer',
  'Combate desarmado': 'qualquer',
};

const FORMATOS_BARALHO = {
  55: {
    total: 55, compraInicial: 5, compraTurno: 3, maoMax: 5,
    faixas: { reino: [8, 15], fortaleza: [0, 6], campeao: [1, 20], artefato: [0, 10], itemMagico: [0, 12], evento: [0, 10], cartaRegra: [0, 3] },
  },
  75: {
    total: 75, compraInicial: 5, compraTurno: 4, maoMax: 5,
    faixas: { reino: [10, 20], fortaleza: [0, 7], campeao: [3, 27], artefato: [0, 12], itemMagico: [0, 15], evento: [0, 13], cartaRegra: [0, 4] },
  },
  110: {
    total: 110, compraInicial: 5, compraTurno: 5, maoMax: 5,
    faixas: { reino: [15, 30], fortaleza: [0, 10], campeao: [4, 40], artefato: [0, 15], itemMagico: [0, 20], evento: [0, 17], cartaRegra: [0, 5] },
  },
};
// Zonas com limite fixo de cartas (regra da casa pedida pelo dono da mesa)
const ZONA_LIMITE = { limbo: 3, abismo: 3, descarte: 3 };
function zonaCabe(p, zona, quantidade) {
  quantidade = quantidade || 1;
  const limite = ZONA_LIMITE[zona];
  if (!limite) return true;
  return (p[zona].length + quantidade) <= limite;
}
function nomeZona(zona) {
  if (zona === 'limbo') return 'Limbo';
  if (zona === 'abismo') return 'Abismo';
  if (zona === 'descarte') return 'Pilha de descarte';
  return zona;
}
const NOMES_CATEGORIA = {
  reino: 'Reinos', fortaleza: 'Fortalezas', campeao: 'Campeões',
  artefato: 'Artefatos', itemMagico: 'Itens Mágicos', evento: 'Eventos', cartaRegra: 'Cartas-regra',
};

function metaDe(img) {
  return CARTAS_META[img] || { tipo: null, mundo: null, nome: null, confiavel: false };
}
function categoriaDe(img) {
  const m = metaDe(img);
  return CATEGORIA_POR_TIPO[m.tipo] || null;
}

function validarBaralho(cartas, formato) {
  const cfg = FORMATOS_BARALHO[formato];
  const contagens = { reino: 0, fortaleza: 0, campeao: 0, artefato: 0, itemMagico: 0, evento: 0, cartaRegra: 0, qualquer: 0, desconhecido: 0 };
  for (const img of cartas) {
    const cat = categoriaDe(img);
    if (!cat) contagens.desconhecido++;
    else contagens[cat]++;
  }
  const avisos = [];
  for (const cat of Object.keys(cfg.faixas)) {
    const min = cfg.faixas[cat][0], max = cfg.faixas[cat][1];
    const n = contagens[cat];
    if (n < min || n > max) {
      avisos.push(NOMES_CATEGORIA[cat] + ': ' + n + ' (faixa oficial: ' + min + '–' + max + ')');
    }
  }
  if (cartas.length !== cfg.total) {
    avisos.push('Total de cartas: ' + cartas.length + ' (formato de ' + cfg.total + ' cartas)');
  }
  if (contagens.desconhecido > 0) {
    avisos.push(contagens.desconhecido + ' carta(s) ainda sem tipo identificado no nosso banco — não entraram na conferência acima.');
  }
  return { formato: formato, contagens: contagens, avisos: avisos, ok: avisos.length === (contagens.desconhecido > 0 ? 1 : 0) };
}

const players = {};
let proximoId = 1;
function novoId() { return 'c' + (proximoId++); }

let cartasRegraEmJogo = [];

let ordemTurno = [];
let turnoAtualIndex = 0;
let faseAtual = 0;

function jogadorDaVez() {
  if (ordemTurno.length === 0) return null;
  return ordemTurno[turnoAtualIndex % ordemTurno.length];
}

function novasFormacao() {
  const slots = {};
  const posicoes = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < posicoes.length; i++) {
    slots[posicoes[i]] = { reino: null, arrasada: false, fortaleza: null };
  }
  return slots;
}

function criarJogador(nome) {
  return {
    name: nome,
    baralho: [],
    mao: [],
    formacao: novasFormacao(),
    poco: [],
    limbo: [],
    abismo: [],
    descarte: [],
    formato: null,
    jaJogouReino: false,
    jaJogouFortaleza: false,
    camLigada: false,
    ausente: false,
  };
}

function embaralhar(lista) {
  const copia = lista.slice();
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copia[i]; copia[i] = copia[j]; copia[j] = tmp;
  }
  return copia;
}

function posicaoLiberada(formacao, posicao) {
  if (posicao === 'A') return true;
  if (posicao === 'B' || posicao === 'C') return !!formacao.A.reino;
  if (posicao === 'D' || posicao === 'E' || posicao === 'F') return !!(formacao.B.reino && formacao.C.reino);
  return false;
}

function estadoPublico() {
  const jogadores = {};
  const ids = Object.keys(players);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const p = players[id];
    jogadores[id] = {
      name: p.name,
      baralhoCount: p.baralho.length,
      maoCount: p.mao.length,
      formacao: p.formacao,
      poco: p.poco,
      limbo: p.limbo,
      abismo: p.abismo,
      descarte: p.descarte,
      formato: p.formato,
      camLigada: p.camLigada,
      ausente: p.ausente,
    };
  }
  return {
    jogadores: jogadores,
    cartasRegraEmJogo: cartasRegraEmJogo,
    turno: { jogadorDaVez: jogadorDaVez(), fase: faseAtual, ordem: ordemTurno },
  };
}

function broadcastEstado() {
  io.emit('estado', estadoPublico());
}

function enviarMaoPrivada(socket) {
  const p = players[socket.id];
  if (p) socket.emit('minha-mao', p.mao);
}

const MAO_MAX_PADRAO = 5;
function limiteMao(p) {
  const cfg = p.formato ? FORMATOS_BARALHO[p.formato] : null;
  return cfg ? cfg.maoMax : MAO_MAX_PADRAO;
}
function comprarCartas(p, quantidade) {
  const limite = limiteMao(p);
  for (let i = 0; i < quantidade; i++) {
    if (p.mao.length >= limite) break;
    if (p.baralho.length === 0) {
      if (p.descarte.length === 0) break;
      p.baralho = embaralhar(p.descarte.map(function(c){ return c.img; }));
      p.descarte = [];
    }
    p.mao.push(p.baralho.pop());
  }
}

io.on('connection', function(socket){
  socket.on('entrar', function(dados){
    const nome = (dados && dados.nome) ? String(dados.nome).slice(0, 20) : 'Visitante';
    players[socket.id] = criarJogador(nome);
    ordemTurno.push(socket.id);
    broadcastEstado();
    enviarMaoPrivada(socket);
    socket.emit('meta-cartas', CARTAS_META);
  });

  socket.on('validar-baralho', function(dados){
    dados = dados || {};
    const cartas = dados.cartas, formato = dados.formato;
    if (!Array.isArray(cartas) || !FORMATOS_BARALHO[formato]) return;
    socket.emit('baralho-validado', validarBaralho(cartas, formato));
  });

  socket.on('montar-baralho', function(dados){
    dados = dados || {};
    const cartas = dados.cartas, formato = dados.formato;
    const p = players[socket.id];
    if (!p || !Array.isArray(cartas) || cartas.length === 0) return;
    p.formato = FORMATOS_BARALHO[formato] ? formato : null;
    const embaralhado = embaralhar(cartas);

    // Preenche a formação já com até 6 reinos sorteados do próprio baralho (posições A-F,
    // na ordem em que forem encontrados), pra começar a partida com a mesa pronta.
    p.formacao = novasFormacao();
    const posicoesFormacao = ['A', 'B', 'C', 'D', 'E', 'F'];
    const restante = [];
    let reinosColocados = 0;
    for (let i = 0; i < embaralhado.length; i++) {
      const img = embaralhado[i];
      if (reinosColocados < 6 && categoriaDe(img) === 'reino') {
        p.formacao[posicoesFormacao[reinosColocados]] = { reino: img, arrasada: false, fortaleza: null };
        reinosColocados++;
      } else {
        restante.push(img);
      }
    }
    p.baralho = restante;
    p.mao = [];
    // Montar um baralho novo reinicia o estado em jogo desse jogador (evita lixo de uma partida anterior)
    p.poco = [];
    p.limbo = [];
    p.abismo = [];
    p.descarte = [];
    p.jaJogouReino = false;
    p.jaJogouFortaleza = false;
    const cfg = p.formato ? FORMATOS_BARALHO[p.formato] : null;
    comprarCartas(p, cfg ? cfg.compraInicial : 5);
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('embaralhar-baralho', function(){
    const p = players[socket.id];
    if (!p) return;
    p.baralho = embaralhar(p.baralho);
    broadcastEstado();
  });

  socket.on('comprar-carta', function(){
    const p = players[socket.id];
    if (!p) return;
    if (p.mao.length >= limiteMao(p)) {
      socket.emit('acao-invalida', 'Mão cheia (máx. ' + limiteMao(p) + ' cartas). Jogue ou descarte alguma carta antes de comprar.');
      return;
    }
    comprarCartas(p, 1);
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('jogar-carta-regra', function(dados){
    dados = dados || {};
    const indiceMao = dados.indiceMao;
    const p = players[socket.id];
    if (!p || typeof indiceMao !== 'number' || indiceMao < 0 || indiceMao >= p.mao.length) return;
    const img = p.mao.splice(indiceMao, 1)[0];
    cartasRegraEmJogo.push({ id: novoId(), img: img, dono: socket.id });
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('descartar-carta-regra', function(dados){
    dados = dados || {};
    const id = dados.id;
    const idx = cartasRegraEmJogo.findIndex(function(c){ return c.id === id; });
    if (idx === -1 || cartasRegraEmJogo[idx].dono !== socket.id) return;
    const p = players[socket.id];
    if (p && !zonaCabe(p, 'abismo', 1)) {
      socket.emit('acao-invalida', nomeZona('abismo') + ' cheio (máx. 3 cartas). Mova ou descarte alguma carta de lá antes.');
      return;
    }
    const carta = cartasRegraEmJogo.splice(idx, 1)[0];
    if (p) p.abismo.push({ id: novoId(), img: carta.img });
    broadcastEstado();
  });

  socket.on('jogar-reino', function(dados){
    dados = dados || {};
    const indiceMao = dados.indiceMao, posicao = dados.posicao;
    const p = players[socket.id];
    if (!p) return;
    if (typeof indiceMao !== 'number' || indiceMao < 0 || indiceMao >= p.mao.length) {
      socket.emit('acao-invalida', 'Carta inválida.');
      return;
    }
    if (!p.formacao[posicao]) {
      socket.emit('acao-invalida', 'Posição inválida.');
      return;
    }
    if (p.jaJogouReino) {
      socket.emit('acao-invalida', 'Você já jogou um reino nesse turno (só um por turno).');
      return;
    }
    const slot = p.formacao[posicao];
    if (slot.reino && !slot.arrasada) {
      socket.emit('acao-invalida', 'Essa posição já tem um reino ativo.');
      return;
    }
    if (!posicaoLiberada(p.formacao, posicao)) {
      socket.emit('acao-invalida', 'Preencha a posição A antes de B/C, e B e C antes de D/E/F.');
      return;
    }
    if (slot.reino && slot.arrasada) {
      const qtdDescarte = slot.fortaleza ? 2 : 1;
      if (!zonaCabe(p, 'descarte', qtdDescarte)) {
        socket.emit('acao-invalida', nomeZona('descarte') + ' cheia (máx. 3 cartas). Mova ou descarte alguma carta de lá antes de jogar aqui.');
        return;
      }
    }

    const img = p.mao.splice(indiceMao, 1)[0];
    if (slot.reino && slot.arrasada) {
      p.descarte.push({ id: novoId(), img: slot.reino });
      if (slot.fortaleza) p.descarte.push({ id: novoId(), img: slot.fortaleza });
    }
    p.formacao[posicao] = { reino: img, arrasada: false, fortaleza: null };
    p.jaJogouReino = true;
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('jogar-fortaleza', function(dados){
    dados = dados || {};
    const indiceMao = dados.indiceMao, posicao = dados.posicao;
    const p = players[socket.id];
    if (!p) return;
    if (typeof indiceMao !== 'number' || indiceMao < 0 || indiceMao >= p.mao.length) {
      socket.emit('acao-invalida', 'Carta inválida.');
      return;
    }
    const slot = p.formacao[posicao];
    if (!slot || !slot.reino || slot.arrasada) {
      socket.emit('acao-invalida', 'Só dá pra jogar fortaleza sobre um reino ativo.');
      return;
    }
    if (slot.fortaleza) {
      socket.emit('acao-invalida', 'Essa posição já tem uma fortaleza.');
      return;
    }
    if (p.jaJogouFortaleza) {
      socket.emit('acao-invalida', 'Você já jogou uma fortaleza nesse turno (só uma por turno).');
      return;
    }
    const img = p.mao.splice(indiceMao, 1)[0];
    slot.fortaleza = img;
    p.jaJogouFortaleza = true;
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('arrasar-reino', function(dados){
    dados = dados || {};
    const posicao = dados.posicao;
    const p = players[socket.id];
    if (!p || !p.formacao[posicao] || !p.formacao[posicao].reino) return;
    const slot = p.formacao[posicao];
    if (slot.fortaleza && !zonaCabe(p, 'descarte', 1)) {
      socket.emit('acao-invalida', nomeZona('descarte') + ' cheia (máx. 3 cartas). Mova ou descarte alguma carta de lá antes.');
      return;
    }
    slot.arrasada = true;
    if (slot.fortaleza) {
      p.descarte.push({ id: novoId(), img: slot.fortaleza });
      slot.fortaleza = null;
    }
    broadcastEstado();
  });

  socket.on('descartar-fortaleza', function(dados){
    dados = dados || {};
    const posicao = dados.posicao;
    const p = players[socket.id];
    if (!p || !p.formacao[posicao] || !p.formacao[posicao].fortaleza) return;
    if (!zonaCabe(p, 'descarte', 1)) {
      socket.emit('acao-invalida', nomeZona('descarte') + ' cheia (máx. 3 cartas). Mova ou descarte alguma carta de lá antes.');
      return;
    }
    const slot = p.formacao[posicao];
    p.descarte.push({ id: novoId(), img: slot.fortaleza });
    slot.fortaleza = null;
    broadcastEstado();
  });

  socket.on('reconstruir-reino', function(dados){
    dados = dados || {};
    const posicao = dados.posicao, indicesDescarte = dados.indicesDescarte;
    const p = players[socket.id];
    if (!p || !p.formacao[posicao]) return;
    const slot = p.formacao[posicao];
    if (!slot.reino || !slot.arrasada) return;
    if (p.jaJogouReino) return;
    if (!Array.isArray(indicesDescarte) || indicesDescarte.length !== 3) return;
    const indicesUnicos = Array.from(new Set(indicesDescarte)).sort(function(a,b){ return b-a; });
    if (indicesUnicos.length !== 3 || indicesUnicos.some(function(i){ return i < 0 || i >= p.mao.length; })) return;
    if (!zonaCabe(p, 'descarte', 3)) {
      socket.emit('acao-invalida', nomeZona('descarte') + ' cheia (máx. 3 cartas). Mova ou descarte alguma carta de lá antes de reconstruir.');
      return;
    }
    for (let k = 0; k < indicesUnicos.length; k++) {
      const img = p.mao.splice(indicesUnicos[k], 1)[0];
      p.descarte.push({ id: novoId(), img: img });
    }
    slot.arrasada = false;
    p.jaJogouReino = true;
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('jogar-no-poco', function(dados){
    dados = dados || {};
    const indiceMao = dados.indiceMao;
    const p = players[socket.id];
    if (!p || typeof indiceMao !== 'number' || indiceMao < 0 || indiceMao >= p.mao.length) return;
    const img = p.mao.splice(indiceMao, 1)[0];
    p.poco.push({ id: novoId(), img: img, girada: false, anexos: [] });
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('anexar-carta-poco', function(dados){
    dados = dados || {};
    const indiceMao = dados.indiceMao, pocoId = dados.pocoId;
    const p = players[socket.id];
    if (!p || typeof indiceMao !== 'number' || indiceMao < 0 || indiceMao >= p.mao.length) return;
    const alvo = p.poco.find(function(c){ return c.id === pocoId; });
    if (!alvo) return;
    const img = p.mao.splice(indiceMao, 1)[0];
    alvo.anexos.push(img);
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('girar-carta-poco', function(dados){
    dados = dados || {};
    const pocoId = dados.pocoId;
    const p = players[socket.id];
    if (!p) return;
    const alvo = p.poco.find(function(c){ return c.id === pocoId; });
    if (alvo) alvo.girada = !alvo.girada;
    broadcastEstado();
  });

  const ZONAS_VALIDAS = ['poco', 'limbo', 'abismo', 'descarte', 'mao'];
  socket.on('mover-carta', function(dados){
    dados = dados || {};
    const origemZona = dados.origemZona, origemId = dados.origemId, destinoZona = dados.destinoZona;
    const p = players[socket.id];
    if (!p || ZONAS_VALIDAS.indexOf(origemZona) === -1 || ZONAS_VALIDAS.indexOf(destinoZona) === -1) return;
    if (destinoZona === 'mao') {
      if (p.mao.length >= limiteMao(p)) {
        socket.emit('acao-invalida', 'Mão cheia (máx. ' + limiteMao(p) + ' cartas).');
        return;
      }
    } else if (!zonaCabe(p, destinoZona, 1)) {
      socket.emit('acao-invalida', nomeZona(destinoZona) + ' cheia (máx. 3 cartas). Mova ou descarte alguma carta de lá antes.');
      return;
    }
    let img = null;
    if (origemZona === 'mao') {
      const i = Number(origemId);
      if (isNaN(i) || i < 0 || i >= p.mao.length) return;
      img = p.mao.splice(i, 1)[0];
    } else {
      const lista = p[origemZona];
      const idx = lista.findIndex(function(c){ return c.id === origemId; });
      if (idx === -1) return;
      img = lista.splice(idx, 1)[0].img;
    }
    if (destinoZona === 'mao') p.mao.push(img);
    else p[destinoZona].push({ id: novoId(), img: img });
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('descartar-da-mao', function(dados){
    dados = dados || {};
    const indice = dados.indice;
    const p = players[socket.id];
    if (!p || typeof indice !== 'number' || indice < 0 || indice >= p.mao.length) return;
    const cat = categoriaDe(p.mao[indice]);
    const zonaDestino = cat === 'evento' ? 'abismo' : 'descarte';
    if (!zonaCabe(p, zonaDestino, 1)) {
      socket.emit('acao-invalida', nomeZona(zonaDestino) + ' cheio (máx. 3 cartas). Mova ou descarte alguma carta de lá antes.');
      return;
    }
    const img = p.mao.splice(indice, 1)[0];
    p[zonaDestino].push({ id: novoId(), img: img });
    broadcastEstado();
    enviarMaoPrivada(socket);
  });

  socket.on('proxima-fase', function(){
    if (jogadorDaVez() !== socket.id) return;
    const p = players[socket.id];
    if (faseAtual === 6) {
      if (p) { p.jaJogouReino = false; p.jaJogouFortaleza = false; }
      turnoAtualIndex = (turnoAtualIndex + 1) % Math.max(ordemTurno.length, 1);
      faseAtual = 0;
    } else {
      faseAtual++;
    }
    broadcastEstado();
  });

  socket.on('status', function(dados){
    dados = dados || {};
    const p = players[socket.id];
    if (!p) return;
    p.ausente = !!dados.ausente;
    broadcastEstado();
  });

  socket.on('cam-estado', function(dados){
    dados = dados || {};
    const p = players[socket.id];
    if (!p) return;
    p.camLigada = !!dados.ligada;
    broadcastEstado();
  });

  socket.on('mensagem', function(texto){
    const p = players[socket.id];
    if (!p || !texto) return;
    io.emit('mensagem', { autor: p.name, texto: String(texto).slice(0, 300) });
  });

  socket.on('webrtc-offer', function(dados){
    dados = dados || {};
    if (!dados.to) return;
    io.to(dados.to).emit('webrtc-offer', { from: socket.id, offer: dados.offer });
  });
  socket.on('webrtc-answer', function(dados){
    dados = dados || {};
    if (!dados.to) return;
    io.to(dados.to).emit('webrtc-answer', { from: socket.id, answer: dados.answer });
  });
  socket.on('webrtc-ice', function(dados){
    dados = dados || {};
    if (!dados.to) return;
    io.to(dados.to).emit('webrtc-ice', { from: socket.id, candidate: dados.candidate });
  });

  socket.on('disconnect', function(){
    delete players[socket.id];
    ordemTurno = ordemTurno.filter(function(id){ return id !== socket.id; });
    cartasRegraEmJogo = cartasRegraEmJogo.filter(function(c){ return c.dono !== socket.id; });
    if (turnoAtualIndex >= ordemTurno.length) turnoAtualIndex = 0;
    broadcastEstado();
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function(){
  console.log('Servidor da Mesa Virtual de Spellfire rodando na porta ' + PORT);
});
