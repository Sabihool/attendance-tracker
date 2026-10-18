import mongoose from "mongoose";

/**
 * ConsecutiveAbsenceAlert Model
 * ─────────────────────────────────────────────────────────────────────────────
 * Tracks students who have missed 3 or more consecutive classes in a subject.
 * Alerts persist until a teacher manually removes them, even if the student
 * resumes attendance. This enables long-term monitoring and historical tracking.
 */
const consecutiveAbsenceAlertSchema = new mongoose.Schema(
  {
    // ── Owning college (Part 12) ───────────────────────────────────────────────
    // Server-set from the session / the subject's college. Student ids are only
    // unique within a college, so an alert is always read and written together
    // with its collegeId. `immutable`: an alert never moves between colleges.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },

    // ── Student reference ──────────────────────────────────────────────────────
    studentId: {
      type: String,
      required: [true, "Student ID is required"],
      trim: true,
      index: true,
    },

    studentName: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
    },

    studentRoll: {
      type: String,
      required: [true, "Student roll is required"],
      trim: true,
    },

    department: {
      type: String,
      required: [true, "Department is required"],
      trim: true,
    },

    batch: {
      type: String,
      required: [true, "Batch is required"],
      trim: true,
    },

    // ── Subject reference ──────────────────────────────────────────────────────
    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: [true, "Subject ID is required"],
      index: true,
    },

    subjectName: {
      type: String,
      trim: true,
    },

    // ── Teacher who owns this subject ──────────────────────────────────────────
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Teacher ID is required"],
      index: true,
    },

    // ── Absence tracking ───────────────────────────────────────────────────────
    consecutiveMissCount: {
      type: Number,
      required: true,
      // Was min: 3, which silently made every admin-configured threshold of 1 or 2
      // (Settings allows 1–100) unable to ever create an alert — the validation
      // error was swallowed by checkAndCreateAlerts. The count can never be below
      // the college's limit, and the limit is >= 1.
      min: 1,
      default: 3,
    },

    // ── Teacher note (editable) ────────────────────────────────────────────────
    note: {
      type: String,
      trim: true,
      maxlength: [1000, "Note cannot exceed 1000 characters"],
      default: "",
    },

    // ── Alert lifecycle ────────────────────────────────────────────────────────
    removed: {
      type: Boolean,
      default: false,
      index: true,
    },

    removedAt: {
      type: Date,
      default: null,
    },

    removedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true, // createdAt = alert creation date
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Prevent duplicate active alerts for the same student + subject combo
// (per college; the legacy index without collegeId is dropped by
// utils/attendanceBackfill.js)
consecutiveAbsenceAlertSchema.index(
  { collegeId: 1, studentId: 1, subjectId: 1, removed: 1 },
  {
    unique: true,
    partialFilterExpression: { removed: false },
  }
);

// Teacher dashboard queries
consecutiveAbsenceAlertSchema.index({ collegeId: 1, teacherId: 1, removed: 1, createdAt: -1 });

// Admin/student analytics queries
consecutiveAbsenceAlertSchema.index({ collegeId: 1, studentId: 1, createdAt: -1 });

const ConsecutiveAbsenceAlert = mongoose.model(
  "ConsecutiveAbsenceAlert",
  consecutiveAbsenceAlertSchema
);

export default ConsecutiveAbsenceAlert;
