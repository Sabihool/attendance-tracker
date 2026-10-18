import mongoose from "mongoose";

// ─── Student Schema ───────────────────────────────────────────────────────────
// A Student document represents one student inside a department/batch/shift group.
// Multiple uploads to the same group REPLACE the previous list (upsert by studentId).

const studentSchema = new mongoose.Schema(
  {
    // ── Student identity ──────────────────────────────────────────────────────
    studentId: {
      type: String,
      required: [true, "Student ID is required"],
      trim: true,
    },

    roll: {
      type: String,
      required: [true, "Roll is required"],
      trim: true,
    },

    name: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [150, "Name cannot exceed 150 characters"],
    },

    // ── Academic group — mirrors Subject schema ───────────────────────────────
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

    // Shift is intentionally NOT a fixed enum — shifts are admin-managed via
    // the Shift collection (see models/Shift.js + shiftController.js). Value
    // is validated against that collection at the controller layer so new
    // shifts work without a schema change.
    shift: {
      type: String,
      required: [true, "Shift is required"],
      trim: true,
    },

    // Owning college. Server-set from the session; never from the request.
    // `immutable` stops a student being moved to another college by any update.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },

    // ── Optional extra fields ("Other information" per spec section 8) ────────
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    section: {
      type: String,
      trim: true,
      default: "",
    },

    // ── Source tracking ───────────────────────────────────────────────────────
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    sourceFile: {
      type: String, // relative path inside /uploads/
      trim: true,
    },

    // ── Soft delete ───────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Every uniqueness rule is now PER COLLEGE: two colleges can both have student
// "2023-001" in "CST / 2024 / Morning". Within one college the old rules are
// unchanged. Legacy single-college data has collegeId = null and keeps behaving
// exactly as before (null is just another, single, "college" for these indexes).
//
// The old indexes (studentId_1_department_1_batch_1_shift_1, studentId_1,
// roll_1_department_1_batch_1_shift_1, department_1_batch_1_shift_1) are
// dropped by utils/academicIndexMigration.js — Mongoose never drops indexes.

// A studentId is unique within a department + batch + shift group of a college
// (kept for the bulk-upload/upsert flow, which replaces one group at a time).
studentSchema.index(
  { collegeId: 1, studentId: 1, department: 1, batch: 1, shift: 1 },
  { unique: true }
);

// ── Duplicate registration prevention (spec section 1) ────────────────────────
// A Registration No. (studentId) must never be reused by another active student
// of the SAME college. Partial filter on isActive lets a removed student's old
// registration number be reissued.
studentSchema.index(
  { collegeId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Roll Number only needs to be unique within its own college + department/
// batch/shift group, but it must be unique THERE at the DB level too.
studentSchema.index(
  { collegeId: 1, roll: 1, department: 1, batch: 1, shift: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

// Group lookups, batch lists, directory counts and the academic-structure
// aggregation: "this college's active students of a group".
studentSchema.index({ collegeId: 1, isActive: 1, department: 1, batch: 1, shift: 1 });

// Fast teacher dashboard queries
studentSchema.index({ uploadedBy: 1 });

// ─── Instance method: minimal public object ───────────────────────────────────
studentSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    studentId: this.studentId,
    roll: this.roll,
    name: this.name,
    department: this.department,
    batch: this.batch,
    shift: this.shift,
    email: this.email,
    section: this.section,
    isActive: this.isActive,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Student = mongoose.model("Student", studentSchema);
export default Student;
