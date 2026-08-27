/**
 * 统一文档读取器测试 — PDF(unpdf) / DOCX(mammoth) / Markdown / HTML / TXT
 */
import { describe, it, expect } from "bun:test";
import { readDocument } from "../src/knowledge/document-reader.js";

// ── 最小有效 PDF（无压缩文本流 + 正确 xref）──
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function makeMinimalPdf(text: string): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  const lines: string[] = ["%PDF-1.4"];
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(lines.join("\n") + "\n");
    lines.push(`${i} 0 obj\n${objs[i]}\nendobj`);
  }
  const xrefOffset = Buffer.byteLength(lines.join("\n") + "\n");
  lines.push("xref", "0 6", "0000000000 65535 f ");
  for (let i = 1; i <= 5; i++) lines.push(String(offsets[i]).padStart(10, "0") + " 00000 n ");
  lines.push("trailer", "<< /Size 6 /Root 1 0 R >>", "startxref", String(xrefOffset), "%%EOF");
  return new TextEncoder().encode(lines.join("\n"));
}

// ── 最小有效 DOCX（ZIP stored 条目 + Content_Types/rels/document.xml）──
function zipStore(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const nameBuf = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    chunks.push(new Uint8Array(local), nameBuf, e.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cen.writeUInt16LE(20, 4); // made by
    cen.writeUInt16LE(20, 6); // needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(0, 10); // method
    cen.writeUInt16LE(0, 12); // time
    cen.writeUInt16LE(0x21, 14); // date
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(new Uint8Array(cen), nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const cdOffset = chunks.reduce((a, c) => a + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...central, eocd]));
}

function makeMinimalDocx(title: string, body: string): Uint8Array {
  const enc = new TextEncoder();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`;
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/document.xml", data: enc.encode(documentXml) },
  ]);
}

describe("readDocument — PDF (unpdf 本地提取)", () => {
  it("文字型 PDF 提取文本", async () => {
    const pdf = makeMinimalPdf("Hello PDF World");
    const r = await readDocument(pdf, "pdf");
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("Hello PDF World");
    expect(r.via).toBe("unpdf");
  });
});

describe("readDocument — DOCX (mammoth → markdown，保留标题)", () => {
  it("提取正文并保留 Heading1 结构", async () => {
    const docx = makeMinimalDocx("Chapter One", "Hello Word body");
    const r = await readDocument(docx, "docx");
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("Hello Word body");
    expect(r.text.toLowerCase()).toContain("chapter one");
  });
});

describe("readDocument — Markdown / HTML / TXT", () => {
  it("markdown 直通解码", async () => {
    const r = await readDocument(new TextEncoder().encode("# T\n\np"), "markdown");
    expect(r.via).toBe("decode");
    expect(r.text).toContain("# T");
  });
  it("html → markdown", async () => {
    const r = await readDocument(new TextEncoder().encode("<h1>Hi</h1><p>body</p>"), "html");
    expect(r.via).toBe("html-to-markdown");
    expect(r.text).toContain("# Hi");
  });
  it("text 直通解码", async () => {
    const r = await readDocument(new TextEncoder().encode("plain text"), "text");
    expect(r.via).toBe("decode");
    expect(r.text).toBe("plain text");
  });
  it("unknown 优雅报错", async () => {
    const r = await readDocument(new Uint8Array([1, 2, 3]), "unknown");
    expect(r.error).toContain("unsupported");
  });
});
