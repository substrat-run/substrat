/**
 * The markdown twin of the support widget.
 *
 * The component renders nothing of its own — the script it appends draws the chat
 * bubble — so there is no prose to flatten. What an agent reading the twin should
 * learn is that the page carries a live desk it cannot open from markdown, and where
 * that desk is. A pointer at the HTML page would say "diagram", which is false.
 */
export function alt(props: Record<string, string>): string {
  const desk = props.desk ?? 'https://ticket0.substrat.net';
  return (
    `*(On the web page, a chat bubble in the corner opens the Substrat support desk at ` +
    `${desk} — a ticket0 desk whose knowledge base is this site's llms-full.txt.)*`
  );
}
