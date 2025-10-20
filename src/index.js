// src/index.js
import express from "express";
import http from "http";
import cors from "cors";
import config from "./config/index.js";
import { attachSocket } from "./socket/index.js";

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

const server = http.createServer(app);
attachSocket(server);

server.listen(config.port, () => {
  console.log(
    `Server listening on http://localhost:${config.port} (env=${config.env})`
  );
});
