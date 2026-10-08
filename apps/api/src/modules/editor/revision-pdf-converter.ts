import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { FILE_TYPE_INFO } from '../storage/storage-keys';
import { FileTokenService } from './file-token.service';
import { OnlyOfficeJwtService } from './onlyoffice-jwt.service';
import { toInternalOnlyOfficeUrl } from './onlyoffice-urls';
import { PdfConversionError } from './pdf-conversion.error';

/** One conversion may take a while for a large file; past this the attempt counts as failed and is retried. */
const CONVERSION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_PDF_BYTES = 100 * 1024 * 1024;

interface ConverterAnswer {
  endConvert?: boolean;
  fileUrl?: string;
  error?: number;
}

/**
 * Turns the file of a revision into a PDF with the Conversion API of the ONLYOFFICE document server. Like the
 * rest of the integration it lives in the editor module (PROJECT.md 4.2); callers only get the PDF bytes.
 */
@Injectable()
export class RevisionPdfConverter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fileTokens: FileTokenService,
    private readonly jwt: OnlyOfficeJwtService,
  ) {}

  async convert(revisionId: string): Promise<Buffer> {
    const revision = await this.prisma.revision.findUnique({
      where: { id: revisionId },
      select: { id: true, organizationId: true, checksum: true, document: { select: { code: true, fileType: true } } },
    });
    if (!revision) throw new PdfConversionError('REVISION_NOT_FOUND');

    const extension = FILE_TYPE_INFO[revision.document.fileType].extension;
    const downloadToken = await this.fileTokens.sign({ purpose: 'download', revisionId: revision.id, organizationId: revision.organizationId });
    const body = {
      async: false,
      filetype: extension,
      outputtype: 'pdf',
      // A new key per content: the server caches conversions by key
      key: `pdf-${revision.id}-${revision.checksum.slice(0, 16)}`,
      title: `${revision.document.code}.${extension}`,
      url: `${this.apiBase()}/api/editor/files/${revision.id}?token=${downloadToken}`,
    };

    const answer = await this.requestConversion(body);
    if (typeof answer.error === 'number' && answer.error !== 0) {
      throw new PdfConversionError('CONVERSION_FAILED', `converter error ${answer.error}`);
    }
    if (!answer.endConvert || !answer.fileUrl) throw new PdfConversionError('CONVERSION_FAILED', 'conversion did not finish');

    const fileUrl = toInternalOnlyOfficeUrl(this.config, answer.fileUrl);
    if (!fileUrl) throw new PdfConversionError('UNTRUSTED_URL');

    const pdf = await this.download(fileUrl);
    if (pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfConversionError('INVALID_OUTPUT');
    return pdf;
  }

  private async requestConversion(body: Record<string, unknown>): Promise<ConverterAnswer> {
    const baseUrl = this.config.get<string>('ONLYOFFICE_INTERNAL_URL', 'http://localhost:8080').replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/converter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // The server expects the request signed like every other message between the two systems
          Authorization: `Bearer ${await this.jwt.sign({ payload: body })}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
      });
      if (!response.ok) throw new PdfConversionError('CONVERTER_UNAVAILABLE', `HTTP ${response.status}`);
      return (await response.json()) as ConverterAnswer;
    } catch (error) {
      if (error instanceof PdfConversionError) throw error;
      throw new PdfConversionError('CONVERTER_UNAVAILABLE', (error as Error).message);
    }
  }

  private async download(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw new PdfConversionError('CONVERSION_FAILED', `download HTTP ${response.status}`);

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_PDF_BYTES) throw new PdfConversionError('INVALID_OUTPUT', 'PDF too large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof PdfConversionError) throw error;
      throw new PdfConversionError('CONVERTER_UNAVAILABLE', (error as Error).message);
    }
  }

  /** Address the document server uses to reach this API (a different network than the browser has). */
  private apiBase(): string {
    return this.config.get<string>('API_INTERNAL_URL', 'http://host.docker.internal:4000').replace(/\/+$/, '');
  }
}
