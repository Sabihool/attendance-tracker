import mongoose from "mongoose";

// ─── Valid enum values ────────────────────────────────────────────────────────
// Departments, Shifts, and Attendance Categories are all stored in separate,
// admin-managed DB collections (Department / Shift / AttendanceCategory).
// At model level we intentionally do NOT hard-code any of them so admin
// changes take effect everywhere without a schema change or redeploy.
//
// Only COLORS remains a fixed set — it's a UI-only cosmetic choice, not a
// business rule the spec asks to make dynamic.
const COLORS = ["brand", "purple", "green", "amber", "rose", "cyan", "blue", "orange"];

// ─── Subject Schema ───────────────────────────────────────────────────────────
const subjectSchema = new mongoose.Schema(
  {
    subjectName: {
      type: String,
      required: [true, "Subject name is required"],
      trim: true,
      minlength: [2, "Subject name must be at least 2 characters"],
      maxlength: [150, "Subject name cannot exceed 150 characters"],
    },

    subjectCode: {
      type: String,
      required: [true, "Subject code is required"],
      trim: true,
      uppercase: true,
      minlength: [2, "Subject code must be at least 2 characters"],
      maxlength: [20, "Subject code cannot exceed 20 characters"],
      match: [
        /^[A-Z0-9\-]+$/,
        "Subject code can only contain letters, numbers, and hyphens",
      ],
    },

    // ── Batch replaces semester ───────────────────────────────────────────────
    batch: {
      type: String,
      required: [true, "Batch is required"],
      trim: true,
      maxlength: [10, "Batch cannot exceed 10 characters"],
    },

    department: {
      type: String,
      required: [true, "Department is required"],
      trim: true,
    },

    // Validated dynamically against the Shift collection in subjectController.
    shift: {
      type: String,
      required: [true, "Shift is required"],
      trim: true,
    },

    // ── Legacy "Subject Type" field — NO LONGER set at subject creation ──────
    // Attendance categories are now chosen per-session when taking attendance
    // (see Attendance.classType), not tied to the subject itself, since a
    // single subject can have both Theory and Lab sessions. This field is
    // kept optional purely for backward compatibility with subjects created
    // before this change, and with reports/exports that still read it.
    creditType: {
      type: String,
      trim: true,
    },

    // Legacy per-subject credit value — no longer set at creation. Kept
    // optional for the same backward-compatibility reason as creditType.
    credits: {
      type: Number,
      min: [0, "Credits cannot be negative"],
      max: [20, "Credits cannot exceed 20"],
    },

    color: {
      type: String,
      enum: {
        values: COLORS,
        message: `Color must be one of: ${COLORS.join(", ")}`,
      },
      default: "brand",
    },

    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Teacher reference is required"],
    },

    // Owning college. Server-set from the creating teacher's/admin's session.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },

    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// UNIQUENESS (reviewed in Part 11). The only unique rule is one subject code per
// teacher. A teacher belongs to exactly one college, and admins can only assign a
// subject to a teacher of their own college, so this is already a per-college rule:
// two colleges may use the same code, the same name, even the same code under
// teachers with identical names. Subject NAMES are intentionally not unique
// (the same course is often offered to several batches/shifts). Do not make
// subjectCode globally unique.
subjectSchema.index({ subjectCode: 1, teacher: 1 }, { unique: true });
// Admin listing of one teacher's subjects inside a college (assignment views).
subjectSchema.index({ collegeId: 1, teacher: 1 });
subjectSchema.index({ teacher: 1, createdAt: -1 });
// College-wide listings, the academic-structure aggregation, department/shift
// in-use checks and rename propagation. Replaces { department: 1, batch: 1 }.
subjectSchema.index({ collegeId: 1, department: 1, batch: 1, shift: 1 });
subjectSchema.index({ collegeId: 1, isArchived: 1, createdAt: -1 });

subjectSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    subjectName: this.subjectName,
    subjectCode: this.subjectCode,
    batch: this.batch,
    department: this.department,
    shift: this.shift,
    creditType: this.creditType,
    subjectType: this.creditType, // alias — see comment above
    credits: this.credits,
    color: this.color,
    teacher: this.teacher,
    isArchived: this.isArchived,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Subject = mongoose.model("Subject", subjectSchema);
export default Subject;
export { COLORS };
