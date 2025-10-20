import { v4 } from "uuid";
import { allWords } from "../libs/words.js";

const rooms = new Map();

function generateBattlefield(opts = {}) {
  // opts: count, width/height etc. Keep simple and deterministic-ish
  const count = opts.count || 8;
  const enemies = [];
  for (let i = 0; i < count; i++) {
    enemies.push({
      id: i + 1,
      word: allWords[Math.floor(Math.random() * allWords.length)],
      x: Math.floor(Math.random() * 600),
      y: Math.floor(Math.random() * 600),
      alive: true,
    });
  }
  return enemies;
}

export function createRoom(io, socketA, socketB) {
  const roomId = v4();
  const battlefield = generateBattlefield({ count: 10 });
  const roomState = {
    id: roomId,
    players: {
      [socketA.id]: { id: socketA.id, heart: 3, kills: 0 },
      [socketB.id]: { id: socketB.id, heart: 3, kills: 0 },
    },
    enemies: battlefield,
    nextEnemyId: battlefield.length + 1,
    tickHandle: null,
  };
  rooms.set(roomId, roomState);

  socketA.join(roomId);
  socketB.join(roomId);

  roomState.tickHandle = startRoomTick(io, roomState);

  // emit match start with initial battlefield to both players
  io.to(roomId).emit("matchStart", {
    roomId: roomState.id,
    enemies: roomState.enemies,
    players: Object.keys(roomState.players),
  });

  return roomState;
}

function startRoomTick(io, room) {
  const TICK_MS = 60;
  return setInterval(() => {
    io.to(room.id).emit("roomtick", { t: Date.now() });
  }, TICK_MS);
}

export function leaveRoomIfAny(io, socketId) {
  for (const [id, room] of rooms) {
    if (room.players[socketId]) {
      // cleanup room if player leaves (simple strategy)
      if (room.tickHandle) clearInterval(room.tickHandle);
      rooms.delete(id);
      // notify opponent(s)
      const otherIds = Object.keys(room.players).filter(
        (pid) => pid !== socketId
      );
      for (const pid of otherIds) {
        // send a simple opponentLeft event to the other sockets
        io.to(pid).emit("opponentLeft", { roomId: id, by: socketId });
      }
    }
  }
}
