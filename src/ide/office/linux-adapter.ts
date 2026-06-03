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
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

/** Check if LibreOffice is installed */
async function isLibreOfficeAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["libreoffice"], { timeout: 5000 });
    return true;
  } catch {
    try {
      await execFileAsync("which", ["soffice"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

/** Check if Python with office libraries is available */
async function isPythonOfficeAvailable(): Promise<boolean> {
  try {
    await execFileAsync(
      "python3",
      ["-c", "import docx; import openpyxl; import pptx; print('OK')"],
      { timeout: 10000 },
    );
    return true;
  } catch {
    try {
      await execFileAsync(
        "python",
        ["-c", "import docx; import openpyxl; import pptx; print('OK')"],
        { timeout: 10000 },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** Check if xclip is available */
async function isXclipAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["xclip"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if xdotool is available */
async function isXdotoolAvailable(): Promise<boolean> {
  try {
    await execFileAsync("which", ["xdotool"], { timeout: 5000 });
    return true;
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
   * Uses execFile to avoid shell injection
   */
  protected async runLibreOffice(args: string[], timeout = 30000): Promise<string> {
    const libreOfficePath = await this.findLibreOfficePath();
    const { stdout, stderr } = await execFileAsync(libreOfficePath, args, {
      timeout,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
    });
    if (stderr) {
      logger.warn("[LinuxAdapter] LibreOffice stderr:", { stderr: stderr.trim() });
    }
    return stdout;
  }

  /** Find LibreOffice executable path */
  private async findLibreOfficePath(): Promise<string> {
    const candidates = ["libreoffice", "soffice"];
    for (const cmd of candidates) {
      try {
        await execFileAsync("which", [cmd], { timeout: 5000 });
        return cmd;
      } catch {
        continue;
      }
    }
    return "libreoffice"; // Fallback
  }

  /**
   * Convert document using LibreOffice
   * Uses execFile with array arguments to prevent shell injection
   */
  protected async convertWithLibreOffice(
    inputPath: string,
    outputDir: string,
    format: string,
  ): Promise<string> {
    await this.runLibreOffice([
      "--headless",
      "--convert-to", format,
      "--outdir", outputDir,
      inputPath, // Pass as array element, not shell string
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
   * Writes script to temp file and executes with execFile
   */
  protected async runPythonScript(script: string, timeout = 30000): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-linux-"));
    const scriptPath = join(tmpDir, "script.py");
    writeFileSync(scriptPath, script, "utf8");

    try {
      const pythonCmd = await this.findPythonPath();
      const { stdout, stderr } = await execFileAsync(
        pythonCmd,
        [scriptPath], // Pass as array element
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
  protected async findPythonPath(): Promise<string> {
    const commands = ["python3", "python"];
    for (const cmd of commands) {
      try {
        await execFileAsync("which", [cmd], { timeout: 5000 });
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
    return html
      .replace(/<[^\u003e]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
  }
}

/** Helper to safely escape strings for Python scripts */
function escapePythonString(str: string): string {
  // Use triple quotes to avoid most escaping issues
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '\\"""');
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
            wordCount: nodes
              .filter((n) => n.type === "paragraph" || n.type === "heading")
              .reduce((sum, n) => sum + n.content.split(/\s+/).length, 0),
          },
        };
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } else {
      // Fallback to python-docx
      // Pass file path as command line argument to avoid injection
      const script = `
import sys
from docx import Document

file_path = sys.argv[1]
doc = Document(file_path)
title = doc.paragraphs[0].text if doc.paragraphs else "Untitled"
print(f"TITLE:{title}")
for i, para in enumerate(doc.paragraphs):
    print(f"P:{i}:{para.text}")
`;
      const output = await this.runPythonScriptWithArg(script, filePath);
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
      // Generate Python script with triple-quoted strings for safety
      const nodesJson = JSON.stringify(
        doc.nodes.map((n) => ({
          type: n.type,
          content: n.content,
          level: n.level,
        }))
      );

      const script = `
from docx import Document
from docx.shared import Pt
import json

doc = Document()
nodes = json.loads('''${escapePythonString(nodesJson)}''')

for node in nodes:
    if node["type"] == "heading":
        doc.add_heading(node["content"], level=node.get("level", 1))
    elif node["type"] == "code":
        doc.add_paragraph(node["content"], style='Intense Quote')
    else:
        doc.add_paragraph(node["content"])

doc.save('''${escapePythonString(filePath)}''')
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with python-docx is required for writing Word documents on Linux");
    }
  }

  /** Run Python script with a file path argument */
  private async runPythonScriptWithArg(script: string, arg: string): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-linux-"));
    const scriptPath = join(tmpDir, "script.py");
    writeFileSync(scriptPath, script, "utf8");

    try {
      const pythonCmd = await this.findPythonPath();
      const { stdout, stderr } = await execFileAsync(
        pythonCmd,
        [scriptPath, arg], // Pass arg as array element
        { timeout: 30000 },
      );
      if (stderr) {
        logger.warn("[LinuxAdapter] Python stderr:", { stderr: stderr.trim() });
      }
      return stdout;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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

file_path = sys.argv[1]
wb = load_workbook(file_path)
ws = wb.active
print(f"TITLE:{ws.title}")
for row in ws.iter_rows(values_only=True):
    print(f"R:{':'.join(str(c) if c is not None else '' for c in row)}")
`;
      const output = await this.runPythonScriptWithArg(script, filePath);
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

      // Serialize rows as JSON to avoid injection
      const rowsJson = JSON.stringify(rows.map((r) => r.cells));

      const script = `
from openpyxl import Workbook
from openpyxl.styles import Font
import json

wb = Workbook()
ws = wb.active
ws.title = '''${escapePythonString(doc.title)}''' or "Sheet1"

rows = json.loads('''${escapePythonString(rowsJson)}''')
for row in rows:
    ws.append(row)

wb.save('''${escapePythonString(filePath)}''')
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with openpyxl is required for writing Excel documents on Linux");
    }
  }

  /** Run Python script with a file path argument */
  private async runPythonScriptWithArg(script: string, arg: string): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-linux-"));
    const scriptPath = join(tmpDir, "script.py");
    writeFileSync(scriptPath, script, "utf8");

    try {
      const pythonCmd = await this.findPythonPath();
      const { stdout, stderr } = await execFileAsync(
        pythonCmd,
        [scriptPath, arg], // Pass arg as array element
        { timeout: 30000 },
      );
      if (stderr) {
        logger.warn("[LinuxAdapter] Python stderr:", { stderr: stderr.trim() });
      }
      return stdout;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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
import sys
from pptx import Presentation

file_path = sys.argv[1]
prs = Presentation(file_path)
print(f"SLIDES:{len(prs.slides)}")
for i, slide in enumerate(prs.slides):
    for shape in slide.shapes:
        if hasattr(shape, "text"):
            print(f"S:{i}:{shape.text}")
`;
      const output = await this.runPythonScriptWithArg(script, filePath);
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
      // Serialize nodes as JSON to avoid injection
      const nodesJson = JSON.stringify(
        doc.nodes.map((n, i) => ({
          index: i,
          content: n.content,
        }))
      );

      const script = `
from pptx import Presentation
from pptx.util import Inches, Pt
import json

prs = Presentation()
prs.core_properties.title = '''${escapePythonString(doc.title)}'''

nodes = json.loads('''${escapePythonString(nodesJson)}''')
for node in nodes:
    slide_layout = prs.slide_layouts[1]  # Title and Content
    slide = prs.slides.add_slide(slide_layout)
    title = slide.shapes.title
    title.text = f"Slide {node['index'] + 1}"
    content = slide.placeholders[1]
    content.text = node["content"]

prs.save('''${escapePythonString(filePath)}''')
print("OK")
`;
      await this.runPythonScript(script);
    } else {
      throw new Error("Python with python-pptx is required for writing PowerPoint documents on Linux");
    }
  }

  /** Run Python script with a file path argument */
  private async runPythonScriptWithArg(script: string, arg: string): Promise<string> {
    const tmpDir = mkdtempSync(join(tmpdir(), "openclaw-linux-"));
    const scriptPath = join(tmpDir, "script.py");
    writeFileSync(scriptPath, script, "utf8");

    try {
      const pythonCmd = await this.findPythonPath();
      const { stdout, stderr } = await execFileAsync(
        pythonCmd,
        [scriptPath, arg], // Pass arg as array element
        { timeout: 30000 },
      );
      if (stderr) {
        logger.warn("[LinuxAdapter] Python stderr:", { stderr: stderr.trim() });
      }
      return stdout;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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
    const { spawn } = await import("child_process");
    return new Promise((resolve, reject) => {
      const proc = spawn("xclip", ["-selection", "clipboard"], {
        timeout: 5000,
      });
      proc.stdin.write(text, "utf8");
      proc.stdin.end();
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`xclip exited with code ${code}`));
      });
    });
  }

  /** Get clipboard content using xclip */
  static async getClipboard(): Promise<string> {
    if (!(await this.hasXclip())) {
      throw new Error("xclip is not installed. Install with: sudo apt-get install xclip");
    }
    const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"], {
      timeout: 5000,
    });
    return stdout;
  }

  /** Get active window title using xdotool */
  static async getActiveWindowTitle(): Promise<string> {
    if (!(await this.hasXdotool())) {
      throw new Error("xdotool is not installed. Install with: sudo apt-get install xdotool");
    }
    const { stdout } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], {
      timeout: 5000,
    });
    return stdout.trim();
  }

  /** Type text using xdotool */
  static async typeText(text: string): Promise<void> {
    if (!(await this.hasXdotool())) {
      throw new Error("xdotool is not installed. Install with: sudo apt-get install xdotool");
    }
    // Use stdin to avoid shell injection
    const { spawn } = await import("child_process");
    return new Promise((resolve, reject) => {
      const proc = spawn("xdotool", ["type", "--clearmodifiers", "-"], {
        timeout: 5000,
      });
      proc.stdin.write(text, "utf8");
      proc.stdin.end();
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`xdotool exited with code ${code}`));
      });
    });
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
