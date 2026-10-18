import mongoose from "mongoose";
import { buildSearchTokens, buildNameKey, toSearchResult } from "../utils/collegeSearch.js";

/**
 * College — one institution (tenant) on the platform.
 *
 * `collegeId` is the public, server-generated identifier. It is NEVER taken
 * from client input. `_id` remains the internal Mongo key.
 *
 * `dedupeKey` is a normalised "name|country|district" string with a unique
 * index, so the same institution cannot be registered twice (case/spacing
 * differences are ignored).
 */
const collegeSchema = new mongoose.Schema(
  {
    collegeId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
    },
    name:     { type: String, required: true, trim: true, maxlength: 120 },
    country:  { type: String, required: true, trim: true, maxlength: 80 },
    district: { type: String, required: true, trim: true, maxlength: 80 },

    dedupeKey: { type: String, required: true, unique: true, select: false },

    // Search support (maintained by the pre-validate hook; see utils/collegeSearch.js).
    // Not required, so colleges created before Part 7 stay valid until backfilled.
    // select:false keeps them out of every normal query/response.
    searchTokens: { type: [String], default: undefined, select: false },
    nameKey:      { type: String, select: false },

    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },

    // The initial administrator (set when the college is registered)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Public autocomplete lookup: active colleges, matched by token prefix.
// Index = equality on status, then an anchored-prefix range on the multikey field.
collegeSchema.index({ status: 1, searchTokens: 1 });

collegeSchema.pre("validate", function (next) {
  if (
    this.isNew ||
    this.isModified("name") || this.isModified("district") || this.isModified("country") ||
    !this.searchTokens || this.searchTokens.length === 0
  ) {
    this.searchTokens = buildSearchTokens(this);
    this.nameKey = buildNameKey(this.name);
  }
  next();
});

collegeSchema.methods.toSearchResult = function () {
  return toSearchResult(this);
};

collegeSchema.methods.toPublicJSON = function () {
  return {
    collegeId: this.collegeId,
    name: this.name,
    country: this.country,
    district: this.district,
    status: this.status,
    createdAt: this.createdAt,
  };
};

const College = mongoose.model("College", collegeSchema);
export default College;
