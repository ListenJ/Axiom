/**
 * Excel Spreadsheet Adapter
 * 
 * Converts between Excel (.xlsx) and UniversalDocument format.
 * Tables in the document become Excel worksheets.
 * 
 * Platform Strategy:
 * - All platforms: openpyxl library (Python)
 */

import { BaseOfficeAdapter, OfficeUtils } from "./office-adapter.js";
import { UniversalDocument, DocumentNode, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { spawn } from "child_process";

export class ExcelAdapter extends BaseOfficeAdapter {
  readonly documentType = "excel" as const;
  readonly platform = "cross-platform";
  readonly capabilities = {
    canRead: true,
    canWrite: true,
    canScript: false,
    requiresProcess: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      await this.runPythonScript("import openpyxl; print('ok')");
      return true;
    } catch {
      return false;
    }
  }

  protected async doRead(filePath: string, options?: ConversionOptions): Promise<UniversalDocument> {
    const script = `
import openpyxl
import json
import sys

try:
    wb = openpyxl.load_workbook("${filePath.replace(/\\/g, "\\\\")}")
    nodes = []
    
    for sheet_name in wb.sheetnames:
        sheet = wb[sheet_name]
        
        # Add sheet name as heading
        nodes.append({
            "type": "heading",
            "content": sheet_name,
            "level": 2
        })
        
        # Extract table data
        rows = []
        for row in sheet.iter_rows(values_only=True):
            cells = [str(cell) if cell is not None else "" for cell in row]
            rows.append({"cells": cells})
        
        if rows:
            nodes.append({
                "type": "table",
                "content": f"Sheet: {sheet_name}",
                "rows": rows
            })
    
    result = {
        "title": wb.sheetnames[0] if wb.sheetnames else "Untitled",
        "nodes": nodes,
        "metadata": {
            "sourceFormat": "xlsx",
            "sheetCount": len(wb.sheetnames)
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
        id: `x-${Math.random().toString(36).slice(2, 8)}`,
        ...n,
      })),
      metadata: data.metadata,
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void> {
    const tables = OfficeUtils.extractTables(doc.nodes);
    
    const script = `
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
import json
import sys

try:
    wb = openpyxl.Workbook()
    
    # Remove default sheet
    if "Sheet" in wb.sheetnames:
        wb.remove(wb["Sheet"])
    
    tables = ${JSON.stringify(tables)}
    
    for idx, table in enumerate(tables):
        sheet_name = f"Sheet{idx + 1}" if idx > 0 else "Data"
        ws = wb.create_sheet(title=sheet_name)
        
        for row_idx, row in enumerate(table["cells"]):
            for col_idx, cell_value in enumerate(row):
                cell = ws.cell(row=row_idx + 1, column=col_idx + 1, value=cell_value)
                
                # Style header row
                if row_idx == 0:
                    cell.font = Font(bold=True, color="FFFFFF")
                    cell.fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
                    cell.alignment = Alignment(horizontal="center")
    
    # If no tables, add document content as text
    if not tables:
        ws = wb.create_sheet(title="Content")
        ws.cell(row=1, column=1, value="${doc.title}")
        ws.cell(row=1, column=1).font = Font(bold=True, size=14)
        
        row = 3
        for node in ${JSON.stringify(doc.nodes)}:
            if node["type"] == "paragraph":
                ws.cell(row=row, column=1, value=node["content"])
                row += 1
    
    wb.save("${filePath.replace(/\\/g, "\\\\")}")
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

    const output = await this.runPythonScript(script);
    if (!output.includes("SUCCESS")) {
      throw new Error(`Excel write failed: ${output}`);
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
