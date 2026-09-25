/**
 * The Observability menu's children (#1767), and which of the page's sub-views each one
 * owns. The redesign (#1752) splits the one page into Pulse · Processes · Logs (Findings
 * joins when #1748 gives it a store). Until each gets its own layout, a child is a named
 * group of the sub-views that already exist — so every link into `?view=…` still lands,
 * and the menu is what tells the reader where they are.
 *
 * The section is derived from `view`, never stored beside it: a URL that carried both
 * could disagree with itself, and the old links carry only `view`.
 */
export type ObsSection = 'pulse' | 'processes' | 'logs';

export const OBS_SECTIONS: { key: ObsSection; label: string }[] = [
  { key: 'pulse', label: 'Pulse' },
  { key: 'processes', label: 'Processes' },
  { key: 'logs', label: 'Logs' },
];

/** Each child's sub-views; the first is where the child opens. */
export const SECTION_VIEWS: Record<ObsSection, readonly string[]> = {
  pulse: ['traffic', 'health', 'schedules'],
  processes: ['flow'],
  logs: ['logs', 'events'],
};

/** The child a sub-view belongs to. An unknown or absent view is Pulse, the page's default. */
export function sectionOf(view: string | null | undefined): ObsSection {
  for (const s of OBS_SECTIONS) if (view && SECTION_VIEWS[s.key].includes(view)) return s.key;
  return 'pulse';
}

/** The sub-view a child opens on. */
export function defaultView(section: ObsSection): string {
  return SECTION_VIEWS[section][0]!;
}

export function sectionLabel(section: ObsSection): string {
  return OBS_SECTIONS.find((s) => s.key === section)!.label;
}
