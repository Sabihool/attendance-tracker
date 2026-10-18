import mongoose from "mongoose";

// ─── Settings Schema (singleton) ───────────────────────────────────────────────
// A single document holds system-wide, admin-controlled configuration values.
// Currently only the consecutive-absence alert threshold, but this is the
// natural place to add future global toggles without more hardcoded values.
const settingsSchema = new mongoose.Schema(
  {
    // Number of consecutive absences (in a single subject) before the system
    // automatically raises an alert. Replaces the old hardcoded value of 3.
    consecutiveAbsenceLimit: {
      type: Number,
      required: true,
      min: [1, "Consecutive absence limit must be at least 1"],
      max: [100, "Consecutive absence limit cannot exceed 100"],
      default: 3,
    },
    // Owning college (Part 12): ONE settings document PER COLLEGE. Previously a
    // single global document meant one college's admin changing the streak limit
    // changed it for every college. `null` = the legacy global document (kept for
    // college-less legacy accounts; copied to every college by the migration).
    collegeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// At most one settings document per college (concurrent first reads race into
// this and the loser re-reads the winner's document).
settingsSchema.index({ collegeId: 1 }, { unique: true });

settingsSchema.methods.toPublicJSON = function () {
  return {
    consecutiveAbsenceLimit: this.consecutiveAbsenceLimit,
    updatedBy: this.updatedBy,
    updatedAt: this.updatedAt,
  };
};

const Settings = mongoose.model("Settings", settingsSchema);
export default Settings;
