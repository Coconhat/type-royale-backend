import express from "express";
import http from "http";
import cors from "cors";
import { Server as IOServer } from "socket.io";
import setupMatchmaking from "./socket/handlers/matchmaking.js";
import authRoutes from "./routes/auth.js";
import "./config/database.js";
import requireAuth from "./middleware/auth.js";

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use("/auth", requireAuth, authRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const io = new IOServer(server, {
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  io.emit("onlineCount", io.engine.clientsCount);

  setupMatchmaking(io, socket);

  socket.on("disconnect", () => {
    console.log("socket disconnected", socket.id);
    io.emit("onlineCount", io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`server listening ${PORT}`));
