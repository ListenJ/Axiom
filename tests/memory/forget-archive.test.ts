import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryArchiver } from "../../src/memory/archiver.js";

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-archive-"));
  fs.mkdirSync(path.join(dir, "03-Resources", "web-clips"), { recursive: true });
  return dir;
}

describe("knowledge self-management: forget via archiving", () => {
  it("archives old Resources notes to 05-Archives, keeps recent", async () => {
    const vault = makeVault();
    const oldFile = path.join(vault, "03-Resources", "web-clips", "old-note.md");
    const newFile = path.join(vault, "03-Resources", "web-clips", "new-note.md");
    fs.writeFileSync(oldFile, "old content", "utf8");
    fs.writeFileSync(newFile, "new content", "utf8");
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - 91 * 24 * 3600 * 1000), new Date(now - 91 * 24 * 3600 * 1000));
    const archiver = new MemoryArchiver(vault);
    const result = await archiver.archive();
    const oldMoved = result.archived.some((f) => f.includes("old-note"));
    const oldGone = !fs.existsSync(oldFile);
    const newKept = fs.existsSync(newFile);
    expect(oldMoved).toBe(true);
    expect(oldGone).toBe(true);
    expect(newKept).toBe(true);
  });
});
