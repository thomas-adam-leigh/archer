import { spawn } from "node:child_process";
import type { RunResult } from "./db.js";

/**
 * Run a shell command, capturing stdout/stderr/exit code. Mirrors the
 * `services/api/src/cli.ts` subprocess pattern, but for an arbitrary command
 * string (the scheduled "bash command") rather than the Archer CLI.
 *
 * The command runs through `sh -c`, so the stored string can use shell features
 * and quoting — e.g. the default `claude -p "@./services/scheduler/prompt.md"`.
 */
export function runCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
