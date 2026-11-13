const WebSocket = require("ws");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const MAX_ROOM_PLAYERS = Number(process.env.MAX_ROOM_PLAYERS || 10); // лимит игроков на комнату
const ROOM_EMPTY_TTL_MS = 10 * 60 * 1000; // пустая комната живёт не дольше 10 минут
const VERSION = "1.15"; // версия билда; синхронизируется с GAME_VERSION в index.html
const INTERNET_MODE = process.argv.includes("--internet");
const rooms = new Map();

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEBAPP_URL = process.env.WEBAPP_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const server = http.createServer(async (req, res) => {
  if (req.url === "/telegram/webhook" && req.method === "POST") {
    if (!BOT_TOKEN || !WEBAPP_URL || !WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
      res.writeHead(403); return res.end("Forbidden");
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      try {
        const update = JSON.parse(body || "{}");
        const message = update.message;
        if (message && message.chat && message.text && /^\/(start|play)(?:\s|$)/.test(message.text)) {
          const roomArg = (message.text.split(/\s+/)[1] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
          const startUrl = roomArg ? `${WEBAPP_URL}${WEBAPP_URL.includes("?") ? "&" : "?"}room=${encodeURIComponent(roomArg)}` : WEBAPP_URL;
          const payload = {
            chat_id: message.chat.id,
            text: "CS 1.6 Classic Arena\n\nСоздайте комнату или подключитесь к друзьям. Выберите режим сервера уже внутри игры.",
            reply_markup: { inline_keyboard: [[{ text: "🎮 Открыть игру", web_app: { url: startUrl } }]] }
          };
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        }
        res.writeHead(200, { "content-type": "text/plain" }); res.end("ok");
      } catch (err) { console.error("Telegram webhook error:", err.message); res.writeHead(200); res.end("ok"); }
    });
    return;
  }
  if (req.method === "GET") {
    const STATIC_FILES = { "/": "index.html", "/index.html": "index.html", "/telegram-config.js": "telegram-config.js" };
    const staticFile = STATIC_FILES[req.url.split("?")[0]];
    if (staticFile) {
      const fullPath = path.join(__dirname, staticFile);
      if (fs.existsSync(fullPath)) {
        res.writeHead(200, {
          "content-type": staticFile.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "cache-control": "no-cache, must-revalidate"
        });
        return fs.createReadStream(fullPath).pipe(res);
      }
    }
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, service: "fy-pool-day-relay", rooms: rooms.size, version: VERSION }));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("fy_pool_day multiplayer relay is running\n");
});

const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, exceptId = null) {
  for (const [id, peer] of room.peers) if (id !== exceptId) send(peer.ws, data);
}
function safeName(value) {
  return String(value || "Игрок").replace(/[<>\\u0000-\\u001f]/g, "").slice(0, 16) || "Игрок";
}
function leave(ws) {
  const room = ws.room;
  if (!room || !ws.playerId) return;
  const id = ws.playerId;
  room.peers.delete(id);
  broadcast(room, { type: "peerLeft", id });
  if (room.hostId === id) {
    const next = room.peers.keys().next();
    room.hostId = next.done ? null : next.value;
    if (room.hostId) broadcast(room, { type: "hostChanged", id: room.hostId });
  }
  if (!room.peers.size) rooms.delete(room.name);
  ws.room = null;
  ws.playerId = null;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: "notice", text: "Некорректный JSON" }); }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "join") {
      if (ws.room) return;
      const name = String(msg.room || "pool-day").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "pool-day";
      let room = rooms.get(name);
      if (!room) {
        room = { name, peers: new Map(), hostId: null, botState: null, lastActivity: Date.now() };
        rooms.set(name, room);
      }
      room.lastActivity = Date.now();
      if (room.peers.size >= MAX_ROOM_PLAYERS) {
        send(ws, { type: "notice", text: `Комната заполнена (лимит ${MAX_ROOM_PLAYERS})` });
        return ws.close(1008, "Room full");
      }
      const initData = typeof msg.initData === "string" ? msg.initData : "";
      let verified = false;
      if (initData) {
        const v = verifyInitData(initData);
        if (!v.ok) {
          send(ws, { type: "notice", text: "Подпись Telegram не прошла проверку" });
          return ws.close(1008, "Bad signature");
        }
        verified = true;
      }
      const id = cryptoId();
      const player = {
        id, name: safeName(msg.name),
        team: msg.team === "blue" ? "blue" : "red",
        verified,
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true
      };
      room.peers.set(id, { ws, player });
      if (!room.hostId) room.hostId = id;
      ws.room = room;
      ws.playerId = id;
      send(ws, { type: "welcome", id, host: room.hostId === id, players: room.peers.size, verified });
      for (const [otherId, peer] of room.peers) {
        if (otherId !== id) send(ws, { type: "peer", ...peer.player });
      }
      broadcast(room, { type: "peer", ...player }, id);
      if (room.botState) send(ws, room.botState);
      return;
    }

    const room = ws.room;
    const id = ws.playerId;
    if (!room || !id) return;
    const peer = room.peers.get(id);
    if (!peer) return;
    room.lastActivity = Date.now(); // любая активность продлевает жизнь комнаты

    if (msg.type === "player") {
      const p = peer.player;
      for (const k of ["x", "y", "z", "yaw", "pitch", "hp", "spd"]) {
        const v = Number(msg[k]);
        if (Number.isFinite(v)) p[k] = Math.max(-10000, Math.min(10000, v));
      }
      p.team = msg.team === "blue" ? "blue" : "red";
      p.name = safeName(msg.name);
      p.weapon = String(msg.weapon || "").slice(0, 32);
      p.alive = msg.alive !== false;
      p.fr = Math.max(0, Math.min(9999, Number(msg.fr) | 0));
      p.de = Math.max(0, Math.min(9999, Number(msg.de) | 0));
      broadcast(room, { type: "player", ...p }, id);
    } else if (msg.type === "botState") {
      if (room.hostId !== id || !Array.isArray(msg.bots)) return;
      room.botState = {
        type: "botState",
        // дельта-формат: null на месте неизменившихся ботов — пробрасываем как есть
        bots: msg.bots.slice(0, 32).map((b) => b ? ({
          x: num(b.x), y: num(b.y), z: num(b.z), hp: num(b.hp),
          alive: !!b.alive, rotY: num(b.rotY), yawS: num(b.yawS),
          pitchS: num(b.pitchS), spd: num(b.spd), vx: num(b.vx), vz: num(b.vz),
          walkT: num(b.walkT), aim: num(b.aim), kick: num(b.kick), flash: num(b.flash),
          weapon: String(b.weapon || "").slice(0, 32), team: b.team === "red" ? "red" : "blue",
          diedAt: num(b.diedAt), spawnProt: num(b.spawnProt),
          frags: Math.max(0, Math.min(9999, Number(b.frags) | 0)),
          deaths: Math.max(0, Math.min(9999, Number(b.deaths) | 0))
        }) : null),
        score: { red: num(msg.score && msg.score.red), blue: num(msg.score && msg.score.blue) },
        timeLeft: Math.max(0, Math.min(3600, num(msg.timeLeft))),
        roundOver: !!msg.roundOver,
        winner: msg.winner === 'blue' ? 'blue' : msg.winner === 'red' ? 'red' : 'draw',
        armor: { active: !!(msg.armor && msg.armor.active), respawnAt: Math.max(0, Math.min(600000, num(msg.armor && msg.armor.respawnAt))) },
        gw: Array.isArray(msg.gw) ? msg.gw.slice(0, 64).map((g) => ({ i: Math.max(0, Math.min(65535, Number(g.i) | 0)), x: num(g.x), y: g && g.y === null ? null : num(g && g.y), z: num(g.z), r: num(g.r), w: String(g.w || "").slice(0, 32) })) : []
      };
      broadcast(room, room.botState, id);
    } else if (msg.type === "botHit") {
      if (room.hostId && room.hostId !== id) {
        const host = room.peers.get(room.hostId);
        send(host && host.ws, {
          type: "botHit",
          index: Math.max(0, Math.min(31, Number(msg.index) | 0)),
          amount: Math.max(0, Math.min(200, num(msg.amount))),
          attackerTeam: msg.attackerTeam === "blue" ? "blue" : "red",
          attacker: String(msg.attacker || "").slice(0, 40),
          w: String(msg.w || "").slice(0, 32) // оружие для ленты убийств
        });
      }
    } else if (msg.type === "damage") {
      const target = room.peers.get(String(msg.target || ""));
      if (!target || target.player.team === (msg.attackerTeam === "blue" ? "blue" : "red")) return;
      send(target.ws, {
        type: "damage", target: target.player.id,
        amount: Math.max(0, Math.min(200, num(msg.amount))),
        attackerTeam: msg.attackerTeam === "blue" ? "blue" : "red",
        killerBot: Number.isInteger(msg.killerBot) ? Math.max(0, Math.min(31, msg.killerBot)) : undefined,
        kname: String(msg.kname || "").slice(0, 16) // имя бота-убийцы для ленты
      });
    } else if (msg.type === "frag") {
      broadcast(room, { type: "frag", team: msg.team === "blue" ? "blue" : "red", by: String(msg.by || "").slice(0, 40), killerBot: Number.isInteger(msg.killerBot) ? Math.max(0, Math.min(31, msg.killerBot)) : undefined }, id);
    } else if (msg.type === "killfeed") {
      // лента убийств: источник уже показал запись локально — остальным рассылаем очищенную копию
      broadcast(room, {
        type: "killfeed",
        k: safeName(msg.k), kt: msg.kt === "blue" ? "blue" : "red", kb: !!msg.kb,
        v: safeName(msg.v), vt: msg.vt === "blue" ? "blue" : "red", vb: !!msg.vb,
        w: String(msg.w || "").slice(0, 32), hs: !!msg.hs
      }, id);
    } else if (msg.type === "armorTaken") {
      if (room.hostId && room.hostId !== id) {
        const host = room.peers.get(room.hostId);
        if (host) send(host.ws, { type: "armorTaken" });
      }
    } else if (msg.type === "gwTaken") {
      if (room.hostId && room.hostId !== id) {
        const host = room.peers.get(room.hostId);
        if (host) send(host.ws, { type: "gwTaken", id: Math.max(0, Math.min(65535, Number(msg.id) | 0)) });
      }
    }
  });

  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-10000, Math.min(10000, n)) : 0;
}
function cryptoId() {
  return crypto.randomBytes(8).toString("hex");
}
function verifyInitData(initData) {
  if (!BOT_TOKEN) return { ok: false };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false };
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const computed = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
    if (computed !== hash) return { ok: false };
    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86400) return { ok: false };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Heartbeat: раз в 30с пингуем клиентов; кто не ответил — теряем (ws.terminate -> leave -> peerLeft)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// Зачистка комнат: обычно пустая комната удаляется сразу при выходе последнего игрока (leave),
// но на случай утечки раз в минуту удаляем комнаты без игроков, пустующие дольше 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [name, room] of rooms) {
    if (!room.peers.size && now - (room.lastActivity || 0) > ROOM_EMPTY_TTL_MS) {
      rooms.delete(name);
      console.log(`Комната "${name}" закрыта: пуста более 10 минут`);
    }
  }
}, 60000);

let publicTunnel = null;
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`fy_pool_day relay listening on :${PORT}`);
  console.log(`Локальный адрес: ws://localhost:${PORT}`);

  if (BOT_TOKEN && WEBAPP_URL && WEBHOOK_SECRET && process.env.PUBLIC_SERVER_URL) {
    try {
      const base = process.env.PUBLIC_SERVER_URL.replace(/\/$/, "");
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${base}/telegram/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ["message"], drop_pending_updates: true })
      });
      const data = await r.json();
      console.log(data.ok ? `Webhook установлен: ${base}/telegram/webhook` : `Ошибка установки webhook: ${data.description}`);
    } catch (err) {
      console.error("Не удалось установить webhook:", err.message);
    }
  }

  if (INTERNET_MODE) {
    try {
      const localtunnel = require("localtunnel");
      publicTunnel = await localtunnel({ port: PORT });
      const publicWs = publicTunnel.url.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
      console.log("\n==============================================");
      console.log("ИНТЕРНЕТ-АДРЕС ДЛЯ ДРУГИХ ИГРОКОВ:");
      console.log(publicWs);
      console.log("==============================================");
      console.log("Оставьте это окно открытым. Передайте игрокам адрес выше и код комнаты.");
      publicTunnel.on("close", () => console.log("Публичный туннель закрыт."));
      publicTunnel.on("error", (err) => console.error("Ошибка интернет-туннеля:", err.message));
    } catch (err) {
      console.error("Не удалось открыть интернет-туннель:", err.message);
      console.error("Проверьте подключение к интернету и повторите npm run internet.");
      server.close();
      process.exitCode = 1;
    }
  }
});

function shutdown() {
  clearInterval(heartbeat);
  if (publicTunnel) publicTunnel.close();
  for (const ws of wss.clients) ws.close();
  server.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
