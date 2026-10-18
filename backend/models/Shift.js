import mongoose from "mongoose";

// ─── Shift Schema ──────────────────────────────────────────────────────────────
// Shifts are fully dynamic — created, edited, and deleted by admin only.
// Mirrors the Department model pattern. Every module that previously hardcoded
// shift values ("morning" | "day" | "afternoon") must now read from this
// collection instead.
const shiftSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Shift name is required"],
      trim: true,
      minlength: [2, "Shift name must be at least 2 characters"],
      maxlength: [50, "Shift name cannot exceed 50 characters"],
    },
    // Optional display order so the admin can control dropdown ordering
    order: {
      type: Number,
      default: 0,
    },
    // Owning college — see models/Department.js.
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// Unique per college, case-insensitive (see models/Department.js).
shiftSchema.index(
  { collegeId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } }
);
// Dropdown order inside one college.
shiftSchema.index({ collegeId: 1, order: 1 });

shiftSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    name: this.name,
    order: this.order,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Shift = mongoose.model("Shift", shiftSchema);
export default Shift;
