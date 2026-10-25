// Blockverse multiplayer server — matchmaking by map+mode, bot fill, relay + authoritative HP/score.
// Run: npm install && npm start   (PORT env var honoured; Render/Fly set it automatically)
// Deno Deploy version — no dependencies. Entrypoint: main.js
const PORT = Number(Deno.env.get('PORT') || 8787);
const WAIT_SECS = 8;          // how long a lobby waits for more humans before starting
const BOT_HP = 3, PLAYER_HP = 100, PLAYER_HIT = 34; // 3 hits of dmg 1 tags a player
const RESPAWN = 2.5;


let nextId = 1;
const lobbies = new Map();   // key map|mode -> {players:[], timer, startsAt}
const rooms = new Map();     // id -> room

const send = (ws, m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const bcast = (room, m, except) => room.players.forEach(p => { if (p !== except) send(p.ws, m); });

function lobbyKey(map, mode) { return `${map}|${mode}`; }

function joinLobby(p) {
  const key = lobbyKey(p.map, p.mode);
  let L = lobbies.get(key);
  if (!L) { L = { key, players: [], startsAt: Date.now() + WAIT_SECS * 1000, timer: null }; lobbies.set(key, L);
    L.timer = setTimeout(() => startRoom(L), WAIT_SECS * 1000); }
  L.players.push(p); p.lobby = L;
  const max = p.teams.reduce((a, b) => a + b, 0);
  L.players.forEach(q => send(q.ws, { t: 'wait', count: L.players.length, max, secs: Math.max(0, Math.round((L.startsAt - Date.now()) / 1000)) }));
  if (L.players.length >= max) { clearTimeout(L.timer); startRoom(L); }
}

function startRoom(L) {
  lobbies.delete(L.key);
  if (!L.players.length) return;
  const teams = L.players[0].teams, ffa = L.players[0].mode === 'ffa', target = L.players[0].target;
  const room = { id: 'r' + nextId++, players: [], bots: [], teams: teams.map(() => ({ score: 0 })), target, ffa, over: false, hostId: null };
  // assign humans round-robin to teams (FFA: one team each)
  const sizes = teams.slice(); let humanIdx = 0;
  L.players.forEach((p, i) => {
    p.room = room; p.lobby = null; p.hp = PLAYER_HP; p.dead = 0;
    if (ffa) { p.team = i; } else { let t = i % teams.length; let tries = 0; while (sizes[t] <= 0 && tries++ < teams.length) t = (t + 1) % teams.length; p.team = t; sizes[t]--; }
    room.players.push(p);
  });
  if (ffa) { for (let i = 0; i < L.players.length; i++) sizes[i] = 0; }
  // bots fill the rest
  let b = 0;
  sizes.forEach((n, t) => { for (let k = 0; k < n; k++) room.bots.push({ id: 'b' + (b++), team: t, hp: BOT_HP, dead: 0 }); });
  room.hostId = room.players[0].id;
  rooms.set(room.id, room);
  const pub = room.players.map(p => ({ id: p.id, name: p.name, team: p.team, avatar: p.avatar }));
  room.players.forEach(p => send(p.ws, { t: 'start', room: room.id, you: p.id, team: p.team, host: room.hostId, players: pub, bots: room.bots.map(x => ({ id: x.id, team: x.team })), teams: teams, target, ffa }));
}

function entity(room, id) { return room.players.find(p => p.id === id) || room.bots.find(b => b.id === id); }

function applyHit(room, m, shooter) {
  if (room.over) return;
  const tgt = entity(room, m.target); if (!tgt || tgt.dead > 0) return;
  if (tgt.team === shooter.team && !room.ffa) return;
  const isBot = String(tgt.id).startsWith('b');
  tgt.hp -= isBot ? m.dmg : m.dmg * PLAYER_HIT;
  if (tgt.hp <= 0) {
    tgt.dead = RESPAWN; tgt.hp = isBot ? BOT_HP : PLAYER_HP;
    room.teams[shooter.team].score++;
    bcast(room, { t: 'ko', id: tgt.id, by: shooter.id, byTeam: shooter.team, scores: room.teams.map(t => t.score) });
    setTimeout(() => { tgt.dead = 0; if (rooms.has(room.id)) bcast(room, { t: 'respawn', id: tgt.id }); }, RESPAWN * 1000);
    const w = room.teams.findIndex(t => t.score >= room.target);
    if (w >= 0) { room.over = true; bcast(room, { t: 'end', winner: w, scores: room.teams.map(t => t.score) }); setTimeout(() => closeRoom(room), 15000); }
  } else {
    bcast(room, { t: 'hp', id: tgt.id, hp: tgt.hp });
  }
}

function closeRoom(room) { rooms.delete(room.id); room.players.forEach(p => { p.room = null; }); }

function leave(p) {
  if (p.lobby) { p.lobby.players = p.lobby.players.filter(q => q !== p); if (!p.lobby.players.length) { clearTimeout(p.lobby.timer); lobbies.delete(p.lobby.key); } p.lobby = null; }
  if (p.room) { const room = p.room; room.players = room.players.filter(q => q !== p); p.room = null;
    if (!room.players.length) return rooms.delete(room.id);
    // the leaver's slot becomes a bot so teams stay even
    const bot = { id: 'b' + Date.now() % 100000, team: p.team, hp: BOT_HP, dead: 0 }; room.bots.push(bot);
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    bcast(room, { t: 'leave', id: p.id, bot: { id: bot.id, team: bot.team }, host: room.hostId });
  }
}

function onConnection(ws) {
  const p = { id: 'p' + nextId++, ws, name: 'Player', avatar: null, room: null, lobby: null, team: 0 };
  ws.onmessage = ev => {
    const raw = ev.data; let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') { leave(p); p.name = String(m.name || 'Player').slice(0, 14); p.avatar = m.avatar; p.map = String(m.map); p.mode = String(m.mode); p.teams = Array.isArray(m.teams) ? m.teams.map(n => Math.max(1, Math.min(5, n | 0))).slice(0, 6) : [1, 1]; p.target = Math.max(5, Math.min(50, m.target | 0)) || 15; joinLobby(p); return; }
    const room = p.room; if (!room) return;
    if (m.t === 'state') { bcast(room, { t: 'state', id: p.id, p: m.p, yaw: m.yaw, slot: m.slot, sc: m.sc, sl: m.sl }, p); return; }
    if (m.t === 'bots' && p.id === room.hostId) { bcast(room, { t: 'bots', b: m.b }, p); return; }
    if (m.t === 'shot') { bcast(room, { t: 'shot', from: m.from, to: m.to, c: m.c }, p); return; }
    if (m.t === 'hit') { let shooter = p; if (m.by && String(m.by).startsWith('b') && p.id === room.hostId) { shooter = entity(room, m.by) || p; } applyHit(room, m, shooter); return; }
    if (m.t === 'bomb') { bcast(room, { t: 'bomb', from: m.from, dir: m.dir }, p); return; }
    if (m.t === 'leave') { leave(p); return; }
  };
  ws.onclose = () => leave(p);
  ws.onerror = () => leave(p);
}

Deno.serve({ port: PORT }, req => {
  if (req.headers.get('upgrade') === 'websocket') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    onConnection(socket);
    return response;
  }
  return new Response(JSON.stringify({ ok: true, rooms: rooms.size, lobbies: lobbies.size }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
});
