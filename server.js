const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
let port = 3000;
let isOfficial = false;
let ngrokToken = null;
let tunnelAddress = null;

const VERCEL_API_URL = "https://server-list-orpin.vercel.app/api";

for (let i = 0; i < args.length; i++) {
    if (args[i] === '-port' && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
    }
    if (args[i] === '-official') {
        if (args[i + 1] === 'false' || args[i + 1] === '0') {
            isOfficial = false;
        } else {
            isOfficial = true;
        }
    }
    if (args[i] === '-ngrok' && args[i + 1]) {
        ngrokToken = args[i + 1];
    }
    if (args[i] === '-tunnel' && args[i + 1]) {
        tunnelAddress = args[i + 1];
    }
}

const WORLD_TILES = 64;
const FOOD_COUNT  = 30;
const COIN_COUNT  = 15;
const APPLE_COUNT = 3;
const STATE_RATE  = 50;
const FOOD_RATE   = 200;
const COIN_RATE   = 3000;
const APPLE_RATE  = 15000;

let nextId = 1;
let heartbeatInterval = null;
let ngrokListener = null;

const players = new Map();
const foods   = [];
const coins   = [];
const apples  = [];

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'players.json');
let accounts = {};
try {
    if (fs.existsSync(ACCOUNTS_FILE)) accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) || {};
} catch (err) {
    console.error('[Accounts] Could not load players.json:', err.message);
    accounts = {};
}
function saveAccounts() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), 'utf8');
    fs.renameSync(tmp, ACCOUNTS_FILE);
}
function sendProfile(player) {
    if (!player.account) return;
    send(player.ws, {
        type: 'profile',
        coins: player.account.coins,
        unlockedSkins: player.account.unlockedSkins || '',
        currentSkinId: player.account.currentSkinId || 'bright_green'
    });
}
function validUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function log(msg) { const ts = new Date().toISOString().substring(11, 23); console.log(`[${ts}] ${msg}`); }
function randomTile() { return { x: Math.floor(Math.random() * WORLD_TILES), y: Math.floor(Math.random() * WORLD_TILES) }; }
function pickRarity() { const r = Math.random() * 100; if (r < 2) return 3; if (r < 10) return 2; if (r < 30) return 1; return 0; }
function spawnFood()  { const { x, y } = randomTile(); foods.push({ x, y, rarity: pickRarity() }); }
function spawnCoin()  { const { x, y } = randomTile(); coins.push({ x, y }); }
function randomFreeTile() {
    for (let attempt = 0; attempt < 500; attempt++) {
        const pos = randomTile();
        const occupied = foods.some(v => v.x === pos.x && v.y === pos.y) ||
            coins.some(v => v.x === pos.x && v.y === pos.y) ||
            apples.some(v => v.x === pos.x && v.y === pos.y) ||
            [...players.values()].some(p => p.alive && p.body.some(seg => seg[0] === pos.x && seg[1] === pos.y));
        if (!occupied) return pos;
    }
    return randomTile();
}
function spawnApple() { const { x, y } = randomFreeTile(); apples.push({ x, y }); }
function ensureFoods() { while (foods.length < FOOD_COUNT) spawnFood(); }
function ensureCoins() { while (coins.length < COIN_COUNT) spawnCoin(); }
function ensureApples() { while (apples.length < APPLE_COUNT) spawnApple(); }
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj, excludeId = -1) {
    const msg = JSON.stringify(obj);
    players.forEach(p => { if (p.id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); });
}
function broadcastAll(obj) { const msg = JSON.stringify(obj); players.forEach(p => { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg); }); }

function buildStatePayload() {
    const plist = [];
    players.forEach(p => plist.push({ id: p.id, name: p.name, skin: p.skin, body: p.body, dir: p.dir, alive: p.alive }));
    return { type: 'state', players: plist };
}

function checkPlayerCollisions(moverId, hx, hy) {
    for (const [id, p] of players) {
        if (!p.alive) continue;
        for (let i = 1; i < p.body.length; i++)
            if (p.body[i][0] === hx && p.body[i][1] === hy) return p;
    }
    return null;
}

function checkFoodEaten(hx, hy) { for (let i = 0; i < foods.length; i++) if (foods[i].x === hx && foods[i].y === hy) return i; return -1; }
function checkCoinEaten(hx, hy) { for (let i = 0; i < coins.length; i++) if (coins[i].x === hx && coins[i].y === hy) return i; return -1; }

function broadcastFoods() { broadcastAll({ type: 'foods', foods: foods.map(f => [f.x, f.y, f.rarity]) }); }
function broadcastCoins() { broadcastAll({ type: 'coin_spawn', coins: coins.map(c => [c.x, c.y]) }); }
function broadcastApples() { broadcastAll({ type: 'apple_spawn', apples: apples.map(a => [a.x, a.y]) }); }

function killPlayer(id, killer, reason) {
    const p = players.get(id); if (!p) return;
    p.alive = false;
    const killerName = killer ? killer.name : '';
    log(`${p.name}${killerName ? ' was killed by ' + killerName : ' died (' + reason + ')'}`);
    broadcastAll({ type: 'player_died', id, killer: killerName });
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sneaky Snakes dedicated network server is Active.n0n0\n');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\x1b[31mThere's already a server running on port (${port}).\x1b[0m`);
        process.exit(1);
    } else {
        console.error(`Server Error:`, err.message);
    }
});

const wss = new WebSocket.Server({ server });

ensureFoods();
ensureCoins();
ensureApples();

// ─── Função de registro na API Vercel ───────────────────────────────────────
const registerServer = async (host,targetPort) => {
    try{
        const response = await axios.post(
            `${VERCEL_API_URL}/register`,
            {
                host: host,
                port: targetPort,
                secure: targetPort == 443 || targetPort === '443',
                name: `Official Server @ ${host}:${targetPort}`,
                timestamp: Date.now()
            }
        );

console.log("Status:", response.status);
console.log("Resposta:", response.data);

log(`\x1b[32m[API Vercel] Heartbeat enviado para ${host}:${targetPort}\x1b[0m`);
    }catch(error){
        log(`\x1b[31m[API Vercel] Erro ao registrar: ${error.message}\x1b[0m`);
    }
};

server.listen(port, async () => {
    log(`Starting network server on port ${port}...`);
    log(`World: ${WORLD_TILES}x${WORLD_TILES} | Food: ${FOOD_COUNT} | Coins: ${COIN_COUNT}`);

    let publicHost = 'localhost';
    let publicPort = port;

    if (ngrokToken) {
        try {

            const ngrok = require('@ngrok/ngrok');

            ngrokListener = await ngrok.connect({
                proto: 'http',
                addr: port,
                authtoken: ngrokToken,
            });
            const url = ngrokListener.url();
            const withoutProto = url.replace('https://', '').replace('http://', '');
            publicHost = withoutProto;
            publicPort = '443'; // HTTPS/WSS usa port 443

            log(`\x1b[32mTunnel active: \x1b[1m${url}\x1b[0m`);
            log(`\x1b[32mPlayers should join in: \x1b[1mwss://${withoutProto}\x1b[0m`);

        } catch (err) {
            log(`\x1b[31mError${err.message}\x1b[0m`);
            log(`\x1b[33mVerify if ngrok is installed: npm install @ngrok/ngrok\x1b[0m`);
        }

    } else if (tunnelAddress) {
        const parts = tunnelAddress.split(':');
        publicHost = parts[0];
        publicPort = parts[1];
        log(`\x1b[33mUsing manual adress: ${tunnelAddress}\x1b[0m`);

    } else {
        log(`\x1b[33mNo tunnel configured; Using local IP. If you have Radmin, you can share your Radmin IP and port with your friends!\x1b[0m`);
    }

    if (isOfficial) {
        await registerServer(publicHost, publicPort);
        heartbeatInterval = setInterval(() => registerServer(publicHost, publicPort), 30000);
    }
});

wss.on('connection', (ws, req) => {
    const id = nextId++;
    const ip = req.socket.remoteAddress;
    const player = { id, ws, name: 'Player' + id, skin: 'bright_blue', body: [], dir: [1, 0], alive: false, score: 0, coins: 0 };
    players.set(id, player);

    send(ws, { type: 'welcome', id });
    send(ws, { type: 'foods', foods: foods.map(f => [f.x, f.y, f.rarity]) });
    send(ws, { type: 'coin_spawn', coins: coins.map(c => [c.x, c.y]) });
    send(ws, { type: 'apple_spawn', apples: apples.map(a => [a.x, a.y]) });

    ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        switch (msg.type) {
            case 'join': {
                player.name = String(msg.name || ('Player' + id)).substring(0, 24);
                player.skin = String(msg.skin || 'bright_blue').substring(0, 40);

                // UUID is the permanent account key. IP is recorded only as auxiliary metadata.
                const requestedUuid = String(msg.playerId || '');
                const uuid = validUuid(requestedUuid) ? requestedUuid.toLowerCase() : null;
                if (!uuid) {
                    send(ws, { type: 'error', message: 'Invalid player UUID. Update the game client.' });
                    break;
                }
                let account = accounts[uuid];
                if (!account) {
                    const legacyCoins = Number.isSafeInteger(Number(msg.legacyCoins))
                        ? Math.max(0, Math.min(100000000, Number(msg.legacyCoins))) : 0;
                    account = {
                        uuid,
                        name: player.name,
                        coins: legacyCoins,
                        unlockedSkins: String(msg.unlockedSkins || '').substring(0, 2000),
                        currentSkinId: String(msg.currentSkinId || 'bright_green').substring(0, 64),
                        lastIp: ip,
                        createdAt: new Date().toISOString(),
                        lastSeen: new Date().toISOString()
                    };
                    accounts[uuid] = account;
                } else {
                    account.name = player.name;
                    account.lastIp = ip;
                    account.lastSeen = new Date().toISOString();
                    const mergedSkins = new Set([
                        ...String(account.unlockedSkins || '').split('|'),
                        ...String(msg.unlockedSkins || '').split('|')
                    ].map(v => v.trim()).filter(Boolean));
                    account.unlockedSkins = [...mergedSkins].join('|');
                    const requestedSkin = String(msg.currentSkinId || '');
                    if (requestedSkin && mergedSkins.has(requestedSkin)) account.currentSkinId = requestedSkin;
                }
                player.uuid = uuid;
                player.account = account;
                saveAccounts();
                player.alive = true;
                const sx = Math.floor(WORLD_TILES / 2) + Math.floor(Math.random() * 10 - 5);
                const sy = Math.floor(WORLD_TILES / 2) + Math.floor(Math.random() * 10 - 5);
                player.body = []; for (let i = 0; i < 4; i++) player.body.push([sx - i, sy]);
                player.dir = [1, 0]; player.score = 0; player.coins = 0;
                sendProfile(player);
                log(`\x1b[34m[[game logs]] Player ${player.name} joined the Game!\x1b[0m`);
                broadcast({ type: 'player_joined', id, name: player.name, skin: player.skin }, id);
                break;
            }
            case 'move': {
                if (!player.alive) break;
                const [dx, dy] = Array.isArray(msg.dir) ? msg.dir : [1, 0];
                const [hx, hy] = Array.isArray(msg.head) ? msg.head : [0, 0];
                player.dir = [dx, dy];
                if (Array.isArray(msg.body) && msg.body.length > 0) {
                    player.body = msg.body.slice(0, 512);
                } else {
                    if (player.body.length > 0) {
                        player.body.unshift([hx, hy]);
                        player.body.pop();
                    }
                }
                if (hx < 0 || hx >= WORLD_TILES || hy < 0 || hy >= WORLD_TILES) {
                    killPlayer(id, null, 'border'); break;
                }
                const fi = checkFoodEaten(hx, hy);
                if (fi >= 0) {
                    const food = foods[fi]; foods.splice(fi, 1);
                    player.score += ([10, 30, 80, 200][food.rarity] || 10);
                    ensureFoods(); broadcastFoods();
                }
                break;
            }
            case 'coin_collect': {
                const cx = msg.x, cy = msg.y;
                const ci = checkCoinEaten(cx, cy);
                if (ci >= 0) {
                    coins.splice(ci, 1);
                    player.coins++;
                    if (player.account) {
                        player.account.coins = Math.max(0, Number(player.account.coins) || 0) + 1;
                        player.account.lastSeen = new Date().toISOString();
                        saveAccounts(); // Persist every collected coin immediately.
                        sendProfile(player);
                    }
                    ensureCoins();
                    broadcastCoins();
                }
                break;
            }
            case 'apple_collect': {
                const ax = Number(msg.x), ay = Number(msg.y);
                const ai = apples.findIndex(a => a.x === ax && a.y === ay);
                if (ai >= 0) {
                    apples.splice(ai, 1);
                    ensureApples();
                    broadcastApples();
                }
                break;
            }
            case 'die': {
                if (!player.alive) break;
                log(`${player.name} died (${msg.reason})`);
                player.alive = false;
                broadcastAll({ type: 'player_died', id, killer: '' });
                break;
            }
            case 'respawn': {
                const [rx, ry] = Array.isArray(msg.head) ? msg.head : [32, 32];
                player.alive = true; player.body = [];
                for (let i = 0; i < 4; i++) player.body.push([rx - i, ry]);
                player.dir = [1, 0]; player.score = 0;
                break;
            }
        }
    });

    ws.on('close', () => {
        log(`Player ${player.name} left`);
        players.delete(id);
        broadcastAll({ type: 'player_left', id });
    });

    ws.on('error', err => log(`! Error on #${id}: ${err.message}`));
});

setInterval(() => { if (players.size === 0) return; broadcastAll(buildStatePayload()); }, STATE_RATE);
setInterval(() => { if (players.size === 0) return; ensureFoods(); broadcastFoods(); }, FOOD_RATE);
setInterval(() => { ensureCoins(); broadcastCoins(); }, COIN_RATE);
setInterval(() => { ensureApples(); broadcastApples(); }, APPLE_RATE);
setInterval(() => { if (players.size === 0) return; const names = [...players.values()].map(p => `${p.name}(${p.body.length})`).join(', '); log(`📊 Players: ${players.size} | ${names}`); }, 10000);

// Console: givecoins "Player Name" 500 (also works when the player is offline).
if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', line => {
        const match = line.trim().match(/^givecoins\\s+"([^"]+)"\\s+(\\d+)$/i) ||
                      line.trim().match(/^givecoins\\s+(\\S+)\\s+(\\d+)$/i);
        if (!match) {
            if (line.trim()) console.log('Use: givecoins "Player Name" 500');
            return;
        }
        const targetName = match[1].trim().toLowerCase();
        const amount = Number(match[2]);
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) {
            console.log('Amount must be between 1 and 100000000.');
            return;
        }
        const matches = Object.values(accounts).filter(a => String(a.name || '').toLowerCase() === targetName);
        if (matches.length === 0) { console.log('Player account not found. They must join once first.'); return; }
        if (matches.length > 1) { console.log('More than one account has this name. Rename one player before using this command.'); return; }
        const account = matches[0];
        account.coins = Math.max(0, Number(account.coins) || 0) + amount;
        account.lastSeen = new Date().toISOString();
        saveAccounts();
        for (const p of players.values()) if (p.uuid === account.uuid) sendProfile(p);
        console.log('[Coins] +' + amount + ' for ' + account.name + '. New balance: ' + account.coins);
    });
}

const cleanup = async () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    if (ngrokListener) {
        try {
            await ngrokListener.close();
        } catch (err) {
            log(`Error ocurred while ending tunnel: ${err.message}`);
        }
    }

    if (isOfficial) {
        try {
            await axios.post(
                `${VERCEL_API_URL}/unregister`,
                {
                    host: publicHost,
                    port: publicPort
                }
            );
            log('Server removed');
        } catch (error) {
            log(`Error ocurred while registering: ${error.message}`);
        }
    }

    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);