/**
 * The markdown twin of the signup form.
 *
 * A form cannot be flattened into prose that works — there is nothing for a reader of
 * the twin to submit — so what the twin has to carry is the FACT the form encodes:
 * which list this is, that joining is double opt-in, and what the address is used for.
 * An agent summarising this page for somebody should be able to tell them how to sign
 * up and what will happen when they do, and a pointer at the HTML page saying "form"
 * says none of that.
 *
 * Rendered from the same two props the component reads, so the twin and the form
 * cannot disagree about which list is on the page.
 */
export function alt(props: Record<string, string>): string {
  const waitlist = (props.kind ?? 'waitlist') === 'waitlist';
  const what = waitlist
    ? 'a place on the waiting list for the Substrat private beta'
    : 'the weekly changelog by email';
  return (
    `*(On the web page, a form here asks for an email address — and, for the waiting ` +
    `list, an optional note about what you would build — to request ${what}. ` +
    `Signing up is double opt-in: submitting sends one confirmation email and nothing ` +
    `is added to any list until the link in it is clicked. Every message after that ` +
    `carries an unsubscribe link. The form posts to Substrat's own ticket0 support ` +
    `desk at ${props.desk ?? 'https://ticket0.substrat.net'}, which only accepts ` +
    `signups from pages it lists as allowed origins.)*`
  );
}
