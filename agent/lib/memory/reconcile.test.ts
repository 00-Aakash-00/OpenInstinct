import type * as Ai from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { findMemoryRecords } from "@db/services/memory/records";
import type { listMemorySources } from "@db/services/memory/sources";

const mocks = vi.hoisted(() => ({
  generate:
    vi.fn<
      (
        input: Parameters<typeof Ai.generateText>[0]
      ) => Promise<{ output: unknown }>
    >(),
  records: vi.fn<typeof findMemoryRecords>(),
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof Ai>()),
  generateText: mocks.generate,
}));
vi.mock("@db/services/settings", () => ({
  getGatewayModel: vi
    .fn<() => Promise<string>>()
    .mockResolvedValue("test-model"),
}));
vi.mock("@db/services/memory/records", () => ({
  findMemoryRecords: mocks.records,
}));
import { reconcileKnowledge } from "./reconcile";

const scope = { workspaceId: "workspace", userId: "user" };
const text = "I prefer quiet train cars.";
const source = {
  id: "source",
  workspaceId: scope.workspaceId,
  scopeKey: "key",
  kind: "user",
  text,
  reference: "session:test",
  sessionId: "session",
  turnId: "turn",
  observedAt: new Date("2026-10-21T12:00:00Z"),
  createdAt: new Date(),
  version: 1,
  status: "pending",
} satisfies Awaited<ReturnType<typeof listMemorySources>>[number];
const claim = {
  sourceId: "source",
  quote: text,
  kind: "preference",
  replacesId: null,
};
const record = {
  id: "preference",
  revision: 3,
  explicit: false,
  updatedAt: "2026-10-20T12:00:00Z",
  content: {
    kind: "preference" as const,
    title: "Train cars",
    body: "I prefer busy train cars.",
    aliases: [],
    status: "active" as const,
    evidence: [{ sourceId: "old", start: 0, end: 24 }],
    effectiveAt: null,
    expiresAt: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.records.mockResolvedValue({ items: [], nextOffset: null });
  mocks.generate.mockResolvedValue({ output: { claims: [claim] } });
});
const run = (
  sources: Awaited<ReturnType<typeof listMemorySources>> = [source]
) => reconcileKnowledge(scope, "key", sources, new AbortController().signal);

describe("restricted knowledge reconciliation", () => {
  it("keeps literal source provenance and stable identities without providing tools", async () => {
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first.records[0]).toMatchObject({
      expectedRevision: 0,
      content: {
        body: text,
        evidence: [{ sourceId: "source", start: 0, end: text.length }],
      },
    });
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, maxOutputTokens: 3_000 })
    );
    expect(mocks.generate.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it.each([
    { ...claim, sourceId: "invented" },
    { ...claim, quote: "I prefer noisy cars." },
    { ...claim, quote: "quiet train cars." },
    { ...claim, replacesId: "unknown" },
  ])("rejects unsupported claims: %s", async (candidate) => {
    mocks.generate.mockResolvedValue({ output: { claims: [candidate] } });
    expect((await run()).records).toEqual([]);
  });

  it("rejects pasted and repeated quotes, commands, and browser receipts", async () => {
    await Promise.all(
      [
        { ...source, text: `Website says: “${text}”` },
        { ...source, text: `${text} ${text}` },
        { ...source, text: `Website says: "${text}"` },
        { ...source, text: `For this week, ${text}` },
        { ...source, text: `For now, ${text}` },
        { ...source, text: `Remember ${text}` },
        { ...source, kind: "browser_receipt" as const },
      ].map(async (invalid) => {
        expect((await run([invalid])).records).toEqual([]);
      })
    );
  });

  it("uses optimistic revision on unmistakable corrections and protects explicit records", async () => {
    mocks.records.mockResolvedValue({ items: [record], nextOffset: null });
    mocks.generate.mockResolvedValue({
      output: { claims: [{ ...claim, replacesId: record.id }] },
    });
    expect((await run()).records).toEqual([]);
    expect(
      (await run([{ ...source, text: `Actually, ${text}` }])).records[0]
    ).toMatchObject({ id: record.id, expectedRevision: 3 });
    mocks.records.mockResolvedValue({
      items: [{ ...record, explicit: true }],
      nextOffset: null,
    });
    expect(
      (await run([{ ...source, text: `Actually, ${text}` }])).records
    ).toEqual([]);
  });

  it("rejects oversized batches before model use", async () => {
    await expect(
      run([{ ...source, text: "a".repeat(16_001) }])
    ).rejects.toThrow("budget");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.records).not.toHaveBeenCalled();
  });

  it("finds an older correction target by source relevance instead of its position in the recent page", async () => {
    mocks.records.mockImplementation((_scope, _key, input) =>
      Promise.resolve({
        items: input?.query?.includes("train") ? [record] : [],
        nextOffset: null,
      })
    );
    mocks.generate.mockResolvedValue({
      output: { claims: [{ ...claim, replacesId: record.id }] },
    });
    const result = await run([{ ...source, text: `Actually, ${text}` }]);
    expect(result.records[0]).toMatchObject({
      id: record.id,
      expectedRevision: record.revision,
    });
    const prompt = mocks.generate.mock.calls[0]?.[0].prompt;
    expect(prompt).toEqual(expect.any(String));
    expect(prompt).toContain(record.content.body);
  });

  it("deduplicates existing facts and rejects malformed structured output", async () => {
    mocks.records.mockResolvedValue({
      items: [{ ...record, content: { ...record.content, body: text } }],
      nextOffset: null,
    });
    expect((await run()).records).toEqual([]);
    mocks.generate.mockResolvedValue({
      output: { claims: [{ ...claim, tools: ["send-email"] }] },
    });
    await expect(run()).rejects.toThrow("Unrecognized key");
  });
});
