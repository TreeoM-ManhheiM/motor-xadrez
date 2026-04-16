const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Chess } = require('chess.js');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const TEMPO_INICIAL = 600; // 10 minutos

let salas = {};

function iniciarRelogio(salaId) {
    const sala = salas[salaId];
    if (!sala || sala.intervaloRelogio) return;

    sala.intervaloRelogio = setInterval(() => {
        if (!sala.rodando || sala.jogo.game_over()) {
            return;
        }

        const turno = sala.jogo.turn();
        const jogadorAtual = sala.jogadores.find(j => j.cor === turno);
        if (!jogadorAtual) return;

        jogadorAtual.tempo -= 1;

        io.to(salaId).emit('atualizarTempo', {
            w: sala.jogadores.find(j => j.cor === 'w')?.tempo,
            b: sala.jogadores.find(j => j.cor === 'b')?.tempo
        });

        if (jogadorAtual.tempo <= 0) {
            jogadorAtual.tempo = 0;
            clearInterval(sala.intervaloRelogio);
            sala.intervaloRelogio = null;
            sala.rodando = false;
            sala.ofertasEmpate = {};

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
                intervaloRelogio: null,
                ofertasEmpate: {}
            };
        }

        const sala = salas[nomeSala];

        const jogadorExistente = sala.jogadores.find(j => j.id === socket.id);
        if (jogadorExistente) {
            socket.emit('erro', 'Você já está nesta sala!');
            return;
        }

        if (sala.jogadores.length < 2) {
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
            console.log(`[Sala ${nomeSala}] Jogador ${apelido} (${cor}) entrou.`);
        } else {
            sala.espectadores.push({ id: socket.id, nome: apelido });
            socket.emit('definirPapel', { papel: 'espectador' });
            socket.emit('estadoAtual', {
                fen: sala.jogo.fen(),
                historico: sala.historico,
                tempos: {
                    w: sala.jogadores.find(j => j.cor === 'w')?.tempo,
                    b: sala.jogadores.find(j => j.cor === 'b')?.tempo
                },
                rodando: sala.rodando
            });
            console.log(`[Sala ${nomeSala}] Espectador ${apelido} entrou.`);
        }

        io.to(nomeSala).emit('estadoLobby', {
            rodando: sala.rodando,
            jogadoresInfo: sala.jogadores.map(j => ({
                nome: j.nome,
                pronto: j.pronto,
                cor: j.cor
            })),
            espectadores: sala.espectadores.map(e => e.nome)
        });

        if (sala.rodando) {
            const jogador = sala.jogadores.find(j => j.id === socket.id);
            if (!jogador) {
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

        const todosProntos = sala.jogadores.length === 2 && sala.jogadores.every(j => j.pronto);
        if (todosProntos && !sala.rodando) {
            sala.rodando = true;
            sala.jogo.reset();
            sala.historico = [];
            sala.ofertasEmpate = {};
            
            iniciarRelogio(nomeSala);

            sala.jogadores.forEach(jog => {
                io.to(jog.id).emit('iniciarPartida', { cor: jog.cor, fen: sala.jogo.fen() });
            });
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
            console.log(`[Sala ${nomeSala}] Partida iniciada!`);
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

        if (sala.jogo.turn() !== jogador.cor) {
            socket.emit('erro', 'Não é sua vez de jogar.');
            return;
        }

        try {
            const movimento = sala.jogo.move({ from, to, promotion: promotion || 'q' });
            if (!movimento) {
                socket.emit('erro', 'Movimento ilegal.');
                return;
            }

            const lance = movimento.san;
            sala.historico.push(lance);

            io.to(nomeSala).emit('jogadaFeita', {
                fen: sala.jogo.fen(),
                historico: sala.historico,
                lance: lance
            });

            if (sala.jogo.game_over()) {
                sala.rodando = false;
                clearInterval(sala.intervaloRelogio);
                sala.intervaloRelogio = null;
                sala.ofertasEmpate = {};

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
                console.log(`[Sala ${nomeSala}] Fim de jogo: ${motivo}`);
            }

        } catch (e) {
            socket.emit('erro', 'Erro ao processar jogada.');
        }
    });

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

    socket.on('desistir', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        sala.rodando = false;
        clearInterval(sala.intervaloRelogio);
        sala.intervaloRelogio = null;
        sala.ofertasEmpate = {};

        const vencedor = jogador.cor === 'w' ? 'b' : 'w';
        io.to(nomeSala).emit('fimDeJogo', {
            motivo: 'desistencia',
            vencedor: vencedor,
            mensagem: `${jogador.nome} desistiu. ${vencedor === 'w' ? 'Brancas' : 'Pretas'} vencem.`
        });
        console.log(`[Sala ${nomeSala}] ${jogador.nome} desistiu.`);
    });

    socket.on('oferecerEmpate', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        if (sala.ofertasEmpate[socket.id]) {
            socket.emit('erro', 'Você já ofereceu empate nesta partida.');
            return;
        }

        const adversario = sala.jogadores.find(j => j.id !== socket.id);
        if (!adversario) return;

        sala.ofertasEmpate[socket.id] = true;

        // Envia para a sala inteira, mas com o ID do destinatário para filtro no cliente
        io.to(nomeSala).emit('propostaEmpate', {
            de: jogador.nome,
            deId: socket.id,
            para: adversario.id  // importante: cliente verificará se é para ele
        });
        console.log(`[Sala ${nomeSala}] ${jogador.nome} ofereceu empate para ${adversario.nome} (${adversario.id})`);
    });

    socket.on('responderEmpate', (resposta) => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || !sala.rodando) return;

        if (resposta.aceito) {
            sala.rodando = false;
            clearInterval(sala.intervaloRelogio);
            sala.intervaloRelogio = null;
            sala.ofertasEmpate = {};

            io.to(nomeSala).emit('fimDeJogo', {
                motivo: 'empate_aceito',
                vencedor: null,
                mensagem: 'Empate aceito! Partida finalizada.'
            });
            console.log(`[Sala ${nomeSala}] Empate aceito.`);
        } else {
            const ofertante = sala.jogadores.find(j => j.nome === resposta.de);
            if (ofertante) {
                io.to(ofertante.id).emit('empateRecusado', { por: socket.apelido });
                console.log(`[Sala ${nomeSala}] Empate recusado por ${socket.apelido}.`);
            }
        }
    });

    socket.on('disconnect', () => {
        const nomeSala = socket.sala;
        if (!nomeSala || !salas[nomeSala]) return;

        const sala = salas[nomeSala];
        console.log(`[Sala ${nomeSala}] ${socket.apelido || socket.id} desconectou.`);

        const jogadorIndex = sala.jogadores.findIndex(j => j.id === socket.id);
        if (jogadorIndex !== -1) {
            sala.jogadores.splice(jogadorIndex, 1);
            
            if (sala.rodando) {
                sala.rodando = false;
                clearInterval(sala.intervaloRelogio);
                sala.intervaloRelogio = null;
                sala.ofertasEmpate = {};
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
            sala.espectadores = sala.espectadores.filter(e => e.id !== socket.id);
        }

        if (sala.jogadores.length === 0 && sala.espectadores.length === 0) {
            clearInterval(sala.intervaloRelogio);
            delete salas[nomeSala];
            console.log(`[Sala ${nomeSala}] Sala removida.`);
        } else {
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
