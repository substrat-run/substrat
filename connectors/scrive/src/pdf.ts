/**
 * A minimal, dependency-free PDF writer.
 *
 * PDF is a text format, and Helvetica is one of the base-14 fonts every reader
 * ships, so a single page of text needs no library and no font embedding. Web
 * standards only — this runs unchanged in Node, Workers and a browser.
 *
 * ## What this is NOT
 *
 * It is not the documents engine (master plan §6), and it is deliberately not
 * where an *avtal* gets laid out. Rendering a contract belongs to the vertical
 * that owns its content — a connector cannot read another module's tables, and
 * should not learn a vertical's vocabulary to try.
 *
 * What this renders is an **attestation sheet**: what is being signed, by whom,
 * and the hash it is identified by. That is honest for a hash-attestation model
 * and enough to exercise the seam end to end. A real contract needs the
 * vertical's own rendering plus somewhere to put the bytes, and neither exists
 * yet (see the connector's README).
 */

const CP1252_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

/**
 * Encode one string to WinAnsi, or throw.
 *
 * **Never approximate.** PDF text is WinAnsi (CP1252), which differs from
 * Latin-1 exactly in `0x80`–`0x9F` — exactly where typographic punctuation
 * lives. An unmapped character therefore does not fail, it SILENTLY
 * SUBSTITUTES: the first draft of this renderer produced a document whose
 * em-dash read as `€24`, which `file(1)` accepted and a parser read cleanly.
 * On a document someone signs, that is the worst available failure mode, and it
 * is invisible to every check short of looking at the rendered page.
 */
function encodeWinAnsi(text: string): string {
  return [...text]
    .map((ch) => {
      if (ch === '(' || ch === ')' || ch === '\\') return `\\${ch}`;
      const cp = ch.codePointAt(0)!;
      const code = cp <= 0x7e ? cp : (CP1252_HIGH[ch] ?? (cp <= 0xff ? cp : undefined));
      if (code === undefined) {
        throw new Error(
          `character not representable in WinAnsi: ${JSON.stringify(ch)} ` +
            `(U+${cp.toString(16).toUpperCase().padStart(4, '0')}) — refusing to substitute`,
        );
      }
      return code > 126 ? `\\${code.toString(8).padStart(3, '0')}` : String.fromCharCode(code);
    })
    .join('');
}

/**
 * Whether `renderPdf` can set this text. For a caller holding text it did not
 * write — a vertical's document title — that must pick different TRUE text
 * rather than have the render throw (#1926), since the encoder above will not
 * approximate.
 */
export function representableInWinAnsi(text: string): boolean {
  try {
    encodeWinAnsi(text);
    return true;
  } catch {
    return false;
  }
}

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

export interface PdfPage {
  title: string;
  lines: string[];
}

/** A one-page A4 document. Returns the bytes, ready to upload. */
export function renderPdf(page: PdfPage): Uint8Array {
  const content =
    `BT /F1 16 Tf 56 780 Td (${encodeWinAnsi(page.title)}) Tj ET\n` +
    page.lines
      .map((l, i) => `BT /F1 11 Tf 56 ${748 - i * 18} Td (${encodeWinAnsi(l)}) Tj ET`)
      .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // Latin-1 out: every byte in `pdf` is already <= 0xFF by construction above.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  void TextEncoder;
  return bytes;
}
