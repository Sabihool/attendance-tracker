/**
 * One-off / repeatable (idempotent) Part 9 migration:
 *   npm run migrate:academic
 * Drops the old GLOBAL unique indexes on departments/shifts/students, builds the
 * per-college ones, stamps existing students/subjects with their college and
 * gives each college its department/shift lists. The server also runs this at
 * start-up; use this script to run it ahead of a deploy.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import { migrateAcademicOwnership } from "../utils/academicBackfill.js";

dotenv.config();
await connectForScript();
const r = await migrateAcademicOwnership();
console.log("Academic structure migration:", JSON.stringify(r));
await mongoose.disconnect();
