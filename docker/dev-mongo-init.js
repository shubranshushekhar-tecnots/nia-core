// Runs automatically on first boot of the dev-mongo scratch container
// (mounted at /docker-entrypoint-initdb.d — see docker-compose.yml), once
// the mongo image's own root-user bootstrap (MONGO_INITDB_ROOT_USERNAME/
// MONGO_INITDB_ROOT_PASSWORD) has run and auth is enabled. Unlike
// dev-mysql/dev-postgres, the plain `mongo:7` image ships with auth
// disabled and no equivalent of MYSQL_USER/MYSQL_PASSWORD for a
// non-root user — this script provisions the actual read-only role
// (nia_ro) connector-mongodb is meant to connect as, scoped to the
// `sandbox` database (so it doubles as that connection's authSource),
// and seeds a small collection so there's something to query.

db = db.getSiblingDB("sandbox");

db.createUser({
  user: "nia_ro",
  pwd: "nia_ro_pw",
  roles: [{ role: "read", db: "sandbox" }],
});

db.sandbox_items.insertMany([
  { _id: 1, name: "seed-1" },
  { _id: 2, name: "seed-2" },
]);

// Gives the chat pipeline's live smoke test (apps/worker/scripts/chat-smoke.ts)
// something concrete to query and cite ("who has the highest salary?").
db.employees.insertMany([
  { _id: 1, name: "Ada Lovelace", salary: 145000 },
  { _id: 2, name: "Grace Hopper", salary: 162000 },
  { _id: 3, name: "Alan Turing", salary: 158000 },
]);
