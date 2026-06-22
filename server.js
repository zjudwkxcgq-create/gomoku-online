const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.IO 配置（Vercel 需要特殊配置）
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // Vercel 不支持 WebSocket 长连接，使用轮询模式
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 存储房间信息
const rooms = new Map();

// 游戏常量
const BOARD_SIZE = 15;
const INITIAL_TIME = 600;

class GameRoom {
  constructor(roomId, isPrivate = false) {
    this.roomId = roomId;
    this.isPrivate = isPrivate;
    this.players = new Map();
    this.board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(null));
    this.currentPlayer = 'black';
    this.winner = null;
    this.winningCells = [];
    this.moveCount = 0;
    this.isDraw = false;
    this.gameStarted = false;
    this.undoRequest = null;
    this.timers = {
      black: INITIAL_TIME,
      white: INITIAL_TIME
    };
    this.timerInterval = null;
  }

  addPlayer(socket, color) {
    this.players.set(socket.id, {
      color: color,
      socket: socket
    });
    socket.join(this.roomId);
  }

  getPlayerCount() {
    return this.players.size;
  }

  getOpponent(socketId) {
    for (let [id, player] of this.players) {
      if (id !== socketId) return { id, ...player };
    }
    return null;
  }

  getPlayerColor(socketId) {
    const player = this.players.get(socketId);
    return player ? player.color : null;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
  }

  isEmpty() {
    return this.players.size === 0;
  }

  startGame() {
    if (this.players.size === 2 && !this.gameStarted) {
      this.gameStarted = true;
      this.startTimer();
      return true;
    }
    return false;
  }

  startTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    this.timerInterval = setInterval(() => {
      if (this.winner || this.isDraw) {
        clearInterval(this.timerInterval);
        return;
      }
      
      this.timers[this.currentPlayer]--;
      
      if (this.timers[this.currentPlayer] <= 0) {
        this.timers[this.currentPlayer] = 0;
        this.winner = this.currentPlayer === 'black' ? 'white' : 'black';
        clearInterval(this.timerInterval);
        this.broadcastGameState();
      }
      
      this.broadcastTimerUpdate();
    }, 1000);
  }

  checkWin(row, col, player) {
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    
    for (let [dx, dy] of directions) {
      let cells = [[row, col]];
      
      for (let step = 1; step < 5; step++) {
        const r = row + dx * step;
        const c = col + dy * step;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) {
          cells.push([r, c]);
        } else break;
      }
      for (let step = 1; step < 5; step++) {
        const r = row - dx * step;
        const c = col - dy * step;
        if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && this.board[r][c] === player) {
          cells.unshift([r, c]);
        } else break;
      }
      
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  isBoardFull() {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (this.board[r][c] === null) return false;
      }
    }
    return true;
  }

  makeMove(row, col, player) {
    if (this.board[row][col] !== null || this.winner || this.isDraw) return false;
    if (this.currentPlayer !== player) return false;
    
    this.board[row][col] = player;
    this.moveCount++;
    
    const winResult = this.checkWin(row, col, player);
    if (winResult) {
      this.winner = player;
      this.winningCells = winResult;
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.broadcastGameState();
      return true;
    }
    
    if (this.isBoardFull()) {
      this.isDraw = true;
      if (this.timerInterval) clearInterval(this.timerInterval);
      this.broadcastGameState();
      return true;
    }
    
    this.currentPlayer = this.currentPlayer === 'black' ? 'white' : 'black';
    this.undoRequest = null;
    this.broadcastGameState();
    return true;
  }

  requestUndo(socketId) {
    const playerColor = this.getPlayerColor(socketId);
    if (!playerColor || this.winner || this.isDraw) return false;
    
    if (this.currentPlayer === playerColor) return false;
    
    this.undoRequest = { from: socketId, fromColor: playerColor };
    this.broadcastUndoRequest(socketId);
    return true;
  }

  acceptUndo() {
    if (!this.undoRequest || this.moveCount < 2) return false;
    
    for (let i = 0; i < 2 && this.moveCount > 0; i++) {
      let lastMove = null;
      for (let r = BOARD_SIZE - 1; r >= 0 && !lastMove; r--) {
        for (let c = BOARD_SIZE - 1; c >= 0 && !lastMove; c--) {
          if (this.board[r][c] !== null) {
            lastMove = { row: r, col: c };
          }
        }
      }
      if (lastMove) {
        this.board[lastMove.row][lastMove.col] = null;
        this.moveCount--;
      }
    }
    
    this.currentPlayer = this.undoRequest.fromColor;
    this.undoRequest = null;
    this.winner = null;
    this.winningCells = [];
    this.isDraw = false;
    this.broadcastGameState();
    return true;
  }

  rejectUndo() {
    this.undoRequest = null;
    this.broadcastUndoRejected();
  }

  broadcastGameState() {
    const gameState = {
      board: this.board,
      currentPlayer: this.currentPlayer,
      winner: this.winner,
      winningCells: this.winningCells,
      moveCount: this.moveCount,
      isDraw: this.isDraw,
      timers: this.timers,
      gameStarted: this.gameStarted
    };
    io.to(this.roomId).emit('gameState', gameState);
  }

  broadcastTimerUpdate() {
    io.to(this.roomId).emit('timerUpdate', this.timers);
  }

  broadcastUndoRequest(fromSocketId) {
    const opponent = this.getOpponent(fromSocketId);
    if (opponent) {
      io.to(opponent.id).emit('undoRequest', {
        from: this.getPlayerColor(fromSocketId)
      });
    }
  }

  broadcastUndoRejected() {
    io.to(this.roomId).emit('undoRejected');
  }

  broadcastPlayerDisconnected(socketId) {
    const color = this.getPlayerColor(socketId);
    io.to(this.roomId).emit('playerDisconnected', {
      color: color,
      message: `对手已断开连接`
    });
  }

  cleanup() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.players.clear();
  }
}

// 匹配队列
let matchingQueue = null;

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  socket.on('createPrivateRoom', () => {
    const roomId = uuidv4().substring(0, 8).toUpperCase();
    const room = new GameRoom(roomId, true);
    rooms.set(roomId, room);
    
    socket.emit('privateRoomCreated', { roomId });
    console.log(`私人房间创建: ${roomId}`);
  });

  socket.on('joinPrivateRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }
    
    if (room.getPlayerCount() >= 2) {
      socket.emit('error', { message: '房间已满' });
      return;
    }
    
    const existingPlayer = room.players.values().next().value;
    const color = existingPlayer ? (existingPlayer.color === 'black' ? 'white' : 'black') : 'black';
    
    room.addPlayer(socket, color);
    
    socket.emit('joinedRoom', {
      roomId,
      color,
      isPrivate: true
    });
    
    if (room.getPlayerCount() === 2) {
      room.startGame();
      room.broadcastGameState();
      
      room.players.forEach((player, id) => {
        io.to(id).emit('gameStart', {
          color: player.color,
          opponent: room.getOpponent(id)?.color
        });
      });
    }
  });

  socket.on('joinMatchmaking', ({ color }) => {
    if (matchingQueue) {
      const roomId = uuidv4().substring(0, 8).toUpperCase();
      const room = new GameRoom(roomId, false);
      rooms.set(roomId, room);
      
      const opponentColor = color === 'black' ? 'white' : 'black';
      
      room.addPlayer(socket, color);
      room.addPlayer(matchingQueue.socket, opponentColor);
      
      socket.emit('matchFound', {
        roomId,
        color,
        opponent: opponentColor
      });
      
      matchingQueue.socket.emit('matchFound', {
        roomId,
        color: opponentColor,
        opponent: color
      });
      
      room.startGame();
      room.broadcastGameState();
      
      matchingQueue = null;
    } else {
      matchingQueue = { socket, color };
      socket.emit('matching', { message: '正在寻找对手...' });
    }
  });

  socket.on('cancelMatchmaking', () => {
    if (matchingQueue && matchingQueue.socket.id === socket.id) {
      matchingQueue = null;
      socket.emit('matchCancelled');
    }
  });

  socket.on('makeMove', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const playerColor = room.getPlayerColor(socket.id);
    if (!playerColor) return;
    
    room.makeMove(row, col, playerColor);
  });

  socket.on('requestUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.requestUndo(socket.id);
  });

  socket.on('acceptUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.acceptUndo();
  });

  socket.on('rejectUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.rejectUndo();
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.broadcastPlayerDisconnected(socket.id);
    room.removePlayer(socket.id);
    socket.leave(roomId);
    
    if (room.isEmpty()) {
      room.cleanup();
      rooms.delete(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('用户断开:', socket.id);
    
    if (matchingQueue && matchingQueue.socket.id === socket.id) {
      matchingQueue = null;
    }
    
    for (let [roomId, room] of rooms) {
      if (room.players.has(socket.id)) {
        room.broadcastPlayerDisconnected(socket.id);
        room.removePlayer(socket.id);
        
        if (room.isEmpty()) {
          room.cleanup();
          rooms.delete(roomId);
        }
        break;
      }
    }
  });
});

// 路由处理
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// 导出给 Vercel
module.exports = app;

// 本地开发时启动服务器
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🎮 五子棋服务器运行在 http://localhost:${PORT}`);
  });
}