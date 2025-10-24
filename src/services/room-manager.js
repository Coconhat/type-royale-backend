import { v4 } from "uuid";
import { allWords } from "../libs/words.js";

const rooms = new Map();

function emitToPlayer(io, playerId, event, payload) {
  const socket = io.sockets.sockets.get(playerId);
  if (socket) socket.emit(event, payload);
}

function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

function getDifficultyPhase(elapsedSec) {
  const totalGameSeconds = 340;
  const progress = elapsedSec / totalGameSeconds;
  if (progress < 0.15)
    return {
      spawnInterval: [2000, 2500],
      speedRange: [0.3, 0.5],
      variety: 0.2,
      max: 5,
    };
  if (progress < 0.35)
    return {
      spawnInterval: [1200, 1800],
      speedRange: [0.5, 0.9],
      variety: 0.4,
      max: 6,
    };
  if (progress < 0.6)
    return {
      spawnInterval: [800, 1300],
      speedRange: [0.8, 1.4],
      variety: 0.6,
      max: 7,
    };
  if (progress < 0.85)
    return {
      spawnInterval: [600, 1000],
      speedRange: [1.2, 2.0],
      variety: 0.8,
      max: 7,
    };
  return {
    spawnInterval: [400, 700],
    speedRange: [1.8, 3.5],
    variety: 1.0,
    max: 7,
  };
}

function createEnemy({ id, phase, word, ownerId }) {
  const spawnRadius = 600 / 2 - 40;
  const angle = Math.random() * Math.PI * 2;
  const x = 300 + Math.cos(angle) * spawnRadius;
  const y = 300 + Math.sin(angle) * spawnRadius;

  const dx = 300 - x;
  const dy = 300 - y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  const [minSpeed, maxSpeed] = phase.speedRange;
  const baseSpeed = minSpeed + Math.random() * (maxSpeed - minSpeed);
  const varietyFactor = 1 + (Math.random() - 0.5) * phase.variety;
  const finalSpeed = baseSpeed * varietyFactor;

  return {
    id,
    word,
    ownerId,
    x,
    y,
    ux,
    uy,
    baseSpeed: finalSpeed,
    alive: true,
    _lastSentX: null,
    _lastSentY: null,
    _lastSentAlive: null,
  };
}

export function createRoom(io, socketA, socketB) {
  const roomId = v4();

  const makePlayerState = (socket) => ({
    id: socket.id,
    socketId: socket.id,
    heart: 3,
    kills: 0,
    ready: false,
    disconnected: false,
    enemies: new Map(),
    nextEnemyId: 1,
  });

  const roomState = {
    id: roomId,
    io,
    players: new Map([
      [socketA.id, makePlayerState(socketA)],
      [socketB.id, makePlayerState(socketB)],
    ]),
    spawnCooldown: null,
    tickHandle: null,
    lastTick: Date.now(),
    started: false,
    createdAt: Date.now(),
    disconnectTimeout: null,
    lastHitTimes: new Map(),
    lastSnapshot: null,
  };

  roomState.handleHit = (playerId, enemyId, word) =>
    handleHit(roomState, playerId, enemyId, word);
  roomState.serializeEnemies = (playerId) => {
    const player = roomState.players.get(playerId);
    if (!player) return [];
    return Array.from(player.enemies.values()).map((enemy) => {
      const { _lastSentX, _lastSentY, _lastSentAlive, ...rest } = enemy;
      return rest;
    });
  };
  roomState.serializePlayers = () =>
    Array.from(roomState.players.values()).map((p) => ({
      id: p.id,
      heart: p.heart,
      kills: p.kills,
      ready: p.ready,
      socketId: p.socketId,
      disconnected: p.disconnected,
    }));
  roomState.setReady = (playerId) => setReady(roomState, playerId);
  roomState.reassignPlayerSocket = (oldId, newSocket) =>
    reassignPlayerSocket(roomState, oldId, newSocket);

  rooms.set(roomId, roomState);

  socketA.join(roomId);
  socketB.join(roomId);

  createRoom.__rooms = rooms;

  return roomState;
}

function broadcastRoomState(room) {
  for (const player of room.players.values()) {
    if (player.disconnected) continue;
    emitToPlayer(room.io, player.id, "roomState", {
      enemies: room.serializeEnemies(player.id),
      players: room.serializePlayers(),
    });
  }
}

function setReady(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) {
    console.warn("[ROOM] setReady: missing player", playerId);
    return;
  }

  player.ready = true;
  room.io.to(room.id).emit("playerReady", { id: playerId });

  const allReady = Array.from(room.players.values()).every(
    (p) => p.ready && !p.disconnected
  );

  if (allReady && !room.started) {
    room.started = true;
    room.lastTick = Date.now();
    room.spawnCooldown = randRange(getDifficultyPhase(0).spawnInterval);
    room.tickHandle = startRoomTick(room.io, room);

    for (const p of room.players.values()) {
      if (p.disconnected) continue;
      emitToPlayer(room.io, p.id, "matchStart", {
        roomId: room.id,
        enemies: room.serializeEnemies(p.id),
        players: room.serializePlayers(),
      });
    }
  }
}

function handleHit(room, playerId, enemyId, word) {
  const now = Date.now();
  const last = room.lastHitTimes.get(playerId) || 0;
  if (now - last < 200) return;
  room.lastHitTimes.set(playerId, now);

  const player = room.players.get(playerId);
  if (!player) return;

  const enemy = player.enemies.get(enemyId);
  if (!enemy || !enemy.alive) return;

  if ((enemy.word || "").toLowerCase() !== (word || "").toLowerCase()) return;

  enemy.alive = false;
  player.kills = (player.kills || 0) + 1;

  emitToPlayer(room.io, player.id, "enemyKilled", {
    enemyId,
    by: playerId,
  });

  room.io.to(room.id).emit("playerStats", {
    playerId,
    heart: player.heart,
    kills: player.kills,
  });
}

function reassignPlayerSocket(room, oldId, newSocket) {
  const player = room.players.get(oldId);
  if (!player) return false;

  room.players.delete(oldId);
  player.socketId = newSocket.id;
  player.id = newSocket.id;
  player.disconnected = false;

  room.players.set(newSocket.id, player);
  newSocket.join(room.id);

  if (room.disconnectTimeout) {
    clearTimeout(room.disconnectTimeout);
    room.disconnectTimeout = null;
  }

  room.io.to(room.id).emit("playerRejoined", { id: newSocket.id });
  return true;
}

function startRoomTick(io, room) {
  const TICK_MS = 60;
  return setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.12, (now - room.lastTick) / 1000);
    room.lastTick = now;

    const elapsedSec = Math.floor((now - room.createdAt) / 1000);
    const phase = getDifficultyPhase(elapsedSec);

    if (room.started) {
      room.spawnCooldown -= dt * 1000;
      if (room.spawnCooldown <= 0) {
        const sharedWord =
          allWords[Math.floor(Math.random() * allWords.length)];
        let spawned = false;

        for (const player of room.players.values()) {
          if (player.disconnected) continue;

          const aliveCount = Array.from(player.enemies.values()).filter(
            (enemy) => enemy.alive
          ).length;

          if (aliveCount >= phase.max) continue;

          const enemyId = player.nextEnemyId++;
          const enemy = createEnemy({
            id: enemyId,
            phase,
            word: sharedWord,
            ownerId: player.id,
          });
          player.enemies.set(enemy.id, enemy);
          emitToPlayer(io, player.id, "spawnEnemy", enemy);
          spawned = true;
        }

        room.spawnCooldown = randRange(phase.spawnInterval);
        if (!spawned) {
          room.spawnCooldown = randRange(phase.spawnInterval) * 0.5;
        }
      }
    }

    const eliminatedPlayers = new Set();

    for (const player of room.players.values()) {
      if (player.disconnected) continue;

      const changed = [];
      const reached = [];

      for (const enemy of player.enemies.values()) {
        if (!enemy.alive) {
          if (enemy._lastSentAlive !== false) {
            changed.push({ id: enemy.id, alive: false });
            enemy._lastSentAlive = false;
          }
          continue;
        }

        enemy.x += enemy.ux * enemy.baseSpeed * (dt * 60);
        enemy.y += enemy.uy * enemy.baseSpeed * (dt * 60);
        const distance = Math.hypot(enemy.x - 300, enemy.y - 300);

        if (distance <= 24) {
          enemy.alive = false;
          reached.push(enemy.id);
          changed.push({
            id: enemy.id,
            x: enemy.x,
            y: enemy.y,
            alive: false,
          });
          enemy._lastSentX = enemy.x;
          enemy._lastSentY = enemy.y;
          enemy._lastSentAlive = false;
          continue;
        }

        const lastX = enemy._lastSentX ?? -9999;
        const lastY = enemy._lastSentY ?? -9999;
        if (Math.hypot(enemy.x - lastX, enemy.y - lastY) > 1) {
          changed.push({ id: enemy.id, x: enemy.x, y: enemy.y, alive: true });
          enemy._lastSentX = enemy.x;
          enemy._lastSentY = enemy.y;
          enemy._lastSentAlive = true;
        }
      }

      if (changed.length > 0) {
        emitToPlayer(io, player.id, "enemyUpdate", {
          updates: changed,
          t: now,
        });
      }

      if (reached.length > 0) {
        player.heart = Math.max(0, player.heart - reached.length);
        emitToPlayer(io, player.id, "enemyReached", { enemyIds: reached });

        io.to(room.id).emit("playerStats", {
          playerId: player.id,
          heart: player.heart,
          kills: player.kills,
        });

        if (player.heart <= 0) {
          eliminatedPlayers.add(player.id);
        }
      }
    }

    if (eliminatedPlayers.size > 0) {
      const survivors = Array.from(room.players.values()).filter(
        (p) => p.heart > 0
      );
      const loserId = eliminatedPlayers.values().next().value;
      const winnerId = survivors.length === 1 ? survivors[0].id : null;

      io.to(room.id).emit("matchEnd", {
        reason: "player_died",
        winnerId,
        loserId,
        players: room.serializePlayers(),
      });

      if (room.tickHandle) clearInterval(room.tickHandle);
      rooms.delete(room.id);
      return;
    }

    if (!room.lastSnapshot || now - room.lastSnapshot > 3000) {
      broadcastRoomState(room);
      room.lastSnapshot = now;
    }
  }, TICK_MS);
}

export function leaveRoomIfAny(io, socketId) {
  for (const [id, room] of rooms) {
    if (room.players.has(socketId)) {
      const player = room.players.get(socketId);
      player.disconnected = true;
      room.disconnectTimeout = setTimeout(() => {
        if (room.tickHandle) clearInterval(room.tickHandle);
        rooms.delete(id);
        const otherIds = Array.from(room.players.keys()).filter(
          (pid) => pid !== socketId
        );
        for (const pid of otherIds) {
          io.to(pid).emit("opponentLeft", { roomId: id, by: socketId });
        }
      }, 20000);
    }
  }
}
