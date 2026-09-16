import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, it, expect, afterAll } from "vitest";
import { subscribeWithReplay, type ReplayEnvelope } from "./sse.js";

/**
 * Regression coverage for Phase 4's replay fix (see PHASE4_EXIT.md). Exercises
 * subscribeWithReplay against a REAL local Redis (docker-compose's `redis`
 * service, already running in dev — see CLAUDE.md/memory) rather than mocking
 * ioredis, since the whole point of this fix is real subscribe/LRANGE/PUBLISH
 * ordering, which a mock can't meaningfully stand in for.
 */

type TestEvent = { type: "token" | "done"; value: number };

const REDIS_URL = "redis://localhost:6379";

function envelope(seq: number, event: TestEvent): ReplayEnvelope<TestEvent> {
  return { seq, ts: Date.now(), event };
}

const isTerminal = (event: TestEvent) => event.type === "done";

const commands = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

afterAll(async () => {
  commands.disconnect();
  publisher.disconnect();
});

function keysFor() {
  const id = randomUUID();
  return { channel: `test:chat:events:${id}`, listKey: `test:chat:events:log:${id}` };
}

async function seedLog(listKey: string, envelopes: ReplayEnvelope<TestEvent>[]) {
  if (envelopes.length === 0) return;
  await commands.rpush(listKey, ...envelopes.map((e) => JSON.stringify(e)));
  await commands.expire(listKey, 60);
}

async function collect(
  channel: string,
  listKey: string,
  options?: { afterSeq?: number },
): Promise<TestEvent[]> {
  const controller = new AbortController();
  const received: TestEvent[] = [];
  await subscribeWithReplay<TestEvent>(REDIS_URL, {
    channel,
    listKey,
    afterSeq: options?.afterSeq,
    signal: controller.signal,
    isTerminal,
    onEnvelope: (e) => received.push(e.event),
  });
  return received;
}

describe("subscribeWithReplay", () => {
  it("late-connect: subscribing after the job already finished replays the full ordered log", async () => {
    const { channel, listKey } = keysFor();
    await seedLog(listKey, [
      envelope(1, { type: "token", value: 1 }),
      envelope(2, { type: "token", value: 2 }),
      envelope(3, { type: "done", value: 3 }),
    ]);

    const events = await collect(channel, listKey);

    expect(events).toEqual([
      { type: "token", value: 1 },
      { type: "token", value: 2 },
      { type: "done", value: 3 },
    ]);
  });

  it("live events published after the connect resolve, in order, exactly once, and stop at the terminal event", async () => {
    const { channel, listKey } = keysFor();
    await seedLog(listKey, [envelope(1, { type: "token", value: 1 })]);

    const promise = collect(channel, listKey);

    // Give subscribeWithReplay time to subscribe + drain the 1-entry replay
    // log and settle into live mode before we publish anything live.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const seq2 = envelope(2, { type: "token", value: 2 });
    const seq3 = envelope(3, { type: "done", value: 3 });
    await commands.rpush(listKey, JSON.stringify(seq2)); // write-before-notify, same as publish.ts
    await publisher.publish(channel, JSON.stringify(seq2));
    await commands.rpush(listKey, JSON.stringify(seq3));
    await publisher.publish(channel, JSON.stringify(seq3));

    const events = await promise;

    expect(events).toEqual([
      { type: "token", value: 1 },
      { type: "token", value: 2 },
      { type: "done", value: 3 },
    ]);
  });

  it("afterSeq resume: already-delivered events (replay and live) are skipped exactly once via seq dedup", async () => {
    const { channel, listKey } = keysFor();
    await seedLog(listKey, [
      envelope(1, { type: "token", value: 1 }),
      envelope(2, { type: "token", value: 2 }),
      envelope(3, { type: "done", value: 3 }),
    ]);

    const events = await collect(channel, listKey, { afterSeq: 1 });

    expect(events).toEqual([
      { type: "token", value: 2 },
      { type: "done", value: 3 },
    ]);
  });

  it("aborting the signal before a terminal event resolves the subscription instead of hanging", async () => {
    const { channel, listKey } = keysFor();
    await seedLog(listKey, [envelope(1, { type: "token", value: 1 })]);

    const controller = new AbortController();
    const received: TestEvent[] = [];
    const promise = subscribeWithReplay<TestEvent>(REDIS_URL, {
      channel,
      listKey,
      signal: controller.signal,
      isTerminal,
      onEnvelope: (e) => received.push(e.event),
    });

    setTimeout(() => controller.abort(), 100);
    await promise; // must resolve, not hang, since no terminal event is ever published

    expect(received).toEqual([{ type: "token", value: 1 }]);
  });
});
