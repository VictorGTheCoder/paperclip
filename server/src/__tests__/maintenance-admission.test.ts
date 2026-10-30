import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { maintenanceAllowsRun, maintenanceBootId, maintenanceStatus } from "../services/maintenance-admission.js";
import { maintenancePolicyFixture } from "./maintenance-policy-fixture.js";
const scope = { companyId: "company", issueId: "issue-425", agentIds: ["architect", "victor"] };
const run = { id: "run", companyId: scope.companyId, agentId: "victor", contextSnapshot: { issueId: scope.issueId } };
let fixture: ReturnType<typeof maintenancePolicyFixture> | undefined;
afterEach(() => { fixture?.cleanup(); fixture = undefined; });
const setup = () => (fixture = maintenancePolicyFixture(scope));
describe("restart-safe maintenance admission", () => {
  it("is inert when not configured", () => expect(maintenanceAllowsRun(run, "test", true, {})).toBe(true));
  it("holds with missing/unreadable/malformed policy or missing audit", () => {
    const f = setup();
    expect(maintenanceAllowsRun(run, "test", true, { PAPERCLIP_MAINTENANCE_REQUIRED: "1" })).toBe(false);
    expect(maintenanceAllowsRun(run, "test", true, { ...f.env, PAPERCLIP_MAINTENANCE_POLICY: "/missing/policy" })).toBe(false);
    expect(maintenanceAllowsRun(run, "test", true, { ...f.env, PAPERCLIP_MAINTENANCE_AUDIT: undefined })).toBe(false);
    f.write({ version: 2 }); expect(maintenanceAllowsRun(run, "test", true, f.env)).toBe(false);
  });
  it("admits only the exact company, issue, agents and consistent persisted native identity", () => {
    const f = setup(); expect(maintenanceAllowsRun(run, "claim", true, f.env)).toBe(true);
    for (const change of [{ companyId: "other" }, { agentId: "engineer" }, { contextSnapshot: { issueId: "issue-97" } },
      { contextSnapshot: {} }, { nativeIssueId: "issue-424" }, { canonicalIssueId: "issue-424" }]) expect(maintenanceAllowsRun({ ...run, ...change }, "claim", true, f.env)).toBe(false);
    expect(f.entries().filter(e => e.reserved)).toHaveLength(1);
  });
  it("denies each of the three observed unrelated Victor deferred wakes", () => {
    const f = setup();
    for (const [id, issueId] of [["9db7bd42-e2ee-45b2-8e1a-a3ad648269ec", "issue-97"], ["d5706cd6-0b22-479e-aaf8-9576bd2c3e5f", "issue-97"], ["9dac9819-d761-4706-965a-6229b5cd3730", "issue-424"]])
      expect(maintenanceAllowsRun({ ...run, id, contextSnapshot: { issueId } }, "deferred_queue", false, f.env)).toBe(false);
  });
  it("closes on expiry, stale boot, explicit hold, bad scope, or oversized window", () => {
    const f = setup();
    for (const change of [{ expiresAt: new Date(0).toISOString() }, { bootId: "old-process" }, { mode: "hold" }, { maxRuns: 7 }, { agentIds: [] }, { expiresAt: new Date(Date.now() + 3600_000).toISOString() }]) {
      f.write(change); expect(maintenanceAllowsRun(run, "claim", true, f.env)).toBe(false);
    }
  });
  it("persists reservations, atomically caps concurrent claims, and permits the same run to resume", async () => {
    const f = setup();
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => Promise.resolve().then(() => maintenanceAllowsRun({ ...run, id: `run-${n}` }, "claim", true, f.env))));
    expect(results.filter(Boolean)).toHaveLength(6);
    expect(maintenanceAllowsRun({ ...run, id: "run-0" }, "resume", true, f.env)).toBe(true);
    f.write({}); // rearming does not reset persisted budget
    expect(maintenanceAllowsRun({ ...run, id: "seventh" }, "claim", true, f.env)).toBe(false);
    expect(new Set(f.entries().filter(e => e.reserved).map(e => e.runId)).size).toBe(6);
  });
  it("fails closed on corrupt/unwritable audit rather than claiming without evidence", () => {
    const f = setup(); fs.writeFileSync(f.audit, "partial-record");
    expect(maintenanceAllowsRun(run, "claim", true, f.env)).toBe(false);
    expect(maintenanceAllowsRun(run, "claim", true, { ...f.env, PAPERCLIP_MAINTENANCE_AUDIT: "/missing/audit" })).toBe(false);
  });
  it("release is explicit and boot-bound; removing its file restores HOLD", () => {
    const f = setup(); f.write({ mode: "released" });
    expect(maintenanceAllowsRun({ ...run, agentId: "other", contextSnapshot: {} }, "claim", true, f.env)).toBe(true);
    f.write({ mode: "released", bootId: "previous-boot" });
    expect(maintenanceAllowsRun(run, "claim", true, f.env)).toBe(false);
    expect(maintenanceStatus(f.env).mode).toBe("hold");
  });
  it("a genuinely new process cannot reuse the old boot's issue or release authorization", () => {
    const f = setup();
    const script = `import {maintenanceAllowsRun,maintenanceBootId} from ${JSON.stringify(new URL("../services/maintenance-admission.ts", import.meta.url).href)}; console.log(JSON.stringify({boot:maintenanceBootId,allowed:maintenanceAllowsRun(${JSON.stringify(run)},"restart",true)}));`;
    for (const mode of ["issue", "released"]) {
      f.write({ mode });
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, ...f.env }, encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0); const result = JSON.parse(child.stdout.trim());
      expect(result.boot).not.toBe(maintenanceBootId); expect(result.allowed).toBe(false);
    }
  });
});
