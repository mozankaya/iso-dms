/**
 * The part of a category's address that comes from its name: lower case, Turkish letters turned into plain ones,
 * everything else that is not a letter or a digit becomes one hyphen. "İş Akışları" -> "is-akislari".
 */
export function slugify(name: string): string {
  return name
    .trim()
    // The two letters that have no plain form to decompose into
    .replace(/İ/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    // Accents and cedillas: "ç" is a "c" and a mark, and the mark goes
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}
