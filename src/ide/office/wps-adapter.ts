/**
 * WPS Office Adapter
 *
 * Provides WPS Office integration for Linux (primary) and Windows.
 * Uses WPS JS API or command-line tools.
 *
 * Supported operations:
 * - Word: .docx, .doc
 * - Excel: .xlsx, .xls, .csv
 * - PowerPoint: .pptx, .ppt
 */

import { BaseOfficeAdapter, OfficeDocumentType } from "./office-adapter.js";
import { UniversalDocument, DocumentNode, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

/** Check if WPS Office is installed */
async function isWPSAvailable(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      // Check Windows registry or Program Files
      const { stdout } = await execAsync(
        'powershell -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -like \'*WPS*\' }"',
        { timeout: 5000 },
      );
      return stdout.includes("WPS");
    } else if (process.platform === "linux") {
      // Check Linux paths
      const paths = ["/usr/bin/wps", "/usr/bin/et", "/usr/bin/wpp", "/usr/local/bin/wps"];
      return paths.some((p) => existsSync(p));
    }
    return false;
  } catch (e: unknown) {
    logger.error(`[WPSAdapter] WPS check failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Abstract WPS adapter base */
abstract class WPSBaseAdapter extends BaseOfficeAdapter {
  readonly platform = "linux/windows";
  readonly capabilities = {
    canRead: true,
    canWrite: true,
    canScript: false,
    requiresProcess: true,
  };

  async isAvailable(): Promise<boolean> {
    return isWPSAvailable();
  }
}

/** WPS Word adapter */
export class WPSWordAdapter extends WPSBaseAdapter {
  readonly documentType: OfficeDocumentType = "word";

  protected async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    logger.info(`[WPSWordAdapter] Reading: ${filePath}`);

    // Use python-docx as fallback since WPS doesn't have a direct read API
    const pythonScript = `
import sys
from docx import Document
doc = Document('${filePath.replace(/\\/g, "/")}')
text = []
for para in doc.paragraphs:
    text.append(para.text)
print('\\n'.join(text))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      const lines = stdout.split("\n").filter(Boolean);
      const nodes: DocumentNode[] = lines.map((line) => ({
        id: `p-${Math.random().toString(36).slice(2, 8)}`,
        type: "paragraph",
        content: line,
      }));

      return {
        title: filePath.split("/").pop()?.split("\\").pop() || "Untitled",
        nodes,
        metadata: { sourceFormat: "docx", wordCount: stdout.split(/\\s+/).length },
      };
    } catch (e: unknown) {
      logger.error(`[WPSWordAdapter] Read failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS Word read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    logger.info(`[WPSWordAdapter] Writing: ${filePath}`);

    const pythonScript = `
import sys
from docx import Document
from docx.shared import Pt
doc = Document()
title = doc.add_heading('${doc.title.replace(/'/g, "\\'")}', 0)
for node in [${doc.nodes.map((n) => `"${n.content.replace(/"/g, '\\"')}"`).join(", ")}]:
    doc.add_paragraph(node)
doc.save('${filePath.replace(/\\/g, "/")}')
`;

    try {
      await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      logger.info(`[WPSWordAdapter] Written: ${filePath}`);
    } catch (e: unknown) {
      logger.error(`[WPSWordAdapter] Write failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS Word write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** WPS Excel adapter */
export class WPSExcelAdapter extends WPSBaseAdapter {
  readonly documentType: OfficeDocumentType = "excel";

  protected async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    logger.info(`[WPSExcelAdapter] Reading: ${filePath}`);

    const pythonScript = `
import openpyxl
wb = openpyxl.load_workbook('${filePath.replace(/\\/g, "/")}')
ws = wb.active
data = []
for row in ws.iter_rows(values_only=True):
    data.append('\\t'.join([str(cell) if cell is not None else '' for cell in row]))
print('\\n'.join(data))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      const lines = stdout.split("\n").filter(Boolean);
      const nodes: DocumentNode[] = lines.map((line) => ({
        id: `cell-${Math.random().toString(36).slice(2, 8)}`,
        type: "paragraph",
        content: line.replace(/\t/g, " | "),
      }));

      return {
        title: filePath.split("/").pop()?.split("\\").pop() || "Untitled",
        nodes,
        metadata: { sourceFormat: "xlsx" },
      };
    } catch (e: unknown) {
      logger.error(`[WPSExcelAdapter] Read failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS Excel read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    logger.info(`[WPSExcelAdapter] Writing: ${filePath}`);

    const tables = this.extractTablesFromNodes(doc.nodes);
    const pythonScript = `
import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws.title = '${doc.title.replace(/'/g, "\\'")}'
for row in [${tables.map((t) => `[${t.cells.map((c) => `"${c.join(", ").replace(/"/g, '\\"')}"`).join(", ")}]`).join(", ")}]:
    ws.append(row)
wb.save('${filePath.replace(/\\/g, "/")}')
`;

    try {
      await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      logger.info(`[WPSExcelAdapter] Written: ${filePath}`);
    } catch (e: unknown) {
      logger.error(`[WPSExcelAdapter] Write failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS Excel write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractTablesFromNodes(nodes: DocumentNode[]): Array<{ cells: string[][] }> {
    return nodes
      .filter((node) => node.type === "table")
      .map((node) => ({
        cells: node.rows?.map((row) => row.cells.map((cell) => cell || "")) || [],
      }));
  }
}

/** WPS PowerPoint adapter */
export class WPSPowerPointAdapter extends WPSBaseAdapter {
  readonly documentType: OfficeDocumentType = "powerpoint";

  protected async doRead(filePath: string, _options?: ConversionOptions): Promise<UniversalDocument> {
    logger.info(`[WPSPowerPointAdapter] Reading: ${filePath}`);

    const pythonScript = `
from pptx import Presentation
prs = Presentation('${filePath.replace(/\\/g, "/")}')
text = []
for i, slide in enumerate(prs.slides):
    text.append(f'Slide {i+1}:')
    for shape in slide.shapes:
        if hasattr(shape, 'text'):
            text.append(shape.text)
print('\\n'.join(text))
`;

    try {
      const { stdout } = await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      const lines = stdout.split("\n").filter(Boolean);
      const nodes: DocumentNode[] = lines.map((line) => ({
        id: `slide-${Math.random().toString(36).slice(2, 8)}`,
        type: "paragraph",
        content: line,
      }));

      return {
        title: filePath.split("/").pop()?.split("\\").pop() || "Untitled",
        nodes,
        metadata: { sourceFormat: "pptx" },
      };
    } catch (e: unknown) {
      logger.error(`[WPSPowerPointAdapter] Read failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS PowerPoint read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  protected async doWrite(doc: UniversalDocument, filePath: string, _options?: ConversionOptions): Promise<void> {
    logger.info(`[WPSPowerPointAdapter] Writing: ${filePath}`);

    const sections = this.extractSlideSectionsFromNodes(doc.nodes);
    const pythonScript = `
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()
for section in [${sections.map((s) => `{"title": "${s.title.replace(/"/g, '\\"')}", "content": "${s.content.map((c) => c.content).join("\\n").replace(/"/g, '\\"')}"}`).join(", ")}]:
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = section["title"]
    slide.placeholders[1].text = section["content"]
prs.save('${filePath.replace(/\\/g, "/")}')
`;

    try {
      await execAsync(`python3 -c "${pythonScript}"`, { timeout: 30000 });
      logger.info(`[WPSPowerPointAdapter] Written: ${filePath}`);
    } catch (e: unknown) {
      logger.error(`[WPSPowerPointAdapter] Write failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error(`WPS PowerPoint write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private extractSlideSectionsFromNodes(nodes: DocumentNode[]): Array<{ title: string; content: DocumentNode[] }> {
    const sections: Array<{ title: string; content: DocumentNode[] }> = [];
    let currentSection: { title: string; content: DocumentNode[] } | null = null;

    for (const node of nodes) {
      if (node.type === "heading" && (node.level || 1) <= 2) {
        if (currentSection) sections.push(currentSection);
        currentSection = { title: node.content, content: [] };
      } else if (currentSection) {
        currentSection.content.push(node);
      }
    }

    if (currentSection) sections.push(currentSection);
    return sections;
  }
}
