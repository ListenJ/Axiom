/**
 * Linux Office Adapter
 *
 * Provides Linux-native Office integration using:
 * - LibreOffice (primary - document conversion and scripting)
 * - Python libraries (fallback - python-docx, openpyxl, python-pptx)
 * - xclip (clipboard operations)
 * - xdotool (window automation)
 * - wmctrl (window management)
 *
 * Supported operations:
 * - Word: .docx, .doc, .odt
 * - Excel: .xlsx, .xls, .csv, .ods
 * - PowerPoint: .pptx, .ppt, .odp
 */

import { BaseOfficeAdapter, OfficeDocumentType, PlatformCapabilities } from "./office-adapter.js";
import { UniversalDocument, DocumentNode, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { tmpdir } from "os";

const execAsync = promisify(exec);

/** Check if LibreOffice is installed */
async function isLibreOfficeAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("which libreoffice || which soffice", { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if Python with office libraries is available */
async function isPythonOfficeAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      "python3 -c \"import docx; import openpyxl; import pptx; print('OK')\" 2>/dev/null || python -c \"import docx; import openpyxl; import pptx; print('OK')\" 2>/dev/null",
      { timeout: 10000 },
    );
    return stdout.trim() === "OK";
  } catch {
    return false;
  }
}

/** Check if xclip is available */
async function isXclipAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("which xclip", { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if xdotool is available */
async function isXdotoolAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("which xdotool", { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Base class for Linux Office adapters */
abstract class LinuxBaseAdapter extends BaseOfficeAdapter {
  readonly platform = "linux";
  readonly capabilities: PlatformCapabilities = {
    canRead: true,
    canWrite: true,
    canScript: true,
    requiresProcess: true,
  };

  private libreOfficeAvailable: boolean | null = null;
  private pythonOfficeAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.libreOfficeAvailable === null) {
      this.libreOfficeAvailable = await isLibreOfficeAvailable();
    }
    if (this.pythonOfficeAvailable === null) {
      this.pythonOfficeAvailable = await isPythonOfficeAvailable();
    }
    return this.libreOfficeAvailable || this.pythonOfficeAvailable;
  }

  /** Check if LibreOffice is available */
  protected async hasLibreOffice(): Promise<boolean> {
    if (this.libreOfficeAvailable === null) {
      this.libreOfficeAvailable = await isLibreOfficeAvailable();
    }
    return this.libreOfficeAvailable;
  }

  /** Check if Python office libraries are available */
  protected async hasPythonOffice(): Promise<boolean> {
    if (this.pythonOfficeAvailable === null) {
      this.pythonOfficeAvailable = await isPythonOfficeAvailable();
    }
    return this.pythonOfficeAvailable;
  }

  /**
   * Execute LibreOffice command
   */
  protected async runLibreOffice(args: string[], timeout = 60000): Promise<string> {
    const libreOfficePath = await this.findLibreOfficePath();
    const cmd = `${libreOfficePath} --headless ${args.join(" ")}`;
    logger.debug(`[LinuxAdapter] Running: ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, { timeout });
    if (stderr) {
      logger.warn("[LinuxAdapter] LibreOffice stderr:", { stderr: stderr.trim() });
    }
    return stdout;
  }

  /** Find LibreOffice executable path */
  private async findLibreOfficePath(): Promise<string> {
    const paths = ["libreoffice", "soffice", "/usr/bin/libreoffice", "/usr/bin/soffice"];
    for (const path of paths) {
      try {
        await execAsync(`which ${path}`, { timeout: 5000 });
        return path;
      } catch {
        continue;
      }
    }
    return "libreoffice"; // Fallback
  }

  /**
   * Convert document using LibreOffice
   * @param inputPath Input file path
   * @param outputDir Output directory
   * @param format Output format (e.g., "txt", "html", "pdf")
   */
  protected async convertWithLibreOffice(
    inputPath: string,
    outputDir: string,
    format: string,
  ): Promise<string> {
    await this.runLibreOffice([
      "--convert-to", format,
      "--outdir", outputDir,
      `"${inputPath}"`,
    ]);

    // Find the converted file
    const baseName = basename(inputPath, extname(inputPath));
    const outputPath = join(outputDir, `${baseName}.${format}`);
    if (!existsSync(outputPath)) {
      throw new Error(`Conversion failed: output file not found at ${outputPath}`);
    }
    return outputPath;
  }

  /**
   * Execute Python script for document processing
   */
  protected async runPythonScript(script: string, timeout = 30000): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-linux-"));
    const scriptPath = join(tmpDir, "script.py");
    writeFileSync(scriptPath, script, "utf8");

    try {
      const pythonCmd = await this.findPythonPath();
      const { stdout, stderr } = await execAsync(
        `${pythonCmd} "${scriptPath}"`,
        { timeout },
      );
      if (stderr) {
        logger.warn("[LinuxAdapter] Python stderr:", { stderr: stderr.trim() });
      }
      return stdout;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Find Python executable path */
  private async findPythonPath(): Promise<string> {
    const commands = ["python3", "python"];
    for (const cmd of commands) {
      try {
        await execAsync(`which ${cmd}`, { timeout: 5000 });
        return cmd;
      } catch {
        continue;
      }
    }
    return "python3"; // Fallback
  }

  /**
   * Parse HTML content to document nodes
   */
  protected parseHtmlToNodes(html: string): DocumentNode[] {
    const nodes: DocumentNode[] = [];
    // Simple HTML parsing (in production, use a proper HTML parser)
    const headingRegex = /<h([1-6])>([^]*?)<\/h\1>/gi;
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      nodes.push({
        id: `heading-${nodes.length}`,
        type: "heading",
        content: this.stripHtmlTags(match[2]),
        level: parseInt(match[1]),
      });
    }

    const paraRegex = /<p>([^]*?)<\/p>/gi;
    while ((match = paraRegex.exec(html)) !== null) {
      const content = this.stripHtmlTags(match[1]).trim();
      if (content) {
        nodes.push({
          id: `paragraph-${nodes.length}`,
          type: "paragraph",
          content,
        });
      }
    }

    return nodes;
  }

  /** Strip HTML tags from text */
  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  }
}

/** Linux Word Adapter using LibreOffice/Python */
class LinuxWordAdapter extends LinuxBaseAdapter {
  readonly documentType: OfficeDocumentType = "word";

  async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    const hasLibreOffice = await this.hasLibreOffice();

    if (hasLibreOffice) {
      // Use LibreOffice to convert to HTML, then parse
      const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-word-"));
      try {
        const htmlPath = await this.convertWithLibreOffice(filePath, tmpDir, "html");
        const html = await Bun.file(htmlPath).text();
        const nodes = this.parseHtmlToNodes(html);

        return {
          title: basename(filePath, extname(filePath)),
          nodes,
          metadata: {
            sourceFormat: extname(filePath).slice(1),
            wordCount: nodes.filter((n) => n.type === "paragraph" || n.type === "heading").reduce((sum, n) => sum + n.content.split(/\s+/).length, 0),
          },
        };
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Fallback to python-docx
      const script = `
import sys
from docx import Document

doc = Document("${filePath.replace(/"/g, '\\"')}")
title = doc.paragraphs[0].text if doc.paragraphs else "Untitled"
print(f"TITLE:{title}")
for i, para in enumerate(doc.paragraphs):
    print(f"P:{i}:{para.text}")
`;
      const output = await this.runPythonScript(script);
      const lines = output.split("\n");
      const title = lines.find((l) => l.startsWith("TITLE:"))?.slice(6) || basename(filePath);
      const nodes: DocumentNode[] = [];

      for (const line of lines) {
        if (line.startsWith("P:")) {
          const content = line.slice(line.indexOf(":", 2) + 1);
          if (content.trim()) {
            nodes.push({
              id: `paragraph-${nodes.length}`,
              type: "paragraph",
              content: content.trim(),
            });
          }
        }
      }

      return {
        title,
        nodes,
        metadata: { sourceFormat: extname(filePath).slice(1) },
      };
    }
  }

  async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    const hasPython = await this.hasPythonOffice();

    if (hasPython) {
      const script = `
from docx import Document
from docx.shared import Pt

doc = Document()
title = doc.add_heading("${doc.title.replace(/"/g, '\\"')}", 0)

${doc.nodes.map((node) => {
  switch (node.type) {
    case "heading":
      return `doc.add_heading("${node.content.replace(/"/g, '\\"')}", level=${node.level || 1})`;
    case "paragraph":
      return `doc.add_paragraph("${node.content.replace(/"/g, '\\"')}")`;
    case "code":
      return `doc.add_paragraph("${node.content.replace(/"/g, '\\"')}", style='Intense Quote')`;
    default:
      return `doc.add_paragraph("${node.content.replace(/"/g, '\\"')}")`;
  }
}).join("\n")}

doc.save("${filePath.replace(/"/g, '\\"')}")
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with python-docx is required for writing Word documents on Linux");
    }
  }
}

/** Linux Excel Adapter using LibreOffice/Python */
class LinuxExcelAdapter extends LinuxBaseAdapter {
  readonly documentType: OfficeDocumentType = "excel";

  async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    const hasLibreOffice = await this.hasLibreOffice();

    if (hasLibreOffice) {
      // Convert to CSV and parse
      const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-excel-"));
      try {
        const csvPath = await this.convertWithLibreOffice(filePath, tmpDir, "csv");
        const csv = await Bun.file(csvPath).text();
        const lines = csv.split("\n").filter((l) => l.trim());

        const nodes: DocumentNode[] = [];
        if (lines.length > 0) {
          // First row as header
          nodes.push({
            id: "header",
            type: "heading",
            content: lines[0],
            level: 2,
          });

          // Remaining rows as table
          const rows = lines.slice(1).map((line) => ({
            cells: line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")),
          }));

          nodes.push({
            id: "data",
            type: "table",
            content: `Table with ${rows.length} rows`,
            rows,
          });
        }

        return {
          title: basename(filePath, extname(filePath)),
          nodes,
          metadata: { sourceFormat: extname(filePath).slice(1) },
        };
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Fallback to openpyxl
      const script = `
import sys
from openpyxl import load_workbook

wb = load_workbook("${filePath.replace(/"/g, '\\"')}")
ws = wb.active
print(f"TITLE:{ws.title}")
for row in ws.iter_rows(values_only=True):
    print(f"R:{':'.join(str(c) if c is not None else '' for c in row)}")
`;
      const output = await this.runPythonScript(script);
      const lines = output.split("\n");
      const title = lines.find((l) => l.startsWith("TITLE:"))?.slice(6) || basename(filePath);

      const nodes: DocumentNode[] = [];
      const rows: { cells: string[] }[] = [];

      for (const line of lines) {
        if (line.startsWith("R:")) {
          const cells = line.slice(2).split(":").map((c) => c.trim());
          rows.push({ cells });
        }
      }

      if (rows.length > 0) {
        nodes.push({
          id: "data",
          type: "table",
          content: `Table with ${rows.length} rows`,
          rows,
        });
      }

      return {
        title,
        nodes,
        metadata: { sourceFormat: extname(filePath).slice(1) },
      };
    }
  }

  async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    const hasPython = await this.hasPythonOffice();

    if (hasPython) {
      const tableNode = doc.nodes.find((n) => n.type === "table");
      const rows = tableNode?.rows || [];

      const rowInserts = rows.map((row) =>
        `ws.append([${row.cells.map((c: string) => `"${c.replace(/"/g, '\\"')}"`).join(", ")}])`
      ).join("\n");

      const script = `
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "${doc.title.replace(/"/g, '\\"')}" or "Sheet1"

${rowInserts}

wb.save("${filePath.replace(/"/g, '\\"')}")
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with openpyxl is required for writing Excel documents on Linux");
    }
  }
}

/** Linux PowerPoint Adapter using LibreOffice/Python */
class LinuxPowerPointAdapter extends LinuxBaseAdapter {
  readonly documentType: OfficeDocumentType = "powerpoint";

  async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    const hasLibreOffice = await this.hasLibreOffice();

    if (hasLibreOffice) {
      // Convert to HTML
      const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-ppt-"));
      try {
        const htmlPath = await this.convertWithLibreOffice(filePath, tmpDir, "html");
        const html = await Bun.file(htmlPath).text();
        const nodes = this.parseHtmlToNodes(html);

        return {
          title: basename(filePath, extname(filePath)),
          nodes,
          metadata: { sourceFormat: extname(filePath).slice(1) },
        };
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Fallback to python-pptx
      const script = `
from pptx import Presentation

prs = Presentation("${filePath.replace(/"/g, '\\"')}")
print(f"SLIDES:{len(prs.slides)}")
for i, slide in enumerate(prs.slides):
    for shape in slide.shapes:
        if hasattr(shape, "text"):
            print(f"S:{i}:{shape.text}")
`;
      const output = await this.runPythonScript(script);
      const lines = output.split("\n");
      const slideCount = lines.find((l) => l.startsWith("SLIDES:"))?.slice(7) || "0";

      const nodes: DocumentNode[] = [];
      for (const line of lines) {
        if (line.startsWith("S:")) {
          const content = line.slice(line.indexOf(":", 2) + 1);
          if (content.trim()) {
            nodes.push({
              id: `slide-${nodes.length}`,
              type: "paragraph",
              content: content.trim(),
            });
          }
        }
      }

      return {
        title: basename(filePath, extname(filePath)),
        nodes,
        metadata: {
          sourceFormat: extname(filePath).slice(1),
          wordCount: parseInt(slideCount) || 0,
        },
      };
    }
  }

  async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    const hasPython = await this.hasPythonOffice();

    if (hasPython) {
      const slideCreations = doc.nodes.map((node: DocumentNode, i: number) =>
        `
slide_layout = prs.slide_layouts[1]  # Title and Content
slide = prs.slides.add_slide(slide_layout)
title = slide.shapes.title
title.text = "Slide ${i + 1}"
content = slide.placeholders[1]
content.text = "${node.content.replace(/"/g, '\\"')}"
`
      ).join("\n");

      const script = `
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
prs.core_properties.title = "${doc.title.replace(/"/g, '\\"')}"

${slideCreations}

prs.save("${filePath.replace(/"/g, '\\"')}")
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with python-pptx is required for writing PowerPoint documents on Linux");
    }
  }
}

/** Linux system integration utilities */
export class LinuxSystemAdapter {
  /** Check if running on Linux */
  static isLinux(): boolean {
    return process.platform === "linux";
  }

  /** Check LibreOffice availability */
  static async hasLibreOffice(): Promise<boolean> {
    return isLibreOfficeAvailable();
  }

  /** Check Python office libraries */
  static async hasPythonOffice(): Promise<boolean> {
    return isPythonOfficeAvailable();
  }

  /** Check xclip availability */
  static async hasXclip(): Promise<boolean> {
    return isXclipAvailable();
  }

  /** Check xdotool availability */
  static async hasXdotool(): Promise<boolean> {
    return isXdotoolAvailable();
  }

  /** Set clipboard content using xclip */
  static async setClipboard(text: string): Promise<void> {
    if (!(await this.hasXclip())) {
      throw new Error("xclip is not installed. Install with: sudo apt-get install xclip");
    }
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    await execAsync(`echo "${text.replace(/"/g, '\\"')}" | xclip -selection clipboard`, { timeout: 5000 });
  }

  /** Get clipboard content using xclip */
  static async getClipboard(): Promise<string> {
    if (!(await this.hasXclip())) {
      throw new Error("xclip is not installed. Install with: sudo apt-get install xclip");
    }
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout } = await execAsync("xclip -selection clipboard -o", { timeout: 5000 });
    return stdout;
  }

  /** Get active window title using xdotool */
  static async getActiveWindowTitle(): Promise<string> {
    if (!(await this.hasXdotool())) {
      throw new Error("xdotool is not installed. Install with: sudo apt-get install xdotool");
    }
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    const { stdout } = await execAsync("xdotool getactivewindow getwindowname", { timeout: 5000 });
    return stdout.trim();
  }

  /** Type text using xdotool */
  static async typeText(text: string): Promise<void> {
    if (!(await this.hasXdotool())) {
      throw new Error("xdotool is not installed. Install with: sudo apt-get install xdotool");
    }
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    await execAsync(`xdotool type "${text.replace(/"/g, '\\"')}"`, { timeout: 5000 });
  }

  /** Get setup instructions for Linux */
  static getSetupInstructions(): string {
    return `
Linux Office Integration Setup
==============================

Required packages:
  sudo apt-get install libreoffice-calc libreoffice-writer libreoffice-impress
  sudo apt-get install python3 python3-pip
  sudo apt-get install xclip xdotool wmctrl

Python libraries:
  pip3 install python-docx openpyxl python-pptx

Optional (for better compatibility):
  sudo apt-get install unoconv
`;
  }
}

export { LinuxWordAdapter, LinuxExcelAdapter, LinuxPowerPointAdapter };
