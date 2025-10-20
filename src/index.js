import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import setupMatchmaking from "./socket/handlers/matchmaking.js";

const app = express();
const server = http.createServer(app);

const io = new IOServer(server, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);
  setupMatchmaking(io, socket);

  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`server listening ${PORT}`));
