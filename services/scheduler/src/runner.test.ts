import { describe, expect, it } from "vitest";
import { runCommand } from "./runner.js";

describe("runCommand", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runCommand("echo hello");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("captures a non-zero exit code", async () => {
    const result = await runCommand("exit 3");
    expect(result.code).toBe(3);
  });

  it("captures stderr", async () => {
    const result = await runCommand("echo oops 1>&2");
    expect(result.stderr.trim()).toBe("oops");
    expect(result.stdout).toBe("");
  });
});
