import { auth } from "../lib/auth.js";
import { dbPool } from "../lib/dbPool.js";

/**
 * Admin command to set a user's password directly, since there's no
 * password-reset flow yet (docs/plans/auth.md Step 2, requirement "An
 * admin command to set a user's password directly"). Uses Better Auth's
 * own context — its password hasher + internalAdapter — never writes a
 * hash by hand, since the hash format/params are internal to Better Auth
 * (same rule as seedFixtureUsers.ts).
 *
 *   pnpm --filter @nia/api set-password <email> <newPassword>
 */
async function main() {
  const [email, newPassword] = process.argv.slice(2);
  if (!email || !newPassword) {
    console.error("usage: pnpm --filter @nia/api set-password <email> <newPassword>");
    process.exit(1);
  }

  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  const hashed = await ctx.password.hash(newPassword);
  const existingAccount = await ctx.internalAdapter.findCredentialAccount(found.user.id);
  if (existingAccount) {
    await ctx.internalAdapter.updatePassword(found.user.id, hashed);
  } else {
    await ctx.internalAdapter.createAccount({
      userId: found.user.id,
      providerId: "credential",
      accountId: found.user.id,
      password: hashed,
    });
  }

  console.log(`password set for ${email} (${found.user.id})`);
  await dbPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
