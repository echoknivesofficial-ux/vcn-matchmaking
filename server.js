const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
// queue: players waiting to be matched
// queue = [{ userId, username, avatarUrl, timeControl, joinedQueueAt }]
const queue = [];

// matches: active matches
// matches[secretCode] = { code, players, gameState, moves, status, ... }
const matches = {};

// userToMatch: userId → secretCode (so we can find the match quickly)
const userToMatch = {};

// Cleanup stale entries every 5 minutes
setInterval(() => {
    const now = Date.now();

    // Remove players stuck in queue for more than 5 minutes
    for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].joinedQueueAt > 5 * 60 * 1000) {
            console.log(`[cleanup] Removing stale queued player ${queue[i].username}`);
            queue.splice(i, 1);
        }
    }

    // Remove finished matches older than 1 hour
    for (const code in matches) {
        if (matches[code].status === 'finished' && now - matches[code].lastActivity > 60 * 60 * 1000) {
            const players = matches[code].players.map(p => p.userId);
            players.forEach(id => delete userToMatch[id]);
            delete matches[code];
        }
    }

    // Remove matches with no activity for 2 hours
    for (const code in matches) {
        if (now - matches[code].lastActivity > 2 * 60 * 60 * 1000) {
            const players = matches[code].players.map(p => p.userId);
            players.forEach(id => delete userToMatch[id]);
            delete matches[code];
        }
    }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function generateSecretCode() {
    // 48-char hex (192 bits of entropy) — impossible to guess
    return crypto.randomBytes(24).toString('hex');
}

function publicMatchView(match, forUserId) {
    const myIndex = forUserId ? match.players.findIndex(p => p.userId === forUserId) : -1;
    const myColor = myIndex === 0 ? 'white' : (myIndex === 1 ? 'black' : null);
    return {
        status: match.status,
        createdAt: match.createdAt,
        gameState: match.gameState,
        playerCount: match.players.length,
        moveCount: match.moves.length,
        timeControl: match.timeControl,
        myColor,
        players: match.players.map(p => ({
            userId: p.userId,
            username: p.username,
            avatarUrl: p.avatarUrl
        }))
    };
}

// ─────────────────────────────────────────────────────────────
// ROOT — info page
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        service: 'VCN Random Matchmaking Server',
        status: 'online',
        queuedPlayers: queue.length,
        activeMatches: Object.keys(matches).length,
        endpoints: {
            findMatch: 'POST /find-match',
            cancelSearch: 'POST /cancel-search',
            matchStatus: 'GET /match-status?userId=X',
            submitMove: 'POST /submit-move',
            getMoves: 'POST /get-moves',
            finishMatch: 'POST /finish-match',
            health: 'GET /health'
        }
    });
});

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        uptime: process.uptime(),
        queuedPlayers: queue.length,
        activeMatches: Object.keys(matches).length
    });
});

// ─────────────────────────────────────────────────────────────
// POST /find-match
// Body: { userId, username, avatarUrl, timeControl }
// Response: { status: 'searching' } or { status: 'matched', match }
// ─────────────────────────────────────────────────────────────
app.post('/find-match', (req, res) => {
    const { userId, username, avatarUrl, timeControl } = req.body;

    if (!userId || !username) {
        return res.status(400).json({ error: 'userId and username required' });
    }

    // If already in a match, return it
    if (userToMatch[userId]) {
        const existing = matches[userToMatch[userId]];
        if (existing && existing.status !== 'finished') {
            return res.json({
                status: 'matched',
                match: publicMatchView(existing, userId)
            });
        }
        // Clean up stale reference
        delete userToMatch[userId];
    }

    // If already in queue, remove old entry (re-queue with fresh timestamp)
    const existingQueueIdx = queue.findIndex(p => p.userId === userId);
    if (existingQueueIdx !== -1) {
        queue.splice(existingQueueIdx, 1);
    }

    // Look for another waiting player with the SAME time control
    const tc = timeControl || 600;
    const opponentIdx = queue.findIndex(p => p.timeControl === tc);

    if (opponentIdx === -1) {
        // No match — add to queue
        queue.push({
            userId,
            username,
            avatarUrl: avatarUrl || '',
            timeControl: tc,
            joinedQueueAt: Date.now()
        });
        console.log(`[queue] ${username} waiting (${queue.length} in queue)`);
        return res.json({ status: 'searching' });
    }

    // Match found! Remove from queue and create match
    const opponent = queue.splice(opponentIdx, 1)[0];
    const secretCode = generateSecretCode();
    const now = Date.now();

    matches[secretCode] = {
        code: secretCode,
        createdAt: now,
        lastActivity: now,
        players: [
            { userId: opponent.userId, username: opponent.username, avatarUrl: opponent.avatarUrl, joinedAt: now },
            { userId, username, avatarUrl: avatarUrl || '', joinedAt: now }
        ],
        status: 'active',
        gameState: 'white-turn',
        moves: [],
        timeControl: tc
    };

    userToMatch[opponent.userId] = secretCode;
    userToMatch[userId] = secretCode;

    console.log(`[match] ${opponent.username} vs ${username} — started`);

    res.json({
        status: 'matched',
        match: publicMatchView(matches[secretCode], userId)
    });
});

// ─────────────────────────────────────────────────────────────
// POST /cancel-search
// Body: { userId }
// ─────────────────────────────────────────────────────────────
app.post('/cancel-search', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const idx = queue.findIndex(p => p.userId === userId);
    if (idx !== -1) {
        queue.splice(idx, 1);
        console.log(`[queue] Removed ${userId} from queue`);
    }
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// GET /match-status?userId=X
// Player polls this to know if they've been matched
// ─────────────────────────────────────────────────────────────
app.get('/match-status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // In queue?
    const inQueue = queue.some(p => p.userId === userId);

    // In active match?
    const code = userToMatch[userId];
    if (code && matches[code]) {
        const match = matches[code];
        match.lastActivity = Date.now();
        return res.json({
            status: 'matched',
            match: publicMatchView(match, userId)
        });
    }

    if (inQueue) {
        return res.json({ status: 'searching' });
    }

    return res.json({ status: 'idle' });
});

// ─────────────────────────────────────────────────────────────
// POST /submit-move
// Body: { userId, move }
// ─────────────────────────────────────────────────────────────
app.post('/submit-move', (req, res) => {
    const { userId, move } = req.body;
    if (!userId || !move) return res.status(400).json({ error: 'userId and move required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    match.lastActivity = Date.now();

    if (match.status !== 'active') {
        return res.status(409).json({ error: 'Match not active' });
    }

    const playerIndex = match.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) return res.status(403).json({ error: 'Not in match' });

    const playerColor = playerIndex === 0 ? 'white' : 'black';
    if (playerColor === 'white' && match.gameState !== 'white-turn') {
        return res.status(409).json({ error: 'Not your turn' });
    }
    if (playerColor === 'black' && match.gameState !== 'black-turn') {
        return res.status(409).json({ error: 'Not your turn' });
    }

    const moveRecord = {
        index: match.moves.length,
        playerId: userId,
        playerColor,
        move,
        at: Date.now()
    };
    match.moves.push(moveRecord);
    match.gameState = playerColor === 'white' ? 'black-turn' : 'white-turn';

    console.log(`[move] ${playerColor} moved (index ${moveRecord.index})`);

    res.json({
        success: true,
        moveIndex: moveRecord.index,
        gameState: match.gameState,
        moveCount: match.moves.length
    });
});

// ─────────────────────────────────────────────────────────────
// POST /get-moves
// Body: { userId, since }
// ─────────────────────────────────────────────────────────────
app.post('/get-moves', (req, res) => {
    const { userId, since } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    match.lastActivity = Date.now();

    const sinceIdx = parseInt(since) || 0;
    const newMoves = match.moves.slice(sinceIdx);

    // Filter out the player's own moves (they already applied them)
    const opponentMoves = newMoves.filter(m => m.playerId !== userId);

    res.json({
        status: match.status,
        gameState: match.gameState,
        moveCount: match.moves.length,
        moves: opponentMoves
    });
});

// ─────────────────────────────────────────────────────────────
// POST /finish-match
// Body: { userId, result }
// ─────────────────────────────────────────────────────────────
app.post('/finish-match', (req, res) => {
    const { userId, result } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    match.status = 'finished';
    match.gameState = result || 'draw';
    match.lastActivity = Date.now();

    console.log(`[finish] Match ended: ${match.gameState}`);

    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// POST /leave-match
// Body: { userId }
// Call this when a player exits mid-game
// ─────────────────────────────────────────────────────────────
app.post('/leave-match', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (code && matches[code]) {
        matches[code].status = 'finished';
        matches[code].gameState = 'draw';
        const players = matches[code].players.map(p => p.userId);
        players.forEach(id => delete userToMatch[id]);
    }

    // Also remove from queue
    const idx = queue.findIndex(p => p.userId === userId);
    if (idx !== -1) queue.splice(idx, 1);

    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('=================================');
    console.log('  VCN RANDOM MATCHMAKING ONLINE');
    console.log('  http://localhost:' + PORT);
    console.log('=================================');
    console.log('');
});
