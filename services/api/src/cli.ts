import { spawn } from "node:child_process";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the Archer CLI as a subprocess — the "API runs the CLI" model. The CLI
 * entry is configured via ARCHER_CLI_PATH; the child inherits the API's env
 * (DATABASE_URL, board creds, proxy), so the browser work stays isolated in the
 * CLI process (and, in prod, on a host with the VNC display).
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const cliPath = env.ARCHER_CLI_PATH;
  if (!cliPath) return Promise.reject(new Error("ARCHER_CLI_PATH is not configured"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
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
