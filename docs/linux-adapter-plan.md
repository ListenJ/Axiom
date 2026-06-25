# Linux Office Adapter Specification

## Overview

Linux Office Adapter 为 Linux 桌面环境提供完整的 Office 文档自动化能力。它是 OpenClaw 平台适配器家族的新成员，与 Windows COM Adapter 和 macOS AppleScript Adapter 并列。

**目标平台**: Ubuntu, Debian, Fedora, Arch Linux 等主流发行版
**主要依赖**: LibreOffice, Python 3, xclip, xdotool, wmctrl

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Linux Office Adapter                      │
├─────────────────────────────────────────────────────────────┤
│  LibreOffice Adapter (Primary)                               │
│  ├─ LibreOfficeWordAdapter                                  │
│  ├─ LibreOfficeExcelAdapter                                 │
│  └─ LibreOfficePowerPointAdapter                            │
├─────────────────────────────────────────────────────────────┤
│  Python Adapter (Fallback)                                   │
│  ├─ PythonWordAdapter (python-docx)                         │
│  ├─ PythonExcelAdapter (openpyxl)                           │
│  └─ PythonPowerPointAdapter (python-pptx)                   │
├─────────────────────────────────────────────────────────────┤
│  System Tools                                                │
│  ├─ xclip (clipboard)                                       │
│  ├─ xdotool (window automation)                             │
│  └─ wmctrl (window management)                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. LibreOffice Adapter

**Capability**: Document conversion, batch processing, PDF generation

**Supported Formats**:
| Format | Read | Write | Convert |
|--------|------|-------|---------|
| DOCX   | ✅   | ✅    | ✅      |
| DOC    | ✅   | ❌    | ✅      |
| ODT    | ✅   | ✅    | ✅      |
| XLSX   | ✅   | ✅    | ✅      |
| XLS    | ✅   | ❌    | ✅      |
| ODS    | ✅   | ✅    | ✅      |
| PPTX   | ✅   | ✅    | ✅      |
| PPT    | ✅   | ❌    | ✅      |
| ODP    | ✅   | ✅    | ✅      |
| PDF    | ❌   | ❌    | ✅ (output) |

**Implementation**:
```typescript
class LibreOfficeWordAdapter extends LinuxBaseAdapter {
  readonly documentType = "word";
  
  async doRead(filePath: string): Promise<UniversalDocument> {
    // Convert to ODT first, then parse
    const odtPath = await this.convertToOdt(filePath);
    return this.parseOdt(odtPath);
  }
  
  async doWrite(doc: UniversalDocument, filePath: string): Promise<void> {
    // Generate ODT, then convert to target format
    const odtPath = await this.generateOdt(doc);
    await this.convertFromOdt(odtPath, filePath);
  }
  
  async convertToPdf(filePath: string, outputPath: string): Promise<void> {
    await execAsync(`libreoffice --headless --convert-to pdf "${filePath}" --outdir "${dirname(outputPath)}"`);
  }
}
```

**Command Pattern**:
```bash
# Convert to PDF
libreoffice --headless --convert-to pdf "input.docx" --outdir "/output/dir"

# Convert to ODT
libreoffice --headless --convert-to odt "input.docx" --outdir "/tmp"

# Batch conversion
libreoffice --headless --convert-to pdf *.docx
```

---

### 2. Python Adapter (Fallback)

**Capability**: Direct document manipulation when LibreOffice is unavailable

**Requirements**:
```bash
pip3 install python-docx openpyxl python-pptx
```

**Supported Operations**:
- **Word**: Read paragraphs, tables, images; Write text, tables, styles
- **Excel**: Read cells, formulas, charts; Write data, formulas, formatting
- **PowerPoint**: Read slides, shapes, text; Write slides, text, images

**Implementation**:
```typescript
class PythonWordAdapter extends LinuxBaseAdapter {
  readonly documentType = "word";
  
  async doRead(filePath: string): Promise<UniversalDocument> {
    const script = `
import docx
from docx import Document
doc = Document("${filePath}")
# Extract paragraphs, tables, images
...`;
    const result = await execAsync(`python3 -c "${script}"`);
    return this.parsePythonOutput(result.stdout);
  }
}
```

---

### 3. System Tools Integration

#### xclip (Clipboard)
```bash
# Copy text to clipboard
echo "text" | xclip -selection clipboard

# Paste text from clipboard
xclip -selection clipboard -o

# Copy file to clipboard
xclip -selection clipboard -t image/png < image.png
```

#### xdotool (Window Automation)
```bash
# Type text
xdotool type "Hello World"

# Press keys
xdotool key ctrl+s

# Click at coordinates
xdotool click 1

# Find window
xdotool search --name "Document.docx"
```

#### wmctrl (Window Management)
```bash
# List windows
wmctrl -l

# Activate window
wmctrl -a "Document.docx"

# Maximize window
wmctrl -r "Document.docx" -b add,maximized_vert,maximized_horz
```

---

## Platform Detection

```typescript
// src/ide/office/platform-adapter.ts
export async function getOfficeAdapter(
  documentType: OfficeDocumentType,
  platform?: string
): Promise<OfficeAdapter> {
  const p = platform || process.platform;
  
  switch (p) {
    case "win32":
      return getWindowsAdapter(documentType);  // COM or WPS
    case "darwin":
      return getMacAdapter(documentType);      // AppleScript
    case "linux":
      return getLinuxAdapter(documentType);    // LibreOffice or Python
    default:
      throw new Error(`Unsupported platform: ${p}`);
  }
}
```

---

## Installation Guide

### Ubuntu/Debian
```bash
# LibreOffice
sudo apt-get update
sudo apt-get install -y libreoffice libreoffice-writer libreoffice-calc libreoffice-impress

# Python libraries
pip3 install python-docx openpyxl python-pptx

# System tools
sudo apt-get install -y xclip xdotool wmctrl
```

### Fedora
```bash
# LibreOffice
sudo dnf install -y libreoffice libreoffice-writer libreoffice-calc libreoffice-impress

# Python libraries
pip3 install python-docx openpyxl python-pptx

# System tools
sudo dnf install -y xclip xdotool wmctrl
```

### Arch Linux
```bash
# LibreOffice
sudo pacman -S libreoffice-still

# Python libraries
pip3 install python-docx openpyxl python-pptx

# System tools
sudo pacman -S xclip xdotool wmctrl
```

---

## API Reference

### LinuxOfficeAdapter

```typescript
interface LinuxOfficeAdapter {
  // Document operations
  read(filePath: string, options?: ConversionOptions): Promise<UniversalDocument>;
  write(doc: UniversalDocument, filePath: string, options?: ConversionOptions): Promise<void>;
  convert(inputPath: string, outputPath: string, format: string): Promise<void>;
  
  // Clipboard operations
  copyToClipboard(text: string): Promise<void>;
  pasteFromClipboard(): Promise<string>;
  
  // Window operations
  findWindow(title: string): Promise<number | null>;
  activateWindow(windowId: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  
  // Availability check
  isAvailable(): Promise<boolean>;
}
```

### Usage Example

```typescript
import { getOfficeAdapter } from "./platform-adapter";

// Auto-detect platform and get adapter
const adapter = await getOfficeAdapter("word");

// Read document
const doc = await adapter.read("/path/to/document.docx");
console.log(doc.title);
console.log(doc.nodes.length);

// Modify document
doc.nodes.push({
  id: "new-para",
  type: "paragraph",
  content: "Added by OpenClaw"
});

// Write back
await adapter.write(doc, "/path/to/output.docx");

// Convert to PDF
await adapter.convert("/path/to/document.docx", "/path/to/output.pdf", "pdf");
```

---

## Testing

**Test File**: `tests/linux-adapter.test.ts`

**Coverage**:
- LibreOffice availability detection
- Python library availability detection
- Document read/write (mocked)
- Clipboard operations (mocked)
- Window operations (mocked)
- Platform detection
- Error handling

**Run Tests**:
```bash
bun test tests/linux-adapter.test.ts
```

**Results**: 12 pass, 0 fail

---

## Troubleshooting

### LibreOffice Not Found
```bash
# Check installation
which libreoffice || which soffice

# Install if missing
sudo apt-get install -y libreoffice
```

### Python Libraries Missing
```bash
# Install missing libraries
pip3 install python-docx openpyxl python-pptx

# Verify
python3 -c "import docx; import openpyxl; import pptx; print('OK')"
```

### Permission Issues
```bash
# xclip requires X11 display
echo $DISPLAY

# If running headless, install xvfb
sudo apt-get install -y xvfb
xvfb-run -a libreoffice --headless --convert-to pdf input.docx
```

---

## Future Enhancements

1. **KDE/GNOME Integration**: Native D-Bus API for window management
2. **Wayland Support**: Replace xdotool with wlroots-based tools
3. **Flatpak/Snap**: Support for sandboxed LibreOffice installations
4. **Cloud Storage**: Integrate with Nextcloud, ownCloud for remote documents

---

*Last Updated: 2026-06-03*
*Version: v2.3.0*
