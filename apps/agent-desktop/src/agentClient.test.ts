import { describe, expect, it, vi } from "vitest";
import { fetchAgentStatus } from "./agentClient.js";

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("fetchAgentStatus", () => {
  it("returns the parsed status on a successful 200 response", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ paired: true, online: true, platformUrl: "https://dev.niaconnector.com" }), { status: 200 }));
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toEqual({
      paired: true,
      online: true,
      platformUrl: "https://dev.niaconnector.com",
      revoked: undefined,
    });
  });

  it("sends the bearer token to the right URL", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("http://127.0.0.1:57415/status");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer my-token");
      return new Response(JSON.stringify({ paired: false }), { status: 200 });
    });
    await fetchAgentStatus(57415, "my-token", fetchImpl);
  });

  it("returns null on a network error (service not running)", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toBeNull();
  });

  it("returns null on a non-200 response", async () => {
    const fetchImpl = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toBeNull();
  });

  it("returns null on a malformed body (missing paired field)", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ notPaired: true }), { status: 200 }));
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toBeNull();
  });

  it("parses a well-formed pendingUpdate field", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ paired: true, online: true, pendingUpdate: { version: "2.0.0", readyToInstall: true } }), { status: 200 }),
    );
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toEqual({
      paired: true,
      online: true,
      platformUrl: undefined,
      revoked: undefined,
      pendingUpdate: { version: "2.0.0", readyToInstall: true },
    });
  });

  it("drops a malformed pendingUpdate field instead of failing the whole response", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ paired: true, pendingUpdate: { version: "2.0.0" } }), { status: 200 }));
    await expect(fetchAgentStatus(57415, "token", fetchImpl)).resolves.toEqual({
      paired: true,
      online: undefined,
      platformUrl: undefined,
      revoked: undefined,
      pendingUpdate: undefined,
    });
  });
});
