import dotenv from "dotenv";
dotenv.config();

export default {
  port: process.env.PORT || 4000,
  corsOrigin: process.env.CORS_ORIGIN || "*",
  env: process.env.NODE_ENV || "development",
};
