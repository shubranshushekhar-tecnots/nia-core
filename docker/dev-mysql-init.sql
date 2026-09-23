-- Runs automatically on first boot of the dev-mysql scratch container
-- (mounted at /docker-entrypoint-initdb.d — see docker-compose.yml), after
-- the mysql image's own MYSQL_USER/MYSQL_PASSWORD provisioning has already
-- run. That provisioning grants nia_ro ALL PRIVILEGES on `sandbox` (there's
-- no env var to make it read-only from the start) — this script narrows it
-- down to the actual read-only role connector-mysql is meant to connect as,
-- and seeds a small table so there's something to select.

CREATE TABLE IF NOT EXISTS sandbox_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

INSERT IGNORE INTO sandbox_items (id, name) VALUES (1, 'seed-1'), (2, 'seed-2');

-- Gives the chat pipeline's live smoke test (apps/worker/scripts/chat-smoke.ts)
-- something concrete to query and cite ("who has the highest salary?").
CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  salary INT NOT NULL
);

INSERT IGNORE INTO employees (id, name, salary) VALUES
  (1, 'Ada Lovelace', 145000),
  (2, 'Grace Hopper', 162000),
  (3, 'Alan Turing', 158000);

REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'nia_ro'@'%';
GRANT SELECT ON sandbox.* TO 'nia_ro'@'%';
FLUSH PRIVILEGES;
