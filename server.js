const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['polling', 'websocket']
});

// ==================== 数据库连接 ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-change-me';

// ==================== 自动建表 ====================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_url VARCHAR(255) DEFAULT '/default-avatar.png',
        rating INT DEFAULT 1000,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        draws INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ 数据库表已就绪');
  } catch (err) {
    console.error('❌ 数据库表初始化失败:', err);
  }
})();

// ==================== 中间件 ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 用户系统 API ====================

// 注册
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: '请填写所有字段' });
    }

    const exists = await pool.query(
      'SELECT id FROM users WHERE username=$1 OR email=$2',
      [username, email]
    );
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: '用户名或邮箱已被注册' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, rating, wins, losses, draws',
      [username, email, passwordHash]
    );

    const token = jwt.sign(
      { userId: result.rows[0].id, username: result.rows[0].username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: result.rows[0] });
  } catch (err) {
    console.error('注册错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '请填写用户名和密码' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE username=$1 OR email=$1',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
        rating: user.rating,
        wins: user.wins,
        losses: user.losses,
        draws: user.draws
      }
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 验证身份中间件
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: '未登录' });

  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// 获取当前用户信息
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, avatar_url, rating, wins, losses, draws FROM users WHERE id=$1',
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('获取用户信息错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 五子棋游戏逻辑 ====================
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
// 更新战绩
app.post('/api/update-stats', authMiddleware, async (req, res) => {
  try {
    const { result } = req.body; // 'win' | 'loss' | 'draw'
    const userId = req.user.userId;

    if (result === 'win') {
      await pool.query(
        'UPDATE users SET wins = wins + 1, rating = rating + 25 WHERE id = $1',
        [userId]
      );
    } else if (result === 'loss') {
      await pool.query(
        'UPDATE users SET losses = losses + 1, rating = GREATEST(0, rating - 15) WHERE id = $1',
        [userId]
      );
    } else if (result === 'draw') {
      await pool.query(
        'UPDATE users SET draws = draws + 1, rating = rating + 5 WHERE id = $1',
        [userId]
      );
    }

    // 返回更新后的数据
    const updated = await pool.query(
      'SELECT rating, wins, losses, draws FROM users WHERE id = $1',
      [userId]
    );

    res.json({ stats: updated.rows[0] });
  } catch (err) {
    console.error('更新战绩错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('服务器已启动，端口:', PORT);
});