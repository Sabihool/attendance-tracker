/**
 * Create ONE legacy (college-less) administrator — only needed for a brand-new single-college install
 * that is not using college self-registration (POST /api/colleges/register).
 *
 * Credentials come from the environment; nothing is hard-coded:
 *   SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (min 12 chars), MONGO_URI, DB_NAME
 *
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a long passphrase' npm run seed:admin
 *
 * Refuses to run if an admin with that e-mail already exists.
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectForScript } from "../database/connection.js";
import User from "../models/User.js";

dotenv.config();

const { SEED_ADMIN_NAME, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, MONGO_URI, DB_NAME } = process.env;

const die = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

if (!MONGO_URI) die("MONGO_URI is not set.");
if (!SEED_ADMIN_EMAIL || !/^\S+@\S+\.\S+$/.test(SEED_ADMIN_EMAIL)) die("SEED_ADMIN_EMAIL is missing or not a valid e-mail.");
if (!SEED_ADMIN_PASSWORD || SEED_ADMIN_PASSWORD.length < 12) die("SEED_ADMIN_PASSWORD is missing or shorter than 12 characters.");

try {
  await connectForScript();
  if (await User.exists({ email: SEED_ADMIN_EMAIL.toLowerCase() })) die("An account with this e-mail already exists.");
  // The User model's pre('save') hook hashes the password — do not hash it here (double hashing breaks login).
  await User.create({
    name: SEED_ADMIN_NAME || "Administrator",
    email: SEED_ADMIN_EMAIL,
    password: SEED_ADMIN_PASSWORD,
    role: "admin",
    approved: true,
    approvalStatus: "approved",
    department: "Administration",
  });
  console.log("✅ Admin created.");
  await mongoose.disconnect();
} catch (error) {
  console.error("❌ Error:", error.message);
  process.exit(1);
}
