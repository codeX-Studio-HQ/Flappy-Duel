const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = {};

function generatePipeSet(n = 20) {
    return Array.from({ length: n }, () => ({
        top: Math.floor(Math.random() * 210) + 85
    }));
}

io.on('connection', socket => {
    console.log(`✅ Bağlandı: ${socket.id}`);

    // ---------- PİNG PONG (YENİ) ----------
    socket.on('ping', () => {
        socket.emit('pong');
    });
    // -------------------------------------

    /* ── Oda Oluştur ── */
    socket.on('createRoom', () => {
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[code] = {
            players:     [{ id: socket.id, score: 0, alive: true, ready: false }],
            host:        socket.id,
            pipeSet:     generatePipeSet(),
            gameStarted: false,
            gameOver:    false
        };
        socket.join(code);
        socket.emit('roomCreated', { roomCode: code, isHost: true });
        console.log(`🏠 Oda: ${code}`);
    });

    /* ── Odaya Katıl ── */
    socket.on('joinRoom', code => {
        const room = rooms[code];
        if (!room)                  return socket.emit('error', '❌ Oda bulunamadı!');
        if (room.players.length>=2) return socket.emit('error', '❌ Oda dolu!');
        if (room.gameStarted)       return socket.emit('error', '❌ Oyun başladı!');

        room.players.push({ id: socket.id, score: 0, alive: true, ready: false });
        socket.join(code);
        socket.emit('roomJoined', { roomCode: code, pipeSet: room.pipeSet });
        io.to(room.host).emit('opponentJoined', { roomCode: code });
        console.log(`👤 ${socket.id} → ${code}`);
    });

    /* ── Oyunu Başlat ── */
    socket.on('startGame', code => {
        const room = rooms[code];
        if (!room || room.host !== socket.id) return;
        if (room.players.length !== 2)        return;
        if (room.gameStarted)                 return;

        room.gameOver  = false;
        room.startedAt = Date.now() + 3000; // geri sayım dahil
        room.players.forEach(p => {
            p.score  = 0;
            p.alive  = true;
            p.flaps  = 0;
            p.diedAt = null;
            p.ready  = false;
        });
        room.pipeSet = generatePipeSet();

        io.to(code).emit('countdown', { seconds: 3, pipeSet: room.pipeSet });
        setTimeout(() => { if (rooms[code]) rooms[code].gameStarted = true; }, 3000);
    });

    /* ── Kanat ve Flap Sayacı ── */
    socket.on('flap', code => {
        const room = rooms[code];
        if (room) {
            const p = room.players.find(p => p.id === socket.id);
            if (p) p.flaps = (p.flaps || 0) + 1;
        }
        socket.to(code).emit('opponentFlapped');
    });

    /* ── Skor ── */
    socket.on('scoreUpdate', code => {
        const room = rooms[code];
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        if (p) {
            p.score++;
            io.to(code).emit('scoreUpdated', { playerId: socket.id, score: p.score });
        }
    });

    /* ── Oyun Bitti ── */
    socket.on('gameOver', code => {
        const room = rooms[code];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        player.alive  = false;
        player.diedAt = Date.now();

        socket.to(code).emit('opponentDied');

        const alive = room.players.filter(p => p.alive).length;
        if (alive === 0 || (room.players.length === 2 && alive <= 1)) {
            const [p1, p2] = room.players;
            let winner = 'draw';
            if (p1 && p2) {
                if      (p1.score > p2.score) winner = p1.id;
                else if (p2.score > p1.score) winner = p2.id;
            }
            room.gameStarted = false;
            room.gameOver    = true;

            setTimeout(() => {
                room.players.forEach(me => {
                    const opp = room.players.find(p => p.id !== me.id);
                    if (!opp) return;
                    const oppAliveMs = opp.diedAt
                        ? opp.diedAt - (room.startedAt || opp.diedAt)
                        : Date.now() - (room.startedAt || Date.now());
                    io.to(me.id).emit('gameEnded', {
                        winner,
                        oppFlaps:   opp.flaps || 0,
                        oppAliveMs: oppAliveMs
                    });
                });
            }, 850);
        }
    });

    /* ── Tekrar Oyna ── */
    socket.on('readyToRestart', code => {
        const room = rooms[code];
        if (!room || !room.gameOver) return;
        const p = room.players.find(p => p.id === socket.id);
        if (p) p.ready = true;

        const allReady = room.players.length === 2 && room.players.every(p => p.ready);
        if (allReady) {
            room.pipeSet = generatePipeSet();
            room.players.forEach(p => { p.score = 0; p.alive = true; p.ready = false; });
            room.gameOver = false;
            io.to(code).emit('countdown', { seconds: 3, pipeSet: room.pipeSet });
            setTimeout(() => { if (rooms[code]) rooms[code].gameStarted = true; }, 3000);
        } else {
            socket.to(code).emit('opponentReadyForRestart');
        }
    });

    /* ── Ana Menü ── */
    socket.on('backToMenu', code => {
        const room = rooms[code];
        if (room) {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                socket.leave(code);
                if (room.players.length === 0) { delete rooms[code]; console.log(`🧹 ${code}`); }
                else io.to(code).emit('opponentLeft');
            }
        }
        socket.emit('menuRedirect');
    });

    /* ── Disconnect ── */
    socket.on('disconnect', () => {
        console.log(`❌ Ayrıldı: ${socket.id}`);
        for (const code in rooms) {
            const room = rooms[code];
            const idx  = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                if (room.players.length === 0) { delete rooms[code]; }
                else io.to(code).emit('opponentLeft');
                break;
            }
        }
    });
});

server.listen(3000, () => console.log('🦅 http://localhost:3000'));
