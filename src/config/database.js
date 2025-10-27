import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

// Create a connection pool for better performance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20, // Maximum number of connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test the connection
pool.on("connect", () => {
  console.log("📦 Connected to Neon PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("❌ Database connection error:", err);
});

// Helper function to execute queries
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log("🔍 Executed query", { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error("❌ Query error:", error);
    throw error;
  }
}

// Helper function to get a client for transactions
export async function getClient() {
  return await pool.connect();
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("📦 Closing database pool...");
  await pool.end();
  process.exit(0);
});

export default pool;
