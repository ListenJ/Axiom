/**
 * macOS AppleScript Office Adapter
 * 
 * Uses AppleScript to interact with Microsoft Office for Mac.
 * Supports Word, Excel, and PowerPoint operations.
 */

import { BaseOfficeAdapter, OfficeDocumentType, PlatformCapabilities } from "./office-adapter.js";
import { UniversalDocument, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";

const execAsync = promisify(exec);

/** Base class for AppleScript-based Office adapters */
abstract class AppleScriptBaseAdapter extends BaseOfficeAdapter {
  readonly platform = "macos";
  readonly capabilities: PlatformCapabilities = {
    canRead: true,
    canWrite: true,
    canScript: true,
    requiresProcess: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      // Check if Microsoft Word is installed
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to return name of exists application "Microsoft Word"'`,
        { timeout: 10000 }
      );
      return stdout.trim().toLowerCase() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Execute AppleScript and return output
   */
  protected async runAppleScript(script: string, timeout = 30000): Promise<string> {
    const { stdout, stderr } = await execAsync(
      `osascript -e '${script.replace(/'/g, "'\\''")}'`,
      { timeout }
    );
    if (stderr) {
      logger.warn("[AppleScriptAdapter] stderr:", { stderr: stderr.trim() });
    }
    return stdout.trim();
  }
}

/** macOS AppleScript Word Adapter */
export class AppleScriptWordAdapter extends AppleScriptBaseAdapter {
  readonly documentType: OfficeDocumentType = "word";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
tell application "Microsoft Word"
    set docPath to "${absPath}"
    open file name docPath
    set docContent to content of text object of active document
    set docTitle to name of active document
    close active document saving no
    return docTitle & "|" & docContent
end tell
`;
    const output = await this.runAppleScript(script);
    const [title, ...contentParts] = output.split("|");
    const content = contentParts.join("|"); // In case content contains |
    
    return {
      title: title || "Untitled",
      nodes: [
        { id: "1", type: "paragraph", content: content || "" }
      ],
      metadata: { sourceFormat: "docx" },
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    const absPath = fs.realpathSync(filePath);
    const content = doc.nodes.map(n => n.content).join("\n\n");
    const script = `
tell application "Microsoft Word"
    set newDoc to make new document
    set content of text object of newDoc to "${content.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
    save as newDoc file name "${absPath}"
    close newDoc saving no
end tell
`;
    await this.runAppleScript(script);
  }
}

/** macOS AppleScript Excel Adapter */
export class AppleScriptExcelAdapter extends AppleScriptBaseAdapter {
  readonly documentType: OfficeDocumentType = "excel";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
tell application "Microsoft Excel"
    open workbook workbook file name "${absPath}"
    set ws to active sheet
    set lastRow to (count of rows of used range of ws)
    set lastCol to (count of columns of used range of ws)
    
    set csvLines to {}
    repeat with r from 1 to lastRow
        set rowValues to {}
        repeat with c from 1 to lastCol
            set cellValue to value of cell r of column c of ws
            set end of rowValues to (cellValue as string)
        end repeat
        set end of csvLines to (my joinList(rowValues, ","))
    end repeat
    
    close active workbook saving no
    return my joinList(csvLines, "\n")
end tell

on joinList(aList, delimiter)
    set oldDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiter
    set theString to aList as string
    set AppleScript's text item delimiters to oldDelimiters
    return theString
end joinList
`;
    const output = await this.runAppleScript(script);
    const rows = output.split("\n").map(line => line.split(","));
    
    return {
      title: "Excel Document",
      nodes: [
        {
          id: "1",
          type: "table",
          content: `Table with ${rows.length} rows`,
          rows: rows.map((r, i) => ({
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
    
    // Build cell assignment lines separately to avoid nested template strings
    const cellLines: string[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      for (let ci = 0; ci < rows[ri].length; ci++) {
        const cellValue = rows[ri][ci].replace(/"/g, '\\"');
        cellLines.push(`    set value of cell ${ri + 1} of column ${ci + 1} of ws to "${cellValue}"`);
      }
    }
    
    const script = `
tell application "Microsoft Excel"
    set wb to make new workbook
    set ws to active sheet of wb
${cellLines.join("\n")}
    
    save workbook as wb filename "${absPath}"
    close wb saving no
end tell
`;
    await this.runAppleScript(script);
  }
}

/** macOS AppleScript PowerPoint Adapter */
export class AppleScriptPowerPointAdapter extends AppleScriptBaseAdapter {
  readonly documentType: OfficeDocumentType = "powerpoint";

  protected async doRead(filePath: string): Promise<UniversalDocument> {
    const absPath = fs.realpathSync(filePath);
    const script = `
tell application "Microsoft PowerPoint"
    open "${absPath}"
    set pres to active presentation
    set slideTexts to {}
    repeat with s from 1 to (count of slides of pres)
        set slideText to ""
        tell slide s of pres
            repeat with shapeRef in shapes
                if has text frame of shapeRef then
                    set slideText to slideText & content of text range of text frame of shapeRef & "\n"
                end if
            end repeat
        end tell
        set end of slideTexts to slideText
    end repeat
    close pres saving no
    return my joinList(slideTexts, "|||SLIDE|||")
end tell

on joinList(aList, delimiter)
    set oldDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiter
    set theString to aList as string
    set AppleScript's text item delimiters to oldDelimiters
    return theString
end joinList
`;
    const output = await this.runAppleScript(script);
    const slides = output.split("|||SLIDE|||");
    
    return {
      title: "PowerPoint Presentation",
      nodes: slides.map((text, i) => ({
        id: String(i + 1),
        type: "paragraph" as const,
        content: text.trim(),
      })),
      metadata: { sourceFormat: "pptx" },
    };
  }

  protected async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    const absPath = fs.realpathSync(filePath);
    const slides = doc.nodes.filter(n => n.type === "heading" || n.type === "paragraph");
    
    // Build slide creation lines separately to avoid nested template strings
    const slideLines: string[] = [];
    for (let i = 0; i < slides.length; i++) {
      const content = slides[i].content.replace(/"/g, '\\"').replace(/\n/g, "\\n");
      slideLines.push(`
    tell pres
        set s${i} to make new slide at end
        tell s${i}
            set text of text range of text frame of shape 1 to "${content}"
        end tell
    end tell`);
    }
    
    const script = `
tell application "Microsoft PowerPoint"
    set pres to make new presentation
${slideLines.join("\n")}
    
    save pres in "${absPath}"
    close pres saving no
end tell
`;
    await this.runAppleScript(script);
  }
}
