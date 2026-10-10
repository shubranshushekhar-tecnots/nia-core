import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const acquireTokenByClientCredential = vi.fn(async () => ({ accessToken: "fake-token" }));

vi.mock("@azure/msal-node", () => ({
  // mockImplementation must be a regular function, not an arrow function —
  // the source does `new ConfidentialClientApplication(...)`, and arrow
  // functions can't be invoked as constructors.
  ConfidentialClientApplication: vi.fn().mockImplementation(function () {
    return { acquireTokenByClientCredential };
  }),
}));

describe("GraphMailTransport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acquires a token and POSTs sendMail to the configured sender's mailbox", async () => {
    const { GraphMailTransport } = await import("./graph.js");
    const transport = new GraphMailTransport({
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      sender: "notify@example.com",
    });

    await transport.send({
      to: "person@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: ["https://graph.microsoft.com/.default"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/users/notify%40example.com/sendMail",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fake-token");
    const body = JSON.parse(init.body as string);
    expect(body.message.toRecipients[0].emailAddress.address).toBe("person@example.com");
    expect(body.message.subject).toBe("Hello");
  });

  it("throws when Graph returns a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const { GraphMailTransport } = await import("./graph.js");
    const transport = new GraphMailTransport({
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      sender: "notify@example.com",
    });

    await expect(
      transport.send({ to: "p@example.com", subject: "s", html: "<p/>", text: "t" }),
    ).rejects.toThrow(/Microsoft Graph sendMail failed/);
  });
});
