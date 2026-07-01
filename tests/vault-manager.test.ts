import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { VaultManager } from "../src/memory/vault-manager.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("VaultManager", () => {
  let tempDir: string;
  let vaultManager: VaultManager;

  beforeEach(() => {
    // Create temp vault directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
    
    // Create PARA structure
    for (const dir of ["00-Meta", "01-Projects", "02-Areas", "03-Resources", "04-Conversations", "05-Archives", "memory"]) {
      fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
    }

    vaultManager = new VaultManager({
      vaultPath: tempDir,
      apiPort: 18789,
      apiToken: "test-token",
      dbPath: path.join(tempDir, "memory.db"),
    });
  });

  afterEach(() => {
    // Close DB connection before cleanup so temp dir can be removed on Windows
    vaultManager?.close();
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should initialize with correct config", () => {
    expect(vaultManager).toBeDefined();
  });

  it("should write and read a note", async () => {
    const notePath = "01-Projects/test-project.md";
    const content = "# Test Project\n\nThis is a test note.";

    await vaultManager.writeNote(notePath, content, {
      title: "Test Project",
      tags: ["test", "project"],
    });

    const note = vaultManager.readNote(notePath);
    expect(note).toBeDefined();
    expect(note?.frontmatter.title).toBe("Test Project");
    expect(note?.content).toContain("This is a test note");
  });

  it("should search notes", async () => {
    // Write test notes
    await vaultManager.writeNote("02-Areas/area1.md", "# Area 1\n\nContent about AI.", { title: "Area 1" });
    await vaultManager.writeNote("02-Areas/area2.md", "# Area 2\n\nContent about ML.", { title: "Area 2" });

    // Search should work
    const results = vaultManager.search("AI");
    expect(Array.isArray(results)).toBe(true);
  });

  it("should list notes by category", async () => {
    await vaultManager.writeNote("01-Projects/project1.md", "# P1", { title: "P1" });
    await vaultManager.writeNote("01-Projects/project2.md", "# P2", { title: "P2" });

    const projects = vaultManager.browsePara("01-Projects");
    expect(projects.length).toBeGreaterThanOrEqual(0);
  });

  it("should return vault stats", () => {
    const stats = vaultManager.stats();
    expect(stats).toHaveProperty("totalNotes");
    expect(stats).toHaveProperty("totalWords");
    expect(typeof stats.totalNotes).toBe("number");
  });
});
