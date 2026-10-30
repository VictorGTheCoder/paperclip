/** Operator maintenance fence. This only restricts admission; it grants no authority.
 * A root-owned policy authorizes one process boot, company, issue and agent set.
 * Missing, expired or stale policy means HOLD, including after an unplanned restart.
 * Reservations are synchronous and durable before a claim can acquire authority.
 * Failed/rolled-back claims consume a slot conservatively; never refund automatically.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const maintenanceBootId = randomUUID();
type Env = Record<string, string | undefined>;
type Run = { id: string; companyId: string; agentId: string; contextSnapshot: unknown; nativeIssueId?: string | null };
type Policy = { version: 1; mode: "hold" | "issue" | "released"; bootId: string; windowId: string;
  companyId: string; issueId: string; agentIds: string[]; expiresAt: string; maxRuns: number };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function maintenanceEnabled(env: Env = process.env) {
  return Boolean(env.PAPERCLIP_MAINTENANCE_REQUIRED || env.PAPERCLIP_MAINTENANCE_POLICY);
}
function readPolicy(env: Env): Policy {
  const filename = env.PAPERCLIP_MAINTENANCE_POLICY;
  if (!filename || !path.isAbsolute(filename)) throw Error("policy_missing");
  const parent = fs.statSync(path.dirname(filename));
  if (parent.uid !== 0 || (parent.mode & 0o022)) throw Error("policy_directory_untrusted");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) || st.size > 4096) throw Error("policy_untrusted");
    const p = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (p.version !== 1 || !["hold", "issue", "released"].includes(p.mode)) throw Error("policy_invalid");
    return p;
  } finally { fs.closeSync(fd); }
}
export function maintenanceStatus(env: Env = process.env): { enabled: boolean; bootId: string; mode: string; policy?: Policy } {
  if (!maintenanceEnabled(env)) return { enabled: false, bootId: maintenanceBootId, mode: "disabled" };
  try {
    const p = readPolicy(env);
    if (p.bootId !== maintenanceBootId) throw Error("boot_mismatch");
    const remaining = Date.parse(p.expiresAt) - Date.now();
    // A newly armed window cannot exceed twenty minutes. Expiry closes the gate.
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 20 * 60_000) throw Error("window_invalid_or_expired");
    if (typeof p.windowId !== "string" || !p.windowId || p.windowId.length > 100) throw Error("window_invalid");
    if (p.mode === "issue" && (typeof p.companyId !== "string" || !p.companyId || typeof p.issueId !== "string" || !p.issueId ||
        !Array.isArray(p.agentIds) || p.agentIds.length < 1 || p.agentIds.length > 2 || p.agentIds.some(a => typeof a !== "string" || !a) ||
        !Number.isInteger(p.maxRuns) || p.maxRuns < 1 || p.maxRuns > 6)) throw Error("scope_invalid");
    return { enabled: true, bootId: maintenanceBootId, mode: p.mode, policy: p };
  } catch {
    return { enabled: true, bootId: maintenanceBootId, mode: "hold" };
  }
}
export function maintenanceAllowsRun(run: Run, phase: string, reserve = false, env: Env = process.env): boolean {
  const state = maintenanceStatus(env);
  if (!state.enabled) return true;
  const p = state.policy;
  const context = record(run.contextSnapshot);
  const issueId = typeof context.issueId === "string" ? context.issueId : run.nativeIssueId;
  // An inconsistent native issue identity is never eligible, even if one field matches.
  let allowed = state.mode === "released" || (state.mode === "issue" && !!p && p.companyId === run.companyId &&
    p.issueId === issueId && (!run.nativeIssueId || run.nativeIssueId === p.issueId) && p.agentIds.includes(run.agentId));
  let reason = allowed ? "scope_allowed" : "maintenance_hold";
  try {
    const audit = env.PAPERCLIP_MAINTENANCE_AUDIT;
    if (!audit || !path.isAbsolute(audit)) return false;
    const fd = fs.openSync(audit, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o022) || st.size > 16 * 1024 * 1024) return false;
      // The journal survives restarts and rearming. A window's consumed run budget
      // cannot be reset by changing bootId. One authorized boot per policy also
      // excludes a second controller; within that process this entire section is
      // synchronous, so concurrent async claims cannot overdraw the budget.
      const entries = fs.readFileSync(fd, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const reservations = new Set(entries.filter(e => e.windowId === p?.windowId && e.reserved === true).map(e => e.runId));
      if (allowed && state.mode === "issue" && !reservations.has(run.id) && reservations.size >= p!.maxRuns) {
        allowed = false; reason = "run_budget_exhausted";
      }
      const reserved = allowed && reserve && state.mode === "issue";
      fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), bootId: maintenanceBootId, windowId: p?.windowId ?? null,
        runId: run.id, companyId: run.companyId, agentId: run.agentId, issueId: issueId ?? null, phase, allowed, reason, reserved }) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  return allowed;
}
