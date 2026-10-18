/**
 * Prints the query plan of every dashboard aggregation for ONE college, so the
 * indexes can be checked on real data:
 *
 *   node scripts/explainAnalytics.js <collegeId>
 *
 * For each pipeline it reports the winning plan's index and whether the plan
 * fetches documents (FETCH stage) — the Attendance dashboards are designed to be
 * answered from the `analytics_by_subject` / `analytics_by_teacher` indexes
 * without one. Read-only. Needs MONGO_URI (and optionally DB_NAME) like the server.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import Attendance from "../models/Attendance.js";
import Student from "../models/Student.js";
import Subject from "../models/Subject.js";

dotenv.config();

const collegeId = process.argv[2];
if (!collegeId) {
  console.error("Usage: node scripts/explainAnalytics.js <collegeId>");
  process.exit(1);
}

const stagesOf = (plan, out = []) => {
  if (!plan || typeof plan !== "object") return out;
  if (plan.stage) out.push(plan.stage + (plan.indexName ? `(${plan.indexName})` : ""));
  for (const k of ["inputStage", "queryPlan"]) stagesOf(plan[k], out);
  for (const c of plan.inputStages || []) stagesOf(c, out);
  return out;
};

const pipelines = {
  "Subject Analytics — sessions per subject+type (Attendance)": [Attendance, [
    { $match: { collegeId, isDeleted: false } },
    { $group: { _id: { subjectId: "$subjectId", classType: "$classType" }, sessions: { $sum: 1 }, last: { $max: "$date" }, p: { $sum: "$summary.presentCount" }, t: { $sum: "$summary.totalStudents" } } },
  ]],
  "Teacher Performance — sessions per teacher (Attendance)": [Attendance, [
    { $match: { collegeId, isDeleted: false } },
    { $group: { _id: "$teacher", sessions: { $sum: 1 }, last: { $max: "$date" }, p: { $sum: "$summary.presentCount" }, t: { $sum: "$summary.totalStudents" } } },
  ]],
  "Active students per department/batch/shift (Student)": [Student, [
    { $match: { collegeId, isActive: true } },
    { $group: { _id: { department: "$department", batch: "$batch", shift: "$shift" }, count: { $sum: 1 } } },
  ]],
  "Subjects per teacher (Subject)": [Subject, [
    { $match: { collegeId } },
    { $group: { _id: "$teacher", n: { $sum: 1 }, last: { $max: "$createdAt" } } },
  ]],
};

await connectForScript();
try {
  for (const [label, [Model, pipeline]] of Object.entries(pipelines)) {
    const ex = await Model.aggregate(pipeline).explain("executionStats");
    const cursorPlan = ex.stages?.[0]?.$cursor?.queryPlanner?.winningPlan || ex.queryPlanner?.winningPlan;
    const stats = ex.stages?.[0]?.$cursor?.executionStats || ex.executionStats;
    const stages = stagesOf(cursorPlan);
    console.log(`\n${label}\n  plan:      ${stages.join(" → ") || "(unknown)"}`);
    console.log(`  fetches documents: ${stages.includes("FETCH") ? "YES" : "no (covered)"}`);
    if (stats) console.log(`  keys examined: ${stats.totalKeysExamined}  docs examined: ${stats.totalDocsExamined}  returned: ${stats.nReturned}`);
  }
} finally {
  await mongoose.disconnect();
}
