import readline from "node:readline";

/**
 * Reads one line from stdin without echoing it to the terminal — used for
 * secret values typed interactively (e.g. a job's push key). There is no
 * pre-existing secure-input mechanism in this codebase to reuse (SQL
 * passwords are passed as a plain `--password` CLI flag); this is new,
 * CLI-layer-only code, never imported by cli/jobCommands.ts's testable
 * functions (which always take the push key as a plain string parameter).
 * Falls back to a normal (echoed) read when stdin isn't a TTY, so piped
 * input keeps working for scripting/tests.
 */
export async function readSecretFromStdin(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const isTty = process.stdin.isTTY === true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
    if (isTty) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rl as any)._writeToOutput = () => {};
    }
    process.stdout.write(promptText);
    rl.question("", (answer) => {
      rl.close();
      if (isTty) process.stdout.write("\n");
      resolve(answer);
    });
  });
}
