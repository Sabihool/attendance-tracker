/**
 * One-off / repeatable (idempotent) Part 12 migration:
 *   npm run migrate:attendance
 * Stamps existing attendance sessions and consecutive-absence alerts with their
 * subject's college, gives every college its own attendance categories (a copy of
 * the old global list) and streak setting, and replaces the old global indexes with
 * college-led ones. Attendance history, credit snapshots and streaks are not
 * modified. The server also runs this at start-up; use this script to run it
 * ahead of a deploy. It runs the Part 9 academic migration first (it stamps the
 * subjects this one depends on; also idempotent).
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import { migrateAcademicOwnership } from "../utils/academicBackfill.js";
import { migrateAttendanceOwnership } from "../utils/attendanceBackfill.js";

dotenv.config();
await connectForScript();
console.log("Academic structure migration:", JSON.stringify(await migrateAcademicOwnership()));
console.log("Attendance migration:", JSON.stringify(await migrateAttendanceOwnership()));
await mongoose.disconnect();
