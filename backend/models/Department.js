import mongoose from "mongoose";

// ─── Department Schema ────────────────────────────────────────────────────────
// Departments are fully dynamic — created and deleted by admin.
const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Department name is required"],
      trim: true,
      minlength: [2, "Department name must be at least 2 characters"],
      maxlength: [150, "Department name cannot exceed 150 characters"],
    },
    // Owning college (public id, e.g. "COL-7K2M9XQ4TB"). Set by the server from
    // the authenticated session only. `null` = legacy single-college data that
    // has not been assigned yet (see utils/academicBackfill.js).
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true, // a department can never be moved to another college
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// A department name is unique WITHIN a college (case-insensitively), never
// across colleges: two colleges may both have "Computer Science and
// Technology". The collation makes the database itself reject "cst" when "CST"
// exists in the same college, even if two requests race past the controller's
// pre-check. This replaces the old global `name_1` unique index, which must be
// dropped (see utils/academicIndexMigration.js).
departmentSchema.index(
  { collegeId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);

const Department = mongoose.model("Department", departmentSchema);
export default Department;
