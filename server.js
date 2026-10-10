const express = require('express');

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
// In-memory storage
// ─────────────────────────────────────────────────────────────
// matches[code] = {
//     code: 'VCN-XXXXXX',
//     createdAt: timestamp,
//     createdBy: { userId, username, avatarUrl },
//     players: [{ userId, username, avatarUrl, joinedAt }],
//     status: 'waiting' | 'active' | 'finished',
//     gameState: 'white-turn' | 'black-turn' | 'white-won' | 'black-won' | 'draw',
//     board: initial 8x8 array,
//     moves: [],
//     lastActivity: timestamp
// }
const matches = {};

// Clean up old matches (older than 2 hours) every 15 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const code in matches) {
        if (now - matches[code].lastActivity > 2 * 60 * 60 * 1000) {
            delete matches[code];
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[cleanup] Removed ${cleaned} stale matches`);
}, 15 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 to avoid confusion

function generateCode() {
    let code = 'VCN-';
    for (let i = 0; i < 6; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
}

function generateUniqueCode() {
    let code;
    let attempts = 0;
    do {
        code = generateCode();
        attempts++;
        if (attempts > 100) throw new Error('Could not generate unique code');
    } while (matches[code] && matches[code].status !== 'finished');
    return code;
}

function publicMatchView(match) {
    return {
        code: match.code,
        status: match.status,
        createdAt: match.createdAt,
        players: match.players.map(p => ({
            userId: p.userId,
            username: p.username,
            avatarUrl: p.avatarUrl,
            joinedAt: p.joinedAt
        })),
        playerCount: match.players.length,
        gameState: match.gameState,
        moveCount: match.moves.length
    };
}

// ─────────────────────────────────────────────────────────────
// ROOT — info page
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        service: 'VCN Matchmaking Server',
        status: 'online',
        activeMatches: Object.keys(matches).length,
        endpoints: {
            createMatch: 'POST /create-match',
            joinMatch: 'POST /join-match',
            matchStatus: 'GET /match-status?code=VCN-XXXXXX',
            submitMove: 'POST /submit-move',
            getMoves: 'GET /get-moves?code=VCN-XXXXXX&since=0',
            finishMatch: 'POST /finish-match',
            listMatches: 'GET /list-matches'
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
        activeMatches: Object.keys(matches).length
    });
});

// ─────────────────────────────────────────────────────────────
// POST /create-match
// Body: { userId, username, avatarUrl }
// Returns: { code, match }
// ─────────────────────────────────────────────────────────────
app.post('/create-match', (req, res) => {
    const { userId, username, avatarUrl } = req.body;

    if (!username) {
        return res.status(400).json({ error: 'username required' });
    }

    try {
        const code = generateUniqueCode();
        const now = Date.now();

        matches[code] = {
            code,
            createdAt: now,
            createdBy: { userId: userId || 'unknown', username, avatarUrl: avatarUrl || '' },
            players: [{
                userId: userId || 'unknown',
                username,
                avatarUrl: avatarUrl || '',
                joinedAt: now
            }],
            status: 'waiting',
            gameState: 'white-turn',
            board: null,
            moves: [],
            lastActivity: now
        };

        console.log(`[create] ${username} created match ${code}`);

        res.json({
            success: true,
            code,
            match: publicMatchView(matches[code])
        });
    } catch (err) {
        console.error('[create] error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /join-match
// Body: { code, userId, username, avatarUrl }
// Returns: { success, match }
// ─────────────────────────────────────────────────────────────
app.post('/join-match', (req, res) => {
    const { code, userId, username, avatarUrl } = req.body;

    if (!code) return res.status(400).json({ error: 'code required' });
    if (!username) return res.status(400).json({ error: 'username required' });

    const normalizedCode = code.trim().toUpperCase();

    if (!matches[normalizedCode]) {
        return res.status(404).json({ error: 'Match not found' });
    }

    const match = matches[normalizedCode];

    if (match.status === 'finished') {
        return res.status(410).json({ error: 'Match already finished' });
    }

    if (match.players.length >= 2) {
        // Check if it's the same user rejoining
        const existing = match.players.find(p => p.userId === userId);
        if (!existing) {
            return res.status(409).json({ error: 'Match is full' });
        }
        // Same user, just return current state
        return res.json({ success: true, match: publicMatchView(match) });
    }

    // Check if user already in match
    const existing = match.players.find(p => p.userId === userId);
    if (existing) {
        return res.json({ success: true, match: publicMatchView(match) });
    }

    // Add second player
    match.players.push({
        userId: userId || 'unknown',
        username,
        avatarUrl: avatarUrl || '',
        joinedAt: Date.now()
    });
    match.lastActivity = Date.now();

    // Both players in → activate match
    if (match.players.length === 2) {
        match.status = 'active';
        match.gameState = 'white-turn';
        console.log(`[join] ${username} joined ${normalizedCode} — MATCH ACTIVE`);
    } else {
        console.log(`[join] ${username} joined ${normalizedCode}`);
    }

    res.json({
        success: true,
        match: publicMatchView(match)
    });
});

// ─────────────────────────────────────────────────────────────
// GET /match-status?code=VCN-XXXXXX&userId=abc
// Returns current match state
// ─────────────────────────────────────────────────────────────
app.get('/match-status', (req, res) => {
    const code = (req.query.code || '').trim().toUpperCase();
    const userId = req.query.userId || null;

    if (!code) return res.status(400).json({ error: 'code required' });
    if (!matches[code]) return res.status(404).json({ error: 'Match not found' });

    const match = matches[code];
    match.lastActivity = Date.now();

    const view = publicMatchView(match);
    if (userId) {
        view.isInMatch = match.players.some(p => p.userId === userId);
        view.yourColor = match.players[0] && match.players[0].userId === userId ? 'white'
                       : match.players[1] && match.players[1].userId === userId ? 'black'
                       : null;
    }

    res.json(view);
});

// ─────────────────────────────────────────────────────────────
// POST /submit-move
// Body: { code, userId, move: { from: [r,c], to: [r,c], ... } }
// ─────────────────────────────────────────────────────────────
app.post('/submit-move', (req, res) => {
    const { code, userId, move } = req.body;

    if (!code) return res.status(400).json({ error: 'code required' });
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!move) return res.status(400).json({ error: 'move required' });

    const normalizedCode = code.trim().toUpperCase();
    if (!matches[normalizedCode]) return res.status(404).json({ error: 'Match not found' });

    const match = matches[normalizedCode];
    match.lastActivity = Date.now();

    if (match.status !== 'active') {
        return res.status(409).json({ error: 'Match not active' });
    }

    // Verify user is in this match
    const playerIndex = match.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) {
        return res.status(403).json({ error: 'You are not in this match' });
    }

    // Verify it's this player's turn
    const playerColor = playerIndex === 0 ? 'white' : 'black';
    if (playerColor === 'white' && match.gameState !== 'white-turn') {
        return res.status(409).json({ error: 'Not your turn' });
    }
    if (playerColor === 'black' && match.gameState !== 'black-turn') {
        return res.status(409).json({ error: 'Not your turn' });
    }

    // Add move to list
    const moveRecord = {
        index: match.moves.length,
        playerId: userId,
        playerColor,
        move,
        at: Date.now()
    };
    match.moves.push(moveRecord);

    // Toggle turn
    match.gameState = playerColor === 'white' ? 'black-turn' : 'white-turn';

    console.log(`[move] ${normalizedCode} #${moveRecord.index} by ${playerColor}`);

    res.json({
        success: true,
        moveIndex: moveRecord.index,
        gameState: match.gameState,
        moveCount: match.moves.length
    });
});

// ─────────────────────────────────────────────────────────────
// GET /get-moves?code=VCN-XXXXXX&since=0
// Returns moves AFTER the `since` index
// ─────────────────────────────────────────────────────────────
app.get('/get-moves', (req, res) => {
    const code = (req.query.code || '').trim().toUpperCase();
    const since = parseInt(req.query.since) || 0;

    if (!code) return res.status(400).json({ error: 'code required' });
    if (!matches[code]) return res.status(404).json({ error: 'Match not found' });

    const match = matches[code];
    match.lastActivity = Date.now();

    const newMoves = match.moves.slice(since);

    res.json({
        code,
        status: match.status,
        gameState: match.gameState,
        moveCount: match.moves.length,
        moves: newMoves
    });
});

// ─────────────────────────────────────────────────────────────
// POST /finish-match
// Body: { code, result }  result = 'white-won' | 'black-won' | 'draw'
// ─────────────────────────────────────────────────────────────
app.post('/finish-match', (req, res) => {
    const { code, result } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });

    const normalizedCode = code.trim().toUpperCase();
    if (!matches[normalizedCode]) return res.status(404).json({ error: 'Match not found' });

    const match = matches[normalizedCode];
    match.status = 'finished';
    match.gameState = result || 'draw';
    match.lastActivity = Date.now();

    console.log(`[finish] ${normalizedCode} — ${match.gameState}`);

    res.json({ success: true, match: publicMatchView(match) });
});

// ─────────────────────────────────────────────────────────────
// GET /list-matches — shows all waiting matches (for debugging)
// ─────────────────────────────────────────────────────────────
app.get('/list-matches', (req, res) => {
    const list = Object.values(matches)
        .filter(m => m.status === 'waiting')
        .map(m => publicMatchView(m));
    res.json({ count: list.length, matches: list });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('=================================');
    console.log('  VCN MATCHMAKING SERVER ONLINE');
    console.log('  http://localhost:' + PORT);
    console.log('=================================');
    console.log('');
});
