/* oxlint-disable eslint/no-await-in-loop -- Transaction mutations and validations must follow their dependent writes. */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  agentSessions,
  db,
  memoryBindings,
  memoryJobs,
  memorySources,
  memoryState,
} from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  eligibleKnowledgeText,
  hasKnowledgeEditIntent,
} from "@shared/memory/policy";
import {
  memorySourceSchema,
  type MemorySourceInput,
} from "@shared/memory/schema";
import {
  disableMemorySessionCapture,
  lockMemoryState,
  requireMemoryMembership,
  type MemoryTransaction,
} from "./scope";

export async function enqueueMemoryJob(
  transaction: MemoryTransaction,
  scope: AccessScope,
  scopeKey: string,
  epoch: number
) {
  const [pending] = await transaction
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.workspaceId, scope.workspaceId),
        eq(memoryJobs.scopeKey, scopeKey),
        eq(memoryJobs.status, "pending")
      )
    )
    .limit(1);
  if (pending) return pending;
  const [job] = await transaction
    .insert(memoryJobs)
    .values({
      workspaceId: scope.workspaceId,
      scopeKey,
      requestedByUserId: scope.userId,
      epoch,
    })
    .returning();
  if (!job) throw new Error("Memory maintenance could not be queued.");
  return job;
}

export async function insertMemorySources(
  transaction: MemoryTransaction,
  scope: AccessScope,
  scopeKey: string,
  inputs: readonly MemorySourceInput[]
) {
  const inserted = [];
  for (const value of inputs) {
    const input = memorySourceSchema.parse(value);
    if (input.kind === "user" && !input.sessionId)
      throw new Error(
        "A direct user memory source requires a trusted session binding."
      );
    const [existing] = await transaction
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.workspaceId, scope.workspaceId),
          eq(memorySources.scopeKey, scopeKey),
          eq(memorySources.id, input.id)
        )
      )
      .limit(1);
    if (existing) {
      if (existing.text !== null && existing.text !== input.text)
        throw new Error(
          "A memory source identity cannot be reused for different content."
        );
      continue;
    }
    const [state] = await transaction
      .select()
      .from(memoryState)
      .where(
        and(
          eq(memoryState.workspaceId, scope.workspaceId),
          eq(memoryState.scopeKey, scopeKey)
        )
      )
      .limit(1);
    let disabled =
      input.sensitive ||
      input.excluded ||
      !eligibleKnowledgeText(input.text) ||
      (input.kind !== "user_edit" &&
        state?.forgetBefore !== null &&
        state?.forgetBefore !== undefined &&
        new Date(input.observedAt) <= state.forgetBefore);
    if (input.sessionId) {
      const [session] = await transaction
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.sessionId, input.sessionId),
            eq(agentSessions.workspaceId, scope.workspaceId),
            eq(agentSessions.createdByUserId, scope.userId)
          )
        )
        .limit(1);
      if (!session)
        throw new Error("A memory source must belong to this workspace.");
      const [binding] = await transaction
        .select()
        .from(memoryBindings)
        .where(
          and(
            eq(memoryBindings.sessionId, input.sessionId),
            eq(memoryBindings.workspaceId, scope.workspaceId),
            eq(memoryBindings.scopeKey, scopeKey)
          )
        )
        .limit(1);
      if (input.kind === "user" && !binding)
        throw new Error("The input session has no trusted memory binding.");
      disabled ||=
        input.kind === "user" &&
        (binding?.captureDisabled === true ||
          (binding !== undefined &&
            new Date(input.observedAt) < binding.captureAfter));
    }
    const [source] = await transaction
      .insert(memorySources)
      .values({
        workspaceId: scope.workspaceId,
        scopeKey,
        id: input.id,
        kind: input.kind,
        text: disabled ? null : input.text,
        reference: disabled ? null : input.reference,
        sessionId: input.sessionId,
        turnId: input.turnId,
        observedAt: new Date(input.observedAt),
        status: disabled
          ? "excluded"
          : input.kind === "user" &&
              (hasKnowledgeEditIntent(input.text, "remember") ||
                hasKnowledgeEditIntent(input.text, "correct"))
            ? "processed"
            : "pending",
      })
      .returning();
    if (source) inserted.push(source);
  }
  return inserted;
}

export async function captureMemorySource(
  scope: AccessScope,
  scopeKey: string,
  input: MemorySourceInput,
  _operationId?: string
) {
  return db.transaction(async (transaction) => {
    const state = await lockMemoryState(transaction, scope, scopeKey);
    const inserted = await insertMemorySources(transaction, scope, scopeKey, [
      input,
    ]);
    if (inserted.some((source) => source.status === "pending")) {
      await transaction
        .update(memoryState)
        .set({ inputRevision: state.inputRevision + 1 })
        .where(
          and(
            eq(memoryState.workspaceId, scope.workspaceId),
            eq(memoryState.scopeKey, scopeKey)
          )
        );
      await enqueueMemoryJob(transaction, scope, scopeKey, state.deletionEpoch);
    }
    const [source] = await transaction
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.workspaceId, scope.workspaceId),
          eq(memorySources.scopeKey, scopeKey),
          eq(memorySources.id, input.id)
        )
      )
      .limit(1);
    return source ?? null;
  });
}

export async function listMemorySources(
  scope: AccessScope,
  scopeKey: string,
  input: { pendingOnly?: boolean; limit?: number } = {}
) {
  await requireMemoryMembership(scope);
  return db
    .select()
    .from(memorySources)
    .where(
      and(
        eq(memorySources.workspaceId, scope.workspaceId),
        eq(memorySources.scopeKey, scopeKey),
        isNotNull(memorySources.text),
        input.pendingOnly ? eq(memorySources.status, "pending") : undefined
      )
    )
    .orderBy(asc(memorySources.createdAt), asc(memorySources.id))
    .limit(
      z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 30)
    );
}

export async function readMemorySource(
  scope: AccessScope,
  scopeKey: string,
  id: string
) {
  await requireMemoryMembership(scope);
  const [source] = await db
    .select()
    .from(memorySources)
    .where(
      and(
        eq(memorySources.workspaceId, scope.workspaceId),
        eq(memorySources.scopeKey, scopeKey),
        eq(memorySources.id, id),
        isNotNull(memorySources.text)
      )
    )
    .limit(1);
  return source ?? null;
}

export async function recordMemoryRecovery(
  scope: AccessScope,
  scopeKey: string,
  sessionId: string,
  input: {
    expectedCursor: number;
    nextCursor: number;
    sources: readonly MemorySourceInput[];
    captureDisabled?: boolean;
  }
) {
  z.number().int().nonnegative().parse(input.expectedCursor);
  z.number().int().min(input.expectedCursor).parse(input.nextCursor);
  return db.transaction(async (transaction) => {
    await lockMemoryState(transaction, scope, scopeKey);
    const [binding] = await transaction
      .select()
      .from(memoryBindings)
      .where(
        and(
          eq(memoryBindings.workspaceId, scope.workspaceId),
          eq(memoryBindings.scopeKey, scopeKey),
          eq(memoryBindings.sessionId, sessionId),
          eq(memoryBindings.userId, scope.userId)
        )
      )
      .limit(1)
      .for("update");
    if (!binding || binding.cursor !== input.expectedCursor)
      throw new Error("The memory recovery cursor changed.");
    if (input.captureDisabled)
      await disableMemorySessionCapture(
        transaction,
        scope,
        scopeKey,
        sessionId
      );
    const currentState = await lockMemoryState(transaction, scope, scopeKey);
    const inserted = await insertMemorySources(
      transaction,
      scope,
      scopeKey,
      input.sources
    );
    if (inserted.some((source) => source.status === "pending")) {
      await transaction
        .update(memoryState)
        .set({ inputRevision: currentState.inputRevision + 1 })
        .where(
          and(
            eq(memoryState.workspaceId, scope.workspaceId),
            eq(memoryState.scopeKey, scopeKey)
          )
        );
      await enqueueMemoryJob(
        transaction,
        scope,
        scopeKey,
        currentState.deletionEpoch
      );
    }
    await transaction
      .update(memoryBindings)
      .set({ cursor: input.nextCursor, updatedAt: new Date() })
      .where(
        and(
          eq(memoryBindings.workspaceId, scope.workspaceId),
          eq(memoryBindings.scopeKey, scopeKey),
          eq(memoryBindings.sessionId, sessionId)
        )
      );
    return { cursor: input.nextCursor, captured: inserted.length };
  });
}
