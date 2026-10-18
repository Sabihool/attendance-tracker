import multer from "multer";
import path from "path";

// ─── Use memoryStorage so multer parses ALL form fields (department/batch/shift)
// before we decide where to put the file. With diskStorage, the destination()
// callback fires before req.body is populated, so those fields are always
// undefined — causing the 400 "Missing required fields" error.
// The controller (studentController.js) is responsible for writing the buffer
// to disk after validation.
export const uploadJson = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype;
    const isJson =
      ext === ".json" ||
      mime === "application/json" ||
      mime === "text/plain"; // some browsers send text/plain for .json

    if (isJson) {
      cb(null, true);
    } else {
      cb(
        new Error(`Only .json files are allowed. Received: ${file.originalname}`),
        false
      );
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024, // 2 MB
    files: 1,
  },
});

// ─── Sanitize a folder-name segment (no slashes, spaces → underscores) ────────
const sanitizeSegment = (str) =>
  str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, "_")
    .replace(/_+/g, "_");

// ─── Helper: build the logical upload path string for response metadata ───────
// Files live under the owning college's folder so two colleges with an identical
// department/batch/shift never share (or overwrite into) one directory. College-
// less legacy data keeps its original path.
const collegeSegment = (collegeId) => (collegeId ? `colleges/${sanitizeSegment(collegeId)}/` : "");

export const buildUploadPath = (department, batch, shift, collegeId = null) => {
  const dep = sanitizeSegment(department);
  const bat = sanitizeSegment(batch);
  const shi = sanitizeSegment(shift);
  return `uploads/${collegeSegment(collegeId)}department/${dep}/${bat}/${shi}`;
};

// ─── Helper: build the full absolute path for saving the file ─────────────────
export const buildAbsUploadPath = (department, batch, shift, collegeId = null) => {
  const dep = sanitizeSegment(department);
  const bat = sanitizeSegment(batch);
  const shi = sanitizeSegment(shift);
  return path.join(process.cwd(), "uploads", ...(collegeId ? ["colleges", sanitizeSegment(collegeId)] : []), "department", dep, bat, shi);
};
