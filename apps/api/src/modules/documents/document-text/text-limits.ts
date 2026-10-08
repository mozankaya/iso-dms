import { UnprocessableEntityException } from '@nestjs/common';
import JSZip from 'jszip';

/** What one part of a package may unpack to; a zip bomb is stopped here, before it is held in memory. */
export const MAX_PART_BYTES = 30 * 1024 * 1024;

/** The streaming reader of JSZip; its typings leave it out. */
interface PartStream {
  on(event: 'data', handler: (chunk: Uint8Array) => void): PartStream;
  on(event: 'error', handler: (error: Error) => void): PartStream;
  on(event: 'end', handler: () => void): PartStream;
  pause(): PartStream;
  resume(): PartStream;
}

export class UnreadableDocumentError extends Error {}

export function tooLargeToCompare(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'DOCUMENT_TOO_LARGE_TO_COMPARE',
    message: 'The document is too large to be compared',
  });
}

export async function openPackage(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new UnreadableDocumentError('The file is not a zip package');
  }
}

/** The text of one part of the package, or null when the package has no such part. Refuses an oversized part. */
export function readPart(zip: JSZip, name: string): Promise<string | null> {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve(null);
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let refused = false;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): PartStream }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        if (refused) return;
        size += chunk.length;
        if (size > MAX_PART_BYTES) {
          refused = true;
          stream.pause();
          reject(tooLargeToCompare());
          return;
        }
        chunks.push(chunk);
      })
      .on('error', () => reject(new UnreadableDocumentError('The part cannot be unpacked')))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .resume();
  });
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function decodeXml(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}
