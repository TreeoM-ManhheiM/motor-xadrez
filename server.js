const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js'); // agora também no servidor!

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Configuração do relógio (em segundos)
const TEMPO_INICIAL = 600; // 10 minutos

let salas = {};

// Função para iniciar o relógio de uma sala
function iniciarRelogio(salaId) {
    const sala = salas[salaId];
    if (!sala || sala.intervaloRelogio) return;

    sala.intervaloRelogio = setInterval(() => {
        if (!sala.rodando || sala.jogo.game_over()) {
            return;
        }

        const turno = sala.jogo.turn(); // 'w' ou 'b'
        const jogadorAtual = sala.jogadores.find(j => j.cor === turno);
        if (!jogadorAtual) return;

        // Decrementa o tempo do jogador da vez
        jogadorAtual.tempo -= 1;

        // Envia atualização de tempo para todos na sala
        io.to(salaId).emit('atualizarTempo', {
            w: sala.jogadores.find(j => j.cor === 'w')?.tempo,
            b: sala.jogadores.find(j => j.cor === 'b')?.tempo
        });

        // Verifica se o tempo acabou
        if (jogadorAtual.tempo <= 0) {
            jogadorAtual.tempo = 0;
            clearInterval(sala.intervaloRelogio);
            sala.intervaloRelogio = null;
            sala.rodando = false;

            const vencedor = turno === 'w' ? 'b' : 'w';
            io.to(salaId).emit('fimDeJogo', {
                motivo: 'tempo',
                vencedor: vencedor,
                mensagem: `Tempo esgotado! ${vencedor === 'w' ? 'Brancas' : 'Pretas'} vencem.`
            });
        }
    }, 1000);
}

io.on('connection', (socket) => {
    console.log('♟️ Novo jogador conectado:', socket.id);

    socket.on('entrarSala', ({ apelido, sala: nomeSala }) => {
        socket.join(nomeSala);
        socket.sala = nomeSala;
        socket.apelido = apelido;

        if (!salas[nomeSala]) {
            salas[nomeSala] = {
                jogadores: [],
                espectadores: [],
                rodando: false,
                jogo: new Chess(),
                historico: [],
                intervaloRelogio: null
            };
        }

        const sala = salas[nomeSala];

        // Verifica se já existe jogador com mesmo socket.id (reconexão)
        const jogadorExistente = sala.jogadores.find(j => j.id === socket.id);
        if (jogadorExistente) {
            socket.emit('erro', 'Você já está nesta sala!');
            return;
        }

        // Decide se é jogador ou espectador
        if (sala.jogadores.length < 2) {
            // Adiciona como jogador
            const cor = sala.jogadores.length === 0 ? 'w' : 'b';
            const novoTempo = TEMPO_INICIAL;
            sala.jogadores.push({
                id: socket.id,
                nome: apelido,
                pronto: false,
                cor: cor,
                tempo: novoTempo
            });
            socket.emit('definirPapel', { papel: 'jogador', cor: cor });
        } else {
            // Adiciona como espectador
            sala.espectadores.push({ id: socket.id, nome: apelido });
            socket.emit('definirPapel', { papel: 'espectador' });
            // Envia o estado atual do jogo para o espectador
            socket.emit('estadoAtual', {
                fen: sala.jogo.fen(),
                historico: sala.historico,
                tempos: {
                    w: sala.jogadores.find(j => j.cor === 'w')?.tempo,
                    b: sala.jogadores.find(j => j.cor === 'b')?.tempo
                },
                rodando: sala.rodando
            });
        }

        // Atualiza lobby para todos
        io.to(nomeSala).emit('estadoLobby', {
            rodando: sala.rodando,
            jogadoresInfo: sala.jogadores.map(j => ({
                nome: j.nome,
                pronto: j.pronto,
                cor: j.cor
            })),
            espectadores: sala.espectadores.map(e => e.nome)
        });

        // Se for espectador e jogo já estiver rodando, envia tabuleiro
        if (sala.rodando) {
            const jogador = sala.jogadores.find(j => j.id === socket.id);
            if (!jogador) {
                // espectador
                socket.emit('iniciarPartida', { cor: 'espectador', fen: sala.jogo.fen() });
            }
        }
    });

    socket.on('marcarPronto', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        jogador.pronto = true;
        io.to(nomeSala).emit('estadoLobby', {
            rodando: sala.rodando,
            jogadoresInfo: sala.jogadores.map(j => ({
                nome: j.nome,
                pronto: j.pronto,
                cor: j.cor
            })),
            espectadores: sala.espectadores.map(e => e.nome)
        });

        // Verifica se os dois estão prontos para iniciar
        const todosProntos = sala.jogadores.length === 2 && sala.jogadores.every(j => j.pronto);
        if (todosProntos && !sala.rodando) {
            sala.rodando = true;
            sala.jogo.reset();
            sala.historico = [];
            
            // Inicia relógio
            iniciarRelogio(nomeSala);

            // Notifica cada jogador com sua cor
            sala.jogadores.forEach(jog => {
                io.to(jog.id).emit('iniciarPartida', { cor: jog.cor, fen: sala.jogo.fen() });
            });
            // Notifica espectadores
            sala.espectadores.forEach(esp => {
                io.to(esp.id).emit('iniciarPartida', { cor: 'espectador', fen: sala.jogo.fen() });
            });

            io.to(nomeSala).emit('estadoLobby', {
                rodando: true,
                jogadoresInfo: sala.jogadores.map(j => ({
                    nome: j.nome,
                    pronto: j.pronto,
                    cor: j.cor
                })),
                espectadores: sala.espectadores.map(e => e.nome)
            });
        }
    });

    socket.on('fazerJogada', ({ from, to, promotion }) => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) {
            socket.emit('erro', 'Você não é um jogador desta partida.');
            return;
        }

        // Verifica se é a vez do jogador
        if (sala.jogo.turn() !== jogador.cor) {
            socket.emit('erro', 'Não é sua vez de jogar.');
            return;
        }

        // Tenta executar o movimento
        try {
            const movimento = sala.jogo.move({ from, to, promotion: promotion || 'q' });
            if (!movimento) {
                socket.emit('erro', 'Movimento ilegal.');
                return;
            }

            // Adiciona ao histórico (notação algébrica)
            const lance = movimento.san;
            sala.historico.push(lance);

            // Envia o novo FEN para todos na sala
            io.to(nomeSala).emit('jogadaFeita', {
                fen: sala.jogo.fen(),
                historico: sala.historico,
                lance: lance
            });

            // Verifica fim de jogo
            if (sala.jogo.game_over()) {
                sala.rodando = false;
                clearInterval(sala.intervaloRelogio);
                sala.intervaloRelogio = null;

                let motivo = '';
                let vencedor = null;
                if (sala.jogo.in_checkmate()) {
                    motivo = 'xeque-mate';
                    vencedor = sala.jogo.turn() === 'w' ? 'b' : 'w';
                } else if (sala.jogo.in_draw()) {
                    motivo = 'empate';
                } else if (sala.jogo.in_stalemate()) {
                    motivo = 'afogamento';
                } else if (sala.jogo.in_threefold_repetition()) {
                    motivo = 'repetição tripla';
                } else if (sala.jogo.insufficient_material()) {
                    motivo = 'material insuficiente';
                }

                io.to(nomeSala).emit('fimDeJogo', {
                    motivo: motivo,
                    vencedor: vencedor,
                    mensagem: vencedor ? `${vencedor === 'w' ? 'Brancas' : 'Pretas'} vencem por xeque-mate!` : 'Empate!'
                });
            }

        } catch (e) {
            socket.emit('erro', 'Erro ao processar jogada.');
        }
    });

    // Chat
    socket.on('enviarMensagem', (mensagem) => {
        const nomeSala = socket.sala;
        if (!nomeSala) return;

        const remetente = socket.apelido || 'Anônimo';
        io.to(nomeSala).emit('novaMensagem', {
            remetente: remetente,
            texto: mensagem,
            timestamp: Date.now()
        });
    });

    // Desistir
    socket.on('desistir', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        sala.rodando = false;
        clearInterval(sala.intervaloRelogio);
        sala.intervaloRelogio = null;

        const vencedor = jogador.cor === 'w' ? 'b' : 'w';
        io.to(nomeSala).emit('fimDeJogo', {
            motivo: 'desistencia',
            vencedor: vencedor,
            mensagem: `${jogador.nome} desistiu. ${vencedor === 'w' ? 'Brancas' : 'Pretas'} vencem.`
        });
    });

    // Oferecer empate
    socket.on('oferecerEmpate', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        // Encontra o adversário
        const adversario = sala.jogadores.find(j => j.id !== socket.id);
        if (!adversario) return;

        // Notifica o adversário
        io.to(adversario.id).emit('propostaEmpate', { de: jogador.nome });
    });

    socket.on('responderEmpate', (resposta) => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        if (resposta.aceito) {
            sala.rodando = false;
            clearInterval(sala.intervaloRelogio);
            sala.intervaloRelogio = null;

            io.to(nomeSala).emit('fimDeJogo', {
                motivo: 'empate_aceito',
                vencedor: null,
                mensagem: 'Empate aceito! Partida finalizada.'
            });
        } else {
            // Recusou
            const ofertante = sala.jogadores.find(j => j.nome === resposta.de);
            if (ofertante) {
                io.to(ofertante.id).emit('empateRecusado', { por: socket.apelido });
            }
        }
    });

    socket.on('disconnect', () => {
        const nomeSala = socket.sala;
        if (!nomeSala || !salas[nomeSala]) return;

        const sala = salas[nomeSala];

        // Remove dos jogadores
        const jogadorIndex = sala.jogadores.findIndex(j => j.id === socket.id);
        if (jogadorIndex !== -1) {
            sala.jogadores.splice(jogadorIndex, 1);
            
            if (sala.rodando) {
                // Se um jogador sai durante a partida, o outro vence
                sala.rodando = false;
                clearInterval(sala.intervaloRelogio);
                sala.intervaloRelogio = null;
                const vencedor = sala.jogadores[0]?.cor;
                if (vencedor) {
                    io.to(nomeSala).emit('fimDeJogo', {
                        motivo: 'desconexao',
                        vencedor: vencedor,
                        mensagem: 'Oponente desconectou. Você vence!'
                    });
                }
            }
        } else {
            // Remove dos espectadores
            sala.espectadores = sala.espectadores.filter(e => e.id !== socket.id);
        }

        // Se não houver mais ninguém, deleta a sala
        if (sala.jogadores.length === 0 && sala.espectadores.length === 0) {
            clearInterval(sala.intervaloRelogio);
            delete salas[nomeSala];
        } else {
            // Atualiza lobby
            io.to(nomeSala).emit('estadoLobby', {
                rodando: sala.rodando,
                jogadoresInfo: sala.jogadores.map(j => ({
                    nome: j.nome,
                    pronto: j.pronto,
                    cor: j.cor
                })),
                espectadores: sala.espectadores.map(e => e.nome)
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`♟️ Motor de Xadrez rodando na porta ${PORT}`);
});
