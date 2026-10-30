import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { maintenanceBootId } from "../services/maintenance-admission.js";

/** Real root-owned policy, matching production file validation. No global FS mocks. */
export function maintenancePolicyFixture(scope: { companyId: string; issueId: string; agentIds: string[] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-maintenance-policy-"));
  const directory = path.join(root, "operator"); fs.mkdirSync(directory);
  const policy = path.join(directory, "policy.json"), audit = path.join(root, "admission.jsonl");
  const chown = (uid: number, gid: number) => {
    if (process.getuid?.() === 0) { fs.chownSync(policy, uid, gid); fs.chownSync(directory, uid, gid); }
    else execFileSync("sudo", ["-n", "chown", `${uid}:${gid}`, policy, directory]);
  };
  const config = { version: 1, mode: "issue", bootId: maintenanceBootId, windowId: root,
    expiresAt: new Date(Date.now() + 19 * 60_000).toISOString(), maxRuns: 6, ...scope };
  fs.writeFileSync(policy, JSON.stringify(config), { mode: 0o644 }); fs.chmodSync(directory, 0o755); chown(0, 0);
  const env = { PAPERCLIP_MAINTENANCE_REQUIRED: "1", PAPERCLIP_MAINTENANCE_POLICY: policy, PAPERCLIP_MAINTENANCE_AUDIT: audit };
  return { env, config, policy, audit,
    write(overrides: Record<string, unknown>) {
      // The parent stays root-owned during atomic operator policy replacement.
      const staging = path.join(root, "next.json"); fs.writeFileSync(staging, JSON.stringify({ ...config, ...overrides }));
      execFileSync("sudo", ["-n", "install", "-o", "root", "-g", "root", "-m", "0644", staging, policy]);
    },
    entries() { return fs.existsSync(audit) ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : []; },
    cleanup() { chown(process.getuid?.() ?? 0, process.getgid?.() ?? 0); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
