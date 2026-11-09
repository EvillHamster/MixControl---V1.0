import "dotenv/config";
import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
pool.on("error", (error) => console.error("PostgreSQL pool:", error.message));
