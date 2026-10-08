export type PdfConversionFailure =
  | 'REVISION_NOT_FOUND'
  | 'CONVERTER_UNAVAILABLE'
  | 'CONVERSION_FAILED'
  | 'UNTRUSTED_URL'
  | 'INVALID_OUTPUT';

/** A conversion that did not produce a PDF; `reason` is a short code that is stored and shown to administrators. */
export class PdfConversionError extends Error {
  constructor(
    readonly reason: PdfConversionFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}
