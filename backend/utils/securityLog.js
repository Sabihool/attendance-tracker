/**
 * Structured security-event logging (server-side only; nothing here is ever
 * sent to a client). One JSON line per event so it can be grepped / shipped.
 *
 * Callers pass ids and short codes only — never tokens, passwords, or request
 * bodies. Values are truncated defensively.
 */
const clip = (v) => (typeof v === "string" && v.length > 120 ? `${v.slice(0, 117)}...` : v);

export const logSecurityEvent = (event, details = {}, sink = console) => {
  const safe = {};
  for (const [k, v] of Object.entries(details)) safe[k] = Array.isArray(v) ? v.map(clip) : clip(v);
  try {
    sink.warn?.(JSON.stringify({ type: "security_event", event, at: new Date().toISOString(), ...safe }));
  } catch { /* logging must never break a request */ }
};
