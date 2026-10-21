import { defineEval } from "eve/evals";
import { env } from "@shared/environment";
import { agentEvalTags, requireDeliveredText } from "@evals/agent/shared";

export default defineEval({
  description:
    "Remembers, corrects, recalls and forgets a preference across fresh sessions",
  tags: [...agentEvalTags, "knowledge-memory"],
  timeoutMs: 300_000,
  async test(t) {
    if (env.KNOWLEDGE_MEMORY_MODE !== "enabled") {
      t.skip("Set KNOWLEDGE_MEMORY_MODE=enabled for this opt-in evaluation.");
      return;
    }
    let forgotten = false;
    try {
      const first = await t.send(
        "Remember this preference for future train trips: I prefer a window seat in the quiet car."
      );
      first.expectOk();
      first.calledTool("knowledge__remember", { count: 1 });
      await requireDeliveredText(t, first);

      const correctionSession = await t.session();
      const correction = await correctionSession.send(
        "Correct my saved train seating preference: I now prefer an aisle seat in the quiet car. Replace my old preference."
      );
      correction.expectOk();
      correction.calledTool("knowledge__correct", { count: 1 });
      await requireDeliveredText(t, correction);

      const recallSession = await t.session();
      const recall = await recallSession.send(
        "What seating preference should you use for my next train trip, and what is the evidence?"
      );
      recall.expectOk();
      const recalled = await requireDeliveredText(t, recall);
      t.judge(
        "The response says the user's current preference is an aisle seat in the quiet car, attributes it to the user's correction, and does not recommend a window seat as their current preference. It does not invent a source or claim to have booked travel.",
        { on: recalled }
      ).atLeast(0.9);

      const deletion = await recallSession.send(
        "Forget my saved train seating preference, including its prior versions."
      );
      deletion.expectOk();
      deletion.calledTool("knowledge__forget", { count: 1 });
      await requireDeliveredText(t, deletion);
      forgotten = true;

      const laterSession = await t.session();
      const later = await laterSession.send(
        "Do you have a saved seating preference for my train trips?"
      );
      later.expectOk();
      const answer = await requireDeliveredText(t, later);
      t.judge(
        "The response correctly says no saved train seating preference is available, or asks the user to supply one. It does not state or imply the forgotten window-seat, aisle-seat or quiet-car preference is still known. General suggestions are clearly distinguished from remembered facts.",
        { on: answer }
      ).atLeast(0.9);
    } finally {
      if (!forgotten) {
        const cleanup = await t.session();
        const result = await cleanup.send(
          "Forget any saved train seating preference from this evaluation, including all its prior versions."
        );
        result.expectOk();
      }
    }
  },
});
