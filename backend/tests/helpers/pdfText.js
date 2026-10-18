/**
 * Minimal PDF text extractor for tests (no dependency, no external binary).
 *
 * PDFKit (standard Helvetica) writes one Flate-compressed content stream per
 * page, with text as hex strings inside `[<..> kern <..>] TJ` arrays. This
 * inflates every stream, joins the hex pieces of each TJ array and decodes them
 * as latin1. It is enough to assert WHICH words appear on WHICH page and how
 * many pages a report has; it is not a general PDF parser.
 */
import zlib from "node:zlib";

const hexToText = (hex) => Buffer.from(hex, "hex").toString("latin1");

/** → { pages: string[] (text per page, in order), pageCount, text } */
export const pdfText = (buf) => {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const s = src.toString("latin1");
  const pageCount = (s.match(/\/Type \/Page\b(?!s)/g) || []).length;
  const pages = [];
  // PDFKit writes "stream\n<data>\nendstream". Do not allow an optional \r before the end marker:
  // a deflate stream whose last byte is 0x0D would lose it and fail to inflate.
  const re = /stream\n([\s\S]*?)\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let content;
    try { content = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    if (!content.includes("BT")) continue;
    const parts = [];
    for (const arr of content.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?\d+(?:\.\d+)?)*)\]\s*TJ/g)) {
      parts.push([...arr[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToText(x[1])).join(""));
    }
    for (const one of content.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) parts.push(hexToText(one[1]));
    pages.push(parts.join("\n"));
  }
  // Streams are not guaranteed to be stored in page order; every page ends with "Page i of N".
  const no = (p) => Number(/^Page (\d+) of \d+$/m.exec(p)?.[1] ?? NaN);
  if (pages.length && pages.every((p) => !Number.isNaN(no(p)))) pages.sort((a, b) => no(a) - no(b));
  return { pages, pageCount, text: pages.join("\n") };
};
