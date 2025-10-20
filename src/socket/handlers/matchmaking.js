import { createRoom, leaveRoomIfAny } from "../../services/room-manager.js";

const queue = [];
export default function setupMatchmaking(io, socket) {
  socket.on("joinQueue", () => {
    console.log("[MATCHMAKING] Player joined queue:", socket.id);
    if (!queue.includes(socket.id)) queue.push(socket.id);
    console.log("[MATCHMAKING] Queue size:", queue.length);
    attemptMatch(io);
  });

  socket.on("leaveQueue", () => {
    console.log("[MATCHMAKING] Player left queue:", socket.id);
    const idx = queue.indexOf(socket.id);
    if (idx !== -1) queue.splice(idx, 1);
    leaveRoomIfAny(io, socket.id);
  });

  socket.on("ready", ({ roomId }) => {
    console.log("[MATCHMAKING] Player ready:", socket.id, "Room:", roomId);
    const room = createRoom.__rooms?.get(roomId);
    if (room) {
      room.setReady(socket.id);
    } else {
      console.warn("[MATCHMAKING] Room not found:", roomId);
    }
  });

  socket.on("hit", ({ roomId, enemyId, word }) => {
    // forward to room manager
    const room = createRoom.__rooms?.get(roomId);
    if (room) {
      room.handleHit(socket.id, enemyId, word);
    }
  });

  socket.on("requestRoomState", ({ roomId }) => {
    const room = createRoom.__rooms?.get(roomId);
    if (room) {
      // send snapshot to requester only with THEIR enemies
      socket.emit("roomState", {
        enemies: room.serializeEnemies(socket.id),
        players: room.serializePlayers(),
      });
    }
  });

  function attemptMatch(ioServer) {
    while (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();

      const sa = ioServer.sockets.sockets.get(a);
      const sb = ioServer.sockets.sockets.get(b);

      if (!sa || !sb) {
        if (sa) queue.unshift(a);
        if (sb) queue.unshift(b);
        continue;
      }

      console.log("[MATCHMAKING] Creating room for:", sa.id, "vs", sb.id);
      const room = createRoom(ioServer, sa, sb);
      console.log("[MATCHMAKING] Room created:", room.id);

      sa.emit("matchFound", {
        roomId: room.id,
        playerId: sa.id,
        opponentId: sb.id,
      });
      sb.emit("matchFound", {
        roomId: room.id,
        playerId: sb.id,
        opponentId: sa.id,
      });

      console.log("[MATCHMAKING] Match found emitted to both players");
    }
  }
}
