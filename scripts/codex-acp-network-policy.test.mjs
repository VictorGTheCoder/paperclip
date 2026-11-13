import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(new URL("../packages/paperclip-runner/package.json", import.meta.url));
const candidateExecutable = process.env.PAPERCLIP_CODEX_ACP_CANDIDATE;
const source = readFileSync(candidateExecutable ?? require.resolve("@agentclientprotocol/codex-acp"), "utf8");
const helperStart = source.indexOf("function paperclipSandboxPolicy(");
const helperEnd = source.indexOf("\nvar CodexAcpClient", helperStart);
const methodStart = source.indexOf("  async sendPrompt(");
const methodEnd = source.indexOf("\n  async runAgentFileChangeReport", methodStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Codex ACP source must contain the network policy patch");
assert.ok(methodStart >= 0 && methodEnd > methodStart, "Codex ACP source must expose the patched turn boundary");

async function turnPolicy(policy, env) {
  const context = {
    process: { env },
    fs7: await import("node:fs").then((module) => module.default),
    path6: path,
    uniqueStrings: (values) => [...new Set(values)],
    buildPromptItems: (prompt) => prompt,
    addAdditionalDirectoriesToSandboxPolicy: (value, directories) => {
      if (directories.length === 0 || value.type !== "workspaceWrite") return value;
      return {
        ...value,
        writableRoots: [...new Set([...(value.writableRoots ?? []), ...directories])],
      };
    },
  };
  const client = runInNewContext(
    source.slice(helperStart, helperEnd) + "\n({" + source.slice(methodStart, methodEnd) + "})",
    context,
  );
  client.refreshSkills = async () => {};
  client.codexClient = { runTurn: async (params) => params };
  return client.sendPrompt(
    { sessionId: "fresh-or-resumed-thread", prompt: [] },
    { approvalPolicy: "on-request", sandboxPolicy: policy },
    { model: "test-model", effort: "low" },
    null, false, "/workspace", [], undefined, undefined,
  );
}

test("ACP forwards workspace networking to the actual Codex turn without changing confinement", async () => {
  const policy = { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false };
  const result = await turnPolicy(policy, { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" });
  assert.equal(result.sandboxPolicy.networkAccess, true);
  assert.equal(result.sandboxPolicy.type, "workspaceWrite");
  assert.equal(result.sandboxPolicy.writableRoots, policy.writableRoots);
  assert.equal(result.approvalPolicy, "on-request");
  assert.equal(policy.networkAccess, false, "must not mutate the shared mode preset");
});

test("Codex projects only existing Git metadata roots into its turn sandbox while network stays disabled", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "paperclip-codex-git-metadata-"));
  const metadataRoot = path.join(fixture, ".git");
  mkdirSync(metadataRoot);
  try {
    const policy = { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false };
    const result = await turnPolicy(policy, {
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1",
      PAPERCLIP_GIT_METADATA_ROOTS: JSON.stringify([metadataRoot]),
      PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true",
      PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled",
    });
    assert.deepEqual(Array.from(result.sandboxPolicy.writableRoots), ["/workspace", metadataRoot]);
    assert.equal(result.sandboxPolicy.networkAccess, false);
    assert.equal(result.approvalPolicy, "on-request");
    assert.deepEqual(policy.writableRoots, ["/workspace"], "must not mutate the shared mode preset");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("ACP preserves operator and execution-target network denials", async () => {
  const policy = { type: "workspaceWrite", networkAccess: true };
  for (const env of [
    { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "false" },
    { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true", PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" },
  ]) {
    assert.equal((await turnPolicy(policy, env)).sandboxPolicy.networkAccess, false);
  }
});

test("ACP leaves other sandbox modes and callers without a valid override unchanged", async () => {
  for (const policy of [{ type: "readOnly", networkAccess: false }, { type: "dangerFullAccess" }]) {
    assert.equal((await turnPolicy(policy, { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: "true" })).sandboxPolicy, policy);
  }
  const policy = { type: "workspaceWrite", networkAccess: false };
  for (const value of [undefined, "", "1", "invalid"]) {
    assert.equal((await turnPolicy(policy, { PAPERCLIP_CODEX_ACP_NETWORK_ACCESS: value })).sandboxPolicy, policy);
  }
});
