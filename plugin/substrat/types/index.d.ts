/** What the approvals pane (#3146) is showing, and where its answer stands. */
export type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly message: string };

/** How the CLI is started for this vertical, as the agent started it. */
export type Launch = { readonly launcher: readonly string[]; readonly cwd: string };

/** A design gate waiting for the person: the delta as `substrat plan` renders it. */
export type PlanApproval = {
  readonly launch: Launch;
  /** `['plan', dir?, '--base', ref?]`: the arguments that render this delta again. */
  readonly plan: readonly string[];
  /** The rendered delta; null until the pane has run it. */
  readonly markdown: string | null;
  /** The digest the delta names; null for an empty delta or one not rendered yet. */
  readonly digest: string | null;
  readonly by: string;
  readonly why: string;
  readonly status: Status;
};

/** A promote the control plane refused until a person acknowledges what it printed. */
export type PromoteApproval = {
  readonly launch: Launch;
  readonly slug: string;
  readonly versionId: string;
  readonly acks: readonly string[];
  readonly review: string | null;
  readonly text: string;
  readonly status: Status;
};

/** A code review the person started from the pane: the id and state the upload answered. */
export type CodeReview = {
  readonly id: string | null;
  readonly state: string | null;
  readonly status: Status;
};

/** The vertical's open changes, as `substrat changes --json` answers them. */
export type OpenChanges = {
  readonly provider: 'github' | 'artifacts' | null;
  readonly repository: string | null;
  /** Why none can be read, when `provider` is null; or why some of what it shows is unknown. */
  readonly reason: string | null;
  readonly changes: readonly {
    readonly id: string;
    readonly title: string;
    readonly branch: string;
    readonly url: string | null;
    readonly checks: { readonly state: 'success' | 'failure' | 'pending' | 'none' | 'unknown'; readonly failing: readonly string[] };
    readonly preview: { readonly tag: string; readonly url: string | null } | null;
  }[];
};

declare module 'claude-code' {
  interface PluginState {
    substrat: {
      plan: Shaped<PlanApproval | null>;
      promote: Shaped<PromoteApproval | null>;
      review: Shaped<CodeReview | null>;
      changes: Shaped<OpenChanges | null>;
    };
  }
}
