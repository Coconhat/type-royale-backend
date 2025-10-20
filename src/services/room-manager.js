import { v4 } from "uuid";
import { allWords } from "../libs/words.js";

const rooms = new Map();

// Helper to emit to a specific player ONLY (not to room)
function emitToPlayer(io, playerId, event, data) {
  const socket = io.sockets.sockets.get(playerId);
  if (socket) {
    socket.emit(event, data);
  } else {
    console.warn(`[EMIT] Socket ${playerId} not found for event ${event}`);
  }
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

function createEnemy(id, phase, ownerId) {
  // Spawn on circle perimeter (like frontend) for consistent behavior
  const spawnRadius = 600 / 2 - 40; // match frontend: Math.min(width, height) / 2 - 40
  const angle = Math.random() * Math.PI * 2;
  const x = 300 + Math.cos(angle) * spawnRadius;
  const y = 300 + Math.sin(angle) * spawnRadius;

  const dx = 300 - x;
  const dy = 300 - y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  // Use phase-based speed with variety (like frontend)
  const [minSpeed, maxSpeed] = phase.speedRange;
  const baseSpeed = minSpeed + Math.random() * (maxSpeed - minSpeed);
  const varietyFactor = 1 + (Math.random() - 0.5) * phase.variety;
  const finalSpeed = baseSpeed * varietyFactor;

  return {
    id,
    word: allWords[Math.floor(Math.random() * allWords.length)],
    x,
    y,
    ux,
    uy,
    baseSpeed: finalSpeed,
    alive: true,
    ownerId, // Add owner tracking for debugging
    _lastSentX: null,
    _lastSentY: null,
    _lastSentAlive: null,
  };
}
export function createRoom(io, socketA, socketB) {
  const roomId = v4();

  const roomState = {
    id: roomId,
    io,
    players: new Map([
      [
        socketA.id,
        {
          id: socketA.id,
          heart: 3,
          kills: 0,
          ready: false,
          socketId: socketA.id,
          disconnected: false,
          enemies: new Map(), // Each player has their own enemies
          nextEnemyId: 1,
          spawnCooldown: null,
        },
      ],
      [
        socketB.id,
        {
          id: socketB.id,
          heart: 3,
          kills: 0,
          ready: false,
          socketId: socketB.id,
          disconnected: false,
          enemies: new Map(), // Each player has their own enemies
          nextEnemyId: 1,
          spawnCooldown: null,
        },
      ],
    ]),
    tickHandle: null,
    lastTick: Date.now(),
    started: false,
    createdAt: Date.now(),
    disconnectTimeout: null,
    lastHitTimes: new Map(),
    lastSnapshot: null, // track last full snapshot time
  };

  // instance helpers bound to roomState
  roomState.handleHit = (playerId, enemyId, word) =>
    handleHit(roomState, playerId, enemyId, word);
  roomState.serializeEnemies = (playerId) => {
    const player = roomState.players.get(playerId);
    if (!player) return [];
    return Array.from(player.enemies.values()).map((en) => {
      const { _lastSentX, _lastSentY, _lastSentAlive, ...rest } = en;
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

  // expose rooms map for handlers
  createRoom.__rooms = rooms;

  return roomState;
}

function broadcastRoomState(room) {
  // Send each player their own enemy state
  for (const [playerId, player] of room.players) {
    if (!player.disconnected) {
      emitToPlayer(room.io, playerId, "roomState", {
        enemies: room.serializeEnemies(playerId),
        players: room.serializePlayers(),
      });
    }
  }
}

function setReady(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) {
    console.warn("[ROOM] setReady: Player not found in room:", playerId);
    return;
  }
  p.ready = true;
  console.log("[ROOM] Player ready:", playerId, "Room:", room.id);
  room.io.to(room.id).emit("playerReady", { id: playerId });

  const allReady = Array.from(room.players.values()).every(
    (pl) => pl.ready && !pl.disconnected
  );

  console.log(
    "[ROOM] All ready check:",
    allReady,
    "Players:",
    Array.from(room.players.values()).map((p) => ({
      id: p.id,
      ready: p.ready,
      disconnected: p.disconnected,
    }))
  );

  if (allReady && !room.started) {
    console.log("[ROOM] Starting room tick for room:", room.id);
    room.started = true;
    room.lastTick = Date.now();

    // Initialize spawn cooldown for each player
    for (const [_playerId, player] of room.players) {
      player.spawnCooldown = randRange(getDifficultyPhase(0).spawnInterval);
    }

    room.tickHandle = startRoomTick(room.io, room);

    // Send each player their own initial state
    for (const [playerId, player] of room.players) {
      if (!player.disconnected) {
        emitToPlayer(room.io, playerId, "matchStart", {
          roomId: room.id,
          enemies: room.serializeEnemies(playerId),
          players: room.serializePlayers(),
        });
      }
    }
    console.log("[ROOM] matchStart emitted with initial state");
  }
}

function handleHit(room, playerId, enemyId, word) {
  const now = Date.now();
  const last = room.lastHitTimes.get(playerId) || 0;
  if (now - last < 200) return; // rate limit
  room.lastHitTimes.set(playerId, now);

  const player = room.players.get(playerId);
  if (!player) {
    console.log(`[HIT] Player ${playerId} not found in room`);
    return;
  }

  // Check enemy in THIS player's enemy pool only
  const enemy = player.enemies.get(enemyId);
  if (!enemy || !enemy.alive) {
    console.log(
      `[HIT] Enemy ${enemyId} not found or already dead for player ${playerId}`
    );
    return;
  }
  if ((enemy.word || "").toLowerCase() !== (word || "").toLowerCase()) {
    console.log(`[HIT] Word mismatch: expected "${enemy.word}", got "${word}"`);
    return;
  }

  enemy.alive = false;
  player.kills = (player.kills || 0) + 1;

  console.log(
    `[HIT] ✅ Player ${playerId} killed enemy ${enemyId} (word: "${word}"). Emitting ONLY to ${playerId}`
  );

  // Send to THIS player ONLY using helper
  emitToPlayer(room.io, playerId, "enemyKilled", { enemyId, by: playerId });

  // Immediately broadcast updated player stats to both players
  room.io.to(room.id).emit("playerStats", {
    playerId,
    heart: player.heart,
    kills: player.kills,
  });
}

function reassignPlayerSocket(room, oldId, newSocket) {
  const p = room.players.get(oldId);
  if (!p) return false;
  room.players.delete(oldId);
  p.socketId = newSocket.id;
  p.id = newSocket.id;
  p.disconnected = false;
  // Ensure enemies map persists
  if (!p.enemies) p.enemies = new Map();
  if (p.nextEnemyId === undefined) p.nextEnemyId = 1;
  if (p.spawnCooldown === null) p.spawnCooldown = null;
  room.players.set(newSocket.id, p);
  newSocket.join(room.id);
  if (room.disconnectTimeout) {
    clearTimeout(room.disconnectTimeout);
    room.disconnectTimeout = null;
  }
  room.io.to(room.id).emit("playerRejoined", { id: newSocket.id });
  return true;
}

function startRoomTick(io, room) {
  const TICK_MS = 60; // higher tick for smoother motion
  return setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.12, (now - room.lastTick) / 1000);
    room.lastTick = now;

    const elapsedSec = Math.floor((now - room.createdAt) / 1000);
    const phase = getDifficultyPhase(elapsedSec);

    // Process each player's enemies separately
    for (const [playerId, player] of room.players) {
      if (player.disconnected) continue;

      // Spawn logic for this player
      if (room.started) {
        player.spawnCooldown -= dt * 1000;
        const aliveCount = Array.from(player.enemies.values()).filter(
          (e) => e.alive
        ).length;
        const maxActive = phase.max;
        if (player.spawnCooldown <= 0 && aliveCount < maxActive) {
          const e = createEnemy(player.nextEnemyId++, phase);
          player.enemies.set(e.id, e);
          emitToPlayer(io, playerId, "spawnEnemy", e);
          player.spawnCooldown = randRange(phase.spawnInterval);
        }
      }

      const changed = [];
      const reached = [];

      // Update this player's enemies
      for (const e of player.enemies.values()) {
        if (!e.alive) {
          if (e._lastSentAlive !== false)
            changed.push({ id: e.id, alive: false });
          e._lastSentAlive = false;
          continue;
        }
        e.x += e.ux * e.baseSpeed * (dt * 60);
        e.y += e.uy * e.baseSpeed * (dt * 60);
        const d = Math.hypot(e.x - 300, e.y - 300);
        if (d <= 24) {
          e.alive = false;
          reached.push(e.id);
          changed.push({ id: e.id, x: e.x, y: e.y, alive: false });
          e._lastSentX = e.x;
          e._lastSentY = e.y;
          e._lastSentAlive = false;
          continue;
        }

        const lastX = e._lastSentX ?? -9999;
        const lastY = e._lastSentY ?? -9999;
        if (Math.hypot(e.x - lastX, e.y - lastY) > 1) {
          changed.push({ id: e.id, x: e.x, y: e.y, alive: true });
          e._lastSentX = e.x;
          e._lastSentY = e.y;
          e._lastSentAlive = true;
        }
      }

      // Send updates to this player only
      if (changed.length > 0) {
        emitToPlayer(io, playerId, "enemyUpdate", { updates: changed, t: now });
      }

      if (reached.length > 0) {
        player.heart = Math.max(0, (player.heart || 0) - reached.length);
        emitToPlayer(io, playerId, "enemyReached", { enemyIds: reached });
        // Broadcast updated stats immediately
        io.to(room.id).emit("playerStats", {
          playerId,
          heart: player.heart,
          kills: player.kills,
        });

        // Check if THIS player just lost (heart reached 0)
        if (player.heart <= 0) {
          // Find the winner (the other player)
          const winner = Array.from(room.players.values()).find(
            (p) => p.id !== playerId
          );

          // End the match immediately
          io.to(room.id).emit("matchEnd", {
            reason: "player_died",
            winnerId: winner?.id,
            loserId: playerId,
            players: room.serializePlayers(),
          });

          if (room.tickHandle) clearInterval(room.tickHandle);
          rooms.delete(room.id);
          return; // Exit the interval callback
        }
      }
    }

    // Send full snapshot every ~3 seconds instead of 6% of ticks
    const ticksSinceSnapshot =
      (now - (room.lastSnapshot || room.createdAt)) / TICK_MS;
    if (ticksSinceSnapshot > 50) {
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
