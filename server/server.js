const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const MAX_ROOM_PLAYERS = Number(process.env.MAX_ROOM_PLAYERS || 12);
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
        res.writeHead(200, { "content-type": staticFile.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
        return fs.createReadStream(fullPath).pipe(res);
      }
    }
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, service: "fy-pool-day-relay", rooms: rooms.size }));
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
        room = { name, peers: new Map(), hostId: null, botState: null };
        rooms.set(name, room);
      }
      if (room.peers.size >= MAX_ROOM_PLAYERS) {
        send(ws, { type: "notice", text: `Комната заполнена (лимит ${MAX_ROOM_PLAYERS})` });
        return ws.close(1008, "Room full");
      }
      const id = cryptoId();
      const player = {
        id, name: safeName(msg.name),
        team: msg.team === "blue" ? "blue" : "red",
        x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true
      };
      room.peers.set(id, { ws, player });
      if (!room.hostId) room.hostId = id;
      ws.room = room;
      ws.playerId = id;
      send(ws, { type: "welcome", id, host: room.hostId === id, players: room.peers.size });
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
      broadcast(room, { type: "player", ...p }, id);
    } else if (msg.type === "botState") {
      if (room.hostId !== id || !Array.isArray(msg.bots)) return;
      room.botState = {
        type: "botState",
        bots: msg.bots.slice(0, 32).map((b) => ({
          x: num(b.x), y: num(b.y), z: num(b.z), hp: num(b.hp),
          alive: !!b.alive, rotY: num(b.rotY), yawS: num(b.yawS),
          pitchS: num(b.pitchS), spd: num(b.spd), vx: num(b.vx), vz: num(b.vz),
          walkT: num(b.walkT), aim: num(b.aim), kick: num(b.kick), flash: num(b.flash),
          weapon: String(b.weapon || "").slice(0, 32), team: b.team === "red" ? "red" : "blue",
          diedAt: num(b.diedAt)
        })),
        score: { red: num(msg.score && msg.score.red), blue: num(msg.score && msg.score.blue) }
      };
      broadcast(room, room.botState, id);
    } else if (msg.type === "botHit") {
      if (room.hostId && room.hostId !== id) {
        const host = room.peers.get(room.hostId);
        send(host && host.ws, {
          type: "botHit",
          index: Math.max(0, Math.min(31, Number(msg.index) | 0)),
          amount: Math.max(0, Math.min(200, num(msg.amount))),
          attackerTeam: msg.attackerTeam === "blue" ? "blue" : "red"
        });
      }
    } else if (msg.type === "damage") {
      const target = room.peers.get(String(msg.target || ""));
      if (!target || target.player.team === (msg.attackerTeam === "blue" ? "blue" : "red")) return;
      send(target.ws, {
        type: "damage", target: target.player.id,
        amount: Math.max(0, Math.min(200, num(msg.amount))),
        attackerTeam: msg.attackerTeam === "blue" ? "blue" : "red"
      });
    } else if (msg.type === "frag") {
      broadcast(room, { type: "frag", team: msg.team === "blue" ? "blue" : "red" }, id);
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
  return require("crypto").randomBytes(8).toString("hex");
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

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
