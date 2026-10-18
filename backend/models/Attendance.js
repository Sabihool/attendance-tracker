import mongoose from "mongoose";

// ─── Class types / credit weights ─────────────────────────────────────────────
// NOTE: These used to be hardcoded here (CLASS_TYPES + CLASS_WEIGHTS). They
// are now fully dynamic — see models/AttendanceCategory.js. `classType`
// stores the admin-defined category name (validated in attendanceController
// against that collection) and `classWeight` stores the resolved credit value
// for THIS specific session (auto-filled from the category at save time, but
// editable per-session by the teacher — see attendanceController.saveAttendance).
//
// We deliberately snapshot the credit value onto each record instead of
// looking it up live every time, so that editing a category's credit value
// later does not silently rewrite the historical record of what a student
// actually earned/missed.

// ─── Student attendance subdocument ──────────────────────────────────────────
const studentAttendanceSchema = new mongoose.Schema(
  {
    studentId: {
      type: String,
      required: [true, "Student ID is required"],
      trim: true,
    },
    roll: {
      type: String,
      required: [true, "Student roll is required"],
      trim: true,
    },
    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ["present", "absent"],
        message: "Status must be 'present' or 'absent'",
      },
      required: [true, "Attendance status is required"],
    },
  },
  { _id: false }
);

// ─── Attendance Schema ────────────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema(
  {
    // ── Which subject this attendance belongs to ──────────────────────────────
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Subject ID is required"],
      index: true,
    },

    // ── Which teacher recorded this attendance ────────────────────────────────
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Teacher reference is required"],
      index: true,
    },

    // ── Owning college (Part 12) ──────────────────────────────────────────────
    // Public college id, e.g. "COL-7K2M9XQ4TB". Set by the server from the
    // authenticated session (see utils/tenantScope.js → scopedModel.create),
    // never from the request, and always equal to the college of the subject,
    // the teacher, every student and the category. `immutable` stops any update
    // from moving a session to another college. `null` = legacy row that the
    // migration (utils/attendanceBackfill.js) could not assign.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },

    // ── Date of the class (stored as UTC date, no time) ───────────────────────
    date: {
      type: Date,
      required: [true, "Date is required"],
    },

    // ── Attendance category (e.g. Theory / Lab / Event / any admin-defined
    // category). Validated dynamically in attendanceController — see note above.
    classType: {
      type: String,
      required: [true, "Attendance category is required"],
      trim: true,
    },

    // ── Credit value for this specific session (auto-filled from the
    // category, teacher-editable, snapshotted permanently) ────────────────────
    classWeight: {
      type: Number,
      min: [0, "Credit value cannot be negative"],
      max: [20, "Credit value cannot exceed 20"],
    },

    // ── Array of student attendance records ───────────────────────────────────
    students: {
      type: [studentAttendanceSchema],
      validate: {
        validator: function (arr) {
          return arr && arr.length > 0;
        },
        message: "At least one student record is required",
      },
    },

    // ── Computed summary (stored for fast queries) ────────────────────────────
    summary: {
      totalStudents: { type: Number, default: 0 },
      presentCount: { type: Number, default: 0 },
      absentCount: { type: Number, default: 0 },
    },

    // ── Optional note ─────────────────────────────────────────────────────────
    note: {
      type: String,
      trim: true,
      maxlength: [500, "Note cannot exceed 500 characters"],
      default: "",
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ── PART 19: Trash & Restore Fields ──────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────

    // ── Soft delete flag ──────────────────────────────────────────────────────
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    // ── When the record was moved to trash ────────────────────────────────────
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // ── Who deleted the record ────────────────────────────────────────────────
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ── Restore history (audit trail) ────────────────────────────────────────
    restoreHistory: [
      {
        restoredAt: { type: Date },
        restoredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Every index leads with collegeId: every query is college-scoped (Part 12), so
// the tenant is the cheapest possible first cut.
//
// Prevent duplicate active attendance for same subject + date + classType
// Allow multiple deleted records to coexist (soft deletes bypass uniqueness).
// (A subject belongs to exactly one college, so this was already a per-college
// rule; collegeId in the key makes that explicit and lets the college-scoped
// duplicate check use the index. The legacy index without collegeId is dropped
// by utils/attendanceBackfill.js.)
attendanceSchema.index(
  { collegeId: 1, subjectId: 1, date: 1, classType: 1, isDeleted: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);
// Efficient teacher-scoped queries
attendanceSchema.index({ collegeId: 1, teacher: 1, date: -1 });
// Subject + date range queries
attendanceSchema.index({ collegeId: 1, subjectId: 1, date: -1 });
// Trash cleanup — find expired trash items fast (the nightly job runs across colleges)
attendanceSchema.index({ isDeleted: 1, deletedAt: 1 });
// College trash views / stats
attendanceSchema.index({ collegeId: 1, isDeleted: 1, deletedAt: -1 });
// Global Student Directory (Feature 3) and student analytics — the attendance
// aggregations match on "students.studentId" for a batch of students at a
// time (never the whole collection unfiltered), inside one college, so this
// multikey index keeps that $match/$unwind fast even with thousands of sessions.
attendanceSchema.index({ collegeId: 1, isDeleted: 1, "students.studentId": 1 });

// Dashboard aggregations (Part 13). Each leads with collegeId (the tenant $match is
// always the first stage) and then carries EVERY field its $group reads — the
// session's date, type and summary counts — so MongoDB can answer the dashboard
// from the index alone instead of loading each session document (which embeds the
// whole roster). Two shapes, because the dashboards group two ways:
//   by subject (Subject Analytics: totals, last session, most-used type), and
//   by teacher (Teacher Performance: sessions, last activity, weighted %).
// Cost: two extra index entries per session written (a few writes per class).
// Not verified with explain() on a real MongoDB — see scripts/explainAnalytics.js.
attendanceSchema.index(
  { collegeId: 1, isDeleted: 1, subjectId: 1, classType: 1, date: 1, "summary.presentCount": 1, "summary.totalStudents": 1 },
  { name: "analytics_by_subject" }
);
attendanceSchema.index(
  { collegeId: 1, isDeleted: 1, teacher: 1, date: 1, "summary.presentCount": 1, "summary.totalStudents": 1 },
  { name: "analytics_by_teacher" }
);

// ─── Pre-save: default classWeight + compute summary ───────────────────────────
// classWeight is normally resolved and passed in explicitly by the controller
// (from the live AttendanceCategory credit value, or a teacher override). This
// hook is just a safety net so a record is never left without a numeric weight.
attendanceSchema.pre("save", function (next) {
  if (this.classWeight === undefined || this.classWeight === null) {
    this.classWeight = 1;
  }

  // Compute summary
  if (this.isModified("students") || this.isNew) {
    const total = this.students.length;
    const present = this.students.filter((s) => s.status === "present").length;
    this.summary = {
      totalStudents: total,
      presentCount: present,
      absentCount: total - present,
    };
  }

  next();
});

// ─── Instance method: public JSON ─────────────────────────────────────────────
attendanceSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    subjectId: this.subjectId,
    teacher: this.teacher,
    date: this.date,
    classType: this.classType,
    classWeight: this.classWeight,
    students: this.students,
    summary: this.summary,
    note: this.note,
    isDeleted: this.isDeleted,
    deletedAt: this.deletedAt,
    deletedBy: this.deletedBy,
    restoreHistory: this.restoreHistory,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// ─── Instance method: days remaining before permanent deletion ────────────────
attendanceSchema.methods.daysUntilPermanentDelete = function () {
  if (!this.isDeleted || !this.deletedAt) return null;
  const TRASH_TTL_DAYS = 10;
  const expiry = new Date(this.deletedAt.getTime() + TRASH_TTL_DAYS * 24 * 60 * 60 * 1000);
  const msLeft = expiry - new Date();
  return Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
};

const Attendance = mongoose.model("Attendance", attendanceSchema);
export default Attendance;
