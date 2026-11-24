/**
 * Whether this page is drawn inside the install's page template (#3350), and whether it is the
 * console editor's preview of one. The server says so on the element the app mounts on
 * (`pageParts` in `src/page-template.ts`), so no inline script is needed to carry it.
 */

/** The mount point is the template's `{%- auth0:widget -%}`. */
export function insideTemplate(): boolean {
  return document.getElementById('root')?.classList.contains('page-template-widget') ?? false;
}

/** The screen a preview asks for, or null outside a preview. */
export function previewScreen(): string | null {
  return document.getElementById('root')?.dataset.previewScreen ?? null;
}
