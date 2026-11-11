/**
 * The markdown twin of `<ElementDemo />`. The demo is the element itself, running, and the
 * facts about it are the prose around it on the same page — so the twin says only that a
 * live demo stands here, rather than pointing an agent at an HTML page with nothing more in it.
 */
export function alt(props: Record<string, string>): string {
  return `*A live \`<sub-${props.name ?? 'element'}>\` runs here on the web page, with a theme picker and a log of the events it fires.*`;
}
