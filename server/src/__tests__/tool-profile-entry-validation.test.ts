import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, toolApplications, toolCatalogEntries, toolConnections, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import type { CreateToolProfileEntryForProfile } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("tool profile entry validation", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-profile-entry-validation-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const id of companyIds.splice(0)) await db.delete(companies).where(eq(companies.id, id));
  });

  afterAll(async () => { await database?.cleanup(); });

  async function fixture(count = 1) {
    const [company] = await db.insert(companies).values({
      name: `Profile fixture ${randomUUID()}`, issuePrefix: `PV${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    companyIds.push(company.id);
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id, name: `Application ${randomUUID()}`, type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: "Fixture connection", uid: `fixture/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, config: {}, transportConfig: {}, healthStatus: "ok",
    }).returning();
    const catalog = await db.insert(toolCatalogEntries).values(Array.from({ length: count }, (_, index) => ({
      companyId: company.id, applicationId: application.id, connectionId: connection.id,
      name: `tool_${index}`, toolName: `tool_${index}`, riskLevel: "read" as const, status: "active" as const,
      versionHash: randomUUID(), schemaHash: randomUUID(),
    }))).returning();
    const entries: CreateToolProfileEntryForProfile[] = catalog.map(entry => ({
      selectorType: "catalog_entry", effect: "include", applicationId: application.id,
      connectionId: connection.id, catalogEntryId: entry.id,
    }));
    return { company, application, connection, catalog, entries };
  }

  function countedService() {
    let selects = 0;
    const counted = new Proxy(db, { get(target, key) {
      if (key === "select") return (...args: unknown[]) => {
        selects++;
        return Reflect.apply(target.select, target, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { service: toolAccessService(counted), reads: () => selects };
  }

  it("creates all 518 exact selectors without per-entry database reads", async () => {
    const { company, entries } = await fixture(518);
    const { service, reads } = countedService();
    const started = performance.now();
    const profile = await service.createProfile(company.id, {
      profileKey: `cold-${randomUUID()}`, name: "Cold runtime assignment", defaultAction: "deny", entries,
    });
    const elapsedMs = performance.now() - started;
    const saved = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(saved).toHaveLength(518);
    expect(new Set(saved.map(entry => entry.catalogEntryId))).toEqual(new Set(entries.map(entry => entry.catalogEntryId)));
    console.info(JSON.stringify({ operation: "create", entries: 518, selects: reads(), elapsedMs }));
    expect(reads()).toBeLessThanOrEqual(24);
  });

  it("replaces 518 selectors without repeating per-entry reads", async () => {
    const { company, entries } = await fixture(518);
    const existing = await toolAccessService(db).createProfile(company.id, {
      profileKey: `replace-${randomUUID()}`, name: "Before replacement", entries: [entries[0]],
    });
    const { service, reads } = countedService();
    const started = performance.now();
    await service.updateProfile(existing.id, { name: "After replacement", entries });
    const elapsedMs = performance.now() - started;
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, existing.id))).toHaveLength(518);
    console.info(JSON.stringify({ operation: "replace", entries: 518, selects: reads(), elapsedMs }));
    expect(reads()).toBeLessThanOrEqual(32);
  });

  it.each(["application", "connection", "catalog"] as const)("rejects a foreign %s before creating or replacing a profile", async kind => {
    const own = await fixture();
    const foreign = await fixture();
    const service = toolAccessService(db);
    const profile = await service.createProfile(own.company.id, {
      profileKey: `preserve-${randomUUID()}`, name: "Preserved profile", entries: own.entries,
    });
    const invalid = { ...own.entries[0], ...({
      application: { applicationId: foreign.application.id },
      connection: { connectionId: foreign.connection.id },
      catalog: { catalogEntryId: foreign.catalog[0].id },
    }[kind]) };
    const status = kind === "catalog" ? 422 : 404;
    const key = `rejected-${randomUUID()}`;
    await expect(service.createProfile(own.company.id, { profileKey: key, name: "Rejected", entries: [invalid] }))
      .rejects.toMatchObject({ status });
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, key))).toEqual([]);
    await expect(service.updateProfile(profile.id, { name: "Must not change", entries: [invalid] }))
      .rejects.toMatchObject({ status });
    expect((await service.getProfile(profile.id)).name).toBe("Preserved profile");
    const saved = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(saved).toHaveLength(1);
    expect(saved[0].catalogEntryId).toBe(own.catalog[0].id);
  });

  it.each([
    ["application", "Application profile entries require applicationId"],
    ["connection", "Connection profile entries require connectionId"],
    ["catalog_entry", "Catalog-entry profile entries require catalogEntryId"],
    ["tool_name", "Tool-name profile entries require toolName"],
    ["risk_level", "Risk-level profile entries require riskLevel"],
  ] as const)("preserves the required %s selector check", async (selectorType, message) => {
    const { company } = await fixture();
    await expect(toolAccessService(db).createProfile(company.id, {
      profileKey: `missing-${randomUUID()}`, name: "Missing selector", entries: [{ selectorType, effect: "include" }],
    })).rejects.toMatchObject({ status: 400, message });
  });

  it("preserves input-order errors when a later selector has a missing field", async () => {
    const own = await fixture();
    const foreign = await fixture();
    await expect(toolAccessService(db).createProfile(own.company.id, {
      profileKey: `ordered-${randomUUID()}`, name: "Ordered errors", entries: [
        { ...own.entries[0], applicationId: foreign.application.id },
        { selectorType: "tool_name", effect: "include" },
      ],
    })).rejects.toMatchObject({ status: 404, message: "Tool application not found" });
  });

  it("does not reuse validation after a catalog entry is removed", async () => {
    const { company, catalog, entries } = await fixture();
    const service = toolAccessService(db);
    await service.createProfile(company.id, { profileKey: `valid-${randomUUID()}`, name: "Before removal", entries });
    await db.delete(toolCatalogEntries).where(eq(toolCatalogEntries.id, catalog[0].id));
    await expect(service.createProfile(company.id, { profileKey: `after-${randomUUID()}`, name: "After removal", entries }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("does not authorize a foreign UUID through another connection's matching UID", async () => {
    const own = await fixture();
    const foreign = await fixture();
    await db.update(toolConnections).set({ uid: foreign.connection.id }).where(eq(toolConnections.id, own.connection.id));
    await expect(toolAccessService(db).createProfile(own.company.id, {
      profileKey: `uid-collision-${randomUUID()}`, name: "UID collision", entries: [
        own.entries[0], { ...own.entries[0], connectionId: foreign.connection.id },
      ],
    })).rejects.toMatchObject({ status: 404, message: "Tool connection not found" });
  });

  it("rejects a foreign catalog selector in the second lookup batch", async () => {
    const own = await fixture(518);
    const foreign = await fixture();
    own.entries[517] = { ...own.entries[517], catalogEntryId: foreign.catalog[0].id };
    const profileKey = `last-batch-${randomUUID()}`;
    await expect(toolAccessService(db).createProfile(own.company.id, {
      profileKey, name: "Last batch", entries: own.entries,
    })).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, profileKey))).toEqual([]);
  });

  it("preserves PostgreSQL UUID case matching", async () => {
    const own = await fixture();
    const profile = await toolAccessService(db).createProfile(own.company.id, {
      profileKey: `upper-${randomUUID()}`, name: "Uppercase identifiers", entries: [{
        ...own.entries[0], applicationId: own.application.id.toUpperCase(),
        connectionId: own.connection.id.toUpperCase(), catalogEntryId: own.catalog[0].id.toUpperCase(),
      }],
    });
    const [saved] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
    expect(saved).toMatchObject({ applicationId: own.application.id, connectionId: own.connection.id, catalogEntryId: own.catalog[0].id });
  });
});
