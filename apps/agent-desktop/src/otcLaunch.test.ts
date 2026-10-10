import { describe, expect, it, vi } from "vitest";
import { AgentNotRunningError, buildLaunchUrl, mintOtc } from "./otcLaunch.js";

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("mintOtc", () => {
  it("returns the otc on a successful 200 response", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ otc: "abc123" }), { status: 200 }));
    await expect(mintOtc(57415, "token", fetchImpl)).resolves.toBe("abc123");
  });

  it("sends the bearer token to the right URL", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("http://127.0.0.1:57415/otc");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer my-token");
      return new Response(JSON.stringify({ otc: "x" }), { status: 200 });
    });
    await mintOtc(57415, "my-token", fetchImpl);
  });

  it("throws AgentNotRunningError on a network error", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(mintOtc(57415, "token", fetchImpl)).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("throws AgentNotRunningError on a non-200 response", async () => {
    const fetchImpl = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(mintOtc(57415, "token", fetchImpl)).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("throws AgentNotRunningError on a malformed body", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ notOtc: true }), { status: 200 }));
    await expect(mintOtc(57415, "token", fetchImpl)).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("throws AgentNotRunningError on invalid JSON", async () => {
    const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(mintOtc(57415, "token", fetchImpl)).rejects.toBeInstanceOf(AgentNotRunningError);
  });
});

describe("buildLaunchUrl", () => {
  it("builds the otc query URL for the given port", () => {
    expect(buildLaunchUrl(57415, "abc123")).toBe("http://127.0.0.1:57415/?otc=abc123");
  });
});
