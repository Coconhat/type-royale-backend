import { createRoom, leaveRoomIfAny } from "../../services/room-manager.js";

const queue = [];
export default function setupMatchmaking(io, socket) {
  socket.on("joinQueue", () => {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    attemptMatch(io);
  });

  socket.on("leaveQueue", () => {
    const idx = queue.indexOf(socket.id);
    if (idx !== -1) queue.splice(idx, 1);
    leaveRoomIfAny(io, socket.id);
  });

  socket.on("ready", ({ roomId }) => {
    const room = io.sockets.adapter.rooms.get(roomId);

    socket.to(roomId).emit("playerReady", { id: socket.id });
  });

  function attemptMatch(ioServer) {
    while (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();

      // guard against disconnected sockets
      const sa = ioServer.sockets.sockets.get(a);
      const sb = ioServer.sockets.sockets.get(b);

      if (!sa || !sb) {
        if (sa) queue.unshift(a);
        if (sb) queue.unshift(b);
        continue;
      }

      const room = createRoom(ioServer, sa, sb);
      // createRoom already emits a `matchStart` event containing the battlefield
      // but send a lighter-weight matchFound as well for backwards compatibility
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
    }
  }
}
