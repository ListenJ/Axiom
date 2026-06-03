/**
 * Word Document Adapter
 * 
 * Converts between Word (.docx) and UniversalDocument format.
 * Uses markdown as intermediate format for maximum compatibility.
 * 
 * Platform Strategy:
 * - Windows: python-docx library (primary), Office COM (advanced features)
 * - macOS: python-docx library (primary)
 * - Linux: python-docx library (primary)
 */

import { BaseOfficeAdapter, OfficeUtils } from "./office-adapter.js";
import { UniversalDocument, DocumentNode, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { spawn } from "child_process";
import { promises as fs } from "fs";

export class WordAdapter extends BaseOfficeAdapter {
  readonly documentType = "word" as const;
  readonly platform = "cross-platform";
  readonly capabilities = {
    canRead: true,
    canWrite: true,
    canScript: false,
    requiresProcess: true,  // Requires python-docx
  };

  async isAvailable(): Promise<boolean> {
    try {
      // Check if python-docx is available
      await this.runPythonScript("import docx; print('ok')");
      return true;
    } catch {
      return false;
    }
  }

  protected async doRead(filePath: string, options?: ConversionOptions): Promise<UniversalDocument> {
    const script = `
import docx
import json
import sys

try:
    doc = docx.Document("${filePath.replace(/\\/g, "\\\\")}")
    nodes = []
    
    for para in doc.paragraphs:
        style = para.style.name if para.style else "Normal"
        
        if style.startswith("Heading"):
            level = int(style.replace("Heading ", "")) if style != "Heading" else 1
            nodes.append({
                "type": "heading",
                "content": para.text,
                "level": level
            })
        elif para.text.strip():
            nodes.append({
                "type": "paragraph", 
                "content": para.text
            })
    
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text for cell in row.cells]
            rows.append({"cells": cells})
        nodes.append({
            "type": "table",
            "content": "Table",
            "rows": rows
        })
    
    result = {
        "title": doc.paragraphs[0].text if doc.paragraphs else "Untitled",
        "nodes": nodes,
        "metadata": {
            "sourceFormat": "docx",
            "wordCount": sum(len(p.text.split()) for p in doc.paragraphs)
        }
    }
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

    const output = await this.runPythonScript(script);
    const data = JSON.parse(output);
    
    if (data.error) throw new Error(data.error);
    
    return {
      title: data.title,
      nodes: data.nodes.map((n: any) => ({
        id: `w-${Math.random().toString(36).slice(2, 8)}`,
        ...n,
      })),
      metadata: data.metadata,
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void> {
    const script = `
import docx
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
import json
import sys

try:
    document = docx.Document()
    
    # Add title
    if "${doc.title}" and "${doc.title}" != "Untitled":
        title = document.add_heading("${doc.title}", 0)
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    
    # Add content nodes
    for node in ${JSON.stringify(doc.nodes)}:
        if node["type"] == "heading":
            document.add_heading(node["content"], level=node.get("level", 1))
        elif node["type"] == "paragraph":
            document.add_paragraph(node["content"])
        elif node["type"] == "code":
            p = document.add_paragraph()
            p.style = "Intense Quote"
            run = p.add_run(node["content"])
            run.font.name = "Courier New"
            run.font.size = Pt(10)
        elif node["type"] == "list":
            for item in node.get("items", []):
                document.add_paragraph(item, style="List Bullet")
        elif node["type"] == "table":
            if node.get("rows"):
                table = document.add_table(rows=len(node["rows"]), cols=len(node["rows"][0]["cells"]))
                for i, row_data in enumerate(node["rows"]):
                    for j, cell_text in enumerate(row_data["cells"]):
                        table.rows[i].cells[j].text = cell_text
        elif node["type"] == "quote":
            p = document.add_paragraph()
            p.style = "Quote"
            p.add_run(node["content"])
    
    document.save("${filePath.replace(/\\/g, "\\\\")}")
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

    const output = await this.runPythonScript(script);
    if (!output.includes("SUCCESS")) {
      throw new Error(`Word write failed: ${output}`);
    }
  }

  private runPythonScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("python", ["-c", script], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr || stdout || `Python process exited with code ${code}`));
        } else {
          resolve(stdout.trim());
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Python: ${err.message}`));
      });
    });
  }
}
