import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { APPROVAL_STATUS, buildPublicUser } from "../utils/approval.js";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters"],
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false, // Never return password in queries by default
    },

    role: {
      type: String,
      enum: {
        values: ["admin", "teacher"],
        message: "Role must be either 'admin' or 'teacher'",
      },
      required: [true, "Role is required"],
    },

    approved: {
      type: Boolean,
      default: false, // Teachers must be approved by admin
    },

    // Part 8 — registration review state. Deliberately NO schema default:
    // Mongoose applies defaults to old documents on read, which would turn
    // legacy approved users into "pending". Code always sets it explicitly,
    // and utils/approval.js interprets a missing value from `approved`.
    approvalStatus: {
      type: String,
      enum: Object.values(APPROVAL_STATUS),
    },
    approvalReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
    approvalReviewedAt: { type: Date, default: undefined },

    // Tenant link. Always assigned by the server (see collegeController).
    // Optional for now so existing single-college users keep working until
    // the migration part assigns them to the first college.
    collegeId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },

    // Session version. Bumped (never decremented) whenever something that changes
    // what this account may do is altered — role, college membership, forced
    // sign-out. JWTs carry the version they were issued under (`av`); a token whose
    // version no longer matches is rejected. Absent on old documents = 0.
    // Only the server writes it (see services/accountSecurityService.js).
    authVersion: {
      type: Number,
      default: 0,
      min: 0,
    },

    department: {
      type: String,
      trim: true,
      default: "",
    },

    phone: {
      type: String,
      trim: true,
      default: "",
      match: [/^[+\d\s\-().]{0,20}$/, "Please enter a valid phone number"],
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

// Admin queue: "this college's teachers, by status, oldest/newest first".
userSchema.index({ collegeId: 1, role: 1, approved: 1, createdAt: -1 });

// ─── Hash password before saving ─────────────────────────────────────────────
userSchema.pre("save", async function (next) {
  // Only hash if password is new or modified
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// ─── Instance method: compare passwords ──────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ─── Instance method: return safe public profile ─────────────────────────────
userSchema.methods.toPublicJSON = function () {
  return buildPublicUser(this);
};

const User = mongoose.model("User", userSchema);
export default User;
