import { shellQuoteArg } from "../../src/utils/spawn-env.js";
import { processSandbox } from "../../src/sandbox/process-sandbox.js";
import { describe, test, expect } from "bun:test";

describe("shellQuoteArg newline / injection gap (Task5 Low)", () => {
  test("win32 newline escaped or rejected", () => {
    const q = shellQuoteArg("a\nb", "win32");
    // Before fix: "a\nb" (bare LF, no caret). After fix: contains "^\n" (caret-escaped)
    expect(q).toContain("^\n");
    expect(q).not.toBe("a\nb");
  });

  test("win32 \\r escaped", () => {
    const q = shellQuoteArg("a\rb", "win32");
    expect(q).toContain("^\r");
    expect(q).not.toBe("a\rb");
  });

  test("win32 backtick escaped", () => {
    const q = shellQuoteArg("`whoami`", "win32");
    expect(q).toContain("^`");
  });

  test("win32 $() escaped", () => {
    const q = shellQuoteArg("$(whoami)", "win32");
    expect(q).toContain("^$");
    expect(q).toContain("^(");
    expect(q).toContain("^)");
  });

  test("win32 $ standalone escaped", () => {
    const q = shellQuoteArg("a$b", "win32");
    expect(q).toContain("^$");
  });

  test("win32 parens escaped", () => {
    const q = shellQuoteArg("(test)", "win32");
    expect(q).toContain("^(");
    expect(q).toContain("^)");
  });

  test("posix single-quote wraps and newline rejected", () => {
    // Spec: POSIX must reject \n/\r (throw). Before fix: returns "'a\nb'" containing newline.
    expect(() => shellQuoteArg("a\nb", "linux")).toThrow(/newline/);
    expect(() => shellQuoteArg("a\rb", "linux")).toThrow(/newline/);
  });

  test("posix normal quoting still works (regression)", () => {
    const q = shellQuoteArg("a'b", "linux");
    expect(q).toBe("'a'\\''b'");
    const q2 = shellQuoteArg("hello world", "linux");
    expect(q2).toBe("'hello world'");
  });
});

describe("processSandbox args pre-check (Task5 second layer)", () => {
  test("rejects arg containing newline", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["a\nb"] });
    expect(r.exitCode).toBe(-1);
    expect(r.error).toMatch(/forbidden/);
  });

  test("rejects arg containing carriage return", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["a\rb"] });
    expect(r.exitCode).toBe(-1);
    expect(r.error).toMatch(/forbidden/);
  });

  test("rejects arg containing backtick", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["`whoami`"] });
    expect(r.exitCode).toBe(-1);
    expect(r.error).toMatch(/forbidden/);
  });

  test("rejects arg containing $()", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["$(whoami)"] });
    expect(r.exitCode).toBe(-1);
    expect(r.error).toMatch(/forbidden/);
  });

  test("allows bare $ (M1: bare $ not rejected, only $()/${)", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["$5"] });
    if (r.exitCode === -1 && r.error?.includes("forbidden")) {
      throw new Error("bare $ incorrectly rejected after M1 fix");
    }
    expect(r.exitCode).not.toBe(-1);
    const r2 = await processSandbox.execute({ command: "echo", args: ["a$b"] });
    if (r2.exitCode === -1 && r2.error?.includes("forbidden")) {
      throw new Error("bare $ a$b incorrectly rejected after M1");
    }
    expect(r2.exitCode).not.toBe(-1);
  });

  test("rejects arg containing ${", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["${HOME}"] });
    expect(r.exitCode).toBe(-1);
    expect(r.error).toMatch(/forbidden/);
  });

  test("allows safe args (regression)", async () => {
    const r = await processSandbox.execute({ command: "echo", args: ["hello"] });
    // Should not be rejected by pre-check; exitCode 0 or at least not -1 with forbidden error
    // If echo succeeds, stdout contains hello; if env lacks echo, at least not forbidden
    if (r.exitCode === -1 && r.error?.includes("forbidden")) {
      throw new Error("safe arg incorrectly rejected");
    }
    expect(r.exitCode).not.toBe(-1);
    expect(r.stdout).toContain("hello");
  });
});
