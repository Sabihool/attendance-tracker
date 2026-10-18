/**
 * exportController.js — FIXED
 *
 * BUGS FIXED:
 * 1. `csv-writer` (createObjectCsvWriter) was imported but NOT in package.json →
 *    runtime crash on any CSV export. Replaced with Node.js built-in CSV generation.
 * 2. buildExportData() did not filter out soft-deleted records (isDeleted: false) →
 *    trashed sessions were incorrectly included in exports.
 */

import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import archiver from "archiver";
import Attendance from "../models/Attendance.js";
import User from "../models/User.js";
import { sendError } from "../utils/response.js";
import { scopedModel, TenantScopeError } from "../utils/tenantScope.js";
import { exactNameMatch } from "../utils/academicNames.js";
import { neutralizeFormula } from "../utils/safeKey.js";
import { aggregateStudentStats } from "../utils/attendanceUtils.js";
import { getCategoryCreditMap, getCategoryMaps, calculateCreditScore } from "../utils/creditUtils.js";
import { renderAttendanceRegisterPDF, MARGIN_X } from "../utils/registerPdfBuilder.js";

// ─── Shared: format a date for display ───────────────────────────────────────
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

// ─── Part 17: filenames ──────────────────────────────────────────────────────
// Subject codes/names are user-entered text. They end up in a Content-Disposition
// header (and in ZIP entry names), so only a conservative character set is allowed:
// no quotes, slashes, CR/LF or non-ASCII — a header-injection / path-traversal guard.
const safeFilePart = (v, fallback = "export") =>
  String(v ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 60) || fallback;

// ─── Part 17: query validation ───────────────────────────────────────────────
// startDate / endDate must be plain YYYY-MM-DD (or a full ISO timestamp) strings.
// Anything else (arrays, objects such as ?startDate[$gt]=…, garbage) is a 400, not a
// query-cast 500 and never part of a database filter.
const DATE_RX = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const parseQueryDate = (v, name) => {
  if (typeof v !== "string" || !DATE_RX.test(v) || Number.isNaN(new Date(v).getTime())) {
    throw { status: 400, message: `${name} must be a valid date (YYYY-MM-DD).` };
  }
  return new Date(v);
};

// ─── FIX #2: Added isDeleted: false to filter out trashed records ─────────────
// COLLEGE SCOPING (Parts 11 + 12): attendance is read through
// scopedModel(Attendance, tenant) and the credit categories through the same
// tenant, so an export only ever contains the caller's college's sessions and is
// graded with its own college's credit rules. The subject is NOT re-read by id here. requireSubjectOwner
// already loaded it inside the caller's college and attached it as req.subject, so a
// subject id of another college can never reach an export. The "Teacher" shown is the
// subject's assigned teacher (not whoever is downloading, which for an admin was wrong),
// read only within the subject's own college; the college name is the caller's college.
const buildExportData = async (req) => {
  const subject = req.subject?.toObject ? req.subject.toObject() : req.subject;
  if (!subject) throw { status: 404, message: "Subject not found." };
  const subjectId = subject._id;
  const query = req.query || {};
  // The caller's college (from the database session). requireSubjectOwner already
  // proved the subject belongs to it; assert that again before any data is read.
  const tenant = req.tenant;
  if (!tenant || (subject.collegeId ?? null) !== (tenant.collegeId ?? null)) throw { status: 404, message: "Subject not found." };

  const teacher = await scopedModel(User, { collegeId: subject.collegeId ?? null }).findById(String(subject.teacher), { lean: true });

  // FIX: was `const filter = { subjectId };` — excluded soft-deleted records now
  const filter = { subjectId, isDeleted: false };
  if (query.startDate) filter.date = { $gte: parseQueryDate(query.startDate, "startDate") };
  if (query.endDate) {
    const end = parseQueryDate(query.endDate, "endDate");
    end.setUTCHours(23, 59, 59, 999);
    filter.date = { ...filter.date, $lte: end };
  }
  if (typeof query.classType === "string" && query.classType) filter.classType = exactNameMatch(query.classType);

  const records = await scopedModel(Attendance, tenant).find(filter).sort({ date: 1 }).lean();
  // Part 17, defence in depth: the scoped read above can only return this college's
  // sessions of this subject. If a row ever came back that is not, fail the whole export
  // (500, nothing sent) rather than print another college's data into a report.
  for (const r of records) {
    if ((r.collegeId ?? null) !== (tenant.collegeId ?? null) || String(r.subjectId) !== String(subjectId)) {
      throw new TenantScopeError("Export read returned a session outside the caller's college/subject.");
    }
  }
  const creditMap = await getCategoryCreditMap(tenant);
  const studentStats = aggregateStudentStats(records, creditMap);

  const totalWeightedClasses = records.reduce(
    (sum, r) => sum + (r.classWeight ?? creditMap[r.classType?.toLowerCase()] ?? 1),
    0
  );

  const overallAverage =
    studentStats.length > 0
      ? Math.round(
          studentStats.reduce((s, st) => s + st.percentage, 0) /
            studentStats.length
        )
      : 0;

  // Part 17: the report is headed with the caller's own college. The COLLEGE_NAME
  // environment branding is only for the legacy college-less install; a real college
  // that has no name on record gets the neutral default, never another institution's name.
  const collegeName =
    req.auth?.college?.name ||
    (tenant.collegeId ? null : process.env.COLLEGE_NAME) ||
    "Your College / Institution";

  return {
    collegeName,
    subject,
    teacher,
    records,
    studentStats,
    totalWeightedClasses,
    overallAverage,
  };
};

// ─── Register export: same data as buildExportData(), plus per-student ───────
// Credit Score (needed for the register's "Credit Score" column — see spec:
// PDF Attendance Report Format). Kept separate from buildExportData so the
// existing summary/matrix/session exports don't pay for this extra work.
const buildRegisterData = async (req) => {
  const data = await buildExportData(req);
  const maps = await getCategoryMaps(req.tenant);

  const studentStats = data.studentStats.map((st) => {
    const { creditScore } = calculateCreditScore(data.records, st.studentId, maps);
    return { ...st, creditScore };
  });

  return { ...data, studentStats };
};

// ─── Shared: build the students × sessions matrix as a CSV string ────────────
const buildMatrixCSV = ({ records, studentStats }) => {
  const sorted = [...studentStats].sort((a, b) =>
    a.roll.localeCompare(b.roll, undefined, { numeric: true })
  );
  const headers = [
    { id: "roll", title: "Roll No." },
    { id: "name", title: "Name" },
    ...records.map((r, i) => ({
      id: `s${i}`,
      title: `${fmtDate(r.date)} (${r.classType})`,
    })),
    { id: "attended", title: "Attended" },
    { id: "total", title: "Total" },
    { id: "percentage", title: "%" },
  ];
  const rows = sorted.map((st) => {
    const row = { roll: st.roll, name: st.name };
    records.forEach((rec, i) => {
      const entry = rec.students.find((s) => s.studentId === st.studentId);
      row[`s${i}`] = entry ? (entry.status === "present" ? "P" : "A") : "—";
    });
    row.attended = st.attended;
    row.total = st.total;
    row.percentage = st.percentage;
    return row;
  });
  return buildCSVString(headers, rows);
};

// ─── FIX #1: Native CSV builder (replaces csv-writer dependency) ──────────────
/** Spreadsheet rows with every text cell neutralised against formula injection (numbers untouched). */
const safeSheet = (rows) => rows.map((row) => row.map((cell) => neutralizeFormula(cell)));

const escapeCSV = (val) => {
  // Student names / notes are free text: neutralise =,+,-,@ prefixes so Excel/Sheets never run them as formulas.
  const str = val === null || val === undefined ? "" : String(typeof val === "string" ? neutralizeFormula(val) : val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const buildCSVString = (headers, rows) => {
  const head = headers.map((h) => escapeCSV(h.title)).join(",");
  const body = rows
    .map((row) => headers.map((h) => escapeCSV(row[h.id])).join(","))
    .join("\n");
  return `${head}\n${body}`;
};

// ─── PDF EXPORT ───────────────────────────────────────────────────────────────
// Uses the exact same date-paginated register layout as every other PDF in
// the Export section (see spec: "PDF Export Requirements" — this same PDF
// layout should be used everywhere). Kept as its own endpoint/filename for
// backward compatibility with the frontend's "PDF Report" button, but the
// rendering now goes through the shared renderAttendanceRegisterPDF().
export const exportPDF = async (req, res, next) => {
  try {
    const data = await buildRegisterData(req);

    const doc = new PDFDocument({
      size: "A4",
      bufferPages: true,
      margins: { top: 0, bottom: 0, left: MARGIN_X, right: MARGIN_X },
    });

    const filename = `attendance_${safeFilePart(data.subject.subjectCode)}_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    renderAttendanceRegisterPDF(doc, data);
    doc.end();
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── EXCEL EXPORT ─────────────────────────────────────────────────────────────
export const exportExcel = async (req, res, next) => {
  try {
    const data = await buildExportData(req);
    const { collegeName, subject, teacher, records, studentStats, totalWeightedClasses, overallAverage } = data;

    const wb = XLSX.utils.book_new();

    // Sheet 1: Info
    const infoRows = [
      ["Attendance Report"],
      ["College / Institution", collegeName],
      [],
      ["Subject Name", subject.subjectName],
      ["Subject Code", subject.subjectCode],
      ["Department", subject.department],
      ["Batch",    `Batch ${subject.batch}`],
      ["Shift", subject.shift],
      ...(subject.creditType ? [["Credit Type", subject.creditType], ["Credits", subject.credits]] : []),
      [],
      ["Teacher Name", teacher?.name || "—"],
      ["Teacher Email", teacher?.email || "—"],
      [],
      ["Total Sessions", records.length],
      ["Total Weighted Classes", totalWeightedClasses],
      ["Overall Average", `${overallAverage}%`],
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet(safeSheet(infoRows));
    XLSX.utils.book_append_sheet(wb, wsInfo, "Info");

    // Sheet 2: Student Summary
    const summaryHeader = ["Roll No.", "Student Name", "Attended", "Total Classes", "Percentage (%)", "Status"];
    const sorted = [...studentStats].sort((a, b) =>
      a.roll.localeCompare(b.roll, undefined, { numeric: true })
    );
    const summaryRows = [
      summaryHeader,
      ...sorted.map((st) => [
        st.roll, st.name, st.attended, st.total, st.percentage,
        st.percentage >= 75 ? "OK" : "LOW",
      ]),
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(safeSheet(summaryRows));
    XLSX.utils.book_append_sheet(wb, wsSummary, "Student Summary");

    // Sheet 3: Session Log
    const sessionHeader = ["Date", "Class Type", "Weight", "Total Students", "Present", "Absent", "Rate (%)", "Note"];
    const sessionRows = [
      sessionHeader,
      ...records.map((rec) => [
        fmtDate(rec.date),
        rec.classType,
        rec.classWeight ?? 1,
        rec.summary.totalStudents,
        rec.summary.presentCount,
        rec.summary.absentCount,
        rec.summary.totalStudents > 0
          ? Math.round((rec.summary.presentCount / rec.summary.totalStudents) * 100)
          : 0,
        rec.note || "",
      ]),
    ];
    const wsSession = XLSX.utils.aoa_to_sheet(safeSheet(sessionRows));
    XLSX.utils.book_append_sheet(wb, wsSession, "Session Log");

    // Sheet 4: Attendance Matrix
    if (records.length > 0 && studentStats.length > 0) {
      const matrixHeader = [
        "Roll No.",
        "Name",
        ...records.map((r) => `${fmtDate(r.date)} (${r.classType})`),
        "Attended",
        "Total",
        "%",
      ];
      const matrixRows = sorted.map((st) => {
        const row = [st.roll, st.name];
        records.forEach((rec) => {
          const entry = rec.students.find((s) => s.studentId === st.studentId);
          row.push(entry ? (entry.status === "present" ? "P" : "A") : "—");
        });
        row.push(st.attended, st.total, st.percentage);
        return row;
      });
      const wsMatrix = XLSX.utils.aoa_to_sheet(safeSheet([matrixHeader, ...matrixRows]));
      XLSX.utils.book_append_sheet(wb, wsMatrix, "Attendance Matrix");
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `attendance_${safeFilePart(subject.subjectCode)}_${Date.now()}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── CSV EXPORT (FIX #1: replaced csv-writer with native CSV builder) ─────────
export const exportCSV = async (req, res, next) => {
  try {
    const csvType = req.query.type || "summary";
    const data = await buildExportData(req);
    const { subject, records, studentStats } = data;

    let csvString = "";

    if (csvType === "sessions") {
      const headers = [
        { id: "date",    title: "Date" },
        { id: "type",    title: "Class Type" },
        { id: "weight",  title: "Weight" },
        { id: "total",   title: "Total Students" },
        { id: "present", title: "Present" },
        { id: "absent",  title: "Absent" },
        { id: "rate",    title: "Rate (%)" },
        { id: "note",    title: "Note" },
      ];
      const rows = records.map((rec) => ({
        date: fmtDate(rec.date),
        type: rec.classType,
        weight: rec.classWeight ?? 1,
        total: rec.summary.totalStudents,
        present: rec.summary.presentCount,
        absent: rec.summary.absentCount,
        rate: rec.summary.totalStudents > 0
          ? Math.round((rec.summary.presentCount / rec.summary.totalStudents) * 100)
          : 0,
        note: rec.note || "",
      }));
      csvString = buildCSVString(headers, rows);

    } else if (csvType === "matrix") {
      csvString = buildMatrixCSV(data);

    } else {
      // summary (default)
      const headers = [
        { id: "roll",       title: "Roll No." },
        { id: "name",       title: "Student Name" },
        { id: "attended",   title: "Attended" },
        { id: "total",      title: "Total Classes" },
        { id: "percentage", title: "Percentage (%)" },
        { id: "status",     title: "Status" },
      ];
      const sorted = [...studentStats].sort((a, b) =>
        a.roll.localeCompare(b.roll, undefined, { numeric: true })
      );
      const rows = sorted.map((st) => ({
        roll: st.roll,
        name: st.name,
        attended: st.attended,
        total: st.total,
        percentage: st.percentage,
        status: st.percentage >= 75 ? "OK" : "LOW",
      }));
      csvString = buildCSVString(headers, rows);
    }

    const filename = `attendance_${safeFilePart(subject.subjectCode)}_${safeFilePart(csvType)}_${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csvString);
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── ATTENDANCE REGISTER PDF ──────────────────────────────────────────────────
// The traditional, printable, session-by-session register (see spec: PDF
// Attendance Report Format). Used as the mandatory pre-deletion backup, but
// also usable as a standalone export.
export const exportRegisterPDF = async (req, res, next) => {
  try {
    const data = await buildRegisterData(req);

    const doc = new PDFDocument({
      size: "A4",
      bufferPages: true,
      margins: { top: 0, bottom: 0, left: MARGIN_X, right: MARGIN_X },
    });
    const filename = `${safeFilePart(data.subject.subjectCode)}_Attendance_Register_${Date.now()}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    renderAttendanceRegisterPDF(doc, data);
    doc.end();
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── Build the register PDF into an in-memory buffer (used by the ZIP bundle) ─
const buildRegisterPDFBuffer = (data) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      bufferPages: true,
      margins: { top: 0, bottom: 0, left: MARGIN_X, right: MARGIN_X },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    renderAttendanceRegisterPDF(doc, data);
    doc.end();
  });

// ─── ZIP BUNDLE (PDF + CSV) ───────────────────────────────────────────────────
// Mandatory pre-deletion backup, per spec: a single ZIP download containing
// both the printable register PDF and the raw matrix CSV, inside a neatly
// named folder — SubjectName_Attendance/{Attendance_Report.pdf, Attendance_Data.csv}
export const exportSubjectZip = async (req, res, next) => {
  try {
    const data = await buildRegisterData(req);
    const { subject } = data;

    const folderNameSafe = `${subject.subjectName}_Attendance`.replace(/[^a-zA-Z0-9_\-]+/g, "_");
    const zipFilename = `${safeFilePart(subject.subjectCode)}_Attendance_${Date.now()}.zip`;

    const [pdfBuffer, csvString] = await Promise.all([
      buildRegisterPDFBuffer(data),
      Promise.resolve(buildMatrixCSV(data)),
    ]);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFilename}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      if (res.headersSent) {
        res.destroy(err);
      } else {
        next(err);
      }
    });
    archive.pipe(res);

    archive.append(pdfBuffer, { name: `${folderNameSafe}/Attendance_Report.pdf` });
    archive.append(csvString, { name: `${folderNameSafe}/Attendance_Data.csv` });

    await archive.finalize();
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};

// ─── EXPORT METADATA ──────────────────────────────────────────────────────────
export const getExportMeta = async (req, res, next) => {
  try {
    const data = await buildExportData(req);
    const { collegeName, subject, teacher, records, studentStats, totalWeightedClasses, overallAverage } = data;

    return res.status(200).json({
      success: true,
      message: "Export metadata fetched successfully.",
      data: {
        collegeName,
        subjectName: subject.subjectName,
        subjectCode: subject.subjectCode,
        totalSessions: records.length,
        totalStudents: studentStats.length,
        totalWeightedClasses,
        avgAttendance: overallAverage,
        subject: {
          _id:         subject._id,
          subjectName: subject.subjectName,
          subjectCode: subject.subjectCode,
          department:  subject.department,
          batch:       subject.batch,
          shift:       subject.shift,
          creditType:  subject.creditType,
          credits:     subject.credits,
        },
        teacher: {
          name:       teacher?.name || "—",
          email:      teacher?.email || "—",
          department: teacher?.department || "—",
        },
        stats: {
          totalSessions:        records.length,
          totalWeightedClasses,
          totalStudents:        studentStats.length,
          overallAverage,
          studentsAbove75:      studentStats.filter((s) => s.percentage >= 75).length,
          studentsBelow75:      studentStats.filter((s) => s.percentage < 75).length,
        },
        availableFormats: ["pdf", "excel", "csv"],
        availableCsvTypes: ["summary", "sessions", "matrix"],
      },
    });
  } catch (error) {
    if (error.status) return sendError(res, error.message, error.status);
    next(error);
  }
};
