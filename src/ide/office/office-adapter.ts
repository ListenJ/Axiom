/**
 * Office Adapter Base Module
 * 
 * Provides unified interfaces for Office document conversion.
 * All Office operations go through Markdown as the intermediate format.
 * 
 * Platform Strategy:
 * - Windows: Office COM API (primary), JS libraries (fallback)
 * - macOS: Office AppleScript (primary), JS libraries (fallback)  
 * - Linux: WPS JS API (primary), pure JS libraries (fallback)
 */

import { UniversalDocument, DocumentNode, ConversionOptions } from "../document-bridge.js";
import { logger } from "../../utils/logger.js";

/** Supported Office document types */
export type OfficeDocumentType = "word" | "excel" | "powerpoint";

/** Platform-specific adapter capabilities */
export interface PlatformCapabilities {
  /** Can read from Office format */
  canRead: boolean;
  /** Can write to Office format */
  canWrite: boolean;
  /** Can execute macros/scripts */
  canScript: boolean;
  /** Requires external process */
  requiresProcess: boolean;
}

/** Base Office adapter interface */
export interface OfficeAdapter {
  readonly documentType: OfficeDocumentType;
  readonly platform: string;
  readonly capabilities: PlatformCapabilities;

  /** Convert from Office format to UniversalDocument */
  read(filePath: string, options?: ConversionOptions): Promise<UniversalDocument>;

  /** Convert from UniversalDocument to Office format */
  write(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void>;

  /** Check if this adapter is available on current platform */
  isAvailable(): Promise<boolean>;
}

/** Abstract base class for Office adapters */
export abstract class BaseOfficeAdapter implements OfficeAdapter {
  abstract readonly documentType: OfficeDocumentType;
  abstract readonly platform: string;
  abstract readonly capabilities: PlatformCapabilities;

  async read(filePath: string, options?: ConversionOptions): Promise<UniversalDocument> {
    logger.info(`[OfficeAdapter] Reading ${this.documentType} from ${filePath}`);
    return this.doRead(filePath, options);
  }

  async write(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void> {
    logger.info(`[OfficeAdapter] Writing ${this.documentType} to ${filePath}`);
    return this.doWrite(doc, filePath, options);
  }

  abstract isAvailable(): Promise<boolean>;
  protected abstract doRead(filePath: string, options?: ConversionOptions): Promise<UniversalDocument>;
  protected abstract doWrite(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void>;
}

/** Utility functions for Office document processing */
export class OfficeUtils {
  /**
   * Convert DocumentNode array to plain text (for Word/Excel cell content)
   */
  static nodesToText(nodes: DocumentNode[]): string {
    return nodes
      .map((node) => {
        switch (node.type) {
          case "heading":
            return `${"#".repeat(node.level || 1)} ${node.content}`;
          case "paragraph":
            return node.content;
          case "code":
            return "```\n" + node.content + "\n```";
          case "list":
            return (node.items || []).map((item) => `- ${item}`).join("\n");
          case "quote":
            return node.content.split("\n").map((line) => `> ${line}`).join("\n");
          default:
            return "";
        }
      })
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Extract tables from document nodes (for Excel)
   */
  static extractTables(nodes: DocumentNode[]): Array<{ cells: string[][] }> {
    return nodes
      .filter((node) => node.type === "table")
      .map((node) => ({
        cells: node.rows?.map((row) => row.cells) || [],
      }));
  }

  /**
   * Extract headings as slide titles (for PowerPoint)
   */
  static extractSlideSections(nodes: DocumentNode[]): Array<{ title: string; content: DocumentNode[] }> {
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

  /**
   * Detect document type from file extension
   */
  static detectDocumentType(filePath: string): OfficeDocumentType | null {
    const ext = filePath.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "docx":
      case "doc":
        return "word";
      case "xlsx":
      case "xls":
      case "csv":
        return "excel";
      case "pptx":
      case "ppt":
        return "powerpoint";
      default:
        return null;
    }
  }

  /**
   * Generate temporary file path
   */
  static tempPath(ext: string): string {
    const tmpDir = process.env.TMPDIR || process.env.TEMP || "/tmp";
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    return `${tmpDir}/openclaw_office_${timestamp}_${random}.${ext}`;
  }
}
