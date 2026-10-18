/**
 * Part 20 — move the ORIGINAL single-college data into a real college. Run this ONCE, BEFORE the first start of the
 * multi-college server (and after taking a database backup — see docs/MIGRATION_AND_BACKUP.md).
 *
 *   # 1. Look first (default; writes nothing, not even the college):
 *   npm run migrate:legacy-college -- --name "Feni Computer Institute" --country Bangladesh --district Feni
 *
 *   # 2. Apply (you confirm that a backup exists):
 *   npm run migrate:legacy-college -- --name "Feni Computer Institute" --country Bangladesh --district Feni --apply --confirm-backup
 *
 *   # Resume / attach to a college that already exists (e.g. an interrupted run):
 *   npm run migrate:legacy-college -- --college-id COL-XXXXXXXXXX --apply --confirm-backup
 *
 * Options:  --founder-email <e-mail>   the protected founder admin (default: oldest approved college-less admin)
 *           --json                     machine-readable output
 * Exit code: 0 success / nothing to do, 1 refused or verification failed.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import College from "../models/College.js";
import User from "../models/User.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";
import Attendance from "../models/Attendance.js";
import ConsecutiveAbsenceAlert from "../models/ConsecutiveAbsenceAlert.js";
import Notification from "../models/Notification.js";
import ActivityLog from "../models/ActivityLog.js";
import Department from "../models/Department.js";
import Shift from "../models/Shift.js";
import AttendanceCategory from "../models/AttendanceCategory.js";
import Settings from "../models/Settings.js";
import { migrateLegacyToCollege } from "../utils/legacyCollegeMigration.js";
import { migrateAcademicOwnership } from "../utils/academicBackfill.js";
import { migrateAttendanceOwnership } from "../utils/attendanceBackfill.js";

dotenv.config();

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (m) => { console.error(`❌ ${m}`); process.exit(1); };

const apply = flag("apply");
if (apply && !flag("confirm-backup")) die("--apply needs --confirm-backup (take a backup first: docs/MIGRATION_AND_BACKUP.md).");

const models = { College, User, Student, Subject, Attendance, ConsecutiveAbsenceAlert, Notification, ActivityLog, Department, Shift, AttendanceCategory, Settings };

try {
  await connectForScript();
  const result = await migrateLegacyToCollege({
    models, dryRun: !apply, collegeId: opt("college-id") || null,
    college: { name: opt("name"), country: opt("country"), district: opt("district") },
    founderEmail: opt("founder-email") || null,
    log: (m) => !flag("json") && console.log(`  … ${m}`),
  });

  if (apply && result.changed > 0 && result.verification?.identical && result.verification?.relationshipsPreserved) {
    // Finish the deployment steps the server also performs at start-up (idempotent): per-college indexes and the
    // category / department / settings completion. Running them here makes the result visible before go-live.
    result.followUp = {
      academic: await migrateAcademicOwnership(),
      attendance: await migrateAttendanceOwnership(),
    };
  }

  if (flag("json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`\n${result.dryRun ? "DRY RUN — nothing was written" : "APPLIED"}`);
    console.log("College-less rows found :", JSON.stringify(result.legacyBefore));
    if (result.college) console.log("Target college          :", JSON.stringify(result.college), result.createdCollege ? "(created)" : "");
    if (result.founder) console.log("Founder (protected)     :", result.founder.email);
    if (!result.dryRun) {
      console.log("Stamped                 :", JSON.stringify(result.stamped));
      if (Object.keys(result.merged).length) console.log("Merged by name (kept)   :", JSON.stringify(result.merged));
      console.log("Still college-less      :", JSON.stringify(result.remaining));
      console.log("Content identical       :", result.verification?.identical, "| relationships preserved:", result.verification?.relationshipsPreserved);
      if (result.followUp) console.log("Follow-up migrations    :", JSON.stringify(result.followUp));
    } else if (result.relationshipsBefore) {
      console.log("Relationship check now  :", JSON.stringify(result.relationshipsBefore));
    }
    for (const w of result.warnings) console.warn(`⚠️  ${w}`);
    if (!result.dryRun && result.changed > 0) {
      console.log("\nNext: start the server, then set STRICT_COLLEGE_MEMBERSHIP=true and restart (see docs/MIGRATION_AND_BACKUP.md).");
    }
  }
  const bad = result.verification && (!result.verification.identical || !result.verification.relationshipsPreserved);
  await mongoose.disconnect();
  process.exit(bad ? 1 : 0);
} catch (err) {
  console.error(`❌ ${err.code ? `[${err.code}] ` : ""}${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
}
