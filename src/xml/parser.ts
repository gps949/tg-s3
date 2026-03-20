export function parseDeleteObjects(xml: string): { keys: string[]; quiet: boolean } {
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    keys.push(decodeXmlEntities(m[1]));
  }
  const quiet = /<Quiet>true<\/Quiet>/i.test(xml);
  return { keys, quiet };
}

export function parseCompleteMultipart(xml: string): Array<{ partNumber: number; etag: string }> {
  const parts: Array<{ partNumber: number; etag: string }> = [];
  // Match each <Part>...</Part> block, then extract PartNumber and ETag from within.
  // This handles extra elements (ChecksumCRC32, ChecksumSHA256, etc.) and any element order.
  const partRe = /<Part>([\s\S]*?)<\/Part>/g;
  let pm;
  while ((pm = partRe.exec(xml)) !== null) {
    const inner = pm[1];
    const pnMatch = /<PartNumber>(\d+)<\/PartNumber>/.exec(inner);
    const etagMatch = /<ETag>([^<]+)<\/ETag>/.exec(inner);
    if (pnMatch && etagMatch) {
      parts.push({ partNumber: parseInt(pnMatch[1], 10), etag: decodeXmlEntities(etagMatch[1]) });
    }
  }
  // Return parts in document order (caller validates ascending order per S3 spec)
  return parts;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}
