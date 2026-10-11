const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const MIN_STAKE = 100;
const MAX_STAKE = 10000;
const ALLOWED_STAKES = [100, 250, 500, 1000, 2500, 5000, 10000];

// How long a draw offer stays valid before auto-expiring (30s)
const DRAW_OFFER_TTL_MS = 30 * 1000;

// Queue: [{ userId, username, avatarUrl, timeControl, stake, joinedQueueAt }]
const queue = [];
const matches = {};
const userToMatch = {};

// Cleanup every 5 min
setInterval(() => {
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].joinedQueueAt > 5 * 60 * 1000) queue.splice(i, 1);
    }
    for (const code in matches) {
        const m = matches[code];
        if (m.status === 'finished' && now - m.lastActivity > 60 * 60 * 1000) {
            m.players.forEach(p => delete userToMatch[p.userId]);
            delete matches[code];
        } else if (now - m.lastActivity > 2 * 60 * 60 * 1000) {
            m.players.forEach(p => delete userToMatch[p.userId]);
            delete matches[code];
        }
    }
}, 5 * 60 * 1000);

function generateSecretCode() {
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
        stake: match.stake,
        pot: match.stake * 2,
        myColor,
        players: match.players.map(p => ({
            userId: p.userId,
            username: p.username,
            avatarUrl: p.avatarUrl
        }))
    };
}

// ─────────────────────────────────────────────────────────────
// ROOT + HEALTH
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        service: 'VCN Random Matchmaking Server',
        status: 'online',
        version: '2.0.0',
        config: { minStake: MIN_STAKE, maxStake: MAX_STAKE, allowedStakes: ALLOWED_STAKES },
        queuedPlayers: queue.length,
        activeMatches: Object.keys(matches).length,
        endpoints: {
            findMatch: 'POST /find-match',
            cancelSearch: 'POST /cancel-search',
            matchStatus: 'GET /match-status?userId=X',
            submitMove: 'POST /submit-move',
            getMoves: 'POST /get-moves',
            finishMatch: 'POST /finish-match',
            leaveMatch: 'POST /leave-match',
            offerDraw: 'POST /offer-draw',
            respondDraw: 'POST /respond-draw',
            clearDraw: 'POST /clear-draw',
            health: 'GET /health'
        }
    });
});

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
// MATCHMAKING
// ─────────────────────────────────────────────────────────────

// POST /find-match
// Body: { userId, username, avatarUrl, timeControl, stake }
app.post('/find-match', (req, res) => {
    const { userId, username, avatarUrl, timeControl, stake } = req.body;

    if (!userId || !username) return res.status(400).json({ error: 'userId and username required' });

    // Validate stake
    const stakeNum = parseInt(stake);
    if (!stakeNum || stakeNum < MIN_STAKE) {
        return res.status(400).json({ error: `Minimum stake is ${MIN_STAKE} R$` });
    }
    if (stakeNum > MAX_STAKE) {
        return res.status(400).json({ error: `Maximum stake is ${MAX_STAKE} R$` });
    }

    // Already in a match?
    if (userToMatch[userId]) {
        const existing = matches[userToMatch[userId]];
        if (existing && existing.status !== 'finished') {
            return res.json({ status: 'matched', match: publicMatchView(existing, userId) });
        }
        delete userToMatch[userId];
    }

    // Remove from queue if already there (re-queue fresh)
    const existingIdx = queue.findIndex(p => p.userId === userId);
    if (existingIdx !== -1) queue.splice(existingIdx, 1);

    const tc = timeControl || 600;

    // Look for opponent with SAME timeControl AND SAME stake
    const opponentIdx = queue.findIndex(p => p.timeControl === tc && p.stake === stakeNum);

    if (opponentIdx === -1) {
        queue.push({
            userId,
            username,
            avatarUrl: avatarUrl || '',
            timeControl: tc,
            stake: stakeNum,
            joinedQueueAt: Date.now()
        });
        console.log(`[queue] ${username} waiting (${tc}s / ${stakeNum} R$) — ${queue.length} in queue`);
        return res.json({ status: 'searching' });
    }

    // Match found
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
        timeControl: tc,
        stake: stakeNum,
        drawOffer: null
    };

    userToMatch[opponent.userId] = secretCode;
    userToMatch[userId] = secretCode;

    console.log(`[match] ${opponent.username} vs ${username} — ${stakeNum} R$ each — pot ${stakeNum * 2} R$`);

    res.json({
        status: 'matched',
        match: publicMatchView(matches[secretCode], userId)
    });
});

// POST /cancel-search
app.post('/cancel-search', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const idx = queue.findIndex(p => p.userId === userId);
    if (idx !== -1) queue.splice(idx, 1);
    res.json({ success: true });
});

// GET /match-status?userId=X
app.get('/match-status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const inQueue = queue.some(p => p.userId === userId);
    const code = userToMatch[userId];

    if (code && matches[code]) {
        const match = matches[code];
        match.lastActivity = Date.now();
        return res.json({ status: 'matched', match: publicMatchView(match, userId) });
    }
    if (inQueue) return res.json({ status: 'searching' });
    return res.json({ status: 'idle' });
});

// ─────────────────────────────────────────────────────────────
// MOVES
// ─────────────────────────────────────────────────────────────

// POST /submit-move
app.post('/submit-move', (req, res) => {
    const { userId, move } = req.body;
    if (!userId || !move) return res.status(400).json({ error: 'userId and move required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    match.lastActivity = Date.now();

    if (match.status !== 'active') return res.status(409).json({ error: 'Match not active' });

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

    res.json({
        success: true,
        moveIndex: moveRecord.index,
        gameState: match.gameState,
        moveCount: match.moves.length
    });
});

// POST /get-moves
app.post('/get-moves', (req, res) => {
    const { userId, since } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    match.lastActivity = Date.now();

    const sinceIdx = parseInt(since) || 0;
    const newMoves = match.moves.slice(sinceIdx);
    const opponentMoves = newMoves.filter(m => m.playerId !== userId);

    // Draw offer: only surface to the OTHER player, and auto-expire stale ones
    let drawOfferFrom = null;
    if (match.drawOffer) {
        const age = Date.now() - match.drawOffer.offeredAt;
        if (age > DRAW_OFFER_TTL_MS) {
            match.drawOffer = null;
        } else if (match.drawOffer.fromUserId !== userId) {
            drawOfferFrom = {
                username: match.drawOffer.fromUsername,
                offeredAt: match.drawOffer.offeredAt,
                expiresInMs: DRAW_OFFER_TTL_MS - age
            };
        }
    }

    res.json({
        status: match.status,
        gameState: match.gameState,
        moveCount: match.moves.length,
        moves: opponentMoves,
        drawOfferFrom
    });
});

// ─────────────────────────────────────────────────────────────
// DRAW OFFER
// ─────────────────────────────────────────────────────────────

// POST /offer-draw — body: { userId }
app.post('/offer-draw', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    if (match.status !== 'active') return res.status(409).json({ error: 'Match not active' });

    const playerIndex = match.players.findIndex(p => p.userId === userId);
    if (playerIndex === -1) return res.status(403).json({ error: 'Not in match' });

    match.lastActivity = Date.now();
    match.drawOffer = {
        fromUserId: userId,
        fromUsername: match.players[playerIndex].username,
        offeredAt: Date.now()
    };

    console.log(`[draw] ${match.players[playerIndex].username} offers draw in ${code.slice(0, 8)}…`);
    res.json({ success: true });
});

// POST /respond-draw — body: { userId, accept }
app.post('/respond-draw', (req, res) => {
    const { userId, accept } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (typeof accept !== 'boolean') return res.status(400).json({ error: 'accept (boolean) required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    if (match.status !== 'active') return res.status(409).json({ error: 'Match not active' });

    if (!match.drawOffer) return res.status(409).json({ error: 'No pending draw offer' });

    if (match.drawOffer.fromUserId === userId) {
        return res.status(400).json({ error: 'Cannot respond to your own draw offer' });
    }

    // Auto-expired?
    if (Date.now() - match.drawOffer.offeredAt > DRAW_OFFER_TTL_MS) {
        match.drawOffer = null;
        return res.status(410).json({ error: 'Draw offer expired' });
    }

    match.lastActivity = Date.now();

    if (accept) {
        match.status = 'finished';
        match.gameState = 'draw';
        match.drawOffer = null;
        match.players.forEach(p => delete userToMatch[p.userId]);
        console.log(`[draw] Match ${code.slice(0, 8)}… ended in draw (both players agreed)`);
        return res.json({ success: true, result: 'draw', stake: match.stake, pot: match.stake * 2 });
    }

    // Declined
    match.drawOffer = null;
    console.log(`[draw] Draw declined in ${code.slice(0, 8)}…`);
    res.json({ success: true, result: 'declined' });
});

// POST /clear-draw — body: { userId }
// Lets the offerer cancel their own pending offer
app.post('/clear-draw', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (code && matches[code]) {
        const match = matches[code];
        if (match.drawOffer && match.drawOffer.fromUserId === userId) {
            match.drawOffer = null;
            match.lastActivity = Date.now();
        }
    }
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// MATCH END
// ─────────────────────────────────────────────────────────────

// POST /finish-match — body: { userId, result }
app.post('/finish-match', (req, res) => {
    const { userId, result } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (!code || !matches[code]) return res.status(404).json({ error: 'No active match' });

    const match = matches[code];
    if (match.status === 'finished') {
        return res.json({ success: true, result: match.gameState, pot: match.stake * 2, stake: match.stake });
    }

    match.status = 'finished';
    match.gameState = result || 'draw';
    match.drawOffer = null;
    match.lastActivity = Date.now();

    console.log(`[finish] Match ${match.gameState} — pot was ${match.stake * 2} R$`);

    res.json({
        success: true,
        result: match.gameState,
        pot: match.stake * 2,
        stake: match.stake
    });
});

// POST /leave-match
app.post('/leave-match', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const code = userToMatch[userId];
    if (code && matches[code]) {
        const match = matches[code];
        // Only forfeit if the match was still active
        if (match.status === 'active') {
            match.status = 'finished';
            // The OTHER player wins by forfeit
            const opponentIdx = match.players.findIndex(p => p.userId !== userId);
            if (opponentIdx !== -1) {
                match.gameState = opponentIdx === 0 ? 'white-won' : 'black-won';
            } else {
                match.gameState = 'draw';
            }
        }
        match.drawOffer = null;
        match.players.forEach(p => delete userToMatch[p.userId]);
    }
    const idx = queue.findIndex(p => p.userId === userId);
    if (idx !== -1) queue.splice(idx, 1);

    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// 404 + ERROR
// ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
});

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('');
    console.log('=================================');
    console.log('  VCN RANDOM MATCHMAKING ONLINE');
    console.log('  Min stake: ' + MIN_STAKE + ' R$');
    console.log('  Max stake: ' + MAX_STAKE + ' R$');
    console.log('  Draw offer TTL: ' + (DRAW_OFFER_TTL_MS / 1000) + 's');
    console.log('=================================');
    console.log('');
});
