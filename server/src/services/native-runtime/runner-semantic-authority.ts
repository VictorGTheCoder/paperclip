import { readPendingInteractionResponder, type PendingInteractionResponder } from "../pending-interaction-responder.js";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  agents,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  PaperclipSemanticDispatcher,
  type PaperclipJsonValue,
  type PaperclipSemanticActionBinding,
  type PaperclipSemanticActionId,
  type PaperclipSemanticAuthorizationRecord,
  type PaperclipSemanticRunContext,
  type PaperclipSemanticToolCall,
  type PaperclipSemanticToolDefinition,
  type PaperclipSemanticToolResult,
} from "../../vendor/paperclip-runner/index.js";

export interface PaperclipRunnerSemanticBinding {
  readonly pendingInteractionResponder?: PendingInteractionResponder;
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly agentId: string;
}

const READ_OPERATION_IDS = [
  "get_task_context",
  "get_task_history",
  "list_documents",
  "read_document",
  "list_document_revisions",
] as const satisfies readonly PaperclipSemanticActionId[];

type BoundContext = {
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly issue: typeof issues.$inferSelect;
  readonly agent: typeof agents.$inferSelect;
};

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 200))
    : 50;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    throw new Error("paperclip_runner_semantic_input_invalid");
  }
  return value;
}

function jsonValue(value: unknown): PaperclipJsonValue {
  return JSON.parse(JSON.stringify(value)) as PaperclipJsonValue;
}

function activeAgentStatus(status: string): "active" | "inactive" {
  return ["paused", "terminated", "pending_approval", "error"].includes(status)
    ? "inactive"
    : "active";
}

/**
 * Run-scoped semantic authority for the hidden native coordinator.
 * This first server slice binds only same-task read operations. A catalog
 * entry remains undiscoverable until a later PR adds its guarded binding.
 */
export class PaperclipRunnerSemanticAuthority {
  readonly #db: Db;
  readonly #binding: PaperclipRunnerSemanticBinding;
  readonly #dispatcher: PaperclipSemanticDispatcher;

  constructor(db: Db, binding: PaperclipRunnerSemanticBinding) {
    this.#db = db;
    this.#binding = structuredClone(binding);
    this.#dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: (runId) => this.#context(runId),
      bindings: READ_OPERATION_IDS.map((operationId) =>
        this.#readBinding(operationId),
      ),
    });
  }

  listAlwaysAvailableTools(): Promise<
    readonly PaperclipSemanticToolDefinition[]
  > {
    return this.#dispatcher.listAlwaysAvailableTools(this.#binding.runId);
  }

  dispatch(
    call: Omit<PaperclipSemanticToolCall, "runId">,
  ): Promise<PaperclipSemanticToolResult> {
    return this.#dispatcher.dispatch({ ...call, runId: this.#binding.runId });
  }

  authorizationRecords(): readonly PaperclipSemanticAuthorizationRecord[] {
    return this.#dispatcher.authorizationRecords();
  }

  #readBinding(
    operationId: (typeof READ_OPERATION_IDS)[number],
  ): PaperclipSemanticActionBinding {
    return {
      operationId,
      execute: async (invocation) => {
        const context = await this.#loadBoundContext();
        await this.#assertActiveContext(context, true);
        const input = invocation.input;
        switch (operationId) {
          case "get_task_context":
            return {
              value: jsonValue({
                company: { id: this.#binding.companyId },
                actor: {
                  id: context.agent.id,
                  name: context.agent.name,
                  role: context.agent.role,
                  title: context.agent.title,
                  capabilities: context.agent.capabilities,
                },
                ...(this.#binding.pendingInteractionResponder ? {
                  assignedInteraction: (await this.#db.select().from(issueThreadInteractions).where(and(
                    eq(issueThreadInteractions.id, this.#binding.pendingInteractionResponder.interactionId),
                    eq(issueThreadInteractions.companyId, this.#binding.companyId),
                    eq(issueThreadInteractions.issueId, this.#binding.issueId))))[0],
                } : {}),
                activeTask: {
                  id: context.issue.id,
                  identifier: context.issue.identifier,
                  title: context.issue.title,
                  description: context.issue.description,
                  status: context.issue.status,
                  statusVersion: context.issue.statusVersion,
                  priority: context.issue.priority,
                  workMode: context.issue.workMode,
                  parentId: context.issue.parentId,
                  projectId: context.issue.projectId,
                  goalId: context.issue.goalId,
                },
                run: {
                  id: context.run.id,
                  status: context.run.status,
                  invocationSource: context.run.invocationSource,
                },
              }),
              references: [{ kind: "task", id: context.issue.id }],
            };
          case "get_task_history": {
            const rows = await this.#db
              .select({
                id: issueComments.id,
                body: issueComments.body,
                authorAgentId: issueComments.authorAgentId,
                authorUserId: issueComments.authorUserId,
                createdAt: issueComments.createdAt,
              })
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, this.#binding.companyId),
                  eq(issueComments.issueId, this.#binding.issueId),
                  isNull(issueComments.deletedAt),
                ),
              )
              .orderBy(desc(issueComments.createdAt))
              .limit(boundedLimit(input.limit));
            return {
              value: jsonValue({ comments: rows.reverse() }),
              references: [{ kind: "task", id: context.issue.id }],
            };
          }
          case "list_documents": {
            const rows = await this.#db
              .select({
                key: issueDocuments.key,
                id: documents.id,
                title: documents.title,
                format: documents.format,
                latestRevisionId: documents.latestRevisionId,
                latestRevisionNumber: documents.latestRevisionNumber,
                lockedAt: documents.lockedAt,
                updatedAt: documents.updatedAt,
              })
              .from(issueDocuments)
              .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(documents.companyId, this.#binding.companyId),
                ),
              );
            return {
              value: jsonValue({ documents: rows }),
              references: rows.map((row) => ({
                kind: "document_revision" as const,
                id: row.latestRevisionId ?? row.id,
              })),
            };
          }
          case "read_document": {
            const key = requiredString(input.key);
            const [row] = await this.#db
              .select({
                key: issueDocuments.key,
                id: documents.id,
                title: documents.title,
                format: documents.format,
                body: documents.latestBody,
                latestRevisionId: documents.latestRevisionId,
                latestRevisionNumber: documents.latestRevisionNumber,
                lockedAt: documents.lockedAt,
                updatedAt: documents.updatedAt,
              })
              .from(issueDocuments)
              .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(issueDocuments.key, key),
                  eq(documents.companyId, this.#binding.companyId),
                ),
              )
              .limit(1);
            if (!row) throw new Error("paperclip_runner_document_not_found");
            return {
              value: jsonValue({ document: row }),
              references: [
                {
                  kind: "document_revision",
                  id: row.latestRevisionId ?? row.id,
                },
              ],
            };
          }
          case "list_document_revisions": {
            const key = requiredString(input.key);
            const rows = await this.#db
              .select({
                id: documentRevisions.id,
                revisionNumber: documentRevisions.revisionNumber,
                title: documentRevisions.title,
                format: documentRevisions.format,
                body: documentRevisions.body,
                changeSummary: documentRevisions.changeSummary,
                createdByAgentId: documentRevisions.createdByAgentId,
                createdByUserId: documentRevisions.createdByUserId,
                createdAt: documentRevisions.createdAt,
              })
              .from(issueDocuments)
              .innerJoin(
                documentRevisions,
                eq(documentRevisions.documentId, issueDocuments.documentId),
              )
              .where(
                and(
                  eq(issueDocuments.companyId, this.#binding.companyId),
                  eq(issueDocuments.issueId, this.#binding.issueId),
                  eq(issueDocuments.key, key),
                  eq(documentRevisions.companyId, this.#binding.companyId),
                ),
              )
              .orderBy(desc(documentRevisions.revisionNumber))
              .limit(boundedLimit(input.limit));
            return {
              value: jsonValue({ revisions: rows }),
              references: rows.map((row) => ({
                kind: "document_revision" as const,
                id: row.id,
              })),
            };
          }
        }
      },
    };
  }

  async #context(requestedRunId: string): Promise<PaperclipSemanticRunContext> {
    if (requestedRunId !== this.#binding.runId) {
      throw new Error("paperclip_runner_semantic_run_mismatch");
    }
    const context = await this.#loadBoundContext();
    await this.#assertActiveContext(context, false);
    return {
      ...(this.#binding.pendingInteractionResponder ? { interactionResponder: { interactionId: this.#binding.pendingInteractionResponder.interactionId } } : {}),
      runId: context.run.id,
      companyId: context.run.companyId,
      actor: {
        id: context.agent.id,
        companyId: context.agent.companyId,
        status: activeAgentStatus(context.agent.status),
        role: context.agent.role,
        claims: [],
      },
      activeTask: {
        id: context.issue.id,
        companyId: context.issue.companyId,
        assigneeActorId: context.issue.assigneeAgentId,
        executionRunId: context.issue.executionRunId,
        status: context.issue.status,
        workMode: context.issue
          .workMode as PaperclipSemanticRunContext["activeTask"]["workMode"],
      },
      delegatedClaims: [],
    };
  }

  async #loadBoundContext(): Promise<BoundContext> {
    const [row] = await this.#db
      .select({ run: heartbeatRuns, issue: issues, agent: agents })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.id, heartbeatRuns.nativeIssueId),
          eq(issues.companyId, heartbeatRuns.companyId),
        ),
      )
      .innerJoin(
        agents,
        and(
          eq(agents.id, heartbeatRuns.agentId),
          eq(agents.companyId, heartbeatRuns.companyId),
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.id, this.#binding.runId),
          eq(heartbeatRuns.companyId, this.#binding.companyId),
          eq(heartbeatRuns.agentId, this.#binding.agentId),
          eq(heartbeatRuns.nativeIssueId, this.#binding.issueId),
          eq(heartbeatRuns.runtimeMode, "native"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("paperclip_runner_semantic_binding_not_found");
    return row;
  }

  async #assertActiveContext(context: BoundContext, requireOwnership: boolean): Promise<void> {
    const responder = this.#binding.pendingInteractionResponder;
    if (responder) {
      const current = await readPendingInteractionResponder(this.#db, {
        ...this.#binding, contextSnapshot: context.run.contextSnapshot,
        responsibleUserId: context.run.responsibleUserId, allowResolvedByRunId: this.#binding.runId,
      });
      if (!current || current.interactionId !== responder.interactionId)
        throw new Error("paperclip_runner_semantic_interaction_inactive");
    }
    if (
      !["queued", "running"].includes(context.run.status) ||
      activeAgentStatus(context.agent.status) !== "active" ||
      (requireOwnership && !responder &&
        (context.issue.assigneeAgentId !== this.#binding.agentId ||
          context.issue.executionRunId !== this.#binding.runId))
    ) {
      throw new Error("paperclip_runner_semantic_binding_inactive");
    }
  }
}
