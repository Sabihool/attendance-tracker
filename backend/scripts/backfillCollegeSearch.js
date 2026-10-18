/**
 * One-off / repeatable: add search fields to existing colleges and make sure
 * the search index exists.   Usage:  npm run backfill:colleges
 * (The server also runs the backfill automatically at startup.)
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import College from "../models/College.js";
import { backfillCollegeSearchFields } from "../utils/collegeBackfill.js";

dotenv.config();

try {
  await connectForScript();
  await College.createIndexes();
  const n = await backfillCollegeSearchFields(College);
  console.log(`✅ Search index ready. Colleges updated: ${n}`);
  process.exit(0);
} catch (err) {
  console.error("❌ Backfill failed:", err.message);
  process.exit(1);
}
