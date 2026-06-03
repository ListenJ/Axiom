/**
 * Windows COM Office Adapter
 * 
 * Uses PowerShell to interact with Microsoft Office via COM API.
 * Supports Word, Excel, and PowerPoint operations.
 */

import { BaseOfficeAdapter, OfficeDocumentType, PlatformCapabilities } from "./office-adapter.js";
import { UniversalDocument, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execAsync = promisify(exec);

/** Base class for COM-based Office adapters */
abstract class ComBaseAdapter extends BaseOfficeAdapter {
  readonly platform = "windows";
  readonly capabilities: PlatformCapabilities = {
    canRead: true,
    canWrite: true,
    canScript: true,
    requiresProcess: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      // Check if PowerShell and Office COM objects are available
      const { stdout } = await execAsync(
        'powershell -Command "try { $word = New-Object -ComObject Word.Application; $word.Quit(); Write-Output \'OK\' } catch { Write-Output \'FAIL\' }"',
        { timeout: 10000 }
      );
      return stdout.trim() === "OK";
    } catch {
      return false;
    }
  }

  /**
   * Execute PowerShell script and return output
   */
  protected async runPowerShell(script: string, timeout = 30000): Promise<string> {
    const tmpScript = OfficeUtils.tempPath("ps1");
    fs.writeFileSync(tmpScript, script, "utf8");
    try {
      const { stdout, stderr } = await execAsync(
        `powershell -ExecutionPolicy Bypass -File "${tmpScript}"`,
        { timeout }
      );
      if (stderr) {
        logger.warn("[ComAdapter] PowerShell stderr:", { stderr: stderr.trim() });
      }
      return stdout;
    } finally {
      try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
    }
  }
}

/** Windows COM Word Adapter */
export class ComWordAdapter extends ComBaseAdapter {
  readonly documentType: OfficeDocumentType = "word";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    $doc = $word.Documents.Open("${absPath}")
    $text = $doc.Content.Text
    $title = $doc.BuiltInDocumentProperties("Title").Value
    $author = $doc.BuiltInDocumentProperties("Author").Value
    $doc.Close($false)
    
    # Output as JSON
    $json = @{ title = $title; content = $text; author = $author } | ConvertTo-Json -Compress
    Write-Output $json
} finally {
    $word.Quit()
}
`;
    const output = await this.runPowerShell(script);
    const data = JSON.parse(output.trim());
    
    return {
      title: data.title || "Untitled",
      nodes: [
        { id: "1", type: "paragraph", content: data.content || "" }
      ],
      metadata: {
        author: data.author,
        sourceFormat: "docx",
      },
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    const absPath = fs.realpathSync(filePath);
    const content = doc.nodes.map(n => n.content).join("\n\n");
    const script = `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
    $doc = $word.Documents.Add()
    $doc.Content.Text = @"
${content}
"@
    if ("${doc.title}") {
        $doc.BuiltInDocumentProperties("Title").Value = "${doc.title}"
    }
    $doc.SaveAs2("${absPath}")
    $doc.Close($false)
} finally {
    $word.Quit()
}
`;
    await this.runPowerShell(script);
  }
}

/** Windows COM Excel Adapter */
export class ComExcelAdapter extends ComBaseAdapter {
  readonly documentType: OfficeDocumentType = "excel";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
try {
    $wb = $excel.Workbooks.Open("${absPath}")
    $ws = $wb.Sheets.Item(1)
    
    # Read all cell values into a 2D array
    $usedRange = $ws.UsedRange
    $rows = @()
    for ($r = 1; $r -le $usedRange.Rows.Count; $r++) {
        $row = @()
        for ($c = 1; $c -le $usedRange.Columns.Count; $c++) {
            $cell = $ws.Cells.Item($r, $c).Text
            $row += $cell
        }
        $rows += ,$row
    }
    
    $wb.Close($false)
    
    $json = @{ rows = $rows } | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} finally {
    $excel.Quit()
}
`;
    const output = await this.runPowerShell(script);
    const data = JSON.parse(output.trim());
    
    const rows: string[][] = data.rows || [];
    return {
      title: "Excel Document",
      nodes: [
        {
          id: "1",
          type: "table",
          content: `Table with ${rows.length} rows`,
          rows: rows.map((r: string[], i: number) => ({
            id: `row-${i}`,
            cells: r,
          })),
        }
      ],
      metadata: { sourceFormat: "xlsx" },
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    const absPath = fs.realpathSync(filePath);
    const tables = doc.nodes.filter(n => n.type === "table");
    const firstTable = tables[0];
    const rows = firstTable?.rows?.map(r => r.cells) || [];
    
    const script = `
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
try {
    $wb = $excel.Workbooks.Add()
    $ws = $wb.Sheets.Item(1)
    
    $rows = @(${rows.map((r: string[]) => `@(${r.map(c => `"${c}"`).join(", ")})`).join(", ")})
    for ($i = 0; $i -lt $rows.Length; $i++) {
        for ($j = 0; $j -lt $rows[$i].Length; $j++) {
            $ws.Cells.Item($i + 1, $j + 1).Value = $rows[$i][$j]
        }
    }
    
    $wb.SaveAs("${absPath}")
    $wb.Close($false)
} finally {
    $excel.Quit()
}
`;
    await this.runPowerShell(script);
  }
}

/** Windows COM PowerPoint Adapter */
export class ComPowerPointAdapter extends ComBaseAdapter {
  readonly documentType: OfficeDocumentType = "powerpoint";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
$ppt = New-Object -ComObject PowerPoint.Application
try {
    $pres = $ppt.Presentations.Open("${absPath}")
    $slides = @()
    foreach ($slide in $pres.Slides) {
        $text = ""
        foreach ($shape in $slide.Shapes) {
            if ($shape.HasTextFrame) {
                $text += $shape.TextFrame.TextRange.Text + "\n"
            }
        }
        $slides += @{ text = $text.Trim() }
    }
    $pres.Close()
    
    $json = @{ slides = $slides } | ConvertTo-Json -Compress -Depth 3
    Write-Output $json
} finally {
    $ppt.Quit()
}
`;
    const output = await this.runPowerShell(script);
    const data = JSON.parse(output.trim());
    
    return {
      title: "PowerPoint Presentation",
      nodes: (data.slides || []).map((s: { text: string }, i: number) => ({
        id: String(i + 1),
        type: "paragraph" as const,
        content: s.text || "",
      })),
      metadata: { sourceFormat: "pptx" },
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    const absPath = fs.realpathSync(filePath);
    const slides = doc.nodes.filter(n => n.type === "heading" || n.type === "paragraph");
    
    const script = `
$ppt = New-Object -ComObject PowerPoint.Application
try {
    $pres = $ppt.Presentations.Add()
    
    foreach ($node in @(${slides.map((s, i) => `{ text = "${s.content.replace(/"/g, '""')}" }`).join("; ")})) {
        $slide = $pres.Slides.Add($pres.Slides.Count + 1, 2)  # ppLayoutText = 2
        $slide.Shapes(1).TextFrame.TextRange.Text = $node.text
    }
    
    $pres.SaveAs("${absPath}")
    $pres.Close()
} finally {
    $ppt.Quit()
}
`;
    await this.runPowerShell(script);
  }
}

// Re-import OfficeUtils for tempPath
import { OfficeUtils } from "./office-adapter.js";
