/**
 * Platform Adapter Module
 * 
 * Provides platform-specific Office integration capabilities.
 * Automatically detects platform and selects appropriate adapter.
 * 
 * Platform Matrix:
 * | Platform | Primary       | Secondary     | Fallback      |
 * |----------|--------------|---------------|---------------|
 * | Windows  | Office COM   | WPS          | python-docx   |
 * | macOS    | AppleScript  | WPS          | python-docx   |
 * | Linux    | LibreOffice  | Python libs  | WPS Office    |
 */

import { OfficeAdapter, OfficeDocumentType, BaseOfficeAdapter, OfficeUtils, PlatformCapabilities } from "./office-adapter.js";
import { WordAdapter } from "./word-adapter.js";
import { ExcelAdapter } from "./excel-adapter.js";
import { PowerPointAdapter } from "./powerpoint-adapter.js";
import { ComWordAdapter, ComExcelAdapter, ComPowerPointAdapter } from "./com-adapter.js";
import { AppleScriptWordAdapter, AppleScriptExcelAdapter, AppleScriptPowerPointAdapter } from "./applescript-adapter.js";
import { WPSWordAdapter, WPSExcelAdapter, WPSPowerPointAdapter } from "./wps-adapter.js";
import { LinuxWordAdapter, LinuxExcelAdapter, LinuxPowerPointAdapter } from "./linux-adapter.js";
import { logger } from "../../utils/logger.js";

// Re-export types for convenience
export { BaseOfficeAdapter, OfficeUtils };
export type { OfficeAdapter, OfficeDocumentType, PlatformCapabilities };

export type PlatformType = "windows" | "macos" | "linux" | "unknown";

/** Platform detection result */
export interface PlatformInfo {
  type: PlatformType;
  version?: string;
  hasOffice: boolean;
  hasWPS: boolean;
  hasPython: boolean;
}

/**
 * Platform adapter factory
 * Automatically selects best available adapter for current platform
 */
export class PlatformAdapter {
  private static detectedPlatform: PlatformInfo | null = null;

  /** Detect current platform capabilities */
  static async detectPlatform(): Promise<PlatformInfo> {
    if (this.detectedPlatform) return this.detectedPlatform;

    const platform = process.platform;
    let type: PlatformType = "unknown";
    
    switch (platform) {
      case "win32":
        type = "windows";
        break;
      case "darwin":
        type = "macos";
        break;
      case "linux":
        type = "linux";
        break;
    }

    // Check for Python availability (fallback for all platforms)
    const hasPython = await this.checkCommand("python --version");
    
    // Platform-specific checks
    let hasOffice = false;
    let hasWPS = false;

    if (type === "windows") {
      hasOffice = await this.checkCommand("powershell -Command \"$word = New-Object -ComObject Word.Application; $word.Quit()\"");
      hasWPS = await this.checkCommand("where wps");
    } else if (type === "macos") {
      hasOffice = await this.checkCommand("osascript -e 'tell application \"System Events\" to return name of exists application \"Microsoft Word\"'");
      hasWPS = await this.checkCommand("which wps");
    } else if (type === "linux") {
      hasOffice = await this.checkCommand("which libreoffice || which soffice"); // LibreOffice as primary
      hasWPS = await this.checkCommand("which wps || which et");
    }

    this.detectedPlatform = {
      type,
      hasOffice,
      hasWPS,
      hasPython,
    };

    logger.info("[PlatformAdapter] Platform detected", { 
      type: this.detectedPlatform.type, 
      hasOffice: this.detectedPlatform.hasOffice, 
      hasWPS: this.detectedPlatform.hasWPS, 
      hasPython: this.detectedPlatform.hasPython 
    });
    return this.detectedPlatform;
  }

  /**
   * Get best available adapter for document type
   * Falls back to Python-based adapters if native integration unavailable
   */
  static async getAdapter(docType: OfficeDocumentType): Promise<OfficeAdapter> {
    const platform = await this.detectPlatform();

    // Try native integration first
    if (platform.hasOffice) {
      logger.info(`[PlatformAdapter] Using native Office integration for ${docType}`);
      if (platform.type === "windows") {
        // Use COM adapters on Windows
        switch (docType) {
          case "word":
            return new ComWordAdapter();
          case "excel":
            return new ComExcelAdapter();
          case "powerpoint":
            return new ComPowerPointAdapter();
        }
      } else if (platform.type === "macos") {
        // Use AppleScript adapters on macOS
        switch (docType) {
          case "word":
            return new AppleScriptWordAdapter();
          case "excel":
            return new AppleScriptExcelAdapter();
          case "powerpoint":
            return new AppleScriptPowerPointAdapter();
        }
      }
    }

    // Try Linux native adapters (LibreOffice + Python)
    if (platform.type === "linux") {
      logger.info(`[PlatformAdapter] Using Linux native integration for ${docType}`);
      switch (docType) {
        case "word":
          return new LinuxWordAdapter();
        case "excel":
          return new LinuxExcelAdapter();
        case "powerpoint":
          return new LinuxPowerPointAdapter();
      }
    }

    // Try WPS Office
    if (platform.hasWPS) {
      logger.info(`[PlatformAdapter] Using WPS Office integration for ${docType}`);
      switch (docType) {
        case "word":
          return new WPSWordAdapter();
        case "excel":
          return new WPSExcelAdapter();
        case "powerpoint":
          return new WPSPowerPointAdapter();
      }
    }

    // Fall back to Python-based adapters
    logger.info(`[PlatformAdapter] Using Python fallback for ${docType}`);
    switch (docType) {
      case "word":
        return new WordAdapter();
      case "excel":
        return new ExcelAdapter();
      case "powerpoint":
        return new PowerPointAdapter();
      default:
        throw new Error(`Unsupported document type: ${docType}`);
    }
  }

  /**
   * Check if a command is available
   */
  private static async checkCommand(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const { exec } = require("child_process");
      exec(command, { timeout: 5000 }, (error: any) => {
        resolve(!error);
      });
    });
  }

  /**
   * Get platform-specific instructions for Office setup
   */
  static getSetupInstructions(): string {
    const platform = process.platform;
    
    switch (platform) {
      case "win32":
        return `
Windows Office Integration:
1. Install Microsoft Office (Word, Excel, PowerPoint)
2. Python fallback requires: pip install python-docx openpyxl python-pptx
3. For COM integration: Office must be activated
        `.trim();
      
      case "darwin":
        return `
macOS Office Integration:
1. Install Microsoft Office for Mac
2. Python fallback requires: pip3 install python-docx openpyxl python-pptx
3. Grant Automation permissions in System Preferences > Security & Privacy > Automation
        `.trim();
      
      case "linux":
        return `
Linux Office Integration:
1. LibreOffice (recommended): sudo apt-get install libreoffice-calc libreoffice-writer libreoffice-impress
2. Python libraries: pip3 install python-docx openpyxl python-pptx
3. System tools: sudo apt-get install xclip xdotool wmctrl
4. Optional WPS Office: https://www.wps.com/linux
5. Optional: sudo apt-get install unoconv
        `.trim();
      
      default:
        return "Platform not supported for Office integration";
    }
  }
}

/** Export all adapters */
export { WordAdapter, ExcelAdapter, PowerPointAdapter };
