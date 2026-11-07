/** Review archives built in memory: USTAR blocks, gzip, SHA-256, as the CLI uploads them. */
export const BLOCK = 512;

export function octal(block: Uint8Array, at: number, width: number, n: number): void {
  block.set(new TextEncoder().encode(n.toString(8).padStart(width - 1, '0')), at);
  block[at + width - 1] = 0;
}

export function tar(entries: { path: string; bytes?: Uint8Array; type?: number; declaredSize?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? new Uint8Array(0);
    const h = new Uint8Array(BLOCK);
    h.set(new TextEncoder().encode(entry.path), 0);
    octal(h, 100, 8, 0o644);
    octal(h, 108, 8, 0);
    octal(h, 116, 8, 0);
    octal(h, 124, 12, entry.declaredSize ?? body.length);
    octal(h, 136, 12, 0);
    h.fill(32, 148, 156);
    h[156] = entry.type ?? 48;
    h.set(new TextEncoder().encode('ustar'), 257);
    h.set(new TextEncoder().encode('00'), 263);
    octal(h, 148, 8, h.reduce((a, b) => a + b, 0));
    parts.push(h, body, new Uint8Array((BLOCK - body.length % BLOCK) % BLOCK));
  }
  parts.push(new Uint8Array(2 * BLOCK));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export async function archiveRaw(raw: Uint8Array) {
  const gzip = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gzip).arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { file: new File([bytes], 'source.tar.gz', { type: 'application/gzip' }), sha256 };
}

export async function archive(entries: { path: string; bytes?: Uint8Array; type?: number; declaredSize?: number }[] = [{ path: 'src/main.ts' }]) {
  return archiveRaw(tar(entries));
}

