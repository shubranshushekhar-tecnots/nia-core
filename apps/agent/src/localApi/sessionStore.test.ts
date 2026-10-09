import { describe, expect, it } from "vitest";
import { createSession, touchSession, SESSION_TTL_MS } from "./sessionStore.js";

describe("sessionStore", () => {
  it("a freshly created session is valid", () => {
    const id = createSession();
    expect(touchSession(id)).toBe(true);
  });

  it("an unknown session id is invalid", () => {
    expect(touchSession("not-a-real-session")).toBe(false);
  });

  it("expires after 12h of inactivity", () => {
    const createdAt = 1_000_000;
    const id = createSession(createdAt);
    expect(touchSession(id, createdAt + SESSION_TTL_MS + 1)).toBe(false);
  });

  it("stays valid right up to (but not including) the 12h boundary", () => {
    const createdAt = 1_000_000;
    const id = createSession(createdAt);
    expect(touchSession(id, createdAt + SESSION_TTL_MS)).toBe(true);
  });

  it("is a sliding window -- activity just under the limit resets the clock", () => {
    const createdAt = 1_000_000;
    const id = createSession(createdAt);
    // Touch again just before expiry -- this should refresh lastSeenAt.
    expect(touchSession(id, createdAt + SESSION_TTL_MS - 1)).toBe(true);
    // Another full window from THAT touch should still be valid, even
    // though it's now more than 12h past the original createSession call.
    expect(touchSession(id, createdAt + SESSION_TTL_MS - 1 + SESSION_TTL_MS)).toBe(true);
  });

  it("once expired, a session cannot be revived by touching it again", () => {
    const createdAt = 1_000_000;
    const id = createSession(createdAt);
    expect(touchSession(id, createdAt + SESSION_TTL_MS + 1)).toBe(false);
    expect(touchSession(id, createdAt + SESSION_TTL_MS + 2)).toBe(false);
  });
});
