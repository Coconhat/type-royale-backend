import { Server } from "socket.io";
import config from "../config/index.js";
import setupMatchmaking from "./handlers/matchmaking.js";

export function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin },
  });

  io.on("connection", (socket) => {
    console.log("a user connected:", socket.id);
    // wire up matchmaking and other handlers
    setupMatchmaking(io, socket);
  });
}

export default attachSocket;
