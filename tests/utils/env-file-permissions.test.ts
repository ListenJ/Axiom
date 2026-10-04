import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureEnvFile } from "../../src/utils/env-file.js";

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("secure .env writes", () => {
  it("creates .env with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "axiom-env-mode-"));
    const path = join(dir, ".env");
    try {
      writeSecureEnvFile("DEEPSEEK_API_KEY=redacted\n", path);
      expect(readFileSync(path, "utf8")).toContain("DEEPSEEK_API_KEY=redacted");
      expect(modeOf(path)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens an existing 0644 .env on overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "axiom-env-mode-"));
    const path = join(dir, ".env");
    try {
      writeFileSync(path, "OLD=1\n", { mode: 0o644 });
      chmodSync(path, 0o644);
      expect(modeOf(path)).toBe(0o644);

      writeSecureEnvFile("NEW=2\n", path);
      expect(modeOf(path)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps setup/cli .env write paths on the secure helper", () => {
    const setup = readFileSync("src/cli/setup.ts", "utf8");
    const cli = readFileSync("src/cli.ts", "utf8");

    expect(setup).toContain("writeSecureEnvFile");
    expect(setup).not.toMatch(/writeFileSync\(envPath/);
    expect(cli).toContain("writeSecureEnvFile");
    expect(cli).not.toMatch(/fs\.writeFileSync\(envPath/);
  });
});
