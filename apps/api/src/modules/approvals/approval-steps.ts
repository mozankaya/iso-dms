/**
 * The steps every request goes through, in order (PROJECT.md 6.3): the approver of the document's department
 * first, then the quality manager, who gives the final go.
 */
export const APPROVAL_STEPS = ['APPROVER', 'QUALITY_MANAGER'] as const;
