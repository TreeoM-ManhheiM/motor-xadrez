const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" }
});

// Memória do servidor para guardar as salas
let salas = {};

io.on('connection', (socket) => {
    console.log('♟️ Novo jogador conectado:', socket.id);

    // 1. Aluno entra na sala
    socket.on('entrarSala', ({ apelido, sala }) => {
        socket.join(sala);
        socket.sala = sala;
        socket.apelido = apelido;

        // Cria a sala se não existir
        if (!salas[sala]) {
            salas[sala] = { jogadores: [], rodando: false };
        }

        // Limita a 2 jogadores por mesa de xadrez
        if (salas[sala].jogadores.length >= 2) {
            socket.emit('erro', 'Esta mesa já está cheia!');
            return;
        }

        salas[sala].jogadores.push({ id: socket.id, nome: apelido, pronto: false });
        io.to(sala).emit('estadoLobby', { rodando: salas[sala].rodando, jogadoresInfo: salas[sala].jogadores });
    });

    // 2. Aluno clica em "Estou Pronto"
    socket.on('marcarPronto', () => {
        let sala = socket.sala;
        if (!sala || !salas[sala]) return;

        let jogador = salas[sala].jogadores.find(j => j.id === socket.id);
        if (jogador) jogador.pronto = true;

        io.to(sala).emit('estadoLobby', { rodando: salas[sala].rodando, jogadoresInfo: salas[sala].jogadores });

        // 3. Se os 2 estiverem prontos, a partida começa
        let prontos = salas[sala].jogadores.filter(j => j.pronto).length;
        if (salas[sala].jogadores.length === 2 && prontos === 2) {
            salas[sala].rodando = true;
            
            // O primeiro a entrar fica de Brancas (w), o segundo de Pretas (b)
            let jogador1 = salas[sala].jogadores[0];
            let jogador2 = salas[sala].jogadores[1];

            io.to(jogador1.id).emit('iniciarPartida', { cor: 'w' });
            io.to(jogador2.id).emit('iniciarPartida', { cor: 'b' });
        }
    });

    // 4. Quando alguém move uma peça, avisa o adversário
    socket.on('fazerJogada', (fen) => {
        let sala = socket.sala;
        // O comando 'socket.to(sala)' envia a jogada para o OUTRO jogador
        socket.to(sala).emit('jogadaFeita', fen);
    });

    // 5. Se alguém fechar a aba ou cair a internet
    socket.on('disconnect', () => {
        let sala = socket.sala;
        if (sala && salas[sala]) {
            // Remove o jogador que saiu
            salas[sala].jogadores = salas[sala].jogadores.filter(j => j.id !== socket.id);
            
            if (salas[sala].jogadores.length === 0) {
                delete salas[sala]; // Apaga a sala vazia
            } else {
                // Pausa o jogo e volta pro lobby pro outro jogador não ficar jogando sozinho
                salas[sala].rodando = false; 
                salas[sala].jogadores.forEach(j => j.pronto = false);
                io.to(sala).emit('estadoLobby', { rodando: false, jogadoresInfo: salas[sala].jogadores });
            }
        }
    });
});

// Inicia o servidor na porta configurada pelo Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`♟️ Motor de Xadrez rodando na porta ${PORT}`);
});
