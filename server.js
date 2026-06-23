const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const BOARD_SIZE = 15;

class GameRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map();
    this.board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(null));
    this.currentPlayer = 'black';
    this.winner = null;
    this.winningCells = [];
    this.moveCount = 0;
    this.isDraw = false;
  }

  addPlayer(socket, color) {
    this.players.set(socket.id, { color, socket });
    socket.join(this.roomId);
  }

  getPlayerCount() { return this.players.size; }

  getPlayerColor(socketId) {
    const p = this.players.get(socketId);
    return p ? p.color : null;
  }

  getOpponent(socketId) {
    for (let [id, player] of this.players) {
      if (id !== socketId) return { id, ...player };
    }
    return null;
  }

  removePlayer(socketId) { this.players.delete(socketId); }
  isEmpty() { return this.players.size === 0; }

  makeMove(row, col, player) {
    if (this.board[row][col] !== null || this.winner || this.isDraw || this.currentPlayer !== player) return false;
    this.board[row][col] = player;
    this.moveCount++;
    
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    let won = false;
    for (let [dx, dy] of dirs) {
      let cells = [[row, col]];
      for (let s = 1; s < 5; s++) {
        const r = row + dx * s, c = col + dy * s;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) cells.push([r, c]);
        else break;
      }
      for (let s = 1; s < 5; s++) {
        const r = row - dx * s, c = col - dy * s;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) cells.unshift([r, c]);
        else break;
      }
      if (cells.length >= 5) { won = true; this.winningCells = cells; break; }
    }
    
    if (won) { this.winner = player; this.broadcast(); return true; }
    
    let full = true;
    for (let r = 0; r < BOARD_SIZE; r++)
      for (let c = 0; c < BOARD_SIZE; c++)
        if (this.board[r][c] === null) full = false;
    
    if (full) { this.isDraw = true; this.broadcast(); return true; }
    
    this.currentPlayer = player === 'black' ? 'white' : 'black';
    this.broadcast();
    return true;
  }

  broadcast() {
    io.to(this.roomId).emit('gameState', {
      board: this.board,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      winningCells: this.winningCells,
      moveCount: this.moveCount,
      isDraw: this.isDraw
    });
  }
}

io.on('connection', (socket) => {
  socket.on('createPrivateRoom', () => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    const room = new GameRoom(roomId);
    rooms.set(roomId, room);
    socket.emit('privateRoomCreated', { roomId });
  });

  socket.on('joinPrivateRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error', { message: '房间不存在' }); return; }
    if (room.getPlayerCount() >= 2) { socket.emit('error', { message: '房间已满' }); return; }
    const first = room.players.values().next().value;
    const color = first ? (first.color === 'black' ? 'white' : 'black') : 'black';
    room.addPlayer(socket, color);
    socket.emit('joinedRoom', { roomId, color });
    if (room.getPlayerCount() === 2) {
      room.broadcast();
    }
  });

  socket.on('makeMove', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (room) {
      const color = room.getPlayerColor(socket.id);
      if (color) room.makeMove(row, col, color);
    }
  });

  socket.on('requestUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      const opp = room.getOpponent(socket.id);
      if (opp) io.to(opp.id).emit('undoRequest', {});
    }
  });

  socket.on('acceptUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.moveCount >= 2) {
      for (let i = 0; i < 2; i++) {
        for (let r = BOARD_SIZE - 1; r >= 0; r--)
          for (let c = BOARD_SIZE - 1; c >= 0; c--)
            if (room.board[r][c] !== null) {
              room.board[r][c] = null;
              room.moveCount--;
              break;
            }
      }
      room.winner = null;
      room.winningCells = [];
      room.isDraw = false;
      room.broadcast();
    }
  });

  socket.on('rejectUndo', ({ roomId }) => {
    io.to(roomId).emit('undoRejected');
  });

  socket.on('disconnect', () => {
    for (let [roomId, room] of rooms) {
      if (room.players.has(socket.id)) {
        io.to(roomId).emit('playerDisconnected', { message: '对手已断开' });
        room.removePlayer(socket.id);
        if (room.isEmpty()) rooms.delete(roomId);
        break;
      }
    }
  });
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('服务器已启动，端口:', PORT);
});