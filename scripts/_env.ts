// Load .env.local for standalone tsx scripts (Next.js loads it automatically
// for the app, but plain scripts need this).
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
