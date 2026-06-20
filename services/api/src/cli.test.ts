import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

// Tiny stub that speaks the API↔CLI contract:
//   - argv[2..] are the command args passed by runCli
//   - exit 0 + JSON to stdout on success
//   - exit 1 + message to stderr when first arg is "fail"
const STUB_SRC = `
const args = process.argv.slice(2);
if (args[0] === "fail") {
  process.stderr.write("stub error");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, args }));
process.exit(0);
`;

let stubDir: string;
let stubPath: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "archer-cli-stub-"));
  stubPath = join(stubDir, "stub.mjs");
  writeFileSync(stubPath, STUB_SRC);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("runCli", () => {
  it("fails closed when ARCHER_CLI_PATH is not set", async () => {
    await expect(runCli(["collect", "board"], {})).rejects.toThrow(
      "ARCHER_CLI_PATH is not configured",
    );
  });

  it("round-trip: args reach the stub and JSON comes back", async () => {
    const env = { ...process.env, ARCHER_CLI_PATH: stubPath };
    const result = await runCli(["collect", "test-board", "--json"], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { ok: boolean; args: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.args).toEqual(["collect", "test-board", "--json"]);
  });

  it("captures non-zero exit code and stderr on failure", async () => {
    const env = { ...process.env, ARCHER_CLI_PATH: stubPath };
    const result = await runCli(["fail"], env);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("stub error");
    expect(result.stdout).toBe("");
  });
});
