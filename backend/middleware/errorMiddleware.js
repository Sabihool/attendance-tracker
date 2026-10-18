import multer from "multer";

/**
 * Global error handler middleware
 */
export const errorHandler = (err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || "Internal Server Error";

  // ── Multer upload errors ───────────────────────────────────────────────────
  if (err instanceof multer.MulterError) {
    status = 400;
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        message = "File too large. Maximum allowed size is 2 MB.";
        break;
      case "LIMIT_FILE_COUNT":
        message = "Too many files. Upload one file at a time.";
        break;
      case "LIMIT_UNEXPECTED_FILE":
        message = `Unexpected field "${err.field}". Use the field name "file".`;
        break;
      default:
        message = `Upload error: ${err.message}`;
    }
  }

  // ── Multer / custom file filter errors (thrown as plain Error) ────────────
  // e.g. "Only .json files are allowed."
  if (
    status === 500 &&
    err.message &&
    (err.message.includes("Only") || err.message.includes("required in the form body"))
  ) {
    status = 400;
  }

  // ── Mongoose CastError (invalid ObjectId) ─────────────────────────────────
  if (err.name === "CastError") {
    status = 400;
    message = "Invalid resource ID format.";
  }

  // ── Mongoose duplicate key error ──────────────────────────────────────────
  if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0] || "field";
    message = `Duplicate value for '${field}'. Please use a different value.`;
  }

  // ── Mongoose validation error ─────────────────────────────────────────────
  if (err.name === "ValidationError") {
    status = 422;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(", ");
  }

  // ── Body-parser errors (malformed / oversized JSON) ───────────────────────
  if (err.type === "entity.parse.failed") {
    status = 400;
    message = "Malformed request body.";
  } else if (err.type === "entity.too.large") {
    status = 413;
    message = "Request body is too large.";
  }

  // ── Server errors never leak internals ────────────────────────────────────
  // Full detail goes to the server log only; the client gets a generic message.
  if (status >= 500) {
    console.error(`❌ [${status}] ${err.message}`, process.env.NODE_ENV === "production" ? "" : err.stack || "");
    return res.status(status).json({
      success: false,
      message: "Something went wrong on our side. Please try again later.",
      code: "SERVER_ERROR",
    });
  }

  console.error(`❌ [${status}] ${message}`);

  res.status(status).json({
    success: false,
    message,
  });
};
