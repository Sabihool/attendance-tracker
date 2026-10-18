/**
 * registerPdfBuilder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds the printable attendance PDF used EVERYWHERE in the Export section
 * (quick PDF export, the dedicated "register" export, and the PDF bundled
 * inside the ZIP backup) — see spec: "PDF Export Requirements".
 *
 * Pagination model (per spec):
 *  - Pagination is driven by the NUMBER OF ATTENDANCE DATES, never by the
 *    number of students. Every attendance page shows every student.
 *  - Each attendance page holds at most MAX_DATES_PER_PAGE (10) date columns.
 *    Attendance Pages = ceil(totalDates / 10).
 *  - Attendance pages show ONLY daily status (Roll, Registration, Student
 *    Name, one column per date). No analytics/summary columns ever appear
 *    on an attendance page.
 *  - After all attendance pages, exactly one Summary Page is appended with
 *    full analytics per student (Total Classes, Total Present, Total
 *    Absent, Attendance %, Credit Score, etc).
 *  - Total PDF Pages = Attendance Pages + 1 (Summary Page) — plus any extra
 *    physical pages needed if the student list itself overflows a page's
 *    vertical space (row-level overflow, not part of the date-driven count;
 *    column headers simply repeat on the continuation page).
 *
 * "Total Classes" / "Total Present" / "Total Absent" on the summary page are
 * PLAIN session counts (one session = one class), matching the same
 * plain-count convention already used elsewhere in the app (see
 * getStudentAnalytics in alertsController.js) — NOT the credit-weighted
 * totals used only for Credit Score. Credit Score itself is always computed
 * via the shared creditUtils.calculateCreditScore(), using the admin's
 * configured attendance-category credit values.
 *
 * This module only draws into a PDFDocument — it does not create, pipe, or
 * end the document. Callers are responsible for that (see exportController),
 * which lets the exact same drawing code serve a direct streamed download,
 * an in-memory buffer (for the ZIP bundle), and the quick PDF export.
 */

const MARGIN_X = 40;
// Exported so callers create the PDFDocument with matching margins (see
// exportController.js). IMPORTANT: PDFKit auto-adds a page whenever a
// `.text()` call's y-position reaches the document's own bottom margin —
// independent of any pagination logic we write ourselves. If that built-in
// margin were smaller than our FOOTER_HEIGHT reservation, PDFKit would
// silently insert extra pages mid-row (one per cell) once rows got close to
// the bottom. To avoid that conflict, the PDFDocument must be created with
// top/bottom margins of 0 — we handle ALL vertical spacing (header/footer
// reservations, row overflow, page breaks) ourselves via HEADER_HEIGHT /
// FOOTER_HEIGHT / contentBottom instead.
export { MARGIN_X };

const HEADER_HEIGHT = 76; // reserved space at top of every page (college/subject/teacher/department info)
const FOOTER_HEIGHT = 26; // reserved space at bottom of every page (page number)
const ROW_HEIGHT = 14;
const MAX_DATES_PER_PAGE = 10; // per spec: Attendance Pages = ceil(totalDates / 10)

const FIXED_COLS = [
  { key: "roll", label: "Roll", width: 36 },
  { key: "reg", label: "Registration", width: 56 },
  { key: "name", label: "Student Name", width: 104 },
];

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

const capitalize = (s) =>
  s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s;

const normalizeStatus = (status) =>
  String(status ?? "").trim().toLowerCase() || "unknown";

// Attendance-page cells show the actual status word (Present / Absent /
// Late / etc.), never a single-letter P/A code — per spec.
const statusDisplay = (status) => {
  const norm = String(status ?? "").trim().toLowerCase();
  return norm ? capitalize(norm) : "—";
};

/**
 * Split the list of attendance sessions (dates) into fixed-size chunks of at
 * most MAX_DATES_PER_PAGE — this is the ONLY axis pagination is driven by.
 * Always returns at least one chunk (possibly empty) so a subject with zero
 * sessions still gets a (mostly blank) attendance page.
 */
const buildDateChunks = (records) => {
  const chunks = [];
  for (let i = 0; i < records.length; i += MAX_DATES_PER_PAGE) {
    chunks.push(records.slice(i, i + MAX_DATES_PER_PAGE));
  }
  if (chunks.length === 0) chunks.push([]);
  return chunks;
};

/**
 * Compute plain (non-credit-weighted) per-student session counts directly
 * from the raw attendance records, grouped by normalized status. One
 * attendance session = one class, regardless of its category's credit
 * value — credit weighting is reserved exclusively for Credit Score.
 */
const computePlainStats = (records) => {
  const statsByStudent = new Map();
  const statusKeys = new Set();

  for (const record of records) {
    for (const s of record.students) {
      if (!statsByStudent.has(s.studentId)) {
        statsByStudent.set(s.studentId, {
          studentId: s.studentId,
          roll: s.roll,
          name: s.name,
          totalClasses: 0,
          statusCounts: {},
        });
      }
      const entry = statsByStudent.get(s.studentId);
      entry.totalClasses += 1;
      const key = normalizeStatus(s.status);
      statusKeys.add(key);
      entry.statusCounts[key] = (entry.statusCounts[key] || 0) + 1;
    }
  }

  return { statsByStudent, statusKeys: Array.from(statusKeys) };
};

/**
 * Draw one attendance page's table: fixed cols + this chunk's date cols
 * ONLY — never any analytics/summary columns (see spec). Every student is
 * shown; if the student list itself is taller than one physical page, rows
 * simply continue onto an extra physical page with the column header
 * repeated (this is row-level overflow, not date-driven pagination).
 */
const drawAttendancePage = (
  doc,
  { chunk, pageIndex, pageCount, sortedStudents, contentTop, contentBottom, pageWidth }
) => {
  const usableWidth = pageWidth - MARGIN_X * 2;
  const fixedWidth = FIXED_COLS.reduce((s, c) => s + c.width, 0);
  const dateColWidth = Math.max(
    24,
    Math.floor((usableWidth - fixedWidth) / MAX_DATES_PER_PAGE)
  );

  const cols = [
    ...FIXED_COLS,
    ...chunk.map((r) => ({
      key: `r_${r._id}`,
      label: fmtDate(r.date),
      width: dateColWidth,
      record: r,
    })),
  ];

  let y = doc.y;

  const drawHeaderRow = () => {
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#333333").text(
      `Attendance Page ${pageIndex + 1} of ${pageCount}`,
      MARGIN_X,
      y
    );
    y += 12;

    if (chunk.length > 0) {
      const sessionInfo = chunk
        .map((r) => `${fmtDate(r.date)} (${r.classType}${r.classWeight != null ? ` · ${r.classWeight}cr` : ""})`)
        .join("   ");
      doc.fontSize(6.5).font("Helvetica").fillColor("#555555").text(sessionInfo, MARGIN_X, y, {
        width: usableWidth,
      });
      y = doc.y + 4;
    } else {
      doc.fontSize(7).font("Helvetica-Oblique").fillColor("#888888").text(
        "No attendance sessions recorded for this subject.",
        MARGIN_X,
        y
      );
      y = doc.y + 4;
    }

    let x = MARGIN_X;
    doc.rect(MARGIN_X, y, usableWidth, ROW_HEIGHT).fill("#4338CA");
    doc.fillColor("#ffffff").fontSize(6.5).font("Helvetica-Bold");
    cols.forEach((c) => {
      doc.text(c.label, x + 2, y + 4, { width: c.width - 3, ellipsis: true });
      x += c.width;
    });
    y += ROW_HEIGHT;
    doc.fillColor("#000000");
    return y;
  };

  y = drawHeaderRow();

  doc.font("Helvetica").fontSize(6);
  sortedStudents.forEach((st, i) => {
    if (y + ROW_HEIGHT > contentBottom) {
      doc.addPage();
      y = contentTop;
      y = drawHeaderRow();
    }

    if (i % 2 === 0) {
      doc.rect(MARGIN_X, y, usableWidth, ROW_HEIGHT).fill("#F8F9FC");
      doc.fillColor("#000000");
    }

    let x = MARGIN_X;
    cols.forEach((c) => {
      let val = "";
      if (c.key === "roll") val = st.roll;
      else if (c.key === "reg") val = st.studentId;
      else if (c.key === "name") val = st.name;
      else if (c.record) {
        const entry = c.record.students.find((s) => s.studentId === st.studentId);
        val = entry ? statusDisplay(entry.status) : "—";
      }
      doc.text(val, x + 2, y + 4, { width: c.width - 3, ellipsis: true });
      x += c.width;
    });
    y += ROW_HEIGHT;
  });

  doc.y = y + 8;
};

/**
 * Draw the final Summary Page: full analytics for every student. This is
 * the ONLY page where analytics/credit columns appear.
 */
const drawSummaryPage = (doc, { students, contentTop, contentBottom, pageWidth, extraStatusKeys }) => {
  const usableWidth = pageWidth - MARGIN_X * 2;

  const baseCols = [
    { key: "roll", label: "Roll", width: 34 },
    { key: "reg", label: "Registration", width: 52 },
    { key: "name", label: "Student Name", width: 92 },
    { key: "totalClasses", label: "Total Classes", width: 48 },
    { key: "totalPresent", label: "Total Present", width: 48 },
    { key: "totalAbsent", label: "Total Absent", width: 46 },
    ...extraStatusKeys.map((k) => ({ key: `total_${k}`, label: `Total ${capitalize(k)}`, width: 46 })),
    { key: "pct", label: "Attendance %", width: 48 },
    { key: "credit", label: "Credit Score", width: 46 },
    { key: "status", label: "Status", width: 36 },
  ];

  // Scale columns down proportionally if the count of extra status columns
  // ever pushes the total past the page width (keeps the table on-page no
  // matter how many custom attendance categories/statuses exist).
  const totalWidth = baseCols.reduce((s, c) => s + c.width, 0);
  const scale = totalWidth > usableWidth ? usableWidth / totalWidth : 1;
  const cols = baseCols.map((c) => ({ ...c, width: c.width * scale }));

  let y = doc.y;

  const drawHeaderRow = () => {
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000").text(
      "Attendance Analytics Summary",
      MARGIN_X,
      y,
      { align: "center", width: usableWidth }
    );
    y = doc.y + 6;

    let x = MARGIN_X;
    doc.rect(MARGIN_X, y, usableWidth, ROW_HEIGHT).fill("#4338CA");
    doc.fillColor("#ffffff").fontSize(6.5).font("Helvetica-Bold");
    cols.forEach((c) => {
      doc.text(c.label, x + 2, y + 4, { width: c.width - 3, ellipsis: true });
      x += c.width;
    });
    y += ROW_HEIGHT;
    doc.fillColor("#000000");
    return y;
  };

  y = drawHeaderRow();

  doc.font("Helvetica").fontSize(7);
  students.forEach((st, i) => {
    if (y + ROW_HEIGHT > contentBottom) {
      doc.addPage();
      y = contentTop;
      y = drawHeaderRow();
    }

    if (i % 2 === 0) {
      doc.rect(MARGIN_X, y, usableWidth, ROW_HEIGHT).fill("#F8F9FC");
      doc.fillColor("#000000");
    }

    let x = MARGIN_X;
    cols.forEach((c) => {
      let val = "";
      if (c.key === "roll") val = st.roll;
      else if (c.key === "reg") val = st.studentId;
      else if (c.key === "name") val = st.name;
      else if (c.key === "totalClasses") val = String(st.totalClasses);
      else if (c.key === "totalPresent") val = String(st.totalPresent);
      else if (c.key === "totalAbsent") val = String(st.totalAbsent);
      else if (c.key === "pct") val = `${st.percentage}%`;
      else if (c.key === "credit") val = String(st.creditScore ?? 0);
      else if (c.key === "status") val = st.percentage >= 75 ? "OK" : "LOW";
      else if (c.key.startsWith("total_")) {
        const statusKey = c.key.slice("total_".length);
        val = String(st.extra?.[statusKey] ?? 0);
      }
      doc.text(val, x + 2, y + 4, { width: c.width - 3, ellipsis: true });
      x += c.width;
    });
    y += ROW_HEIGHT;
  });

  doc.y = y + 8;
};

/**
 * Main entry point — draws the full report into `doc`. Does NOT call
 * doc.end(); the caller owns the document lifecycle.
 */
export const renderAttendanceRegisterPDF = (doc, data) => {
  const { collegeName, subject, teacher, records, studentStats } = data;

  doc.bufferPages = true;

  const pageWidth = doc.page.width;
  const contentTop = HEADER_HEIGHT;
  const contentBottom = doc.page.height - FOOTER_HEIGHT;

  doc.y = contentTop;

  const sortedStudents = [...studentStats].sort((a, b) =>
    a.roll.localeCompare(b.roll, undefined, { numeric: true })
  );

  // ── Attendance pages: split purely by date count, per spec ─────────────
  const chunks = buildDateChunks(records);
  const attendancePageCount = chunks.length;

  chunks.forEach((chunk, i) => {
    if (i > 0) {
      doc.addPage();
      doc.y = contentTop;
    }
    drawAttendancePage(doc, {
      chunk,
      pageIndex: i,
      pageCount: attendancePageCount,
      sortedStudents,
      contentTop,
      contentBottom,
      pageWidth,
    });
  });

  // ── Final Summary Page: complete analytics for every student ───────────
  const { statsByStudent, statusKeys } = computePlainStats(records);
  const extraStatusKeys = statusKeys.filter((k) => k !== "present" && k !== "absent");

  // Credit Score always comes from the shared creditUtils calculation
  // (studentStats is enriched with it upstream — see buildRegisterData in
  // exportController.js), never recomputed here.
  const creditScoreByStudent = new Map(studentStats.map((s) => [s.studentId, s.creditScore ?? 0]));

  const summaryStudents = sortedStudents.map((st) => {
    const plain = statsByStudent.get(st.studentId) || { totalClasses: 0, statusCounts: {} };
    const totalPresent = plain.statusCounts.present || 0;
    const totalAbsent = plain.statusCounts.absent || 0;
    const totalClasses = plain.totalClasses;
    const percentage = totalClasses > 0 ? Math.round((totalPresent / totalClasses) * 100) : 0;
    const extra = {};
    extraStatusKeys.forEach((k) => {
      extra[k] = plain.statusCounts[k] || 0;
    });

    return {
      studentId: st.studentId,
      roll: st.roll,
      name: st.name,
      totalClasses,
      totalPresent,
      totalAbsent,
      percentage,
      creditScore: creditScoreByStudent.get(st.studentId) ?? 0,
      extra,
    };
  });

  doc.addPage();
  doc.y = contentTop;
  drawSummaryPage(doc, {
    students: summaryStudents,
    contentTop,
    contentBottom,
    pageWidth,
    extraStatusKeys,
  });

  // ── Repeating header (college/subject/teacher/department info) + footer
  // (page numbers) drawn on every buffered page in a single final pass —
  // the simplest reliable way to get "Page X of Y" with PDFKit.
  const usableWidth = pageWidth - MARGIN_X * 2;
  const totalStudents = sortedStudents.length;
  const infoLine1 = `Subject: ${subject.subjectName} (${subject.subjectCode})   |   Teacher: ${teacher?.name || "—"}`;
  const infoLine2 = `Department: ${subject.department || "—"}   Batch: ${subject.batch || "—"}   Shift: ${subject.shift || "—"}   Subject Type: ${subject.creditType || "—"}   Total Students: ${totalStudents}`;

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000").text(
      collegeName,
      MARGIN_X,
      10,
      { width: usableWidth, align: "center" }
    );
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor("#4338CA").text(
      "Attendance Tracker",
      MARGIN_X,
      23,
      { width: usableWidth, align: "center" }
    );
    doc.fontSize(7).font("Helvetica").fillColor("#444444").text(
      infoLine1,
      MARGIN_X,
      36,
      { width: usableWidth, align: "center" }
    );
    doc.fontSize(6.5).font("Helvetica").fillColor("#555555").text(
      infoLine2,
      MARGIN_X,
      47,
      { width: usableWidth, align: "center" }
    );
    doc.moveTo(MARGIN_X, 60).lineTo(pageWidth - MARGIN_X, 60).stroke();

    doc.fontSize(7).fillColor("#666666").text(
      `Page ${i - range.start + 1} of ${range.count}`,
      MARGIN_X,
      doc.page.height - 18,
      { width: usableWidth, align: "center" }
    );
    doc.fillColor("#000000");
  }
};
