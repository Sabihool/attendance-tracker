import mongoose from "mongoose";

// ─── AttendanceCategory Schema ─────────────────────────────────────────────────
// Replaces the hardcoded CLASS_TYPES / CLASS_WEIGHTS constants that used to
// live on the Attendance model, and the fixed CREDIT_TYPES enum that used to
// live on the Subject model.
//
// Admin can add / edit / delete categories (including the seeded defaults).
// Every category carries a credit value that is used to:
//   1. Auto-fill the credit value when a teacher takes attendance for that
//      category (teacher can still override it per-session).
//   2. Feed the student "Credit Score" calculation:
//        creditScore = Σ (attended classes of a type × credit value of that type)
const attendanceCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      // NOT globally unique any more (Part 12): unique per college, see the
      // { collegeId, name } index below. The legacy `name_1` index is dropped by
      // utils/attendanceBackfill.js.
      minlength: [2, "Category name must be at least 2 characters"],
      maxlength: [50, "Category name cannot exceed 50 characters"],
    },
    credit: {
      type: Number,
      required: [true, "Credit value is required"],
      min: [0, "Credit value cannot be negative"],
      max: [20, "Credit value cannot exceed 20"],
      default: 1,
    },
    // Owning college (Part 12). Server-set from the session; categories (and
    // their credit values) are configured by each college's own admins, so
    // "Lab = 3" in one college never affects another. `immutable`: a category
    // can never be moved to another college. `null` = legacy single-college data.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },
    // Marks the three categories that are auto-seeded on first run. Admin can
    // still edit or delete these — this flag is informational only.
    isDefault: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// A category name is unique WITHIN a college, case-insensitively (the collation
// makes the database itself reject "lab" when "Lab" exists in that college, even
// if two requests race past the controller's pre-check). Two colleges may both
// have "Theory". Same pattern as departments and shifts (Part 9).
attendanceCategorySchema.index(
  { collegeId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

attendanceCategorySchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    name: this.name,
    credit: this.credit,
    isDefault: this.isDefault,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const AttendanceCategory = mongoose.model(
  "AttendanceCategory",
  attendanceCategorySchema
);
export default AttendanceCategory;
