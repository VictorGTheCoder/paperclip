import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { pendingInteractionId, readPendingInteractionResponder } from "./pending-interaction-responder.js";

const { access, invokable } = vi.hoisted(() => ({ access: vi.fn(), invokable: vi.fn() }));
vi.mock("./authorization.js", () => ({ authorizationService: () => ({ decide: access }) }));
vi.mock("./agent-invokability.js", () => ({ evaluateAgentInvokabilityFromDb: invokable }));
const id = "10000000-0000-4000-8000-000000000001";
const agentId = "10000000-0000-4000-8000-000000000002";
const runId = "10000000-0000-4000-8000-000000000003";
const contextSnapshot = { wakeReason: "interaction_pending", source: "issue.interaction.created", interactionId: id };
const input = { companyId: "company", issueId: "issue", agentId, runId, contextSnapshot };
const issue = { id: "issue", companyId: "company", status: "in_review", assigneeAgentId: "author" };
const card = { id, companyId: "company", issueId: "issue", kind: "request_confirmation", status: "pending",
  addresseeAgentId: agentId, addresseeUserId: null, createdByAgentId: "author", sourceRunId: "author-run",
  effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "requested", payload: {}, updatedAt: new Date("2026-11-01T00:00:00Z") };
function dbWith(rows: unknown[][]) {
  const locks: unknown[] = [];
  const select = vi.fn(() => {
    const result = rows.shift() ?? [];
    const query: Record<string, unknown> = {};
    for (const key of ["from", "where", "innerJoin"]) query[key] = () => query;
    query.for = (...args: unknown[]) => { locks.push(args); return query; };
    query.then = (fn: (value: unknown[]) => unknown) => Promise.resolve(result).then(fn);
    return query;
  });
  return { db: { select } as unknown as Db, select, locks };
}
beforeEach(() => { access.mockResolvedValue({ allowed: true }); invokable.mockResolvedValue({ invokable: true }); });

describe("pending named interaction responder admission", () => {
  it("admits a named independent responder without making it the issue owner", async () => {
    const { db, locks } = dbWith([[issue], [card], [{ id: agentId }]]);
    expect(await readPendingInteractionResponder(db, { ...input, lockForUpdate: true })).toEqual({
      purpose: "interaction_responder", interactionId: id, interactionUpdatedAt: card.updatedAt.toISOString(),
    });
    expect(locks).toEqual([["update"]]);
    expect(issue.assigneeAgentId).toBe("author");
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read",
      actor: expect.objectContaining({ agentId, runId }) }));
  });
  it.each(["answered", "accepted", "rejected", "expired", "superseded", "cancelled"])("refuses a %s card", async status => {
    const { db } = dbWith([[issue], [{ ...card, status }]]);
    expect(await readPendingInteractionResponder(db, input)).toBeNull();
  });
  it.each([
    { addresseeAgentId: "someone-else" }, { addresseeUserId: "human" },
    { effectiveResolverPolicy: "human_only" }, { createdByAgentId: agentId },
    { payload: { toolAction: { tool: "privileged" } } },
    { payload: { target: { type: "custom", key: "native_completion_review" } } },
  ])("refuses audience or governed-action restrictions %j", async change => {
    const { db } = dbWith([[issue], [{ ...card, ...change }]]);
    expect(await readPendingInteractionResponder(db, input)).toBeNull();
  });
  it("revalidates the current target document revision under lock", async () => {
    const { db, locks } = dbWith([[issue], [{ ...card, payload: { target: {
      type: "issue_document", key: "plan", revisionId: "old", revisionNumber: 1,
    } } }], [{ revisionId: "new", revisionNumber: 2 }]]);
    expect(await readPendingInteractionResponder(db, { ...input, lockForUpdate: true })).toBeNull();
    expect(locks).toHaveLength(2);
  });
  it("rejects a different document even when its revision matches the hint", async () => {
    const { db } = dbWith([[issue], [{ ...card, payload: { target: {
      type: "issue_document", key: "plan", documentId: "requested-doc", revisionId: "same-revision",
    } } }], [{ documentId: "other-doc", revisionId: "same-revision", revisionNumber: 1 }]]);
    expect(await readPendingInteractionResponder(db, input)).toBeNull();
  });
  it.each([{ companyId: "other-company" }, { issueId: "other-task" }])("rejects mismatched persisted scope %j", async change => {
    const { db } = dbWith([[issue], [{ ...card, ...change }]]);
    expect(await readPendingInteractionResponder(db, input)).toBeNull();
  });
  it.each(["access", "invokable"])("refuses revoked %s", async revoked => {
    if (revoked === "access") access.mockResolvedValue({ allowed: false });
    else invokable.mockResolvedValue({ invokable: false });
    const { db } = dbWith([[issue], [card], [{ id: agentId }]]);
    expect(await readPendingInteractionResponder(db, input)).toBeNull();
  });
  it("treats a deferred purpose marker only as a hint and rereads the card", async () => {
    const marker = { purpose: "interaction_responder", interactionId: id, interactionUpdatedAt: card.updatedAt.toISOString() };
    expect(pendingInteractionId({ wakeReason: "ai_connection_pool_wait", interactionResponder: marker })).toBe(id);
    const { db } = dbWith([[issue], [{ ...card, status: "superseded" }]]);
    expect(await readPendingInteractionResponder(db, { ...input, contextSnapshot: { interactionResponder: marker } })).toBeNull();
  });
  it("keeps only its own resolved receipt readable after the producer publishes a newer plan", async () => {
    const resolved = { ...card, status: "accepted", resolvedByRunId: runId, resolvedByAgentId: agentId,
      payload: { target: { type: "issue_document", key: "plan", revisionId: "old", documentId: "old-doc" } } };
    const { db, select } = dbWith([[{ ...issue, status: "done" }], [resolved], [{ id: agentId }]]);
    expect(await readPendingInteractionResponder(db, { ...input, allowResolvedByRunId: runId })).toMatchObject({ interactionId: id });
    expect(select).toHaveBeenCalledTimes(3); // No mutable document lookup after this run's terminal response.
    const other = dbWith([[issue], [{ ...resolved, resolvedByRunId: "other-run" }]]);
    expect(await readPendingInteractionResponder(other.db, { ...input, allowResolvedByRunId: runId })).toBeNull();
  });
  it("recognizes a fresh board-requested intent without forging a creation event or a run identity", async () => {
    const manual = { wakeReason: "interaction_response_requested", source: "agent.wakeup.interaction_requested", interactionId: id };
    expect(pendingInteractionId(manual)).toBe(id);
    expect(pendingInteractionId({ ...manual, source: "issue.interaction.created" })).toBeNull();
    const admission = dbWith([[issue], [card], [{ id: agentId }]]);
    expect(await readPendingInteractionResponder(admission.db, { ...input, runId: undefined,
      contextSnapshot: manual, forAdmission: true })).toMatchObject({ interactionId: id });
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ source: "agent_key", runId: undefined }) }));
    const unattributed = dbWith([[issue], [card]]);
    expect(await readPendingInteractionResponder(unattributed.db, { ...input, runId: undefined, contextSnapshot: manual })).toBeNull();
    const humanOnly = dbWith([[issue], [{ ...card, effectiveResolverPolicy: "human_only" }]]);
    expect(await readPendingInteractionResponder(humanOnly.db, { ...input, runId: undefined,
      contextSnapshot: manual, forAdmission: true })).toBeNull();
  });
  it("prevalidates an automatic initial wake without a fabricated run ID, while dispatch still needs attribution", async () => {
    const initial = dbWith([[{ ...issue, status: "blocked" }], [card], [{ id: agentId }]]);
    expect(await readPendingInteractionResponder(initial.db, { ...input, runId: undefined, forAdmission: true }))
      .toMatchObject({ interactionId: id });
    const dispatch = dbWith([[{ ...issue, status: "blocked" }], [card]]);
    expect(await readPendingInteractionResponder(dispatch.db, { ...input, runId: undefined })).toBeNull();
  });
  it("does not infer responder authority from a comment wake or arbitrary boolean", async () => {
    const { db, select } = dbWith([]);
    expect(await readPendingInteractionResponder(db, { ...input,
      contextSnapshot: { interactionId: id, wakeReason: "issue_commented", isPendingInteractionResponder: true } })).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
});
