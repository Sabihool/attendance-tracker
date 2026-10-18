import College from "../models/College.js";
import User from "../models/User.js";
import { runInTransaction } from "../utils/txUtils.js";
import { generateToken, buildTokenPayload } from "../utils/token.js";
import { generateCollegeId, COLLEGE_ID_PATTERN } from "../utils/collegeId.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { parseSearchParams, buildSearchFilter, rankColleges, toSearchResult, SEARCH_LIMITS } from "../utils/collegeSearch.js";
import { validateCollegeRegistration, buildDedupeKey } from "../validators/collegeValidator.js";
import { seedCollegeDefaults } from "../services/academicDefaults.js";
import { seedCollegeCategories } from "../services/categoryDefaults.js";

const MAX_ID_ATTEMPTS = 5;

const isDup = (err, field) =>
  err?.code === 11000 &&
  (err.keyPattern?.[field] !== undefined || err.keyValue?.[field] !== undefined ||
    String(err.message || "").includes(field));

/**
 * Factory so the handler can be unit-tested with fake models/tx helpers.
 * Production wiring is the default export below.
 */
export const createRegisterCollege = (deps) => async (req, res, next) => {
  const { College, User, runInTransaction, generateToken, buildTokenPayload, generateCollegeId, seedCollegeDefaults, seedCollegeCategories } = deps;
  try {
    // 1. Validate + whitelist. Anything else in the body (role, collegeId,
    //    approved, …) is discarded here and can never reach the database.
    const { ok, errors, values } = validateCollegeRegistration(req.body);
    if (!ok) {
      return res.status(400).json({
        success: false,
        message: "Please correct the highlighted fields.",
        errors,
      });
    }

    // 2. Friendly duplicate pre-checks (the unique indexes remain the real guard)
    const dedupeKey = buildDedupeKey({
      name: values.collegeName, country: values.country, district: values.district,
    });
    if (await User.exists({ email: values.adminEmail })) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
        errors: { adminEmail: "An account with this email already exists." },
      });
    }
    if (await College.exists({ dedupeKey })) {
      return res.status(409).json({
        success: false,
        message: "This college is already registered in this country and district. Ask its administrator to add you, or check the details.",
        errors: { collegeName: "A college with this name already exists in this district." },
      });
    }

    // 3. Create college + initial admin atomically
    let created;
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      try {
        created = await runInTransaction(async (session) => {
          const opts = session ? { session } : {};

          const [college] = await College.create(
            [{
              collegeId: generateCollegeId(),         // server-generated only
              name: values.collegeName,
              country: values.country,
              district: values.district,
              dedupeKey,
              status: "active",
            }],
            opts
          );

          try {
            const [admin] = await User.create(
              [{
                name: values.adminName,
                email: values.adminEmail,
                password: values.password,            // hashed by User pre-save hook (bcrypt)
                role: "admin",                        // fixed — never from client
                approved: true,
                collegeId: college.collegeId,         // fixed — never from client
              }],
              opts
            );
            college.createdBy = admin._id;
            await college.save(opts);
            return { college, admin };
          } catch (err) {
            // Without a transaction (standalone dev MongoDB) undo the college manually
            if (!session) await College.deleteOne({ _id: college._id }).catch(() => {});
            throw err;
          }
        });
        break;
      } catch (err) {
        if (isDup(err, "collegeId") && attempt < MAX_ID_ATTEMPTS) continue; // ID collision: retry
        throw err;
      }
    }

    // 3b. Part 9: every college gets its OWN default departments and shifts.
    //     Best effort — a seeding hiccup must never undo a successful
    //     registration (start-up re-seeds colleges that have none).
    if (typeof seedCollegeDefaults === "function") {
      try {
        await seedCollegeDefaults(created.college.collegeId);
      } catch (err) {
        console.error("⚠️  Could not seed default departments/shifts:", err.message);
      }
    }

    // 3c. Part 12: ...and its OWN attendance categories (Theory/Lab/Tutorial with
    //     their default credits), also best effort (start-up re-seeds).
    if (typeof seedCollegeCategories === "function") {
      try {
        await seedCollegeCategories(created.college.collegeId);
      } catch (err) {
        console.error("⚠️  Could not seed default attendance categories:", err.message);
      }
    }

    // 4. Respond — public projections only (no password hash, no dedupeKey)
    const token = generateToken(buildTokenPayload(created.admin));
    return sendSuccess(
      res,
      { token, user: created.admin.toPublicJSON(), college: created.college.toPublicJSON() },
      "College account created successfully.",
      201
    );
  } catch (err) {
    if (isDup(err, "email")) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists.",
        errors: { adminEmail: "An account with this email already exists." },
      });
    }
    if (isDup(err, "dedupeKey")) {
      return res.status(409).json({
        success: false,
        message: "This college is already registered in this country and district.",
        errors: { collegeName: "A college with this name already exists in this district." },
      });
    }
    next(err);
  }
};

// POST /api/colleges/register
export const registerCollege = createRegisterCollege({
  College, User, runInTransaction, generateToken, buildTokenPayload, generateCollegeId, seedCollegeDefaults, seedCollegeCategories,
});

/**
 * GET /api/colleges/search?q=feni&limit=10   (public, rate-limited)
 *
 * Returns ONLY { collegeId, name, district, country } of ACTIVE colleges.
 * Blank / one-character queries return an empty list (never the whole table);
 * malformed input (arrays, objects, over-long text, bad limit) gets 400.
 */
export const createSearchColleges = ({ College }) => async (req, res, next) => {
  try {
    const parsed = parseSearchParams(req.query);
    if (!parsed.ok) return sendError(res, parsed.message, 400);

    res.set("Cache-Control", "public, max-age=30");

    if (parsed.empty) {
      return sendSuccess(res, { colleges: [], count: 0, minQueryLength: SEARCH_LIMITS.minQueryLength }, "Type at least 2 characters to search.");
    }

    const rows = await College.find(buildSearchFilter(parsed.tokens))
      .select("collegeId name district country -_id") // explicit whitelist
      .sort({ nameKey: 1 })
      .limit(SEARCH_LIMITS.candidatePool)
      .maxTimeMS(3000)
      .lean();

    const colleges = rankColleges(rows, parsed.tokens, parsed.limit, parsed.phrase).map(toSearchResult);
    return sendSuccess(res, { colleges, count: colleges.length, minQueryLength: SEARCH_LIMITS.minQueryLength }, "Colleges fetched.");
  } catch (err) {
    next(err);
  }
};

export const searchColleges = createSearchColleges({ College });

/**
 * Used by teacher signup (and any future public join flow): confirm the client's
 * collegeId is a real, ACTIVE college. Returns the college or null.
 * Input is checked against the ID pattern first, so operators like
 * `{ "$ne": "" }` can never reach the query.
 */
export const findActiveCollegeById = async (College, collegeId) => {
  if (typeof collegeId !== "string" || !COLLEGE_ID_PATTERN.test(collegeId)) return null;
  return College.findOne({ collegeId, status: "active" }).select("collegeId name").lean();
};
