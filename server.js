import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET || AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET must be set to a random value of at least 32 characters.");
const MAX_PLAYERS_PER_ROOM = 32;
const WORLD_LIMIT = 150;
const MAX_SPEED = 16;
const MAX_VERTICAL_SPEED = 32;
const MAX_MESSAGES_PER_SECOND = 90;
const rooms = new Map();

function createSessionToken(player) {
  const payload = `${player.id}.${player.roomCode}.${Date.now()}`;
  const signature = createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function isValidSessionToken(player, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [id, roomCode, issuedAt, signature] = parts;
  if (id !== player.id || roomCode !== player.roomCode || !/^\d+$/.test(issuedAt)) return false;
  if (Date.now() - Number(issuedAt) > 24 * 60 * 60 * 1000) return false;
  const payload = `${id}.${roomCode}.${issuedAt}`;
  const expected = createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const providedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(room, message, except = null) {
  for (const player of room.players.values()) {
    if (player.socket !== except) send(player.socket, message);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9 _-]{1,12}$/.test(value.trim());
}

function validRoom(value) {
  return typeof value === "string" && /^[A-Z0-9]{3,12}$/.test(value);
}

function publicPlayer(player) {
  return {
    id: player.id,
    username: player.username,
    x: player.x,
    y: player.y,
    z: player.z,
    rotY: player.rotY
  };
}

function removePlayer(player) {
  const room = rooms.get(player.roomCode);
  if (!room) return;
  room.players.delete(player.id);
  broadcast(room, { type: "player_left", id: player.id });
  if (room.players.size === 0) rooms.delete(player.roomCode);
}

const app = express();
app.use(express.static(__dirname));
app.get("/", (_request, response) => response.sendFile(`${__dirname}/woah.html`));

const httpServer = createServer(app);

const websocketServer = new WebSocketServer({ server: httpServer, maxPayload: 4096 });

websocketServer.on("connection", socket => {
  const player = {
    socket,
    id: randomUUID(),
    roomCode: null,
    username: null,
    x: 0,
    y: 0,
    z: 0,
    rotY: 0,
    lastMoveAt: Date.now(),
    messageWindowStartedAt: Date.now(),
    messagesInWindow: 0
  };

  socket.on("message", raw => {
    const now = Date.now();
    if (now - player.messageWindowStartedAt >= 1000) {
      player.messageWindowStartedAt = now;
      player.messagesInWindow = 0;
    }
    player.messagesInWindow++;
    if (player.messagesInWindow > MAX_MESSAGES_PER_SECOND) return;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: "error", message: "Invalid message format." });
    }

    if (message.type === "join") {
      const roomCode = String(message.room || "").toUpperCase();
      const username = typeof message.username === "string" ? message.username.trim() : "";
      if (!validRoom(roomCode) || !validName(username)) return send(socket, { type: "error", message: "Invalid room or username." });
      if (player.roomCode) return send(socket, { type: "error", message: "Already joined." });

      const room = rooms.get(roomCode) || { players: new Map() };
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) return send(socket, { type: "error", message: "Room is full." });
      rooms.set(roomCode, room);
      player.roomCode = roomCode;
      player.username = username;
      player.sessionToken = createSessionToken(player);
      room.players.set(player.id, player);

      send(socket, {
        type: "joined",
        id: player.id,
        sessionToken: player.sessionToken,
        players: Array.from(room.players.values()).filter(item => item.id !== player.id).map(publicPlayer)
      });
      broadcast(room, { type: "player_joined", player: publicPlayer(player) }, socket);
      return;
    }

    if (message.type === "move") {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      if (!isValidSessionToken(player, message.sessionToken)) return send(socket, { type: "error", message: "Invalid or expired session." });
      const values = [message.x, message.y, message.z, message.rotY];
      if (!values.every(finiteNumber)) return;
      if (Math.abs(message.x) > WORLD_LIMIT || Math.abs(message.z) > WORLD_LIMIT || message.y < -20 || message.y > 60) return;

      const elapsed = Math.max((now - player.lastMoveAt) / 1000, 1 / 60);
      const horizontalDistance = Math.hypot(message.x - player.x, message.z - player.z);
      const verticalDistance = Math.abs(message.y - player.y);
      if (horizontalDistance > MAX_SPEED * elapsed + 1 || verticalDistance > MAX_VERTICAL_SPEED * elapsed + 2) {
        return send(socket, { type: "state_rejected", reason: "Movement exceeded server limits.", player: publicPlayer(player) });
      }

      player.x = message.x;
      player.y = message.y;
      player.z = message.z;
      player.rotY = message.rotY;
      player.lastMoveAt = now;
      broadcast(room, { type: "state", player: publicPlayer(player) });
    }
  });

  socket.on("close", () => removePlayer(player));
  socket.on("error", () => removePlayer(player));
});

httpServer.listen(PORT, () => console.log(`Authoritative server running at http://localhost:${PORT}`));
