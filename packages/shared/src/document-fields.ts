/**
 * The fields of a document that are written into its Word file (PROJECT.md 6.14). A template marks the places with
 * content controls (Word: Developer > Rich Text / Plain Text Content Control) whose tag is one of these names.
 */
export const DOCUMENT_FIELD_TAGS = ['DOC_CODE', 'DOC_TITLE', 'DOC_DEPARTMENT', 'DOC_REVISION_NO', 'DOC_PREPARED_BY'] as const;
export type DocumentFieldTag = (typeof DOCUMENT_FIELD_TAGS)[number];

/** A value is cut at this many characters; a title longer than a header line would only break the layout. */
export const DOCUMENT_FIELD_VALUE_MAX_LENGTH = 300;
