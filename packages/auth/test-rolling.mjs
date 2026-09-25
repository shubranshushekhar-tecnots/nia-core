import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://postgres:postgres@127.0.0.1:54322/postgres" });
const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  advanced: { database: { generateId: "uuid" } },
  plugins: [bearer()],
});

const signup = await auth.api.signUpEmail({
  body: { email: `rolling-test-${Date.now()}@example.com`, password: "password123", name: "Rolling Test" },
  returnHeaders: true,
});
const setCookie = signup.headers.get("set-cookie");
const cookiePair = setCookie.split(";")[0];
const rawValue = decodeURIComponent(cookiePair.split("=").slice(1).join("="));
const rawToken = rawValue.split(".")[0];

// simulate a session that's about to expire soon (well within the updateAge window)
await pool.query(`update "session" set "expiresAt" = now() + interval '2 hours' where token = $1`, [rawToken]);

const headers = new Headers();
headers.set("cookie", cookiePair);
const result = await auth.api.getSession({ headers, returnHeaders: true });
console.log("session:", JSON.stringify(result.response?.session ?? result.response));
console.log("set-cookie on response:", result.headers.get("set-cookie"));

// also verify via bearer header path
const bearerHeaders = new Headers();
bearerHeaders.set("authorization", `Bearer ${setCookie.match(/set-auth-token/) ? "" : ""}`);
await pool.end();
