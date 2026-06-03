/**
 * Linux Adapter Tests
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { LinuxWordAdapter, LinuxExcelAdapter, LinuxPowerPointAdapter, LinuxSystemAdapter } from "../src/ide/office/linux-adapter.js";

describe("Linux Adapter", () => {
  describe("LinuxSystemAdapter", () => {
    it("should detect Linux platform", () => {
      const isLinux = LinuxSystemAdapter.isLinux();
      expect(typeof isLinux).toBe("boolean");
    });

    it("should provide setup instructions", () => {
      const instructions = LinuxSystemAdapter.getSetupInstructions();
      expect(instructions).toContain("libreoffice");
      expect(instructions).toContain("python-docx");
      expect(instructions).toContain("xclip");
      expect(instructions).toContain("xdotool");
    });

    it("should check LibreOffice availability", async () => {
      const hasLibreOffice = await LinuxSystemAdapter.hasLibreOffice();
      expect(typeof hasLibreOffice).toBe("boolean");
    });

    it("should check Python office libraries", async () => {
      const hasPythonOffice = await LinuxSystemAdapter.hasPythonOffice();
      expect(typeof hasPythonOffice).toBe("boolean");
    });
  });

  describe("LinuxWordAdapter", () => {
    let adapter: LinuxWordAdapter;

    beforeEach(() => {
      adapter = new LinuxWordAdapter();
    });

    it("should have correct document type", () => {
      expect(adapter.documentType).toBe("word");
    });

    it("should have linux platform", () => {
      expect(adapter.platform).toBe("linux");
    });

    it("should have correct capabilities", () => {
      expect(adapter.capabilities.canRead).toBe(true);
      expect(adapter.capabilities.canWrite).toBe(true);
      expect(adapter.capabilities.canScript).toBe(true);
    });

    it("should check availability", async () => {
      const available = await adapter.isAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  describe("LinuxExcelAdapter", () => {
    let adapter: LinuxExcelAdapter;

    beforeEach(() => {
      adapter = new LinuxExcelAdapter();
    });

    it("should have correct document type", () => {
      expect(adapter.documentType).toBe("excel");
    });

    it("should check availability", async () => {
      const available = await adapter.isAvailable();
      expect(typeof available).toBe("boolean");
    });
  });

  describe("LinuxPowerPointAdapter", () => {
    let adapter: LinuxPowerPointAdapter;

    beforeEach(() => {
      adapter = new LinuxPowerPointAdapter();
    });

    it("should have correct document type", () => {
      expect(adapter.documentType).toBe("powerpoint");
    });

    it("should check availability", async () => {
      const available = await adapter.isAvailable();
      expect(typeof available).toBe("boolean");
    });
  });
});
