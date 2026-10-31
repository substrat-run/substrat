// .vitepress/config.mts
import { resolve as resolve4 } from "node:path";
import { defineConfig } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.59.0_@types+node@26.6.3_@types+react@18.3.31_f_f4eeb7b756baec127ed2d4f961f28493/node_modules/vitepress/dist/node/index.js";
import { withMermaid } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/vitepress-plugin-mermaid@2.0.17_mermaid@11.17.2_vitepress@1.6.4_@algolia+client-search@_20defa3a94509ce5879153482fb4a711/node_modules/vitepress-plugin-mermaid/dist/vitepress-plugin-mermaid.es.mjs";

// .vitepress/llms.mts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { dirname as dirname2, extname, join as join2, resolve as resolve2 } from "node:path";

// .vitepress/sidebar.mts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var __vite_injected_original_import_meta_url = "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/apps/docs/.vitepress/sidebar.mts";
var START_HERE = "/guide/agent-rules";
function engineSidebar(slug, text) {
  return {
    text,
    collapsed: true,
    items: [
      { text: "Overview", link: `/engines/${slug}/` },
      { text: "Domain model & invariants", link: `/engines/${slug}/model` },
      { text: "Operations & permissions", link: `/engines/${slug}/surface` },
      { text: "Events", link: `/engines/${slug}/events` },
      { text: "Composing & extending", link: `/engines/${slug}/composing` }
    ]
  };
}
var CHANGELOG_DIR = resolve(dirname(fileURLToPath(__vite_injected_original_import_meta_url)), "../changelog");
function changelogSidebar() {
  const entries = existsSync(CHANGELOG_DIR) ? readdirSync(CHANGELOG_DIR).filter((f) => f.endsWith(".md") && f !== "index.md").sort().reverse() : [];
  const byYear = /* @__PURE__ */ new Map();
  for (const file of entries) {
    const slug = file.replace(/\.md$/, "");
    const year = slug.slice(0, 4);
    const raw = readFileSync(join(CHANGELOG_DIR, file), "utf8");
    const title = /^title:\s*(.+)$/m.exec(raw)?.[1].trim().replace(/^['"]|['"]$/g, "");
    byYear.set(year, [
      ...byYear.get(year) ?? [],
      { text: title ?? slug, link: `/changelog/${slug}` }
    ]);
  }
  const years = [...byYear.keys()].sort().reverse();
  return [
    {
      text: "Changelog",
      items: [
        { text: "What this is", link: "/changelog/" },
        // The current year open, everything before it folded away.
        ...years.map((year, i) => ({ text: year, collapsed: i > 0, items: byYear.get(year) }))
      ]
    }
  ];
}
function bookChapters() {
  return [
    { text: "How to read this", link: "/book/" },
    { text: "1. Why a substrate at all", link: "/book/01-why-a-substrate" },
    { text: "2. Tenants, scopes, and one database each", link: "/book/02-tenants-and-scopes" },
    { text: "3. The path of one request", link: "/book/03-one-request" },
    { text: "4. What a handler can and cannot do", link: "/book/04-inside-an-operation" },
    { text: "5. The life of one event", link: "/book/05-one-event" },
    { text: "6. Permissions and identity", link: "/book/06-permissions-and-identity" },
    { text: "7. Engines, verticals, composition", link: "/book/07-engines-and-verticals" },
    { text: "8. The life of one deploy", link: "/book/08-one-deploy" },
    { text: "9. The two clocks", link: "/book/09-the-two-clocks" },
    { text: "10. Seeing what happened", link: "/book/10-seeing-what-happened" },
    { text: "11. The audit trail and the lake", link: "/book/11-audit-and-the-lake" },
    { text: "12. Metering and billing", link: "/book/12-metering-and-billing" },
    { text: "13. Operating it", link: "/book/13-operating-it" }
  ];
}
function bookSidebar() {
  return [
    {
      text: "The book",
      items: bookChapters()
    }
  ];
}
function guideSidebar() {
  return [
    // The guide is three groups a reader takes in order: what Substrat is, how to
    // build on it, how to ship what was built. The two halves of the AI-agent story
    // (`ai-agents` and `ai-guardrails` each call the other "the other half") sit
    // together under Build, right after the agent rules they explain (#1009).
    {
      text: "Introduction",
      items: [
        { text: "What is Substrat?", link: "/guide/what-is-substrat" },
        { text: "Why runtime enforcement?", link: "/guide/why-substrat" },
        { text: "How Substrat compares", link: "/guide/comparisons" },
        { text: "What Substrat doesn't have (yet)", link: "/guide/what-substrat-lacks" },
        { text: "FAQ", link: "/guide/faq" },
        { text: "Architecture", link: "/guide/architecture" }
      ]
    },
    {
      text: "Build",
      items: [
        { text: "Getting started", link: "/guide/getting-started" },
        { text: "Walkthrough: the todo app", link: "/guide/walkthrough-todo" },
        { text: "Agent rules", link: START_HERE },
        { text: "The Claude Code plugin", link: "/guide/agent-plugin" },
        { text: "Building for AI agents", link: "/guide/ai-agents" },
        { text: "Where AI mistakes stop", link: "/guide/ai-guardrails" },
        { text: "Running locally", link: "/guide/running-locally" }
      ]
    },
    {
      text: "Ship",
      items: [
        { text: "Deploying a vertical", link: "/guide/deploying" },
        { text: "Environments & previews", link: "/guide/environments-and-previews" },
        { text: "Ask the docs", link: "/guide/support" }
      ]
    },
    {
      text: "Concepts",
      items: [
        { text: "Tenants & scopes", link: "/concepts/tenancy" },
        { text: "Scope stores", link: "/concepts/scope-stores" },
        { text: "The platform layer", link: "/concepts/platform" },
        { text: "Operations & the scope host", link: "/concepts/scope-host" },
        { text: "Permissions", link: "/concepts/permissions" },
        { text: "Authentication & identity", link: "/concepts/identity" },
        { text: "Events & audit", link: "/concepts/events" },
        { text: "Cross-vertical communication", link: "/concepts/cross-vertical" },
        { text: "Snapshots & test copies", link: "/concepts/snapshots" },
        { text: "The deploy model", link: "/concepts/deploying" },
        { text: "Reads & scaling", link: "/concepts/reads" },
        { text: "The model", link: "/concepts/model" },
        { text: "Lifecycles", link: "/concepts/lifecycle" },
        { text: "Archive & trash", link: "/concepts/archive-and-trash" },
        { text: "Attachments & upload links", link: "/concepts/attachments" },
        { text: "Modules & the manifest", link: "/concepts/modules" },
        { text: "What a good API looks like", link: "/concepts/api-design" },
        { text: "The MCP surface", link: "/concepts/mcp" },
        { text: "Money", link: "/concepts/money" }
      ]
    },
    {
      text: "Engines",
      items: [
        { text: "What is an engine?", link: "/engines/" },
        engineSidebar("workorder", "Work orders"),
        engineSidebar("booking", "Bookings"),
        engineSidebar("invoicing", "Invoicing"),
        engineSidebar("protocol", "Protocols"),
        engineSidebar("invites", "Invites"),
        engineSidebar("absence", "Absence"),
        engineSidebar("metering", "Metering"),
        engineSidebar("notifications", "Notifications"),
        engineSidebar("assistant", "Assistant")
      ]
    },
    {
      text: "Connectors",
      items: [
        { text: "What is a connector?", link: "/connectors/" },
        { text: "Scrive (e-signing)", link: "/connectors/scrive" },
        { text: "Fortnox (accounting)", link: "/connectors/fortnox" },
        { text: "Planima (facility maintenance)", link: "/connectors/planima" },
        { text: "Microsoft 365 (mail, documents)", link: "/connectors/microsoft365" },
        { text: "Inbound mail", link: "/connectors/mail-in" },
        { text: "Your own connector", link: "/connectors/your-own" }
      ]
    },
    {
      text: "Verticals",
      items: [
        { text: "What is a vertical?", link: "/verticals/" },
        { text: "Handlebar (bike workshop)", link: "/verticals/handlebar" },
        { text: "Kallk\xE4lla (coffee shop)", link: "/verticals/shop" },
        { text: "Meridian (HR)", link: "/verticals/meridian" },
        { text: "Manyfold (headless CMS)", link: "/verticals/manyfold" },
        { text: "Todo (shared lists)", link: "/verticals/todo" },
        { text: "ticket0 (support desk)", link: "/verticals/ticket0" },
        { text: "Tock (measured file loads)", link: "/verticals/tock" }
      ]
    },
    {
      text: "Platform",
      items: [
        { text: "The platform surfaces", link: "/platform/" },
        { text: "Control plane", link: "/platform/control-plane" },
        { text: "Console", link: "/platform/console" },
        { text: "Router", link: "/platform/router" },
        { text: "Dashboard", link: "/platform/dashboard" }
      ]
    },
    {
      text: "Package reference",
      items: [
        { text: "@substrat-run/contracts", link: "/reference/contracts" },
        { text: "@substrat-run/model-emit", link: "/reference/model-emit" },
        { text: "@substrat-run/model-view", link: "/reference/model-view" },
        { text: "@substrat-run/kernel", link: "/reference/kernel" },
        { text: "@substrat-run/adapter-sqlite", link: "/reference/adapter-sqlite" },
        { text: "@substrat-run/adapter-cloudflare", link: "/reference/adapter-cloudflare" },
        { text: "@substrat-run/attachment-extractors", link: "/reference/attachment-extractors" },
        { text: "@substrat-run/vertical-host", link: "/reference/vertical-host" },
        { text: "@substrat-run/vertical-auth", link: "/reference/vertical-auth" },
        { text: "@substrat-run/control-plane-api", link: "/reference/control-plane-api" },
        { text: "@substrat-run/control-plane-client", link: "/reference/control-plane-client" },
        { text: "@substrat-run/contract-tests", link: "/reference/contract-tests" },
        { text: "@substrat-run/boundary-lint", link: "/reference/boundary-lint" },
        { text: "@substrat-run/oidc-rp", link: "/reference/oidc-rp" },
        { text: "@substrat-run/dev-issuer", link: "/reference/dev-issuer" },
        { text: "@substrat-run/psl", link: "/reference/psl" },
        { text: "@substrat-run/model-providers", link: "/reference/model-providers" },
        { text: "@substrat-run/cli", link: "/reference/cli" },
        { text: "create-substrat", link: "/reference/create-substrat" }
      ]
    }
  ];
}
function fileForLink(link) {
  const path = link.replace(/^\//, "");
  return path === "" || path.endsWith("/") ? `${path}index.md` : `${path}.md`;
}
function tableOfContents() {
  const legal = {
    text: "Legal",
    items: [
      { text: "Privacy policy", link: "/privacy" },
      { text: "Terms of service", link: "/terms" }
    ]
  };
  return [...bookSidebar(), ...guideSidebar(), ...changelogSidebar(), legal].map((section) => {
    const pages = [];
    for (const item of section.items) {
      if ("link" in item && item.link) {
        pages.push({ link: item.link, text: item.text, file: fileForLink(item.link) });
        continue;
      }
      for (const child of item.items) {
        pages.push({
          link: child.link,
          text: child.text,
          group: item.text,
          file: fileForLink(child.link)
        });
      }
    }
    return { text: section.text, pages };
  });
}

// .vitepress/theme/components/PermissionPipeline.content.mts
var source = {
  tag: "authored",
  title: "Declared in TypeScript",
  sub: ["module manifests \u2192 keys + descriptions", "roles \u2192 templates \xB7 entity grants \u2192 shapes"]
};
var toReview = "renders";
var review = {
  tag: "checkpoint \xB7 a human reads this",
  title: "pnpm lint:permissions",
  sub: ["emits PERMISSIONS.md, the review artifact", "CI --check fails the build on drift"]
};
var stages = [
  {
    edge: "substrat push",
    tag: "ships",
    title: "The deploy manifest",
    sub: ["the surface rides along as a registry", "content-hashed \u2192 digests.permission"]
  },
  {
    edge: "promote",
    tag: "gate",
    title: "Admission",
    sub: ["a real diff between two versions", "a widened surface is visible, not implicit"]
  },
  {
    edge: "at write time",
    tag: "per tenant",
    title: "Provisioning",
    sub: ["role templates projected into each", "tenant's own _substrat_roles"]
  },
  {
    edge: "every operation",
    tag: "runtime",
    title: "ctx.check",
    sub: ["reads scope-local tables only", "absent or empty projection = deny"]
  }
];
var caption = "The branch off the top ends in a person: PERMISSIONS.md exists to be read in a diff, and CI going red is what makes the reading unskippable \u2014 it is not itself the approval.";
function alt() {
  return [
    "**Diagram \u2014 a permission, from declaration to check.**",
    "",
    `1. **${source.title}** (${source.tag}) \u2014 ${source.sub.join("; ")}.`,
    `   - Branches off to **${review.title}** (${review.tag}), which ${toReview} ${review.sub.join("; ")}. This branch ends in a human review, not at runtime.`,
    ...stages.map(
      (s, i) => `${i + 2}. *${s.edge}* \u2192 **${s.title}** (${s.tag}) \u2014 ${s.sub.join("; ")}.`
    ),
    "",
    caption
  ].join("\n");
}

// .vitepress/theme/components/ScopeDrain.content.mts
var commit = {
  tag: "in the scope \xB7 one transaction",
  title: "An operation commits",
  sub: ["your rows \xB7 its events in _substrat_outbox", "a platform intent, if it asked for one"]
};
var toKick = "response flagged";
var kick = {
  tag: "latency \xB7 seconds",
  title: "The router kicks",
  sub: ["returns the response to the user first", "then asks for a drain \xB7 intents and exports"]
};
var sweep = {
  tag: "backstop \xB7 every 15 minutes",
  title: "The platform sweep",
  sub: ["walks every active scope", "catches anything a kick missed"]
};
var fromKick = "names a scope, carries no data";
var fromSweep = "each active scope";
var platform = {
  tag: "platform \xB7 the only thing that acts",
  title: "The control plane drains the scope",
  sub: [
    "reads the rows itself, through the vertical's /internal routes",
    "so a kick can speed up a scope's own work, never forge it"
  ]
};
var toIntents = "executes";
var intents = {
  tag: "intents",
  title: "Run with platform authority",
  sub: ["executed outside the scope", "outcome written back to its intent journal"]
};
var toEvents = "ships";
var events = {
  tag: "events \xB7 tier 2",
  title: "Shipped to the lake",
  sub: ["marked shipped only once the lake confirms", "through the sweep only \u2014 no kick yet"]
};
var caption2 = "The kick and the sweep are not alternatives. The kick makes it fast; the sweep makes it certain \u2014 a lost kick costs a wait, never a missed intent or event. Neither carries data: the control plane always reads the scope itself. This figure follows intents and lake shipping; chapter 7 shows the separate kicked pull for exported events.";
function alt2() {
  const line = (b) => `**${b.title}** (${b.tag}) \u2014 ${b.sub.join("; ")}.`;
  return [
    "**Diagram \u2014 how committed work leaves a scope.**",
    "",
    `1. ${line(commit)}`,
    "2. Two paths reach the control plane:",
    `   - ${toKick}: ${line(kick)} It ${fromKick}.`,
    `   - ${line(sweep)} It runs on a timer rather than a signal, and drains ${fromSweep}.`,
    `3. ${line(platform)}`,
    `4. It ${toIntents} intents \u2014 ${line(intents)}`,
    `5. It ${toEvents} events \u2014 ${line(events)}`,
    "",
    caption2
  ].join("\n");
}

// .vitepress/theme/components/InstanceResolution.content.mts
var chain = [
  {
    tag: "stable",
    title: "Hostname",
    sub: "names a scope, never a version",
    git: "a checkout path",
    mutable: false
  },
  {
    tag: "the thing that is named",
    title: "Scope",
    sub: "one isolation domain, one database",
    git: "\u2014",
    mutable: false
  },
  {
    tag: "immutable",
    title: "Version id \u2192 deploymentRef",
    sub: "a pushed build never changes",
    git: "a commit sha",
    mutable: false
  }
];
var edges = ["resolves to", "currently bound to"];
var binding = {
  title: "the binding",
  detail: "bindScopeVersion \u2014 mutable by design",
  git: "a branch ref"
};
var environments = [
  ["prod", "an explicit, acknowledged promote \u2014 cascades across a shared vertical\u2019s tenants"],
  ["test", "every merge to main, one scope, ungated, driven from CI"],
  ["preview", "each push to the PR \u2014 its own scope, so it can never inherit prod\u2019s binding"]
];
var caption3 = "Nothing else names an environment. \u201Cprod\u201D and \u201Ctest\u201D are the same shape \u2014 a stable scope and a stable hostname whose binding moves; only the trigger and how gated it is differ.";
function alt3() {
  return [
    "**Diagram \u2014 what a hostname serves.** An instance is `(scope \xD7 version)`, and exactly one link in the chain is mutable.",
    "",
    `1. **${chain[0].title}** (${chain[0].tag}, ${chain[0].git}) \u2014 ${chain[0].sub}.`,
    `2. *${edges[0]}* \u2192 **${chain[1].title}** \u2014 ${chain[1].sub}.`,
    `3. *${edges[1]}* \u2014 this is **${binding.title}** (${binding.git}): ${binding.detail}. It is the only mutable link, and the only thing an environment is.`,
    `4. \u2192 **${chain[2].title}** (${chain[2].tag}, ${chain[2].git}) \u2014 ${chain[2].sub}.`,
    "",
    "**What moves the binding:**",
    ...environments.map(([env, trigger]) => `- **${env}** \u2014 ${trigger}.`),
    "",
    caption3
  ].join("\n");
}

// .vitepress/theme/components/TenancyTree.content.mts
var tenant = {
  tag: "billing \xB7 identity \xB7 the contract",
  title: "Tenant",
  sub: "slug \xB7 status \xB7 one Identity DO for all its people",
  note: "Holds no operational rows of its own."
};
var scopes = [
  { slug: "stockholm", kind: "branch", note: "active \xB7 eu" },
  { slug: "g\xF6teborg", kind: "branch", note: "active \xB7 eu" },
  { slug: "malm\xF6", kind: "branch", note: "provisioning" }
];
var scopeFacts = [
  "its own database \u2014 one SQLite file, or one Durable Object",
  "one operation at a time, run to completion",
  "kind is your vocabulary: brf, branch, brand, clinic\u2026",
  "jurisdiction and bound version are fixed per scope"
];
var barrier = "No query crosses these lines. There is no join between two scopes.";
var deeper = "parentScopeId is null on every scope today. The column exists so a deeper tree is an addition rather than a migration.";
var caption4 = "The tenant is who you bill and who can log in. The scope is where data lives and where consistency is decided \u2014 which is why isolation is a property of the substrate here, not a WHERE clause somebody has to remember.";
function alt4() {
  return [
    "**Diagram \u2014 a tenant and its scopes.**",
    "",
    `- **${tenant.title}** (${tenant.tag}) \u2014 ${tenant.sub}. ${tenant.note}`,
    `- It contains scopes: ${scopes.map((s) => `\`${s.slug}\` (${s.kind}, ${s.note})`).join(", ")}.`,
    "- Every scope is: " + scopeFacts.join("; ") + ".",
    `- **${barrier}**`,
    `- ${deeper}`,
    "",
    caption4
  ].join("\n");
}

// .vitepress/theme/components/ReadPaths.content.mts
var paths = [
  {
    n: 1,
    title: "In-scope read",
    latency: "\xB5s",
    consistency: "serializable",
    use: "everything interactive",
    how: "local tables; projection consumers run after commit in the same turn",
    inside: true
  },
  {
    n: 2,
    title: "External read model",
    latency: "ms",
    consistency: "eventually consistent",
    use: "a scope whose reads outgrow its executor",
    how: "fed by events off the spine",
    inside: false
  },
  {
    n: 3,
    title: "History tier",
    latency: "seconds",
    consistency: "eventually consistent",
    use: "reporting, audit, cross-scope",
    how: "exported to Iceberg / R2 SQL",
    inside: false
  }
];
var order = "Reach for them in this order.";
var caption5 = "An in-scope projection has no visible gap when its consumer succeeds; a failed consumer can leave it behind. External projections have delivery lag. The history gateway is staff-only and requires configuration; it is not an interactive read tier.";
function alt5() {
  return [
    `**Diagram \u2014 the three read paths.** ${order} The further a path sits from the scope that owns the data, the staler it is allowed to be.`,
    "",
    ...paths.map(
      (p) => `${p.n}. **${p.title}** \u2014 ${p.latency}, ${p.consistency}. For ${p.use}. ${p.inside ? "Inside the scope boundary" : "Outside the scope boundary"}: ${p.how}.`
    ),
    "",
    caption5
  ].join("\n");
}

// .vitepress/theme/components/ConnectorLoop.content.mts
var scope = {
  tag: "durable object",
  title: "Scope DO",
  sub: ["The operation committed;", "the event is in the outbox."],
  chip: "no fetch() here \u2014 the lint forbids it"
};
var runtime = {
  tag: "worker",
  title: "Connector runtime",
  sub: ["Opens the sealed credential", "for this tenant."],
  chip: "fetch bound to the connection \xB7 retry"
};
var provider = {
  tag: "outside the platform",
  title: "The provider",
  sub: "Scrive, Fortnox, a bank.",
  chip: "never sees a principal"
};
var arrows = {
  out: "delegates the delivery",
  back: "getConnectorScope()",
  send: "sends the document",
  callback: "the provider calls back"
};
var caption6 = "A provider\u2019s callback is not a person, so it cannot hold a principal. The connection itself is the subject: getConnectorScope opens a stub whose authority is that connection\u2019s own grants, narrowed by construction to one tenant and one vertical.";
function alt6() {
  return [
    "**Diagram \u2014 the connector round trip.** A delivery leaves the scope, crosses the platform boundary, and comes back in through a different door.",
    "",
    `1. **${scope.title}** (${scope.tag}) \u2014 ${scope.sub.join(" ")} ${scope.chip}.`,
    `2. It **${arrows.out}** up to the **${runtime.title}** (${runtime.tag}) \u2014 ${runtime.sub.join(" ")} ${runtime.chip}.`,
    `3. The runtime **${arrows.send}** to **${provider.title}** (${provider.tag}) \u2014 ${provider.sub} It ${provider.chip}.`,
    `4. Later, **${arrows.callback}**; the worker reopens the scope with \`${arrows.back}\` and writes the result back.`,
    "",
    caption6
  ].join("\n");
}

// ../../engines/booking/model.json
var model_default = {
  version: "0.0.1",
  entities: {
    reservation: {
      table: "booking_reservations",
      fields: {
        type: "object",
        properties: {
          id: {
            type: "string"
          },
          resource_id: {
            type: "string"
          },
          starts_at: {
            type: "string"
          },
          ends_at: {
            type: "string"
          },
          state: {
            type: "string",
            enum: [
              "held",
              "confirmed",
              "in_service",
              "completed",
              "expired",
              "cancelled",
              "no_show"
            ]
          },
          quantity: {
            type: "number"
          },
          expires_at: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          },
          fill_target: {
            anyOf: [
              {
                type: "number"
              },
              {
                type: "null"
              }
            ]
          },
          note: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          },
          created_by: {
            type: "string"
          },
          created_at: {
            type: "string"
          }
        },
        required: [
          "id",
          "resource_id",
          "starts_at",
          "ends_at",
          "state",
          "quantity",
          "expires_at",
          "fill_target",
          "note",
          "created_by",
          "created_at"
        ],
        additionalProperties: false
      },
      parents: [
        "resource"
      ]
    },
    resource: {
      table: "booking_resources",
      fields: {
        type: "object",
        properties: {
          id: {
            type: "string"
          },
          kind: {
            type: "string"
          },
          name: {
            type: "string"
          },
          capacity: {
            type: "number"
          },
          active: {
            type: "number"
          },
          created_at: {
            type: "string"
          }
        },
        required: [
          "id",
          "kind",
          "name",
          "capacity",
          "active",
          "created_at"
        ],
        additionalProperties: false
      }
    }
  },
  lifecycles: {
    reservation: {
      field: "state",
      initial: "held",
      states: {
        cancelled: {
          terminal: true
        },
        completed: {
          terminal: true
        },
        confirmed: {
          on: {
            "booking/cancel": "cancelled",
            "booking/complete": "completed",
            "booking/no-show": "no_show",
            "booking/start": "in_service"
          },
          allow: [
            "booking/join",
            "booking/move",
            "booking/open"
          ]
        },
        expired: {
          terminal: true
        },
        held: {
          on: {
            "booking/cancel": "cancelled",
            "booking/confirm": "confirmed",
            "booking/expire": "expired"
          },
          allow: [
            "booking/join",
            "booking/move",
            "booking/open"
          ]
        },
        in_service: {
          on: {
            "booking/complete": "completed",
            "booking/no-show": "no_show"
          }
        },
        no_show: {
          terminal: true
        }
      }
    }
  }
};

// ../../engines/invoicing/model.json
var model_default2 = {
  version: "0.0.1",
  entities: {
    underlag: {
      table: "invoicing_underlag",
      fields: {
        type: "object",
        properties: {
          id: {
            type: "string"
          },
          number: {
            type: "number"
          },
          customer_type: {
            type: "string"
          },
          customer_id: {
            type: "string"
          },
          status: {
            type: "string",
            enum: [
              "open",
              "exported"
            ]
          },
          created_at: {
            type: "string"
          },
          exported_at: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          }
        },
        required: [
          "id",
          "number",
          "customer_type",
          "customer_id",
          "status",
          "created_at",
          "exported_at"
        ],
        additionalProperties: false
      }
    }
  },
  lifecycles: {
    underlag: {
      field: "status",
      initial: "open",
      states: {
        exported: {
          terminal: true
        },
        open: {
          on: {
            "invoicing/export": "exported"
          }
        }
      }
    }
  }
};

// ../../engines/workorder/model.json
var model_default3 = {
  version: "0.0.1",
  entities: {
    workorder: {
      table: "workorder_orders",
      fields: {
        type: "object",
        properties: {
          id: {
            type: "string"
          },
          number: {
            type: "number"
          },
          facility_type: {
            type: "string"
          },
          facility_id: {
            type: "string"
          },
          customer_type: {
            type: "string"
          },
          customer_id: {
            type: "string"
          },
          kind: {
            type: "string"
          },
          title: {
            type: "string"
          },
          description: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          },
          status: {
            type: "string",
            enum: [
              "planned",
              "in_progress",
              "completed",
              "closed"
            ]
          },
          assigned_to: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          },
          created_by: {
            type: "string"
          },
          created_at: {
            type: "string"
          },
          completed_at: {
            anyOf: [
              {
                type: "string"
              },
              {
                type: "null"
              }
            ]
          }
        },
        required: [
          "id",
          "number",
          "facility_type",
          "facility_id",
          "customer_type",
          "customer_id",
          "kind",
          "title",
          "description",
          "status",
          "assigned_to",
          "created_by",
          "created_at",
          "completed_at"
        ],
        additionalProperties: false
      }
    }
  },
  lifecycles: {
    workorder: {
      field: "status",
      initial: "planned",
      states: {
        closed: {
          terminal: true
        },
        completed: {
          on: {
            "workorder/close": "closed"
          }
        },
        in_progress: {
          on: {
            "workorder/complete": "completed"
          },
          allow: [
            "workorder/report-material",
            "workorder/report-time"
          ],
          extensible: true
        },
        planned: {
          on: {
            "workorder/start": "in_progress"
          },
          allow: [
            "workorder/assign",
            "workorder/report-material",
            "workorder/report-time"
          ]
        }
      }
    }
  }
};

// .vitepress/theme/components/state-machine.mts
function fromModel(model, entity) {
  const machine = model.lifecycles?.[entity];
  if (!machine) throw new Error(`model.json declares no lifecycle for '${entity}'`);
  return machine;
}
var verb = (operationId) => operationId.includes("/") ? operationId.slice(operationId.indexOf("/") + 1) : operationId;
var edgesOf = (m) => Object.entries(m.states).flatMap(
  ([from, s]) => Object.entries(s.on ?? {}).map(([op, to]) => ({ from, to, op }))
);
function longestPath(m, edges2) {
  const walk = (at, seen) => {
    const next = edges2.filter((e) => e.from === at && !seen.includes(e.to)).map((e) => walk(e.to, [...seen, e.to]));
    return next.reduce((best, p) => p.length > best.length ? p : best, []).length ? [at, ...next.reduce((b, p) => p.length > b.length ? p : b, [])] : [at];
  };
  return walk(m.initial, [m.initial]);
}
function layout(m) {
  const edges2 = edgesOf(m);
  const spine2 = longestPath(m, edges2);
  const onSpine = new Set(spine2);
  const spineEdges = [];
  for (let i = 0; i < spine2.length - 1; i++) {
    const e = edges2.find((x) => x.from === spine2[i] && x.to === spine2[i + 1]);
    if (e) spineEdges.push(e);
  }
  const rest = edges2.filter((e) => !spineEdges.includes(e));
  return {
    spine: spine2,
    spineEdges,
    branches: rest.filter((e) => !onSpine.has(e.to)),
    rejoins: rest.filter((e) => onSpine.has(e.to))
  };
}
function altFrom(m, title) {
  const l = layout(m);
  const lines = [
    `**Diagram \u2014 the ${title} state machine**, on \`${m.field}\`, starting at \`${m.initial}\`.`,
    "",
    `- **The main run:** ${l.spine.map((s, i) => i === 0 ? `\`${s}\`` : `\u2192 *${verb(l.spineEdges[i - 1].op)}* \u2192 \`${s}\``).join(" ")}`
  ];
  for (const e of l.branches) {
    lines.push(`- **Leaves the run:** \`${e.from}\` \u2192 *${verb(e.op)}* \u2192 \`${e.to}\`.`);
  }
  for (const e of l.rejoins) {
    lines.push(`- **Rejoins:** \`${e.from}\` \u2192 *${verb(e.op)}* \u2192 \`${e.to}\`.`);
  }
  const allowed = Object.entries(m.states).filter(([, s]) => s.allow?.length).map(([name, s]) => `\`${name}\` admits ${s.allow.map((o) => `*${verb(o)}*`).join(", ")}`);
  if (allowed.length) {
    lines.push("", `**Permitted without moving:** ${allowed.join("; ")}.`);
  }
  const terminal = Object.entries(m.states).filter(([, s]) => s.terminal).map(([n]) => `\`${n}\``);
  if (terminal.length) lines.push(`**Terminal:** ${terminal.join(", ")}.`);
  lines.push(
    "",
    'An operation the machine has never heard of is not forbidden \u2014 it is not governed. Absence means "no state gates this", never "denied".'
  );
  return lines.join("\n");
}

// .vitepress/theme/components/StateMachine.content.mts
var absence = {
  field: "status",
  initial: "requested",
  states: {
    requested: {
      on: {
        "absence/approve": "approved",
        "absence/reject": "rejected",
        "absence/cancel": "cancelled"
      }
    },
    approved: { on: { "absence/cancel": "cancelled" } },
    rejected: { terminal: true },
    cancelled: { terminal: true }
  }
};
var protocol = {
  field: "status",
  initial: "open",
  states: {
    open: {
      on: {
        "protocol/request-signatures": "pending_signature",
        "protocol/sign": "signed",
        "protocol/void": "voided"
      }
    },
    pending_signature: {
      on: {
        "protocol/complete-signing": "signed",
        "protocol/cancel-signature-requests": "open",
        "protocol/void": "voided"
      }
    },
    signed: { on: { "protocol/void": "voided" } },
    voided: { terminal: true }
  }
};
var invites = {
  field: "state",
  initial: "invited",
  states: {
    invited: {
      on: {
        "invites/accept": "accepted",
        "invites/revoke": "revoked",
        "invites/expire": "expired"
      }
    },
    accepted: { terminal: true },
    revoked: { terminal: true },
    expired: { terminal: true }
  }
};
var DIAGRAMS = {
  workorder: { entity: "workorder", machine: fromModel(model_default3, "workorder"), declared: true },
  booking: { entity: "reservation", machine: fromModel(model_default, "reservation"), declared: true },
  invoicing: { entity: "underlag", machine: fromModel(model_default2, "underlag"), declared: true },
  absence: { entity: "absence request", machine: absence, declared: false },
  protocol: { entity: "protocol", machine: protocol, declared: false },
  invites: { entity: "invitation", machine: invites, declared: false }
};
function diagramFor(engine) {
  const d = DIAGRAMS[engine];
  if (!d) throw new Error(`no state machine registered for engine '${engine}'`);
  return d;
}
var emittedNote = "Drawn from the engine\u2019s declared lifecycle in model.json \u2014 the same artifact lint:model --check gates, so this picture cannot drift from the code.";
var transcribedNote = "This engine declares no lifecycle yet, so the machine above is transcribed from its status enum and guard clauses. Nothing re-checks it \u2014 treat it as documentation, not as the contract.";
function alt7(props) {
  const d = diagramFor(props.engine ?? "");
  return [
    altFrom(d.machine, d.entity),
    "",
    d.declared ? emittedNote : transcribedNote
  ].join("\n");
}

// .vitepress/theme/components/LayerStack.content.mts
var verticals = {
  name: "Verticals",
  role: "Everything a user touches \u2014 the businesses themselves.",
  owner: "own vocabulary \xB7 screens \xB7 pricing \xB7 roles",
  chips: [
    ["Handlebar", "bike workshop"],
    ["Kallk\xE4lla", "coffee shop"],
    ["Meridian", "HR"],
    ["Manyfold", "headless CMS"]
  ]
};
var engines = {
  name: "Engines",
  role: "Headless domain machinery that owns invariants. Star topology \u2014 they talk to the kernel, never to each other.",
  owner: "own invariants \xB7 versioned \xB7 never forked",
  chips: [
    ["workorder", "one state machine \xB7 append-only time + material"],
    ["booking", "resource \xD7 interval \xD7 capacity \xB7 one allocation, no locks"],
    ["invoicing", "consumes billable events \xB7 immutable once exported"],
    ["protocol", "checklists + signed docs \xB7 freeze \u2192 immutable, hashed"],
    ["invites", "hashed identifier \xB7 accept-required \xB7 non-enumerable"],
    ["notifications", "preferences + delivery records \xB7 email via platform intent"],
    ["assistant", "thread record + run lease + exact-input approval \xB7 host integration pending"]
  ]
};
var adapters = {
  name: "Adapters",
  role: "Scope hosts \u2014 the interchangeable ground the kernel is seated on.",
  owner: "swappable \xB7 escrowable \xB7 self-hostable",
  chips: [
    ["adapter-sqlite", "dev \xB7 CI \xB7 self-host / escrow"],
    ["adapter-cloudflare", "production \xB7 Durable-Object per scope"],
    ["adapter-email", "notification transport \xB7 CF Email + mock"]
  ]
};
var connectors = {
  name: "Connectors",
  role: "The outside world, at the edges. React to events on the spine \u2014 host code, never module code.",
  owner: "no fetch inside a module \u2014 ever",
  chips: [
    ["Scrive eSign", "signatures-requested \u2192 BankID signing \u2192 recorded back"],
    ["\u2026more", "one port per capability"]
  ]
};
var kernel = {
  name: "Kernel",
  role: "The substrate. Everything true of <em>every</em> B2B SaaS \u2014 and nothing true of any one.",
  owner: "owns no domain entities",
  bits: [
    "Identity",
    "Nested tenancy",
    "Permissions + grants",
    "Events / audit spine",
    "Migrations",
    "GDPR machinery",
    "Email intents",
    "Jobs",
    "Billing entitlements",
    "Module system",
    "Attachment contracts",
    "App shell"
  ],
  ctxLabel: "Every operation runs inside",
  ctx: ["ctx.sql", "ctx.check", "ctx.emit", "ctx.link"],
  note: "No customer table, no work-order table. It offers attachment contracts that bind to opaque (entityType, entityId) refs the vertical defines."
};
var theLine = {
  label: "the line",
  above: "AI velocity \u2014 mistakes are cosmetic (a wrong screen)",
  below: "humans + runtime guarantees \u2014 mistakes are catastrophic (a tenant leak)"
};
var seams = {
  verticalToEngine: "composes engines in-scope, same transaction",
  engineToKernel: "<b>&darr;</b> ctx (sql \xB7 check \xB7 emit \xB7 link) &nbsp;\xB7&nbsp; events + audit <b>&uarr;</b>",
  kernelToAdapter: "same kernel semantics on any ground \u2014 one contract-test suite gates them all"
};
var lawsHead = "The four rules that hold it together";
var laws = [
  ["Kernel owns no domain entities.", "It provides the spine; verticals define what the entities mean."],
  ["Star topology.", "Engines cooperate through fat events and opaque refs \u2014 never by importing each other. N contracts, not N\xB2."],
  ["Enforced at runtime.", "Guarantees are defaults of the substrate, not config a builder \u2014 human or AI \u2014 can get wrong."],
  ["No forking.", "If a vertical ever needs to fork an engine, the engine drew its line wrong."]
];
var plain = (html) => html.replace(/<\/?(em|b|code)>/g, "").replace(/&nbsp;/g, " ").replace(/&darr;/g, "\u2193").replace(/&uarr;/g, "\u2191").replace(/\s+/g, " ").trim();
var band = (layer) => `- **${layer.name}** \u2014 ${plain(layer.role)} *(${layer.owner})*
` + layer.chips.map(([name, sub]) => `  - \`${name}\` \u2014 ${sub}`).join("\n");
function alt8() {
  return [
    "**Diagram \u2014 the three-layer stack.** Six bands, top to bottom: verticals, the line, engines, the kernel, the adapters under it, and connectors at the edge.",
    "",
    band(verticals),
    `- **The line.** Above: ${theLine.above}. Below: ${theLine.below}.`,
    `  - Verticals meet engines by: ${plain(seams.verticalToEngine)}.`,
    band(engines),
    `  - Engines meet the kernel by: ${plain(seams.engineToKernel)}.`,
    `- **${kernel.name}** \u2014 ${plain(kernel.role)} *(${kernel.owner})*
  - Provides: ${kernel.bits.join(", ")}.
  - ${kernel.ctxLabel}: ${kernel.ctx.map((c) => `\`${c}\``).join(", ")}.
  - ${kernel.note}`,
    `  - Kernel meets the adapters by: ${plain(seams.kernelToAdapter)}.`,
    band(adapters),
    band(connectors),
    "",
    `**${lawsHead}**`,
    "",
    laws.map(([head2, body], i) => `${i + 1}. **${head2}** ${body}`).join("\n")
  ].join("\n");
}

// .vitepress/theme/components/RuntimeTopology.content.mts
var headings = {
  flow: "How a request travels",
  dbs: "The three databases",
  provisioning: "How the databases get created"
};
var steps = [
  {
    n: 1,
    kind: "edge",
    title: "Browser hits a hostname",
    body: "A tenant, a vertical, and a surface \u2014 all encoded in the name.",
    mono: "acme.ticket0.substrat.run"
  },
  {
    n: 2,
    kind: "router",
    title: "The router resolves the door",
    body: "One kernel-owned worker in front of every vertical. Its only binding is the control plane \u2014 it reads the directory to turn hostname \u2192 (tenant, scope, vertical, surface). It finds the door; it cannot open a scope even by mistake.",
    touches: "cp"
  },
  {
    n: 3,
    kind: "compute",
    title: "Header handshake, then dispatch",
    body: "Every client x-substrat-* header is stripped; the router asserts the resolved node plus a shared secret, then dispatches to the vertical worker. The vertical has no public route \u2014 the router is the only way in."
  },
  {
    n: 4,
    kind: "compute",
    title: "Vertical worker resolves who you are",
    body: "The vertical worker holds no state between requests. It resolves your session to a principal in the tenant\u2019s own identity database.",
    touches: "id"
  },
  {
    n: 5,
    kind: "compute",
    title: "Open the scope, run the operation",
    body: "Gate the scope\u2019s lifecycle & tenancy, then invoke() runs the operation inside the scope\u2019s own SQLite, in one transaction \u2014 permission check first, mutation emits an event, the outbox drains to consumers and connectors. Roll back on any throw.",
    touches: "sc"
  },
  {
    n: 6,
    kind: "edge",
    title: "Response travels back up",
    body: "Back through the router, the one place that knows the tenant \u2014 so it meters the request there, one datapoint per call."
  }
];
var dbs = [
  {
    key: "cp",
    card: "Directory",
    name: "Control-plane DB",
    count: "one per environment",
    items: ["Tenant registry & scope lifecycle", "Roles, tenant grants, entitlements", "Hostnames, verticals & versions", "Connections (ciphertext only)", "The admin audit log"],
    tag: "Knows which door \u2014 never what\u2019s behind it. A single singleton DO."
  },
  {
    key: "id",
    card: "Application / auth",
    name: "Identity DB",
    count: "one per tenant",
    items: ["Users, sessions, credentials", "Its own auth engine, own SQLite", "The login \u2192 principal map", "The owner seat, set at provision"],
    tag: "Separate DO, separate storage \u2014 one tenant\u2019s users can\u2019t leak to another."
  },
  {
    key: "sc",
    card: "Business data",
    name: "Scope DB",
    count: "one per scope",
    items: ["The vertical\u2019s entities & kernel spine", "Events, outbox, entity links", "Applied migrations", "Scope-level grants & permissions"],
    tag: "Where ctx.sql runs \u2014 one transaction per operation."
  }
];
var touchLabel = {
  cp: "reads \u2192 Control-plane DB",
  id: "reads \u2192 Identity DB (this tenant)",
  sc: "reads + writes \u2192 Scope DB (this scope)"
};
var kindLabel = {
  edge: "edge",
  router: "kernel worker \xB7 1 per env",
  compute: "compute"
};
var provKey = "The trick: <b>a Durable Object\u2019s database springs into existence the first time you address it by id.</b> There is no <code>CREATE DATABASE</code> and no migration server \u2014 provisioning is just addressing a new DO and letting it build itself.";
var prov = [
  ["Write the directory row.", "The coordinator records the new scope in the control plane \u2014 the door now exists, gated by the tenant."],
  ["Address the Scope DO.", "The moment it\u2019s named, its SQLite is born. A lazy migration builds the kernel spine and runs the vertical\u2019s own module migrations in order \u2014 a PITR bookmark taken before each pass."],
  ["Project permissions in.", "The tenant\u2019s current roles and grants are copied into the fresh scope so it can decide access from its own storage \u2014 then the migration frontier is recorded back to the directory."],
  ["Identity DB, likewise.", "The tenant\u2019s Identity DO is created on first address \u2014 tables on construction, the owner seat set at provision, waiting to be claimed by the first login."]
];
var isolation = {
  head: "Why the shared control plane isn\u2019t a shared blast radius",
  paragraphs: [
    "A normal vertical runs <b>\u201CCP-less\u201D on the hot path</b>: it decides permissions from the scope\u2019s <em>own</em> storage and trusts the node the router asserted \u2014 the shared control plane is <b>off the request path entirely</b>. It still owns provisioning and the audit spine, but a request serving one tenant never touches another tenant\u2019s data, or the shared directory, to answer.",
    "The result: the same kernel guarantees, a per-tenant database, and a shared control plane whose failure can\u2019t read or corrupt a running scope. <b>Isolation is the default, not a configuration you can forget.</b>"
  ]
};
var residency = {
  intro: "One bundle, two execution environments. The worker is trusted with addressing and never with data; the scope holds the data and cannot reach the network.",
  worker: [
    { dot: "k", title: "Kernel host", detail: "getScope() \xB7 permission gate \xB7 metering" },
    { dot: "v", title: "Vertical HTTP", detail: "routes, error envelope, session \u2192 principal" },
    { dot: "v", title: "Connector code", detail: "the only place fetch() is allowed to exist" }
  ],
  scope: [
    { dot: "v", text: "Vertical operations \u2014 ctx.check(), then ctx.sql" },
    { dot: "e", text: "Engine functions \u2014 the same transaction" },
    { dot: "k", text: "Kernel spine \u2014 events, outbox, links, migrations" }
  ]
};
var plain2 = (html) => html.replace(/<\/?(b|em|code)>/g, "");
function alt9() {
  const flow = steps.map((s) => {
    const detail = [
      s.mono ? `\`${s.mono}\`` : "",
      s.touches ? `_${touchLabel[s.touches]}_` : ""
    ].filter(Boolean);
    return `${s.n}. **${s.title}** (${kindLabel[s.kind]}) \u2014 ${s.body}` + (detail.length ? `
   ${detail.join(" \xB7 ")}` : "");
  });
  const stores = dbs.map(
    (d) => `- **${d.name}** (${d.card}, ${d.count}) \u2014 ${d.items.join("; ")}. ${d.tag}`
  );
  const provisioning = prov.map(([head2, body], i) => `${i + 1}. **${head2}** ${body}`);
  const where = [
    `- **The vertical worker** runs: ` + residency.worker.map((p) => `${p.title} (${p.detail})`).join("; ") + ".",
    `- **The Scope DO** runs: ` + residency.scope.map((r) => r.text).join("; ") + "."
  ];
  return [
    "**Diagram \u2014 the hosted runtime topology.** Every box is a Durable Object with its own SQLite; the router\u2019s only job is to find the right door. The request descends browser \u2192 router \u2192 worker \u2192 scope, and the response returns the same way, metered at the router.",
    "",
    residency.intro,
    "",
    ...where,
    "",
    `**${headings.flow}**`,
    "",
    ...flow,
    "",
    `**${headings.dbs}**`,
    "",
    ...stores,
    "",
    `**${headings.provisioning}**`,
    "",
    plain2(provKey),
    "",
    ...provisioning,
    "",
    `**${isolation.head}**`,
    "",
    ...isolation.paragraphs.map(plain2)
  ].join("\n");
}

// .vitepress/theme/components/ScopeTopology.content.mts
var vertical = {
  tag: "your code",
  title: "Vertical",
  sub: "TypeScript \xB7 often AI-built"
};
var toHost = "@substrat-run/kernel API only";
var host = {
  tag: "kernel",
  title: "Scope host",
  mono: "getScope(principal, tenant, scope)"
};
var toScopes = "holding a stub is the authorization";
var scopes2 = [
  {
    tag: "one isolation domain",
    title: "Scope \xB7 branch #1",
    sub: ["its own database + ACL", "serialized \u2014 one op at a time"]
  },
  {
    tag: "one isolation domain",
    title: "Scope \xB7 branch #240",
    sub: ["its own database + ACL", "serialized \u2014 one op at a time"]
  }
];
var toSpine = "events, kernel-stamped";
var spine = {
  tag: "kernel-owned",
  title: "Event spine",
  sub: "audit \xB7 reporting \xB7 integrations"
};
var caption7 = "The same shape on every adapter \u2014 one SQLite file per scope locally, one Durable Object per scope in production. Nothing above the stub can widen its own reach.";
function alt10() {
  return [
    "**Diagram \u2014 the topology, adapter-neutral.** Vertical code reaches data one way, and every scope feeds one spine.",
    "",
    `1. **${vertical.title}** (${vertical.tag}, ${vertical.sub}) reaches the host by **${toHost}**.`,
    `2. **${host.title}** (${host.tag}) \u2014 \`${host.mono}\` returns a capability stub. ${toScopes}.`,
    `3. Each scope is ${scopes2[0].sub.join(", ")} \u2014 drawn here as ${scopes2.map((s) => s.title).join(" and ")}, but there are as many as the tenant has.`,
    `4. Every scope emits **${toSpine}** into the **${spine.title}** (${spine.tag}): ${spine.sub}.`,
    "",
    caption7
  ].join("\n");
}

// .vitepress/theme/components/BlastRadius.content.mts
var above = {
  name: "What an agent writes",
  verdict: "Mistakes are cosmetic",
  chips: ["screens", "forms", "workflows", "reports", "pricing", "vocabulary"]
};
var below = {
  name: "What the substrate owns",
  verdict: "Mistakes are catastrophic",
  chips: ["tenancy", "auth", "migrations", "integrations", "audit", "compliance"]
};
var caption8 = 'The layer where models are weakest is the layer where mistakes are fatal. So the split is structural rather than instructional: prompting a model to "be careful with tenancy" is a suggestion, and a `getScope` call that fails closed on a mismatched pair is a fact.';
var captionHtml = caption8.replace(/`([^`]+)`/g, "<code>$1</code>");
function alt11() {
  const side = (s) => `- **${s.name}** \u2014 ${s.verdict.toLowerCase()}: ${s.chips.join(", ")}.`;
  return [
    "**Diagram \u2014 the line.** Two bands either side of one boundary.",
    "",
    side(above),
    `- **${theLine.label}.** Above: ${theLine.above}. Below: ${theLine.below}.`,
    side(below),
    "",
    caption8
  ].join("\n");
}

// .vitepress/theme/components/GuardPath.content.mts
var guards = [
  {
    when: "Compile",
    title: "Invalid states don't typecheck",
    body: "A narrow, aggressively typed SDK means a small hallucination surface. A <code>ScopeId</code> will not typecheck where a <code>TenantId</code> is expected, so an agent cannot swap them silently. A permission <code>Decision</code> is either <code>{ allowed: true, proof }</code> or <code>{ allowed: false, checked, node }</code> \u2014 an unexplained allow is unrepresentable. An event without a <code>piiClass</code> doesn't parse, and a PII-classed event without a <code>subjectId</code> doesn't either.",
    stops: "ID confusion, silent allows, unclassified personal data."
  },
  {
    when: "Bound",
    title: "The shortcut is told apart from the sanctioned path",
    body: "Most guardrails fail loud. The layer rules are the ones that fail <em>silently</em> \u2014 a raw <code>SELECT</code> against an engine's private table returns the right rows, the test passes, and nothing tells you that engine can now never ship a migration. <code>boundary-lint</code> is the only thing that can see it.",
    stops: "Raw DB access, cross-module reads, forged audit rows, ambient secrets."
  },
  {
    when: "Derive",
    title: "What can be derived is never generated",
    body: "Wherever an artifact can be <em>derived</em>, it is derived by code, not by a model. Entities are declared once; the DDL, the API surface, the browser client and the permission table are emitted from that declaration, and CI re-emits each and fails on drift. Code generated by code beats code generated by a model on tokens, latency and exactness at once.",
    stops: "Hand-edits to shipped SQL, drifted clients, a widened role merging unseen."
  },
  {
    when: "Judge",
    title: "The build may not edit its own oracle",
    body: "Models fail quietly and inconsistently rather than loudly, and you cannot prompt that away \u2014 so the architecture has to catch it. Every defect worth catching is two descriptions disagreeing. Once the code is derived from the model it can no longer contradict it, so the second description has to come from somewhere else entirely.",
    stops: "A suite that ratifies a wrong model perfectly and forever."
  },
  {
    when: "Review",
    title: "Two things an agent never self-approves",
    body: "Schema migrations and permission definitions stay under human review even in a fully agent-driven shop. Both are read as a diff, and CI re-emits the artifact and fails on drift \u2014 which is what makes the reading unskippable. The red build is not the approval; it is what stops the approval being skipped.",
    stops: "A destructive migration or a quietly widened role reaching main."
  },
  {
    when: "Rehearse",
    title: "A running copy of production to be wrong in",
    body: "Reviewing a migration diff is a checkpoint. Watching that migration run against a copy of the real data is what makes the checkpoint honest. Crossing a migration-digest boundary snapshots the prior state first \u2014 the digest comparison is the gate, not a flag someone remembers to pass.",
    stops: "Version 2 landing on version 1's live data."
  }
];
var head = {
  label: "the path",
  lede: "Six guards, in the order they fire."
};
var plain3 = (html) => html.replace(/<code>([^<]*)<\/code>/g, "`$1`").replace(/<em>([^<]*)<\/em>/g, "*$1*").replace(/<(?:b|strong)>([^<]*)<\/(?:b|strong)>/g, "**$1**").replace(/\s+/g, " ").trim();
function alt12() {
  return [
    `**Diagram \u2014 ${head.label}.** ${head.lede} Each stage can stop a change, and the claim is that a mistake surviving one meets the next.`,
    "",
    ...guards.map(
      (g, i) => `${i + 1}. **${g.when} \u2014 ${g.title}.** ${plain3(g.body)}
   - *Stops:* ${g.stops}`
    )
  ].join("\n");
}

// .vitepress/theme/components/SignupForm.content.mts
function alt13(props) {
  const waitlist = (props.kind ?? "waitlist") === "waitlist";
  const what = waitlist ? "a place on the waiting list for the Substrat private beta" : "the weekly changelog by email";
  return `*(On the web page, a form here asks for an email address \u2014 and, for the waiting list, an optional note about what you would build \u2014 to request ${what}. Signing up is double opt-in: submitting sends one confirmation email and nothing is added to any list until the link in it is clicked. Every message after that carries an unsubscribe link \u2014 though the first issue of the changelog email has not been sent yet, so confirming puts you on the list rather than starting a delivery. The form posts to Substrat's own ticket0 support desk at ${props.desk ?? "https://ticket0.substrat.net"}, which only accepts signups from pages it lists as allowed origins.)*`;
}

// .vitepress/theme/components/CommunicationFlow.content.mts
var flows = {
  live: {
    title: "One change \xB7 a checked re-read",
    aria: "An operation commits a change in the scope. The live feed checks the subscriber and sends a change hint, without the row content. The browser calls its ordinary read operation again, which checks current permissions before returning data. Polling remains the fallback.",
    steps: [
      {
        owner: "SCOPE \xB7 COMMITTED WRITE",
        title: "A record changes",
        layer: "vertical",
        lines: ["The operation writes and emits.", "A live target declares the read key."]
      },
      {
        owner: "HOST \xB7 LIVE FEED",
        title: "Check, then send a hint",
        layer: "kernel",
        lines: ["Check access before sending a frame.", "The frame carries no row content."]
      },
      {
        owner: "BROWSER \xB7 ORDINARY READ",
        title: "Ask for the current data",
        layer: "vertical",
        lines: ["Re-read through the usual operation.", "Current permissions decide the answer."]
      }
    ],
    edges: ["committed activity wakes the feed", "a hint asks the screen to refresh"],
    caption: "Push reduces the wait; polling remains the recovery path. A frame can be one permission evaluation stale. The read it triggers checks access again. This is invalidation, not offline sync or presence."
  },
  peer: {
    title: "One peer call \xB7 one tenant",
    aria: "The board-room host declares it calls the CRM. The platform proves the calling app and resolves the target in the same tenant. The CRM admits the peer, checks its permissions and runs its own transaction. The result returns to the calling host.",
    steps: [
      {
        owner: "CALLER \xB7 BOARD-ROOM HOST",
        title: "Ask for current customer details",
        layer: "vertical",
        lines: ["Declares: calls acme/crm", "Invokes: customer/get"]
      },
      {
        owner: "PLATFORM \xB7 IDENTITY AND ROUTING",
        title: "Prove who calls; find the target",
        layer: "kernel",
        lines: ["Caller identity comes from the dispatch.", "Target is in the same tenant."]
      },
      {
        owner: "TARGET \xB7 CRM SCOPE",
        title: "Admit, check, then run",
        layer: "vertical",
        lines: ["CRM declares the peer and its operations.", "Its checks and transaction run here."]
      }
    ],
    edges: ["platform-asserted app identity", "request enters through the peer door"],
    caption: "The result returns to the host. Each scope keeps its own transaction. Module code queues a platform intent instead of making this synchronous call."
  },
  events: {
    title: "One exported fact \xB7 two commits",
    aria: "The CRM commits its row and event together. The platform reads allowed exports after the board-room\u2019s saved watermark. The board-room commits each handler\u2019s writes with its delivery record, then advances its watermark. A paused edge holds the watermark.",
    steps: [
      {
        owner: "PRODUCER \xB7 CRM DATABASE",
        title: "Commit the fact",
        layer: "vertical",
        lines: ["Customer row + event commit together.", "The event stays in the CRM outbox."]
      },
      {
        owner: "PLATFORM \xB7 PULL AND DELIVER",
        title: "Read after the saved watermark",
        layer: "kernel",
        lines: ["Export \u2229 import, with checks on both sides.", "Only the agreed version and PII class none."]
      },
      {
        owner: "CONSUMER \xB7 BOARD-ROOM DATABASE",
        title: "Apply, record, then advance",
        layer: "vertical",
        lines: ["Handler writes + delivery row commit together.", "Watermark advances after the batch."]
      }
    ],
    edges: ["kick for speed \xB7 sweep as backstop", "separate transaction in the receiver"],
    caption: "The consumer owns the bookmark. Pause holds it. Restore rewinds it with the data. Ordinary redelivery skips recorded deliveries; explicit replay runs handlers again."
  },
  notifications: {
    title: "One notification \xB7 three responsibilities",
    aria: "The vertical names the occasion and recipients. The notifications engine applies preferences and records the delivery with an email intent in the same transaction. After commit the platform sends mail and emits an outcome that settles the delivery.",
    steps: [
      {
        owner: "VERTICAL \xB7 BUSINESS MEANING",
        title: "A repair was assigned",
        layer: "vertical",
        lines: ["Choose topic, recipients and wording.", "Use the event id as the occasion\u2019s key."]
      },
      {
        owner: "ENGINE \xB7 IN THE SAME TRANSACTION",
        title: "Decide and record the notification",
        layer: "engine",
        lines: ["Apply preferences; render the template.", "Delivery row + email intent commit together."]
      },
      {
        owner: "PLATFORM \xB7 AFTER COMMIT",
        title: "Send, then report the outcome",
        layer: "kernel",
        lines: ["Send through the configured mail provider.", "Sent, refused or dead-lettered settles the row."]
      }
    ],
    edges: ["notify(ctx, \u2026)", "commit ends the scope transaction"],
    caption: "A rollback leaves no send. A committed intent survives a crash. The delivery row is deduplicated, but a provider send can repeat if its outcome was lost."
  },
  assistant: {
    title: "One assistant turn \xB7 an approved change",
    aria: "A person starts a turn. The host acquires a run lease, calls a model outside the transaction and records events. A proposed change waits for the person\u2019s approval of exact input. The host must claim that approved call before executing and recording its result.",
    steps: [
      {
        owner: "PERSON \xB7 ASSISTANT:USE",
        title: "Start a turn",
        layer: "vertical",
        lines: ["Append the person\u2019s message.", "The engine opens a turn on their thread."]
      },
      {
        owner: "HOST \xB7 ASSISTANT:RUN",
        title: "Take the lease and run the model",
        layer: "engine",
        lines: ["One run may write at a time.", "Model calls happen outside transactions."]
      },
      {
        owner: "PERSON \xB7 EXACT APPROVAL",
        title: "Review the proposed change",
        layer: "vertical",
        lines: ["Digest binds input, operation and version.", "Deny or let it expire: no execution claim."]
      },
      {
        owner: "HOST \xB7 CHECK BEFORE EXECUTING",
        title: "Claim once, execute, record",
        layer: "engine",
        lines: ["Changed input or a second claim is refused.", "The target still checks its own permissions."]
      }
    ],
    edges: ["short engine calls record progress", "a gated tool call pauses for approval", "only the approved call may be claimed"],
    caption: "The engine records and gates the turn. The host runs it. The execution claim cannot make an external effect atomic with the conversation record. Host integration is still to come."
  }
};
function flowFor(kind) {
  const flow = flows[kind];
  if (!flow) throw new Error(`Unknown communication figure: ${kind}`);
  return flow;
}
function alt14(props) {
  const flow = flowFor(props.kind ?? "peer");
  return [
    `**Diagram \u2014 ${flow.title}.**`,
    "",
    ...flow.steps.flatMap((step, i) => [
      `${i + 1}. **${step.title}** (${step.owner}). ${step.lines.join(" ")}`,
      ...flow.edges[i] ? [`   Then: ${flow.edges[i]}.`] : []
    ]),
    "",
    flow.caption
  ].join("\n");
}

// .vitepress/theme/components/alt.mts
var COMPONENT_ALT = {
  ConnectorLoop: alt6,
  ReadPaths: alt5,
  TenancyTree: alt4,
  InstanceResolution: alt3,
  PermissionPipeline: alt,
  ScopeDrain: alt2,
  LayerStack: alt8,
  RuntimeTopology: alt9,
  ScopeTopology: alt10,
  StateMachine: alt7,
  BlastRadius: alt11,
  GuardPath: alt12,
  SignupForm: alt13,
  CommunicationFlow: alt14
};
function altFor(component, props = {}) {
  return COMPONENT_ALT[component]?.(props) ?? null;
}

// .vitepress/llms.mts
var SITE = "https://substrat.net";
var TAGLINE = "The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.";
function kernelVersion(repoRoot) {
  const pkg = join2(repoRoot, "packages/kernel/package.json");
  return JSON.parse(readFileSync2(pkg, "utf8")).version;
}
function splitFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { frontmatter: "", body: raw };
  return { frontmatter: match[1], body: raw.slice(match[0].length) };
}
function frontmatterDescription(frontmatter) {
  const match = /^description:\s*(.+)$/m.exec(frontmatter);
  if (!match) return void 0;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}
function plainText(markdown) {
  return markdown.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1").replace(/\s+/g, " ").trim();
}
function describe(raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const declared = frontmatterDescription(frontmatter);
  if (declared) return declared;
  let paragraph = "";
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text2 = line.replace(/^\s*>\s?/, "");
    if (!text2.trim()) {
      if (paragraph) break;
      continue;
    }
    if (/^\s*(#|:::|\||[-*+]\s|\d+\.\s|<)/.test(text2)) {
      if (paragraph) break;
      continue;
    }
    paragraph += (paragraph ? " " : "") + text2.trim();
  }
  const text = plainText(paragraph);
  if (!text) return "";
  if (text.length <= 200) return text;
  const sentence = text.slice(0, 200).lastIndexOf(". ");
  if (sentence > 80) return text.slice(0, sentence + 1);
  const clause = text.slice(0, 200).lastIndexOf(" \u2014 ");
  if (clause > 80) return `${text.slice(0, clause)}\u2026`;
  return `${text.slice(0, text.slice(0, 200).lastIndexOf(" "))}\u2026`;
}
function twinUrl(link) {
  const [path, hash] = link.split("#");
  const suffix = hash ? `#${hash}` : "";
  if (/\.[a-z0-9]+$/i.test(path)) return `${SITE}${path}${suffix}`;
  return `${SITE}/${fileForLink(path)}${suffix}`;
}
var COMPONENT_LINE = /^<([A-Z]\w*)((?:\s+[a-z][\w-]*="[^"]*")*)\s*\/>$/;
function propsOf(attrs) {
  const out = {};
  for (const [, k, v] of attrs.matchAll(/([a-z][\w-]*)="([^"]*)"/g)) out[k] = v;
  return out;
}
var altTwin = (name, props) => altFor(name, props) ?? `*(Diagram: ${name} \u2014 rendered at the HTML page for this document.)*`;
function toTwin(raw, srcDir, component = altTwin) {
  const { body } = splitFrontmatter(raw);
  const out = [];
  let inFence = false;
  let inContainer = false;
  const push = (line) => {
    if (!inContainer) return out.push(line);
    return out.push(line.trim() ? `> ${line}` : ">");
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      push(line);
      continue;
    }
    if (inFence) {
      push(line);
      continue;
    }
    const pulled = pulledIn(line, srcDir);
    if (pulled) {
      for (const l of pulled) push(l);
      continue;
    }
    if (!inContainer) {
      const open = /^:::+\s*(\w[\w-]*)\s*(.*)$/.exec(line);
      if (open) {
        const [, type, title] = open;
        const label = type.charAt(0).toUpperCase() + type.slice(1);
        out.push("", `> **${label}${title.trim() ? ` \u2014 ${title.trim()}` : ""}**`, ">");
        inContainer = true;
        continue;
      }
    } else if (/^:::+\s*$/.test(line)) {
      inContainer = false;
      out.push("");
      continue;
    }
    const match = COMPONENT_LINE.exec(line.trim());
    if (match) {
      push(component(match[1], propsOf(match[2] ?? "")));
      continue;
    }
    push(line);
  }
  const unanchored = out.join("\n").replace(
    /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/g,
    (_m, href, text) => `[${text}](${href})`
  );
  const linked = unanchored.replace(
    /\]\((\/[^)\s]*)\)/g,
    (_m, link) => `](${twinUrl(link)})`
  );
  return `${collapseBlankRuns(linked).trimEnd()}
`;
}
var SNIPPET = /^<<<\s*(\S+?)(#[\w*-]+)?(?:\{([^}]*)\})?(?:\s+\[[^\]]*\])?\s*$/;
var INCLUDE = /^<!--@include:\s*(\S+?)(#[\w-]+)?(?:\{(\d*),(\d*)\})?\s*-->$/;
function pulledIn(line, srcDir) {
  if (!srcDir) return void 0;
  const directive = line.trim();
  const isSnippet = directive.startsWith("<<<");
  const isInclude = directive.startsWith("<!--@include:");
  if (!isSnippet && !isInclude) return void 0;
  const refuse = (why) => {
    throw new Error(
      `The llms twin cannot reproduce \`${directive}\`: ${why}.
Supported: \`<<< @/path[{lang}]\` and \`<!--@include: @/path[{from,to}]-->\`.`
    );
  };
  const fileOf = (path2, region2) => {
    if (region2) refuse(`\`${region2}\` selects a region, and the twin pulls whole files or line ranges only`);
    if (!path2.startsWith("@/")) refuse("the path must be `@/\u2026`, relative to the docs source directory");
    return resolve2(srcDir, path2.slice(2));
  };
  if (isSnippet) {
    const snippet = SNIPPET.exec(directive);
    if (!snippet) refuse("it is not a snippet import the twin can parse");
    const [, path2, region2, meta] = snippet;
    const file = fileOf(path2, region2);
    const lang = languageOf(meta) ?? extname(file).slice(1);
    return [`\`\`\`${lang}`, readFileSync2(file, "utf8").trimEnd(), "```"];
  }
  const include = INCLUDE.exec(directive);
  if (!include) refuse("it is not a markdown include the twin can parse");
  const [, path, region, fromText, toText] = include;
  const lines = readFileSync2(fileOf(path, region), "utf8").trimEnd().split("\n");
  const from = fromText ? Number(fromText) : 1;
  const to = toText ? Number(toText) : lines.length;
  return lines.slice(from - 1, to);
}
function languageOf(meta) {
  if (!meta) return void 0;
  const word = meta.split(/\s+/).filter(Boolean).find((token) => !/^[\d,-]+$/.test(token));
  const lang = word?.replace(/:(?:no-)?line-numbers(?:=\d+)?$/, "");
  return lang || void 0;
}
function collapseBlankRuns(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}
function titleOf(raw, fallback) {
  const { body } = splitFrontmatter(raw);
  const h1 = body.split("\n").find((l) => l.startsWith("# "));
  return h1 ? plainText(h1.slice(2)) : fallback;
}
function indexLabel(page) {
  return page.group ? `${page.group} \u203A ${page.text}` : page.text;
}
function buildArtifacts(srcDir, repoRoot) {
  const version = kernelVersion(repoRoot);
  const sections = tableOfContents();
  const artifacts = [];
  const missing = [];
  const pages = /* @__PURE__ */ new Map();
  for (const section of sections) {
    for (const page of section.pages) {
      const file = join2(srcDir, page.file);
      if (!existsSync2(file)) {
        missing.push(page.file);
        continue;
      }
      pages.set(page.link, { page, raw: readFileSync2(file, "utf8") });
    }
  }
  if (missing.length) {
    throw new Error(
      `The sidebar names ${missing.length} page(s) with no source file:
  ${missing.join("\n  ")}`
    );
  }
  if (!pages.has(START_HERE)) {
    throw new Error(
      `llms.txt promotes ${START_HERE} as the page to read first, but no sidebar entry points there. Update START_HERE in sidebar.mts, or restore the page.`
    );
  }
  for (const { page, raw } of pages.values()) {
    artifacts.push({ path: page.file, contents: toTwin(raw, srcDir) });
  }
  const index = [
    "# Substrat",
    "",
    `> ${TAGLINE}`,
    "",
    "## What Substrat is",
    "",
    "Substrat hosts the parts of a business application that are catastrophic to get wrong \u2014",
    "multi-tenancy, permissions, audit, migrations \u2014 and enforces them **at runtime**, in the",
    "platform. That is the whole distinction: a template hands you correct code once and every",
    "edit after erodes it, whereas here a vertical *cannot* query across tenants or skip a",
    "permission check, because the kernel will not serve the query.",
    "",
    "Three layers, and you write only the third:",
    "",
    "- **Kernel** \u2014 tenancy, permissions, events and audit, migrations. One **scope** is one",
    "  isolated SQLite database; there is no cross-tenant API to misuse.",
    "- **Engines** \u2014 headless, versioned packages owning domain invariants (work orders,",
    "  invoicing, bookings, protocols, invites, absence, metering). You either **compose** one",
    "  (import it; its in-scope functions run inside *your* transaction) or **feed** one (emit a",
    "  fat event; it consumes, with no import). Engines never import each other.",
    "- **Verticals** \u2014 the application: vocabulary, pricing, roles, screens. This is the layer",
    "  you own, and the only one an agent should be writing.",
    "",
    "A vertical is built by scaffolding one (`npm create substrat`) and reshaping the working",
    "reference vertical it ships into your domain. It runs locally against SQLite with no",
    "platform in the loop, and deploys to Cloudflare Durable Objects unchanged.",
    "",
    "That vocabulary \u2014 scope, engine, vertical, module, operation \u2014 is what the page titles",
    "below assume you already have.",
    "",
    "## Before you read",
    "",
    `These docs describe **@substrat-run/kernel ${version}**.`,
    "",
    `Substrat is pre-1.0 and interfaces change without notice, so a page cached from two`,
    `minors ago is the failure mode this file exists to prevent. Check the version you have`,
    "(`npm ls @substrat-run/kernel`, or the `@substrat-run/kernel` entry in your",
    "`package.json`) against the version above.",
    "",
    `- If they match, everything below describes your install.`,
    `- [\`${SITE}/llms-${version}.txt\`](${SITE}/llms-${version}.txt) is this same file, at a version-pinned URL. Fetching`,
    `  \`${SITE}/llms-<your-version>.txt\` returns 200 only while the published docs still`,
    "  describe your kernel; a 404 means they have moved on, and this file is the one to re-read.",
    "",
    "Every link below is **raw markdown**. Fetch those `.md` URLs directly \u2014 do not fetch the",
    "HTML page at the same path, which wraps the same prose in navigation and theme markup.",
    "",
    `Everything at once: [\`${SITE}/llms-full.txt\`](${SITE}/llms-full.txt).`,
    "",
    "## Start here",
    "",
    "If you are building on Substrat, read this one page before any other:",
    "",
    `- [**Agent rules**](${twinUrl(START_HERE)}): the always-on contract \u2014 the three layers,`,
    "  the ten non-negotiable module-code rules, the gates to run, and the two checkpoints you",
    "  may never self-approve. Most of what a generated vertical gets wrong is on that page,",
    "  and where it restates the summary above, that page is the authoritative one.",
    "",
    "The rest of this index is reference. Fetch from it as the task needs, rather than reading",
    "it through \u2014 the sections below are ordered for a person learning the platform, not for an",
    "agent with a job to do.",
    ""
  ];
  for (const section of sections) {
    index.push(`## ${section.text}`, "");
    for (const page of section.pages) {
      const { raw } = pages.get(page.link);
      const description = describe(raw);
      const url = twinUrl(page.link);
      index.push(`- [${indexLabel(page)}](${url})${description ? `: ${description}` : ""}`);
    }
    index.push("");
  }
  const indexText = `${index.join("\n").trimEnd()}
`;
  artifacts.push({ path: "llms.txt", contents: indexText });
  artifacts.push({ path: `llms-${version}.txt`, contents: indexText });
  const full = [
    "# Substrat \u2014 complete documentation",
    "",
    `> ${TAGLINE}`,
    "",
    `Describes **@substrat-run/kernel ${version}**. Index: ${SITE}/llms.txt`,
    ""
  ];
  for (const section of sections) {
    for (const page of section.pages) {
      const { raw } = pages.get(page.link);
      full.push("---", "", `# ${indexLabel(page)}`, "", `Source: ${twinUrl(page.link)}`, "");
      const twin = toTwin(raw, srcDir);
      const h1 = titleOf(raw, page.text);
      full.push(twin.replace(`# ${h1}
`, "").trimStart(), "");
    }
  }
  artifacts.push({ path: "llms-full.txt", contents: `${full.join("\n").trimEnd()}
` });
  const catalog = join2(repoRoot, ".claude-plugin", "marketplace.json");
  if (!existsSync2(catalog)) {
    throw new Error(
      `The plugin marketplace catalog is missing: ${catalog}
Users install the Substrat plugin from it; publishing the site without it breaks \`claude plugin marketplace add https://substrat.net/marketplace.json\`.`
    );
  }
  artifacts.push({ path: "marketplace.json", contents: readFileSync2(catalog, "utf8") });
  return artifacts;
}
function emitInto(outDir, artifacts) {
  for (const artifact of artifacts) {
    const target = resolve2(outDir, artifact.path);
    mkdirSync(dirname2(target), { recursive: true });
    writeFileSync(target, artifact.contents);
  }
}

// .vitepress/book.mts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join4 } from "node:path";
import MarkdownIt from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/markdown-it@14.3.3/node_modules/markdown-it/index.mjs";

// .vitepress/figures.mts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { createServer } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/vite@8.3.5_@types+node@26.6.3_esbuild@0.28.2_tsx@4.23.15_yaml@2.9.1/node_modules/vite/dist/node/index.js";
import vue from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/@vitejs+plugin-vue@6.0.10_vite@8.3.5_@types+node@26.6.3_esbuild@0.28.2_tsx@4.23.15_yaml_3b500bed2e3dee670aace009d0bd37e6/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import { createSSRApp } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/vue@3.5.44_typescript@7.0.2/node_modules/vue/index.mjs";
import { renderToString } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/vue@3.5.44_typescript@7.0.2/node_modules/vue/server-renderer/index.mjs";
function figureKey(name, props = {}) {
  const entries = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? name : `${name}?${JSON.stringify(entries)}`;
}
var componentOf = (key) => key.split("?")[0];
var componentFile = (name) => `/.vitepress/theme/components/${name}.vue`;
var XML_ENTITIES = {
  "&nbsp;": "\xA0",
  "&uarr;": "\u2191",
  "&darr;": "\u2193"
};
function toXhtml(html) {
  let out = html.replace(/\s+data-v-[0-9a-f]+(?=[\s/>])/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const [entity, char] of Object.entries(XML_ENTITIES)) {
    out = out.replaceAll(entity, char);
  }
  return out.replace(
    /<svg(?![^>]*\sxmlns=)/g,
    '<svg xmlns="http://www.w3.org/2000/svg"'
  );
}
async function renderFigures(srcDir, requests) {
  const wanted = /* @__PURE__ */ new Map();
  for (const request of requests) {
    wanted.set(figureKey(request.name, request.props), request);
  }
  const figures = /* @__PURE__ */ new Map();
  if (wanted.size === 0) return figures;
  const server = await createServer({
    root: srcDir,
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    // Nothing in this server is served to a browser, so crawling the graph for
    // dependencies to pre-bundle is work with no output.
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [vue()]
  });
  try {
    for (const [key, request] of wanted) {
      const module = await server.ssrLoadModule(componentFile(request.name));
      const html = await renderToString(
        createSSRApp(module.default, request.props)
      );
      figures.set(
        key,
        `<div class="figure figure--${request.name}">${toXhtml(html)}</div>`
      );
    }
  } finally {
    await server.close();
  }
  return figures;
}
function scopedStyle(srcDir, name) {
  const sfc = readFileSync3(
    join3(srcDir, ".vitepress/theme/components", `${name}.vue`),
    "utf8"
  );
  return [...sfc.matchAll(/<style scoped>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}
var NESTED_AT_RULES = /* @__PURE__ */ new Set(["media", "supports", "container", "layer"]);
function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}
function prefixSelector(selector, prefix) {
  const cleaned = selector.replace(/::v-deep\s*\(([^)]*)\)/g, "$1").replace(/:deep\s*\(([^)]*)\)/g, "$1").trim();
  return cleaned ? `${prefix} ${cleaned}` : prefix;
}
function scopeCss(css, prefix) {
  const source2 = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let prelude = "";
  let index = 0;
  const readBlock = () => {
    let depth = 0;
    const start = index;
    let quote = "";
    for (; index < source2.length; index += 1) {
      const char = source2[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          return source2.slice(start + 1, index - 1);
        }
      }
    }
    return source2.slice(start + 1);
  };
  while (index < source2.length) {
    const char = source2[index];
    if (char === "{") {
      const body = readBlock();
      const head2 = prelude.trim();
      prelude = "";
      if (head2.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(head2)?.[1] ?? "";
        out.push(
          NESTED_AT_RULES.has(name) ? `${head2} {
${scopeCss(body, prefix)}
}` : `${head2} {${body}}`
        );
      } else {
        const selectors = splitSelectors(head2).map((s) => prefixSelector(s, prefix)).join(", ");
        out.push(`${selectors} {${body}}`);
      }
      continue;
    }
    if (char === ";" && prelude.trim().startsWith("@")) {
      out.push(`${prelude.trim()};`);
      prelude = "";
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return out.join("\n");
}
var TOKEN_FILES = ["colors.css", "typography.css", "spacing.css", "effects.css"];
function tokenDeclarations(srcDir) {
  const declarations = [];
  for (const file of TOKEN_FILES) {
    const css = readFileSync3(join3(srcDir, ".vitepress/theme/tokens", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
    if (root) declarations.push(root[1].trim());
  }
  return declarations.join("\n");
}
function figureCss(srcDir, names) {
  const unique = [...new Set(names)].sort();
  if (unique.length === 0) return "";
  const parts = [
    `/* Figures \u2014 the book's diagrams, from .vitepress/theme/components. */`,
    `.figure {
${tokenDeclarations(srcDir)}
}`,
    // A figure is a card, so a reader in night mode gets a picture painted on its
    // own light ground rather than near-black strokes on a near-black page.
    `.figure { background: var(--surface-card); color: var(--text-primary);
  padding: 10px 12px; margin: 1.4em 0; border-radius: 6px;
  page-break-inside: avoid; break-inside: avoid; }`,
    `.figure svg { display: block; width: 100%; height: auto; }`,
    `.figure p, .figure h3 { margin: 0; }`
  ];
  for (const name of unique) {
    const scoped = scopedStyle(srcDir, name).trim();
    if (scoped) parts.push(scopeCss(scoped, `.figure--${name}`).trim());
  }
  return `${parts.join("\n\n")}
`;
}

// .vitepress/book.mts
var TITLE = "Substrat, end to end";
var stripFrontmatter = (raw) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
var stripNextLink = (body) => body.replace(/\n---\n+\s*(\*\*Next:\*\*|\*That is the end of the book\.)[\s\S]*$/, "\n");
function demoteHeadings(body) {
  let fenced = false;
  return body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return /^#{1,5} /.test(line) ? `#${line}` : line;
  }).join("\n");
}
function chapterMarkdown(srcDir, link, demote = true, component) {
  const raw = readFileSync4(join4(srcDir, fileForLink(link)), "utf8");
  const body = stripNextLink(stripFrontmatter(toTwin(raw, srcDir, component))).trimEnd();
  return demote ? demoteHeadings(body) : body;
}
function bookPages(srcDir, component) {
  return bookChapters().map((c) => ({
    text: c.text,
    link: c.link,
    slug: c.link.replace(/^\/book\/?/, "") || "index",
    markdown: chapterMarkdown(srcDir, c.link, false, component)
  }));
}
function bookMarkdown(srcDir, component) {
  const [frontLink, ...chapterLinks] = bookChapters();
  const front = chapterMarkdown(srcDir, frontLink.link, false, component);
  const chapters = chapterLinks.map((c) => chapterMarkdown(srcDir, c.link, true, component));
  return [
    `# ${TITLE}`,
    "",
    `The Substrat book, in one file. Published at ${SITE}/book/ \u2014 this edition is`,
    "generated from those chapters at build time, so it cannot fall behind them.",
    "",
    front.replace(/^# .*\n+/, ""),
    "",
    chapters.join("\n\n---\n\n"),
    ""
  ].join("\n");
}
function bookHtml(srcDir, figures = /* @__PURE__ */ new Map()) {
  const md2 = new MarkdownIt({ html: true, linkify: false, typographer: false });
  const body = md2.render(bookMarkdown(
    srcDir,
    (name, props) => figures.get(figureKey(name, props)) ?? altTwin(name, props)
  ));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<link rel="canonical" href="${SITE}/book/read.html">
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5a5a5a; --bg: #fff;
          --rule: #e2e2e2; --code-bg: #f5f5f4; --accent: #0b6b62; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #a0a0a0; --bg: #16161a;
            --rule: #2e2e33; --code-bg: #202027; --accent: #5fd3c4; }
  }
  * { box-sizing: border-box; }
  body { margin: 0 auto; padding: 3rem 1.25rem 6rem; max-width: 44rem;
         background: var(--bg); color: var(--fg); line-height: 1.65;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         font-size: 17px; }
  h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; margin: 2.5em 0 0.6em; }
  h1 { font-size: 2rem; margin-top: 0; }
  h1 + p { color: var(--muted); }
  h2 { font-size: 1.45rem; padding-top: 0.6em; border-top: 1px solid var(--rule); }
  h3 { font-size: 1.15rem; }
  p, ul, ol, blockquote, table { margin: 0 0 1.1em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.87em;
         background: var(--code-bg); padding: 0.15em 0.35em; border-radius: 4px; }
  pre { background: var(--code-bg); padding: 1rem; border-radius: 8px;
        overflow-x: auto; font-size: 0.85em; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: 1em; }
  blockquote { margin-left: 0; padding: 0.2em 0 0.2em 1.1em;
               border-left: 3px solid var(--accent); color: var(--muted); }
  table { border-collapse: collapse; width: 100%; font-size: 0.93em; display: block;
          overflow-x: auto; }
  th, td { border: 1px solid var(--rule); padding: 0.45em 0.7em; text-align: left;
           vertical-align: top; }
  th { background: var(--code-bg); font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 3.5em 0; }
  @media print {
    body { max-width: none; font-size: 11pt; padding: 0; color: #000; background: #fff; }
    a { color: #000; text-decoration: underline; }
    h2 { break-before: page; }
    h1 + p { break-after: auto; }
    pre, blockquote, table { break-inside: avoid; }
  }
</style>
<style>
${figureCss(srcDir, [...figures.keys()].map(componentOf))}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
function bookArtifacts(srcDir, figures = /* @__PURE__ */ new Map()) {
  return [
    { path: "book.txt", contents: bookMarkdown(srcDir) },
    { path: "book/read.html", contents: bookHtml(srcDir, figures) }
  ];
}

// .vitepress/epub.mts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join5 } from "node:path";
import { zipSync, strToU8 } from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm/index.mjs";
import MarkdownIt2 from "file:///Users/markus/Projects/private/substrat/.worktrees/feat/requests-path-facet-2762/node_modules/.pnpm/markdown-it@14.3.3/node_modules/markdown-it/index.mjs";
var TITLE2 = "Substrat, end to end";
var AUTHOR = "Substrat";
var LANGUAGE = "en";
var BOOK_ID = "urn:uuid:5f3b9c62-8a4e-4d17-9f21-7c6e0b2a4d83";
var xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var md = new MarkdownIt2({ html: true, xhtmlOut: true, linkify: false, typographer: false });
var fileFor = (page) => `text/${page.slug}.xhtml`;
var idOf = (page) => `ch-${page.slug}`;
function relinkForEpub(html) {
  return html.replace(
    new RegExp(`${SITE}/book/([a-z0-9-]+)\\.md`, "g"),
    (_m, slug) => `${slug}.xhtml`
  ).replace(new RegExp(`${SITE}/book/index\\.md`, "g"), "index.xhtml").replace(new RegExp(`(${SITE}/[^"']*?)\\.md(?=["'#])`, "g"), "$1");
}
function chapterDoc(page) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>${xml(page.text)}</title>
<link rel="stylesheet" type="text/css" href="../style.css"/>
</head>
<body epub:type="${page.slug === "index" ? "frontmatter" : "bodymatter"}">
<section epub:type="chapter">
${relinkForEpub(md.render(page.markdown))}
</section>
</body>
</html>
`;
}
function titlePage() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>${xml(TITLE2)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body epub:type="frontmatter">
<section epub:type="titlepage" class="titlepage">
<h1 class="booktitle">Substrat,<br/>end to end</h1>
<p class="subtitle">How the pieces join \u2014 thirteen chapters, front to back.</p>
<p class="imprint">${xml(SITE)}</p>
</section>
</body>
</html>
`;
}
function navDoc(pages) {
  const items = pages.map((p) => `      <li><a href="${fileFor(p)}">${xml(p.text)}</a></li>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${LANGUAGE}" xml:lang="${LANGUAGE}">
<head>
<meta charset="UTF-8"/>
<title>Contents</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<nav epub:type="toc" id="toc" class="toc">
  <h1>Contents</h1>
  <ol>
${items}
  </ol>
</nav>
<nav epub:type="landmarks" hidden="hidden">
  <ol>
    <li><a epub:type="toc" href="nav.xhtml">Contents</a></li>
    <li><a epub:type="bodymatter" href="${fileFor(pages[1])}">Start of content</a></li>
  </ol>
</nav>
</body>
</html>
`;
}
function ncxDoc(pages) {
  const points = pages.map(
    (p, i) => `  <navPoint id="nav${i + 1}" playOrder="${i + 1}">
    <navLabel><text>${xml(p.text)}</text></navLabel>
    <content src="${fileFor(p)}"/>
  </navPoint>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
  <meta name="dtb:uid" content="${BOOK_ID}"/>
  <meta name="dtb:depth" content="1"/>
  <meta name="dtb:totalPageCount" content="0"/>
  <meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${xml(TITLE2)}</text></docTitle>
<navMap>
${points}
</navMap>
</ncx>
`;
}
function packageDoc(pages, modified, hasCover) {
  const chapterItems = pages.map(
    (p) => `    <item id="${idOf(p)}" href="${fileFor(p)}" media-type="application/xhtml+xml"/>`
  ).join("\n");
  const spine2 = pages.map((p) => `    <itemref idref="${idOf(p)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${LANGUAGE}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${BOOK_ID}</dc:identifier>
    <dc:title>${xml(TITLE2)}</dc:title>
    <dc:creator>${xml(AUTHOR)}</dc:creator>
    <dc:language>${LANGUAGE}</dc:language>
    <dc:publisher>${xml(AUTHOR)}</dc:publisher>
    <dc:description>How Substrat works, end to end: the path of one request, the life of one event, the two clocks, and everything a reference page cannot say about how the pieces join.</dc:description>
    <dc:source>${xml(`${SITE}/book/`)}</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
${hasCover ? '    <meta name="cover" content="cover-image"/>\n' : ""}  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
${hasCover ? '    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>\n' : ""}${chapterItems}
  </manifest>
  <spine toc="ncx">
    <itemref idref="titlepage"/>
    <itemref idref="nav"/>
${spine2}
  </spine>
</package>
`;
}
var STYLE = `@namespace epub "http://www.idpf.org/2007/ops";

body { margin: 0 5%; line-height: 1.5; widows: 2; orphans: 2; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; page-break-after: avoid; }
h1 { font-size: 1.6em; margin-top: 0; }
h2 { font-size: 1.25em; }
h3 { font-size: 1.08em; }
p { margin: 0 0 0.9em; text-align: left; }
a { text-decoration: underline; }
code, pre { font-family: "SF Mono", Menlo, Consolas, monospace; }
code { font-size: 0.85em; }
pre { font-size: 0.72em; line-height: 1.4; padding: 0.7em; margin: 0 0 1em;
      background: rgba(127,127,127,0.12); border-radius: 4px;
      white-space: pre-wrap; word-wrap: break-word; page-break-inside: avoid; }
pre code { font-size: 1em; }
blockquote { margin: 0 0 1em 1em; padding-left: 0.9em;
             border-left: 3px solid rgba(127,127,127,0.5); font-style: italic; }
ul, ol { margin: 0 0 1em; padding-left: 1.3em; }
li { margin-bottom: 0.35em; }
hr { border: 0; border-top: 1px solid rgba(127,127,127,0.4); margin: 2em 0; }
table { border-collapse: collapse; width: 100%; font-size: 0.8em; margin: 0 0 1em; }
th, td { border: 1px solid rgba(127,127,127,0.5); padding: 0.35em 0.5em;
         text-align: left; vertical-align: top; }
th { font-weight: bold; }

/*
 * The contents page numbers itself twice otherwise. EPUB 3 requires the toc to be an
 * ordered list, and a reader draws that list's markers \u2014 but every chapter title opens
 * with its own number, because the number is part of the chapter's name and has to
 * survive into a reader's own table-of-contents panel, which ignores this stylesheet.
 * So the title keeps the number and the list marker goes.
 */
.toc ol { list-style: none; padding-left: 0; }
.toc ol li { margin-bottom: 0.6em; }
.toc ol a { text-decoration: none; }

.titlepage { text-align: center; padding-top: 22%; }
.booktitle { font-size: 2.1em; line-height: 1.15; margin: 0 0 0.7em; }
.subtitle { font-size: 1.05em; font-style: italic; margin: 0 0 3em; }
.imprint { font-size: 0.85em; }
`;
function figureRequests(srcDir) {
  const found = [];
  bookPages(srcDir, (name, props) => {
    found.push({ name, props });
    return "";
  });
  return found;
}
var twinWith = (figures) => (name, props) => figures.get(figureKey(name, props)) ?? altTwin(name, props);
function buildEpub(srcDir, coverPng, figures = /* @__PURE__ */ new Map()) {
  const pages = bookPages(srcDir, twinWith(figures));
  const modified = `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`;
  const hasCover = coverPng !== void 0 && coverPng.length > 0;
  const files = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": [
      strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
      { level: 6 }
    ],
    "EPUB/package.opf": [strToU8(packageDoc(pages, modified, hasCover)), { level: 6 }],
    "EPUB/nav.xhtml": [strToU8(navDoc(pages)), { level: 6 }],
    "EPUB/toc.ncx": [strToU8(ncxDoc(pages)), { level: 6 }],
    "EPUB/style.css": [
      // Styles for the figures actually embedded — not for every one the chapters
      // ask for, so the sync path ships no rules for pictures it does not carry.
      strToU8(STYLE + figureCss(srcDir, [...figures.keys()].map(componentOf))),
      { level: 6 }
    ],
    "EPUB/titlepage.xhtml": [strToU8(titlePage()), { level: 6 }]
  };
  if (hasCover) files["EPUB/cover.png"] = [coverPng, { level: 6 }];
  for (const page of pages) {
    files[`EPUB/${fileFor(page)}`] = [strToU8(chapterDoc(page)), { level: 6 }];
  }
  return zipSync(files, { level: 6 });
}
function readCover(srcDir) {
  try {
    return new Uint8Array(readFileSync5(join5(srcDir, "assets/book-cover.png")));
  } catch {
    return void 0;
  }
}
async function epubArtifacts(srcDir, rendered) {
  const figures = rendered ?? await renderFigures(srcDir, figureRequests(srcDir));
  return [{ path: "book.epub", contents: buildEpub(srcDir, readCover(srcDir), figures) }];
}

// .vitepress/headers.mts
import { readFileSync as readFileSync6, readdirSync as readdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { createHash } from "node:crypto";
import { join as join6, resolve as resolve3 } from "node:path";
var INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
function filesWith(dir, suffix) {
  const out = [];
  for (const entry of readdirSync2(dir, { withFileTypes: true })) {
    const path = join6(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
        continue;
      out.push(...filesWith(path, suffix));
    } else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
}
function htmlFiles(dir) {
  return filesWith(dir, ".html");
}
function inlineScriptHashes(outDir) {
  const hashes = /* @__PURE__ */ new Set();
  for (const file of htmlFiles(outDir)) {
    const html = readFileSync6(file, "utf8");
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      hashes.add(`'sha256-${createHash("sha256").update(body ?? "", "utf8").digest("base64")}'`);
    }
  }
  return [...hashes].sort();
}
var COMPONENT_TAG = /<([A-Z][A-Za-z0-9]*)\b([^>]*)>/g;
function deskOrigins(srcDir) {
  const origins = /* @__PURE__ */ new Set();
  for (const file of filesWith(srcDir, ".md")) {
    for (const match of readFileSync6(file, "utf8").matchAll(COMPONENT_TAG)) {
      const desk = attributes(match[2] ?? "").get("desk");
      if (desk) origins.add(new URL(desk).origin);
    }
  }
  return [...origins].sort();
}
function csp(scriptHashes, widgetOrigins = []) {
  const script = ["'self'", ...scriptHashes, ...widgetOrigins];
  const connect = ["'self'", ...widgetOrigins];
  return [
    `default-src 'self'`,
    `script-src ${script.join(" ")}`,
    // See the header: mermaid styles diagrams after the policy is written.
    `style-src 'self' 'unsafe-inline'`,
    // data: — katex and mermaid inline small raster/SVG payloads.
    `img-src 'self' data:`,
    // data: — vp-icons.css inlines its woff2 as base64. Without this the nav,
    // sidebar and external-link icons silently vanish; 96 blocked loads per page.
    `font-src 'self' data:`,
    `connect-src ${connect.join(" ")}`,
    // The site embeds nothing and is embedded by nothing.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    // A docs site posts nowhere; both close an injected-markup escape route
    // that script-src does not cover.
    `base-uri 'none'`,
    `form-action 'none'`
  ].join("; ");
}
var RESOURCE_TAG = /<(script|link|img|iframe)\b([^>]*)>/gi;
var ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;
function attributes(raw) {
  const attrs = /* @__PURE__ */ new Map();
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? "";
    const unquoted = /^["']/.test(value) ? value.slice(1, -1) : value;
    if (name && !attrs.has(name)) attrs.set(name, unquoted);
  }
  return attrs;
}
var FETCHING_RELS = /* @__PURE__ */ new Set(["stylesheet", "preload", "modulepreload"]);
function externalResourceUrls(html) {
  const urls = [];
  for (const match of html.matchAll(RESOURCE_TAG)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = attributes(match[2] ?? "");
    const url = tag === "link" ? (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).some((rel) => FETCHING_RELS.has(rel)) ? attrs.get("href") : void 0 : attrs.get("src");
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}
function assertNoUnallowedOrigins(outDir, allowed) {
  const permitted = new Set(allowed.map((o) => new URL(o).origin));
  const offenders = /* @__PURE__ */ new Map();
  for (const file of htmlFiles(outDir)) {
    for (const url of externalResourceUrls(readFileSync6(file, "utf8"))) {
      const origin = new URL(url).origin;
      if (!permitted.has(origin)) offenders.set(origin, file);
    }
  }
  if (offenders.size === 0) return;
  const lines = [...offenders].map(([origin, file]) => `  ${origin} (first seen in ${file})`);
  throw new Error(
    `headers.mts: the built site loads resources from origins the CSP does not allow:
${lines.join("\n")}
Add each to the right directive in csp() \u2014 or drop the resource. Shipping as-is builds green and breaks in the browser, on production only.`
  );
}
function emitHeaders(outDir, srcDir, siteWideWidget) {
  const widgets = [
    .../* @__PURE__ */ new Set([
      ...siteWideWidget ? [new URL(siteWideWidget).origin] : [],
      ...deskOrigins(srcDir)
    ])
  ].sort();
  assertNoUnallowedOrigins(outDir, widgets);
  const policy = csp(inlineScriptHashes(outDir), widgets);
  const body = [
    "# GENERATED by .vitepress/headers.mts during `vitepress build` \u2014 do not edit by hand.",
    "# The script hashes are read out of the built HTML, so they follow every rebuild.",
    "/*",
    `  Content-Security-Policy: ${policy}`,
    "  X-Frame-Options: DENY",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    // No camera/mic/geolocation anywhere on a documentation site.
    "  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "",
    // The EPUB edition of the book (epub.mts). Pages guesses a content type from the
    // extension and does not know this one, so it would serve `application/octet-stream`
    // — and with `nosniff` set above, nothing downstream is allowed to correct that. iOS
    // Safari decides whether to offer "Open in Books" from the content type alone, so
    // without this line the file downloads as an anonymous blob on the one device most
    // likely to want it.
    "/book.epub",
    "  Content-Type: application/epub+zip",
    // The site names the file `book.epub`, which is right in a URL and poor in a phone's
    // Files app next to everything else called book-something. Books takes its library
    // title from the package metadata either way, so this only ever names the download.
    '  Content-Disposition: attachment; filename="substrat-end-to-end.epub"',
    ""
  ].join("\n");
  writeFileSync2(resolve3(outDir, "_headers"), body);
  return policy;
}

// .vitepress/config.mts
var WIDGET_API = process.env.TICKET0_WIDGET === "0" ? void 0 : process.env.TICKET0_API ?? "https://ticket0.substrat.net";
var config_default = withMermaid(defineConfig({
  title: "Substrat",
  description: "The hard parts, hosted. A runtime-enforced substrate for building vertical B2B SaaS.",
  lastUpdated: true,
  /*
   * No `ignoreDeadLinks`, deliberately. `/book/read.html` is written in `buildEnd`
   * (book.mts) and used to be exempted here so a markdown link to it would build —
   * but building was never the problem: VitePress's SPA router intercepts a
   * same-origin link whose extension it does not recognise as a file (`.html` is one
   * of those), so the link routed client-side to a page the router has no chunk for
   * and rendered the 404. book/index.md points at it with a raw `<a target="_self">`
   * instead, which the router skips. Nothing checks a raw anchor, so the exemption
   * has no work left — and without it a markdown link to that route fails the build,
   * which is the right answer now that a markdown link is the bug.
   */
  /**
   * The ticket0 support widget, in every page's `<head>` (see `WIDGET_API`).
   *
   * A `<script>` in the head rather than a component in a layout slot: it is in the
   * built HTML, so the CSP guard in headers.mts sees the origin it has to allow, and
   * VitePress runs it once per real page load — the bubble then survives every
   * client-side navigation, with nothing to unmount and remount on the way.
   */
  head: WIDGET_API ? [["script", { src: `${WIDGET_API}/widget.js`, "data-api": WIDGET_API, defer: "" }]] : [],
  // The package's own changelog is not a docs page. It was being built and
  // served at /CHANGELOG, where nothing linked to it and nothing indexed it.
  srcExclude: ["CHANGELOG.md"],
  vite: {
    // mermaid ships ESM that default-imports CJS deps (dayjs); without
    // pre-bundling, the browser throws and the whole app fails to mount.
    optimizeDeps: { include: ["mermaid", "dayjs"] }
  },
  // The machine-readable surface (#751): llms.txt, llms-full.txt and a .md twin
  // of every page, written into the built site. It lives here rather than in a
  // standalone script so it reads the same sidebar the nav renders and the same
  // srcDir VitePress just built — there is no second list of pages to forget.
  // `pnpm lint:llms --check` runs the identical code and fails on a mismatch.
  async buildEnd(siteConfig) {
    const repoRoot = resolve4(siteConfig.srcDir, "../..");
    emitInto(siteConfig.outDir, buildArtifacts(siteConfig.srcDir, repoRoot));
    const figures = await renderFigures(siteConfig.srcDir, figureRequests(siteConfig.srcDir));
    emitInto(siteConfig.outDir, bookArtifacts(siteConfig.srcDir, figures));
    emitInto(siteConfig.outDir, await epubArtifacts(siteConfig.srcDir, figures));
    emitHeaders(siteConfig.outDir, siteConfig.srcDir, WIDGET_API);
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/what-is-substrat", activeMatch: "/guide/" },
      { text: "Concepts", link: "/concepts/tenancy", activeMatch: "/concepts/" },
      { text: "Engines", link: "/engines/", activeMatch: "/engines/" },
      { text: "Connectors", link: "/connectors/", activeMatch: "/connectors/" },
      { text: "Verticals", link: "/verticals/", activeMatch: "/verticals/" },
      { text: "Platform", link: "/platform/", activeMatch: "/platform/" },
      { text: "Reference", link: "/reference/contracts", activeMatch: "/reference/" },
      // Last, and deliberately apart from the sections a reader takes in order: the
      // changelog is dated, not sequenced. Its sidebar is read from the directory
      // (sidebar.mts), so Monday's entry reaches the nav with nothing else to remember.
      { text: "Changelog", link: "/changelog/", activeMatch: "/changelog/" }
    ],
    sidebar: {
      // The book is not in the nav or the docs sidebar: the landing page offers it as
      // the ebook. Inside it, the sidebar is its chapters alone, which is also what
      // gives every chapter the Next link its reading order depends on.
      "/book/": bookSidebar(),
      "/guide/": guideSidebar(),
      "/concepts/": guideSidebar(),
      "/engines/": guideSidebar(),
      "/connectors/": guideSidebar(),
      "/verticals/": guideSidebar(),
      "/platform/": guideSidebar(),
      "/reference/": guideSidebar(),
      "/changelog/": changelogSidebar()
    },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: "github", link: "https://github.com/substrat-run/substrat" }],
    search: {
      provider: "local"
    },
    footer: {
      message: 'The hard parts, hosted. \xB7 <a href="/privacy">Privacy policy</a> \xB7 <a href="/terms.html">Terms of service</a>'
    }
  }
}));
export {
  config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLnZpdGVwcmVzcy9jb25maWcubXRzIiwgIi52aXRlcHJlc3MvbGxtcy5tdHMiLCAiLnZpdGVwcmVzcy9zaWRlYmFyLm10cyIsICIudml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvUGVybWlzc2lvblBpcGVsaW5lLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9TY29wZURyYWluLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9JbnN0YW5jZVJlc29sdXRpb24uY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1RlbmFuY3lUcmVlLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9SZWFkUGF0aHMuY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL0Nvbm5lY3Rvckxvb3AuY29udGVudC5tdHMiLCAiLi4vLi4vZW5naW5lcy9ib29raW5nL21vZGVsLmpzb24iLCAiLi4vLi4vZW5naW5lcy9pbnZvaWNpbmcvbW9kZWwuanNvbiIsICIuLi8uLi9lbmdpbmVzL3dvcmtvcmRlci9tb2RlbC5qc29uIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9zdGF0ZS1tYWNoaW5lLm10cyIsICIudml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU3RhdGVNYWNoaW5lLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9MYXllclN0YWNrLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9SdW50aW1lVG9wb2xvZ3kuY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1Njb3BlVG9wb2xvZ3kuY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL0JsYXN0UmFkaXVzLmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9HdWFyZFBhdGguY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1NpZ251cEZvcm0uY29udGVudC5tdHMiLCAiLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL0NvbW11bmljYXRpb25GbG93LmNvbnRlbnQubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9hbHQubXRzIiwgIi52aXRlcHJlc3MvYm9vay5tdHMiLCAiLnZpdGVwcmVzcy9maWd1cmVzLm10cyIsICIudml0ZXByZXNzL2VwdWIubXRzIiwgIi52aXRlcHJlc3MvaGVhZGVycy5tdHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvY29uZmlnLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9jb25maWcubXRzXCI7aW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlcHJlc3MnO1xuaW1wb3J0IHsgd2l0aE1lcm1haWQgfSBmcm9tICd2aXRlcHJlc3MtcGx1Z2luLW1lcm1haWQnO1xuaW1wb3J0IHsgYnVpbGRBcnRpZmFjdHMsIGVtaXRJbnRvIH0gZnJvbSAnLi9sbG1zLm1qcyc7XG5pbXBvcnQgeyBib29rQXJ0aWZhY3RzIH0gZnJvbSAnLi9ib29rLm1qcyc7XG5pbXBvcnQgeyBlcHViQXJ0aWZhY3RzLCBmaWd1cmVSZXF1ZXN0cyB9IGZyb20gJy4vZXB1Yi5tanMnO1xuaW1wb3J0IHsgcmVuZGVyRmlndXJlcyB9IGZyb20gJy4vZmlndXJlcy5tanMnO1xuaW1wb3J0IHsgZW1pdEhlYWRlcnMgfSBmcm9tICcuL2hlYWRlcnMubWpzJztcbmltcG9ydCB7IGJvb2tTaWRlYmFyLCBjaGFuZ2Vsb2dTaWRlYmFyLCBndWlkZVNpZGViYXIgfSBmcm9tICcuL3NpZGViYXIubWpzJztcblxuLyoqXG4gKiBUaGUgdGlja2V0MCBzdXBwb3J0IGRlc2sgZXZlcnkgcGFnZSBlbWJlZHMgXHUyMDE0IG5hbWVkIG9uY2UsIGJlY2F1c2UgaXQgaXMgcmVhZFxuICogdHdpY2U6IHRoZSBgPHNjcmlwdD5gIHRhZyBiZWxvdywgYW5kIHRoZSBDU1AgdGhhdCBoYXMgdG8gYWxsb3cgaXQuIEEgd2lkZ2V0IHRoZVxuICogcG9saWN5IGRpZCBub3QgbmFtZSB3b3VsZCBsb2FkIGFuZCB0aGVuIGZhaWwgc2lsZW50bHkuXG4gKlxuICogT24gYnkgZGVmYXVsdCBhbmQgcG9pbnRlZCBhdCB0aGUgbGl2ZSBkZXNrLCBzbyBzdWJzdHJhdC5uZXQgY2FycmllcyB0aGUgYnViYmxlIG9uXG4gKiBldmVyeSBwYWdlOiB0aGUgd2hvbGUgZG9nZm9vZCBpcyB0aGUgd2lkZ2V0IG9uIHN1YnN0cmF0Lm5ldCBhbnN3ZXJpbmcgb3V0IG9mXG4gKiBzdWJzdHJhdC5uZXQncyBvd24gYGxsbXMtZnVsbC50eHRgLiBgVElDS0VUMF9BUEk9aHR0cDovL2xvY2FsaG9zdDo4ODc0YCBhaW1zIGFcbiAqIGxvY2FsIGJ1aWxkIGF0IGEgbG9jYWwgZGVzayAoYHBucG0gLS1maWx0ZXIgQHN1YnN0cmF0LXJ1bi9kZW1vLXRpY2tldDAgZGV2YCksIGFuZFxuICogYFRJQ0tFVDBfV0lER0VUPTBgIGJ1aWxkcyB3aXRob3V0IG9uZS4gT2ZmIGlzIHRoZSBleGNlcHRpb24gbm93LCBub3Qgb24gXHUyMDE0IHRoaXNcbiAqIGFycmF5IHNoaXBzIHRvIHByb2R1Y3Rpb24sIGFuZCBhIHBlcnNvbiBtYWRlIHRoYXQgZGVjaXNpb24gb25jZSwgaGVyZS5cbiAqL1xuY29uc3QgV0lER0VUX0FQSSA9XG4gIHByb2Nlc3MuZW52LlRJQ0tFVDBfV0lER0VUID09PSAnMCdcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogKHByb2Nlc3MuZW52LlRJQ0tFVDBfQVBJID8/ICdodHRwczovL3RpY2tldDAuc3Vic3RyYXQubmV0Jyk7XG5cbmV4cG9ydCBkZWZhdWx0IHdpdGhNZXJtYWlkKGRlZmluZUNvbmZpZyh7XG4gIHRpdGxlOiAnU3Vic3RyYXQnLFxuICBkZXNjcmlwdGlvbjpcbiAgICAnVGhlIGhhcmQgcGFydHMsIGhvc3RlZC4gQSBydW50aW1lLWVuZm9yY2VkIHN1YnN0cmF0ZSBmb3IgYnVpbGRpbmcgdmVydGljYWwgQjJCIFNhYVMuJyxcbiAgbGFzdFVwZGF0ZWQ6IHRydWUsXG5cbiAgLypcbiAgICogTm8gYGlnbm9yZURlYWRMaW5rc2AsIGRlbGliZXJhdGVseS4gYC9ib29rL3JlYWQuaHRtbGAgaXMgd3JpdHRlbiBpbiBgYnVpbGRFbmRgXG4gICAqIChib29rLm10cykgYW5kIHVzZWQgdG8gYmUgZXhlbXB0ZWQgaGVyZSBzbyBhIG1hcmtkb3duIGxpbmsgdG8gaXQgd291bGQgYnVpbGQgXHUyMDE0XG4gICAqIGJ1dCBidWlsZGluZyB3YXMgbmV2ZXIgdGhlIHByb2JsZW06IFZpdGVQcmVzcydzIFNQQSByb3V0ZXIgaW50ZXJjZXB0cyBhXG4gICAqIHNhbWUtb3JpZ2luIGxpbmsgd2hvc2UgZXh0ZW5zaW9uIGl0IGRvZXMgbm90IHJlY29nbmlzZSBhcyBhIGZpbGUgKGAuaHRtbGAgaXMgb25lXG4gICAqIG9mIHRob3NlKSwgc28gdGhlIGxpbmsgcm91dGVkIGNsaWVudC1zaWRlIHRvIGEgcGFnZSB0aGUgcm91dGVyIGhhcyBubyBjaHVuayBmb3JcbiAgICogYW5kIHJlbmRlcmVkIHRoZSA0MDQuIGJvb2svaW5kZXgubWQgcG9pbnRzIGF0IGl0IHdpdGggYSByYXcgYDxhIHRhcmdldD1cIl9zZWxmXCI+YFxuICAgKiBpbnN0ZWFkLCB3aGljaCB0aGUgcm91dGVyIHNraXBzLiBOb3RoaW5nIGNoZWNrcyBhIHJhdyBhbmNob3IsIHNvIHRoZSBleGVtcHRpb25cbiAgICogaGFzIG5vIHdvcmsgbGVmdCBcdTIwMTQgYW5kIHdpdGhvdXQgaXQgYSBtYXJrZG93biBsaW5rIHRvIHRoYXQgcm91dGUgZmFpbHMgdGhlIGJ1aWxkLFxuICAgKiB3aGljaCBpcyB0aGUgcmlnaHQgYW5zd2VyIG5vdyB0aGF0IGEgbWFya2Rvd24gbGluayBpcyB0aGUgYnVnLlxuICAgKi9cblxuICAvKipcbiAgICogVGhlIHRpY2tldDAgc3VwcG9ydCB3aWRnZXQsIGluIGV2ZXJ5IHBhZ2UncyBgPGhlYWQ+YCAoc2VlIGBXSURHRVRfQVBJYCkuXG4gICAqXG4gICAqIEEgYDxzY3JpcHQ+YCBpbiB0aGUgaGVhZCByYXRoZXIgdGhhbiBhIGNvbXBvbmVudCBpbiBhIGxheW91dCBzbG90OiBpdCBpcyBpbiB0aGVcbiAgICogYnVpbHQgSFRNTCwgc28gdGhlIENTUCBndWFyZCBpbiBoZWFkZXJzLm10cyBzZWVzIHRoZSBvcmlnaW4gaXQgaGFzIHRvIGFsbG93LCBhbmRcbiAgICogVml0ZVByZXNzIHJ1bnMgaXQgb25jZSBwZXIgcmVhbCBwYWdlIGxvYWQgXHUyMDE0IHRoZSBidWJibGUgdGhlbiBzdXJ2aXZlcyBldmVyeVxuICAgKiBjbGllbnQtc2lkZSBuYXZpZ2F0aW9uLCB3aXRoIG5vdGhpbmcgdG8gdW5tb3VudCBhbmQgcmVtb3VudCBvbiB0aGUgd2F5LlxuICAgKi9cbiAgaGVhZDogV0lER0VUX0FQSVxuICAgID8gW1snc2NyaXB0JywgeyBzcmM6IGAke1dJREdFVF9BUEl9L3dpZGdldC5qc2AsICdkYXRhLWFwaSc6IFdJREdFVF9BUEksIGRlZmVyOiAnJyB9XV1cbiAgICA6IFtdLFxuXG4gIC8vIFRoZSBwYWNrYWdlJ3Mgb3duIGNoYW5nZWxvZyBpcyBub3QgYSBkb2NzIHBhZ2UuIEl0IHdhcyBiZWluZyBidWlsdCBhbmRcbiAgLy8gc2VydmVkIGF0IC9DSEFOR0VMT0csIHdoZXJlIG5vdGhpbmcgbGlua2VkIHRvIGl0IGFuZCBub3RoaW5nIGluZGV4ZWQgaXQuXG4gIHNyY0V4Y2x1ZGU6IFsnQ0hBTkdFTE9HLm1kJ10sXG5cbiAgdml0ZToge1xuICAgIC8vIG1lcm1haWQgc2hpcHMgRVNNIHRoYXQgZGVmYXVsdC1pbXBvcnRzIENKUyBkZXBzIChkYXlqcyk7IHdpdGhvdXRcbiAgICAvLyBwcmUtYnVuZGxpbmcsIHRoZSBicm93c2VyIHRocm93cyBhbmQgdGhlIHdob2xlIGFwcCBmYWlscyB0byBtb3VudC5cbiAgICBvcHRpbWl6ZURlcHM6IHsgaW5jbHVkZTogWydtZXJtYWlkJywgJ2RheWpzJ10gfSxcbiAgfSxcblxuICAvLyBUaGUgbWFjaGluZS1yZWFkYWJsZSBzdXJmYWNlICgjNzUxKTogbGxtcy50eHQsIGxsbXMtZnVsbC50eHQgYW5kIGEgLm1kIHR3aW5cbiAgLy8gb2YgZXZlcnkgcGFnZSwgd3JpdHRlbiBpbnRvIHRoZSBidWlsdCBzaXRlLiBJdCBsaXZlcyBoZXJlIHJhdGhlciB0aGFuIGluIGFcbiAgLy8gc3RhbmRhbG9uZSBzY3JpcHQgc28gaXQgcmVhZHMgdGhlIHNhbWUgc2lkZWJhciB0aGUgbmF2IHJlbmRlcnMgYW5kIHRoZSBzYW1lXG4gIC8vIHNyY0RpciBWaXRlUHJlc3MganVzdCBidWlsdCBcdTIwMTQgdGhlcmUgaXMgbm8gc2Vjb25kIGxpc3Qgb2YgcGFnZXMgdG8gZm9yZ2V0LlxuICAvLyBgcG5wbSBsaW50OmxsbXMgLS1jaGVja2AgcnVucyB0aGUgaWRlbnRpY2FsIGNvZGUgYW5kIGZhaWxzIG9uIGEgbWlzbWF0Y2guXG4gIGFzeW5jIGJ1aWxkRW5kKHNpdGVDb25maWcpIHtcbiAgICBjb25zdCByZXBvUm9vdCA9IHJlc29sdmUoc2l0ZUNvbmZpZy5zcmNEaXIsICcuLi8uLicpO1xuICAgIGVtaXRJbnRvKHNpdGVDb25maWcub3V0RGlyLCBidWlsZEFydGlmYWN0cyhzaXRlQ29uZmlnLnNyY0RpciwgcmVwb1Jvb3QpKTtcbiAgICAvLyBUaGUgYm9vaydzIHNpbmdsZS1maWxlIGVkaXRpb25zICgjMTQwMSk6IC9ib29rLnR4dCBhbmQgL2Jvb2svcmVhZC5odG1sLCB0aGVcbiAgICAvLyBzYW1lIGNoYXB0ZXJzIGNvbmNhdGVuYXRlZCBmb3IgcHJpbnRpbmcsIHBhbmRvYywgb3Igb25lLXNob3QgaW5nZXN0aW9uLlxuICAgIC8vIEVtaXR0ZWQgcmF0aGVyIHRoYW4gY2hlY2tlZCBpbiwgc28gdGhlcmUgaXMgbm8gc2Vjb25kIGNvcHkgdG8gZHJpZnQgXHUyMDE0IHNlZSBib29rLm10cy5cbiAgICAvLyBSZW5kZXIgb25jZSBmb3IgYm90aCBvZmZsaW5lIHJlYWRpbmcgZm9ybWF0czsgdGhlIHRleHQgZWRpdGlvbiBrZWVwcyBwcm9zZSB0d2lucy5cbiAgICBjb25zdCBmaWd1cmVzID0gYXdhaXQgcmVuZGVyRmlndXJlcyhzaXRlQ29uZmlnLnNyY0RpciwgZmlndXJlUmVxdWVzdHMoc2l0ZUNvbmZpZy5zcmNEaXIpKTtcbiAgICBlbWl0SW50byhzaXRlQ29uZmlnLm91dERpciwgYm9va0FydGlmYWN0cyhzaXRlQ29uZmlnLnNyY0RpciwgZmlndXJlcykpO1xuICAgIC8vIEFuZCAvYm9vay5lcHViIFx1MjAxNCB0aGUgc2FtZSBjaGFwdGVycyBwYWNrYWdlZCBmb3IgYSBwaG9uZTogYSByZWFsIEVQVUIgMyB3aXRoIGFcbiAgICAvLyBjb3ZlciwgYSB0YWJsZSBvZiBjb250ZW50cyBhbmQgb25lIGZpbGUgcGVyIGNoYXB0ZXIsIHNvIEFwcGxlIEJvb2tzIGFuZCB0aGUgcmVzdFxuICAgIC8vIGNhbiByZW1lbWJlciB3aGVyZSB0aGUgcmVhZGVyIGdvdCB0by4gU2VlIGVwdWIubXRzIGZvciB0aGUgemlwJ3Mgb3duIHJ1bGVzLlxuICAgIC8vIEFzeW5jIGJlY2F1c2UgdGhlIGNoYXB0ZXJzJyBmaWd1cmVzIGFyZSB0aGUgcGFnZSdzIG93biBWdWUgY29tcG9uZW50cyxcbiAgICAvLyBzZXJ2ZXItcmVuZGVyZWQgZm9yIGEgZm9ybWF0IHdpdGggbm8gSmF2YVNjcmlwdCAoZmlndXJlcy5tdHMpLlxuICAgIGVtaXRJbnRvKHNpdGVDb25maWcub3V0RGlyLCBhd2FpdCBlcHViQXJ0aWZhY3RzKHNpdGVDb25maWcuc3JjRGlyLCBmaWd1cmVzKSk7XG4gICAgLy8gVGhlIGBfaGVhZGVyc2AgQ2xvdWRmbGFyZSBQYWdlcyBzZXJ2ZXMgdGhlIHNpdGUgd2l0aCwgaW5jbHVkaW5nIGEgQ1NQXG4gICAgLy8gd2hvc2Ugc2NyaXB0IGhhc2hlcyBhcmUgcmVhZCBiYWNrIG91dCBvZiB0aGUgSFRNTCB0aGlzIGJ1aWxkIGp1c3Qgd3JvdGVcbiAgICAvLyAoaGVhZGVycy5tdHMgZXhwbGFpbnMgd2h5IHRoZXkgY2Fubm90IGJlIHdyaXR0ZW4gZG93bikuIEVtaXR0ZWQgbGFzdDogaXRcbiAgICAvLyBoYXNoZXMgdGhlIGlubGluZSBzY3JpcHRzIG9uIGV2ZXJ5IHBhZ2UsIGFuZCB0aGUgdHdpbnMgYWJvdmUgYWRkIG5vbmUuXG4gICAgLy8gc3JjRGlyIHRvbzogdGhlIHNpZ251cCBmb3JtcyBuYW1lIHRoZSBkZXNrIHRoZXkgYGZldGNoYCBhcyBhIGBkZXNrYCBhdHRyaWJ1dGVcbiAgICAvLyAoaW5kZXgubWQsIGNoYW5nZWxvZy9pbmRleC5tZCksIGFuZCB0aGF0IHRhZyBjb21waWxlcyBhd2F5IFx1MjAxNCB0aGUgb3JpZ2luIGlzXG4gICAgLy8gbm93aGVyZSBpbiB0aGUgSFRNTCB0aGlzIHBvbGljeSB3b3VsZCBvdGhlcndpc2UgYmUgZGVyaXZlZCBmcm9tLlxuICAgIGVtaXRIZWFkZXJzKHNpdGVDb25maWcub3V0RGlyLCBzaXRlQ29uZmlnLnNyY0RpciwgV0lER0VUX0FQSSk7XG4gIH0sXG5cbiAgdGhlbWVDb25maWc6IHtcbiAgICBuYXY6IFtcbiAgICAgIHsgdGV4dDogJ0d1aWRlJywgbGluazogJy9ndWlkZS93aGF0LWlzLXN1YnN0cmF0JywgYWN0aXZlTWF0Y2g6ICcvZ3VpZGUvJyB9LFxuICAgICAgeyB0ZXh0OiAnQ29uY2VwdHMnLCBsaW5rOiAnL2NvbmNlcHRzL3RlbmFuY3knLCBhY3RpdmVNYXRjaDogJy9jb25jZXB0cy8nIH0sXG4gICAgICB7IHRleHQ6ICdFbmdpbmVzJywgbGluazogJy9lbmdpbmVzLycsIGFjdGl2ZU1hdGNoOiAnL2VuZ2luZXMvJyB9LFxuICAgICAgeyB0ZXh0OiAnQ29ubmVjdG9ycycsIGxpbms6ICcvY29ubmVjdG9ycy8nLCBhY3RpdmVNYXRjaDogJy9jb25uZWN0b3JzLycgfSxcbiAgICAgIHsgdGV4dDogJ1ZlcnRpY2FscycsIGxpbms6ICcvdmVydGljYWxzLycsIGFjdGl2ZU1hdGNoOiAnL3ZlcnRpY2Fscy8nIH0sXG4gICAgICB7IHRleHQ6ICdQbGF0Zm9ybScsIGxpbms6ICcvcGxhdGZvcm0vJywgYWN0aXZlTWF0Y2g6ICcvcGxhdGZvcm0vJyB9LFxuICAgICAgeyB0ZXh0OiAnUmVmZXJlbmNlJywgbGluazogJy9yZWZlcmVuY2UvY29udHJhY3RzJywgYWN0aXZlTWF0Y2g6ICcvcmVmZXJlbmNlLycgfSxcbiAgICAgIC8vIExhc3QsIGFuZCBkZWxpYmVyYXRlbHkgYXBhcnQgZnJvbSB0aGUgc2VjdGlvbnMgYSByZWFkZXIgdGFrZXMgaW4gb3JkZXI6IHRoZVxuICAgICAgLy8gY2hhbmdlbG9nIGlzIGRhdGVkLCBub3Qgc2VxdWVuY2VkLiBJdHMgc2lkZWJhciBpcyByZWFkIGZyb20gdGhlIGRpcmVjdG9yeVxuICAgICAgLy8gKHNpZGViYXIubXRzKSwgc28gTW9uZGF5J3MgZW50cnkgcmVhY2hlcyB0aGUgbmF2IHdpdGggbm90aGluZyBlbHNlIHRvIHJlbWVtYmVyLlxuICAgICAgeyB0ZXh0OiAnQ2hhbmdlbG9nJywgbGluazogJy9jaGFuZ2Vsb2cvJywgYWN0aXZlTWF0Y2g6ICcvY2hhbmdlbG9nLycgfSxcbiAgICBdLFxuXG4gICAgc2lkZWJhcjoge1xuICAgICAgLy8gVGhlIGJvb2sgaXMgbm90IGluIHRoZSBuYXYgb3IgdGhlIGRvY3Mgc2lkZWJhcjogdGhlIGxhbmRpbmcgcGFnZSBvZmZlcnMgaXQgYXNcbiAgICAgIC8vIHRoZSBlYm9vay4gSW5zaWRlIGl0LCB0aGUgc2lkZWJhciBpcyBpdHMgY2hhcHRlcnMgYWxvbmUsIHdoaWNoIGlzIGFsc28gd2hhdFxuICAgICAgLy8gZ2l2ZXMgZXZlcnkgY2hhcHRlciB0aGUgTmV4dCBsaW5rIGl0cyByZWFkaW5nIG9yZGVyIGRlcGVuZHMgb24uXG4gICAgICAnL2Jvb2svJzogYm9va1NpZGViYXIoKSxcbiAgICAgICcvZ3VpZGUvJzogZ3VpZGVTaWRlYmFyKCksXG4gICAgICAnL2NvbmNlcHRzLyc6IGd1aWRlU2lkZWJhcigpLFxuICAgICAgJy9lbmdpbmVzLyc6IGd1aWRlU2lkZWJhcigpLFxuICAgICAgJy9jb25uZWN0b3JzLyc6IGd1aWRlU2lkZWJhcigpLFxuICAgICAgJy92ZXJ0aWNhbHMvJzogZ3VpZGVTaWRlYmFyKCksXG4gICAgICAnL3BsYXRmb3JtLyc6IGd1aWRlU2lkZWJhcigpLFxuICAgICAgJy9yZWZlcmVuY2UvJzogZ3VpZGVTaWRlYmFyKCksXG4gICAgICAnL2NoYW5nZWxvZy8nOiBjaGFuZ2Vsb2dTaWRlYmFyKCksXG4gICAgfSxcblxuICAgIG91dGxpbmU6IHsgbGV2ZWw6IFsyLCAzXSB9LFxuXG4gICAgc29jaWFsTGlua3M6IFt7IGljb246ICdnaXRodWInLCBsaW5rOiAnaHR0cHM6Ly9naXRodWIuY29tL3N1YnN0cmF0LXJ1bi9zdWJzdHJhdCcgfV0sXG5cbiAgICBzZWFyY2g6IHtcbiAgICAgIHByb3ZpZGVyOiAnbG9jYWwnLFxuICAgIH0sXG5cbiAgICBmb290ZXI6IHtcbiAgICAgIG1lc3NhZ2U6ICdUaGUgaGFyZCBwYXJ0cywgaG9zdGVkLiBcdTAwQjcgPGEgaHJlZj1cIi9wcml2YWN5XCI+UHJpdmFjeSBwb2xpY3k8L2E+IFx1MDBCNyA8YSBocmVmPVwiL3Rlcm1zLmh0bWxcIj5UZXJtcyBvZiBzZXJ2aWNlPC9hPicsXG4gICAgfSxcbiAgfSxcbn0pKTtcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3NcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2xsbXMubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2xsbXMubXRzXCI7LyoqXG4gKiBUaGUgbWFjaGluZS1yZWFkYWJsZSBkb2NzIHN1cmZhY2UgKCM3NTEpOiBgbGxtcy50eHRgLCBgbGxtcy1mdWxsLnR4dGAsIGFuZCBhXG4gKiBgLm1kYCB0d2luIG9mIGV2ZXJ5IHBhZ2UuXG4gKlxuICogVml0ZVByZXNzIHNlcnZlcyBIVE1MIG9ubHksIHNvIGFuIGFnZW50IHJlYWRpbmcgb3VyIGRvY3MgdG9kYXkgZ2V0cyBuYXZcbiAqIGNocm9tZSwgYSByZW5kZXJlZCBgOjo6IHRpcGAsIGFuZCB0aGVtZSBtYXJrdXAgd3JhcHBlZCBhcm91bmQgdGhlIHRocmVlXG4gKiBwYXJhZ3JhcGhzIGl0IHdhbnRlZC4gVGhlIGZpeCBpcyB0aGUgb25lIHRoZSBlY29zeXN0ZW0gaGFzIGNvbnZlcmdlZCBvbjogYW5cbiAqIGluZGV4IGF0IGEgd2VsbC1rbm93biBwYXRoIHBvaW50aW5nIGF0ICpyYXcgbWFya2Rvd24qLCBzbyB0aGUgYWdlbnQgZmV0Y2hlc1xuICogcHJvc2UgaW5zdGVhZCBvZiBzY3JhcGluZyBhIHBhZ2UuXG4gKlxuICogVGhyZWUgYXJ0aWZhY3RzLCBlYWNoIHdpdGggYSBkaWZmZXJlbnQgam9iOlxuICpcbiAqICAgLSAqKmAvbGxtcy50eHRgKiogXHUyMDE0IHRoZSBpbmRleC4gT25lIGxpbmUgcGVyIHBhZ2UsIGdyb3VwZWQgYnkgdGhlIHNpdGUncyBvd25cbiAqICAgICBzZWN0aW9ucywgZWFjaCB3aXRoIGEgb25lLWxpbmUgZGVzY3JpcHRpb24uIFRoaXMgaXMgd2hhdCBhbiBhZ2VudCByZWFkc1xuICogICAgIGZpcnN0IHRvIGRlY2lkZSAqd2hpY2gqIHBhZ2UgaXQgbmVlZHMuIEl0IGlzIGRlbGliZXJhdGVseSBzbWFsbC5cbiAqICAgLSAqKmAvbGxtcy1mdWxsLnR4dGAqKiBcdTIwMTQgZXZlcnkgcGFnZSBjb25jYXRlbmF0ZWQsIGZvciBvbmUtc2hvdCBpbmdlc3Rpb25cbiAqICAgICBpbnRvIGEgY29udGV4dCB3aW5kb3cuIExhcmdlOyB0aGUgaW5kZXggZXhpc3RzIHNvIHRoaXMgaXMgdGhlIGZhbGxiYWNrLFxuICogICAgIG5vdCB0aGUgZGVmYXVsdC5cbiAqICAgLSAqKmAvY29uY2VwdHMvbW9kZWwubWRgKiogYW5kIGZyaWVuZHMgXHUyMDE0IHRoZSB0d2luIG9mIGVhY2ggcGFnZTogc291cmNlXG4gKiAgICAgbWFya2Rvd24gd2l0aCBmcm9udG1hdHRlciBzdHJpcHBlZCwgVml0ZVByZXNzIGNvbnRhaW5lcnMgZmxhdHRlbmVkIHRvXG4gKiAgICAgYmxvY2txdW90ZXMsIGFuZCBldmVyeSBpbnRlcm5hbCBsaW5rIHJld3JpdHRlbiB0byB0aGUgdHdpbidzIG93biBhYnNvbHV0ZVxuICogICAgIFVSTCwgc28gYW4gYWdlbnQgdGhhdCBmb2xsb3dzIGEgbGluayBsYW5kcyBvbiBtYXJrZG93biBhZ2FpbiByYXRoZXIgdGhhblxuICogICAgIGJvdW5jaW5nIGJhY2sgaW50byBIVE1MLlxuICpcbiAqICMjIFdoeSB0aGlzIHJ1bnMgaW4gYGJ1aWxkRW5kYCBhbmQgbm90IGFzIGEgc2NyaXB0XG4gKlxuICogVGhlIGlzc3VlIGFza2VkIGZvciBhIGJ1aWxkIHBsdWdpbiBzbyB0aGUgYXJ0aWZhY3RzIGNhbm5vdCBkcmlmdCBmcm9tIHRoZVxuICogc2l0ZSwgYW5kIHRoYXQgaXMgdGhlIHdob2xlIHBvaW50OiB0aGUgaW5kZXggaXMgd2Fsa2VkIGZyb20gdGhlIHNhbWVcbiAqIGBzaWRlYmFyLm10c2AgdGhlIG5hdiByZW5kZXJzIGZyb20sIGFuZCB0aGUgdHdpbnMgYXJlIHdyaXR0ZW4gZnJvbSB0aGUgc2FtZVxuICogYHNyY0RpcmAgVml0ZVByZXNzIGp1c3QgcmVuZGVyZWQuIFRoZXJlIGlzIG5vIHNlY29uZCBsaXN0IG9mIHBhZ2VzIHRvIGZvcmdldFxuICogdG8gdXBkYXRlLiBgcG5wbSBsaW50OmxsbXMgLS1jaGVja2AgcnVucyB0aGUgaWRlbnRpY2FsIGNvZGUgYW5kIGFzc2VydHMgdGhlXG4gKiB0d28gYWdyZWUuXG4gKlxuICogIyMgVmVyc2lvbiBwaW5uaW5nLCBob25lc3RseVxuICpcbiAqIFdhc3AgcGFydGl0aW9ucyBpdHMgaW5kZXggYnkgZnJhbWV3b3JrIHZlcnNpb24gYW5kIGtlZXBzIGFuIGFyY2hpdmUgcGVyXG4gKiB2ZXJzaW9uLiBXZSBjYW5ub3QgY29weSB0aGF0OiBhIENsb3VkZmxhcmUgUGFnZXMgZGVwbG95IHJlcGxhY2VzIHRoZSB3aG9sZVxuICogc2l0ZSwgc28gdGhlcmUgaXMgbm8gYXJjaGl2ZSB0byBwb2ludCBhdCwgYW5kIGludmVudGluZyBgbGxtcy0wLjcxLnR4dGAgVVJMc1xuICogdGhhdCA0MDQgdG9tb3Jyb3cgd291bGQgYmUgd29yc2UgdGhhbiBub3QgdmVyc2lvbmluZyBhdCBhbGwuXG4gKlxuICogV2hhdCB3ZSBkbyBpbnN0ZWFkOiB0aGUgaW5kZXggc3RhdGVzIHRoZSBgQHN1YnN0cmF0LXJ1bi9rZXJuZWxgIHZlcnNpb24gaXRcbiAqIGRlc2NyaWJlcywgYW5kIHdlIGVtaXQgYC9sbG1zLTx2ZXJzaW9uPi50eHRgIGFzIGFuIGFsaWFzIGZvciB0aGUgKmN1cnJlbnQqXG4gKiB2ZXJzaW9uIG9ubHkuIEEgaG9vayAoIzc1NCkgdGhhdCByZWFkcyB0aGUgaW5zdGFsbGVkIGtlcm5lbCB2ZXJzaW9uIGFuZFxuICogZmV0Y2hlcyB0aGF0IFVSTCBnZXRzIGEgbWVjaGFuaWNhbCBhbnN3ZXIgXHUyMDE0IDIwMCBtZWFucyB0aGUgcHVibGlzaGVkIGRvY3NcbiAqIGRlc2NyaWJlIHRoZSBrZXJuZWwgeW91IGFjdHVhbGx5IGhhdmUsIDQwNCBtZWFucyB0aGV5IGhhdmUgbW92ZWQgb24gYW5kIHRoZVxuICogYWdlbnQgc2hvdWxkIHJlLXJlYWQgYC9sbG1zLnR4dGAgcmF0aGVyIHRoYW4gdHJ1c3Qgd2hhdCBpdCBjYWNoZWQuIEF0IDAueFxuICogd2l0aCBpbnRlcmZhY2VzIGNoYW5naW5nIHdpdGhvdXQgbm90aWNlLCBcInlvdXIgZG9jcyBhcmUgZm9yIGEgZGlmZmVyZW50XG4gKiBrZXJuZWxcIiBpcyB0aGUgZmFpbHVyZSB0aGlzIGhhcyB0byBtYWtlIHZpc2libGUuXG4gKi9cbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBkaXJuYW1lLCBleHRuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGZpbGVGb3JMaW5rLCBTVEFSVF9IRVJFLCB0YWJsZU9mQ29udGVudHMsIHR5cGUgSW5kZXhlZFBhZ2UgfSBmcm9tICcuL3NpZGViYXIubWpzJztcbmltcG9ydCB7IGFsdEZvciB9IGZyb20gJy4vdGhlbWUvY29tcG9uZW50cy9hbHQubWpzJztcblxuLyoqIFdoZXJlIHRoZSBkb2NzIGFyZSBwdWJsaXNoZWQuIExpbmtzIGluIGBsbG1zLnR4dGAgbXVzdCBiZSBhYnNvbHV0ZS4gKi9cbmV4cG9ydCBjb25zdCBTSVRFID0gJ2h0dHBzOi8vc3Vic3RyYXQubmV0JztcblxuLyoqIFRoZSBvbmUtbGluZSBzaXRlIGJsdXJiLCBtaXJyb3JlZCBmcm9tIGBjb25maWcubXRzYC4gKi9cbmNvbnN0IFRBR0xJTkUgPVxuICAnVGhlIGhhcmQgcGFydHMsIGhvc3RlZC4gQSBydW50aW1lLWVuZm9yY2VkIHN1YnN0cmF0ZSBmb3IgYnVpbGRpbmcgdmVydGljYWwgQjJCIFNhYVMuJztcblxuLyoqXG4gKiBUaGUgdmVyc2lvbiBhbiBhZ2VudCBwaW5zIHRvLiBUaGUga2VybmVsIGlzIHRoZSByaWdodCBjaG9pY2U6IGl0IG93bnMgdGhlXG4gKiBzZWFtcyBldmVyeSB2ZXJ0aWNhbCBjb21waWxlcyBhZ2FpbnN0LCBzbyBpdHMgdmVyc2lvbiBtb3ZpbmcgaXMgd2hhdCBtYWtlcyBhXG4gKiBjYWNoZWQgcGFnZSB3cm9uZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtlcm5lbFZlcnNpb24ocmVwb1Jvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBrZyA9IGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcy9rZXJuZWwvcGFja2FnZS5qc29uJyk7XG4gIHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwa2csICd1dGY4JykpLnZlcnNpb24gYXMgc3RyaW5nO1xufVxuXG4vKiogU3RyaXAgYSBsZWFkaW5nIGAtLS1gIGZyb250bWF0dGVyIGJsb2NrLCByZXR1cm5pbmcgaXQgYW5kIHRoZSBib2R5LiAqL1xuZnVuY3Rpb24gc3BsaXRGcm9udG1hdHRlcihyYXc6IHN0cmluZyk6IHsgZnJvbnRtYXR0ZXI6IHN0cmluZzsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBtYXRjaCA9IC9eLS0tXFxyP1xcbihbXFxzXFxTXSo/KVxccj9cXG4tLS1cXHI/XFxuPy8uZXhlYyhyYXcpO1xuICBpZiAoIW1hdGNoKSByZXR1cm4geyBmcm9udG1hdHRlcjogJycsIGJvZHk6IHJhdyB9O1xuICByZXR1cm4geyBmcm9udG1hdHRlcjogbWF0Y2hbMV0sIGJvZHk6IHJhdy5zbGljZShtYXRjaFswXS5sZW5ndGgpIH07XG59XG5cbi8qKiBBIHBhZ2UgbWF5IG5hbWUgaXRzIG93biBpbmRleCBsaW5lLiBVc2VkIHdoZXJlIHRoZSBvcGVuaW5nIHByb3NlIGlzIGEgdGFibGUuICovXG5mdW5jdGlvbiBmcm9udG1hdHRlckRlc2NyaXB0aW9uKGZyb250bWF0dGVyOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCBtYXRjaCA9IC9eZGVzY3JpcHRpb246XFxzKiguKykkL20uZXhlYyhmcm9udG1hdHRlcik7XG4gIGlmICghbWF0Y2gpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBtYXRjaFsxXS50cmltKCkucmVwbGFjZSgvXlsnXCJdfFsnXCJdJC9nLCAnJyk7XG59XG5cbi8qKiBNYXJrZG93biBlbXBoYXNpcyBhbmQgbGlua3MsIHJlZHVjZWQgdG8gdGhlIHdvcmRzLiBGb3Igb25lLWxpbmUgZGVzY3JpcHRpb25zLiAqL1xuZnVuY3Rpb24gcGxhaW5UZXh0KG1hcmtkb3duOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbWFya2Rvd25cbiAgICAucmVwbGFjZSgvYChbXmBdKylgL2csICckMScpXG4gICAgLnJlcGxhY2UoL1xcWyhbXlxcXV0rKVxcXVxcKFteKV0qXFwpL2csICckMScpXG4gICAgLnJlcGxhY2UoL1xcKlxcKihbXipdKylcXCpcXCovZywgJyQxJylcbiAgICAucmVwbGFjZSgvXFwqKFteKl0rKVxcKi9nLCAnJDEnKVxuICAgIC5yZXBsYWNlKC9fKFteX10rKV8vZywgJyQxJylcbiAgICAucmVwbGFjZSgvXFxzKy9nLCAnICcpXG4gICAgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBUaGUgcGFnZSdzIG9uZS1saW5lIGRlc2NyaXB0aW9uOiBpdHMgYGRlc2NyaXB0aW9uYCBmcm9udG1hdHRlciwgZWxzZSBpdHNcbiAqIGZpcnN0IHBhcmFncmFwaCBvZiBhY3R1YWwgcHJvc2UgXHUyMDE0IHNraXBwaW5nIGhlYWRpbmdzLCBjb250YWluZXJzLCBjb2RlLFxuICogY29tcG9uZW50cyBhbmQgdGFibGVzLCBhbGwgb2Ygd2hpY2ggZGVzY3JpYmUgbm90aGluZyBvbiB0aGVpciBvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZShyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHsgZnJvbnRtYXR0ZXIsIGJvZHkgfSA9IHNwbGl0RnJvbnRtYXR0ZXIocmF3KTtcbiAgY29uc3QgZGVjbGFyZWQgPSBmcm9udG1hdHRlckRlc2NyaXB0aW9uKGZyb250bWF0dGVyKTtcbiAgaWYgKGRlY2xhcmVkKSByZXR1cm4gZGVjbGFyZWQ7XG5cbiAgbGV0IHBhcmFncmFwaCA9ICcnO1xuICBsZXQgaW5GZW5jZSA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgYm9keS5zcGxpdCgnXFxuJykpIHtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKCdgYGAnKSkge1xuICAgICAgaW5GZW5jZSA9ICFpbkZlbmNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpbkZlbmNlKSBjb250aW51ZTtcbiAgICAvLyBBIGJsb2NrcXVvdGUncyBwcm9zZSBpcyBwcm9zZTsgdGhlIG1hcmtlciBpcyBub3QgcGFydCBvZiBpdC5cbiAgICBjb25zdCB0ZXh0ID0gbGluZS5yZXBsYWNlKC9eXFxzKj5cXHM/LywgJycpO1xuICAgIGlmICghdGV4dC50cmltKCkpIHtcbiAgICAgIGlmIChwYXJhZ3JhcGgpIGJyZWFrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIC8vIEEgdGFibGUsIGEgbGlzdCwgYSBjb250YWluZXIsIGEgaGVhZGluZyBvciBhIGNvbXBvbmVudCBpcyBub3QgYSBkZXNjcmlwdGlvbi5cbiAgICBpZiAoL15cXHMqKCN8Ojo6fFxcfHxbLSorXVxcc3xcXGQrXFwuXFxzfDwpLy50ZXN0KHRleHQpKSB7XG4gICAgICBpZiAocGFyYWdyYXBoKSBicmVhaztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBwYXJhZ3JhcGggKz0gKHBhcmFncmFwaCA/ICcgJyA6ICcnKSArIHRleHQudHJpbSgpO1xuICB9XG5cbiAgY29uc3QgdGV4dCA9IHBsYWluVGV4dChwYXJhZ3JhcGgpO1xuICBpZiAoIXRleHQpIHJldHVybiAnJztcblxuICAvLyBPbmUgc2VudGVuY2UsIGFuZCBuZXZlciBhIHJ1bmF3YXkuIFByZWZlciBhIHNlbnRlbmNlIGJvdW5kYXJ5LCB0aGVuIGFcbiAgLy8gY2xhdXNlLCB0aGVuIGEgaGFyZCBjdXQgXHUyMDE0IGFuIGluZGV4IGxpbmUgdGhhdCB3cmFwcyB0d2ljZSBpcyBub3QgYW4gaW5kZXguXG4gIGlmICh0ZXh0Lmxlbmd0aCA8PSAyMDApIHJldHVybiB0ZXh0O1xuICBjb25zdCBzZW50ZW5jZSA9IHRleHQuc2xpY2UoMCwgMjAwKS5sYXN0SW5kZXhPZignLiAnKTtcbiAgaWYgKHNlbnRlbmNlID4gODApIHJldHVybiB0ZXh0LnNsaWNlKDAsIHNlbnRlbmNlICsgMSk7XG4gIGNvbnN0IGNsYXVzZSA9IHRleHQuc2xpY2UoMCwgMjAwKS5sYXN0SW5kZXhPZignIFx1MjAxNCAnKTtcbiAgaWYgKGNsYXVzZSA+IDgwKSByZXR1cm4gYCR7dGV4dC5zbGljZSgwLCBjbGF1c2UpfVx1MjAyNmA7XG4gIHJldHVybiBgJHt0ZXh0LnNsaWNlKDAsIHRleHQuc2xpY2UoMCwgMjAwKS5sYXN0SW5kZXhPZignICcpKX1cdTIwMjZgO1xufVxuXG4vKipcbiAqIFJld3JpdGUgYSBzaXRlLWFic29sdXRlIGRvY3MgbGluayB0byBpdHMgbWFya2Rvd24gdHdpbidzIGFic29sdXRlIFVSTCwgc28gYW5cbiAqIGFnZW50IGZvbGxvd2luZyBhIGxpbmsgaW5zaWRlIGEgdHdpbiBnZXRzIG1hcmtkb3duIHJhdGhlciB0aGFuIEhUTUwuXG4gKiBgL2NvbmNlcHRzL21vZGVsI2V2ZW50c2AgXHUyMTkyIGBodHRwczovL3N1YnN0cmF0Lm5ldC9jb25jZXB0cy9tb2RlbC5tZCNldmVudHNgLlxuICovXG5mdW5jdGlvbiB0d2luVXJsKGxpbms6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IFtwYXRoLCBoYXNoXSA9IGxpbmsuc3BsaXQoJyMnKTtcbiAgY29uc3Qgc3VmZml4ID0gaGFzaCA/IGAjJHtoYXNofWAgOiAnJztcbiAgLy8gQSBsaW5rIHRoYXQgYWxyZWFkeSBuYW1lcyBhIGZpbGUgXHUyMDE0IGAvbGxtcy50eHRgLCBhbiBhc3NldCwgYSBwYWdlJ3Mgb3duIHR3aW4gXHUyMDE0XG4gIC8vIGlzIGEgZGVzdGluYXRpb24sIG5vdCBhIGRvY3Mgcm91dGUuIEFic29sdXRpemUgaXQgYW5kIGxlYXZlIGl0IGFsb25lLlxuICBpZiAoL1xcLlthLXowLTldKyQvaS50ZXN0KHBhdGgpKSByZXR1cm4gYCR7U0lURX0ke3BhdGh9JHtzdWZmaXh9YDtcbiAgcmV0dXJuIGAke1NJVEV9LyR7ZmlsZUZvckxpbmsocGF0aCl9JHtzdWZmaXh9YDtcbn1cblxuLyoqXG4gKiBBIGNvbXBvbmVudCBvbiBhIGxpbmUgb2YgaXRzIG93bjogYDxMYXllclN0YWNrIC8+YCwgYDxTdGF0ZU1hY2hpbmUgZW5naW5lPVwiYm9va2luZ1wiIC8+YC5cbiAqXG4gKiBQcm9wcyBhcmUgcGFydCBvZiB0aGUgbWF0Y2ggYmVjYXVzZSBvbmUgY29tcG9uZW50IGNhbiBzZXJ2ZSBtYW55IHBhZ2VzIFx1MjAxNCB0aGVcbiAqIGZpdmUgZW5naW5lIHN0YXRlIG1hY2hpbmVzIGFyZSBvbmUgY29tcG9uZW50IGFuZCBmaXZlIHByb3BzLiBgdG9vbHMvbGxtcy1pbmRleC5tdHNgXG4gKiBtYXRjaGVzIHdpdGggdGhlIHNhbWUgcGF0dGVybiwgc28gYSBwYWdlIGl0IHBhc3NlcyBpcyBhIHBhZ2UgdGhpcyBjYW4gZmxhdHRlbi5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTVBPTkVOVF9MSU5FID0gL148KFtBLVpdXFx3KikoKD86XFxzK1thLXpdW1xcdy1dKj1cIlteXCJdKlwiKSopXFxzKlxcLz4kLztcblxuLyoqIGBlbmdpbmU9XCJib29raW5nXCJgIFx1MjE5MiBgeyBlbmdpbmU6ICdib29raW5nJyB9YC4gU3RyaW5nIHByb3BzIG9ubHksIGJ5IGRlc2lnbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcm9wc09mKGF0dHJzOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgWywgaywgdl0gb2YgYXR0cnMubWF0Y2hBbGwoLyhbYS16XVtcXHctXSopPVwiKFteXCJdKilcIi9nKSkgb3V0W2tdID0gdjtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBIb3cgYSBgPENvbXBvbmVudCAvPmAgbGluZSBpcyByZW5kZXJlZCBpbnRvIHRoZSB0d2luLlxuICpcbiAqIFRoZSBkZWZhdWx0IGZsYXR0ZW5zIGl0IHRvIHRoZSBwcm9zZSBpbiBpdHMgYCouY29udGVudC5tdHNgLCB3aGljaCBpcyB3aGF0IGV2ZXJ5XG4gKiBtYXJrZG93biB0d2luIHdhbnRzLiBUaGUgRVBVQiBwYXNzZXMgb25lIHRoYXQgcmV0dXJucyB0aGUgY29tcG9uZW50J3Mgb3duXG4gKiBzZXJ2ZXItcmVuZGVyZWQgZmlndXJlIGluc3RlYWQgKGAudml0ZXByZXNzL2ZpZ3VyZXMubXRzYCksIGJlY2F1c2UgYSByZWFkZXJcbiAqIGhvbGRpbmcgYSBwaG9uZSBzaG91bGQgZ2V0IHRoZSBwaWN0dXJlIHRoZSB3ZWIgcGFnZSBkcmF3cy5cbiAqL1xuZXhwb3J0IHR5cGUgQ29tcG9uZW50VHdpbiA9IChuYW1lOiBzdHJpbmcsIHByb3BzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSA9PiBzdHJpbmc7XG5cbi8qKiBUaGUgZGVmYXVsdDogdGhlIGNvbXBvbmVudCdzIHByb3NlIHR3aW4sIG9yIGEgcG9pbnRlciBhdCB0aGUgcGFnZSB3aGVuIGl0IGhhcyBub25lLiAqL1xuZXhwb3J0IGNvbnN0IGFsdFR3aW46IENvbXBvbmVudFR3aW4gPSAobmFtZSwgcHJvcHMpID0+XG4gIGFsdEZvcihuYW1lLCBwcm9wcykgPz9cbiAgYCooRGlhZ3JhbTogJHtuYW1lfSBcdTIwMTQgcmVuZGVyZWQgYXQgdGhlIEhUTUwgcGFnZSBmb3IgdGhpcyBkb2N1bWVudC4pKmA7XG5cbi8qKlxuICogU291cmNlIG1hcmtkb3duIFx1MjE5MiB0aGUgdHdpbiBhbiBhZ2VudCBzaG91bGQgcmVhZC5cbiAqXG4gKiBWaXRlUHJlc3MgY29udGFpbmVycyBiZWNvbWUgYmxvY2txdW90ZXMgKHRoZSBjbG9zZXN0IG1hcmtkb3duIGhhcyB0byBhblxuICogYXNpZGUsIGFuZCBpdCBrZWVwcyB0aGUgbGFiZWwgdGhhdCBjYXJyaWVzIHRoZSB3YXJuaW5nKS4gVGhlbWUgY29tcG9uZW50cyBhcmVcbiAqIGZsYXR0ZW5lZCBieSBgYWx0Rm9yYCB3aGVuIHRoZXkgY2FycnkgcHJvc2UgXHUyMDE0IHdoaWNoIGJvdGggb2Ygb3VycyBkbywgb3V0IG9mXG4gKiBwbGFpbiBhcnJheXMgXHUyMDE0IGFuZCBmYWxsIGJhY2sgdG8gYSBwb2ludGVyIGF0IHRoZSByZW5kZXJlZCBwYWdlIG9ubHkgd2hlbiB0aGVyZVxuICogaXMgZ2VudWluZWx5IG5vdGhpbmcgdG8gZmxhdHRlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvVHdpbihcbiAgcmF3OiBzdHJpbmcsXG4gIHNyY0Rpcj86IHN0cmluZyxcbiAgY29tcG9uZW50OiBDb21wb25lbnRUd2luID0gYWx0VHdpbixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHsgYm9keSB9ID0gc3BsaXRGcm9udG1hdHRlcihyYXcpO1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBpbkZlbmNlID0gZmFsc2U7XG4gIGxldCBpbkNvbnRhaW5lciA9IGZhbHNlO1xuXG4gIC8qKiBJbnNpZGUgYSBjb250YWluZXIgZXZlcnkgbGluZSBjYXJyaWVzIHRoZSBibG9ja3F1b3RlIG1hcmtlciwgZmVuY2VzIGluY2x1ZGVkLiAqL1xuICBjb25zdCBwdXNoID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIGlmICghaW5Db250YWluZXIpIHJldHVybiBvdXQucHVzaChsaW5lKTtcbiAgICByZXR1cm4gb3V0LnB1c2gobGluZS50cmltKCkgPyBgPiAke2xpbmV9YCA6ICc+Jyk7XG4gIH07XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJvZHkuc3BsaXQoJ1xcbicpKSB7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnYGBgJykpIHtcbiAgICAgIGluRmVuY2UgPSAhaW5GZW5jZTtcbiAgICAgIHB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGluRmVuY2UpIHtcbiAgICAgIHB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBBIGZpbGUgdGhlIHBhZ2UgcHVsbHMgaW4gYXQgYnVpbGQgdGltZS4gVGhlIHJlbmRlcmVkIHBhZ2UgcmVzb2x2ZXMgaXQ7IHRoZVxuICAgIC8vIHR3aW4gaGFzIHRvIGFzIHdlbGwsIG9yIGEgd2Fsa3Rocm91Z2ggdGhhdCBleGlzdHMgdG8gc2hvdyB3aG9sZSBmaWxlcyBoYW5kc1xuICAgIC8vIGFuIGFnZW50IGEgcGFnZSBvZiBwb2ludGVycy5cbiAgICBjb25zdCBwdWxsZWQgPSBwdWxsZWRJbihsaW5lLCBzcmNEaXIpO1xuICAgIGlmIChwdWxsZWQpIHtcbiAgICAgIGZvciAoY29uc3QgbCBvZiBwdWxsZWQpIHB1c2gobCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoIWluQ29udGFpbmVyKSB7XG4gICAgICBjb25zdCBvcGVuID0gL146OjorXFxzKihcXHdbXFx3LV0qKVxccyooLiopJC8uZXhlYyhsaW5lKTtcbiAgICAgIGlmIChvcGVuKSB7XG4gICAgICAgIGNvbnN0IFssIHR5cGUsIHRpdGxlXSA9IG9wZW47XG4gICAgICAgIGNvbnN0IGxhYmVsID0gdHlwZS5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHR5cGUuc2xpY2UoMSk7XG4gICAgICAgIG91dC5wdXNoKCcnLCBgPiAqKiR7bGFiZWx9JHt0aXRsZS50cmltKCkgPyBgIFx1MjAxNCAke3RpdGxlLnRyaW0oKX1gIDogJyd9KipgLCAnPicpO1xuICAgICAgICBpbkNvbnRhaW5lciA9IHRydWU7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoL146OjorXFxzKiQvLnRlc3QobGluZSkpIHtcbiAgICAgIGluQ29udGFpbmVyID0gZmFsc2U7XG4gICAgICBvdXQucHVzaCgnJyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBBIHRoZW1lIGNvbXBvbmVudCBvbiBhIGxpbmUgb2YgaXRzIG93biwgd2l0aCBvciB3aXRob3V0IHNpbXBsZSBzdHJpbmdcbiAgICAvLyBwcm9wcy4gV2hhdCBpdCBiZWNvbWVzIGlzIHRoZSBjYWxsZXIncyBkZWNpc2lvbiBcdTIwMTQgcHJvc2UgYnkgZGVmYXVsdCAoc2VlXG4gICAgLy8gYGFsdFR3aW5gKSwgdGhlIHJlbmRlcmVkIGZpZ3VyZSBmb3IgdGhlIEVQVUIuXG4gICAgY29uc3QgbWF0Y2ggPSBDT01QT05FTlRfTElORS5leGVjKGxpbmUudHJpbSgpKTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIHB1c2goY29tcG9uZW50KG1hdGNoWzFdISwgcHJvcHNPZihtYXRjaFsyXSA/PyAnJykpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHB1c2gobGluZSk7XG4gIH1cblxuICAvLyBBIHJhdyBgPGEgaHJlZj1cIlx1MjAyNlwiIHRhcmdldD1cIlx1MjAyNlwiPmAgaXMgaG93IGEgcGFnZSBlc2NhcGVzIFZpdGVQcmVzcydzIFNQQSByb3V0ZXIgZm9yXG4gIC8vIGEgcm91dGUgdGhlIHJvdXRlciBkb2VzIG5vdCBoYXZlIChib29rL2luZGV4Lm1kIGlzIHRoZSBvbmUgY2FzZSkuIEEgZmlsZSBoYXMgbm9cbiAgLy8gcm91dGVyIHRvIGVzY2FwZSwgc28gdGhlIHR3aW4gZ2V0cyB0aGUgbWFya2Rvd24gbGluayBiYWNrIFx1MjAxNCBhbmQgdGhlbiB0aGUgcmV3cml0ZVxuICAvLyBiZWxvdyBhYnNvbHV0aXplcyBpdCBleGFjdGx5IGFzIGlmIGl0IGhhZCBiZWVuIHdyaXR0ZW4gdGhhdCB3YXkuXG4gIGNvbnN0IHVuYW5jaG9yZWQgPSBvdXRcbiAgICAuam9pbignXFxuJylcbiAgICAucmVwbGFjZSgvPGFcXHMraHJlZj1cIihbXlwiXSspXCJbXj5dKj4oW148XSopPFxcL2E+L2csIChfbSwgaHJlZjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+XG4gICAgICBgWyR7dGV4dH1dKCR7aHJlZn0pYCxcbiAgICApO1xuXG4gIC8vIEludGVybmFsIGxpbmtzIHBvaW50IGF0IEhUTUwgcm91dGVzOyBhbiBhZ2VudCByZWFkaW5nIG1hcmtkb3duIHdhbnRzIG1hcmtkb3duLlxuICBjb25zdCBsaW5rZWQgPSB1bmFuY2hvcmVkLnJlcGxhY2UoXG4gICAgL1xcXVxcKChcXC9bXilcXHNdKilcXCkvZyxcbiAgICAoX20sIGxpbms6IHN0cmluZykgPT4gYF0oJHt0d2luVXJsKGxpbmspfSlgLFxuICApO1xuXG4gIHJldHVybiBgJHtjb2xsYXBzZUJsYW5rUnVucyhsaW5rZWQpLnRyaW1FbmQoKX1cXG5gO1xufVxuXG4vKipcbiAqIFZpdGVQcmVzcydzIHNuaXBwZXQgaW1wb3J0LCBpbiBmdWxsOiBgPDw8IHBhdGhbI3JlZ2lvbl1be21ldGF9XSBbdGl0bGVdYCwgd2hlcmVcbiAqIGBtZXRhYCBpcyBhbnkgb2YgbGluZSBoaWdobGlnaHRzLCBhIGxhbmd1YWdlLCBgOmxpbmUtbnVtYmVyc2AgXHUyMDE0IGB7MSwzLTUgdHM6bGluZS1udW1iZXJzfWAuXG4gKi9cbmNvbnN0IFNOSVBQRVQgPSAvXjw8PFxccyooXFxTKz8pKCNbXFx3Ki1dKyk/KD86XFx7KFtefV0qKVxcfSk/KD86XFxzK1xcW1teXFxdXSpcXF0pP1xccyokLztcbi8qKlxuICogVml0ZVByZXNzJ3MgbWFya2Rvd24gaW5jbHVkZSwgaW4gZnVsbDogYDwhLS1AaW5jbHVkZTogcGF0aFsjcmVnaW9uXVt7ZnJvbSx0b31dLS0+YCxcbiAqIHRoZSByYW5nZSAxLWJhc2VkIGFuZCBlaXRoZXIgZW5kIG9wZW4uXG4gKi9cbmNvbnN0IElOQ0xVREUgPSAvXjwhLS1AaW5jbHVkZTpcXHMqKFxcUys/KSgjW1xcdy1dKyk/KD86XFx7KFxcZCopLChcXGQqKVxcfSk/XFxzKi0tPiQvO1xuXG4vKipcbiAqIFRoZSBsaW5lcyBhIHNuaXBwZXQgb3IgaW5jbHVkZSBzdGFuZHMgZm9yICgjNzQxKSwgb3IgYHVuZGVmaW5lZGAgZm9yIGFueSBvdGhlclxuICogbGluZS4gYEAvYCBpcyB0aGUgZG9jcyBzb3VyY2UgZGlyZWN0b3J5LCBleGFjdGx5IGFzIFZpdGVQcmVzcyByZXNvbHZlcyBpdCwgc29cbiAqIGEgd2Fsa3Rocm91Z2ggcHVsbGluZyBgQC8uLi8uLi9kZW1vcy90b2RvL3NwZWMvbW9kZWwudHNgIGludG8gdGhlIHBhZ2UgcHVsbHNcbiAqIHRoZSBzYW1lIGZpbGUgaW50byB0aGUgdHdpbi4gQSBzbmlwcGV0IGJlY29tZXMgYSBmZW5jZSB0YWdnZWQgYnkgaXRzIGV4cGxpY2l0XG4gKiBsYW5ndWFnZSBvciBlbHNlIGl0cyBleHRlbnNpb247IGFuIGluY2x1ZGUgaXMgc3BsaWNlZCBpbiBhcyB0aGUgbWFya2Rvd24gaXRcbiAqIGlzLCBob25vdXJpbmcgdGhlIGxpbmUgcmFuZ2UuXG4gKlxuICogV2hhdCB0aGUgcmVuZGVyZWQgcGFnZSBjYW4gZG8gYW5kIHRoZSB0d2luIGRvZXMgbm90LCB0aGUgdHdpbiAqKnJlZnVzZXMqKlxuICogcmF0aGVyIHRoYW4gYXBwcm94aW1hdGVzOiBhIGAjcmVnaW9uYCBzZWxlY3RvciAoVml0ZVByZXNzJ3MgbWFya2VyIGdyYW1tYXIgaXNcbiAqIG5vdCB3b3J0aCBhIHNlY29uZCBpbXBsZW1lbnRhdGlvbiksIGEgcGF0aCByZWxhdGl2ZSB0byB0aGUgcGFnZSByYXRoZXIgdGhhblxuICogYEAvYCAodGhpcyBmdW5jdGlvbiBkb2VzIG5vdCBrbm93IHRoZSBwYWdlKSwgb3IgYSBkaXJlY3RpdmUgaXQgY2Fubm90IHBhcnNlXG4gKiBhdCBhbGwuIFJlYWRpbmcgdGhlIHdob2xlIGZpbGUgd2hlcmUgdGhlIHBhZ2Ugc2hvd3MgYSByZWdpb24gd291bGQgaGFuZCBhblxuICogYWdlbnQgYSB0d2luIHRoYXQgcXVpZXRseSBkaWZmZXJzIGZyb20gdGhlIHBhZ2UsIGFuZCB0aGlzIHJ1bnMgdW5kZXJcbiAqIGBsaW50OmxsbXMgLS1jaGVja2AsIHNvIHRoZSByZWZ1c2FsIGlzIGEgcmVkIFBSIHJhdGhlciB0aGFuIGEgd3JvbmcgYXJ0aWZhY3QuXG4gKiBMaW5lIGhpZ2hsaWdodHMgYW5kIGxpbmUgbnVtYmVycyBhcmUgcHJlc2VudGF0aW9uIGFuZCBhcmUgZHJvcHBlZCBvbiBwdXJwb3NlLlxuICpcbiAqIFdpdGhvdXQgYSBzb3VyY2UgZGlyZWN0b3J5IChhIGNhbGxlciB3aXRoIG9ubHkgdGhlIHRleHQpIHRoZSBsaW5lIGlzIGtlcHQgYXNcbiAqIHdyaXR0ZW4sIHdoaWNoIGlzIHdoYXQgdGhlIHR3aW4gZGlkIGJlZm9yZSBhbmQgaXMgc3RpbGwgdGhlIGhvbmVzdCBmYWxsYmFjay5cbiAqL1xuZnVuY3Rpb24gcHVsbGVkSW4obGluZTogc3RyaW5nLCBzcmNEaXI6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFzcmNEaXIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGRpcmVjdGl2ZSA9IGxpbmUudHJpbSgpO1xuICBjb25zdCBpc1NuaXBwZXQgPSBkaXJlY3RpdmUuc3RhcnRzV2l0aCgnPDw8Jyk7XG4gIGNvbnN0IGlzSW5jbHVkZSA9IGRpcmVjdGl2ZS5zdGFydHNXaXRoKCc8IS0tQGluY2x1ZGU6Jyk7XG4gIGlmICghaXNTbmlwcGV0ICYmICFpc0luY2x1ZGUpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgcmVmdXNlID0gKHdoeTogc3RyaW5nKTogbmV2ZXIgPT4ge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBUaGUgbGxtcyB0d2luIGNhbm5vdCByZXByb2R1Y2UgXFxgJHtkaXJlY3RpdmV9XFxgOiAke3doeX0uXFxuYCArXG4gICAgICAgIGBTdXBwb3J0ZWQ6IFxcYDw8PCBAL3BhdGhbe2xhbmd9XVxcYCBhbmQgXFxgPCEtLUBpbmNsdWRlOiBAL3BhdGhbe2Zyb20sdG99XS0tPlxcYC5gLFxuICAgICk7XG4gIH07XG4gIGNvbnN0IGZpbGVPZiA9IChwYXRoOiBzdHJpbmcsIHJlZ2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nID0+IHtcbiAgICBpZiAocmVnaW9uKSByZWZ1c2UoYFxcYCR7cmVnaW9ufVxcYCBzZWxlY3RzIGEgcmVnaW9uLCBhbmQgdGhlIHR3aW4gcHVsbHMgd2hvbGUgZmlsZXMgb3IgbGluZSByYW5nZXMgb25seWApO1xuICAgIGlmICghcGF0aC5zdGFydHNXaXRoKCdALycpKSByZWZ1c2UoJ3RoZSBwYXRoIG11c3QgYmUgYEAvXHUyMDI2YCwgcmVsYXRpdmUgdG8gdGhlIGRvY3Mgc291cmNlIGRpcmVjdG9yeScpO1xuICAgIHJldHVybiByZXNvbHZlKHNyY0RpciwgcGF0aC5zbGljZSgyKSk7XG4gIH07XG5cbiAgaWYgKGlzU25pcHBldCkge1xuICAgIGNvbnN0IHNuaXBwZXQgPSBTTklQUEVULmV4ZWMoZGlyZWN0aXZlKTtcbiAgICBpZiAoIXNuaXBwZXQpIHJlZnVzZSgnaXQgaXMgbm90IGEgc25pcHBldCBpbXBvcnQgdGhlIHR3aW4gY2FuIHBhcnNlJyk7XG4gICAgY29uc3QgWywgcGF0aCwgcmVnaW9uLCBtZXRhXSA9IHNuaXBwZXQhO1xuICAgIGNvbnN0IGZpbGUgPSBmaWxlT2YocGF0aCEsIHJlZ2lvbik7XG4gICAgY29uc3QgbGFuZyA9IGxhbmd1YWdlT2YobWV0YSkgPz8gZXh0bmFtZShmaWxlKS5zbGljZSgxKTtcbiAgICByZXR1cm4gW2BcXGBcXGBcXGAke2xhbmd9YCwgcmVhZEZpbGVTeW5jKGZpbGUsICd1dGY4JykudHJpbUVuZCgpLCAnYGBgJ107XG4gIH1cblxuICBjb25zdCBpbmNsdWRlID0gSU5DTFVERS5leGVjKGRpcmVjdGl2ZSk7XG4gIGlmICghaW5jbHVkZSkgcmVmdXNlKCdpdCBpcyBub3QgYSBtYXJrZG93biBpbmNsdWRlIHRoZSB0d2luIGNhbiBwYXJzZScpO1xuICBjb25zdCBbLCBwYXRoLCByZWdpb24sIGZyb21UZXh0LCB0b1RleHRdID0gaW5jbHVkZSE7XG4gIGNvbnN0IGxpbmVzID0gcmVhZEZpbGVTeW5jKGZpbGVPZihwYXRoISwgcmVnaW9uKSwgJ3V0ZjgnKS50cmltRW5kKCkuc3BsaXQoJ1xcbicpO1xuICBjb25zdCBmcm9tID0gZnJvbVRleHQgPyBOdW1iZXIoZnJvbVRleHQpIDogMTtcbiAgY29uc3QgdG8gPSB0b1RleHQgPyBOdW1iZXIodG9UZXh0KSA6IGxpbmVzLmxlbmd0aDtcbiAgcmV0dXJuIGxpbmVzLnNsaWNlKGZyb20gLSAxLCB0byk7XG59XG5cbi8qKlxuICogVGhlIGxhbmd1YWdlIGEgc25pcHBldCdzIGB7bWV0YX1gIG5hbWVzLCBpZiBhbnk6IHRoZSB0b2tlbiB0aGF0IGlzIG5vdCBhIGxpbmVcbiAqIGhpZ2hsaWdodCAoYDEsMy01YCksIHNob3JuIG9mIGl0cyBgOmxpbmUtbnVtYmVyc2AgZmxhZyBcdTIwMTQgYHsyIHRzOmxpbmUtbnVtYmVyc31gXG4gKiBpcyBgdHNgLiBWaXRlUHJlc3MgZmFsbHMgYmFjayB0byB0aGUgZXh0ZW5zaW9uIHdoZW4gdGhlcmUgaXMgbm9uZTsgc28gZG8gd2UuXG4gKi9cbmZ1bmN0aW9uIGxhbmd1YWdlT2YobWV0YTogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFtZXRhKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCB3b3JkID0gbWV0YVxuICAgIC5zcGxpdCgvXFxzKy8pXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5maW5kKCh0b2tlbikgPT4gIS9eW1xcZCwtXSskLy50ZXN0KHRva2VuKSk7XG4gIGNvbnN0IGxhbmcgPSB3b3JkPy5yZXBsYWNlKC86KD86bm8tKT9saW5lLW51bWJlcnMoPzo9XFxkKyk/JC8sICcnKTtcbiAgcmV0dXJuIGxhbmcgfHwgdW5kZWZpbmVkO1xufVxuXG4vKiogVGhyZWUgYmxhbmsgbGluZXMgaW4gYSByb3cgaXMgYW4gYXJ0aWZhY3Qgb2Ygc3RyaXBwaW5nLCBub3QgYXV0aG9yaWFsIGludGVudC4gKi9cbmZ1bmN0aW9uIGNvbGxhcHNlQmxhbmtSdW5zKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1xcbnszLH0vZywgJ1xcblxcbicpO1xufVxuXG4vKiogVGhlIHBhZ2UncyBIMSwgZm9yIHRoZSBjb25jYXRlbmF0ZWQgZmlsZSdzIHNlY3Rpb24gaGVhZGVycy4gKi9cbmZ1bmN0aW9uIHRpdGxlT2YocmF3OiBzdHJpbmcsIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB7IGJvZHkgfSA9IHNwbGl0RnJvbnRtYXR0ZXIocmF3KTtcbiAgY29uc3QgaDEgPSBib2R5LnNwbGl0KCdcXG4nKS5maW5kKChsKSA9PiBsLnN0YXJ0c1dpdGgoJyMgJykpO1xuICByZXR1cm4gaDEgPyBwbGFpblRleHQoaDEuc2xpY2UoMikpIDogZmFsbGJhY2s7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXJ0aWZhY3Qge1xuICAvKiogUGF0aCByZWxhdGl2ZSB0byB0aGUgc2l0ZSByb290OiBgbGxtcy50eHRgLCBgY29uY2VwdHMvbW9kZWwubWRgLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGF0IHRvIHdyaXRlLiBgVWludDhBcnJheWAgZm9yIGEgYmluYXJ5IGFydGlmYWN0IFx1MjAxNCB0aGUgRVBVQiBlZGl0aW9uIG9mIHRoZSBib29rXG4gICAqIChlcHViLm10cykgaXMgYSB6aXAsIGFuZCBgd3JpdGVGaWxlU3luY2AgdGFrZXMgZWl0aGVyIHdpdGhvdXQgYSBicmFuY2ggaGVyZS5cbiAgICovXG4gIGNvbnRlbnRzOiBzdHJpbmcgfCBVaW50OEFycmF5O1xufVxuXG4vKiogVGhlIGZ1bGwgbmFtZSBvZiBhIHBhZ2UgaW4gdGhlIGluZGV4OiBgV29yayBvcmRlcnMgXHUyMDNBIEV2ZW50c2AuICovXG5mdW5jdGlvbiBpbmRleExhYmVsKHBhZ2U6IEluZGV4ZWRQYWdlKTogc3RyaW5nIHtcbiAgcmV0dXJuIHBhZ2UuZ3JvdXAgPyBgJHtwYWdlLmdyb3VwfSBcdTIwM0EgJHtwYWdlLnRleHR9YCA6IHBhZ2UudGV4dDtcbn1cblxuLyoqXG4gKiBCdWlsZCBldmVyeSBhcnRpZmFjdCBmcm9tIHRoZSBkb2NzIHNvdXJjZS4gUHVyZTogdGFrZXMgdGhlIHNvdXJjZSBkaXJlY3RvcnksXG4gKiByZXR1cm5zIHdoYXQgc2hvdWxkIGJlIHdyaXR0ZW4uIGBlbWl0YCB3cml0ZXMgdGhlbSwgYC0tY2hlY2tgIGNvbXBhcmVzIHRoZW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEFydGlmYWN0cyhzcmNEaXI6IHN0cmluZywgcmVwb1Jvb3Q6IHN0cmluZyk6IEFydGlmYWN0W10ge1xuICBjb25zdCB2ZXJzaW9uID0ga2VybmVsVmVyc2lvbihyZXBvUm9vdCk7XG4gIGNvbnN0IHNlY3Rpb25zID0gdGFibGVPZkNvbnRlbnRzKCk7XG4gIGNvbnN0IGFydGlmYWN0czogQXJ0aWZhY3RbXSA9IFtdO1xuXG4gIGNvbnN0IG1pc3Npbmc6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHBhZ2VzID0gbmV3IE1hcDxzdHJpbmcsIHsgcGFnZTogSW5kZXhlZFBhZ2U7IHJhdzogc3RyaW5nIH0+KCk7XG4gIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgIGZvciAoY29uc3QgcGFnZSBvZiBzZWN0aW9uLnBhZ2VzKSB7XG4gICAgICBjb25zdCBmaWxlID0gam9pbihzcmNEaXIsIHBhZ2UuZmlsZSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoZmlsZSkpIHtcbiAgICAgICAgbWlzc2luZy5wdXNoKHBhZ2UuZmlsZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgcGFnZXMuc2V0KHBhZ2UubGluaywgeyBwYWdlLCByYXc6IHJlYWRGaWxlU3luYyhmaWxlLCAndXRmOCcpIH0pO1xuICAgIH1cbiAgfVxuICBpZiAobWlzc2luZy5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVGhlIHNpZGViYXIgbmFtZXMgJHttaXNzaW5nLmxlbmd0aH0gcGFnZShzKSB3aXRoIG5vIHNvdXJjZSBmaWxlOlxcbiAgJHttaXNzaW5nLmpvaW4oJ1xcbiAgJyl9YCxcbiAgICApO1xuICB9XG4gIC8vIFRoZSBpbmRleCBwcm9tb3RlcyB0aGlzIHBhZ2UgYWJvdmUgZXZlcnl0aGluZyBlbHNlIGl0IGxpc3RzLCBzbyBhIHJlbmFtZSB0aGF0XG4gIC8vIGxlZnQgdGhlIHByb21vdGlvbiBiZWhpbmQgd291bGQgcHVibGlzaCBhIDQwNCBhcyB0aGUgZmlyc3QgdGhpbmcgYW4gYWdlbnQgcmVhZHMuXG4gIGlmICghcGFnZXMuaGFzKFNUQVJUX0hFUkUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGxsbXMudHh0IHByb21vdGVzICR7U1RBUlRfSEVSRX0gYXMgdGhlIHBhZ2UgdG8gcmVhZCBmaXJzdCwgYnV0IG5vIHNpZGViYXIgZW50cnkgYCArXG4gICAgICAgIGBwb2ludHMgdGhlcmUuIFVwZGF0ZSBTVEFSVF9IRVJFIGluIHNpZGViYXIubXRzLCBvciByZXN0b3JlIHRoZSBwYWdlLmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFRoZSB0d2lucy5cbiAgZm9yIChjb25zdCB7IHBhZ2UsIHJhdyB9IG9mIHBhZ2VzLnZhbHVlcygpKSB7XG4gICAgYXJ0aWZhY3RzLnB1c2goeyBwYXRoOiBwYWdlLmZpbGUsIGNvbnRlbnRzOiB0b1R3aW4ocmF3LCBzcmNEaXIpIH0pO1xuICB9XG5cbiAgLy8gVGhlIGluZGV4LlxuICBjb25zdCBpbmRleDogc3RyaW5nW10gPSBbXG4gICAgJyMgU3Vic3RyYXQnLFxuICAgICcnLFxuICAgIGA+ICR7VEFHTElORX1gLFxuICAgICcnLFxuICAgICcjIyBXaGF0IFN1YnN0cmF0IGlzJyxcbiAgICAnJyxcbiAgICAnU3Vic3RyYXQgaG9zdHMgdGhlIHBhcnRzIG9mIGEgYnVzaW5lc3MgYXBwbGljYXRpb24gdGhhdCBhcmUgY2F0YXN0cm9waGljIHRvIGdldCB3cm9uZyBcdTIwMTQnLFxuICAgICdtdWx0aS10ZW5hbmN5LCBwZXJtaXNzaW9ucywgYXVkaXQsIG1pZ3JhdGlvbnMgXHUyMDE0IGFuZCBlbmZvcmNlcyB0aGVtICoqYXQgcnVudGltZSoqLCBpbiB0aGUnLFxuICAgICdwbGF0Zm9ybS4gVGhhdCBpcyB0aGUgd2hvbGUgZGlzdGluY3Rpb246IGEgdGVtcGxhdGUgaGFuZHMgeW91IGNvcnJlY3QgY29kZSBvbmNlIGFuZCBldmVyeScsXG4gICAgJ2VkaXQgYWZ0ZXIgZXJvZGVzIGl0LCB3aGVyZWFzIGhlcmUgYSB2ZXJ0aWNhbCAqY2Fubm90KiBxdWVyeSBhY3Jvc3MgdGVuYW50cyBvciBza2lwIGEnLFxuICAgICdwZXJtaXNzaW9uIGNoZWNrLCBiZWNhdXNlIHRoZSBrZXJuZWwgd2lsbCBub3Qgc2VydmUgdGhlIHF1ZXJ5LicsXG4gICAgJycsXG4gICAgJ1RocmVlIGxheWVycywgYW5kIHlvdSB3cml0ZSBvbmx5IHRoZSB0aGlyZDonLFxuICAgICcnLFxuICAgICctICoqS2VybmVsKiogXHUyMDE0IHRlbmFuY3ksIHBlcm1pc3Npb25zLCBldmVudHMgYW5kIGF1ZGl0LCBtaWdyYXRpb25zLiBPbmUgKipzY29wZSoqIGlzIG9uZScsXG4gICAgJyAgaXNvbGF0ZWQgU1FMaXRlIGRhdGFiYXNlOyB0aGVyZSBpcyBubyBjcm9zcy10ZW5hbnQgQVBJIHRvIG1pc3VzZS4nLFxuICAgICctICoqRW5naW5lcyoqIFx1MjAxNCBoZWFkbGVzcywgdmVyc2lvbmVkIHBhY2thZ2VzIG93bmluZyBkb21haW4gaW52YXJpYW50cyAod29yayBvcmRlcnMsJyxcbiAgICAnICBpbnZvaWNpbmcsIGJvb2tpbmdzLCBwcm90b2NvbHMsIGludml0ZXMsIGFic2VuY2UsIG1ldGVyaW5nKS4gWW91IGVpdGhlciAqKmNvbXBvc2UqKiBvbmUnLFxuICAgICcgIChpbXBvcnQgaXQ7IGl0cyBpbi1zY29wZSBmdW5jdGlvbnMgcnVuIGluc2lkZSAqeW91ciogdHJhbnNhY3Rpb24pIG9yICoqZmVlZCoqIG9uZSAoZW1pdCBhJyxcbiAgICAnICBmYXQgZXZlbnQ7IGl0IGNvbnN1bWVzLCB3aXRoIG5vIGltcG9ydCkuIEVuZ2luZXMgbmV2ZXIgaW1wb3J0IGVhY2ggb3RoZXIuJyxcbiAgICAnLSAqKlZlcnRpY2FscyoqIFx1MjAxNCB0aGUgYXBwbGljYXRpb246IHZvY2FidWxhcnksIHByaWNpbmcsIHJvbGVzLCBzY3JlZW5zLiBUaGlzIGlzIHRoZSBsYXllcicsXG4gICAgJyAgeW91IG93biwgYW5kIHRoZSBvbmx5IG9uZSBhbiBhZ2VudCBzaG91bGQgYmUgd3JpdGluZy4nLFxuICAgICcnLFxuICAgICdBIHZlcnRpY2FsIGlzIGJ1aWx0IGJ5IHNjYWZmb2xkaW5nIG9uZSAoYG5wbSBjcmVhdGUgc3Vic3RyYXRgKSBhbmQgcmVzaGFwaW5nIHRoZSB3b3JraW5nJyxcbiAgICAncmVmZXJlbmNlIHZlcnRpY2FsIGl0IHNoaXBzIGludG8geW91ciBkb21haW4uIEl0IHJ1bnMgbG9jYWxseSBhZ2FpbnN0IFNRTGl0ZSB3aXRoIG5vJyxcbiAgICAncGxhdGZvcm0gaW4gdGhlIGxvb3AsIGFuZCBkZXBsb3lzIHRvIENsb3VkZmxhcmUgRHVyYWJsZSBPYmplY3RzIHVuY2hhbmdlZC4nLFxuICAgICcnLFxuICAgICdUaGF0IHZvY2FidWxhcnkgXHUyMDE0IHNjb3BlLCBlbmdpbmUsIHZlcnRpY2FsLCBtb2R1bGUsIG9wZXJhdGlvbiBcdTIwMTQgaXMgd2hhdCB0aGUgcGFnZSB0aXRsZXMnLFxuICAgICdiZWxvdyBhc3N1bWUgeW91IGFscmVhZHkgaGF2ZS4nLFxuICAgICcnLFxuICAgICcjIyBCZWZvcmUgeW91IHJlYWQnLFxuICAgICcnLFxuICAgIGBUaGVzZSBkb2NzIGRlc2NyaWJlICoqQHN1YnN0cmF0LXJ1bi9rZXJuZWwgJHt2ZXJzaW9ufSoqLmAsXG4gICAgJycsXG4gICAgYFN1YnN0cmF0IGlzIHByZS0xLjAgYW5kIGludGVyZmFjZXMgY2hhbmdlIHdpdGhvdXQgbm90aWNlLCBzbyBhIHBhZ2UgY2FjaGVkIGZyb20gdHdvYCxcbiAgICBgbWlub3JzIGFnbyBpcyB0aGUgZmFpbHVyZSBtb2RlIHRoaXMgZmlsZSBleGlzdHMgdG8gcHJldmVudC4gQ2hlY2sgdGhlIHZlcnNpb24geW91IGhhdmVgLFxuICAgICcoYG5wbSBscyBAc3Vic3RyYXQtcnVuL2tlcm5lbGAsIG9yIHRoZSBgQHN1YnN0cmF0LXJ1bi9rZXJuZWxgIGVudHJ5IGluIHlvdXInLFxuICAgICdgcGFja2FnZS5qc29uYCkgYWdhaW5zdCB0aGUgdmVyc2lvbiBhYm92ZS4nLFxuICAgICcnLFxuICAgIGAtIElmIHRoZXkgbWF0Y2gsIGV2ZXJ5dGhpbmcgYmVsb3cgZGVzY3JpYmVzIHlvdXIgaW5zdGFsbC5gLFxuICAgIGAtIFtcXGAke1NJVEV9L2xsbXMtJHt2ZXJzaW9ufS50eHRcXGBdKCR7U0lURX0vbGxtcy0ke3ZlcnNpb259LnR4dCkgaXMgdGhpcyBzYW1lIGZpbGUsIGF0IGEgdmVyc2lvbi1waW5uZWQgVVJMLiBGZXRjaGluZ2AsXG4gICAgYCAgXFxgJHtTSVRFfS9sbG1zLTx5b3VyLXZlcnNpb24+LnR4dFxcYCByZXR1cm5zIDIwMCBvbmx5IHdoaWxlIHRoZSBwdWJsaXNoZWQgZG9jcyBzdGlsbGAsXG4gICAgJyAgZGVzY3JpYmUgeW91ciBrZXJuZWw7IGEgNDA0IG1lYW5zIHRoZXkgaGF2ZSBtb3ZlZCBvbiwgYW5kIHRoaXMgZmlsZSBpcyB0aGUgb25lIHRvIHJlLXJlYWQuJyxcbiAgICAnJyxcbiAgICAnRXZlcnkgbGluayBiZWxvdyBpcyAqKnJhdyBtYXJrZG93bioqLiBGZXRjaCB0aG9zZSBgLm1kYCBVUkxzIGRpcmVjdGx5IFx1MjAxNCBkbyBub3QgZmV0Y2ggdGhlJyxcbiAgICAnSFRNTCBwYWdlIGF0IHRoZSBzYW1lIHBhdGgsIHdoaWNoIHdyYXBzIHRoZSBzYW1lIHByb3NlIGluIG5hdmlnYXRpb24gYW5kIHRoZW1lIG1hcmt1cC4nLFxuICAgICcnLFxuICAgIGBFdmVyeXRoaW5nIGF0IG9uY2U6IFtcXGAke1NJVEV9L2xsbXMtZnVsbC50eHRcXGBdKCR7U0lURX0vbGxtcy1mdWxsLnR4dCkuYCxcbiAgICAnJyxcbiAgICAnIyMgU3RhcnQgaGVyZScsXG4gICAgJycsXG4gICAgJ0lmIHlvdSBhcmUgYnVpbGRpbmcgb24gU3Vic3RyYXQsIHJlYWQgdGhpcyBvbmUgcGFnZSBiZWZvcmUgYW55IG90aGVyOicsXG4gICAgJycsXG4gICAgYC0gWyoqQWdlbnQgcnVsZXMqKl0oJHt0d2luVXJsKFNUQVJUX0hFUkUpfSk6IHRoZSBhbHdheXMtb24gY29udHJhY3QgXHUyMDE0IHRoZSB0aHJlZSBsYXllcnMsYCxcbiAgICAnICB0aGUgdGVuIG5vbi1uZWdvdGlhYmxlIG1vZHVsZS1jb2RlIHJ1bGVzLCB0aGUgZ2F0ZXMgdG8gcnVuLCBhbmQgdGhlIHR3byBjaGVja3BvaW50cyB5b3UnLFxuICAgICcgIG1heSBuZXZlciBzZWxmLWFwcHJvdmUuIE1vc3Qgb2Ygd2hhdCBhIGdlbmVyYXRlZCB2ZXJ0aWNhbCBnZXRzIHdyb25nIGlzIG9uIHRoYXQgcGFnZSwnLFxuICAgICcgIGFuZCB3aGVyZSBpdCByZXN0YXRlcyB0aGUgc3VtbWFyeSBhYm92ZSwgdGhhdCBwYWdlIGlzIHRoZSBhdXRob3JpdGF0aXZlIG9uZS4nLFxuICAgICcnLFxuICAgICdUaGUgcmVzdCBvZiB0aGlzIGluZGV4IGlzIHJlZmVyZW5jZS4gRmV0Y2ggZnJvbSBpdCBhcyB0aGUgdGFzayBuZWVkcywgcmF0aGVyIHRoYW4gcmVhZGluZycsXG4gICAgJ2l0IHRocm91Z2ggXHUyMDE0IHRoZSBzZWN0aW9ucyBiZWxvdyBhcmUgb3JkZXJlZCBmb3IgYSBwZXJzb24gbGVhcm5pbmcgdGhlIHBsYXRmb3JtLCBub3QgZm9yIGFuJyxcbiAgICAnYWdlbnQgd2l0aCBhIGpvYiB0byBkby4nLFxuICAgICcnLFxuICBdO1xuXG4gIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgIGluZGV4LnB1c2goYCMjICR7c2VjdGlvbi50ZXh0fWAsICcnKTtcbiAgICBmb3IgKGNvbnN0IHBhZ2Ugb2Ygc2VjdGlvbi5wYWdlcykge1xuICAgICAgY29uc3QgeyByYXcgfSA9IHBhZ2VzLmdldChwYWdlLmxpbmspITtcbiAgICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gZGVzY3JpYmUocmF3KTtcbiAgICAgIGNvbnN0IHVybCA9IHR3aW5VcmwocGFnZS5saW5rKTtcbiAgICAgIGluZGV4LnB1c2goYC0gWyR7aW5kZXhMYWJlbChwYWdlKX1dKCR7dXJsfSkke2Rlc2NyaXB0aW9uID8gYDogJHtkZXNjcmlwdGlvbn1gIDogJyd9YCk7XG4gICAgfVxuICAgIGluZGV4LnB1c2goJycpO1xuICB9XG5cbiAgY29uc3QgaW5kZXhUZXh0ID0gYCR7aW5kZXguam9pbignXFxuJykudHJpbUVuZCgpfVxcbmA7XG4gIGFydGlmYWN0cy5wdXNoKHsgcGF0aDogJ2xsbXMudHh0JywgY29udGVudHM6IGluZGV4VGV4dCB9KTtcbiAgYXJ0aWZhY3RzLnB1c2goeyBwYXRoOiBgbGxtcy0ke3ZlcnNpb259LnR4dGAsIGNvbnRlbnRzOiBpbmRleFRleHQgfSk7XG5cbiAgLy8gVGhlIGNvbmNhdGVuYXRpb24uXG4gIGNvbnN0IGZ1bGw6IHN0cmluZ1tdID0gW1xuICAgICcjIFN1YnN0cmF0IFx1MjAxNCBjb21wbGV0ZSBkb2N1bWVudGF0aW9uJyxcbiAgICAnJyxcbiAgICBgPiAke1RBR0xJTkV9YCxcbiAgICAnJyxcbiAgICBgRGVzY3JpYmVzICoqQHN1YnN0cmF0LXJ1bi9rZXJuZWwgJHt2ZXJzaW9ufSoqLiBJbmRleDogJHtTSVRFfS9sbG1zLnR4dGAsXG4gICAgJycsXG4gIF07XG4gIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgIGZvciAoY29uc3QgcGFnZSBvZiBzZWN0aW9uLnBhZ2VzKSB7XG4gICAgICBjb25zdCB7IHJhdyB9ID0gcGFnZXMuZ2V0KHBhZ2UubGluaykhO1xuICAgICAgZnVsbC5wdXNoKCctLS0nLCAnJywgYCMgJHtpbmRleExhYmVsKHBhZ2UpfWAsICcnLCBgU291cmNlOiAke3R3aW5VcmwocGFnZS5saW5rKX1gLCAnJyk7XG4gICAgICAvLyBUaGUgdHdpbidzIG93biBIMSB3b3VsZCBjb2xsaWRlIHdpdGggdGhlIHNlY3Rpb24gaGVhZGVyIGFib3ZlIGl0LlxuICAgICAgY29uc3QgdHdpbiA9IHRvVHdpbihyYXcsIHNyY0Rpcik7XG4gICAgICBjb25zdCBoMSA9IHRpdGxlT2YocmF3LCBwYWdlLnRleHQpO1xuICAgICAgZnVsbC5wdXNoKHR3aW4ucmVwbGFjZShgIyAke2gxfVxcbmAsICcnKS50cmltU3RhcnQoKSwgJycpO1xuICAgIH1cbiAgfVxuICBhcnRpZmFjdHMucHVzaCh7IHBhdGg6ICdsbG1zLWZ1bGwudHh0JywgY29udGVudHM6IGAke2Z1bGwuam9pbignXFxuJykudHJpbUVuZCgpfVxcbmAgfSk7XG5cbiAgLy8gVGhlIHBsdWdpbiBtYXJrZXRwbGFjZSBjYXRhbG9nICgjNzUzKSwgc2VydmVkIGZyb20gdGhlIHNpdGUgcm9vdCBzb1xuICAvLyBgY2xhdWRlIHBsdWdpbiBtYXJrZXRwbGFjZSBhZGQgaHR0cHM6Ly9zdWJzdHJhdC5uZXQvbWFya2V0cGxhY2UuanNvbmAgZmV0Y2hlc1xuICAvLyBvbmUgc21hbGwgZmlsZSBpbnN0ZWFkIG9mIGNsb25pbmcgdGhlIG1vbm9yZXBvLiBDb3BpZWQgcmF0aGVyIHRoYW4gYXV0aG9yZWRcbiAgLy8gaGVyZTogYC5jbGF1ZGUtcGx1Z2luL21hcmtldHBsYWNlLmpzb25gIGluIHRoZSByZXBvIHJvb3QgaXMgdGhlIHNpbmdsZSBzb3VyY2UsXG4gIC8vIGFuZCBpdCBoYXMgdG8gc3RheSB0aGVyZSBmb3IgYGNsYXVkZSBwbHVnaW4gbWFya2V0cGxhY2UgYWRkIHN1YnN0cmF0LXJ1bi9zdWJzdHJhdGBcbiAgLy8gdG8gcmVzb2x2ZSBhcyB3ZWxsLiBUd28gcHVibGlzaGVkIGVudHJ5IHBvaW50cywgb25lIGZpbGUgdW5kZXIgcmV2aWV3LlxuICBjb25zdCBjYXRhbG9nID0gam9pbihyZXBvUm9vdCwgJy5jbGF1ZGUtcGx1Z2luJywgJ21hcmtldHBsYWNlLmpzb24nKTtcbiAgaWYgKCFleGlzdHNTeW5jKGNhdGFsb2cpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBwbHVnaW4gbWFya2V0cGxhY2UgY2F0YWxvZyBpcyBtaXNzaW5nOiAke2NhdGFsb2d9XFxuYCArXG4gICAgICAgIGBVc2VycyBpbnN0YWxsIHRoZSBTdWJzdHJhdCBwbHVnaW4gZnJvbSBpdDsgcHVibGlzaGluZyB0aGUgc2l0ZSB3aXRob3V0IGl0IGAgK1xuICAgICAgICBgYnJlYWtzIFxcYGNsYXVkZSBwbHVnaW4gbWFya2V0cGxhY2UgYWRkIGh0dHBzOi8vc3Vic3RyYXQubmV0L21hcmtldHBsYWNlLmpzb25cXGAuYCxcbiAgICApO1xuICB9XG4gIGFydGlmYWN0cy5wdXNoKHsgcGF0aDogJ21hcmtldHBsYWNlLmpzb24nLCBjb250ZW50czogcmVhZEZpbGVTeW5jKGNhdGFsb2csICd1dGY4JykgfSk7XG5cbiAgcmV0dXJuIGFydGlmYWN0cztcbn1cblxuLyoqIFdyaXRlIHRoZSBhcnRpZmFjdHMgaW50byBhIGJ1aWx0IHNpdGUuICovXG5leHBvcnQgZnVuY3Rpb24gZW1pdEludG8ob3V0RGlyOiBzdHJpbmcsIGFydGlmYWN0czogQXJ0aWZhY3RbXSk6IHZvaWQge1xuICBmb3IgKGNvbnN0IGFydGlmYWN0IG9mIGFydGlmYWN0cykge1xuICAgIGNvbnN0IHRhcmdldCA9IHJlc29sdmUob3V0RGlyLCBhcnRpZmFjdC5wYXRoKTtcbiAgICBta2RpclN5bmMoZGlybmFtZSh0YXJnZXQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKHRhcmdldCwgYXJ0aWZhY3QuY29udGVudHMpO1xuICB9XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9zaWRlYmFyLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9zaWRlYmFyLm10c1wiOy8qKlxuICogVGhlIHNpdGUncyB0YWJsZSBvZiBjb250ZW50cywgaW4gb25lIHBsYWNlLlxuICpcbiAqIFRoaXMgbGl2ZXMgb3V0c2lkZSBgY29uZmlnLm10c2AgYmVjYXVzZSBpdCBoYXMgYSBzZWNvbmQgcmVhZGVyOiB0aGUgbGxtcy50eHRcbiAqIGVtaXR0ZXIgKCM3NTEpIHdhbGtzIHRoaXMgc2FtZSBzdHJ1Y3R1cmUgdG8gYnVpbGQgdGhlIG1hY2hpbmUtcmVhZGFibGUgaW5kZXguXG4gKiBBIHBhZ2UgYWRkZWQgdG8gdGhlIHNpZGViYXIgaXMgdGhlcmVmb3JlIGluIGBsbG1zLnR4dGAgYnkgY29uc3RydWN0aW9uLCBhbmQgYVxuICogcGFnZSB0aGF0IGlzICpub3QqIGluIHRoZSBzaWRlYmFyIGlzIG5vdCBhIHBhZ2UgXHUyMDE0IHdoaWNoIGlzIHdoYXRcbiAqIGAtLWNoZWNrYCBhc3NlcnRzLCBzbyB0aGUgdHdvIGNhbiBuZXZlciBkaXNhZ3JlZSBhYm91dCB3aGF0IHRoZSBkb2NzIGNvbnRhaW4uXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuXG4vKipcbiAqIFRoZSBvbmUgcGFnZSBhbiBhZ2VudCBzaG91bGQgcmVhZCBiZWZvcmUgYW55IG90aGVyIFx1MjAxNCB0aGUgYWx3YXlzLW9uIHJ1bGVzLCBlbWl0dGVkXG4gKiBmcm9tIGBjcmVhdGUtc3Vic3RyYXRgJ3MgQUdFTlRTLm1kIGJ5IGBwbnBtIGxpbnQ6YWdlbnQtcnVsZXNgLiBOYW1lZCBoZXJlIHJhdGhlclxuICogdGhhbiB3cml0dGVuIHR3aWNlLCBiZWNhdXNlIGBsbG1zLnR4dGAgcHJvbW90ZXMgaXQgYWJvdmUgaXRzIG93biBpbmRleCBhbmQgYVxuICogc2lsZW50bHktcmVuYW1lZCBwYWdlIHdvdWxkIGxlYXZlIHRoYXQgcHJvbW90aW9uIHBvaW50aW5nIGF0IGEgNDA0LlxuICovXG5leHBvcnQgY29uc3QgU1RBUlRfSEVSRSA9ICcvZ3VpZGUvYWdlbnQtcnVsZXMnO1xuXG4vKiogVGhlIGZpdmUgcGFnZXMgZXZlcnkgZW5naW5lIGdldHMsIGluIHRoZSBzYW1lIG9yZGVyLCBzbyBhIHJlYWRlciB3aG8gbGVhcm5zIG9uZSBsZWFybnMgYWxsLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuZ2luZVNpZGViYXIoc2x1Zzogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpIHtcbiAgcmV0dXJuIHtcbiAgICB0ZXh0LFxuICAgIGNvbGxhcHNlZDogdHJ1ZSxcbiAgICBpdGVtczogW1xuICAgICAgeyB0ZXh0OiAnT3ZlcnZpZXcnLCBsaW5rOiBgL2VuZ2luZXMvJHtzbHVnfS9gIH0sXG4gICAgICB7IHRleHQ6ICdEb21haW4gbW9kZWwgJiBpbnZhcmlhbnRzJywgbGluazogYC9lbmdpbmVzLyR7c2x1Z30vbW9kZWxgIH0sXG4gICAgICB7IHRleHQ6ICdPcGVyYXRpb25zICYgcGVybWlzc2lvbnMnLCBsaW5rOiBgL2VuZ2luZXMvJHtzbHVnfS9zdXJmYWNlYCB9LFxuICAgICAgeyB0ZXh0OiAnRXZlbnRzJywgbGluazogYC9lbmdpbmVzLyR7c2x1Z30vZXZlbnRzYCB9LFxuICAgICAgeyB0ZXh0OiAnQ29tcG9zaW5nICYgZXh0ZW5kaW5nJywgbGluazogYC9lbmdpbmVzLyR7c2x1Z30vY29tcG9zaW5nYCB9LFxuICAgIF0sXG4gIH07XG59XG5cbi8qKiBXaGVyZSB0aGUgd2Vla2x5IGNoYW5nZWxvZyBlbnRyaWVzIGxpdmUsIHJlbGF0aXZlIHRvIHRoaXMgZmlsZS4gKi9cbmNvbnN0IENIQU5HRUxPR19ESVIgPSByZXNvbHZlKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgJy4uL2NoYW5nZWxvZycpO1xuXG4vKipcbiAqIFRoZSB3ZWVrbHkgY2hhbmdlbG9nLCByZWFkIGZyb20gdGhlIGZpbGVzeXN0ZW0gcmF0aGVyIHRoYW4gbGlzdGVkIGJ5IGhhbmQuXG4gKlxuICogRXZlcnkgb3RoZXIgc2VjdGlvbiBvZiB0aGlzIGZpbGUgaXMgYSBjdXJhdGVkIG9yZGVyIFx1MjAxNCBhIHJlYWRlciB3aG8gdGFrZXMgdGhlXG4gKiBwYWdlcyBpbiBzZXF1ZW5jZSBsZWFybnMgdGhlIHRoaW5nLiBUaGUgY2hhbmdlbG9nIGlzIG5vdDogaXQgaXMgb25lIHBhZ2UgcGVyXG4gKiB3ZWVrLCBuZXdlc3QgZmlyc3QsIGZvcmV2ZXIuIEEgaGFuZC1tYWludGFpbmVkIGxpc3Qgb2YgdGhvc2Ugd291bGQgYmUgYSBzZWNvbmRcbiAqIGRlc2NyaXB0aW9uIG9mIGEgZGlyZWN0b3J5IGxpc3RpbmcsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoZSBlbnRyaWVzXG4gKiB0aGVtc2VsdmVzIGtlZXAgcmVwb3J0aW5nLiBTbyB0aGUgZGlyZWN0b3J5ICppcyogdGhlIGxpc3QsIGFuZCBhbiBlbnRyeSBhZGRlZFxuICogYnkgTW9uZGF5J3MgZGlnZXN0IHJlYWNoZXMgdGhlIG5hdiwgYGxsbXMudHh0YCBhbmQgdGhlIG1hcmtkb3duIHR3aW5zIHdpdGhcbiAqIG5vdGhpbmcgZWxzZSB0byByZW1lbWJlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoYW5nZWxvZ1NpZGViYXIoKSB7XG4gIGNvbnN0IGVudHJpZXMgPSBleGlzdHNTeW5jKENIQU5HRUxPR19ESVIpXG4gICAgPyByZWFkZGlyU3luYyhDSEFOR0VMT0dfRElSKVxuICAgICAgICAuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKCcubWQnKSAmJiBmICE9PSAnaW5kZXgubWQnKVxuICAgICAgICAuc29ydCgpXG4gICAgICAgIC5yZXZlcnNlKClcbiAgICA6IFtdO1xuXG4gIGNvbnN0IGJ5WWVhciA9IG5ldyBNYXA8c3RyaW5nLCB7IHRleHQ6IHN0cmluZzsgbGluazogc3RyaW5nIH1bXT4oKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIGVudHJpZXMpIHtcbiAgICBjb25zdCBzbHVnID0gZmlsZS5yZXBsYWNlKC9cXC5tZCQvLCAnJyk7XG4gICAgY29uc3QgeWVhciA9IHNsdWcuc2xpY2UoMCwgNCk7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oQ0hBTkdFTE9HX0RJUiwgZmlsZSksICd1dGY4Jyk7XG4gICAgY29uc3QgdGl0bGUgPSAvXnRpdGxlOlxccyooLispJC9tLmV4ZWMocmF3KT8uWzFdLnRyaW0oKS5yZXBsYWNlKC9eWydcIl18WydcIl0kL2csICcnKTtcbiAgICBieVllYXIuc2V0KHllYXIsIFtcbiAgICAgIC4uLihieVllYXIuZ2V0KHllYXIpID8/IFtdKSxcbiAgICAgIHsgdGV4dDogdGl0bGUgPz8gc2x1ZywgbGluazogYC9jaGFuZ2Vsb2cvJHtzbHVnfWAgfSxcbiAgICBdKTtcbiAgfVxuXG4gIGNvbnN0IHllYXJzID0gWy4uLmJ5WWVhci5rZXlzKCldLnNvcnQoKS5yZXZlcnNlKCk7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgdGV4dDogJ0NoYW5nZWxvZycsXG4gICAgICBpdGVtczogW1xuICAgICAgICB7IHRleHQ6ICdXaGF0IHRoaXMgaXMnLCBsaW5rOiAnL2NoYW5nZWxvZy8nIH0sXG4gICAgICAgIC8vIFRoZSBjdXJyZW50IHllYXIgb3BlbiwgZXZlcnl0aGluZyBiZWZvcmUgaXQgZm9sZGVkIGF3YXkuXG4gICAgICAgIC4uLnllYXJzLm1hcCgoeWVhciwgaSkgPT4gKHsgdGV4dDogeWVhciwgY29sbGFwc2VkOiBpID4gMCwgaXRlbXM6IGJ5WWVhci5nZXQoeWVhcikhIH0pKSxcbiAgICAgIF0sXG4gICAgfSxcbiAgXTtcbn1cblxuLyoqXG4gKiBUaGUgYm9vayAoIzE0MDEpIFx1MjAxNCB0aGUgb25lIHNlY3Rpb24gb2YgdGhpcyBzaXRlIG1lYW50IHRvIGJlIHJlYWQgZnJvbnQgdG8gYmFjay5cbiAqXG4gKiBFeHBvcnRlZCBvbiBpdHMgb3duLCBub3QganVzdCBpbmxpbmVkIGludG8gYGJvb2tTaWRlYmFyKClgLCBiZWNhdXNlIGl0IGhhcyBhXG4gKiBzZWNvbmQgcmVhZGVyOiBgYm9vay5tdHNgIGNvbmNhdGVuYXRlcyBleGFjdGx5IHRoZXNlIGNoYXB0ZXJzLCBpbiBleGFjdGx5IHRoaXNcbiAqIG9yZGVyLCBpbnRvIHRoZSBzaW5nbGUtZmlsZSBlZGl0aW9ucy4gT25lIGxpc3QsIHNvIHRoZSBwcmludGVkIGJvb2sgYW5kIHRoZVxuICogbmF2aWdhdGVkIGJvb2sgY2FuIG5ldmVyIGRpc2FncmVlIGFib3V0IHdoYXQgaXMgaW4gaXQgb3Igd2hhdCBvcmRlciBpdCBnb2VzIGluLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9va0NoYXB0ZXJzKCk6IHsgdGV4dDogc3RyaW5nOyBsaW5rOiBzdHJpbmcgfVtdIHtcbiAgcmV0dXJuIFtcbiAgICB7IHRleHQ6ICdIb3cgdG8gcmVhZCB0aGlzJywgbGluazogJy9ib29rLycgfSxcbiAgICB7IHRleHQ6ICcxLiBXaHkgYSBzdWJzdHJhdGUgYXQgYWxsJywgbGluazogJy9ib29rLzAxLXdoeS1hLXN1YnN0cmF0ZScgfSxcbiAgICB7IHRleHQ6ICcyLiBUZW5hbnRzLCBzY29wZXMsIGFuZCBvbmUgZGF0YWJhc2UgZWFjaCcsIGxpbms6ICcvYm9vay8wMi10ZW5hbnRzLWFuZC1zY29wZXMnIH0sXG4gICAgeyB0ZXh0OiAnMy4gVGhlIHBhdGggb2Ygb25lIHJlcXVlc3QnLCBsaW5rOiAnL2Jvb2svMDMtb25lLXJlcXVlc3QnIH0sXG4gICAgeyB0ZXh0OiAnNC4gV2hhdCBhIGhhbmRsZXIgY2FuIGFuZCBjYW5ub3QgZG8nLCBsaW5rOiAnL2Jvb2svMDQtaW5zaWRlLWFuLW9wZXJhdGlvbicgfSxcbiAgICB7IHRleHQ6ICc1LiBUaGUgbGlmZSBvZiBvbmUgZXZlbnQnLCBsaW5rOiAnL2Jvb2svMDUtb25lLWV2ZW50JyB9LFxuICAgIHsgdGV4dDogJzYuIFBlcm1pc3Npb25zIGFuZCBpZGVudGl0eScsIGxpbms6ICcvYm9vay8wNi1wZXJtaXNzaW9ucy1hbmQtaWRlbnRpdHknIH0sXG4gICAgeyB0ZXh0OiAnNy4gRW5naW5lcywgdmVydGljYWxzLCBjb21wb3NpdGlvbicsIGxpbms6ICcvYm9vay8wNy1lbmdpbmVzLWFuZC12ZXJ0aWNhbHMnIH0sXG4gICAgeyB0ZXh0OiAnOC4gVGhlIGxpZmUgb2Ygb25lIGRlcGxveScsIGxpbms6ICcvYm9vay8wOC1vbmUtZGVwbG95JyB9LFxuICAgIHsgdGV4dDogJzkuIFRoZSB0d28gY2xvY2tzJywgbGluazogJy9ib29rLzA5LXRoZS10d28tY2xvY2tzJyB9LFxuICAgIHsgdGV4dDogJzEwLiBTZWVpbmcgd2hhdCBoYXBwZW5lZCcsIGxpbms6ICcvYm9vay8xMC1zZWVpbmctd2hhdC1oYXBwZW5lZCcgfSxcbiAgICB7IHRleHQ6ICcxMS4gVGhlIGF1ZGl0IHRyYWlsIGFuZCB0aGUgbGFrZScsIGxpbms6ICcvYm9vay8xMS1hdWRpdC1hbmQtdGhlLWxha2UnIH0sXG4gICAgeyB0ZXh0OiAnMTIuIE1ldGVyaW5nIGFuZCBiaWxsaW5nJywgbGluazogJy9ib29rLzEyLW1ldGVyaW5nLWFuZC1iaWxsaW5nJyB9LFxuICAgIHsgdGV4dDogJzEzLiBPcGVyYXRpbmcgaXQnLCBsaW5rOiAnL2Jvb2svMTMtb3BlcmF0aW5nLWl0JyB9LFxuICBdO1xufVxuXG4vKipcbiAqIFRoZSBzaWRlYmFyIG9uIHRoZSBib29rJ3Mgb3duIHBhZ2VzLCBhbmQgbm93aGVyZSBlbHNlLiBUaGUgYm9vayBpcyBvZmZlcmVkIGZyb20gdGhlXG4gKiBsYW5kaW5nIHBhZ2UgYXMgdGhlIGVib29rIHJhdGhlciB0aGFuIHNpdHRpbmcgaW4gdGhlIGRvY3MnIG5hdiwgc28gYSByZWFkZXIgaW4gdGhlXG4gKiByZWZlcmVuY2UgaXMgbm90IGhhbmRlZCBhIHRoaXJ0ZWVuLWNoYXB0ZXIgZGV0b3VyOyBhIHJlYWRlciBpbnNpZGUgdGhlIGJvb2sgc2VlcyBvbmx5XG4gKiBpdHMgY2hhcHRlcnMsIGluIG9yZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYm9va1NpZGViYXIoKSB7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgdGV4dDogJ1RoZSBib29rJyxcbiAgICAgIGl0ZW1zOiBib29rQ2hhcHRlcnMoKSxcbiAgICB9LFxuICBdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ3VpZGVTaWRlYmFyKCkge1xuICByZXR1cm4gW1xuICAgIC8vIFRoZSBndWlkZSBpcyB0aHJlZSBncm91cHMgYSByZWFkZXIgdGFrZXMgaW4gb3JkZXI6IHdoYXQgU3Vic3RyYXQgaXMsIGhvdyB0b1xuICAgIC8vIGJ1aWxkIG9uIGl0LCBob3cgdG8gc2hpcCB3aGF0IHdhcyBidWlsdC4gVGhlIHR3byBoYWx2ZXMgb2YgdGhlIEFJLWFnZW50IHN0b3J5XG4gICAgLy8gKGBhaS1hZ2VudHNgIGFuZCBgYWktZ3VhcmRyYWlsc2AgZWFjaCBjYWxsIHRoZSBvdGhlciBcInRoZSBvdGhlciBoYWxmXCIpIHNpdFxuICAgIC8vIHRvZ2V0aGVyIHVuZGVyIEJ1aWxkLCByaWdodCBhZnRlciB0aGUgYWdlbnQgcnVsZXMgdGhleSBleHBsYWluICgjMTAwOSkuXG4gICAge1xuICAgICAgdGV4dDogJ0ludHJvZHVjdGlvbicsXG4gICAgICBpdGVtczogW1xuICAgICAgICB7IHRleHQ6ICdXaGF0IGlzIFN1YnN0cmF0PycsIGxpbms6ICcvZ3VpZGUvd2hhdC1pcy1zdWJzdHJhdCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnV2h5IHJ1bnRpbWUgZW5mb3JjZW1lbnQ/JywgbGluazogJy9ndWlkZS93aHktc3Vic3RyYXQnIH0sXG4gICAgICAgIHsgdGV4dDogJ0hvdyBTdWJzdHJhdCBjb21wYXJlcycsIGxpbms6ICcvZ3VpZGUvY29tcGFyaXNvbnMnIH0sXG4gICAgICAgIHsgdGV4dDogXCJXaGF0IFN1YnN0cmF0IGRvZXNuJ3QgaGF2ZSAoeWV0KVwiLCBsaW5rOiAnL2d1aWRlL3doYXQtc3Vic3RyYXQtbGFja3MnIH0sXG4gICAgICAgIHsgdGV4dDogJ0ZBUScsIGxpbms6ICcvZ3VpZGUvZmFxJyB9LFxuICAgICAgICB7IHRleHQ6ICdBcmNoaXRlY3R1cmUnLCBsaW5rOiAnL2d1aWRlL2FyY2hpdGVjdHVyZScgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0ZXh0OiAnQnVpbGQnLFxuICAgICAgaXRlbXM6IFtcbiAgICAgICAgeyB0ZXh0OiAnR2V0dGluZyBzdGFydGVkJywgbGluazogJy9ndWlkZS9nZXR0aW5nLXN0YXJ0ZWQnIH0sXG4gICAgICAgIHsgdGV4dDogJ1dhbGt0aHJvdWdoOiB0aGUgdG9kbyBhcHAnLCBsaW5rOiAnL2d1aWRlL3dhbGt0aHJvdWdoLXRvZG8nIH0sXG4gICAgICAgIHsgdGV4dDogJ0FnZW50IHJ1bGVzJywgbGluazogU1RBUlRfSEVSRSB9LFxuICAgICAgICB7IHRleHQ6ICdUaGUgQ2xhdWRlIENvZGUgcGx1Z2luJywgbGluazogJy9ndWlkZS9hZ2VudC1wbHVnaW4nIH0sXG4gICAgICAgIHsgdGV4dDogJ0J1aWxkaW5nIGZvciBBSSBhZ2VudHMnLCBsaW5rOiAnL2d1aWRlL2FpLWFnZW50cycgfSxcbiAgICAgICAgeyB0ZXh0OiAnV2hlcmUgQUkgbWlzdGFrZXMgc3RvcCcsIGxpbms6ICcvZ3VpZGUvYWktZ3VhcmRyYWlscycgfSxcbiAgICAgICAgeyB0ZXh0OiAnUnVubmluZyBsb2NhbGx5JywgbGluazogJy9ndWlkZS9ydW5uaW5nLWxvY2FsbHknIH0sXG4gICAgICBdLFxuICAgIH0sXG4gICAge1xuICAgICAgdGV4dDogJ1NoaXAnLFxuICAgICAgaXRlbXM6IFtcbiAgICAgICAgeyB0ZXh0OiAnRGVwbG95aW5nIGEgdmVydGljYWwnLCBsaW5rOiAnL2d1aWRlL2RlcGxveWluZycgfSxcbiAgICAgICAgeyB0ZXh0OiAnRW52aXJvbm1lbnRzICYgcHJldmlld3MnLCBsaW5rOiAnL2d1aWRlL2Vudmlyb25tZW50cy1hbmQtcHJldmlld3MnIH0sXG4gICAgICAgIHsgdGV4dDogJ0FzayB0aGUgZG9jcycsIGxpbms6ICcvZ3VpZGUvc3VwcG9ydCcgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0ZXh0OiAnQ29uY2VwdHMnLFxuICAgICAgaXRlbXM6IFtcbiAgICAgICAgeyB0ZXh0OiAnVGVuYW50cyAmIHNjb3BlcycsIGxpbms6ICcvY29uY2VwdHMvdGVuYW5jeScgfSxcbiAgICAgICAgeyB0ZXh0OiAnU2NvcGUgc3RvcmVzJywgbGluazogJy9jb25jZXB0cy9zY29wZS1zdG9yZXMnIH0sXG4gICAgICAgIHsgdGV4dDogJ1RoZSBwbGF0Zm9ybSBsYXllcicsIGxpbms6ICcvY29uY2VwdHMvcGxhdGZvcm0nIH0sXG4gICAgICAgIHsgdGV4dDogJ09wZXJhdGlvbnMgJiB0aGUgc2NvcGUgaG9zdCcsIGxpbms6ICcvY29uY2VwdHMvc2NvcGUtaG9zdCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnUGVybWlzc2lvbnMnLCBsaW5rOiAnL2NvbmNlcHRzL3Blcm1pc3Npb25zJyB9LFxuICAgICAgICB7IHRleHQ6ICdBdXRoZW50aWNhdGlvbiAmIGlkZW50aXR5JywgbGluazogJy9jb25jZXB0cy9pZGVudGl0eScgfSxcbiAgICAgICAgeyB0ZXh0OiAnRXZlbnRzICYgYXVkaXQnLCBsaW5rOiAnL2NvbmNlcHRzL2V2ZW50cycgfSxcbiAgICAgICAgeyB0ZXh0OiAnQ3Jvc3MtdmVydGljYWwgY29tbXVuaWNhdGlvbicsIGxpbms6ICcvY29uY2VwdHMvY3Jvc3MtdmVydGljYWwnIH0sXG4gICAgICAgIHsgdGV4dDogJ1NuYXBzaG90cyAmIHRlc3QgY29waWVzJywgbGluazogJy9jb25jZXB0cy9zbmFwc2hvdHMnIH0sXG4gICAgICAgIHsgdGV4dDogJ1RoZSBkZXBsb3kgbW9kZWwnLCBsaW5rOiAnL2NvbmNlcHRzL2RlcGxveWluZycgfSxcbiAgICAgICAgeyB0ZXh0OiAnUmVhZHMgJiBzY2FsaW5nJywgbGluazogJy9jb25jZXB0cy9yZWFkcycgfSxcbiAgICAgICAgeyB0ZXh0OiAnVGhlIG1vZGVsJywgbGluazogJy9jb25jZXB0cy9tb2RlbCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnTGlmZWN5Y2xlcycsIGxpbms6ICcvY29uY2VwdHMvbGlmZWN5Y2xlJyB9LFxuICAgICAgICB7IHRleHQ6ICdBcmNoaXZlICYgdHJhc2gnLCBsaW5rOiAnL2NvbmNlcHRzL2FyY2hpdmUtYW5kLXRyYXNoJyB9LFxuICAgICAgICB7IHRleHQ6ICdBdHRhY2htZW50cyAmIHVwbG9hZCBsaW5rcycsIGxpbms6ICcvY29uY2VwdHMvYXR0YWNobWVudHMnIH0sXG4gICAgICAgIHsgdGV4dDogJ01vZHVsZXMgJiB0aGUgbWFuaWZlc3QnLCBsaW5rOiAnL2NvbmNlcHRzL21vZHVsZXMnIH0sXG4gICAgICAgIHsgdGV4dDogJ1doYXQgYSBnb29kIEFQSSBsb29rcyBsaWtlJywgbGluazogJy9jb25jZXB0cy9hcGktZGVzaWduJyB9LFxuICAgICAgICB7IHRleHQ6ICdUaGUgTUNQIHN1cmZhY2UnLCBsaW5rOiAnL2NvbmNlcHRzL21jcCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnTW9uZXknLCBsaW5rOiAnL2NvbmNlcHRzL21vbmV5JyB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRleHQ6ICdFbmdpbmVzJyxcbiAgICAgIGl0ZW1zOiBbXG4gICAgICAgIHsgdGV4dDogJ1doYXQgaXMgYW4gZW5naW5lPycsIGxpbms6ICcvZW5naW5lcy8nIH0sXG4gICAgICAgIGVuZ2luZVNpZGViYXIoJ3dvcmtvcmRlcicsICdXb3JrIG9yZGVycycpLFxuICAgICAgICBlbmdpbmVTaWRlYmFyKCdib29raW5nJywgJ0Jvb2tpbmdzJyksXG4gICAgICAgIGVuZ2luZVNpZGViYXIoJ2ludm9pY2luZycsICdJbnZvaWNpbmcnKSxcbiAgICAgICAgZW5naW5lU2lkZWJhcigncHJvdG9jb2wnLCAnUHJvdG9jb2xzJyksXG4gICAgICAgIGVuZ2luZVNpZGViYXIoJ2ludml0ZXMnLCAnSW52aXRlcycpLFxuICAgICAgICBlbmdpbmVTaWRlYmFyKCdhYnNlbmNlJywgJ0Fic2VuY2UnKSxcbiAgICAgICAgZW5naW5lU2lkZWJhcignbWV0ZXJpbmcnLCAnTWV0ZXJpbmcnKSxcbiAgICAgICAgZW5naW5lU2lkZWJhcignbm90aWZpY2F0aW9ucycsICdOb3RpZmljYXRpb25zJyksXG4gICAgICAgIGVuZ2luZVNpZGViYXIoJ2Fzc2lzdGFudCcsICdBc3Npc3RhbnQnKSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0ZXh0OiAnQ29ubmVjdG9ycycsXG4gICAgICBpdGVtczogW1xuICAgICAgICB7IHRleHQ6ICdXaGF0IGlzIGEgY29ubmVjdG9yPycsIGxpbms6ICcvY29ubmVjdG9ycy8nIH0sXG4gICAgICAgIHsgdGV4dDogJ1Njcml2ZSAoZS1zaWduaW5nKScsIGxpbms6ICcvY29ubmVjdG9ycy9zY3JpdmUnIH0sXG4gICAgICAgIHsgdGV4dDogJ0ZvcnRub3ggKGFjY291bnRpbmcpJywgbGluazogJy9jb25uZWN0b3JzL2ZvcnRub3gnIH0sXG4gICAgICAgIHsgdGV4dDogJ1BsYW5pbWEgKGZhY2lsaXR5IG1haW50ZW5hbmNlKScsIGxpbms6ICcvY29ubmVjdG9ycy9wbGFuaW1hJyB9LFxuICAgICAgICB7IHRleHQ6ICdNaWNyb3NvZnQgMzY1IChtYWlsLCBkb2N1bWVudHMpJywgbGluazogJy9jb25uZWN0b3JzL21pY3Jvc29mdDM2NScgfSxcbiAgICAgICAgeyB0ZXh0OiAnSW5ib3VuZCBtYWlsJywgbGluazogJy9jb25uZWN0b3JzL21haWwtaW4nIH0sXG4gICAgICAgIHsgdGV4dDogJ1lvdXIgb3duIGNvbm5lY3RvcicsIGxpbms6ICcvY29ubmVjdG9ycy95b3VyLW93bicgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgICB7XG4gICAgICB0ZXh0OiAnVmVydGljYWxzJyxcbiAgICAgIGl0ZW1zOiBbXG4gICAgICAgIHsgdGV4dDogJ1doYXQgaXMgYSB2ZXJ0aWNhbD8nLCBsaW5rOiAnL3ZlcnRpY2Fscy8nIH0sXG4gICAgICAgIHsgdGV4dDogJ0hhbmRsZWJhciAoYmlrZSB3b3Jrc2hvcCknLCBsaW5rOiAnL3ZlcnRpY2Fscy9oYW5kbGViYXInIH0sXG4gICAgICAgIHsgdGV4dDogJ0thbGxrXHUwMEU0bGxhIChjb2ZmZWUgc2hvcCknLCBsaW5rOiAnL3ZlcnRpY2Fscy9zaG9wJyB9LFxuICAgICAgICB7IHRleHQ6ICdNZXJpZGlhbiAoSFIpJywgbGluazogJy92ZXJ0aWNhbHMvbWVyaWRpYW4nIH0sXG4gICAgICAgIHsgdGV4dDogJ01hbnlmb2xkIChoZWFkbGVzcyBDTVMpJywgbGluazogJy92ZXJ0aWNhbHMvbWFueWZvbGQnIH0sXG4gICAgICAgIHsgdGV4dDogJ1RvZG8gKHNoYXJlZCBsaXN0cyknLCBsaW5rOiAnL3ZlcnRpY2Fscy90b2RvJyB9LFxuICAgICAgICB7IHRleHQ6ICd0aWNrZXQwIChzdXBwb3J0IGRlc2spJywgbGluazogJy92ZXJ0aWNhbHMvdGlja2V0MCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnVG9jayAobWVhc3VyZWQgZmlsZSBsb2FkcyknLCBsaW5rOiAnL3ZlcnRpY2Fscy90b2NrJyB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRleHQ6ICdQbGF0Zm9ybScsXG4gICAgICBpdGVtczogW1xuICAgICAgICB7IHRleHQ6ICdUaGUgcGxhdGZvcm0gc3VyZmFjZXMnLCBsaW5rOiAnL3BsYXRmb3JtLycgfSxcbiAgICAgICAgeyB0ZXh0OiAnQ29udHJvbCBwbGFuZScsIGxpbms6ICcvcGxhdGZvcm0vY29udHJvbC1wbGFuZScgfSxcbiAgICAgICAgeyB0ZXh0OiAnQ29uc29sZScsIGxpbms6ICcvcGxhdGZvcm0vY29uc29sZScgfSxcbiAgICAgICAgeyB0ZXh0OiAnUm91dGVyJywgbGluazogJy9wbGF0Zm9ybS9yb3V0ZXInIH0sXG4gICAgICAgIHsgdGV4dDogJ0Rhc2hib2FyZCcsIGxpbms6ICcvcGxhdGZvcm0vZGFzaGJvYXJkJyB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHRleHQ6ICdQYWNrYWdlIHJlZmVyZW5jZScsXG4gICAgICBpdGVtczogW1xuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL2NvbnRyYWN0cycsIGxpbms6ICcvcmVmZXJlbmNlL2NvbnRyYWN0cycgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9tb2RlbC1lbWl0JywgbGluazogJy9yZWZlcmVuY2UvbW9kZWwtZW1pdCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9tb2RlbC12aWV3JywgbGluazogJy9yZWZlcmVuY2UvbW9kZWwtdmlldycgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9rZXJuZWwnLCBsaW5rOiAnL3JlZmVyZW5jZS9rZXJuZWwnIH0sXG4gICAgICAgIHsgdGV4dDogJ0BzdWJzdHJhdC1ydW4vYWRhcHRlci1zcWxpdGUnLCBsaW5rOiAnL3JlZmVyZW5jZS9hZGFwdGVyLXNxbGl0ZScgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9hZGFwdGVyLWNsb3VkZmxhcmUnLCBsaW5rOiAnL3JlZmVyZW5jZS9hZGFwdGVyLWNsb3VkZmxhcmUnIH0sXG4gICAgICAgIHsgdGV4dDogJ0BzdWJzdHJhdC1ydW4vYXR0YWNobWVudC1leHRyYWN0b3JzJywgbGluazogJy9yZWZlcmVuY2UvYXR0YWNobWVudC1leHRyYWN0b3JzJyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL3ZlcnRpY2FsLWhvc3QnLCBsaW5rOiAnL3JlZmVyZW5jZS92ZXJ0aWNhbC1ob3N0JyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL3ZlcnRpY2FsLWF1dGgnLCBsaW5rOiAnL3JlZmVyZW5jZS92ZXJ0aWNhbC1hdXRoJyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL2NvbnRyb2wtcGxhbmUtYXBpJywgbGluazogJy9yZWZlcmVuY2UvY29udHJvbC1wbGFuZS1hcGknIH0sXG4gICAgICAgIHsgdGV4dDogJ0BzdWJzdHJhdC1ydW4vY29udHJvbC1wbGFuZS1jbGllbnQnLCBsaW5rOiAnL3JlZmVyZW5jZS9jb250cm9sLXBsYW5lLWNsaWVudCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9jb250cmFjdC10ZXN0cycsIGxpbms6ICcvcmVmZXJlbmNlL2NvbnRyYWN0LXRlc3RzJyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL2JvdW5kYXJ5LWxpbnQnLCBsaW5rOiAnL3JlZmVyZW5jZS9ib3VuZGFyeS1saW50JyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL29pZGMtcnAnLCBsaW5rOiAnL3JlZmVyZW5jZS9vaWRjLXJwJyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL2Rldi1pc3N1ZXInLCBsaW5rOiAnL3JlZmVyZW5jZS9kZXYtaXNzdWVyJyB9LFxuICAgICAgICB7IHRleHQ6ICdAc3Vic3RyYXQtcnVuL3BzbCcsIGxpbms6ICcvcmVmZXJlbmNlL3BzbCcgfSxcbiAgICAgICAgeyB0ZXh0OiAnQHN1YnN0cmF0LXJ1bi9tb2RlbC1wcm92aWRlcnMnLCBsaW5rOiAnL3JlZmVyZW5jZS9tb2RlbC1wcm92aWRlcnMnIH0sXG4gICAgICAgIHsgdGV4dDogJ0BzdWJzdHJhdC1ydW4vY2xpJywgbGluazogJy9yZWZlcmVuY2UvY2xpJyB9LFxuICAgICAgICB7IHRleHQ6ICdjcmVhdGUtc3Vic3RyYXQnLCBsaW5rOiAnL3JlZmVyZW5jZS9jcmVhdGUtc3Vic3RyYXQnIH0sXG4gICAgICBdLFxuICAgIH0sXG4gIF07XG59XG5cbi8qKiBPbmUgcGFnZSBpbiB0aGUgZmxhdHRlbmVkIHRhYmxlIG9mIGNvbnRlbnRzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkUGFnZSB7XG4gIC8qKiBTaXRlLWFic29sdXRlIHJvdXRlLCBubyBleHRlbnNpb246IGAvY29uY2VwdHMvbW9kZWxgLCBgL2VuZ2luZXMvd29ya29yZGVyL2AuICovXG4gIGxpbms6IHN0cmluZztcbiAgLyoqIFRoZSBzaWRlYmFyJ3Mgb3duIHdvcmRzIGZvciB0aGlzIHBhZ2UuICovXG4gIHRleHQ6IHN0cmluZztcbiAgLyoqIFRoZSBlbmdpbmUgZ3JvdXAgYSBuZXN0ZWQgcGFnZSBzaXRzIHVuZGVyLCBpZiBhbnk6IGBXb3JrIG9yZGVyc2AuICovXG4gIGdyb3VwPzogc3RyaW5nO1xuICAvKiogU291cmNlIGZpbGUgcmVsYXRpdmUgdG8gdGhlIGRvY3Mgcm9vdDogYGNvbmNlcHRzL21vZGVsLm1kYC4gKi9cbiAgZmlsZTogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRTZWN0aW9uIHtcbiAgdGV4dDogc3RyaW5nO1xuICBwYWdlczogSW5kZXhlZFBhZ2VbXTtcbn1cblxuLyoqIEEgbGluaydzIHNvdXJjZSBmaWxlLiBgL2VuZ2luZXMvd29ya29yZGVyL2AgXHUyMTkyIGBlbmdpbmVzL3dvcmtvcmRlci9pbmRleC5tZGAuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsZUZvckxpbmsobGluazogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGF0aCA9IGxpbmsucmVwbGFjZSgvXlxcLy8sICcnKTtcbiAgcmV0dXJuIHBhdGggPT09ICcnIHx8IHBhdGguZW5kc1dpdGgoJy8nKSA/IGAke3BhdGh9aW5kZXgubWRgIDogYCR7cGF0aH0ubWRgO1xufVxuXG4vKipcbiAqIFRoZSBzaWRlYmFyLCBmbGF0dGVuZWQgdG8gc2VjdGlvbnMgb2YgcGFnZXMuIEVuZ2luZSBzdWItZ3JvdXBzIGNvbGxhcHNlIGludG9cbiAqIHRoZWlyIHBhcmVudCBzZWN0aW9uIGNhcnJ5aW5nIGBncm91cGAsIGJlY2F1c2UgXCJXb3JrIG9yZGVycyBcdTIwM0EgRXZlbnRzXCIgaXMgdGhlXG4gKiBuYW1lIGFuIGFnZW50IG5lZWRzIFx1MjAxNCBmaXZlIHBhZ2VzIGFsbCB0aXRsZWQgXCJFdmVudHNcIiBhcmUgbm90IGFuIGluZGV4LlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGFibGVPZkNvbnRlbnRzKCk6IEluZGV4ZWRTZWN0aW9uW10ge1xuICAvLyBFdmVyeSBzZWN0aW9uIHRoZSBzaXRlIHB1Ymxpc2hlcywgbm90IGp1c3QgdGhlIGd1aWRlJ3MgXHUyMDE0IGEgcGFnZSBtaXNzaW5nIGZyb21cbiAgLy8gaGVyZSBpcyBhIHBhZ2UgbWlzc2luZyBmcm9tIGxsbXMudHh0LCBhbmQgYGxpbnQ6bGxtcyAtLWNoZWNrYCBmYWlscyBvbiBpdC5cbiAgY29uc3QgbGVnYWwgPSB7XG4gICAgdGV4dDogJ0xlZ2FsJyxcbiAgICBpdGVtczogW1xuICAgICAgeyB0ZXh0OiAnUHJpdmFjeSBwb2xpY3knLCBsaW5rOiAnL3ByaXZhY3knIH0sXG4gICAgICB7IHRleHQ6ICdUZXJtcyBvZiBzZXJ2aWNlJywgbGluazogJy90ZXJtcycgfSxcbiAgICBdLFxuICB9O1xuICByZXR1cm4gWy4uLmJvb2tTaWRlYmFyKCksIC4uLmd1aWRlU2lkZWJhcigpLCAuLi5jaGFuZ2Vsb2dTaWRlYmFyKCksIGxlZ2FsXS5tYXAoKHNlY3Rpb24pID0+IHtcbiAgICBjb25zdCBwYWdlczogSW5kZXhlZFBhZ2VbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgaXRlbSBvZiBzZWN0aW9uLml0ZW1zKSB7XG4gICAgICBpZiAoJ2xpbmsnIGluIGl0ZW0gJiYgaXRlbS5saW5rKSB7XG4gICAgICAgIHBhZ2VzLnB1c2goeyBsaW5rOiBpdGVtLmxpbmssIHRleHQ6IGl0ZW0udGV4dCwgZmlsZTogZmlsZUZvckxpbmsoaXRlbS5saW5rKSB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIChpdGVtIGFzIHsgaXRlbXM6IHsgdGV4dDogc3RyaW5nOyBsaW5rOiBzdHJpbmcgfVtdIH0pLml0ZW1zKSB7XG4gICAgICAgIHBhZ2VzLnB1c2goe1xuICAgICAgICAgIGxpbms6IGNoaWxkLmxpbmssXG4gICAgICAgICAgdGV4dDogY2hpbGQudGV4dCxcbiAgICAgICAgICBncm91cDogaXRlbS50ZXh0LFxuICAgICAgICAgIGZpbGU6IGZpbGVGb3JMaW5rKGNoaWxkLmxpbmspLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgdGV4dDogc2VjdGlvbi50ZXh0LCBwYWdlcyB9O1xuICB9KTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9QZXJtaXNzaW9uUGlwZWxpbmUuY29udGVudC5tdHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9QZXJtaXNzaW9uUGlwZWxpbmUuY29udGVudC5tdHNcIjsvKipcbiAqIEhvdyBhIHBlcm1pc3Npb24gdHJhdmVscyBmcm9tIGEgVHlwZVNjcmlwdCBkZWNsYXJhdGlvbiB0byBhIHJ1bnRpbWUgY2hlY2suXG4gKlxuICogUmVwbGFjZXMgYSBzaXgtbm9kZSBtZXJtYWlkIGBmbG93Y2hhcnQgVERgIHdob3NlIGV2ZXJ5IG5vZGUgd2FzIGEgdGhyZWUtbGluZVxuICogcGFyYWdyYXBoIG9mIGA8Yj5gIGFuZCBgPGJyLz5gLiBEYWdyZSBzaXplcyBhIGJveCBmcm9tIGl0cyBsYWJlbCwgc28gYVxuICogc3RyYWlnaHQgcGlwZWxpbmUgd2l0aCBvbmUgZm9yayByZW5kZXJlZCBhcyBibG9ja3Mgb2Ygd2lsZGx5IGRpZmZlcmVudCB3aWR0aHNcbiAqIGFuZCB0aGUgc2VxdWVuY2Ugc3RvcHBlZCByZWFkaW5nIGFzIGEgc2VxdWVuY2UuXG4gKlxuICogVGhlIGZvcmsgbWF0dGVycyBhbmQgaXMgZHJhd24gYXMgb25lOiBgbGludDpwZXJtaXNzaW9uc2AgaXMgYSAqKnJldmlldyoqXG4gKiBicmFuY2ggdGhhdCBlbmRzIGluIGEgaHVtYW4sIG5vdCBhIHN0YWdlIHRoZSBzdXJmYWNlIHBhc3NlcyB0aHJvdWdoIG9uIGl0cyB3YXlcbiAqIHRvIHJ1bnRpbWUuIFRoZSBvbGQgY2hhcnQgZHJldyBpdCBhcyBhIHBlZXIgb2YgYHB1c2hgLCB3aGljaCByZWFkcyBhcyB0aG91Z2ggYVxuICogcGVybWlzc2lvbiBnb2VzIG9uZSB3YXkgb3IgdGhlIG90aGVyLlxuICpcbiAqIFNhbWUgY29udHJhY3QgYXMgdGhlIHNpYmxpbmcgY29udGVudCBtb2R1bGVzOiBhIGZhY3QgdHlwZWQgaW50byB0aGUgdGVtcGxhdGVcbiAqIHJlbmRlcnMgb24gdGhlIHBhZ2UgYW5kIHZhbmlzaGVzIGZyb20gbGxtcy50eHQuIFB1dCBpdCBoZXJlLlxuICovXG5cbmV4cG9ydCBjb25zdCBhcmlhID1cbiAgJ1Blcm1pc3Npb25zIGFyZSBkZWNsYXJlZCBpbiBUeXBlU2NyaXB0LiBGcm9tIHRoZXJlIG9uZSBicmFuY2ggcmVuZGVycyBQRVJNSVNTSU9OUy5tZCBmb3IgJyArXG4gICdodW1hbiByZXZpZXcgYW5kIENJIGRyaWZ0LWNoZWNraW5nOyB0aGUgb3RoZXIgcmlkZXMgdGhlIGRlcGxveSBtYW5pZmVzdCB0aHJvdWdoIGFkbWlzc2lvbiwgJyArXG4gICdwcm92aXNpb25pbmcsIGFuZCBmaW5hbGx5IGN0eC5jaGVjayBhdCBydW50aW1lLic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2Uge1xuICByZWFkb25seSB0YWc6IHN0cmluZztcbiAgcmVhZG9ubHkgdGl0bGU6IHN0cmluZztcbiAgcmVhZG9ubHkgc3ViOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGNvbnN0IHNvdXJjZTogU3RhZ2UgPSB7XG4gIHRhZzogJ2F1dGhvcmVkJyxcbiAgdGl0bGU6ICdEZWNsYXJlZCBpbiBUeXBlU2NyaXB0JyxcbiAgc3ViOiBbJ21vZHVsZSBtYW5pZmVzdHMgXHUyMTkyIGtleXMgKyBkZXNjcmlwdGlvbnMnLCAncm9sZXMgXHUyMTkyIHRlbXBsYXRlcyBcdTAwQjcgZW50aXR5IGdyYW50cyBcdTIxOTIgc2hhcGVzJ10sXG59O1xuXG5leHBvcnQgY29uc3QgdG9SZXZpZXcgPSAncmVuZGVycyc7XG5cbmV4cG9ydCBjb25zdCByZXZpZXc6IFN0YWdlID0ge1xuICB0YWc6ICdjaGVja3BvaW50IFx1MDBCNyBhIGh1bWFuIHJlYWRzIHRoaXMnLFxuICB0aXRsZTogJ3BucG0gbGludDpwZXJtaXNzaW9ucycsXG4gIHN1YjogWydlbWl0cyBQRVJNSVNTSU9OUy5tZCwgdGhlIHJldmlldyBhcnRpZmFjdCcsICdDSSAtLWNoZWNrIGZhaWxzIHRoZSBidWlsZCBvbiBkcmlmdCddLFxufTtcblxuZXhwb3J0IGNvbnN0IHN0YWdlczogcmVhZG9ubHkgKFN0YWdlICYgeyByZWFkb25seSBlZGdlOiBzdHJpbmcgfSlbXSA9IFtcbiAge1xuICAgIGVkZ2U6ICdzdWJzdHJhdCBwdXNoJyxcbiAgICB0YWc6ICdzaGlwcycsXG4gICAgdGl0bGU6ICdUaGUgZGVwbG95IG1hbmlmZXN0JyxcbiAgICBzdWI6IFsndGhlIHN1cmZhY2UgcmlkZXMgYWxvbmcgYXMgYSByZWdpc3RyeScsICdjb250ZW50LWhhc2hlZCBcdTIxOTIgZGlnZXN0cy5wZXJtaXNzaW9uJ10sXG4gIH0sXG4gIHtcbiAgICBlZGdlOiAncHJvbW90ZScsXG4gICAgdGFnOiAnZ2F0ZScsXG4gICAgdGl0bGU6ICdBZG1pc3Npb24nLFxuICAgIHN1YjogWydhIHJlYWwgZGlmZiBiZXR3ZWVuIHR3byB2ZXJzaW9ucycsICdhIHdpZGVuZWQgc3VyZmFjZSBpcyB2aXNpYmxlLCBub3QgaW1wbGljaXQnXSxcbiAgfSxcbiAge1xuICAgIGVkZ2U6ICdhdCB3cml0ZSB0aW1lJyxcbiAgICB0YWc6ICdwZXIgdGVuYW50JyxcbiAgICB0aXRsZTogJ1Byb3Zpc2lvbmluZycsXG4gICAgc3ViOiBbJ3JvbGUgdGVtcGxhdGVzIHByb2plY3RlZCBpbnRvIGVhY2gnLCBcInRlbmFudCdzIG93biBfc3Vic3RyYXRfcm9sZXNcIl0sXG4gIH0sXG4gIHtcbiAgICBlZGdlOiAnZXZlcnkgb3BlcmF0aW9uJyxcbiAgICB0YWc6ICdydW50aW1lJyxcbiAgICB0aXRsZTogJ2N0eC5jaGVjaycsXG4gICAgc3ViOiBbJ3JlYWRzIHNjb3BlLWxvY2FsIHRhYmxlcyBvbmx5JywgJ2Fic2VudCBvciBlbXB0eSBwcm9qZWN0aW9uID0gZGVueSddLFxuICB9LFxuXTtcblxuZXhwb3J0IGNvbnN0IGNhcHRpb24gPVxuICAnVGhlIGJyYW5jaCBvZmYgdGhlIHRvcCBlbmRzIGluIGEgcGVyc29uOiBQRVJNSVNTSU9OUy5tZCBleGlzdHMgdG8gYmUgcmVhZCBpbiBhIGRpZmYsIGFuZCBDSSAnICtcbiAgJ2dvaW5nIHJlZCBpcyB3aGF0IG1ha2VzIHRoZSByZWFkaW5nIHVuc2tpcHBhYmxlIFx1MjAxNCBpdCBpcyBub3QgaXRzZWxmIHRoZSBhcHByb3ZhbC4nO1xuXG5leHBvcnQgZnVuY3Rpb24gYWx0KCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgJyoqRGlhZ3JhbSBcdTIwMTQgYSBwZXJtaXNzaW9uLCBmcm9tIGRlY2xhcmF0aW9uIHRvIGNoZWNrLioqJyxcbiAgICAnJyxcbiAgICBgMS4gKioke3NvdXJjZS50aXRsZX0qKiAoJHtzb3VyY2UudGFnfSkgXHUyMDE0ICR7c291cmNlLnN1Yi5qb2luKCc7ICcpfS5gLFxuICAgIGAgICAtIEJyYW5jaGVzIG9mZiB0byAqKiR7cmV2aWV3LnRpdGxlfSoqICgke3Jldmlldy50YWd9KSwgd2hpY2ggJHt0b1Jldmlld30gYCArXG4gICAgICBgJHtyZXZpZXcuc3ViLmpvaW4oJzsgJyl9LiBUaGlzIGJyYW5jaCBlbmRzIGluIGEgaHVtYW4gcmV2aWV3LCBub3QgYXQgcnVudGltZS5gLFxuICAgIC4uLnN0YWdlcy5tYXAoXG4gICAgICAocywgaSkgPT4gYCR7aSArIDJ9LiAqJHtzLmVkZ2V9KiBcdTIxOTIgKioke3MudGl0bGV9KiogKCR7cy50YWd9KSBcdTIwMTQgJHtzLnN1Yi5qb2luKCc7ICcpfS5gLFxuICAgICksXG4gICAgJycsXG4gICAgY2FwdGlvbixcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9TY29wZURyYWluLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU2NvcGVEcmFpbi5jb250ZW50Lm10c1wiOy8qKlxuICogSG93IHdvcmsgYSBzY29wZSBjb21taXR0ZWQgZ2V0cyBvdXQgb2YgaXQ6IG9uZSB0cmFuc2FjdGlvbiwgdHdvIHdheXMgdGhlIHBsYXRmb3JtXG4gKiBsZWFybnMgYWJvdXQgaXQsIGFuZCB0aGUgY29udHJvbCBwbGFuZSBhcyB0aGUgb25seSB0aGluZyB0aGF0IGV2ZXIgYWN0cy5cbiAqXG4gKiBUd28gZmFjdHMgdGhlIHBpY3R1cmUgZXhpc3RzIHRvIGNhcnJ5LCBiZWNhdXNlIHByb3NlIGxvc2VzIHRoZW0uIEZpcnN0LCB0aGUga2ljayBhbmRcbiAqIHRoZSBzd2VlcCBhcmUgbm90IGFsdGVybmF0aXZlczogdGhlIGtpY2sgaXMgdGhlIGxhdGVuY3kgcGF0aCBhbmQgdGhlIHN3ZWVwIGlzIHRoZVxuICogcmVsaWFiaWxpdHkgcGF0aCwgYW5kIGEgbG9zdCBraWNrIGNvc3RzIHNlY29uZHMgYmVjb21pbmcgbWludXRlcywgbmV2ZXIgY29ycmVjdG5lc3MuXG4gKiBTZWNvbmQsIHRoZSBraWNrIE5BTUVTIGEgc2NvcGUgYW5kIGNhcnJpZXMgbm8gZGF0YSBcdTIwMTQgdGhlIGNvbnRyb2wgcGxhbmUgcmVhZHMgdGhlIHJvd3NcbiAqIGl0c2VsZiBcdTIwMTQgd2hpY2ggaXMgd2h5IGEgZmxhZyBhbnkgdmVydGljYWwgY2FuIHNldCBpcyBzYWZlIHRvIGFjdCBvbi5cbiAqXG4gKiBUaGlzIGZpZ3VyZSBmb2xsb3dzIHBsYXRmb3JtIGludGVudHMgYW5kIGxha2Ugc2hpcHBpbmcuIEV4cG9ydGVkIGV2ZW50cyBoYXZlIHRoZWlyXG4gKiBvd24ga2lja2VkIHB1bGwsIHNob3duIHNlcGFyYXRlbHkgYnkgQ29tbXVuaWNhdGlvbkZsb3cgaW4gY2hhcHRlciA3LlxuICpcbiAqIFNhbWUgY29udHJhY3QgYXMgdGhlIHNpYmxpbmcgY29udGVudCBtb2R1bGVzOiBhIGZhY3QgdHlwZWQgaW50byB0aGUgdGVtcGxhdGUgcmVuZGVycyBvblxuICogdGhlIHBhZ2UgYW5kIHZhbmlzaGVzIGZyb20gbGxtcy50eHQuIFB1dCBpdCBoZXJlLlxuICovXG5cbmV4cG9ydCBjb25zdCBhcmlhID1cbiAgJ09uZSBvcGVyYXRpb24gY29tbWl0cyBpdHMgcm93cywgaXRzIGV2ZW50cyBhbmQgYW55IHBsYXRmb3JtIGludGVudHMgaW4gYSBzaW5nbGUgJyArXG4gICd0cmFuc2FjdGlvbi4gVHdvIHBhdGhzIHRoZW4gcmVhY2ggdGhlIGNvbnRyb2wgcGxhbmU6IGEgZmxhZyBvbiB0aGUgcmVzcG9uc2UsIHdoaWNoIHRoZSAnICtcbiAgJ3JvdXRlciB0dXJucyBpbnRvIGFuIGltbWVkaWF0ZSBkcmFpbiBvZiB0aGF0IHNjb3BlLCBhbmQgYSBzd2VlcCBldmVyeSAxNSBtaW51dGVzIG92ZXIgJyArXG4gICdldmVyeSBhY3RpdmUgc2NvcGUuIFRoZSBjb250cm9sIHBsYW5lIHJlYWRzIHRoZSBzY29wZSBpdHNlbGYsIGV4ZWN1dGVzIGludGVudHMsIGFuZCBzaGlwcyAnICtcbiAgJ2V2ZW50cyB0byB0aGUgVGllci0yIGxha2UuJztcblxuZXhwb3J0IGludGVyZmFjZSBCb3gge1xuICByZWFkb25seSB0YWc6IHN0cmluZztcbiAgcmVhZG9ubHkgdGl0bGU6IHN0cmluZztcbiAgcmVhZG9ubHkgc3ViOiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuZXhwb3J0IGNvbnN0IGNvbW1pdDogQm94ID0ge1xuICB0YWc6ICdpbiB0aGUgc2NvcGUgXHUwMEI3IG9uZSB0cmFuc2FjdGlvbicsXG4gIHRpdGxlOiAnQW4gb3BlcmF0aW9uIGNvbW1pdHMnLFxuICBzdWI6IFsneW91ciByb3dzIFx1MDBCNyBpdHMgZXZlbnRzIGluIF9zdWJzdHJhdF9vdXRib3gnLCAnYSBwbGF0Zm9ybSBpbnRlbnQsIGlmIGl0IGFza2VkIGZvciBvbmUnXSxcbn07XG5cbi8qKiBUaGUgbGF0ZW5jeSBwYXRoLiAqL1xuZXhwb3J0IGNvbnN0IHRvS2ljayA9ICdyZXNwb25zZSBmbGFnZ2VkJztcblxuZXhwb3J0IGNvbnN0IGtpY2s6IEJveCA9IHtcbiAgdGFnOiAnbGF0ZW5jeSBcdTAwQjcgc2Vjb25kcycsXG4gIHRpdGxlOiAnVGhlIHJvdXRlciBraWNrcycsXG4gIHN1YjogWydyZXR1cm5zIHRoZSByZXNwb25zZSB0byB0aGUgdXNlciBmaXJzdCcsICd0aGVuIGFza3MgZm9yIGEgZHJhaW4gXHUwMEI3IGludGVudHMgYW5kIGV4cG9ydHMnXSxcbn07XG5cbi8qKiBUaGUgcmVsaWFiaWxpdHkgcGF0aC4gTm90aGluZyBmbG93cyBJTlRPIGl0OiBpdCBydW5zIG9uIGEgY2xvY2ssIG5vdCBhIHNpZ25hbC4gKi9cbmV4cG9ydCBjb25zdCBzd2VlcDogQm94ID0ge1xuICB0YWc6ICdiYWNrc3RvcCBcdTAwQjcgZXZlcnkgMTUgbWludXRlcycsXG4gIHRpdGxlOiAnVGhlIHBsYXRmb3JtIHN3ZWVwJyxcbiAgc3ViOiBbJ3dhbGtzIGV2ZXJ5IGFjdGl2ZSBzY29wZScsICdjYXRjaGVzIGFueXRoaW5nIGEga2ljayBtaXNzZWQnXSxcbn07XG5cbmV4cG9ydCBjb25zdCBmcm9tS2ljayA9ICduYW1lcyBhIHNjb3BlLCBjYXJyaWVzIG5vIGRhdGEnO1xuZXhwb3J0IGNvbnN0IGZyb21Td2VlcCA9ICdlYWNoIGFjdGl2ZSBzY29wZSc7XG5cbmV4cG9ydCBjb25zdCBwbGF0Zm9ybTogQm94ID0ge1xuICB0YWc6ICdwbGF0Zm9ybSBcdTAwQjcgdGhlIG9ubHkgdGhpbmcgdGhhdCBhY3RzJyxcbiAgdGl0bGU6ICdUaGUgY29udHJvbCBwbGFuZSBkcmFpbnMgdGhlIHNjb3BlJyxcbiAgc3ViOiBbXG4gICAgXCJyZWFkcyB0aGUgcm93cyBpdHNlbGYsIHRocm91Z2ggdGhlIHZlcnRpY2FsJ3MgL2ludGVybmFsIHJvdXRlc1wiLFxuICAgIFwic28gYSBraWNrIGNhbiBzcGVlZCB1cCBhIHNjb3BlJ3Mgb3duIHdvcmssIG5ldmVyIGZvcmdlIGl0XCIsXG4gIF0sXG59O1xuXG5leHBvcnQgY29uc3QgdG9JbnRlbnRzID0gJ2V4ZWN1dGVzJztcbmV4cG9ydCBjb25zdCBpbnRlbnRzOiBCb3ggPSB7XG4gIHRhZzogJ2ludGVudHMnLFxuICB0aXRsZTogJ1J1biB3aXRoIHBsYXRmb3JtIGF1dGhvcml0eScsXG4gIHN1YjogWydleGVjdXRlZCBvdXRzaWRlIHRoZSBzY29wZScsICdvdXRjb21lIHdyaXR0ZW4gYmFjayB0byBpdHMgaW50ZW50IGpvdXJuYWwnXSxcbn07XG5cbmV4cG9ydCBjb25zdCB0b0V2ZW50cyA9ICdzaGlwcyc7XG5leHBvcnQgY29uc3QgZXZlbnRzOiBCb3ggPSB7XG4gIHRhZzogJ2V2ZW50cyBcdTAwQjcgdGllciAyJyxcbiAgdGl0bGU6ICdTaGlwcGVkIHRvIHRoZSBsYWtlJyxcbiAgc3ViOiBbJ21hcmtlZCBzaGlwcGVkIG9ubHkgb25jZSB0aGUgbGFrZSBjb25maXJtcycsICd0aHJvdWdoIHRoZSBzd2VlcCBvbmx5IFx1MjAxNCBubyBraWNrIHlldCddLFxufTtcblxuZXhwb3J0IGNvbnN0IGNhcHRpb24gPVxuICAnVGhlIGtpY2sgYW5kIHRoZSBzd2VlcCBhcmUgbm90IGFsdGVybmF0aXZlcy4gVGhlIGtpY2sgbWFrZXMgaXQgZmFzdDsgdGhlIHN3ZWVwIG1ha2VzIGl0ICcgK1xuICAnY2VydGFpbiBcdTIwMTQgYSBsb3N0IGtpY2sgY29zdHMgYSB3YWl0LCBuZXZlciBhIG1pc3NlZCBpbnRlbnQgb3IgZXZlbnQuIE5laXRoZXIgY2FycmllcyBkYXRhOiAnICtcbiAgJ3RoZSBjb250cm9sIHBsYW5lIGFsd2F5cyByZWFkcyB0aGUgc2NvcGUgaXRzZWxmLiBUaGlzIGZpZ3VyZSBmb2xsb3dzIGludGVudHMgYW5kIGxha2UgJyArXG4gICdzaGlwcGluZzsgY2hhcHRlciA3IHNob3dzIHRoZSBzZXBhcmF0ZSBraWNrZWQgcHVsbCBmb3IgZXhwb3J0ZWQgZXZlbnRzLic7XG5cbmV4cG9ydCBmdW5jdGlvbiBhbHQoKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZSA9IChiOiBCb3gpID0+IGAqKiR7Yi50aXRsZX0qKiAoJHtiLnRhZ30pIFx1MjAxNCAke2Iuc3ViLmpvaW4oJzsgJyl9LmA7XG4gIHJldHVybiBbXG4gICAgJyoqRGlhZ3JhbSBcdTIwMTQgaG93IGNvbW1pdHRlZCB3b3JrIGxlYXZlcyBhIHNjb3BlLioqJyxcbiAgICAnJyxcbiAgICBgMS4gJHtsaW5lKGNvbW1pdCl9YCxcbiAgICAnMi4gVHdvIHBhdGhzIHJlYWNoIHRoZSBjb250cm9sIHBsYW5lOicsXG4gICAgYCAgIC0gJHt0b0tpY2t9OiAke2xpbmUoa2ljayl9IEl0ICR7ZnJvbUtpY2t9LmAsXG4gICAgYCAgIC0gJHtsaW5lKHN3ZWVwKX0gSXQgcnVucyBvbiBhIHRpbWVyIHJhdGhlciB0aGFuIGEgc2lnbmFsLCBhbmQgZHJhaW5zICR7ZnJvbVN3ZWVwfS5gLFxuICAgIGAzLiAke2xpbmUocGxhdGZvcm0pfWAsXG4gICAgYDQuIEl0ICR7dG9JbnRlbnRzfSBpbnRlbnRzIFx1MjAxNCAke2xpbmUoaW50ZW50cyl9YCxcbiAgICBgNS4gSXQgJHt0b0V2ZW50c30gZXZlbnRzIFx1MjAxNCAke2xpbmUoZXZlbnRzKX1gLFxuICAgICcnLFxuICAgIGNhcHRpb24sXG4gIF0uam9pbignXFxuJyk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvSW5zdGFuY2VSZXNvbHV0aW9uLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvSW5zdGFuY2VSZXNvbHV0aW9uLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBXaGF0IGEgaG9zdG5hbWUgYWN0dWFsbHkgc2VydmVzLCBhbmQgd2hpY2ggcGFydCBvZiB0aGF0IGlzIGFsbG93ZWQgdG8gbW92ZS5cbiAqXG4gKiBUaGUgcGFnZSdzIHdob2xlIGFyZ3VtZW50IGlzIHRoYXQgYW4gaW5zdGFuY2UgaXMgYChzY29wZSBcdTAwRDcgdmVyc2lvbilgIGFuZCB0aGF0XG4gKiBleGFjdGx5IG9uZSBvZiB0aGUgdGhyZWUgcHJpbWl0aXZlcyBpcyBtdXRhYmxlLiBSZWFkIGFzIHByb3NlIGl0IGlzIGZvdXJcbiAqIHNlY3Rpb25zOyBkcmF3biwgaXQgaXMgb25lIGxvb2t1cCB3aXRoIGEgdGFibGUgb2Ygd2hhdCBtb3ZlcyB0aGUgYmluZGluZy5cbiAqXG4gKiBUaGlzIGlzIHRoZSBtZWNoYW5pc20gYmVoaW5kICM1MjcsIHdoZXJlIGEgcHJldmlldyBpbmhlcml0ZWQgYHNlcnZpbmdfcmVmYCBhbmRcbiAqIHRoZXJlZm9yZSBzZXJ2ZWQgcHJvZHVjdGlvbiBjb2RlLiBBIHBpY3R1cmUgdGhhdCBwdXRzIHRoZSBtdXRhYmxlIGxpbmsgaW4gdGhlXG4gKiBtaWRkbGUgaXMgdGhlIHBvaW50LlxuICpcbiAqIFNhbWUgY29udHJhY3QgYXMgdGhlIHNpYmxpbmcgY29udGVudCBtb2R1bGVzOiBhIGZhY3QgdHlwZWQgaW50byB0aGUgdGVtcGxhdGVcbiAqIHJlbmRlcnMgb24gdGhlIHBhZ2UgYW5kIHZhbmlzaGVzIGZyb20gbGxtcy50eHQuIFB1dCBpdCBoZXJlLlxuICovXG5cbmV4cG9ydCBjb25zdCBhcmlhID1cbiAgJ0EgaG9zdG5hbWUgcmVzb2x2ZXMgdG8gYSBzY29wZSwgbmV2ZXIgdG8gYSB2ZXJzaW9uLiBUaGUgc2NvcGUgaXMgYm91bmQgdG8gYSB2ZXJzaW9uIGlkLCAnICtcbiAgJ2FuZCB0aGF0IGJpbmRpbmcgaXMgdGhlIG9ubHkgbXV0YWJsZSBsaW5rLiBUaGUgdmVyc2lvbiBpZCByZXNvbHZlcyB0byBhbiBpbW11dGFibGUgJyArXG4gICdkZXBsb3ltZW50UmVmLiBQcm9kLCB0ZXN0IGFuZCBwcmV2aWV3IGRpZmZlciBvbmx5IGluIHdoYXQgbW92ZXMgdGhlIGJpbmRpbmcuJztcblxuZXhwb3J0IGNvbnN0IGNoYWluID0gW1xuICB7XG4gICAgdGFnOiAnc3RhYmxlJyxcbiAgICB0aXRsZTogJ0hvc3RuYW1lJyxcbiAgICBzdWI6ICduYW1lcyBhIHNjb3BlLCBuZXZlciBhIHZlcnNpb24nLFxuICAgIGdpdDogJ2EgY2hlY2tvdXQgcGF0aCcsXG4gICAgbXV0YWJsZTogZmFsc2UsXG4gIH0sXG4gIHtcbiAgICB0YWc6ICd0aGUgdGhpbmcgdGhhdCBpcyBuYW1lZCcsXG4gICAgdGl0bGU6ICdTY29wZScsXG4gICAgc3ViOiAnb25lIGlzb2xhdGlvbiBkb21haW4sIG9uZSBkYXRhYmFzZScsXG4gICAgZ2l0OiAnXHUyMDE0JyxcbiAgICBtdXRhYmxlOiBmYWxzZSxcbiAgfSxcbiAge1xuICAgIHRhZzogJ2ltbXV0YWJsZScsXG4gICAgdGl0bGU6ICdWZXJzaW9uIGlkIFx1MjE5MiBkZXBsb3ltZW50UmVmJyxcbiAgICBzdWI6ICdhIHB1c2hlZCBidWlsZCBuZXZlciBjaGFuZ2VzJyxcbiAgICBnaXQ6ICdhIGNvbW1pdCBzaGEnLFxuICAgIG11dGFibGU6IGZhbHNlLFxuICB9LFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IGVkZ2VzID0gWydyZXNvbHZlcyB0bycsICdjdXJyZW50bHkgYm91bmQgdG8nXSBhcyBjb25zdDtcblxuLyoqIFRoZSBvbmUgbXV0YWJsZSBsaW5rLCBhbmQgdGhlIG9ubHkgdGhpbmcgdGhhdCBkaXN0aW5ndWlzaGVzIGFuIGVudmlyb25tZW50LiAqL1xuZXhwb3J0IGNvbnN0IGJpbmRpbmcgPSB7XG4gIHRpdGxlOiAndGhlIGJpbmRpbmcnLFxuICBkZXRhaWw6ICdiaW5kU2NvcGVWZXJzaW9uIFx1MjAxNCBtdXRhYmxlIGJ5IGRlc2lnbicsXG4gIGdpdDogJ2EgYnJhbmNoIHJlZicsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgZW52aXJvbm1lbnRzID0gW1xuICBbJ3Byb2QnLCAnYW4gZXhwbGljaXQsIGFja25vd2xlZGdlZCBwcm9tb3RlIFx1MjAxNCBjYXNjYWRlcyBhY3Jvc3MgYSBzaGFyZWQgdmVydGljYWxcdTIwMTlzIHRlbmFudHMnXSxcbiAgWyd0ZXN0JywgJ2V2ZXJ5IG1lcmdlIHRvIG1haW4sIG9uZSBzY29wZSwgdW5nYXRlZCwgZHJpdmVuIGZyb20gQ0knXSxcbiAgWydwcmV2aWV3JywgJ2VhY2ggcHVzaCB0byB0aGUgUFIgXHUyMDE0IGl0cyBvd24gc2NvcGUsIHNvIGl0IGNhbiBuZXZlciBpbmhlcml0IHByb2RcdTIwMTlzIGJpbmRpbmcnXSxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBjYXB0aW9uID1cbiAgJ05vdGhpbmcgZWxzZSBuYW1lcyBhbiBlbnZpcm9ubWVudC4gXHUyMDFDcHJvZFx1MjAxRCBhbmQgXHUyMDFDdGVzdFx1MjAxRCBhcmUgdGhlIHNhbWUgc2hhcGUgXHUyMDE0IGEgc3RhYmxlIHNjb3BlIGFuZCAnICtcbiAgJ2Egc3RhYmxlIGhvc3RuYW1lIHdob3NlIGJpbmRpbmcgbW92ZXM7IG9ubHkgdGhlIHRyaWdnZXIgYW5kIGhvdyBnYXRlZCBpdCBpcyBkaWZmZXIuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGFsdCgpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgICcqKkRpYWdyYW0gXHUyMDE0IHdoYXQgYSBob3N0bmFtZSBzZXJ2ZXMuKiogQW4gaW5zdGFuY2UgaXMgYChzY29wZSBcdTAwRDcgdmVyc2lvbilgLCBhbmQgZXhhY3RseSBvbmUgJyArXG4gICAgICAnbGluayBpbiB0aGUgY2hhaW4gaXMgbXV0YWJsZS4nLFxuICAgICcnLFxuICAgIGAxLiAqKiR7Y2hhaW5bMF0udGl0bGV9KiogKCR7Y2hhaW5bMF0udGFnfSwgJHtjaGFpblswXS5naXR9KSBcdTIwMTQgJHtjaGFpblswXS5zdWJ9LmAsXG4gICAgYDIuICoke2VkZ2VzWzBdfSogXHUyMTkyICoqJHtjaGFpblsxXS50aXRsZX0qKiBcdTIwMTQgJHtjaGFpblsxXS5zdWJ9LmAsXG4gICAgYDMuICoke2VkZ2VzWzFdfSogXHUyMDE0IHRoaXMgaXMgKioke2JpbmRpbmcudGl0bGV9KiogKCR7YmluZGluZy5naXR9KTogJHtiaW5kaW5nLmRldGFpbH0uIGAgK1xuICAgICAgJ0l0IGlzIHRoZSBvbmx5IG11dGFibGUgbGluaywgYW5kIHRoZSBvbmx5IHRoaW5nIGFuIGVudmlyb25tZW50IGlzLicsXG4gICAgYDQuIFx1MjE5MiAqKiR7Y2hhaW5bMl0udGl0bGV9KiogKCR7Y2hhaW5bMl0udGFnfSwgJHtjaGFpblsyXS5naXR9KSBcdTIwMTQgJHtjaGFpblsyXS5zdWJ9LmAsXG4gICAgJycsXG4gICAgJyoqV2hhdCBtb3ZlcyB0aGUgYmluZGluZzoqKicsXG4gICAgLi4uZW52aXJvbm1lbnRzLm1hcCgoW2VudiwgdHJpZ2dlcl0pID0+IGAtICoqJHtlbnZ9KiogXHUyMDE0ICR7dHJpZ2dlcn0uYCksXG4gICAgJycsXG4gICAgY2FwdGlvbixcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9UZW5hbmN5VHJlZS5jb250ZW50Lm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1RlbmFuY3lUcmVlLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBXaGF0IGEgdGVuYW50IGNvbnRhaW5zLCBhbmQgd2hlcmUgdGhlIGRhdGFiYXNlIGJvdW5kYXJ5IGFjdHVhbGx5IGZhbGxzLlxuICpcbiAqIFRoZSBwYWdlIGNhcnJpZXMgdHdvIGNsYWltcyB0aGF0IGFyZSBzaGFwZXM6IHRlbmFuY3kgaXMgYSAqKnRyZWUqKiwgYW5kIG9uZVxuICogc2NvcGUgaXMgb25lIGRhdGFiYXNlIGlzIG9uZSBjb25zaXN0ZW5jeSBkb21haW4uIFByb3NlIGhhcyB0byB3YWxrIGEgcmVhZGVyXG4gKiB0aHJvdWdoIGJvdGg7IGEgcGljdHVyZSBwdXRzIHRoZSBib3VuZGFyeSB3aGVyZSBpdCBpcyBhbmQgdGhlIGFyZ3VtZW50IGlzXG4gKiBvdmVyLlxuICpcbiAqIGBwYXJlbnRTY29wZUlkYCBpcyBkcmF3biBiZWNhdXNlIGl0cyBiZWluZyBudWxsIGlzIGEgZmFjdCBhYm91dCB0b2RheSwgbm90XG4gKiBhYm91dCB0aGUgbW9kZWwgXHUyMDE0IHRoZSBjb2x1bW4gZXhpc3RzIHNvIGRlZXBlciB0cmVlcyBhcmUgYWRkaXRpdmUgcmF0aGVyIHRoYW5cbiAqIGEgbWlncmF0aW9uLCBhbmQgYSBkaWFncmFtIHRoYXQgb21pdHMgaXQgcXVpZXRseSBjbGFpbXMgdGhlIG9wcG9zaXRlLlxuICpcbiAqIFNhbWUgY29udHJhY3QgYXMgdGhlIHNpYmxpbmcgY29udGVudCBtb2R1bGVzOiBhIGZhY3QgdHlwZWQgaW50byB0aGUgdGVtcGxhdGVcbiAqIHJlbmRlcnMgb24gdGhlIHBhZ2UgYW5kIHZhbmlzaGVzIGZyb20gbGxtcy50eHQuIFB1dCBpdCBoZXJlLlxuICovXG5cbmV4cG9ydCBjb25zdCBhcmlhID1cbiAgJ0EgdGVuYW50IGlzIGEgYmlsbGluZyBhbmQgaWRlbnRpdHkgYm91bmRhcnkgY29udGFpbmluZyBvbmUgb3IgbW9yZSBzY29wZXMuIEVhY2ggc2NvcGUgaXMgJyArXG4gICdpdHMgb3duIGRhdGFiYXNlIGFuZCBpdHMgb3duIGNvbnNpc3RlbmN5IGRvbWFpbiwgd2l0aCBpdHMgb3duIGtpbmQsIGp1cmlzZGljdGlvbiBhbmQgYm91bmQgJyArXG4gICd2ZXJ0aWNhbCB2ZXJzaW9uLiBOb3RoaW5nIGpvaW5zIGFjcm9zcyB0aGUgYm91bmRhcnkgYmV0d2VlbiB0d28gc2NvcGVzLic7XG5cbmV4cG9ydCBjb25zdCB0ZW5hbnQgPSB7XG4gIHRhZzogJ2JpbGxpbmcgXHUwMEI3IGlkZW50aXR5IFx1MDBCNyB0aGUgY29udHJhY3QnLFxuICB0aXRsZTogJ1RlbmFudCcsXG4gIHN1YjogJ3NsdWcgXHUwMEI3IHN0YXR1cyBcdTAwQjcgb25lIElkZW50aXR5IERPIGZvciBhbGwgaXRzIHBlb3BsZScsXG4gIG5vdGU6ICdIb2xkcyBubyBvcGVyYXRpb25hbCByb3dzIG9mIGl0cyBvd24uJyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBzY29wZXMgPSBbXG4gIHsgc2x1ZzogJ3N0b2NraG9sbScsIGtpbmQ6ICdicmFuY2gnLCBub3RlOiAnYWN0aXZlIFx1MDBCNyBldScgfSxcbiAgeyBzbHVnOiAnZ1x1MDBGNnRlYm9yZycsIGtpbmQ6ICdicmFuY2gnLCBub3RlOiAnYWN0aXZlIFx1MDBCNyBldScgfSxcbiAgeyBzbHVnOiAnbWFsbVx1MDBGNicsIGtpbmQ6ICdicmFuY2gnLCBub3RlOiAncHJvdmlzaW9uaW5nJyB9LFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IHNjb3BlRmFjdHMgPSBbXG4gICdpdHMgb3duIGRhdGFiYXNlIFx1MjAxNCBvbmUgU1FMaXRlIGZpbGUsIG9yIG9uZSBEdXJhYmxlIE9iamVjdCcsXG4gICdvbmUgb3BlcmF0aW9uIGF0IGEgdGltZSwgcnVuIHRvIGNvbXBsZXRpb24nLFxuICAna2luZCBpcyB5b3VyIHZvY2FidWxhcnk6IGJyZiwgYnJhbmNoLCBicmFuZCwgY2xpbmljXHUyMDI2JyxcbiAgJ2p1cmlzZGljdGlvbiBhbmQgYm91bmQgdmVyc2lvbiBhcmUgZml4ZWQgcGVyIHNjb3BlJyxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBiYXJyaWVyID0gJ05vIHF1ZXJ5IGNyb3NzZXMgdGhlc2UgbGluZXMuIFRoZXJlIGlzIG5vIGpvaW4gYmV0d2VlbiB0d28gc2NvcGVzLic7XG5cbmV4cG9ydCBjb25zdCBkZWVwZXIgPVxuICAncGFyZW50U2NvcGVJZCBpcyBudWxsIG9uIGV2ZXJ5IHNjb3BlIHRvZGF5LiBUaGUgY29sdW1uIGV4aXN0cyBzbyBhIGRlZXBlciB0cmVlIGlzIGFuICcgK1xuICAnYWRkaXRpb24gcmF0aGVyIHRoYW4gYSBtaWdyYXRpb24uJztcblxuZXhwb3J0IGNvbnN0IGNhcHRpb24gPVxuICAnVGhlIHRlbmFudCBpcyB3aG8geW91IGJpbGwgYW5kIHdobyBjYW4gbG9nIGluLiBUaGUgc2NvcGUgaXMgd2hlcmUgZGF0YSBsaXZlcyBhbmQgd2hlcmUgJyArXG4gICdjb25zaXN0ZW5jeSBpcyBkZWNpZGVkIFx1MjAxNCB3aGljaCBpcyB3aHkgaXNvbGF0aW9uIGlzIGEgcHJvcGVydHkgb2YgdGhlIHN1YnN0cmF0ZSBoZXJlLCBub3QgYSAnICtcbiAgJ1dIRVJFIGNsYXVzZSBzb21lYm9keSBoYXMgdG8gcmVtZW1iZXIuJztcblxuZXhwb3J0IGZ1bmN0aW9uIGFsdCgpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgICcqKkRpYWdyYW0gXHUyMDE0IGEgdGVuYW50IGFuZCBpdHMgc2NvcGVzLioqJyxcbiAgICAnJyxcbiAgICBgLSAqKiR7dGVuYW50LnRpdGxlfSoqICgke3RlbmFudC50YWd9KSBcdTIwMTQgJHt0ZW5hbnQuc3VifS4gJHt0ZW5hbnQubm90ZX1gLFxuICAgIGAtIEl0IGNvbnRhaW5zIHNjb3BlczogJHtzY29wZXMubWFwKChzKSA9PiBgXFxgJHtzLnNsdWd9XFxgICgke3Mua2luZH0sICR7cy5ub3RlfSlgKS5qb2luKCcsICcpfS5gLFxuICAgICctIEV2ZXJ5IHNjb3BlIGlzOiAnICsgc2NvcGVGYWN0cy5qb2luKCc7ICcpICsgJy4nLFxuICAgIGAtICoqJHtiYXJyaWVyfSoqYCxcbiAgICBgLSAke2RlZXBlcn1gLFxuICAgICcnLFxuICAgIGNhcHRpb24sXG4gIF0uam9pbignXFxuJyk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvUmVhZFBhdGhzLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvUmVhZFBhdGhzLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBUaGUgdGhyZWUgcmVhZCBwYXRocywgZHJhd24gYXMgdGhlIGNvbXBhcmlzb24gdGhlIHBhZ2UgaXMgYWN0dWFsbHkgbWFraW5nLlxuICpcbiAqIEEgdGFibGUgZ2l2ZXMgbGF0ZW5jeSBhbmQgY29uc2lzdGVuY3kgcGVyIHBhdGggYnV0IG5vdCB0aGUgdGhpbmcgdGhhdCBkZWNpZGVzXG4gKiBiZXR3ZWVuIHRoZW06IGhvdyBmYXIgdGhlIGRhdGEgaGFzIHRyYXZlbGxlZCBmcm9tIHRoZSBzY29wZSB0aGF0IG93bnMgaXQuXG4gKiBUaGF0IGRpc3RhbmNlIElTIHRoZSBzdGFsZW5lc3MsIGFuZCBpdCBpcyB3aHkgdGhlIGRlZmF1bHQgaGFzIG5vbmUgXHUyMDE0IHRoZVxuICogYSBzdWNjZXNzZnVsIHByb2plY3Rpb24gY29uc3VtZXIgcnVucyBpbiB0aGUgc2FtZSBzZXJpYWxpemVkIHR1cm4gYXMgdGhlIHdyaXRlXG4gKiBpdCBkZXJpdmVzIGZyb20sIGluIGEgc2VwYXJhdGUgdHJhbnNhY3Rpb24uIEEgZmFpbGVkIGNvbnN1bWVyIGNhbiBsZWF2ZSBpdCBiZWhpbmQuXG4gKlxuICogRHJhd24gYXMgaW5jcmVhc2luZyBkaXN0YW5jZSBmcm9tIG9uZSBib3VuZGFyeSByYXRoZXIgdGhhbiB0aHJlZSBwZWVyIGJveGVzOlxuICogdGhyZWUgYm94ZXMgc2lkZSBieSBzaWRlIHdvdWxkIHJlc3RhdGUgdGhlIHRhYmxlLCB3aGljaCBpcyB0aGUgZmFpbHVyZSBtb2RlXG4gKiB0aGUgcGljdHVyZSBleGlzdHMgdG8gYXZvaWQuXG4gKlxuICogU2FtZSBjb250cmFjdCBhcyB0aGUgc2libGluZyBjb250ZW50IG1vZHVsZXM6IGEgZmFjdCB0eXBlZCBpbnRvIHRoZSB0ZW1wbGF0ZVxuICogcmVuZGVycyBvbiB0aGUgcGFnZSBhbmQgdmFuaXNoZXMgZnJvbSBsbG1zLnR4dC4gUHV0IGl0IGhlcmUuXG4gKi9cblxuZXhwb3J0IGNvbnN0IGFyaWEgPVxuICAnVGhyZWUgcmVhZCBwYXRocyBhdCBpbmNyZWFzaW5nIGRpc3RhbmNlIGZyb20gdGhlIHNjb3BlLiBBbiBpbi1zY29wZSByZWFkIGlzIGEgbG9jYWwgJyArXG4gICdpbmRleGVkIHF1ZXJ5LiBBbiBleHRlcm5hbCByZWFkIG1vZGVsIGlzIGZlZCBieSBldmVudHMgYW5kIGlzIGV2ZW50dWFsbHkgJyArXG4gICdjb25zaXN0ZW50LiBUaGUgaGlzdG9yeSB0aWVyIGlzIGZlZCBieSBleHBvcnQgYW5kIGlzIG5vdCBhIHJlYWQgdGllciBmb3IgaW50ZXJhY3RpdmUgdXNlLic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGF0aCB7XG4gIHJlYWRvbmx5IG46IG51bWJlcjtcbiAgcmVhZG9ubHkgdGl0bGU6IHN0cmluZztcbiAgcmVhZG9ubHkgbGF0ZW5jeTogc3RyaW5nO1xuICByZWFkb25seSBjb25zaXN0ZW5jeTogc3RyaW5nO1xuICByZWFkb25seSB1c2U6IHN0cmluZztcbiAgcmVhZG9ubHkgaG93OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGluc2lkZTogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNvbnN0IHBhdGhzOiByZWFkb25seSBQYXRoW10gPSBbXG4gIHtcbiAgICBuOiAxLFxuICAgIHRpdGxlOiAnSW4tc2NvcGUgcmVhZCcsXG4gICAgbGF0ZW5jeTogJ1x1MDBCNXMnLFxuICAgIGNvbnNpc3RlbmN5OiAnc2VyaWFsaXphYmxlJyxcbiAgICB1c2U6ICdldmVyeXRoaW5nIGludGVyYWN0aXZlJyxcbiAgICBob3c6ICdsb2NhbCB0YWJsZXM7IHByb2plY3Rpb24gY29uc3VtZXJzIHJ1biBhZnRlciBjb21taXQgaW4gdGhlIHNhbWUgdHVybicsXG4gICAgaW5zaWRlOiB0cnVlLFxuICB9LFxuICB7XG4gICAgbjogMixcbiAgICB0aXRsZTogJ0V4dGVybmFsIHJlYWQgbW9kZWwnLFxuICAgIGxhdGVuY3k6ICdtcycsXG4gICAgY29uc2lzdGVuY3k6ICdldmVudHVhbGx5IGNvbnNpc3RlbnQnLFxuICAgIHVzZTogJ2Egc2NvcGUgd2hvc2UgcmVhZHMgb3V0Z3JvdyBpdHMgZXhlY3V0b3InLFxuICAgIGhvdzogJ2ZlZCBieSBldmVudHMgb2ZmIHRoZSBzcGluZScsXG4gICAgaW5zaWRlOiBmYWxzZSxcbiAgfSxcbiAge1xuICAgIG46IDMsXG4gICAgdGl0bGU6ICdIaXN0b3J5IHRpZXInLFxuICAgIGxhdGVuY3k6ICdzZWNvbmRzJyxcbiAgICBjb25zaXN0ZW5jeTogJ2V2ZW50dWFsbHkgY29uc2lzdGVudCcsXG4gICAgdXNlOiAncmVwb3J0aW5nLCBhdWRpdCwgY3Jvc3Mtc2NvcGUnLFxuICAgIGhvdzogJ2V4cG9ydGVkIHRvIEljZWJlcmcgLyBSMiBTUUwnLFxuICAgIGluc2lkZTogZmFsc2UsXG4gIH0sXG5dO1xuXG5leHBvcnQgY29uc3QgYm91bmRhcnkgPVxuICAndGhlIHNjb3BlIGJvdW5kYXJ5IFx1MjAxNCBldmVyeXRoaW5nIGJlbG93IGl0IGlzIGFsbG93ZWQgdG8gYmUgYmVoaW5kJztcblxuZXhwb3J0IGNvbnN0IG9yZGVyID0gJ1JlYWNoIGZvciB0aGVtIGluIHRoaXMgb3JkZXIuJztcblxuZXhwb3J0IGNvbnN0IGNhcHRpb24gPVxuICAnQW4gaW4tc2NvcGUgcHJvamVjdGlvbiBoYXMgbm8gdmlzaWJsZSBnYXAgd2hlbiBpdHMgY29uc3VtZXIgc3VjY2VlZHM7IGEgZmFpbGVkIGNvbnN1bWVyIGNhbiBsZWF2ZSBpdCBiZWhpbmQuICcgK1xuICAnRXh0ZXJuYWwgcHJvamVjdGlvbnMgaGF2ZSBkZWxpdmVyeSBsYWcuIFRoZSBoaXN0b3J5IGdhdGV3YXkgaXMgc3RhZmYtb25seSBhbmQgcmVxdWlyZXMgY29uZmlndXJhdGlvbjsgJyArXG4gICdpdCBpcyBub3QgYW4gaW50ZXJhY3RpdmUgcmVhZCB0aWVyLic7XG5cbmV4cG9ydCBmdW5jdGlvbiBhbHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBgKipEaWFncmFtIFx1MjAxNCB0aGUgdGhyZWUgcmVhZCBwYXRocy4qKiAke29yZGVyfSBUaGUgZnVydGhlciBhIHBhdGggc2l0cyBmcm9tIHRoZSBzY29wZSB0aGF0IGAgK1xuICAgICAgJ293bnMgdGhlIGRhdGEsIHRoZSBzdGFsZXIgaXQgaXMgYWxsb3dlZCB0byBiZS4nLFxuICAgICcnLFxuICAgIC4uLnBhdGhzLm1hcChcbiAgICAgIChwKSA9PlxuICAgICAgICBgJHtwLm59LiAqKiR7cC50aXRsZX0qKiBcdTIwMTQgJHtwLmxhdGVuY3l9LCAke3AuY29uc2lzdGVuY3l9LiBGb3IgJHtwLnVzZX0uIGAgK1xuICAgICAgICBgJHtwLmluc2lkZSA/ICdJbnNpZGUgdGhlIHNjb3BlIGJvdW5kYXJ5JyA6ICdPdXRzaWRlIHRoZSBzY29wZSBib3VuZGFyeSd9OiAke3AuaG93fS5gLFxuICAgICksXG4gICAgJycsXG4gICAgY2FwdGlvbixcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9Db25uZWN0b3JMb29wLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvQ29ubmVjdG9yTG9vcC5jb250ZW50Lm10c1wiOy8qKlxuICogVGhlIGNvbm5lY3RvciByb3VuZCB0cmlwLCBhbmQgaXRzIG1hcmtkb3duIHR3aW4uXG4gKlxuICogUmVwbGFjZXMgdGhlIEFTQ0lJIGJsb2NrIHRoYXQgc3Rvb2QgaW4gY29ubmVjdG9ycy9pbmRleC5tZC4gVGhlIEFTQ0lJIHNhaWRcbiAqIHRoZSBzYW1lIHRoaW5nczsgd2hhdCBpdCBjb3VsZCBub3Qgc2hvdyBpcyB3aHkgdGhlIGxvb3AgbGVhdmVzIHRoZSBzY29wZSBhdFxuICogYWxsIFx1MjAxNCB0aGUgc2NvcGUgaGFzIG5vIGZldGNoIGFuZCBub3doZXJlIHRvIGtlZXAgYSBjcmVkZW50aWFsLCBzbyB0aGUgZGVsaXZlcnlcbiAqIGlzIGhhbmRlZCBPVVQgdG8gdGhlIHdvcmtlciBhbmQgdGhlIHJlc3VsdCBjb21lcyBiYWNrIGluIHRocm91Z2ggYSBkaWZmZXJlbnRcbiAqIGRvb3IsIG9uIHRoZSBjb25uZWN0aW9uJ3Mgb3duIGF1dGhvcml0eS5cbiAqXG4gKiBTYW1lIGNvbnRyYWN0IGFzIHRoZSBzaWJsaW5nIGNvbnRlbnQgbW9kdWxlczogYSBmYWN0IHR5cGVkIGludG8gdGhlIHRlbXBsYXRlXG4gKiByZW5kZXJzIG9uIHRoZSBwYWdlIGFuZCB2YW5pc2hlcyBmcm9tIGxsbXMudHh0LiBQdXQgaXQgaGVyZS5cbiAqL1xuXG5leHBvcnQgY29uc3QgYXJpYSA9XG4gICdUaGUgU2NvcGUgRHVyYWJsZSBPYmplY3QgZGVsZWdhdGVzIGFuIG91dGJveCBkZWxpdmVyeSB1cCB0byB0aGUgY29ubmVjdG9yIHJ1bnRpbWUgaW4gJyArXG4gICd0aGUgdmVydGljYWwgd29ya2VyLCB3aGljaCBvcGVucyB0aGUgc2VhbGVkIGNyZWRlbnRpYWwgYW5kIGNhbGxzIHRoZSBwcm92aWRlciB3aXRoIGEgJyArXG4gICdib3VuZCBmZXRjaC4gVGhlIHByb3ZpZGVyXHUyMDE5cyBjYWxsYmFjayByZXR1cm5zIHRvIHRoZSB3b3JrZXIsIHdoaWNoIHJlb3BlbnMgdGhlIHNjb3BlICcgK1xuICAndGhyb3VnaCBnZXRDb25uZWN0b3JTY29wZSB3aXRoIHRoZSBjb25uZWN0aW9uIGFzIGl0cyBzdWJqZWN0Lic7XG5cbmV4cG9ydCBjb25zdCBzY29wZSA9IHtcbiAgdGFnOiAnZHVyYWJsZSBvYmplY3QnLFxuICB0aXRsZTogJ1Njb3BlIERPJyxcbiAgc3ViOiBbJ1RoZSBvcGVyYXRpb24gY29tbWl0dGVkOycsICd0aGUgZXZlbnQgaXMgaW4gdGhlIG91dGJveC4nXSxcbiAgY2hpcDogJ25vIGZldGNoKCkgaGVyZSBcdTIwMTQgdGhlIGxpbnQgZm9yYmlkcyBpdCcsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgcnVudGltZSA9IHtcbiAgdGFnOiAnd29ya2VyJyxcbiAgdGl0bGU6ICdDb25uZWN0b3IgcnVudGltZScsXG4gIHN1YjogWydPcGVucyB0aGUgc2VhbGVkIGNyZWRlbnRpYWwnLCAnZm9yIHRoaXMgdGVuYW50LiddLFxuICBjaGlwOiAnZmV0Y2ggYm91bmQgdG8gdGhlIGNvbm5lY3Rpb24gXHUwMEI3IHJldHJ5Jyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBwcm92aWRlciA9IHtcbiAgdGFnOiAnb3V0c2lkZSB0aGUgcGxhdGZvcm0nLFxuICB0aXRsZTogJ1RoZSBwcm92aWRlcicsXG4gIHN1YjogJ1Njcml2ZSwgRm9ydG5veCwgYSBiYW5rLicsXG4gIGNoaXA6ICduZXZlciBzZWVzIGEgcHJpbmNpcGFsJyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBhcnJvd3MgPSB7XG4gIG91dDogJ2RlbGVnYXRlcyB0aGUgZGVsaXZlcnknLFxuICBiYWNrOiAnZ2V0Q29ubmVjdG9yU2NvcGUoKScsXG4gIHNlbmQ6ICdzZW5kcyB0aGUgZG9jdW1lbnQnLFxuICBjYWxsYmFjazogJ3RoZSBwcm92aWRlciBjYWxscyBiYWNrJyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBjYXB0aW9uID1cbiAgJ0EgcHJvdmlkZXJcdTIwMTlzIGNhbGxiYWNrIGlzIG5vdCBhIHBlcnNvbiwgc28gaXQgY2Fubm90IGhvbGQgYSBwcmluY2lwYWwuIFRoZSBjb25uZWN0aW9uICcgK1xuICAnaXRzZWxmIGlzIHRoZSBzdWJqZWN0OiBnZXRDb25uZWN0b3JTY29wZSBvcGVucyBhIHN0dWIgd2hvc2UgYXV0aG9yaXR5IGlzIHRoYXQgJyArXG4gICdjb25uZWN0aW9uXHUyMDE5cyBvd24gZ3JhbnRzLCBuYXJyb3dlZCBieSBjb25zdHJ1Y3Rpb24gdG8gb25lIHRlbmFudCBhbmQgb25lIHZlcnRpY2FsLic7XG5cbmV4cG9ydCBmdW5jdGlvbiBhbHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICAnKipEaWFncmFtIFx1MjAxNCB0aGUgY29ubmVjdG9yIHJvdW5kIHRyaXAuKiogQSBkZWxpdmVyeSBsZWF2ZXMgdGhlIHNjb3BlLCBjcm9zc2VzIHRoZSAnICtcbiAgICAgICdwbGF0Zm9ybSBib3VuZGFyeSwgYW5kIGNvbWVzIGJhY2sgaW4gdGhyb3VnaCBhIGRpZmZlcmVudCBkb29yLicsXG4gICAgJycsXG4gICAgYDEuICoqJHtzY29wZS50aXRsZX0qKiAoJHtzY29wZS50YWd9KSBcdTIwMTQgJHtzY29wZS5zdWIuam9pbignICcpfSAke3Njb3BlLmNoaXB9LmAsXG4gICAgYDIuIEl0ICoqJHthcnJvd3Mub3V0fSoqIHVwIHRvIHRoZSAqKiR7cnVudGltZS50aXRsZX0qKiAoJHtydW50aW1lLnRhZ30pIFx1MjAxNCBgICtcbiAgICAgIGAke3J1bnRpbWUuc3ViLmpvaW4oJyAnKX0gJHtydW50aW1lLmNoaXB9LmAsXG4gICAgYDMuIFRoZSBydW50aW1lICoqJHthcnJvd3Muc2VuZH0qKiB0byAqKiR7cHJvdmlkZXIudGl0bGV9KiogKCR7cHJvdmlkZXIudGFnfSkgXHUyMDE0IGAgK1xuICAgICAgYCR7cHJvdmlkZXIuc3VifSBJdCAke3Byb3ZpZGVyLmNoaXB9LmAsXG4gICAgYDQuIExhdGVyLCAqKiR7YXJyb3dzLmNhbGxiYWNrfSoqOyB0aGUgd29ya2VyIHJlb3BlbnMgdGhlIHNjb3BlIHdpdGggYCArXG4gICAgICBgXFxgJHthcnJvd3MuYmFja31cXGAgYW5kIHdyaXRlcyB0aGUgcmVzdWx0IGJhY2suYCxcbiAgICAnJyxcbiAgICBjYXB0aW9uLFxuICBdLmpvaW4oJ1xcbicpO1xufVxuIiwgIntcbiAgXCJ2ZXJzaW9uXCI6IFwiMC4wLjFcIixcbiAgXCJlbnRpdGllc1wiOiB7XG4gICAgXCJyZXNlcnZhdGlvblwiOiB7XG4gICAgICBcInRhYmxlXCI6IFwiYm9va2luZ19yZXNlcnZhdGlvbnNcIixcbiAgICAgIFwiZmllbGRzXCI6IHtcbiAgICAgICAgXCJ0eXBlXCI6IFwib2JqZWN0XCIsXG4gICAgICAgIFwicHJvcGVydGllc1wiOiB7XG4gICAgICAgICAgXCJpZFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJyZXNvdXJjZV9pZFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJzdGFydHNfYXRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiZW5kc19hdFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJzdGF0ZVwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIixcbiAgICAgICAgICAgIFwiZW51bVwiOiBbXG4gICAgICAgICAgICAgIFwiaGVsZFwiLFxuICAgICAgICAgICAgICBcImNvbmZpcm1lZFwiLFxuICAgICAgICAgICAgICBcImluX3NlcnZpY2VcIixcbiAgICAgICAgICAgICAgXCJjb21wbGV0ZWRcIixcbiAgICAgICAgICAgICAgXCJleHBpcmVkXCIsXG4gICAgICAgICAgICAgIFwiY2FuY2VsbGVkXCIsXG4gICAgICAgICAgICAgIFwibm9fc2hvd1wiXG4gICAgICAgICAgICBdXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcInF1YW50aXR5XCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcIm51bWJlclwiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImV4cGlyZXNfYXRcIjoge1xuICAgICAgICAgICAgXCJhbnlPZlwiOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwibnVsbFwiXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiZmlsbF90YXJnZXRcIjoge1xuICAgICAgICAgICAgXCJhbnlPZlwiOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJudW1iZXJcIlxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwibnVsbFwiXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgICB9LFxuICAgICAgICAgIFwibm90ZVwiOiB7XG4gICAgICAgICAgICBcImFueU9mXCI6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJudWxsXCJcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJjcmVhdGVkX2J5XCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImNyZWF0ZWRfYXRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIFwicmVxdWlyZWRcIjogW1xuICAgICAgICAgIFwiaWRcIixcbiAgICAgICAgICBcInJlc291cmNlX2lkXCIsXG4gICAgICAgICAgXCJzdGFydHNfYXRcIixcbiAgICAgICAgICBcImVuZHNfYXRcIixcbiAgICAgICAgICBcInN0YXRlXCIsXG4gICAgICAgICAgXCJxdWFudGl0eVwiLFxuICAgICAgICAgIFwiZXhwaXJlc19hdFwiLFxuICAgICAgICAgIFwiZmlsbF90YXJnZXRcIixcbiAgICAgICAgICBcIm5vdGVcIixcbiAgICAgICAgICBcImNyZWF0ZWRfYnlcIixcbiAgICAgICAgICBcImNyZWF0ZWRfYXRcIlxuICAgICAgICBdLFxuICAgICAgICBcImFkZGl0aW9uYWxQcm9wZXJ0aWVzXCI6IGZhbHNlXG4gICAgICB9LFxuICAgICAgXCJwYXJlbnRzXCI6IFtcbiAgICAgICAgXCJyZXNvdXJjZVwiXG4gICAgICBdXG4gICAgfSxcbiAgICBcInJlc291cmNlXCI6IHtcbiAgICAgIFwidGFibGVcIjogXCJib29raW5nX3Jlc291cmNlc1wiLFxuICAgICAgXCJmaWVsZHNcIjoge1xuICAgICAgICBcInR5cGVcIjogXCJvYmplY3RcIixcbiAgICAgICAgXCJwcm9wZXJ0aWVzXCI6IHtcbiAgICAgICAgICBcImlkXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImtpbmRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwibmFtZVwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJjYXBhY2l0eVwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJudW1iZXJcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJhY3RpdmVcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwibnVtYmVyXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiY3JlYXRlZF9hdFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgXCJyZXF1aXJlZFwiOiBbXG4gICAgICAgICAgXCJpZFwiLFxuICAgICAgICAgIFwia2luZFwiLFxuICAgICAgICAgIFwibmFtZVwiLFxuICAgICAgICAgIFwiY2FwYWNpdHlcIixcbiAgICAgICAgICBcImFjdGl2ZVwiLFxuICAgICAgICAgIFwiY3JlYXRlZF9hdFwiXG4gICAgICAgIF0sXG4gICAgICAgIFwiYWRkaXRpb25hbFByb3BlcnRpZXNcIjogZmFsc2VcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gIFwibGlmZWN5Y2xlc1wiOiB7XG4gICAgXCJyZXNlcnZhdGlvblwiOiB7XG4gICAgICBcImZpZWxkXCI6IFwic3RhdGVcIixcbiAgICAgIFwiaW5pdGlhbFwiOiBcImhlbGRcIixcbiAgICAgIFwic3RhdGVzXCI6IHtcbiAgICAgICAgXCJjYW5jZWxsZWRcIjoge1xuICAgICAgICAgIFwidGVybWluYWxcIjogdHJ1ZVxuICAgICAgICB9LFxuICAgICAgICBcImNvbXBsZXRlZFwiOiB7XG4gICAgICAgICAgXCJ0ZXJtaW5hbFwiOiB0cnVlXG4gICAgICAgIH0sXG4gICAgICAgIFwiY29uZmlybWVkXCI6IHtcbiAgICAgICAgICBcIm9uXCI6IHtcbiAgICAgICAgICAgIFwiYm9va2luZy9jYW5jZWxcIjogXCJjYW5jZWxsZWRcIixcbiAgICAgICAgICAgIFwiYm9va2luZy9jb21wbGV0ZVwiOiBcImNvbXBsZXRlZFwiLFxuICAgICAgICAgICAgXCJib29raW5nL25vLXNob3dcIjogXCJub19zaG93XCIsXG4gICAgICAgICAgICBcImJvb2tpbmcvc3RhcnRcIjogXCJpbl9zZXJ2aWNlXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiYWxsb3dcIjogW1xuICAgICAgICAgICAgXCJib29raW5nL2pvaW5cIixcbiAgICAgICAgICAgIFwiYm9va2luZy9tb3ZlXCIsXG4gICAgICAgICAgICBcImJvb2tpbmcvb3BlblwiXG4gICAgICAgICAgXVxuICAgICAgICB9LFxuICAgICAgICBcImV4cGlyZWRcIjoge1xuICAgICAgICAgIFwidGVybWluYWxcIjogdHJ1ZVxuICAgICAgICB9LFxuICAgICAgICBcImhlbGRcIjoge1xuICAgICAgICAgIFwib25cIjoge1xuICAgICAgICAgICAgXCJib29raW5nL2NhbmNlbFwiOiBcImNhbmNlbGxlZFwiLFxuICAgICAgICAgICAgXCJib29raW5nL2NvbmZpcm1cIjogXCJjb25maXJtZWRcIixcbiAgICAgICAgICAgIFwiYm9va2luZy9leHBpcmVcIjogXCJleHBpcmVkXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiYWxsb3dcIjogW1xuICAgICAgICAgICAgXCJib29raW5nL2pvaW5cIixcbiAgICAgICAgICAgIFwiYm9va2luZy9tb3ZlXCIsXG4gICAgICAgICAgICBcImJvb2tpbmcvb3BlblwiXG4gICAgICAgICAgXVxuICAgICAgICB9LFxuICAgICAgICBcImluX3NlcnZpY2VcIjoge1xuICAgICAgICAgIFwib25cIjoge1xuICAgICAgICAgICAgXCJib29raW5nL2NvbXBsZXRlXCI6IFwiY29tcGxldGVkXCIsXG4gICAgICAgICAgICBcImJvb2tpbmcvbm8tc2hvd1wiOiBcIm5vX3Nob3dcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgXCJub19zaG93XCI6IHtcbiAgICAgICAgICBcInRlcm1pbmFsXCI6IHRydWVcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIntcbiAgXCJ2ZXJzaW9uXCI6IFwiMC4wLjFcIixcbiAgXCJlbnRpdGllc1wiOiB7XG4gICAgXCJ1bmRlcmxhZ1wiOiB7XG4gICAgICBcInRhYmxlXCI6IFwiaW52b2ljaW5nX3VuZGVybGFnXCIsXG4gICAgICBcImZpZWxkc1wiOiB7XG4gICAgICAgIFwidHlwZVwiOiBcIm9iamVjdFwiLFxuICAgICAgICBcInByb3BlcnRpZXNcIjoge1xuICAgICAgICAgIFwiaWRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwibnVtYmVyXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcIm51bWJlclwiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImN1c3RvbWVyX3R5cGVcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiY3VzdG9tZXJfaWRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwic3RhdHVzXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiLFxuICAgICAgICAgICAgXCJlbnVtXCI6IFtcbiAgICAgICAgICAgICAgXCJvcGVuXCIsXG4gICAgICAgICAgICAgIFwiZXhwb3J0ZWRcIlxuICAgICAgICAgICAgXVxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJjcmVhdGVkX2F0XCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImV4cG9ydGVkX2F0XCI6IHtcbiAgICAgICAgICAgIFwiYW55T2ZcIjogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIm51bGxcIlxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICBcInJlcXVpcmVkXCI6IFtcbiAgICAgICAgICBcImlkXCIsXG4gICAgICAgICAgXCJudW1iZXJcIixcbiAgICAgICAgICBcImN1c3RvbWVyX3R5cGVcIixcbiAgICAgICAgICBcImN1c3RvbWVyX2lkXCIsXG4gICAgICAgICAgXCJzdGF0dXNcIixcbiAgICAgICAgICBcImNyZWF0ZWRfYXRcIixcbiAgICAgICAgICBcImV4cG9ydGVkX2F0XCJcbiAgICAgICAgXSxcbiAgICAgICAgXCJhZGRpdGlvbmFsUHJvcGVydGllc1wiOiBmYWxzZVxuICAgICAgfVxuICAgIH1cbiAgfSxcbiAgXCJsaWZlY3ljbGVzXCI6IHtcbiAgICBcInVuZGVybGFnXCI6IHtcbiAgICAgIFwiZmllbGRcIjogXCJzdGF0dXNcIixcbiAgICAgIFwiaW5pdGlhbFwiOiBcIm9wZW5cIixcbiAgICAgIFwic3RhdGVzXCI6IHtcbiAgICAgICAgXCJleHBvcnRlZFwiOiB7XG4gICAgICAgICAgXCJ0ZXJtaW5hbFwiOiB0cnVlXG4gICAgICAgIH0sXG4gICAgICAgIFwib3BlblwiOiB7XG4gICAgICAgICAgXCJvblwiOiB7XG4gICAgICAgICAgICBcImludm9pY2luZy9leHBvcnRcIjogXCJleHBvcnRlZFwiXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iLCAie1xuICBcInZlcnNpb25cIjogXCIwLjAuMVwiLFxuICBcImVudGl0aWVzXCI6IHtcbiAgICBcIndvcmtvcmRlclwiOiB7XG4gICAgICBcInRhYmxlXCI6IFwid29ya29yZGVyX29yZGVyc1wiLFxuICAgICAgXCJmaWVsZHNcIjoge1xuICAgICAgICBcInR5cGVcIjogXCJvYmplY3RcIixcbiAgICAgICAgXCJwcm9wZXJ0aWVzXCI6IHtcbiAgICAgICAgICBcImlkXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcIm51bWJlclwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJudW1iZXJcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJmYWNpbGl0eV90eXBlXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImZhY2lsaXR5X2lkXCI6IHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImN1c3RvbWVyX3R5cGVcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiY3VzdG9tZXJfaWRcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwia2luZFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJ0aXRsZVwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJkZXNjcmlwdGlvblwiOiB7XG4gICAgICAgICAgICBcImFueU9mXCI6IFtcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInN0cmluZ1wiXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJudWxsXCJcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJzdGF0dXNcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCIsXG4gICAgICAgICAgICBcImVudW1cIjogW1xuICAgICAgICAgICAgICBcInBsYW5uZWRcIixcbiAgICAgICAgICAgICAgXCJpbl9wcm9ncmVzc1wiLFxuICAgICAgICAgICAgICBcImNvbXBsZXRlZFwiLFxuICAgICAgICAgICAgICBcImNsb3NlZFwiXG4gICAgICAgICAgICBdXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImFzc2lnbmVkX3RvXCI6IHtcbiAgICAgICAgICAgIFwiYW55T2ZcIjogW1xuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIm51bGxcIlxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgICAgfSxcbiAgICAgICAgICBcImNyZWF0ZWRfYnlcIjoge1xuICAgICAgICAgICAgXCJ0eXBlXCI6IFwic3RyaW5nXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiY3JlYXRlZF9hdFwiOiB7XG4gICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJjb21wbGV0ZWRfYXRcIjoge1xuICAgICAgICAgICAgXCJhbnlPZlwiOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJzdHJpbmdcIlxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwibnVsbFwiXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIFwicmVxdWlyZWRcIjogW1xuICAgICAgICAgIFwiaWRcIixcbiAgICAgICAgICBcIm51bWJlclwiLFxuICAgICAgICAgIFwiZmFjaWxpdHlfdHlwZVwiLFxuICAgICAgICAgIFwiZmFjaWxpdHlfaWRcIixcbiAgICAgICAgICBcImN1c3RvbWVyX3R5cGVcIixcbiAgICAgICAgICBcImN1c3RvbWVyX2lkXCIsXG4gICAgICAgICAgXCJraW5kXCIsXG4gICAgICAgICAgXCJ0aXRsZVwiLFxuICAgICAgICAgIFwiZGVzY3JpcHRpb25cIixcbiAgICAgICAgICBcInN0YXR1c1wiLFxuICAgICAgICAgIFwiYXNzaWduZWRfdG9cIixcbiAgICAgICAgICBcImNyZWF0ZWRfYnlcIixcbiAgICAgICAgICBcImNyZWF0ZWRfYXRcIixcbiAgICAgICAgICBcImNvbXBsZXRlZF9hdFwiXG4gICAgICAgIF0sXG4gICAgICAgIFwiYWRkaXRpb25hbFByb3BlcnRpZXNcIjogZmFsc2VcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gIFwibGlmZWN5Y2xlc1wiOiB7XG4gICAgXCJ3b3Jrb3JkZXJcIjoge1xuICAgICAgXCJmaWVsZFwiOiBcInN0YXR1c1wiLFxuICAgICAgXCJpbml0aWFsXCI6IFwicGxhbm5lZFwiLFxuICAgICAgXCJzdGF0ZXNcIjoge1xuICAgICAgICBcImNsb3NlZFwiOiB7XG4gICAgICAgICAgXCJ0ZXJtaW5hbFwiOiB0cnVlXG4gICAgICAgIH0sXG4gICAgICAgIFwiY29tcGxldGVkXCI6IHtcbiAgICAgICAgICBcIm9uXCI6IHtcbiAgICAgICAgICAgIFwid29ya29yZGVyL2Nsb3NlXCI6IFwiY2xvc2VkXCJcbiAgICAgICAgICB9XG4gICAgICAgIH0sXG4gICAgICAgIFwiaW5fcHJvZ3Jlc3NcIjoge1xuICAgICAgICAgIFwib25cIjoge1xuICAgICAgICAgICAgXCJ3b3Jrb3JkZXIvY29tcGxldGVcIjogXCJjb21wbGV0ZWRcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgXCJhbGxvd1wiOiBbXG4gICAgICAgICAgICBcIndvcmtvcmRlci9yZXBvcnQtbWF0ZXJpYWxcIixcbiAgICAgICAgICAgIFwid29ya29yZGVyL3JlcG9ydC10aW1lXCJcbiAgICAgICAgICBdLFxuICAgICAgICAgIFwiZXh0ZW5zaWJsZVwiOiB0cnVlXG4gICAgICAgIH0sXG4gICAgICAgIFwicGxhbm5lZFwiOiB7XG4gICAgICAgICAgXCJvblwiOiB7XG4gICAgICAgICAgICBcIndvcmtvcmRlci9zdGFydFwiOiBcImluX3Byb2dyZXNzXCJcbiAgICAgICAgICB9LFxuICAgICAgICAgIFwiYWxsb3dcIjogW1xuICAgICAgICAgICAgXCJ3b3Jrb3JkZXIvYXNzaWduXCIsXG4gICAgICAgICAgICBcIndvcmtvcmRlci9yZXBvcnQtbWF0ZXJpYWxcIixcbiAgICAgICAgICAgIFwid29ya29yZGVyL3JlcG9ydC10aW1lXCJcbiAgICAgICAgICBdXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9zdGF0ZS1tYWNoaW5lLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL3N0YXRlLW1hY2hpbmUubXRzXCI7LyoqXG4gKiBPbmUgbGF5b3V0IGZvciBldmVyeSBlbmdpbmUgc3RhdGUgbWFjaGluZSBvbiB0aGUgZG9jcyBzaXRlLlxuICpcbiAqIFRoZSBmaXZlIGVuZ2luZSBwYWdlcyBkcmV3IHRoZWlyIG1hY2hpbmVzIGFzIEFTQ0lJLCBmaXZlIHRpbWVzLCBieSBoYW5kLiBUaGVcbiAqIHNoYXBlcyB3ZXJlIGlkZW50aWNhbCBcdTIwMTQgYSBzcGluZSBmcm9tIHRoZSBpbml0aWFsIHN0YXRlIHBsdXMgYnJhbmNoZXMgZmFsbGluZ1xuICogb2ZmIGl0IFx1MjAxNCBhbmQgdGhlIGRyYXdpbmdzIGNvdWxkIGRpc2FncmVlIHdpdGggdGhlIGNvZGUgd2l0aCBub3RoaW5nIG5vdGljaW5nLlxuICpcbiAqIFR3byB0aGluZ3Mgc2VwYXJhdGUgaGVyZS4gVGhlICoqbWFjaGluZSoqIGlzIHRoZSBkYXRhOiBmb3IgZW5naW5lcyB0aGF0XG4gKiBkZWNsYXJlIGEgbGlmZWN5Y2xlIGl0IGlzIHJlYWQgc3RyYWlnaHQgZnJvbSB0aGUgZW1pdHRlZCBgbW9kZWwuanNvbmAsIHdoaWNoXG4gKiBgbGludDptb2RlbCAtLWNoZWNrYCBhbHJlYWR5IGdhdGVzLCBzbyB0aGUgZGlhZ3JhbSBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgY29kZS5cbiAqIEZvciBlbmdpbmVzIHRoYXQgZG8gbm90IGRlY2xhcmUgb25lIHlldCBpdCBpcyB3cml0dGVuIG91dCBpbiB0aGUgc2FtZSBzaGFwZSBcdTIwMTRcbiAqIHNvIHdoZW4gdGhleSBkbywgdGhlIGNhbGwgc3dhcHMgdG8gYGZyb21Nb2RlbGAgYW5kIG5vdGhpbmcgZWxzZSBjaGFuZ2VzLlxuICpcbiAqIFRoZSAqKmxheW91dCoqIGlzIGRlcml2ZWQgaGVyZSwgdGhlIHNhbWUgd2F5IGZvciBib3RoLiBOb3RoaW5nIGlzIHBvc2l0aW9uZWRcbiAqIGJ5IGhhbmQsIGFuZCBub3RoaW5nIGlzIHBvc2l0aW9uZWQgYnkgYSBnZW5lcmFsLXB1cnBvc2UgZ3JhcGggYWxnb3JpdGhtXG4gKiBlaXRoZXI6IHRoZXNlIG1hY2hpbmVzIGFyZSBhIGNoYWluIHdpdGggYnJhbmNoZXMsIHNvIHRoZSBsYXlvdXQgdGhhdCByZWFkc1xuICogYmVzdCBpcyB0aGUgb25lIHRoYXQgc2F5cyBzby5cbiAqL1xuXG5leHBvcnQgaW50ZXJmYWNlIE1hY2hpbmVTdGF0ZSB7XG4gIHJlYWRvbmx5IG9uPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj47XG4gIHJlYWRvbmx5IGFsbG93PzogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlYWRvbmx5IHRlcm1pbmFsPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgZXh0ZW5zaWJsZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWFjaGluZSB7XG4gIHJlYWRvbmx5IGZpZWxkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGluaXRpYWw6IHN0cmluZztcbiAgcmVhZG9ubHkgc3RhdGVzOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBNYWNoaW5lU3RhdGU+Pjtcbn1cblxuLyoqIFB1bGwgb25lIGVudGl0eSdzIG1hY2hpbmUgb3V0IG9mIGFuIGVtaXR0ZWQgYG1vZGVsLmpzb25gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZyb21Nb2RlbChcbiAgbW9kZWw6IHsgbGlmZWN5Y2xlcz86IFJlY29yZDxzdHJpbmcsIE1hY2hpbmU+IH0sXG4gIGVudGl0eTogc3RyaW5nLFxuKTogTWFjaGluZSB7XG4gIGNvbnN0IG1hY2hpbmUgPSBtb2RlbC5saWZlY3ljbGVzPy5bZW50aXR5XTtcbiAgaWYgKCFtYWNoaW5lKSB0aHJvdyBuZXcgRXJyb3IoYG1vZGVsLmpzb24gZGVjbGFyZXMgbm8gbGlmZWN5Y2xlIGZvciAnJHtlbnRpdHl9J2ApO1xuICByZXR1cm4gbWFjaGluZTtcbn1cblxuLyoqXG4gKiBgd29ya29yZGVyL3JlcG9ydC10aW1lYCBcdTIxOTIgYHJlcG9ydC10aW1lYC5cbiAqXG4gKiBUaGUgZW5naW5lIHByZWZpeCBpcyB0aGUgc2FtZSBvbiBldmVyeSBlZGdlIG9mIGEgZ2l2ZW4gbWFjaGluZSwgc28gcHJpbnRpbmcgaXRcbiAqIGNvc3RzIHdpZHRoIGFuZCBzYXlzIG5vdGhpbmcuIFRoZSBmdWxsIGlkIHN0YXlzIGluIHRoZSB0d2luLlxuICovXG5leHBvcnQgY29uc3QgdmVyYiA9IChvcGVyYXRpb25JZDogc3RyaW5nKTogc3RyaW5nID0+XG4gIG9wZXJhdGlvbklkLmluY2x1ZGVzKCcvJykgPyBvcGVyYXRpb25JZC5zbGljZShvcGVyYXRpb25JZC5pbmRleE9mKCcvJykgKyAxKSA6IG9wZXJhdGlvbklkO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVkZ2Uge1xuICByZWFkb25seSBmcm9tOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRvOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG9wOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGF5b3V0IHtcbiAgLyoqIFRoZSBsb25nZXN0IHJ1biBvZiBzdGF0ZXMgZnJvbSBgaW5pdGlhbGAsIGxhaWQgb3V0IHRvcCB0byBib3R0b20uICovXG4gIHJlYWRvbmx5IHNwaW5lOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEVkZ2VzIGFsb25nIHRoZSBzcGluZSwgb25lIHBlciBnYXAgYmV0d2VlbiBjb25zZWN1dGl2ZSBzcGluZSBzdGF0ZXMuICovXG4gIHJlYWRvbmx5IHNwaW5lRWRnZXM6IHJlYWRvbmx5IEVkZ2VbXTtcbiAgLyoqIEVkZ2VzIGxlYXZpbmcgdGhlIHNwaW5lIGZvciBhIHN0YXRlIHRoYXQgaXMgbm90IG9uIGl0IFx1MjAxNCBkcmF3biB0byB0aGUgcmlnaHQuICovXG4gIHJlYWRvbmx5IGJyYW5jaGVzOiByZWFkb25seSBFZGdlW107XG4gIC8qKiBFZGdlcyByZWpvaW5pbmcgdGhlIHNwaW5lIG91dCBvZiBvcmRlciBcdTIwMTQgYSBza2lwIGFoZWFkIG9yIGEgbG9vcCBiYWNrLiAqL1xuICByZWFkb25seSByZWpvaW5zOiByZWFkb25seSBFZGdlW107XG59XG5cbmNvbnN0IGVkZ2VzT2YgPSAobTogTWFjaGluZSk6IEVkZ2VbXSA9PlxuICBPYmplY3QuZW50cmllcyhtLnN0YXRlcykuZmxhdE1hcCgoW2Zyb20sIHNdKSA9PlxuICAgIE9iamVjdC5lbnRyaWVzKHMub24gPz8ge30pLm1hcCgoW29wLCB0b10pID0+ICh7IGZyb20sIHRvLCBvcCB9KSksXG4gICk7XG5cbi8qKlxuICogVGhlIGxvbmdlc3Qgc2ltcGxlIHBhdGggZnJvbSBgaW5pdGlhbGAuXG4gKlxuICogTG9uZ2VzdCByYXRoZXIgdGhhbiBmaXJzdC1mb3VuZCBiZWNhdXNlIHRoZSBzcGluZSBzaG91bGQgYmUgdGhlIHN0b3J5IHRoZVxuICogbWFjaGluZSBpcyBtb3N0bHkgYWJvdXQ6IGBoZWxkIFx1MjE5MiBjb25maXJtZWQgXHUyMTkyIGluX3NlcnZpY2UgXHUyMTkyIGNvbXBsZXRlZGAsIHdpdGhcbiAqIGBleHBpcmVkYCBoYW5naW5nIG9mZiBpdCBcdTIwMTQgbm90IGBoZWxkIFx1MjE5MiBleHBpcmVkYCwgd2hpY2ggaXMgdHJ1ZSwgc2hvcnRlciwgYW5kXG4gKiBhIHRlcnJpYmxlIHN1bW1hcnkuIEV4cG9uZW50aWFsIGluIHByaW5jaXBsZSwgdHJpdmlhbCBhdCBmaXZlIHN0YXRlcy5cbiAqL1xuZnVuY3Rpb24gbG9uZ2VzdFBhdGgobTogTWFjaGluZSwgZWRnZXM6IHJlYWRvbmx5IEVkZ2VbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgd2FsayA9IChhdDogc3RyaW5nLCBzZWVuOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdID0+IHtcbiAgICBjb25zdCBuZXh0ID0gZWRnZXNcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuZnJvbSA9PT0gYXQgJiYgIXNlZW4uaW5jbHVkZXMoZS50bykpXG4gICAgICAubWFwKChlKSA9PiB3YWxrKGUudG8sIFsuLi5zZWVuLCBlLnRvXSkpO1xuICAgIHJldHVybiBuZXh0LnJlZHVjZSgoYmVzdCwgcCkgPT4gKHAubGVuZ3RoID4gYmVzdC5sZW5ndGggPyBwIDogYmVzdCksIFtdIGFzIHN0cmluZ1tdKS5sZW5ndGhcbiAgICAgID8gW2F0LCAuLi5uZXh0LnJlZHVjZSgoYiwgcCkgPT4gKHAubGVuZ3RoID4gYi5sZW5ndGggPyBwIDogYiksIFtdIGFzIHN0cmluZ1tdKV1cbiAgICAgIDogW2F0XTtcbiAgfTtcbiAgcmV0dXJuIHdhbGsobS5pbml0aWFsLCBbbS5pbml0aWFsXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsYXlvdXQobTogTWFjaGluZSk6IExheW91dCB7XG4gIGNvbnN0IGVkZ2VzID0gZWRnZXNPZihtKTtcbiAgY29uc3Qgc3BpbmUgPSBsb25nZXN0UGF0aChtLCBlZGdlcyk7XG4gIGNvbnN0IG9uU3BpbmUgPSBuZXcgU2V0KHNwaW5lKTtcblxuICBjb25zdCBzcGluZUVkZ2VzOiBFZGdlW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzcGluZS5sZW5ndGggLSAxOyBpKyspIHtcbiAgICBjb25zdCBlID0gZWRnZXMuZmluZCgoeCkgPT4geC5mcm9tID09PSBzcGluZVtpXSAmJiB4LnRvID09PSBzcGluZVtpICsgMV0pO1xuICAgIGlmIChlKSBzcGluZUVkZ2VzLnB1c2goZSk7XG4gIH1cblxuICBjb25zdCByZXN0ID0gZWRnZXMuZmlsdGVyKChlKSA9PiAhc3BpbmVFZGdlcy5pbmNsdWRlcyhlKSk7XG4gIHJldHVybiB7XG4gICAgc3BpbmUsXG4gICAgc3BpbmVFZGdlcyxcbiAgICBicmFuY2hlczogcmVzdC5maWx0ZXIoKGUpID0+ICFvblNwaW5lLmhhcyhlLnRvKSksXG4gICAgcmVqb2luczogcmVzdC5maWx0ZXIoKGUpID0+IG9uU3BpbmUuaGFzKGUudG8pKSxcbiAgfTtcbn1cblxuLyoqIFRoZSBtYXJrZG93biB0d2luIG9mIGEgbWFjaGluZSBcdTIwMTQgdGhlIHNhbWUgbGF5b3V0LCBzdGF0ZWQgcmF0aGVyIHRoYW4gZHJhd24uICovXG5leHBvcnQgZnVuY3Rpb24gYWx0RnJvbShtOiBNYWNoaW5lLCB0aXRsZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbCA9IGxheW91dChtKTtcbiAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gW1xuICAgIGAqKkRpYWdyYW0gXHUyMDE0IHRoZSAke3RpdGxlfSBzdGF0ZSBtYWNoaW5lKiosIG9uIFxcYCR7bS5maWVsZH1cXGAsIHN0YXJ0aW5nIGF0IGAgK1xuICAgICAgYFxcYCR7bS5pbml0aWFsfVxcYC5gLFxuICAgICcnLFxuICAgIGAtICoqVGhlIG1haW4gcnVuOioqICR7bC5zcGluZVxuICAgICAgLm1hcCgocywgaSkgPT4gKGkgPT09IDAgPyBgXFxgJHtzfVxcYGAgOiBgXHUyMTkyICoke3ZlcmIobC5zcGluZUVkZ2VzW2kgLSAxXSEub3ApfSogXHUyMTkyIFxcYCR7c31cXGBgKSlcbiAgICAgIC5qb2luKCcgJyl9YCxcbiAgXTtcbiAgZm9yIChjb25zdCBlIG9mIGwuYnJhbmNoZXMpIHtcbiAgICBsaW5lcy5wdXNoKGAtICoqTGVhdmVzIHRoZSBydW46KiogXFxgJHtlLmZyb219XFxgIFx1MjE5MiAqJHt2ZXJiKGUub3ApfSogXHUyMTkyIFxcYCR7ZS50b31cXGAuYCk7XG4gIH1cbiAgZm9yIChjb25zdCBlIG9mIGwucmVqb2lucykge1xuICAgIGxpbmVzLnB1c2goYC0gKipSZWpvaW5zOioqIFxcYCR7ZS5mcm9tfVxcYCBcdTIxOTIgKiR7dmVyYihlLm9wKX0qIFx1MjE5MiBcXGAke2UudG99XFxgLmApO1xuICB9XG4gIGNvbnN0IGFsbG93ZWQgPSBPYmplY3QuZW50cmllcyhtLnN0YXRlcylcbiAgICAuZmlsdGVyKChbLCBzXSkgPT4gcy5hbGxvdz8ubGVuZ3RoKVxuICAgIC5tYXAoKFtuYW1lLCBzXSkgPT4gYFxcYCR7bmFtZX1cXGAgYWRtaXRzICR7cy5hbGxvdyEubWFwKChvKSA9PiBgKiR7dmVyYihvKX0qYCkuam9pbignLCAnKX1gKTtcbiAgaWYgKGFsbG93ZWQubGVuZ3RoKSB7XG4gICAgbGluZXMucHVzaCgnJywgYCoqUGVybWl0dGVkIHdpdGhvdXQgbW92aW5nOioqICR7YWxsb3dlZC5qb2luKCc7ICcpfS5gKTtcbiAgfVxuICBjb25zdCB0ZXJtaW5hbCA9IE9iamVjdC5lbnRyaWVzKG0uc3RhdGVzKS5maWx0ZXIoKFssIHNdKSA9PiBzLnRlcm1pbmFsKS5tYXAoKFtuXSkgPT4gYFxcYCR7bn1cXGBgKTtcbiAgaWYgKHRlcm1pbmFsLmxlbmd0aCkgbGluZXMucHVzaChgKipUZXJtaW5hbDoqKiAke3Rlcm1pbmFsLmpvaW4oJywgJyl9LmApO1xuICBsaW5lcy5wdXNoKFxuICAgICcnLFxuICAgICdBbiBvcGVyYXRpb24gdGhlIG1hY2hpbmUgaGFzIG5ldmVyIGhlYXJkIG9mIGlzIG5vdCBmb3JiaWRkZW4gXHUyMDE0IGl0IGlzIG5vdCBnb3Zlcm5lZC4gJyArXG4gICAgICAnQWJzZW5jZSBtZWFucyBcIm5vIHN0YXRlIGdhdGVzIHRoaXNcIiwgbmV2ZXIgXCJkZW5pZWRcIi4nLFxuICApO1xuICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU3RhdGVNYWNoaW5lLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU3RhdGVNYWNoaW5lLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBUaGUgZW5naW5lIHN0YXRlIG1hY2hpbmVzLCBhbmQgdGhlaXIgbWFya2Rvd24gdHdpbnMuXG4gKlxuICogRml2ZSBlbmdpbmUgcGFnZXMgZHJldyB0aGlzIGJ5IGhhbmQgaW4gQVNDSUksIGFuZCB0d28gb2YgdGhlIGZpdmUgaGFkIGFscmVhZHlcbiAqIGRyaWZ0ZWQ6IGJvb2tpbmcncyBwaWN0dXJlIHNob3dlZCBuZWl0aGVyIGBjYW5jZWxgIG5vciBgbm8tc2hvd2AsIGFuZFxuICogcHJvdG9jb2wncyBvbWl0dGVkIGB2b2lkZWRgIGVudGlyZWx5LiBUaGF0IGlzIHRoZSBhcmd1bWVudCBmb3IgcmVhZGluZyB0aGVcbiAqIG1hY2hpbmUgcmF0aGVyIHRoYW4gcmVkcmF3aW5nIGl0LlxuICpcbiAqICMjIFR3byBzb3VyY2VzLCBhbmQgdGhlIGRpZmZlcmVuY2UgaXMgc3RhdGVkLCBub3QgaGlkZGVuXG4gKlxuICogYHdvcmtvcmRlcmAsIGBib29raW5nYCBhbmQgYGludm9pY2luZ2AgZGVjbGFyZSBhIGxpZmVjeWNsZSwgc28gdGhlaXIgbWFjaGluZVxuICogaXMgcmVhZCBmcm9tIHRoZSBlbWl0dGVkIGBtb2RlbC5qc29uYCBcdTIwMTQgYW4gYXJ0aWZhY3QgYGxpbnQ6bW9kZWwgLS1jaGVja2BcbiAqIGFscmVhZHkgZ2F0ZXMuIFRob3NlIGRpYWdyYW1zIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBjb2RlLlxuICpcbiAqIGBhYnNlbmNlYCwgYHByb3RvY29sYCBhbmQgYGludml0ZXNgIGRlY2xhcmUgbm8gbGlmZWN5Y2xlIHlldCwgc28gdGhlaXIgbWFjaGluZVxuICogaXMgd3JpdHRlbiBvdXQgYmVsb3csIHRyYW5zY3JpYmVkIGZyb20gdGhlIGVuZ2luZSdzIG93biBzdGF0dXMgZW51bSBhbmQgaXRzXG4gKiBgcmVxdWlyZVN0YXR1c2AgY2FsbCBzaXRlcy4gKipOb3RoaW5nIGdhdGVzIHRob3NlIHRocmVlLioqIFRoZXkgY2FycnlcbiAqIGBkZWNsYXJlZDogZmFsc2VgLCB0aGUgcGFnZSBzYXlzIHNvIHVuZGVyIHRoZSBmaWd1cmUsIGFuZCB0aGUgZml4IGlzIG5vdCBhXG4gKiBiZXR0ZXIgY29tbWVudCBoZXJlIFx1MjAxNCBpdCBpcyBgZGVmaW5lTGlmZWN5Y2xlc2AgaW4gdGhvc2UgdGhyZWUgZW5naW5lcywgYWZ0ZXJcbiAqIHdoaWNoIHRoZSBlbnRyeSBzd2FwcyB0byBgZnJvbU1vZGVsYCBhbmQgdGhpcyBub3RlIGdvZXMgYXdheS5cbiAqL1xuaW1wb3J0IGJvb2tpbmcgZnJvbSAnLi4vLi4vLi4vLi4vLi4vZW5naW5lcy9ib29raW5nL21vZGVsLmpzb24nIHdpdGggeyB0eXBlOiAnanNvbicgfTtcbmltcG9ydCBpbnZvaWNpbmcgZnJvbSAnLi4vLi4vLi4vLi4vLi4vZW5naW5lcy9pbnZvaWNpbmcvbW9kZWwuanNvbicgd2l0aCB7IHR5cGU6ICdqc29uJyB9O1xuaW1wb3J0IHdvcmtvcmRlciBmcm9tICcuLi8uLi8uLi8uLi8uLi9lbmdpbmVzL3dvcmtvcmRlci9tb2RlbC5qc29uJyB3aXRoIHsgdHlwZTogJ2pzb24nIH07XG5pbXBvcnQgeyBhbHRGcm9tLCBmcm9tTW9kZWwsIHR5cGUgTWFjaGluZSB9IGZyb20gJy4vc3RhdGUtbWFjaGluZS5tanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIERpYWdyYW0ge1xuICAvKiogVGhlIGVudGl0eSB0aGUgbWFjaGluZSBnb3Zlcm5zIFx1MjAxNCBpdHMgbmFtZSBvbiB0aGUgcGFnZS4gKi9cbiAgcmVhZG9ubHkgZW50aXR5OiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1hY2hpbmU6IE1hY2hpbmU7XG4gIC8qKiBUcnVlIHdoZW4gdGhlIG1hY2hpbmUgY2FtZSBmcm9tIGFuIGVtaXR0ZWQsIENJLWdhdGVkIGBtb2RlbC5qc29uYC4gKi9cbiAgcmVhZG9ubHkgZGVjbGFyZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBUcmFuc2NyaWJlZCwgbm90IGVtaXR0ZWQgXHUyMDE0IHNlZSB0aGUgaGVhZGVyLiAqL1xuY29uc3QgYWJzZW5jZTogTWFjaGluZSA9IHtcbiAgZmllbGQ6ICdzdGF0dXMnLFxuICBpbml0aWFsOiAncmVxdWVzdGVkJyxcbiAgc3RhdGVzOiB7XG4gICAgcmVxdWVzdGVkOiB7XG4gICAgICBvbjoge1xuICAgICAgICAnYWJzZW5jZS9hcHByb3ZlJzogJ2FwcHJvdmVkJyxcbiAgICAgICAgJ2Fic2VuY2UvcmVqZWN0JzogJ3JlamVjdGVkJyxcbiAgICAgICAgJ2Fic2VuY2UvY2FuY2VsJzogJ2NhbmNlbGxlZCcsXG4gICAgICB9LFxuICAgIH0sXG4gICAgYXBwcm92ZWQ6IHsgb246IHsgJ2Fic2VuY2UvY2FuY2VsJzogJ2NhbmNlbGxlZCcgfSB9LFxuICAgIHJlamVjdGVkOiB7IHRlcm1pbmFsOiB0cnVlIH0sXG4gICAgY2FuY2VsbGVkOiB7IHRlcm1pbmFsOiB0cnVlIH0sXG4gIH0sXG59O1xuXG4vKiogVHJhbnNjcmliZWQsIG5vdCBlbWl0dGVkIFx1MjAxNCBzZWUgdGhlIGhlYWRlci4gKi9cbmNvbnN0IHByb3RvY29sOiBNYWNoaW5lID0ge1xuICBmaWVsZDogJ3N0YXR1cycsXG4gIGluaXRpYWw6ICdvcGVuJyxcbiAgc3RhdGVzOiB7XG4gICAgb3Blbjoge1xuICAgICAgb246IHtcbiAgICAgICAgJ3Byb3RvY29sL3JlcXVlc3Qtc2lnbmF0dXJlcyc6ICdwZW5kaW5nX3NpZ25hdHVyZScsXG4gICAgICAgICdwcm90b2NvbC9zaWduJzogJ3NpZ25lZCcsXG4gICAgICAgICdwcm90b2NvbC92b2lkJzogJ3ZvaWRlZCcsXG4gICAgICB9LFxuICAgIH0sXG4gICAgcGVuZGluZ19zaWduYXR1cmU6IHtcbiAgICAgIG9uOiB7XG4gICAgICAgICdwcm90b2NvbC9jb21wbGV0ZS1zaWduaW5nJzogJ3NpZ25lZCcsXG4gICAgICAgICdwcm90b2NvbC9jYW5jZWwtc2lnbmF0dXJlLXJlcXVlc3RzJzogJ29wZW4nLFxuICAgICAgICAncHJvdG9jb2wvdm9pZCc6ICd2b2lkZWQnLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHNpZ25lZDogeyBvbjogeyAncHJvdG9jb2wvdm9pZCc6ICd2b2lkZWQnIH0gfSxcbiAgICB2b2lkZWQ6IHsgdGVybWluYWw6IHRydWUgfSxcbiAgfSxcbn07XG5cbi8qKiBUcmFuc2NyaWJlZCwgbm90IGVtaXR0ZWQgXHUyMDE0IHNlZSB0aGUgaGVhZGVyLiAqL1xuY29uc3QgaW52aXRlczogTWFjaGluZSA9IHtcbiAgZmllbGQ6ICdzdGF0ZScsXG4gIGluaXRpYWw6ICdpbnZpdGVkJyxcbiAgc3RhdGVzOiB7XG4gICAgaW52aXRlZDoge1xuICAgICAgb246IHtcbiAgICAgICAgJ2ludml0ZXMvYWNjZXB0JzogJ2FjY2VwdGVkJyxcbiAgICAgICAgJ2ludml0ZXMvcmV2b2tlJzogJ3Jldm9rZWQnLFxuICAgICAgICAnaW52aXRlcy9leHBpcmUnOiAnZXhwaXJlZCcsXG4gICAgICB9LFxuICAgIH0sXG4gICAgYWNjZXB0ZWQ6IHsgdGVybWluYWw6IHRydWUgfSxcbiAgICByZXZva2VkOiB7IHRlcm1pbmFsOiB0cnVlIH0sXG4gICAgZXhwaXJlZDogeyB0ZXJtaW5hbDogdHJ1ZSB9LFxuICB9LFxufTtcblxuZXhwb3J0IGNvbnN0IERJQUdSQU1TOiBSZWNvcmQ8c3RyaW5nLCBEaWFncmFtPiA9IHtcbiAgd29ya29yZGVyOiB7IGVudGl0eTogJ3dvcmtvcmRlcicsIG1hY2hpbmU6IGZyb21Nb2RlbCh3b3Jrb3JkZXIsICd3b3Jrb3JkZXInKSwgZGVjbGFyZWQ6IHRydWUgfSxcbiAgYm9va2luZzogeyBlbnRpdHk6ICdyZXNlcnZhdGlvbicsIG1hY2hpbmU6IGZyb21Nb2RlbChib29raW5nLCAncmVzZXJ2YXRpb24nKSwgZGVjbGFyZWQ6IHRydWUgfSxcbiAgaW52b2ljaW5nOiB7IGVudGl0eTogJ3VuZGVybGFnJywgbWFjaGluZTogZnJvbU1vZGVsKGludm9pY2luZywgJ3VuZGVybGFnJyksIGRlY2xhcmVkOiB0cnVlIH0sXG4gIGFic2VuY2U6IHsgZW50aXR5OiAnYWJzZW5jZSByZXF1ZXN0JywgbWFjaGluZTogYWJzZW5jZSwgZGVjbGFyZWQ6IGZhbHNlIH0sXG4gIHByb3RvY29sOiB7IGVudGl0eTogJ3Byb3RvY29sJywgbWFjaGluZTogcHJvdG9jb2wsIGRlY2xhcmVkOiBmYWxzZSB9LFxuICBpbnZpdGVzOiB7IGVudGl0eTogJ2ludml0YXRpb24nLCBtYWNoaW5lOiBpbnZpdGVzLCBkZWNsYXJlZDogZmFsc2UgfSxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBkaWFncmFtRm9yKGVuZ2luZTogc3RyaW5nKTogRGlhZ3JhbSB7XG4gIGNvbnN0IGQgPSBESUFHUkFNU1tlbmdpbmVdO1xuICBpZiAoIWQpIHRocm93IG5ldyBFcnJvcihgbm8gc3RhdGUgbWFjaGluZSByZWdpc3RlcmVkIGZvciBlbmdpbmUgJyR7ZW5naW5lfSdgKTtcbiAgcmV0dXJuIGQ7XG59XG5cbmV4cG9ydCBjb25zdCBlbWl0dGVkTm90ZSA9XG4gICdEcmF3biBmcm9tIHRoZSBlbmdpbmVcdTIwMTlzIGRlY2xhcmVkIGxpZmVjeWNsZSBpbiBtb2RlbC5qc29uIFx1MjAxNCB0aGUgc2FtZSBhcnRpZmFjdCAnICtcbiAgJ2xpbnQ6bW9kZWwgLS1jaGVjayBnYXRlcywgc28gdGhpcyBwaWN0dXJlIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBjb2RlLic7XG5cbmV4cG9ydCBjb25zdCB0cmFuc2NyaWJlZE5vdGUgPVxuICAnVGhpcyBlbmdpbmUgZGVjbGFyZXMgbm8gbGlmZWN5Y2xlIHlldCwgc28gdGhlIG1hY2hpbmUgYWJvdmUgaXMgdHJhbnNjcmliZWQgZnJvbSBpdHMgJyArXG4gICdzdGF0dXMgZW51bSBhbmQgZ3VhcmQgY2xhdXNlcy4gTm90aGluZyByZS1jaGVja3MgaXQgXHUyMDE0IHRyZWF0IGl0IGFzIGRvY3VtZW50YXRpb24sIG5vdCAnICtcbiAgJ2FzIHRoZSBjb250cmFjdC4nO1xuXG5leHBvcnQgZnVuY3Rpb24gYWx0KHByb3BzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogc3RyaW5nIHtcbiAgY29uc3QgZCA9IGRpYWdyYW1Gb3IocHJvcHMuZW5naW5lID8/ICcnKTtcbiAgcmV0dXJuIFtcbiAgICBhbHRGcm9tKGQubWFjaGluZSwgZC5lbnRpdHkpLFxuICAgICcnLFxuICAgIGQuZGVjbGFyZWQgPyBlbWl0dGVkTm90ZSA6IHRyYW5zY3JpYmVkTm90ZSxcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9MYXllclN0YWNrLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvTGF5ZXJTdGFjay5jb250ZW50Lm10c1wiOy8qKlxuICogRXZlcnkgc3RyaW5nIExheWVyU3RhY2sgcmVuZGVycywgYW5kIHRoZSBtYXJrZG93biB0d2luIG9mIHRoZSBzYW1lIGZhY3RzLlxuICpcbiAqIFRoZSBkYXRhIGxpdmVzIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIGNvbXBvbmVudCdzIGA8c2NyaXB0IHNldHVwPmAgZm9yIG9uZVxuICogcmVhc29uOiBgbGxtcy5tdHNgIGNhbm5vdCBpbXBvcnQgYSBgPHNjcmlwdCBzZXR1cD5gIGJsb2NrLCBzbyBhIGRpYWdyYW0gd2hvc2VcbiAqIGNvbnRlbnQgZXhpc3RzIG9ubHkgaW5zaWRlIHRoZSBTRkMgaXMgaW52aXNpYmxlIHRvIGV2ZXJ5IGFnZW50IHJlYWRpbmdcbiAqIGxsbXMudHh0LiBXaXRoIHRoZSBjb250ZW50IGhlcmUsIHRoZSBjb21wb25lbnQgcmVuZGVycyBpdCBhbmQgYGFsdCgpYFxuICogZmxhdHRlbnMgaXQgXHUyMDE0IG9uZSBzb3VyY2UsIHNvIHRoZSBwaWN0dXJlIGFuZCBpdHMgdGV4dCBjYW5ub3QgZGlzYWdyZWUuXG4gKlxuICogVGhlIHJ1bGUgdGhhdCBmb2xsb3dzOiBhIGZhY3QgYmVsb25ncyBpbiB0aGlzIGZpbGUsIG5ldmVyIGluIHRoZSB0ZW1wbGF0ZS5cbiAqIEEgc3RyaW5nIHR5cGVkIHN0cmFpZ2h0IGludG8gTGF5ZXJTdGFjay52dWUgcmVuZGVycyBvbiB0aGUgcGFnZSBhbmQgdmFuaXNoZXNcbiAqIGZyb20gdGhlIHR3aW4sIHdpdGggbm90aGluZyBmYWlsaW5nLlxuICovXG5cbi8qKiBBIGNoaXA6IGEgbmFtZWQgdGhpbmcgd2l0aCBhIG9uZS1saW5lIGdsb3NzLiAqL1xuZXhwb3J0IHR5cGUgQ2hpcCA9IHJlYWRvbmx5IFtuYW1lOiBzdHJpbmcsIHN1Yjogc3RyaW5nXTtcblxuLyoqIEEgYmFuZCBvZiB0aGUgc3RhY2suIGByb2xlYCBjYXJyaWVzIGlubGluZSBgPGVtPmAsIHNvIHRoZSB0ZW1wbGF0ZSB2LWh0bWxzIGl0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBMYXllciB7XG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgcm9sZTogc3RyaW5nO1xuICByZWFkb25seSBvd25lcjogc3RyaW5nO1xuICByZWFkb25seSBjaGlwczogcmVhZG9ubHkgQ2hpcFtdO1xufVxuXG5leHBvcnQgY29uc3QgdmVydGljYWxzOiBMYXllciA9IHtcbiAgbmFtZTogJ1ZlcnRpY2FscycsXG4gIHJvbGU6ICdFdmVyeXRoaW5nIGEgdXNlciB0b3VjaGVzIFx1MjAxNCB0aGUgYnVzaW5lc3NlcyB0aGVtc2VsdmVzLicsXG4gIG93bmVyOiAnb3duIHZvY2FidWxhcnkgXHUwMEI3IHNjcmVlbnMgXHUwMEI3IHByaWNpbmcgXHUwMEI3IHJvbGVzJyxcbiAgY2hpcHM6IFtcbiAgICBbJ0hhbmRsZWJhcicsICdiaWtlIHdvcmtzaG9wJ10sXG4gICAgWydLYWxsa1x1MDBFNGxsYScsICdjb2ZmZWUgc2hvcCddLFxuICAgIFsnTWVyaWRpYW4nLCAnSFInXSxcbiAgICBbJ01hbnlmb2xkJywgJ2hlYWRsZXNzIENNUyddLFxuICBdLFxufTtcblxuZXhwb3J0IGNvbnN0IGVuZ2luZXM6IExheWVyID0ge1xuICBuYW1lOiAnRW5naW5lcycsXG4gIHJvbGU6ICdIZWFkbGVzcyBkb21haW4gbWFjaGluZXJ5IHRoYXQgb3ducyBpbnZhcmlhbnRzLiBTdGFyIHRvcG9sb2d5IFx1MjAxNCB0aGV5IHRhbGsgdG8gdGhlIGtlcm5lbCwgbmV2ZXIgdG8gZWFjaCBvdGhlci4nLFxuICBvd25lcjogJ293biBpbnZhcmlhbnRzIFx1MDBCNyB2ZXJzaW9uZWQgXHUwMEI3IG5ldmVyIGZvcmtlZCcsXG4gIGNoaXBzOiBbXG4gICAgWyd3b3Jrb3JkZXInLCAnb25lIHN0YXRlIG1hY2hpbmUgXHUwMEI3IGFwcGVuZC1vbmx5IHRpbWUgKyBtYXRlcmlhbCddLFxuICAgIFsnYm9va2luZycsICdyZXNvdXJjZSBcdTAwRDcgaW50ZXJ2YWwgXHUwMEQ3IGNhcGFjaXR5IFx1MDBCNyBvbmUgYWxsb2NhdGlvbiwgbm8gbG9ja3MnXSxcbiAgICBbJ2ludm9pY2luZycsICdjb25zdW1lcyBiaWxsYWJsZSBldmVudHMgXHUwMEI3IGltbXV0YWJsZSBvbmNlIGV4cG9ydGVkJ10sXG4gICAgWydwcm90b2NvbCcsICdjaGVja2xpc3RzICsgc2lnbmVkIGRvY3MgXHUwMEI3IGZyZWV6ZSBcdTIxOTIgaW1tdXRhYmxlLCBoYXNoZWQnXSxcbiAgICBbJ2ludml0ZXMnLCAnaGFzaGVkIGlkZW50aWZpZXIgXHUwMEI3IGFjY2VwdC1yZXF1aXJlZCBcdTAwQjcgbm9uLWVudW1lcmFibGUnXSxcbiAgICBbJ25vdGlmaWNhdGlvbnMnLCAncHJlZmVyZW5jZXMgKyBkZWxpdmVyeSByZWNvcmRzIFx1MDBCNyBlbWFpbCB2aWEgcGxhdGZvcm0gaW50ZW50J10sXG4gICAgWydhc3Npc3RhbnQnLCAndGhyZWFkIHJlY29yZCArIHJ1biBsZWFzZSArIGV4YWN0LWlucHV0IGFwcHJvdmFsIFx1MDBCNyBob3N0IGludGVncmF0aW9uIHBlbmRpbmcnXSxcbiAgXSxcbn07XG5cbmV4cG9ydCBjb25zdCBhZGFwdGVyczogTGF5ZXIgPSB7XG4gIG5hbWU6ICdBZGFwdGVycycsXG4gIHJvbGU6ICdTY29wZSBob3N0cyBcdTIwMTQgdGhlIGludGVyY2hhbmdlYWJsZSBncm91bmQgdGhlIGtlcm5lbCBpcyBzZWF0ZWQgb24uJyxcbiAgb3duZXI6ICdzd2FwcGFibGUgXHUwMEI3IGVzY3Jvd2FibGUgXHUwMEI3IHNlbGYtaG9zdGFibGUnLFxuICBjaGlwczogW1xuICAgIFsnYWRhcHRlci1zcWxpdGUnLCAnZGV2IFx1MDBCNyBDSSBcdTAwQjcgc2VsZi1ob3N0IC8gZXNjcm93J10sXG4gICAgWydhZGFwdGVyLWNsb3VkZmxhcmUnLCAncHJvZHVjdGlvbiBcdTAwQjcgRHVyYWJsZS1PYmplY3QgcGVyIHNjb3BlJ10sXG4gICAgWydhZGFwdGVyLWVtYWlsJywgJ25vdGlmaWNhdGlvbiB0cmFuc3BvcnQgXHUwMEI3IENGIEVtYWlsICsgbW9jayddLFxuICBdLFxufTtcblxuZXhwb3J0IGNvbnN0IGNvbm5lY3RvcnM6IExheWVyID0ge1xuICBuYW1lOiAnQ29ubmVjdG9ycycsXG4gIHJvbGU6ICdUaGUgb3V0c2lkZSB3b3JsZCwgYXQgdGhlIGVkZ2VzLiBSZWFjdCB0byBldmVudHMgb24gdGhlIHNwaW5lIFx1MjAxNCBob3N0IGNvZGUsIG5ldmVyIG1vZHVsZSBjb2RlLicsXG4gIG93bmVyOiAnbm8gZmV0Y2ggaW5zaWRlIGEgbW9kdWxlIFx1MjAxNCBldmVyJyxcbiAgY2hpcHM6IFtcbiAgICBbJ1Njcml2ZSBlU2lnbicsICdzaWduYXR1cmVzLXJlcXVlc3RlZCBcdTIxOTIgQmFua0lEIHNpZ25pbmcgXHUyMTkyIHJlY29yZGVkIGJhY2snXSxcbiAgICBbJ1x1MjAyNm1vcmUnLCAnb25lIHBvcnQgcGVyIGNhcGFiaWxpdHknXSxcbiAgXSxcbn07XG5cbmV4cG9ydCBjb25zdCBrZXJuZWwgPSB7XG4gIG5hbWU6ICdLZXJuZWwnLFxuICByb2xlOiAnVGhlIHN1YnN0cmF0ZS4gRXZlcnl0aGluZyB0cnVlIG9mIDxlbT5ldmVyeTwvZW0+IEIyQiBTYWFTIFx1MjAxNCBhbmQgbm90aGluZyB0cnVlIG9mIGFueSBvbmUuJyxcbiAgb3duZXI6ICdvd25zIG5vIGRvbWFpbiBlbnRpdGllcycsXG4gIGJpdHM6IFtcbiAgICAnSWRlbnRpdHknLCAnTmVzdGVkIHRlbmFuY3knLCAnUGVybWlzc2lvbnMgKyBncmFudHMnLCAnRXZlbnRzIC8gYXVkaXQgc3BpbmUnLFxuICAgICdNaWdyYXRpb25zJywgJ0dEUFIgbWFjaGluZXJ5JywgJ0VtYWlsIGludGVudHMnLCAnSm9icycsXG4gICAgJ0JpbGxpbmcgZW50aXRsZW1lbnRzJywgJ01vZHVsZSBzeXN0ZW0nLCAnQXR0YWNobWVudCBjb250cmFjdHMnLCAnQXBwIHNoZWxsJyxcbiAgXSxcbiAgY3R4TGFiZWw6ICdFdmVyeSBvcGVyYXRpb24gcnVucyBpbnNpZGUnLFxuICBjdHg6IFsnY3R4LnNxbCcsICdjdHguY2hlY2snLCAnY3R4LmVtaXQnLCAnY3R4LmxpbmsnXSxcbiAgbm90ZTogJ05vIGN1c3RvbWVyIHRhYmxlLCBubyB3b3JrLW9yZGVyIHRhYmxlLiBJdCBvZmZlcnMgYXR0YWNobWVudCBjb250cmFjdHMgdGhhdCBiaW5kIHRvIG9wYXF1ZSAoZW50aXR5VHlwZSwgZW50aXR5SWQpIHJlZnMgdGhlIHZlcnRpY2FsIGRlZmluZXMuJyxcbn0gYXMgY29uc3Q7XG5cbi8qKiBUaGUgZGFzaGVkIHJ1bGUgYmV0d2VlbiBcIm1pc3Rha2VzIGFyZSBjb3NtZXRpY1wiIGFuZCBcIm1pc3Rha2VzIGFyZSBjYXRhc3Ryb3BoaWNcIi4gKi9cbmV4cG9ydCBjb25zdCB0aGVMaW5lID0ge1xuICBsYWJlbDogJ3RoZSBsaW5lJyxcbiAgYWJvdmU6ICdBSSB2ZWxvY2l0eSBcdTIwMTQgbWlzdGFrZXMgYXJlIGNvc21ldGljIChhIHdyb25nIHNjcmVlbiknLFxuICBiZWxvdzogJ2h1bWFucyArIHJ1bnRpbWUgZ3VhcmFudGVlcyBcdTIwMTQgbWlzdGFrZXMgYXJlIGNhdGFzdHJvcGhpYyAoYSB0ZW5hbnQgbGVhayknLFxufSBhcyBjb25zdDtcblxuLyoqIFRoZSBqb2lucyBiZXR3ZWVuIGJhbmRzLCBpbiBzdGFjayBvcmRlci4gKi9cbmV4cG9ydCBjb25zdCBzZWFtcyA9IHtcbiAgdmVydGljYWxUb0VuZ2luZTogJ2NvbXBvc2VzIGVuZ2luZXMgaW4tc2NvcGUsIHNhbWUgdHJhbnNhY3Rpb24nLFxuICBlbmdpbmVUb0tlcm5lbDogJzxiPiZkYXJyOzwvYj4gY3R4IChzcWwgXHUwMEI3IGNoZWNrIFx1MDBCNyBlbWl0IFx1MDBCNyBsaW5rKSAmbmJzcDtcdTAwQjcmbmJzcDsgZXZlbnRzICsgYXVkaXQgPGI+JnVhcnI7PC9iPicsXG4gIGtlcm5lbFRvQWRhcHRlcjogJ3NhbWUga2VybmVsIHNlbWFudGljcyBvbiBhbnkgZ3JvdW5kIFx1MjAxNCBvbmUgY29udHJhY3QtdGVzdCBzdWl0ZSBnYXRlcyB0aGVtIGFsbCcsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgbGF3c0hlYWQgPSAnVGhlIGZvdXIgcnVsZXMgdGhhdCBob2xkIGl0IHRvZ2V0aGVyJztcblxuZXhwb3J0IGNvbnN0IGxhd3M6IHJlYWRvbmx5IENoaXBbXSA9IFtcbiAgWydLZXJuZWwgb3ducyBubyBkb21haW4gZW50aXRpZXMuJywgJ0l0IHByb3ZpZGVzIHRoZSBzcGluZTsgdmVydGljYWxzIGRlZmluZSB3aGF0IHRoZSBlbnRpdGllcyBtZWFuLiddLFxuICBbJ1N0YXIgdG9wb2xvZ3kuJywgJ0VuZ2luZXMgY29vcGVyYXRlIHRocm91Z2ggZmF0IGV2ZW50cyBhbmQgb3BhcXVlIHJlZnMgXHUyMDE0IG5ldmVyIGJ5IGltcG9ydGluZyBlYWNoIG90aGVyLiBOIGNvbnRyYWN0cywgbm90IE5cdTAwQjIuJ10sXG4gIFsnRW5mb3JjZWQgYXQgcnVudGltZS4nLCAnR3VhcmFudGVlcyBhcmUgZGVmYXVsdHMgb2YgdGhlIHN1YnN0cmF0ZSwgbm90IGNvbmZpZyBhIGJ1aWxkZXIgXHUyMDE0IGh1bWFuIG9yIEFJIFx1MjAxNCBjYW4gZ2V0IHdyb25nLiddLFxuICBbJ05vIGZvcmtpbmcuJywgJ0lmIGEgdmVydGljYWwgZXZlciBuZWVkcyB0byBmb3JrIGFuIGVuZ2luZSwgdGhlIGVuZ2luZSBkcmV3IGl0cyBsaW5lIHdyb25nLiddLFxuXTtcblxuLyoqIE1hcmt1cCBhbmQgZW50aXRpZXMgdGhlIGRpYWdyYW0gd2FudHMgYW5kIHRoZSB0d2luIGRvZXMgbm90LiAqL1xuY29uc3QgcGxhaW4gPSAoaHRtbDogc3RyaW5nKSA9PlxuICBodG1sXG4gICAgLnJlcGxhY2UoLzxcXC8/KGVtfGJ8Y29kZSk+L2csICcnKVxuICAgIC5yZXBsYWNlKC8mbmJzcDsvZywgJyAnKVxuICAgIC5yZXBsYWNlKC8mZGFycjsvZywgJ1x1MjE5MycpXG4gICAgLnJlcGxhY2UoLyZ1YXJyOy9nLCAnXHUyMTkxJylcbiAgICAucmVwbGFjZSgvXFxzKy9nLCAnICcpXG4gICAgLnRyaW0oKTtcblxuY29uc3QgYmFuZCA9IChsYXllcjogTGF5ZXIpID0+XG4gIGAtICoqJHtsYXllci5uYW1lfSoqIFx1MjAxNCAke3BsYWluKGxheWVyLnJvbGUpfSAqKCR7bGF5ZXIub3duZXJ9KSpcXG5gICtcbiAgbGF5ZXIuY2hpcHMubWFwKChbbmFtZSwgc3ViXSkgPT4gYCAgLSBcXGAke25hbWV9XFxgIFx1MjAxNCAke3N1Yn1gKS5qb2luKCdcXG4nKTtcblxuLyoqXG4gKiBUaGUgbWFya2Rvd24gdHdpbiwgcmVuZGVyZWQgZnJvbSB0aGUgZGF0YSBhYm92ZSByYXRoZXIgdGhhbiB3cml0dGVuIGJlc2lkZSBpdC5cbiAqIEFkZCBhbiBlbmdpbmUgdG8gYGVuZ2luZXMuY2hpcHNgIGFuZCBpdCBhcHBlYXJzIGhlcmU7IHRoZXJlIGlzIG5vIHNlY29uZCBsaXN0XG4gKiB0byB1cGRhdGUgYW5kIG5vIHdheSBmb3IgdGhlIHR3byB0byBkcmlmdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFsdCgpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgICcqKkRpYWdyYW0gXHUyMDE0IHRoZSB0aHJlZS1sYXllciBzdGFjay4qKiBTaXggYmFuZHMsIHRvcCB0byBib3R0b206IHZlcnRpY2FscywgJyArXG4gICAgICAndGhlIGxpbmUsIGVuZ2luZXMsIHRoZSBrZXJuZWwsIHRoZSBhZGFwdGVycyB1bmRlciBpdCwgYW5kIGNvbm5lY3RvcnMgYXQgdGhlIGVkZ2UuJyxcbiAgICAnJyxcbiAgICBiYW5kKHZlcnRpY2FscyksXG4gICAgYC0gKipUaGUgbGluZS4qKiBBYm92ZTogJHt0aGVMaW5lLmFib3ZlfS4gQmVsb3c6ICR7dGhlTGluZS5iZWxvd30uYCxcbiAgICBgICAtIFZlcnRpY2FscyBtZWV0IGVuZ2luZXMgYnk6ICR7cGxhaW4oc2VhbXMudmVydGljYWxUb0VuZ2luZSl9LmAsXG4gICAgYmFuZChlbmdpbmVzKSxcbiAgICBgICAtIEVuZ2luZXMgbWVldCB0aGUga2VybmVsIGJ5OiAke3BsYWluKHNlYW1zLmVuZ2luZVRvS2VybmVsKX0uYCxcbiAgICBgLSAqKiR7a2VybmVsLm5hbWV9KiogXHUyMDE0ICR7cGxhaW4oa2VybmVsLnJvbGUpfSAqKCR7a2VybmVsLm93bmVyfSkqXFxuYCArXG4gICAgICBgICAtIFByb3ZpZGVzOiAke2tlcm5lbC5iaXRzLmpvaW4oJywgJyl9LlxcbmAgK1xuICAgICAgYCAgLSAke2tlcm5lbC5jdHhMYWJlbH06ICR7a2VybmVsLmN0eC5tYXAoKGMpID0+IGBcXGAke2N9XFxgYCkuam9pbignLCAnKX0uXFxuYCArXG4gICAgICBgICAtICR7a2VybmVsLm5vdGV9YCxcbiAgICBgICAtIEtlcm5lbCBtZWV0cyB0aGUgYWRhcHRlcnMgYnk6ICR7cGxhaW4oc2VhbXMua2VybmVsVG9BZGFwdGVyKX0uYCxcbiAgICBiYW5kKGFkYXB0ZXJzKSxcbiAgICBiYW5kKGNvbm5lY3RvcnMpLFxuICAgICcnLFxuICAgIGAqKiR7bGF3c0hlYWR9KipgLFxuICAgICcnLFxuICAgIGxhd3MubWFwKChbaGVhZCwgYm9keV0sIGkpID0+IGAke2kgKyAxfS4gKioke2hlYWR9KiogJHtib2R5fWApLmpvaW4oJ1xcbicpLFxuICBdLmpvaW4oJ1xcbicpO1xufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1J1bnRpbWVUb3BvbG9neS5jb250ZW50Lm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL1J1bnRpbWVUb3BvbG9neS5jb250ZW50Lm10c1wiOy8qKlxuICogRXZlcnkgc3RyaW5nIFJ1bnRpbWVUb3BvbG9neSByZW5kZXJzLCBhbmQgdGhlIG1hcmtkb3duIHR3aW4gb2YgdGhlIHNhbWUgZmFjdHMuXG4gKiBTYW1lIGNvbnRyYWN0IGFzIExheWVyU3RhY2suY29udGVudC5tdHM6IGNvbnRlbnQgbGl2ZXMgaGVyZSBzbyBgbGxtcy5tdHNgIGNhblxuICogZmxhdHRlbiBpdCwgYmVjYXVzZSBhIGZhY3QgdHlwZWQgaW50byB0aGUgdGVtcGxhdGUgcmVuZGVycyBvbiB0aGUgcGFnZSBhbmRcbiAqIGRpc2FwcGVhcnMgZnJvbSBsbG1zLnR4dCB3aXRoIG5vdGhpbmcgZmFpbGluZy5cbiAqXG4gKiBTb3VyY2VkIGZyb20gdGhlIENsb3VkZmxhcmUgYWRhcHRlciAoaG9zdC50cywgcm91dGUtcmVzb2x2ZXIudHMsIHNjb3BlLWRvLnRzLFxuICogY29udHJvbC1wbGFuZS1kby50cykuXG4gKi9cblxuZXhwb3J0IHR5cGUgRGJLZXkgPSAnY3AnIHwgJ2lkJyB8ICdzYyc7XG5leHBvcnQgdHlwZSBTdGVwS2luZCA9ICdlZGdlJyB8ICdyb3V0ZXInIHwgJ2NvbXB1dGUnO1xuXG5leHBvcnQgaW50ZXJmYWNlIERiIHtcbiAgcmVhZG9ubHkga2V5OiBEYktleTtcbiAgcmVhZG9ubHkgY2FyZDogc3RyaW5nO1xuICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvdW50OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGl0ZW1zOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcmVhZG9ubHkgdGFnOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RlcCB7XG4gIHJlYWRvbmx5IG46IG51bWJlcjtcbiAgcmVhZG9ubHkga2luZDogU3RlcEtpbmQ7XG4gIHJlYWRvbmx5IHRpdGxlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGJvZHk6IHN0cmluZztcbiAgcmVhZG9ubHkgbW9ubz86IHN0cmluZztcbiAgcmVhZG9ubHkgdG91Y2hlcz86IERiS2V5O1xufVxuXG5leHBvcnQgY29uc3QgaGVhZGluZ3MgPSB7XG4gIGZsb3c6ICdIb3cgYSByZXF1ZXN0IHRyYXZlbHMnLFxuICBkYnM6ICdUaGUgdGhyZWUgZGF0YWJhc2VzJyxcbiAgcHJvdmlzaW9uaW5nOiAnSG93IHRoZSBkYXRhYmFzZXMgZ2V0IGNyZWF0ZWQnLFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IHN0ZXBzOiByZWFkb25seSBTdGVwW10gPSBbXG4gIHtcbiAgICBuOiAxLCBraW5kOiAnZWRnZScsXG4gICAgdGl0bGU6ICdCcm93c2VyIGhpdHMgYSBob3N0bmFtZScsXG4gICAgYm9keTogJ0EgdGVuYW50LCBhIHZlcnRpY2FsLCBhbmQgYSBzdXJmYWNlIFx1MjAxNCBhbGwgZW5jb2RlZCBpbiB0aGUgbmFtZS4nLFxuICAgIG1vbm86ICdhY21lLnRpY2tldDAuc3Vic3RyYXQucnVuJyxcbiAgfSxcbiAge1xuICAgIG46IDIsIGtpbmQ6ICdyb3V0ZXInLFxuICAgIHRpdGxlOiAnVGhlIHJvdXRlciByZXNvbHZlcyB0aGUgZG9vcicsXG4gICAgYm9keTogJ09uZSBrZXJuZWwtb3duZWQgd29ya2VyIGluIGZyb250IG9mIGV2ZXJ5IHZlcnRpY2FsLiBJdHMgb25seSBiaW5kaW5nIGlzIHRoZSBjb250cm9sIHBsYW5lIFx1MjAxNCBpdCByZWFkcyB0aGUgZGlyZWN0b3J5IHRvIHR1cm4gaG9zdG5hbWUgXHUyMTkyICh0ZW5hbnQsIHNjb3BlLCB2ZXJ0aWNhbCwgc3VyZmFjZSkuIEl0IGZpbmRzIHRoZSBkb29yOyBpdCBjYW5ub3Qgb3BlbiBhIHNjb3BlIGV2ZW4gYnkgbWlzdGFrZS4nLFxuICAgIHRvdWNoZXM6ICdjcCcsXG4gIH0sXG4gIHtcbiAgICBuOiAzLCBraW5kOiAnY29tcHV0ZScsXG4gICAgdGl0bGU6ICdIZWFkZXIgaGFuZHNoYWtlLCB0aGVuIGRpc3BhdGNoJyxcbiAgICBib2R5OiAnRXZlcnkgY2xpZW50IHgtc3Vic3RyYXQtKiBoZWFkZXIgaXMgc3RyaXBwZWQ7IHRoZSByb3V0ZXIgYXNzZXJ0cyB0aGUgcmVzb2x2ZWQgbm9kZSBwbHVzIGEgc2hhcmVkIHNlY3JldCwgdGhlbiBkaXNwYXRjaGVzIHRvIHRoZSB2ZXJ0aWNhbCB3b3JrZXIuIFRoZSB2ZXJ0aWNhbCBoYXMgbm8gcHVibGljIHJvdXRlIFx1MjAxNCB0aGUgcm91dGVyIGlzIHRoZSBvbmx5IHdheSBpbi4nLFxuICB9LFxuICB7XG4gICAgbjogNCwga2luZDogJ2NvbXB1dGUnLFxuICAgIHRpdGxlOiAnVmVydGljYWwgd29ya2VyIHJlc29sdmVzIHdobyB5b3UgYXJlJyxcbiAgICBib2R5OiAnVGhlIHZlcnRpY2FsIHdvcmtlciBob2xkcyBubyBzdGF0ZSBiZXR3ZWVuIHJlcXVlc3RzLiBJdCByZXNvbHZlcyB5b3VyIHNlc3Npb24gdG8gYSBwcmluY2lwYWwgaW4gdGhlIHRlbmFudFx1MjAxOXMgb3duIGlkZW50aXR5IGRhdGFiYXNlLicsXG4gICAgdG91Y2hlczogJ2lkJyxcbiAgfSxcbiAge1xuICAgIG46IDUsIGtpbmQ6ICdjb21wdXRlJyxcbiAgICB0aXRsZTogJ09wZW4gdGhlIHNjb3BlLCBydW4gdGhlIG9wZXJhdGlvbicsXG4gICAgYm9keTogJ0dhdGUgdGhlIHNjb3BlXHUyMDE5cyBsaWZlY3ljbGUgJiB0ZW5hbmN5LCB0aGVuIGludm9rZSgpIHJ1bnMgdGhlIG9wZXJhdGlvbiBpbnNpZGUgdGhlIHNjb3BlXHUyMDE5cyBvd24gU1FMaXRlLCBpbiBvbmUgdHJhbnNhY3Rpb24gXHUyMDE0IHBlcm1pc3Npb24gY2hlY2sgZmlyc3QsIG11dGF0aW9uIGVtaXRzIGFuIGV2ZW50LCB0aGUgb3V0Ym94IGRyYWlucyB0byBjb25zdW1lcnMgYW5kIGNvbm5lY3RvcnMuIFJvbGwgYmFjayBvbiBhbnkgdGhyb3cuJyxcbiAgICB0b3VjaGVzOiAnc2MnLFxuICB9LFxuICB7XG4gICAgbjogNiwga2luZDogJ2VkZ2UnLFxuICAgIHRpdGxlOiAnUmVzcG9uc2UgdHJhdmVscyBiYWNrIHVwJyxcbiAgICBib2R5OiAnQmFjayB0aHJvdWdoIHRoZSByb3V0ZXIsIHRoZSBvbmUgcGxhY2UgdGhhdCBrbm93cyB0aGUgdGVuYW50IFx1MjAxNCBzbyBpdCBtZXRlcnMgdGhlIHJlcXVlc3QgdGhlcmUsIG9uZSBkYXRhcG9pbnQgcGVyIGNhbGwuJyxcbiAgfSxcbl07XG5cbmV4cG9ydCBjb25zdCBkYnM6IHJlYWRvbmx5IERiW10gPSBbXG4gIHtcbiAgICBrZXk6ICdjcCcsIGNhcmQ6ICdEaXJlY3RvcnknLCBuYW1lOiAnQ29udHJvbC1wbGFuZSBEQicsIGNvdW50OiAnb25lIHBlciBlbnZpcm9ubWVudCcsXG4gICAgaXRlbXM6IFsnVGVuYW50IHJlZ2lzdHJ5ICYgc2NvcGUgbGlmZWN5Y2xlJywgJ1JvbGVzLCB0ZW5hbnQgZ3JhbnRzLCBlbnRpdGxlbWVudHMnLCAnSG9zdG5hbWVzLCB2ZXJ0aWNhbHMgJiB2ZXJzaW9ucycsICdDb25uZWN0aW9ucyAoY2lwaGVydGV4dCBvbmx5KScsICdUaGUgYWRtaW4gYXVkaXQgbG9nJ10sXG4gICAgdGFnOiAnS25vd3Mgd2hpY2ggZG9vciBcdTIwMTQgbmV2ZXIgd2hhdFx1MjAxOXMgYmVoaW5kIGl0LiBBIHNpbmdsZSBzaW5nbGV0b24gRE8uJyxcbiAgfSxcbiAge1xuICAgIGtleTogJ2lkJywgY2FyZDogJ0FwcGxpY2F0aW9uIC8gYXV0aCcsIG5hbWU6ICdJZGVudGl0eSBEQicsIGNvdW50OiAnb25lIHBlciB0ZW5hbnQnLFxuICAgIGl0ZW1zOiBbJ1VzZXJzLCBzZXNzaW9ucywgY3JlZGVudGlhbHMnLCAnSXRzIG93biBhdXRoIGVuZ2luZSwgb3duIFNRTGl0ZScsICdUaGUgbG9naW4gXHUyMTkyIHByaW5jaXBhbCBtYXAnLCAnVGhlIG93bmVyIHNlYXQsIHNldCBhdCBwcm92aXNpb24nXSxcbiAgICB0YWc6ICdTZXBhcmF0ZSBETywgc2VwYXJhdGUgc3RvcmFnZSBcdTIwMTQgb25lIHRlbmFudFx1MjAxOXMgdXNlcnMgY2FuXHUyMDE5dCBsZWFrIHRvIGFub3RoZXIuJyxcbiAgfSxcbiAge1xuICAgIGtleTogJ3NjJywgY2FyZDogJ0J1c2luZXNzIGRhdGEnLCBuYW1lOiAnU2NvcGUgREInLCBjb3VudDogJ29uZSBwZXIgc2NvcGUnLFxuICAgIGl0ZW1zOiBbJ1RoZSB2ZXJ0aWNhbFx1MjAxOXMgZW50aXRpZXMgJiBrZXJuZWwgc3BpbmUnLCAnRXZlbnRzLCBvdXRib3gsIGVudGl0eSBsaW5rcycsICdBcHBsaWVkIG1pZ3JhdGlvbnMnLCAnU2NvcGUtbGV2ZWwgZ3JhbnRzICYgcGVybWlzc2lvbnMnXSxcbiAgICB0YWc6ICdXaGVyZSBjdHguc3FsIHJ1bnMgXHUyMDE0IG9uZSB0cmFuc2FjdGlvbiBwZXIgb3BlcmF0aW9uLicsXG4gIH0sXG5dO1xuXG5leHBvcnQgY29uc3QgdG91Y2hMYWJlbDogUmVjb3JkPERiS2V5LCBzdHJpbmc+ID0ge1xuICBjcDogJ3JlYWRzIFx1MjE5MiBDb250cm9sLXBsYW5lIERCJyxcbiAgaWQ6ICdyZWFkcyBcdTIxOTIgSWRlbnRpdHkgREIgKHRoaXMgdGVuYW50KScsXG4gIHNjOiAncmVhZHMgKyB3cml0ZXMgXHUyMTkyIFNjb3BlIERCICh0aGlzIHNjb3BlKScsXG59O1xuXG5leHBvcnQgY29uc3Qga2luZExhYmVsOiBSZWNvcmQ8U3RlcEtpbmQsIHN0cmluZz4gPSB7XG4gIGVkZ2U6ICdlZGdlJywgcm91dGVyOiAna2VybmVsIHdvcmtlciBcdTAwQjcgMSBwZXIgZW52JywgY29tcHV0ZTogJ2NvbXB1dGUnLFxufTtcblxuLyoqIFRoZSBvbmUgaWRlYSBwcm92aXNpb25pbmcgdHVybnMgb24uIENhcnJpZXMgYDxiPmAsIHNvIHRoZSB0ZW1wbGF0ZSB2LWh0bWxzIGl0LiAqL1xuZXhwb3J0IGNvbnN0IHByb3ZLZXkgPVxuICAnVGhlIHRyaWNrOiA8Yj5hIER1cmFibGUgT2JqZWN0XHUyMDE5cyBkYXRhYmFzZSBzcHJpbmdzIGludG8gZXhpc3RlbmNlIHRoZSBmaXJzdCB0aW1lIHlvdSBhZGRyZXNzIGl0IGJ5IGlkLjwvYj4gJyArXG4gICdUaGVyZSBpcyBubyA8Y29kZT5DUkVBVEUgREFUQUJBU0U8L2NvZGU+IGFuZCBubyBtaWdyYXRpb24gc2VydmVyIFx1MjAxNCBwcm92aXNpb25pbmcgaXMganVzdCBhZGRyZXNzaW5nIGEgbmV3IERPICcgK1xuICAnYW5kIGxldHRpbmcgaXQgYnVpbGQgaXRzZWxmLic7XG5cbmV4cG9ydCBjb25zdCBwcm92OiByZWFkb25seSAocmVhZG9ubHkgW3N0cmluZywgc3RyaW5nXSlbXSA9IFtcbiAgWydXcml0ZSB0aGUgZGlyZWN0b3J5IHJvdy4nLCAnVGhlIGNvb3JkaW5hdG9yIHJlY29yZHMgdGhlIG5ldyBzY29wZSBpbiB0aGUgY29udHJvbCBwbGFuZSBcdTIwMTQgdGhlIGRvb3Igbm93IGV4aXN0cywgZ2F0ZWQgYnkgdGhlIHRlbmFudC4nXSxcbiAgWydBZGRyZXNzIHRoZSBTY29wZSBETy4nLCAnVGhlIG1vbWVudCBpdFx1MjAxOXMgbmFtZWQsIGl0cyBTUUxpdGUgaXMgYm9ybi4gQSBsYXp5IG1pZ3JhdGlvbiBidWlsZHMgdGhlIGtlcm5lbCBzcGluZSBhbmQgcnVucyB0aGUgdmVydGljYWxcdTIwMTlzIG93biBtb2R1bGUgbWlncmF0aW9ucyBpbiBvcmRlciBcdTIwMTQgYSBQSVRSIGJvb2ttYXJrIHRha2VuIGJlZm9yZSBlYWNoIHBhc3MuJ10sXG4gIFsnUHJvamVjdCBwZXJtaXNzaW9ucyBpbi4nLCAnVGhlIHRlbmFudFx1MjAxOXMgY3VycmVudCByb2xlcyBhbmQgZ3JhbnRzIGFyZSBjb3BpZWQgaW50byB0aGUgZnJlc2ggc2NvcGUgc28gaXQgY2FuIGRlY2lkZSBhY2Nlc3MgZnJvbSBpdHMgb3duIHN0b3JhZ2UgXHUyMDE0IHRoZW4gdGhlIG1pZ3JhdGlvbiBmcm9udGllciBpcyByZWNvcmRlZCBiYWNrIHRvIHRoZSBkaXJlY3RvcnkuJ10sXG4gIFsnSWRlbnRpdHkgREIsIGxpa2V3aXNlLicsICdUaGUgdGVuYW50XHUyMDE5cyBJZGVudGl0eSBETyBpcyBjcmVhdGVkIG9uIGZpcnN0IGFkZHJlc3MgXHUyMDE0IHRhYmxlcyBvbiBjb25zdHJ1Y3Rpb24sIHRoZSBvd25lciBzZWF0IHNldCBhdCBwcm92aXNpb24sIHdhaXRpbmcgdG8gYmUgY2xhaW1lZCBieSB0aGUgZmlyc3QgbG9naW4uJ10sXG5dO1xuXG4vKiogVGhlIGNsb3NpbmcgYXJndW1lbnQuIFBhcmFncmFwaHMgY2FycnkgYDxiPmAvYDxlbT5gOyB0aGUgdGVtcGxhdGUgdi1odG1scyB0aGVtLiAqL1xuZXhwb3J0IGNvbnN0IGlzb2xhdGlvbiA9IHtcbiAgaGVhZDogJ1doeSB0aGUgc2hhcmVkIGNvbnRyb2wgcGxhbmUgaXNuXHUyMDE5dCBhIHNoYXJlZCBibGFzdCByYWRpdXMnLFxuICBwYXJhZ3JhcGhzOiBbXG4gICAgJ0Egbm9ybWFsIHZlcnRpY2FsIHJ1bnMgPGI+XHUyMDFDQ1AtbGVzc1x1MjAxRCBvbiB0aGUgaG90IHBhdGg8L2I+OiBpdCBkZWNpZGVzIHBlcm1pc3Npb25zIGZyb20gdGhlIHNjb3BlXHUyMDE5cyA8ZW0+b3duPC9lbT4gc3RvcmFnZSBhbmQgdHJ1c3RzIHRoZSBub2RlIHRoZSByb3V0ZXIgYXNzZXJ0ZWQgXHUyMDE0IHRoZSBzaGFyZWQgY29udHJvbCBwbGFuZSBpcyA8Yj5vZmYgdGhlIHJlcXVlc3QgcGF0aCBlbnRpcmVseTwvYj4uIEl0IHN0aWxsIG93bnMgcHJvdmlzaW9uaW5nIGFuZCB0aGUgYXVkaXQgc3BpbmUsIGJ1dCBhIHJlcXVlc3Qgc2VydmluZyBvbmUgdGVuYW50IG5ldmVyIHRvdWNoZXMgYW5vdGhlciB0ZW5hbnRcdTIwMTlzIGRhdGEsIG9yIHRoZSBzaGFyZWQgZGlyZWN0b3J5LCB0byBhbnN3ZXIuJyxcbiAgICAnVGhlIHJlc3VsdDogdGhlIHNhbWUga2VybmVsIGd1YXJhbnRlZXMsIGEgcGVyLXRlbmFudCBkYXRhYmFzZSwgYW5kIGEgc2hhcmVkIGNvbnRyb2wgcGxhbmUgd2hvc2UgZmFpbHVyZSBjYW5cdTIwMTl0IHJlYWQgb3IgY29ycnVwdCBhIHJ1bm5pbmcgc2NvcGUuIDxiPklzb2xhdGlvbiBpcyB0aGUgZGVmYXVsdCwgbm90IGEgY29uZmlndXJhdGlvbiB5b3UgY2FuIGZvcmdldC48L2I+JyxcbiAgXSxcbn0gYXMgY29uc3Q7XG5cblxuLyoqIEEgcmVzaWRlbmN5IGRvdDogd2hpY2ggb2YgdGhlIHRocmVlIGxheWVycyBvd25zIHRoZSBjb2RlIGluIHRoaXMgYm94LiAqL1xuZXhwb3J0IHR5cGUgTGF5ZXIgPSAnaycgfCAnZScgfCAndic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFuZSB7XG4gIHJlYWRvbmx5IGRvdDogTGF5ZXI7XG4gIHJlYWRvbmx5IHRpdGxlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGRldGFpbDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJvdyB7XG4gIHJlYWRvbmx5IGRvdDogTGF5ZXI7XG4gIHJlYWRvbmx5IHRleHQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgb3ZlcnZpZXcgZHJhd2luZyBhYm92ZSB0aGUgbnVtYmVyZWQgc3RlcHMuXG4gKlxuICogSXQgZXhpc3RzIGZvciB0aGUgb25lIHRoaW5nIGEgbnVtYmVyZWQgbGlzdCBjYW5ub3Qgc2hvdzogdGhlIHJlcXVlc3QgZ29pbmdcbiAqIEJPVEggd2F5cy4gU3RlcCA2IHNheXMgdGhlIHJlc3BvbnNlIHRyYXZlbHMgYmFjayB1cCwgYW5kIGEgcmVhZGVyIHN0aWxsIGhhcyB0b1xuICogYXNzZW1ibGUgdGhlIHJvdW5kIHRyaXAgaW4gdGhlaXIgaGVhZC4gVGhlIGRhc2hlZCByZXR1cm4gcGF0aCBkcmF3cyBpdC5cbiAqXG4gKiBJdHMgbGFiZWxzIGFyZSBkZWxpYmVyYXRlbHkgc2hvcnQgXHUyMDE0IHRoZSBzdGVwcyBiZWxvdyBjYXJyeSB0aGUgcHJvc2UsIGFuZFxuICogYGFsdCgpYCBkb2VzIG5vdCByZS1lbWl0IHRoZW0uIFdoYXQgdGhlIGRyYXdpbmcgYWRkcywgYW5kIHdoYXQgYGFsdCgpYFxuICogdGhlcmVmb3JlIGRvZXMgZW1pdCwgaXMgYHJlc2lkZW5jeWA6IHdoaWNoIGxheWVyJ3MgY29kZSBydW5zIGluIHdoaWNoIGJveC5cbiAqL1xuZXhwb3J0IGNvbnN0IGRpYWdyYW0gPSB7XG4gIGFyaWE6XG4gICAgJ0EgcmVxdWVzdCB0cmF2ZWxzIGZyb20gdGhlIGJyb3dzZXIgdG8gdGhlIHJvdXRlciwgd2hpY2ggcmVhZHMgdGhlIGNvbnRyb2wtcGxhbmUgJyArXG4gICAgJ0R1cmFibGUgT2JqZWN0IHRvIHJlc29sdmUgdGhlIGhvc3RuYW1lLCB0aGVuIGRpc3BhdGNoZXMgdG8gdGhlIHZlcnRpY2FsIHdvcmtlci4gJyArXG4gICAgJ1RoZSB3b3JrZXIgcmVhZHMgdGhlIHRlbmFudFx1MjAxOXMgSWRlbnRpdHkgRHVyYWJsZSBPYmplY3QgYW5kIG9wZW5zIHRoZSBTY29wZSBEdXJhYmxlICcgK1xuICAgICdPYmplY3QsIHdoZXJlIHRoZSBvcGVyYXRpb24gcnVucy4gVGhlIHJlc3BvbnNlIHJldHVybnMgYWxvbmcgYSBkYXNoZWQgcGF0aCBiYWNrICcgK1xuICAgICd0aHJvdWdoIHRoZSByb3V0ZXIuJyxcbiAgYnJvd3NlcjogeyB0aXRsZTogJ0Jyb3dzZXInLCBtb25vOiAnYWNtZS50aWNrZXQwLnN1YnN0cmF0LnJ1bicgfSxcbiAgdG9Sb3V0ZXI6ICd0aGUgcmVxdWVzdCcsXG4gIHJvdXRlcjoge1xuICAgIHRhZzogJ2Nsb3VkZmxhcmUgZWRnZScsXG4gICAgdGl0bGU6ICdSb3V0ZXInLFxuICAgIHN1YjogWydPbmUgcGVyIGVudmlyb25tZW50LicsICdGaW5kcyB0aGUgZG9vcjsgY2Fubm90IG9wZW4gaXQuJ10sXG4gICAgY2hpcDogJ2tlcm5lbCBvbmx5JyxcbiAgfSxcbiAgdG9Db250cm9sUGxhbmU6ICdob3N0bmFtZSBcdTIxOTIgbm9kZScsXG4gIGNvbnRyb2xQbGFuZToge1xuICAgIHRhZzogJ2R1cmFibGUgb2JqZWN0JyxcbiAgICB0aXRsZTogJ0NvbnRyb2wtcGxhbmUgRE8nLFxuICAgIHN1YjogWydUaGUgZGlyZWN0b3J5LicsICdPbmUgcGVyIGVudmlyb25tZW50LiddLFxuICAgIGNoaXA6ICdrZXJuZWwgb25seScsXG4gIH0sXG4gIHRvV29ya2VyOiAnZGlzcGF0Y2ggXHUwMEI3IGFzc2VydHMgdGhlIG5vZGUgKyBST1VURVJfU0VDUkVUJyxcbiAgd29ya2VyOiB7XG4gICAgdGFnOiAnd29ya2VyIFx1MDBCNyBvbmUgcGVyIHZlcnNpb24nLFxuICAgIHRpdGxlOiAnVGhlIHZlcnRpY2FsIHdvcmtlcicsXG4gICAgc3ViOiAnWW91ciBwdXNoZWQgYnVuZGxlLiBObyBwdWJsaWMgcm91dGUsIG5vIHN0YXRlIGJldHdlZW4gcmVxdWVzdHMuJyxcbiAgfSxcbiAgdG9JZGVudGl0eTogJ3Nlc3Npb24gXHUyMTkyIHByaW5jaXBhbCcsXG4gIGlkZW50aXR5OiB7XG4gICAgdGFnOiAnZHVyYWJsZSBvYmplY3QnLFxuICAgIHRpdGxlOiAnSWRlbnRpdHkgRE8nLFxuICAgIHN1YjogWydPbmUgcGVyIHRlbmFudC4nLCAnVXNlcnMsIHNlc3Npb25zLCB0aGUgb3duZXIgc2VhdC4nXSxcbiAgICBjaGlwOiAna2VybmVsIG9ubHknLFxuICB9LFxuICB0b1Njb3BlOiAnZ2V0U2NvcGUoKSBcdTAwQjcgaW52b2tlKCknLFxuICBzY29wZToge1xuICAgIHRhZzogJ2R1cmFibGUgb2JqZWN0JyxcbiAgICB0aXRsZTogJ1Njb3BlIERPJyxcbiAgICBzdWI6ICdJdHMgb3duIFNRTGl0ZS4gT25lIG9wZXJhdGlvbiBhdCBhIHRpbWUuJyxcbiAgfSxcbiAgcmV0OiAncmVzcG9uc2UgXHUwMEI3IG1ldGVyZWQgYXQgdGhlIHJvdXRlcicsXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIFdoaWNoIGxheWVyJ3MgY29kZSBleGVjdXRlcyBpbiB3aGljaCBib3ggXHUyMDE0IHRoZSBmYWN0IHRoZSBkcmF3aW5nIGNhcnJpZXMgdGhhdFxuICogdGhlIG51bWJlcmVkIHN0ZXBzIGRvIG5vdC4gT25lIHB1c2hlZCBidW5kbGU7IHRoZSBydW50aW1lIGRlY2lkZXMgd2hlcmUgZWFjaFxuICogcGFydCBvZiBpdCBydW5zLCBhbmQgdGhhdCBzcGxpdCBpcyB3aGF0IHRoZSBib3VuZGFyaWVzIGFyZSBtYWRlIG9mLlxuICovXG5leHBvcnQgY29uc3QgcmVzaWRlbmN5ID0ge1xuICBpbnRybzpcbiAgICAnT25lIGJ1bmRsZSwgdHdvIGV4ZWN1dGlvbiBlbnZpcm9ubWVudHMuIFRoZSB3b3JrZXIgaXMgdHJ1c3RlZCB3aXRoIGFkZHJlc3NpbmcgJyArXG4gICAgJ2FuZCBuZXZlciB3aXRoIGRhdGE7IHRoZSBzY29wZSBob2xkcyB0aGUgZGF0YSBhbmQgY2Fubm90IHJlYWNoIHRoZSBuZXR3b3JrLicsXG4gIHdvcmtlcjogW1xuICAgIHsgZG90OiAnaycsIHRpdGxlOiAnS2VybmVsIGhvc3QnLCBkZXRhaWw6ICdnZXRTY29wZSgpIFx1MDBCNyBwZXJtaXNzaW9uIGdhdGUgXHUwMEI3IG1ldGVyaW5nJyB9LFxuICAgIHsgZG90OiAndicsIHRpdGxlOiAnVmVydGljYWwgSFRUUCcsIGRldGFpbDogJ3JvdXRlcywgZXJyb3IgZW52ZWxvcGUsIHNlc3Npb24gXHUyMTkyIHByaW5jaXBhbCcgfSxcbiAgICB7IGRvdDogJ3YnLCB0aXRsZTogJ0Nvbm5lY3RvciBjb2RlJywgZGV0YWlsOiAndGhlIG9ubHkgcGxhY2UgZmV0Y2goKSBpcyBhbGxvd2VkIHRvIGV4aXN0JyB9LFxuICBdLFxuICBzY29wZTogW1xuICAgIHsgZG90OiAndicsIHRleHQ6ICdWZXJ0aWNhbCBvcGVyYXRpb25zIFx1MjAxNCBjdHguY2hlY2soKSwgdGhlbiBjdHguc3FsJyB9LFxuICAgIHsgZG90OiAnZScsIHRleHQ6ICdFbmdpbmUgZnVuY3Rpb25zIFx1MjAxNCB0aGUgc2FtZSB0cmFuc2FjdGlvbicgfSxcbiAgICB7IGRvdDogJ2snLCB0ZXh0OiAnS2VybmVsIHNwaW5lIFx1MjAxNCBldmVudHMsIG91dGJveCwgbGlua3MsIG1pZ3JhdGlvbnMnIH0sXG4gIF0sXG59IGFzIGNvbnN0IHNhdGlzZmllcyB7IGludHJvOiBzdHJpbmc7IHdvcmtlcjogcmVhZG9ubHkgUGFuZVtdOyBzY29wZTogcmVhZG9ubHkgUm93W10gfTtcblxuLyoqIE1hcmt1cCB0aGUgZGlhZ3JhbSB3YW50cyBhbmQgdGhlIHR3aW4gZG9lcyBub3QuICovXG5jb25zdCBwbGFpbiA9IChodG1sOiBzdHJpbmcpID0+IGh0bWwucmVwbGFjZSgvPFxcLz8oYnxlbXxjb2RlKT4vZywgJycpO1xuXG4vKipcbiAqIFRoZSBtYXJrZG93biB0d2luLCByZW5kZXJlZCBmcm9tIHRoZSBkYXRhIGFib3ZlLiBUaGUgbnVtYmVyZWQgZmxvdyBzdXJ2aXZlcyBhc1xuICogYSBudW1iZXJlZCBsaXN0IGJlY2F1c2UgdGhlIG9yZGVyIGlzIHRoZSBpbmZvcm1hdGlvbiBcdTIwMTQgdGhpcyByZWFsbHkgaXMgYVxuICogc2VxdWVuY2UsIG5vdCBhIHNldCBvZiBsYWJlbGxlZCBib3hlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFsdCgpOiBzdHJpbmcge1xuICBjb25zdCBmbG93ID0gc3RlcHMubWFwKChzKSA9PiB7XG4gICAgY29uc3QgZGV0YWlsID0gW1xuICAgICAgcy5tb25vID8gYFxcYCR7cy5tb25vfVxcYGAgOiAnJyxcbiAgICAgIHMudG91Y2hlcyA/IGBfJHt0b3VjaExhYmVsW3MudG91Y2hlc119X2AgOiAnJyxcbiAgICBdLmZpbHRlcihCb29sZWFuKTtcbiAgICByZXR1cm4gKFxuICAgICAgYCR7cy5ufS4gKioke3MudGl0bGV9KiogKCR7a2luZExhYmVsW3Mua2luZF19KSBcdTIwMTQgJHtzLmJvZHl9YCArXG4gICAgICAoZGV0YWlsLmxlbmd0aCA/IGBcXG4gICAke2RldGFpbC5qb2luKCcgXHUwMEI3ICcpfWAgOiAnJylcbiAgICApO1xuICB9KTtcblxuICBjb25zdCBzdG9yZXMgPSBkYnMubWFwKFxuICAgIChkKSA9PlxuICAgICAgYC0gKioke2QubmFtZX0qKiAoJHtkLmNhcmR9LCAke2QuY291bnR9KSBcdTIwMTQgJHtkLml0ZW1zLmpvaW4oJzsgJyl9LiAke2QudGFnfWAsXG4gICk7XG5cbiAgY29uc3QgcHJvdmlzaW9uaW5nID0gcHJvdi5tYXAoKFtoZWFkLCBib2R5XSwgaSkgPT4gYCR7aSArIDF9LiAqKiR7aGVhZH0qKiAke2JvZHl9YCk7XG5cbiAgY29uc3Qgd2hlcmUgPSBbXG4gICAgYC0gKipUaGUgdmVydGljYWwgd29ya2VyKiogcnVuczogYCArXG4gICAgICByZXNpZGVuY3kud29ya2VyLm1hcCgocCkgPT4gYCR7cC50aXRsZX0gKCR7cC5kZXRhaWx9KWApLmpvaW4oJzsgJykgKyAnLicsXG4gICAgYC0gKipUaGUgU2NvcGUgRE8qKiBydW5zOiBgICsgcmVzaWRlbmN5LnNjb3BlLm1hcCgocikgPT4gci50ZXh0KS5qb2luKCc7ICcpICsgJy4nLFxuICBdO1xuXG4gIHJldHVybiBbXG4gICAgJyoqRGlhZ3JhbSBcdTIwMTQgdGhlIGhvc3RlZCBydW50aW1lIHRvcG9sb2d5LioqIEV2ZXJ5IGJveCBpcyBhIER1cmFibGUgT2JqZWN0IHdpdGggJyArXG4gICAgICAnaXRzIG93biBTUUxpdGU7IHRoZSByb3V0ZXJcdTIwMTlzIG9ubHkgam9iIGlzIHRvIGZpbmQgdGhlIHJpZ2h0IGRvb3IuIFRoZSByZXF1ZXN0ICcgK1xuICAgICAgJ2Rlc2NlbmRzIGJyb3dzZXIgXHUyMTkyIHJvdXRlciBcdTIxOTIgd29ya2VyIFx1MjE5MiBzY29wZSwgYW5kIHRoZSByZXNwb25zZSByZXR1cm5zIHRoZSBzYW1lICcgK1xuICAgICAgJ3dheSwgbWV0ZXJlZCBhdCB0aGUgcm91dGVyLicsXG4gICAgJycsXG4gICAgcmVzaWRlbmN5LmludHJvLFxuICAgICcnLFxuICAgIC4uLndoZXJlLFxuICAgICcnLFxuICAgIGAqKiR7aGVhZGluZ3MuZmxvd30qKmAsXG4gICAgJycsXG4gICAgLi4uZmxvdyxcbiAgICAnJyxcbiAgICBgKioke2hlYWRpbmdzLmRic30qKmAsXG4gICAgJycsXG4gICAgLi4uc3RvcmVzLFxuICAgICcnLFxuICAgIGAqKiR7aGVhZGluZ3MucHJvdmlzaW9uaW5nfSoqYCxcbiAgICAnJyxcbiAgICBwbGFpbihwcm92S2V5KSxcbiAgICAnJyxcbiAgICAuLi5wcm92aXNpb25pbmcsXG4gICAgJycsXG4gICAgYCoqJHtpc29sYXRpb24uaGVhZH0qKmAsXG4gICAgJycsXG4gICAgLi4uaXNvbGF0aW9uLnBhcmFncmFwaHMubWFwKHBsYWluKSxcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9TY29wZVRvcG9sb2d5LmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU2NvcGVUb3BvbG9neS5jb250ZW50Lm10c1wiOy8qKlxuICogVGhlIGFkYXB0ZXItbmV1dHJhbCB0b3BvbG9neSwgYW5kIGl0cyBtYXJrZG93biB0d2luLlxuICpcbiAqIFJlcGxhY2VzIHRoZSBgZmxvd2NoYXJ0IFRCYCBtZXJtYWlkIGJsb2NrIHRoYXQgc3Rvb2QgaW4gZ3VpZGUvYXJjaGl0ZWN0dXJlLm1kLlxuICogTWVybWFpZCBsYWlkIGl0IG91dCBvbiBpdHMgb3duIHRlcm1zIFx1MjAxNCBib3ggd2lkdGhzIGZyb20gbGFiZWwgbGVuZ3RoLCBlZGdlc1xuICogcm91dGVkIGJ5IGRhZ3JlIFx1MjAxNCBzbyB0aGUgb25lIHRoaW5nIHRoZSBwaWN0dXJlIGlzIGZvciwgdGhhdCBhIHNjb3BlIGhvc3QgZmFuc1xuICogb3V0IHRvIG1hbnkgaXNvbGF0ZWQgc2NvcGVzIGFuZCBldmVyeSBvbmUgb2YgdGhlbSBmZWVkcyB0aGUgc2FtZSBzcGluZSwgY2FtZVxuICogb3V0IGxvb2tpbmcgYWNjaWRlbnRhbC5cbiAqXG4gKiBUaGlzIGlzIGRlbGliZXJhdGVseSBOT1QgdGhlIGhvc3RlZCBwaWN0dXJlOiBubyByb3V0ZXIsIG5vIENsb3VkZmxhcmUsIG5vXG4gKiBEdXJhYmxlIE9iamVjdHMuIFRoYXQgaXMgYFJ1bnRpbWVUb3BvbG9neWAsIGZ1cnRoZXIgZG93biB0aGUgc2FtZSBwYWdlLiBUaGVcbiAqIGNsYWltIGhlcmUgaXMgdHJ1ZSBvZiBldmVyeSBhZGFwdGVyLCB3aGljaCBpcyB0aGUgcG9pbnQgb2YgZHJhd2luZyBpdCBmaXJzdC5cbiAqXG4gKiBTYW1lIGNvbnRyYWN0IGFzIHRoZSBzaWJsaW5nIGNvbnRlbnQgbW9kdWxlczogYSBmYWN0IHR5cGVkIGludG8gdGhlIHRlbXBsYXRlXG4gKiByZW5kZXJzIG9uIHRoZSBwYWdlIGFuZCB2YW5pc2hlcyBmcm9tIGxsbXMudHh0LiBQdXQgaXQgaGVyZS5cbiAqL1xuXG5leHBvcnQgY29uc3QgYXJpYSA9XG4gICdWZXJ0aWNhbCBjb2RlIHJlYWNoZXMgYSBzY29wZSBob3N0IHRocm91Z2ggdGhlIGtlcm5lbCBBUEkgb25seS4gVGhlIGhvc3QgaGFuZHMgb3V0ICcgK1xuICAnY2FwYWJpbGl0eSBzdHVicyBmb3IgaW5kaXZpZHVhbCBzY29wZXMsIGVhY2ggd2l0aCBpdHMgb3duIGRhdGFiYXNlIGFuZCBBQ0wgYW5kIGl0cyBvd24gJyArXG4gICdzZXJpYWxpemVkIGV4ZWN1dG9yLiBFdmVyeSBzY29wZSBlbWl0cyBrZXJuZWwtc3RhbXBlZCBldmVudHMgaW50byBvbmUgc2hhcmVkIGV2ZW50IHNwaW5lLic7XG5cbmV4cG9ydCBjb25zdCB2ZXJ0aWNhbCA9IHtcbiAgdGFnOiAneW91ciBjb2RlJyxcbiAgdGl0bGU6ICdWZXJ0aWNhbCcsXG4gIHN1YjogJ1R5cGVTY3JpcHQgXHUwMEI3IG9mdGVuIEFJLWJ1aWx0Jyxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCB0b0hvc3QgPSAnQHN1YnN0cmF0LXJ1bi9rZXJuZWwgQVBJIG9ubHknO1xuXG5leHBvcnQgY29uc3QgaG9zdCA9IHtcbiAgdGFnOiAna2VybmVsJyxcbiAgdGl0bGU6ICdTY29wZSBob3N0JyxcbiAgbW9ubzogJ2dldFNjb3BlKHByaW5jaXBhbCwgdGVuYW50LCBzY29wZSknLFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IHRvU2NvcGVzID0gJ2hvbGRpbmcgYSBzdHViIGlzIHRoZSBhdXRob3JpemF0aW9uJztcblxuZXhwb3J0IGNvbnN0IHNjb3BlcyA9IFtcbiAge1xuICAgIHRhZzogJ29uZSBpc29sYXRpb24gZG9tYWluJyxcbiAgICB0aXRsZTogJ1Njb3BlIFx1MDBCNyBicmFuY2ggIzEnLFxuICAgIHN1YjogWydpdHMgb3duIGRhdGFiYXNlICsgQUNMJywgJ3NlcmlhbGl6ZWQgXHUyMDE0IG9uZSBvcCBhdCBhIHRpbWUnXSxcbiAgfSxcbiAge1xuICAgIHRhZzogJ29uZSBpc29sYXRpb24gZG9tYWluJyxcbiAgICB0aXRsZTogJ1Njb3BlIFx1MDBCNyBicmFuY2ggIzI0MCcsXG4gICAgc3ViOiBbJ2l0cyBvd24gZGF0YWJhc2UgKyBBQ0wnLCAnc2VyaWFsaXplZCBcdTIwMTQgb25lIG9wIGF0IGEgdGltZSddLFxuICB9LFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IHRvU3BpbmUgPSAnZXZlbnRzLCBrZXJuZWwtc3RhbXBlZCc7XG5cbmV4cG9ydCBjb25zdCBzcGluZSA9IHtcbiAgdGFnOiAna2VybmVsLW93bmVkJyxcbiAgdGl0bGU6ICdFdmVudCBzcGluZScsXG4gIHN1YjogJ2F1ZGl0IFx1MDBCNyByZXBvcnRpbmcgXHUwMEI3IGludGVncmF0aW9ucycsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgY2FwdGlvbiA9XG4gICdUaGUgc2FtZSBzaGFwZSBvbiBldmVyeSBhZGFwdGVyIFx1MjAxNCBvbmUgU1FMaXRlIGZpbGUgcGVyIHNjb3BlIGxvY2FsbHksIG9uZSBEdXJhYmxlIE9iamVjdCAnICtcbiAgJ3BlciBzY29wZSBpbiBwcm9kdWN0aW9uLiBOb3RoaW5nIGFib3ZlIHRoZSBzdHViIGNhbiB3aWRlbiBpdHMgb3duIHJlYWNoLic7XG5cbi8qKlxuICogVGhlIHR3aW4uIEl0IGRvZXMgbm90IHJlc3RhdGUgdGhlIHRocmVlIGludmFyaWFudHMgYmVsb3cgdGhlIGZpZ3VyZSBvbiB0aGVcbiAqIHBhZ2U6IHRob3NlIGFyZSBwcm9zZSB0aGUgdHdpbiBhbHJlYWR5IGNhcnJpZXMgdmVyYmF0aW0sIGFuZCBzYXlpbmcgdGhlbSB0d2ljZVxuICogaXMgaG93IHR3byBjb3BpZXMgc3RhcnQgZGlzYWdyZWVpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICAnKipEaWFncmFtIFx1MjAxNCB0aGUgdG9wb2xvZ3ksIGFkYXB0ZXItbmV1dHJhbC4qKiBWZXJ0aWNhbCBjb2RlIHJlYWNoZXMgZGF0YSBvbmUgd2F5LCAnICtcbiAgICAgICdhbmQgZXZlcnkgc2NvcGUgZmVlZHMgb25lIHNwaW5lLicsXG4gICAgJycsXG4gICAgYDEuICoqJHt2ZXJ0aWNhbC50aXRsZX0qKiAoJHt2ZXJ0aWNhbC50YWd9LCAke3ZlcnRpY2FsLnN1Yn0pIHJlYWNoZXMgdGhlIGhvc3QgYnkgYCArXG4gICAgICBgKioke3RvSG9zdH0qKi5gLFxuICAgIGAyLiAqKiR7aG9zdC50aXRsZX0qKiAoJHtob3N0LnRhZ30pIFx1MjAxNCBcXGAke2hvc3QubW9ub31cXGAgcmV0dXJucyBhIGNhcGFiaWxpdHkgc3R1Yi4gYCArXG4gICAgICBgJHt0b1Njb3Blc30uYCxcbiAgICBgMy4gRWFjaCBzY29wZSBpcyAke3Njb3Blc1swXS5zdWIuam9pbignLCAnKX0gXHUyMDE0IGRyYXduIGhlcmUgYXMgYCArXG4gICAgICBgJHtzY29wZXMubWFwKChzKSA9PiBzLnRpdGxlKS5qb2luKCcgYW5kICcpfSwgYnV0IHRoZXJlIGFyZSBhcyBtYW55IGFzIHRoZSB0ZW5hbnQgaGFzLmAsXG4gICAgYDQuIEV2ZXJ5IHNjb3BlIGVtaXRzICoqJHt0b1NwaW5lfSoqIGludG8gdGhlICoqJHtzcGluZS50aXRsZX0qKiAoJHtzcGluZS50YWd9KTogYCArXG4gICAgICBgJHtzcGluZS5zdWJ9LmAsXG4gICAgJycsXG4gICAgY2FwdGlvbixcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9CbGFzdFJhZGl1cy5jb250ZW50Lm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzL0JsYXN0UmFkaXVzLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBFdmVyeSBzdHJpbmcgQmxhc3RSYWRpdXMgcmVuZGVycywgYW5kIHRoZSBtYXJrZG93biB0d2luIG9mIHRoZSBzYW1lIGZhY3RzLlxuICpcbiAqIFRoZSBkYXRhIGxpdmVzIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIGNvbXBvbmVudCdzIGA8c2NyaXB0IHNldHVwPmAgYmVjYXVzZVxuICogYGxsbXMubXRzYCBjYW5ub3QgaW1wb3J0IGEgYDxzY3JpcHQgc2V0dXA+YCBibG9jazogYSBmYWN0IHR5cGVkIGludG8gdGhlXG4gKiB0ZW1wbGF0ZSByZW5kZXJzIG9uIHRoZSBwYWdlIGFuZCB2YW5pc2hlcyBmcm9tIGxsbXMudHh0LiBTZWUgdGhlIG5vdGUgYXQgdGhlXG4gKiB0b3Agb2YgLi9MYXllclN0YWNrLmNvbnRlbnQubXRzIFx1MjAxNCB0aGUgcnVsZSBpcyB0aGUgc2FtZSBvbmUuXG4gKlxuICogYHRoZUxpbmVgIGlzIGltcG9ydGVkIHJhdGhlciB0aGFuIHJlc3RhdGVkLiBUaGUgY29zbWV0aWMvY2F0YXN0cm9waGljIHNwbGl0IGlzXG4gKiBhbHJlYWR5IHRoZSBzcGluZSBvZiB0aGUgdGhyZWUtbGF5ZXIgZGlhZ3JhbSwgYW5kIHR3byBjb3BpZXMgb2YgYSB0aGVzaXMgaXNcbiAqIGV4YWN0bHkgdGhlIGRyaWZ0IHRoaXMgcmVwbyBsaW50cyBmb3IgZXZlcnl3aGVyZSBlbHNlLlxuICovXG5pbXBvcnQgeyB0aGVMaW5lIH0gZnJvbSAnLi9MYXllclN0YWNrLmNvbnRlbnQubWpzJztcblxuZXhwb3J0IHsgdGhlTGluZSB9O1xuXG4vKiogQSBzaWRlIG9mIHRoZSBsaW5lOiB3aG8gd3JpdGVzIGl0LCBhbmQgd2hhdCBhIG1pc3Rha2UgdGhlcmUgY29zdHMuICovXG5leHBvcnQgaW50ZXJmYWNlIFNpZGUge1xuICByZWFkb25seSBuYW1lOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHZlcmRpY3Q6IHN0cmluZztcbiAgcmVhZG9ubHkgY2hpcHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgY29uc3QgYWJvdmU6IFNpZGUgPSB7XG4gIG5hbWU6ICdXaGF0IGFuIGFnZW50IHdyaXRlcycsXG4gIHZlcmRpY3Q6ICdNaXN0YWtlcyBhcmUgY29zbWV0aWMnLFxuICBjaGlwczogWydzY3JlZW5zJywgJ2Zvcm1zJywgJ3dvcmtmbG93cycsICdyZXBvcnRzJywgJ3ByaWNpbmcnLCAndm9jYWJ1bGFyeSddLFxufTtcblxuZXhwb3J0IGNvbnN0IGJlbG93OiBTaWRlID0ge1xuICBuYW1lOiAnV2hhdCB0aGUgc3Vic3RyYXRlIG93bnMnLFxuICB2ZXJkaWN0OiAnTWlzdGFrZXMgYXJlIGNhdGFzdHJvcGhpYycsXG4gIGNoaXBzOiBbJ3RlbmFuY3knLCAnYXV0aCcsICdtaWdyYXRpb25zJywgJ2ludGVncmF0aW9ucycsICdhdWRpdCcsICdjb21wbGlhbmNlJ10sXG59O1xuXG4vKipcbiAqIFRoZSBjYXB0aW9uIHVuZGVyIHRoZSBmaWd1cmUgXHUyMDE0IHRoZSByZWFzb24gdGhlIHNwbGl0IGlzIGFyY2hpdGVjdHVyYWwsIG5vdCBhZHZpc29yeS5cbiAqIEhlbGQgb25jZSBpbiBtYXJrZG93bi1pc2ggc291cmNlOyB0aGUgY29tcG9uZW50IHJlbmRlcnMgYGNhcHRpb25IdG1sYCBhbmQgdGhlIHR3aW5cbiAqIHJlbmRlcnMgdGhlIHBsYWluIGZvcm0sIHNvIHRoZSBwaWN0dXJlIGFuZCBpdHMgdGV4dCBjYW5ub3QgZGlzYWdyZWUuXG4gKi9cbmV4cG9ydCBjb25zdCBjYXB0aW9uID1cbiAgJ1RoZSBsYXllciB3aGVyZSBtb2RlbHMgYXJlIHdlYWtlc3QgaXMgdGhlIGxheWVyIHdoZXJlIG1pc3Rha2VzIGFyZSBmYXRhbC4gJyArXG4gICdTbyB0aGUgc3BsaXQgaXMgc3RydWN0dXJhbCByYXRoZXIgdGhhbiBpbnN0cnVjdGlvbmFsOiBwcm9tcHRpbmcgYSBtb2RlbCB0byAnICtcbiAgJ1wiYmUgY2FyZWZ1bCB3aXRoIHRlbmFuY3lcIiBpcyBhIHN1Z2dlc3Rpb24sIGFuZCBhIGBnZXRTY29wZWAgY2FsbCB0aGF0IGZhaWxzICcgK1xuICAnY2xvc2VkIG9uIGEgbWlzbWF0Y2hlZCBwYWlyIGlzIGEgZmFjdC4nO1xuXG4vKiogVGhlIHNhbWUgc2VudGVuY2Ugd2l0aCBpdHMgY29kZSBzcGFucyBtYXJrZWQgdXAsIGZvciB0aGUgdGVtcGxhdGUuICovXG5leHBvcnQgY29uc3QgY2FwdGlvbkh0bWwgPSBjYXB0aW9uLnJlcGxhY2UoL2AoW15gXSspYC9nLCAnPGNvZGU+JDE8L2NvZGU+Jyk7XG5cbmV4cG9ydCBmdW5jdGlvbiBhbHQoKTogc3RyaW5nIHtcbiAgY29uc3Qgc2lkZSA9IChzOiBTaWRlKSA9PlxuICAgIGAtICoqJHtzLm5hbWV9KiogXHUyMDE0ICR7cy52ZXJkaWN0LnRvTG93ZXJDYXNlKCl9OiAke3MuY2hpcHMuam9pbignLCAnKX0uYDtcbiAgcmV0dXJuIFtcbiAgICAnKipEaWFncmFtIFx1MjAxNCB0aGUgbGluZS4qKiBUd28gYmFuZHMgZWl0aGVyIHNpZGUgb2Ygb25lIGJvdW5kYXJ5LicsXG4gICAgJycsXG4gICAgc2lkZShhYm92ZSksXG4gICAgYC0gKioke3RoZUxpbmUubGFiZWx9LioqIEFib3ZlOiAke3RoZUxpbmUuYWJvdmV9LiBCZWxvdzogJHt0aGVMaW5lLmJlbG93fS5gLFxuICAgIHNpZGUoYmVsb3cpLFxuICAgICcnLFxuICAgIGNhcHRpb24sXG4gIF0uam9pbignXFxuJyk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvR3VhcmRQYXRoLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvR3VhcmRQYXRoLmNvbnRlbnQubXRzXCI7LyoqXG4gKiBFdmVyeSBzdHJpbmcgR3VhcmRQYXRoIHJlbmRlcnMsIGFuZCB0aGUgbWFya2Rvd24gdHdpbiBvZiB0aGUgc2FtZSBmYWN0cy5cbiAqXG4gKiBBcyB3aXRoIGl0cyBzaWJsaW5nczogYSBmYWN0IHR5cGVkIGludG8gdGhlIHRlbXBsYXRlIHJlbmRlcnMgb24gdGhlIHBhZ2UgYW5kXG4gKiB2YW5pc2hlcyBmcm9tIGxsbXMudHh0LiBQdXQgaXQgaGVyZS4gU2VlIC4vTGF5ZXJTdGFjay5jb250ZW50Lm10cy5cbiAqXG4gKiBUaGUgb3JkZXJpbmcgaXMgbG9hZC1iZWFyaW5nIGFuZCBpcyBub3QgZGVjb3JhdGlvbi4gVGhlc2UgYXJlIG5vdCBsYXllcnMgb2YgYVxuICogcGljdHVyZSBcdTIwMTQgdGhleSBhcmUgc3RhZ2VzIGEgY29tbWl0IHBhc3NlcyB0aHJvdWdoIGluIHRpbWUsIGVhY2ggYWJsZSB0byBzdG9wXG4gKiBpdCwgYW5kIHRoZSBjbGFpbSB0aGUgcGFnZSBtYWtlcyBpcyB0aGF0IGEgbWlzdGFrZSBzdXJ2aXZpbmcgb25lIG1lZXRzIHRoZVxuICogbmV4dC4gUmVvcmRlcmluZyB0aGVtIG1ha2VzIHRoZSBwYWdlIHNheSBzb21ldGhpbmcgZmFsc2UuXG4gKi9cblxuLyoqIE9uZSBzdGFnZSBvbiB0aGUgcGF0aCBhIGNoYW5nZSB0YWtlcy4gYGJvZHlgIGNhcnJpZXMgaW5saW5lIGA8Y29kZT5gL2A8ZW0+YC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR3VhcmQge1xuICAvKiogV2hlbiBpdCBmaXJlcyBcdTIwMTQgdGhlIHN0YWdlIG5hbWUsIG5vdCBhIGNhdGVnb3J5LiAqL1xuICByZWFkb25seSB3aGVuOiBzdHJpbmc7XG4gIHJlYWRvbmx5IHRpdGxlOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGJvZHk6IHN0cmluZztcbiAgLyoqIFdoYXQgYSByZWFkZXIgbG9zZXMgaWYgdGhpcyBzdGFnZSBpcyBtaXNzaW5nLiAqL1xuICByZWFkb25seSBzdG9wczogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgZ3VhcmRzOiByZWFkb25seSBHdWFyZFtdID0gW1xuICB7XG4gICAgd2hlbjogJ0NvbXBpbGUnLFxuICAgIHRpdGxlOiBcIkludmFsaWQgc3RhdGVzIGRvbid0IHR5cGVjaGVja1wiLFxuICAgIGJvZHk6XG4gICAgICAnQSBuYXJyb3csIGFnZ3Jlc3NpdmVseSB0eXBlZCBTREsgbWVhbnMgYSBzbWFsbCBoYWxsdWNpbmF0aW9uIHN1cmZhY2UuIEEgJyArXG4gICAgICAnPGNvZGU+U2NvcGVJZDwvY29kZT4gd2lsbCBub3QgdHlwZWNoZWNrIHdoZXJlIGEgPGNvZGU+VGVuYW50SWQ8L2NvZGU+IGlzIGV4cGVjdGVkLCBzbyBhbiAnICtcbiAgICAgICdhZ2VudCBjYW5ub3Qgc3dhcCB0aGVtIHNpbGVudGx5LiBBIHBlcm1pc3Npb24gPGNvZGU+RGVjaXNpb248L2NvZGU+IGlzIGVpdGhlciAnICtcbiAgICAgICc8Y29kZT57IGFsbG93ZWQ6IHRydWUsIHByb29mIH08L2NvZGU+IG9yIDxjb2RlPnsgYWxsb3dlZDogZmFsc2UsIGNoZWNrZWQsIG5vZGUgfTwvY29kZT4gXHUyMDE0IGFuICcgK1xuICAgICAgJ3VuZXhwbGFpbmVkIGFsbG93IGlzIHVucmVwcmVzZW50YWJsZS4gQW4gZXZlbnQgd2l0aG91dCBhIDxjb2RlPnBpaUNsYXNzPC9jb2RlPiAnICtcbiAgICAgIFwiZG9lc24ndCBwYXJzZSwgYW5kIGEgUElJLWNsYXNzZWQgZXZlbnQgd2l0aG91dCBhIDxjb2RlPnN1YmplY3RJZDwvY29kZT4gZG9lc24ndCBlaXRoZXIuXCIsXG4gICAgc3RvcHM6ICdJRCBjb25mdXNpb24sIHNpbGVudCBhbGxvd3MsIHVuY2xhc3NpZmllZCBwZXJzb25hbCBkYXRhLicsXG4gIH0sXG4gIHtcbiAgICB3aGVuOiAnQm91bmQnLFxuICAgIHRpdGxlOiAnVGhlIHNob3J0Y3V0IGlzIHRvbGQgYXBhcnQgZnJvbSB0aGUgc2FuY3Rpb25lZCBwYXRoJyxcbiAgICBib2R5OlxuICAgICAgJ01vc3QgZ3VhcmRyYWlscyBmYWlsIGxvdWQuIFRoZSBsYXllciBydWxlcyBhcmUgdGhlIG9uZXMgdGhhdCBmYWlsIDxlbT5zaWxlbnRseTwvZW0+IFx1MjAxNCBhICcgK1xuICAgICAgXCJyYXcgPGNvZGU+U0VMRUNUPC9jb2RlPiBhZ2FpbnN0IGFuIGVuZ2luZSdzIHByaXZhdGUgdGFibGUgcmV0dXJucyB0aGUgcmlnaHQgcm93cywgdGhlIHRlc3QgXCIgK1xuICAgICAgJ3Bhc3NlcywgYW5kIG5vdGhpbmcgdGVsbHMgeW91IHRoYXQgZW5naW5lIGNhbiBub3cgbmV2ZXIgc2hpcCBhIG1pZ3JhdGlvbi4gJyArXG4gICAgICAnPGNvZGU+Ym91bmRhcnktbGludDwvY29kZT4gaXMgdGhlIG9ubHkgdGhpbmcgdGhhdCBjYW4gc2VlIGl0LicsXG4gICAgc3RvcHM6ICdSYXcgREIgYWNjZXNzLCBjcm9zcy1tb2R1bGUgcmVhZHMsIGZvcmdlZCBhdWRpdCByb3dzLCBhbWJpZW50IHNlY3JldHMuJyxcbiAgfSxcbiAge1xuICAgIHdoZW46ICdEZXJpdmUnLFxuICAgIHRpdGxlOiAnV2hhdCBjYW4gYmUgZGVyaXZlZCBpcyBuZXZlciBnZW5lcmF0ZWQnLFxuICAgIGJvZHk6XG4gICAgICAnV2hlcmV2ZXIgYW4gYXJ0aWZhY3QgY2FuIGJlIDxlbT5kZXJpdmVkPC9lbT4sIGl0IGlzIGRlcml2ZWQgYnkgY29kZSwgbm90IGJ5IGEgbW9kZWwuICcgK1xuICAgICAgJ0VudGl0aWVzIGFyZSBkZWNsYXJlZCBvbmNlOyB0aGUgRERMLCB0aGUgQVBJIHN1cmZhY2UsIHRoZSBicm93c2VyIGNsaWVudCBhbmQgdGhlICcgK1xuICAgICAgJ3Blcm1pc3Npb24gdGFibGUgYXJlIGVtaXR0ZWQgZnJvbSB0aGF0IGRlY2xhcmF0aW9uLCBhbmQgQ0kgcmUtZW1pdHMgZWFjaCBhbmQgZmFpbHMgJyArXG4gICAgICAnb24gZHJpZnQuIENvZGUgZ2VuZXJhdGVkIGJ5IGNvZGUgYmVhdHMgY29kZSBnZW5lcmF0ZWQgYnkgYSBtb2RlbCBvbiB0b2tlbnMsIGxhdGVuY3kgJyArXG4gICAgICAnYW5kIGV4YWN0bmVzcyBhdCBvbmNlLicsXG4gICAgc3RvcHM6ICdIYW5kLWVkaXRzIHRvIHNoaXBwZWQgU1FMLCBkcmlmdGVkIGNsaWVudHMsIGEgd2lkZW5lZCByb2xlIG1lcmdpbmcgdW5zZWVuLicsXG4gIH0sXG4gIHtcbiAgICB3aGVuOiAnSnVkZ2UnLFxuICAgIHRpdGxlOiAnVGhlIGJ1aWxkIG1heSBub3QgZWRpdCBpdHMgb3duIG9yYWNsZScsXG4gICAgYm9keTpcbiAgICAgICdNb2RlbHMgZmFpbCBxdWlldGx5IGFuZCBpbmNvbnNpc3RlbnRseSByYXRoZXIgdGhhbiBsb3VkbHksIGFuZCB5b3UgY2Fubm90IHByb21wdCB0aGF0ICcgK1xuICAgICAgJ2F3YXkgXHUyMDE0IHNvIHRoZSBhcmNoaXRlY3R1cmUgaGFzIHRvIGNhdGNoIGl0LiBFdmVyeSBkZWZlY3Qgd29ydGggY2F0Y2hpbmcgaXMgdHdvICcgK1xuICAgICAgJ2Rlc2NyaXB0aW9ucyBkaXNhZ3JlZWluZy4gT25jZSB0aGUgY29kZSBpcyBkZXJpdmVkIGZyb20gdGhlIG1vZGVsIGl0IGNhbiBubyBsb25nZXIgJyArXG4gICAgICAnY29udHJhZGljdCBpdCwgc28gdGhlIHNlY29uZCBkZXNjcmlwdGlvbiBoYXMgdG8gY29tZSBmcm9tIHNvbWV3aGVyZSBlbHNlIGVudGlyZWx5LicsXG4gICAgc3RvcHM6ICdBIHN1aXRlIHRoYXQgcmF0aWZpZXMgYSB3cm9uZyBtb2RlbCBwZXJmZWN0bHkgYW5kIGZvcmV2ZXIuJyxcbiAgfSxcbiAge1xuICAgIHdoZW46ICdSZXZpZXcnLFxuICAgIHRpdGxlOiAnVHdvIHRoaW5ncyBhbiBhZ2VudCBuZXZlciBzZWxmLWFwcHJvdmVzJyxcbiAgICBib2R5OlxuICAgICAgJ1NjaGVtYSBtaWdyYXRpb25zIGFuZCBwZXJtaXNzaW9uIGRlZmluaXRpb25zIHN0YXkgdW5kZXIgaHVtYW4gcmV2aWV3IGV2ZW4gaW4gYSBmdWxseSAnICtcbiAgICAgICdhZ2VudC1kcml2ZW4gc2hvcC4gQm90aCBhcmUgcmVhZCBhcyBhIGRpZmYsIGFuZCBDSSByZS1lbWl0cyB0aGUgYXJ0aWZhY3QgYW5kIGZhaWxzIG9uICcgK1xuICAgICAgJ2RyaWZ0IFx1MjAxNCB3aGljaCBpcyB3aGF0IG1ha2VzIHRoZSByZWFkaW5nIHVuc2tpcHBhYmxlLiBUaGUgcmVkIGJ1aWxkIGlzIG5vdCB0aGUgJyArXG4gICAgICAnYXBwcm92YWw7IGl0IGlzIHdoYXQgc3RvcHMgdGhlIGFwcHJvdmFsIGJlaW5nIHNraXBwZWQuJyxcbiAgICBzdG9wczogJ0EgZGVzdHJ1Y3RpdmUgbWlncmF0aW9uIG9yIGEgcXVpZXRseSB3aWRlbmVkIHJvbGUgcmVhY2hpbmcgbWFpbi4nLFxuICB9LFxuICB7XG4gICAgd2hlbjogJ1JlaGVhcnNlJyxcbiAgICB0aXRsZTogJ0EgcnVubmluZyBjb3B5IG9mIHByb2R1Y3Rpb24gdG8gYmUgd3JvbmcgaW4nLFxuICAgIGJvZHk6XG4gICAgICAnUmV2aWV3aW5nIGEgbWlncmF0aW9uIGRpZmYgaXMgYSBjaGVja3BvaW50LiBXYXRjaGluZyB0aGF0IG1pZ3JhdGlvbiBydW4gYWdhaW5zdCBhIGNvcHkgJyArXG4gICAgICAnb2YgdGhlIHJlYWwgZGF0YSBpcyB3aGF0IG1ha2VzIHRoZSBjaGVja3BvaW50IGhvbmVzdC4gQ3Jvc3NpbmcgYSBtaWdyYXRpb24tZGlnZXN0ICcgK1xuICAgICAgJ2JvdW5kYXJ5IHNuYXBzaG90cyB0aGUgcHJpb3Igc3RhdGUgZmlyc3QgXHUyMDE0IHRoZSBkaWdlc3QgY29tcGFyaXNvbiBpcyB0aGUgZ2F0ZSwgbm90IGEgJyArXG4gICAgICAnZmxhZyBzb21lb25lIHJlbWVtYmVycyB0byBwYXNzLicsXG4gICAgc3RvcHM6IFwiVmVyc2lvbiAyIGxhbmRpbmcgb24gdmVyc2lvbiAxJ3MgbGl2ZSBkYXRhLlwiLFxuICB9LFxuXTtcblxuLyoqIFRoZSBoZWFkaW5nIHRoZSBmaWd1cmUgY2Fycmllcywga2VwdCBiZXNpZGUgdGhlIGRhdGEgaXQgZGVzY3JpYmVzLiAqL1xuZXhwb3J0IGNvbnN0IGhlYWQgPSB7XG4gIGxhYmVsOiAndGhlIHBhdGgnLFxuICBsZWRlOiAnU2l4IGd1YXJkcywgaW4gdGhlIG9yZGVyIHRoZXkgZmlyZS4nLFxufTtcblxuLyoqXG4gKiBNYXJrdXAgdGhlIGZpZ3VyZSB3YW50cywgcmVuZGVyZWQgYXMgdGhlIG1hcmtkb3duIHRoZSB0d2luIHdhbnRzLlxuICpcbiAqIE1hcHBlZCByYXRoZXIgdGhhbiBzdHJpcHBlZCAodGhlIHNpYmxpbmcgTGF5ZXJTdGFjayBzdHJpcHMsIHdoaWNoIGlzIGZpbmUgZm9yXG4gKiBwcm9zZSB0aGF0IGNhcnJpZXMgbm8gY29kZSk6IGBTY29wZUlkYCBhbmQgYGN0eC5zcWxgIGFyZSB0aGUgc3Vic3RhbmNlIG9mIHRoZXNlXG4gKiBzZW50ZW5jZXMsIGFuZCBhIHR3aW4gdGhhdCBmbGF0dGVucyB0aGVtIHRvIGJhcmUgd29yZHMgcmVhZHMgYXMgaWYgdGhlIHJ1bGUgd2VyZVxuICogYWJvdXQgdGhlIEVuZ2xpc2ggd29yZCByYXRoZXIgdGhhbiB0aGUgc3ltYm9sLlxuICovXG5jb25zdCBwbGFpbiA9IChodG1sOiBzdHJpbmcpID0+XG4gIGh0bWxcbiAgICAucmVwbGFjZSgvPGNvZGU+KFtePF0qKTxcXC9jb2RlPi9nLCAnYCQxYCcpXG4gICAgLnJlcGxhY2UoLzxlbT4oW148XSopPFxcL2VtPi9nLCAnKiQxKicpXG4gICAgLnJlcGxhY2UoLzwoPzpifHN0cm9uZyk+KFtePF0qKTxcXC8oPzpifHN0cm9uZyk+L2csICcqKiQxKionKVxuICAgIC5yZXBsYWNlKC9cXHMrL2csICcgJylcbiAgICAudHJpbSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gYWx0KCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgYCoqRGlhZ3JhbSBcdTIwMTQgJHtoZWFkLmxhYmVsfS4qKiAke2hlYWQubGVkZX0gRWFjaCBzdGFnZSBjYW4gc3RvcCBhIGNoYW5nZSwgYW5kIHRoZSBgICtcbiAgICAgICdjbGFpbSBpcyB0aGF0IGEgbWlzdGFrZSBzdXJ2aXZpbmcgb25lIG1lZXRzIHRoZSBuZXh0LicsXG4gICAgJycsXG4gICAgLi4uZ3VhcmRzLm1hcChcbiAgICAgIChnLCBpKSA9PlxuICAgICAgICBgJHtpICsgMX0uICoqJHtnLndoZW59IFx1MjAxNCAke2cudGl0bGV9LioqICR7cGxhaW4oZy5ib2R5KX1cXG5gICtcbiAgICAgICAgYCAgIC0gKlN0b3BzOiogJHtnLnN0b3BzfWAsXG4gICAgKSxcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9TaWdudXBGb3JtLmNvbnRlbnQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvU2lnbnVwRm9ybS5jb250ZW50Lm10c1wiOy8qKlxuICogVGhlIG1hcmtkb3duIHR3aW4gb2YgdGhlIHNpZ251cCBmb3JtLlxuICpcbiAqIEEgZm9ybSBjYW5ub3QgYmUgZmxhdHRlbmVkIGludG8gcHJvc2UgdGhhdCB3b3JrcyBcdTIwMTQgdGhlcmUgaXMgbm90aGluZyBmb3IgYSByZWFkZXIgb2ZcbiAqIHRoZSB0d2luIHRvIHN1Ym1pdCBcdTIwMTQgc28gd2hhdCB0aGUgdHdpbiBoYXMgdG8gY2FycnkgaXMgdGhlIEZBQ1QgdGhlIGZvcm0gZW5jb2RlczpcbiAqIHdoaWNoIGxpc3QgdGhpcyBpcywgdGhhdCBqb2luaW5nIGlzIGRvdWJsZSBvcHQtaW4sIGFuZCB3aGF0IHRoZSBhZGRyZXNzIGlzIHVzZWQgZm9yLlxuICogQW4gYWdlbnQgc3VtbWFyaXNpbmcgdGhpcyBwYWdlIGZvciBzb21lYm9keSBzaG91bGQgYmUgYWJsZSB0byB0ZWxsIHRoZW0gaG93IHRvIHNpZ25cbiAqIHVwIGFuZCB3aGF0IHdpbGwgaGFwcGVuIHdoZW4gdGhleSBkbywgYW5kIGEgcG9pbnRlciBhdCB0aGUgSFRNTCBwYWdlIHNheWluZyBcImZvcm1cIlxuICogc2F5cyBub25lIG9mIHRoYXQuXG4gKlxuICogUmVuZGVyZWQgZnJvbSB0aGUgc2FtZSB0d28gcHJvcHMgdGhlIGNvbXBvbmVudCByZWFkcywgc28gdGhlIHR3aW4gYW5kIHRoZSBmb3JtXG4gKiBjYW5ub3QgZGlzYWdyZWUgYWJvdXQgd2hpY2ggbGlzdCBpcyBvbiB0aGUgcGFnZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFsdChwcm9wczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHN0cmluZyB7XG4gIGNvbnN0IHdhaXRsaXN0ID0gKHByb3BzLmtpbmQgPz8gJ3dhaXRsaXN0JykgPT09ICd3YWl0bGlzdCc7XG4gIGNvbnN0IHdoYXQgPSB3YWl0bGlzdFxuICAgID8gJ2EgcGxhY2Ugb24gdGhlIHdhaXRpbmcgbGlzdCBmb3IgdGhlIFN1YnN0cmF0IHByaXZhdGUgYmV0YSdcbiAgICA6ICd0aGUgd2Vla2x5IGNoYW5nZWxvZyBieSBlbWFpbCc7XG4gIHJldHVybiAoXG4gICAgYCooT24gdGhlIHdlYiBwYWdlLCBhIGZvcm0gaGVyZSBhc2tzIGZvciBhbiBlbWFpbCBhZGRyZXNzIFx1MjAxNCBhbmQsIGZvciB0aGUgd2FpdGluZyBgICtcbiAgICBgbGlzdCwgYW4gb3B0aW9uYWwgbm90ZSBhYm91dCB3aGF0IHlvdSB3b3VsZCBidWlsZCBcdTIwMTQgdG8gcmVxdWVzdCAke3doYXR9LiBgICtcbiAgICBgU2lnbmluZyB1cCBpcyBkb3VibGUgb3B0LWluOiBzdWJtaXR0aW5nIHNlbmRzIG9uZSBjb25maXJtYXRpb24gZW1haWwgYW5kIG5vdGhpbmcgYCArXG4gICAgYGlzIGFkZGVkIHRvIGFueSBsaXN0IHVudGlsIHRoZSBsaW5rIGluIGl0IGlzIGNsaWNrZWQuIEV2ZXJ5IG1lc3NhZ2UgYWZ0ZXIgdGhhdCBgICtcbiAgICBgY2FycmllcyBhbiB1bnN1YnNjcmliZSBsaW5rIFx1MjAxNCB0aG91Z2ggdGhlIGZpcnN0IGlzc3VlIG9mIHRoZSBjaGFuZ2Vsb2cgZW1haWwgaGFzIGAgK1xuICAgIGBub3QgYmVlbiBzZW50IHlldCwgc28gY29uZmlybWluZyBwdXRzIHlvdSBvbiB0aGUgbGlzdCByYXRoZXIgdGhhbiBzdGFydGluZyBhIGAgK1xuICAgIGBkZWxpdmVyeS4gVGhlIGZvcm0gcG9zdHMgdG8gU3Vic3RyYXQncyBvd24gdGlja2V0MCBzdXBwb3J0IGAgK1xuICAgIGBkZXNrIGF0ICR7cHJvcHMuZGVzayA/PyAnaHR0cHM6Ly90aWNrZXQwLnN1YnN0cmF0Lm5ldCd9LCB3aGljaCBvbmx5IGFjY2VwdHMgYCArXG4gICAgYHNpZ251cHMgZnJvbSBwYWdlcyBpdCBsaXN0cyBhcyBhbGxvd2VkIG9yaWdpbnMuKSpgXG4gICk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvQ29tbXVuaWNhdGlvbkZsb3cuY29udGVudC5tdHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9Db21tdW5pY2F0aW9uRmxvdy5jb250ZW50Lm10c1wiOy8qKiBTaGFyZWQgZmFjdHMgZm9yIHRoZSBkb2NzJyBTVkcgZmlndXJlcyBhbmQgdGhlaXIgcGxhaW4tdGV4dCBlZGl0aW9ucy4gKi9cbmludGVyZmFjZSBTdGVwIHtcbiAgb3duZXI6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgbGluZXM6IHN0cmluZ1tdO1xuICBsYXllcjogJ3ZlcnRpY2FsJyB8ICdrZXJuZWwnIHwgJ2VuZ2luZSc7XG59XG5pbnRlcmZhY2UgRmxvdyB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGFyaWE6IHN0cmluZztcbiAgc3RlcHM6IFN0ZXBbXTtcbiAgZWRnZXM6IHN0cmluZ1tdO1xuICBjYXB0aW9uOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBmbG93czogUmVjb3JkPHN0cmluZywgRmxvdz4gPSB7XG4gIGxpdmU6IHtcbiAgICB0aXRsZTogJ09uZSBjaGFuZ2UgXHUwMEI3IGEgY2hlY2tlZCByZS1yZWFkJyxcbiAgICBhcmlhOiAnQW4gb3BlcmF0aW9uIGNvbW1pdHMgYSBjaGFuZ2UgaW4gdGhlIHNjb3BlLiBUaGUgbGl2ZSBmZWVkIGNoZWNrcyB0aGUgc3Vic2NyaWJlciBhbmQgc2VuZHMgYSBjaGFuZ2UgaGludCwgd2l0aG91dCB0aGUgcm93IGNvbnRlbnQuIFRoZSBicm93c2VyIGNhbGxzIGl0cyBvcmRpbmFyeSByZWFkIG9wZXJhdGlvbiBhZ2Fpbiwgd2hpY2ggY2hlY2tzIGN1cnJlbnQgcGVybWlzc2lvbnMgYmVmb3JlIHJldHVybmluZyBkYXRhLiBQb2xsaW5nIHJlbWFpbnMgdGhlIGZhbGxiYWNrLicsXG4gICAgc3RlcHM6IFtcbiAgICAgIHsgb3duZXI6ICdTQ09QRSBcdTAwQjcgQ09NTUlUVEVEIFdSSVRFJywgdGl0bGU6ICdBIHJlY29yZCBjaGFuZ2VzJywgbGF5ZXI6ICd2ZXJ0aWNhbCcsXG4gICAgICAgIGxpbmVzOiBbJ1RoZSBvcGVyYXRpb24gd3JpdGVzIGFuZCBlbWl0cy4nLCAnQSBsaXZlIHRhcmdldCBkZWNsYXJlcyB0aGUgcmVhZCBrZXkuJ10gfSxcbiAgICAgIHsgb3duZXI6ICdIT1NUIFx1MDBCNyBMSVZFIEZFRUQnLCB0aXRsZTogJ0NoZWNrLCB0aGVuIHNlbmQgYSBoaW50JywgbGF5ZXI6ICdrZXJuZWwnLFxuICAgICAgICBsaW5lczogWydDaGVjayBhY2Nlc3MgYmVmb3JlIHNlbmRpbmcgYSBmcmFtZS4nLCAnVGhlIGZyYW1lIGNhcnJpZXMgbm8gcm93IGNvbnRlbnQuJ10gfSxcbiAgICAgIHsgb3duZXI6ICdCUk9XU0VSIFx1MDBCNyBPUkRJTkFSWSBSRUFEJywgdGl0bGU6ICdBc2sgZm9yIHRoZSBjdXJyZW50IGRhdGEnLCBsYXllcjogJ3ZlcnRpY2FsJyxcbiAgICAgICAgbGluZXM6IFsnUmUtcmVhZCB0aHJvdWdoIHRoZSB1c3VhbCBvcGVyYXRpb24uJywgJ0N1cnJlbnQgcGVybWlzc2lvbnMgZGVjaWRlIHRoZSBhbnN3ZXIuJ10gfSxcbiAgICBdLFxuICAgIGVkZ2VzOiBbJ2NvbW1pdHRlZCBhY3Rpdml0eSB3YWtlcyB0aGUgZmVlZCcsICdhIGhpbnQgYXNrcyB0aGUgc2NyZWVuIHRvIHJlZnJlc2gnXSxcbiAgICBjYXB0aW9uOiAnUHVzaCByZWR1Y2VzIHRoZSB3YWl0OyBwb2xsaW5nIHJlbWFpbnMgdGhlIHJlY292ZXJ5IHBhdGguIEEgZnJhbWUgY2FuIGJlIG9uZSBwZXJtaXNzaW9uIGV2YWx1YXRpb24gc3RhbGUuIFRoZSByZWFkIGl0IHRyaWdnZXJzIGNoZWNrcyBhY2Nlc3MgYWdhaW4uIFRoaXMgaXMgaW52YWxpZGF0aW9uLCBub3Qgb2ZmbGluZSBzeW5jIG9yIHByZXNlbmNlLicsXG4gIH0sXG4gIHBlZXI6IHtcbiAgICB0aXRsZTogJ09uZSBwZWVyIGNhbGwgXHUwMEI3IG9uZSB0ZW5hbnQnLFxuICAgIGFyaWE6ICdUaGUgYm9hcmQtcm9vbSBob3N0IGRlY2xhcmVzIGl0IGNhbGxzIHRoZSBDUk0uIFRoZSBwbGF0Zm9ybSBwcm92ZXMgdGhlIGNhbGxpbmcgYXBwIGFuZCByZXNvbHZlcyB0aGUgdGFyZ2V0IGluIHRoZSBzYW1lIHRlbmFudC4gVGhlIENSTSBhZG1pdHMgdGhlIHBlZXIsIGNoZWNrcyBpdHMgcGVybWlzc2lvbnMgYW5kIHJ1bnMgaXRzIG93biB0cmFuc2FjdGlvbi4gVGhlIHJlc3VsdCByZXR1cm5zIHRvIHRoZSBjYWxsaW5nIGhvc3QuJyxcbiAgICBzdGVwczogW1xuICAgICAgeyBvd25lcjogJ0NBTExFUiBcdTAwQjcgQk9BUkQtUk9PTSBIT1NUJywgdGl0bGU6ICdBc2sgZm9yIGN1cnJlbnQgY3VzdG9tZXIgZGV0YWlscycsIGxheWVyOiAndmVydGljYWwnLFxuICAgICAgICBsaW5lczogWydEZWNsYXJlczogY2FsbHMgYWNtZS9jcm0nLCAnSW52b2tlczogY3VzdG9tZXIvZ2V0J10gfSxcbiAgICAgIHsgb3duZXI6ICdQTEFURk9STSBcdTAwQjcgSURFTlRJVFkgQU5EIFJPVVRJTkcnLCB0aXRsZTogJ1Byb3ZlIHdobyBjYWxsczsgZmluZCB0aGUgdGFyZ2V0JywgbGF5ZXI6ICdrZXJuZWwnLFxuICAgICAgICBsaW5lczogWydDYWxsZXIgaWRlbnRpdHkgY29tZXMgZnJvbSB0aGUgZGlzcGF0Y2guJywgJ1RhcmdldCBpcyBpbiB0aGUgc2FtZSB0ZW5hbnQuJ10gfSxcbiAgICAgIHsgb3duZXI6ICdUQVJHRVQgXHUwMEI3IENSTSBTQ09QRScsIHRpdGxlOiAnQWRtaXQsIGNoZWNrLCB0aGVuIHJ1bicsIGxheWVyOiAndmVydGljYWwnLFxuICAgICAgICBsaW5lczogWydDUk0gZGVjbGFyZXMgdGhlIHBlZXIgYW5kIGl0cyBvcGVyYXRpb25zLicsICdJdHMgY2hlY2tzIGFuZCB0cmFuc2FjdGlvbiBydW4gaGVyZS4nXSB9LFxuICAgIF0sXG4gICAgZWRnZXM6IFsncGxhdGZvcm0tYXNzZXJ0ZWQgYXBwIGlkZW50aXR5JywgJ3JlcXVlc3QgZW50ZXJzIHRocm91Z2ggdGhlIHBlZXIgZG9vciddLFxuICAgIGNhcHRpb246ICdUaGUgcmVzdWx0IHJldHVybnMgdG8gdGhlIGhvc3QuIEVhY2ggc2NvcGUga2VlcHMgaXRzIG93biB0cmFuc2FjdGlvbi4gTW9kdWxlIGNvZGUgcXVldWVzIGEgcGxhdGZvcm0gaW50ZW50IGluc3RlYWQgb2YgbWFraW5nIHRoaXMgc3luY2hyb25vdXMgY2FsbC4nLFxuICB9LFxuICBldmVudHM6IHtcbiAgICB0aXRsZTogJ09uZSBleHBvcnRlZCBmYWN0IFx1MDBCNyB0d28gY29tbWl0cycsXG4gICAgYXJpYTogJ1RoZSBDUk0gY29tbWl0cyBpdHMgcm93IGFuZCBldmVudCB0b2dldGhlci4gVGhlIHBsYXRmb3JtIHJlYWRzIGFsbG93ZWQgZXhwb3J0cyBhZnRlciB0aGUgYm9hcmQtcm9vbVx1MjAxOXMgc2F2ZWQgd2F0ZXJtYXJrLiBUaGUgYm9hcmQtcm9vbSBjb21taXRzIGVhY2ggaGFuZGxlclx1MjAxOXMgd3JpdGVzIHdpdGggaXRzIGRlbGl2ZXJ5IHJlY29yZCwgdGhlbiBhZHZhbmNlcyBpdHMgd2F0ZXJtYXJrLiBBIHBhdXNlZCBlZGdlIGhvbGRzIHRoZSB3YXRlcm1hcmsuJyxcbiAgICBzdGVwczogW1xuICAgICAgeyBvd25lcjogJ1BST0RVQ0VSIFx1MDBCNyBDUk0gREFUQUJBU0UnLCB0aXRsZTogJ0NvbW1pdCB0aGUgZmFjdCcsIGxheWVyOiAndmVydGljYWwnLFxuICAgICAgICBsaW5lczogWydDdXN0b21lciByb3cgKyBldmVudCBjb21taXQgdG9nZXRoZXIuJywgJ1RoZSBldmVudCBzdGF5cyBpbiB0aGUgQ1JNIG91dGJveC4nXSB9LFxuICAgICAgeyBvd25lcjogJ1BMQVRGT1JNIFx1MDBCNyBQVUxMIEFORCBERUxJVkVSJywgdGl0bGU6ICdSZWFkIGFmdGVyIHRoZSBzYXZlZCB3YXRlcm1hcmsnLCBsYXllcjogJ2tlcm5lbCcsXG4gICAgICAgIGxpbmVzOiBbJ0V4cG9ydCBcdTIyMjkgaW1wb3J0LCB3aXRoIGNoZWNrcyBvbiBib3RoIHNpZGVzLicsICdPbmx5IHRoZSBhZ3JlZWQgdmVyc2lvbiBhbmQgUElJIGNsYXNzIG5vbmUuJ10gfSxcbiAgICAgIHsgb3duZXI6ICdDT05TVU1FUiBcdTAwQjcgQk9BUkQtUk9PTSBEQVRBQkFTRScsIHRpdGxlOiAnQXBwbHksIHJlY29yZCwgdGhlbiBhZHZhbmNlJywgbGF5ZXI6ICd2ZXJ0aWNhbCcsXG4gICAgICAgIGxpbmVzOiBbJ0hhbmRsZXIgd3JpdGVzICsgZGVsaXZlcnkgcm93IGNvbW1pdCB0b2dldGhlci4nLCAnV2F0ZXJtYXJrIGFkdmFuY2VzIGFmdGVyIHRoZSBiYXRjaC4nXSB9LFxuICAgIF0sXG4gICAgZWRnZXM6IFsna2ljayBmb3Igc3BlZWQgXHUwMEI3IHN3ZWVwIGFzIGJhY2tzdG9wJywgJ3NlcGFyYXRlIHRyYW5zYWN0aW9uIGluIHRoZSByZWNlaXZlciddLFxuICAgIGNhcHRpb246ICdUaGUgY29uc3VtZXIgb3ducyB0aGUgYm9va21hcmsuIFBhdXNlIGhvbGRzIGl0LiBSZXN0b3JlIHJld2luZHMgaXQgd2l0aCB0aGUgZGF0YS4gT3JkaW5hcnkgcmVkZWxpdmVyeSBza2lwcyByZWNvcmRlZCBkZWxpdmVyaWVzOyBleHBsaWNpdCByZXBsYXkgcnVucyBoYW5kbGVycyBhZ2Fpbi4nLFxuICB9LFxuICBub3RpZmljYXRpb25zOiB7XG4gICAgdGl0bGU6ICdPbmUgbm90aWZpY2F0aW9uIFx1MDBCNyB0aHJlZSByZXNwb25zaWJpbGl0aWVzJyxcbiAgICBhcmlhOiAnVGhlIHZlcnRpY2FsIG5hbWVzIHRoZSBvY2Nhc2lvbiBhbmQgcmVjaXBpZW50cy4gVGhlIG5vdGlmaWNhdGlvbnMgZW5naW5lIGFwcGxpZXMgcHJlZmVyZW5jZXMgYW5kIHJlY29yZHMgdGhlIGRlbGl2ZXJ5IHdpdGggYW4gZW1haWwgaW50ZW50IGluIHRoZSBzYW1lIHRyYW5zYWN0aW9uLiBBZnRlciBjb21taXQgdGhlIHBsYXRmb3JtIHNlbmRzIG1haWwgYW5kIGVtaXRzIGFuIG91dGNvbWUgdGhhdCBzZXR0bGVzIHRoZSBkZWxpdmVyeS4nLFxuICAgIHN0ZXBzOiBbXG4gICAgICB7IG93bmVyOiAnVkVSVElDQUwgXHUwMEI3IEJVU0lORVNTIE1FQU5JTkcnLCB0aXRsZTogJ0EgcmVwYWlyIHdhcyBhc3NpZ25lZCcsIGxheWVyOiAndmVydGljYWwnLFxuICAgICAgICBsaW5lczogWydDaG9vc2UgdG9waWMsIHJlY2lwaWVudHMgYW5kIHdvcmRpbmcuJywgJ1VzZSB0aGUgZXZlbnQgaWQgYXMgdGhlIG9jY2FzaW9uXHUyMDE5cyBrZXkuJ10gfSxcbiAgICAgIHsgb3duZXI6ICdFTkdJTkUgXHUwMEI3IElOIFRIRSBTQU1FIFRSQU5TQUNUSU9OJywgdGl0bGU6ICdEZWNpZGUgYW5kIHJlY29yZCB0aGUgbm90aWZpY2F0aW9uJywgbGF5ZXI6ICdlbmdpbmUnLFxuICAgICAgICBsaW5lczogWydBcHBseSBwcmVmZXJlbmNlczsgcmVuZGVyIHRoZSB0ZW1wbGF0ZS4nLCAnRGVsaXZlcnkgcm93ICsgZW1haWwgaW50ZW50IGNvbW1pdCB0b2dldGhlci4nXSB9LFxuICAgICAgeyBvd25lcjogJ1BMQVRGT1JNIFx1MDBCNyBBRlRFUiBDT01NSVQnLCB0aXRsZTogJ1NlbmQsIHRoZW4gcmVwb3J0IHRoZSBvdXRjb21lJywgbGF5ZXI6ICdrZXJuZWwnLFxuICAgICAgICBsaW5lczogWydTZW5kIHRocm91Z2ggdGhlIGNvbmZpZ3VyZWQgbWFpbCBwcm92aWRlci4nLCAnU2VudCwgcmVmdXNlZCBvciBkZWFkLWxldHRlcmVkIHNldHRsZXMgdGhlIHJvdy4nXSB9LFxuICAgIF0sXG4gICAgZWRnZXM6IFsnbm90aWZ5KGN0eCwgXHUyMDI2KScsICdjb21taXQgZW5kcyB0aGUgc2NvcGUgdHJhbnNhY3Rpb24nXSxcbiAgICBjYXB0aW9uOiAnQSByb2xsYmFjayBsZWF2ZXMgbm8gc2VuZC4gQSBjb21taXR0ZWQgaW50ZW50IHN1cnZpdmVzIGEgY3Jhc2guIFRoZSBkZWxpdmVyeSByb3cgaXMgZGVkdXBsaWNhdGVkLCBidXQgYSBwcm92aWRlciBzZW5kIGNhbiByZXBlYXQgaWYgaXRzIG91dGNvbWUgd2FzIGxvc3QuJyxcbiAgfSxcbiAgYXNzaXN0YW50OiB7XG4gICAgdGl0bGU6ICdPbmUgYXNzaXN0YW50IHR1cm4gXHUwMEI3IGFuIGFwcHJvdmVkIGNoYW5nZScsXG4gICAgYXJpYTogJ0EgcGVyc29uIHN0YXJ0cyBhIHR1cm4uIFRoZSBob3N0IGFjcXVpcmVzIGEgcnVuIGxlYXNlLCBjYWxscyBhIG1vZGVsIG91dHNpZGUgdGhlIHRyYW5zYWN0aW9uIGFuZCByZWNvcmRzIGV2ZW50cy4gQSBwcm9wb3NlZCBjaGFuZ2Ugd2FpdHMgZm9yIHRoZSBwZXJzb25cdTIwMTlzIGFwcHJvdmFsIG9mIGV4YWN0IGlucHV0LiBUaGUgaG9zdCBtdXN0IGNsYWltIHRoYXQgYXBwcm92ZWQgY2FsbCBiZWZvcmUgZXhlY3V0aW5nIGFuZCByZWNvcmRpbmcgaXRzIHJlc3VsdC4nLFxuICAgIHN0ZXBzOiBbXG4gICAgICB7IG93bmVyOiAnUEVSU09OIFx1MDBCNyBBU1NJU1RBTlQ6VVNFJywgdGl0bGU6ICdTdGFydCBhIHR1cm4nLCBsYXllcjogJ3ZlcnRpY2FsJyxcbiAgICAgICAgbGluZXM6IFsnQXBwZW5kIHRoZSBwZXJzb25cdTIwMTlzIG1lc3NhZ2UuJywgJ1RoZSBlbmdpbmUgb3BlbnMgYSB0dXJuIG9uIHRoZWlyIHRocmVhZC4nXSB9LFxuICAgICAgeyBvd25lcjogJ0hPU1QgXHUwMEI3IEFTU0lTVEFOVDpSVU4nLCB0aXRsZTogJ1Rha2UgdGhlIGxlYXNlIGFuZCBydW4gdGhlIG1vZGVsJywgbGF5ZXI6ICdlbmdpbmUnLFxuICAgICAgICBsaW5lczogWydPbmUgcnVuIG1heSB3cml0ZSBhdCBhIHRpbWUuJywgJ01vZGVsIGNhbGxzIGhhcHBlbiBvdXRzaWRlIHRyYW5zYWN0aW9ucy4nXSB9LFxuICAgICAgeyBvd25lcjogJ1BFUlNPTiBcdTAwQjcgRVhBQ1QgQVBQUk9WQUwnLCB0aXRsZTogJ1JldmlldyB0aGUgcHJvcG9zZWQgY2hhbmdlJywgbGF5ZXI6ICd2ZXJ0aWNhbCcsXG4gICAgICAgIGxpbmVzOiBbJ0RpZ2VzdCBiaW5kcyBpbnB1dCwgb3BlcmF0aW9uIGFuZCB2ZXJzaW9uLicsICdEZW55IG9yIGxldCBpdCBleHBpcmU6IG5vIGV4ZWN1dGlvbiBjbGFpbS4nXSB9LFxuICAgICAgeyBvd25lcjogJ0hPU1QgXHUwMEI3IENIRUNLIEJFRk9SRSBFWEVDVVRJTkcnLCB0aXRsZTogJ0NsYWltIG9uY2UsIGV4ZWN1dGUsIHJlY29yZCcsIGxheWVyOiAnZW5naW5lJyxcbiAgICAgICAgbGluZXM6IFsnQ2hhbmdlZCBpbnB1dCBvciBhIHNlY29uZCBjbGFpbSBpcyByZWZ1c2VkLicsICdUaGUgdGFyZ2V0IHN0aWxsIGNoZWNrcyBpdHMgb3duIHBlcm1pc3Npb25zLiddIH0sXG4gICAgXSxcbiAgICBlZGdlczogWydzaG9ydCBlbmdpbmUgY2FsbHMgcmVjb3JkIHByb2dyZXNzJywgJ2EgZ2F0ZWQgdG9vbCBjYWxsIHBhdXNlcyBmb3IgYXBwcm92YWwnLCAnb25seSB0aGUgYXBwcm92ZWQgY2FsbCBtYXkgYmUgY2xhaW1lZCddLFxuICAgIGNhcHRpb246ICdUaGUgZW5naW5lIHJlY29yZHMgYW5kIGdhdGVzIHRoZSB0dXJuLiBUaGUgaG9zdCBydW5zIGl0LiBUaGUgZXhlY3V0aW9uIGNsYWltIGNhbm5vdCBtYWtlIGFuIGV4dGVybmFsIGVmZmVjdCBhdG9taWMgd2l0aCB0aGUgY29udmVyc2F0aW9uIHJlY29yZC4gSG9zdCBpbnRlZ3JhdGlvbiBpcyBzdGlsbCB0byBjb21lLicsXG4gIH0sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZmxvd0ZvcihraW5kOiBzdHJpbmcpOiBGbG93IHtcbiAgY29uc3QgZmxvdyA9IGZsb3dzW2tpbmRdO1xuICBpZiAoIWZsb3cpIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBjb21tdW5pY2F0aW9uIGZpZ3VyZTogJHtraW5kfWApO1xuICByZXR1cm4gZmxvdztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFsdChwcm9wczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHN0cmluZyB7XG4gIGNvbnN0IGZsb3cgPSBmbG93Rm9yKHByb3BzLmtpbmQgPz8gJ3BlZXInKTtcbiAgcmV0dXJuIFtcbiAgICBgKipEaWFncmFtIFx1MjAxNCAke2Zsb3cudGl0bGV9LioqYCwgJycsXG4gICAgLi4uZmxvdy5zdGVwcy5mbGF0TWFwKChzdGVwLCBpKSA9PiBbXG4gICAgICBgJHtpICsgMX0uICoqJHtzdGVwLnRpdGxlfSoqICgke3N0ZXAub3duZXJ9KS4gJHtzdGVwLmxpbmVzLmpvaW4oJyAnKX1gLFxuICAgICAgLi4uKGZsb3cuZWRnZXNbaV0gPyBbYCAgIFRoZW46ICR7Zmxvdy5lZGdlc1tpXX0uYF0gOiBbXSksXG4gICAgXSksXG4gICAgJycsIGZsb3cuY2FwdGlvbixcbiAgXS5qb2luKCdcXG4nKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy9hbHQubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMvYWx0Lm10c1wiOy8qKlxuICogVGhlIG1hcmtkb3duIHR3aW4gb2YgZXZlcnkgdGhlbWUgY29tcG9uZW50IHRoYXQgY2FycmllcyBmYWN0cy5cbiAqXG4gKiBgdG9Ud2luYCB1c2VkIHRvIGZsYXR0ZW4gYDxMYXllclN0YWNrIC8+YCB0byBhIHBvaW50ZXIgYXQgdGhlIEhUTUwgcGFnZSwgb24gdGhlXG4gKiBncm91bmRzIHRoYXQgYSBkaWFncmFtIGNhbm5vdCBiZSBmbGF0dGVuZWQgaG9uZXN0bHkuIFRoYXQgaXMgdHJ1ZSBvZiBhIGRyYXdpbmdcbiAqIGFuZCBmYWxzZSBvZiB0aGVzZTogYm90aCBjb21wb25lbnRzIHJlbmRlciBvcmRpbmFyeSBwcm9zZSBvdXQgb2Ygb3JkaW5hcnlcbiAqIGFycmF5cywgc28gd2hhdCB0aGUgcG9pbnRlciBkcm9wcGVkIHdhcyBjb250ZW50IHRoYXQgYWxyZWFkeSBleGlzdGVkIFx1MjAxNCBhbmRcbiAqIGRyb3BwZWQgaXQgZnJvbSBsbG1zLnR4dCwgdGhlIHN1cmZhY2UgYWdlbnRzIHJlYWQuXG4gKlxuICogRWFjaCBlbnRyeSByZW5kZXJzIGl0cyBtYXJrZG93biBmcm9tIHRoZSBzYW1lIGRhdGEgaXRzIGNvbXBvbmVudCByZW5kZXJzIGZyb21cbiAqIChzZWUgdGhlIHNpYmxpbmcgYCouY29udGVudC5tdHNgKSwgc28gdGhlIHR3aW4gY2Fubm90IGRyaWZ0IGZyb20gdGhlIHBpY3R1cmUuIEFcbiAqIGNvbXBvbmVudCB3aXRoIG5vIGVudHJ5IGhlcmUgc3RpbGwgZ2V0cyB0aGUgcG9pbnRlciwgd2hpY2ggaXMgdGhlIGhvbmVzdFxuICogYW5zd2VyIGZvciBhIGRyYXdpbmc7IGBsaW50OmxsbXMgLS1jaGVja2AgZmFpbHMgb24gb25lIHRoYXQgaXMgbWVyZWx5XG4gKiBmb3Jnb3R0ZW4gXHUyMDE0IHNlZSBgQUxUX05PVF9ORUVERURgIGluIHRvb2xzL2xsbXMtaW5kZXgubXRzLlxuICovXG5pbXBvcnQgeyBhbHQgYXMgcGVybWlzc2lvblBpcGVsaW5lIH0gZnJvbSAnLi9QZXJtaXNzaW9uUGlwZWxpbmUuY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIHNjb3BlRHJhaW4gfSBmcm9tICcuL1Njb3BlRHJhaW4uY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIGluc3RhbmNlUmVzb2x1dGlvbiB9IGZyb20gJy4vSW5zdGFuY2VSZXNvbHV0aW9uLmNvbnRlbnQubWpzJztcbmltcG9ydCB7IGFsdCBhcyB0ZW5hbmN5VHJlZSB9IGZyb20gJy4vVGVuYW5jeVRyZWUuY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIHJlYWRQYXRocyB9IGZyb20gJy4vUmVhZFBhdGhzLmNvbnRlbnQubWpzJztcbmltcG9ydCB7IGFsdCBhcyBjb25uZWN0b3JMb29wIH0gZnJvbSAnLi9Db25uZWN0b3JMb29wLmNvbnRlbnQubWpzJztcbmltcG9ydCB7IGFsdCBhcyBzdGF0ZU1hY2hpbmUgfSBmcm9tICcuL1N0YXRlTWFjaGluZS5jb250ZW50Lm1qcyc7XG5pbXBvcnQgeyBhbHQgYXMgbGF5ZXJTdGFjayB9IGZyb20gJy4vTGF5ZXJTdGFjay5jb250ZW50Lm1qcyc7XG5pbXBvcnQgeyBhbHQgYXMgcnVudGltZVRvcG9sb2d5IH0gZnJvbSAnLi9SdW50aW1lVG9wb2xvZ3kuY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIHNjb3BlVG9wb2xvZ3kgfSBmcm9tICcuL1Njb3BlVG9wb2xvZ3kuY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIGJsYXN0UmFkaXVzIH0gZnJvbSAnLi9CbGFzdFJhZGl1cy5jb250ZW50Lm1qcyc7XG5pbXBvcnQgeyBhbHQgYXMgZ3VhcmRQYXRoIH0gZnJvbSAnLi9HdWFyZFBhdGguY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIHNpZ251cEZvcm0gfSBmcm9tICcuL1NpZ251cEZvcm0uY29udGVudC5tanMnO1xuaW1wb3J0IHsgYWx0IGFzIGNvbW11bmljYXRpb25GbG93IH0gZnJvbSAnLi9Db21tdW5pY2F0aW9uRmxvdy5jb250ZW50Lm1qcyc7XG5cbmV4cG9ydCBjb25zdCBDT01QT05FTlRfQUxUOiBSZWNvcmQ8c3RyaW5nLCAocHJvcHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pID0+IHN0cmluZz4gPSB7XG4gIENvbm5lY3Rvckxvb3A6IGNvbm5lY3Rvckxvb3AsXG4gIFJlYWRQYXRoczogcmVhZFBhdGhzLFxuICBUZW5hbmN5VHJlZTogdGVuYW5jeVRyZWUsXG4gIEluc3RhbmNlUmVzb2x1dGlvbjogaW5zdGFuY2VSZXNvbHV0aW9uLFxuICBQZXJtaXNzaW9uUGlwZWxpbmU6IHBlcm1pc3Npb25QaXBlbGluZSxcbiAgU2NvcGVEcmFpbjogc2NvcGVEcmFpbixcbiAgTGF5ZXJTdGFjazogbGF5ZXJTdGFjayxcbiAgUnVudGltZVRvcG9sb2d5OiBydW50aW1lVG9wb2xvZ3ksXG4gIFNjb3BlVG9wb2xvZ3k6IHNjb3BlVG9wb2xvZ3ksXG4gIFN0YXRlTWFjaGluZTogc3RhdGVNYWNoaW5lLFxuICBCbGFzdFJhZGl1czogYmxhc3RSYWRpdXMsXG4gIEd1YXJkUGF0aDogZ3VhcmRQYXRoLFxuICBTaWdudXBGb3JtOiBzaWdudXBGb3JtLFxuICBDb21tdW5pY2F0aW9uRmxvdzogY29tbXVuaWNhdGlvbkZsb3csXG59O1xuXG4vKiogVGhlIHR3aW4gZm9yIGA8TmFtZSBcdTIwMjYgLz5gLCBvciBudWxsIHdoZW4gdGhlIGNvbXBvbmVudCBoYXMgbm8gZmxhdHRlbmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbHRGb3IoXG4gIGNvbXBvbmVudDogc3RyaW5nLFxuICBwcm9wczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBDT01QT05FTlRfQUxUW2NvbXBvbmVudF0/Lihwcm9wcykgPz8gbnVsbDtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3NcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2Jvb2subXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2Jvb2subXRzXCI7LyoqXG4gKiBUaGUgc2luZ2xlLWZpbGUgZWRpdGlvbnMgb2YgdGhlIGJvb2sgKCMxNDAxKS5cbiAqXG4gKiBUaGUgYm9vayBpcyBvbmUgcGFnZSBwZXIgY2hhcHRlciB3aXRoIHByZXYvbmV4dCwgd2hpY2ggaXMgdGhlIHJpZ2h0IHNoYXBlIGZvclxuICogcmVhZGluZyBpdCBpbiBhIGJyb3dzZXIgYW5kIHRoZSB3cm9uZyBzaGFwZSBmb3IgcHJpbnRpbmcgaXQsIGNvbnZlcnRpbmcgaXQgd2l0aFxuICogYHBhbmRvY2AsIG9yIGhhbmRpbmcgaXQgdG8gYSBtb2RlbCBpbiBvbmUgc2hvdC4gU28gdGhlIGJ1aWxkIGFsc28gZW1pdHMgdGhlIHdob2xlXG4gKiB0aGluZyB0d2ljZSBtb3JlOlxuICpcbiAqICAgLSAqKmAvYm9vay50eHRgKiogXHUyMDE0IGV2ZXJ5IGNoYXB0ZXIgY29uY2F0ZW5hdGVkIGFzIHBsYWluIG1hcmtkb3duLlxuICogICAtICoqYC9ib29rL3JlYWQuaHRtbGAqKiBcdTIwMTQgdGhlIHNhbWUgY29udGVudCBhcyBvbmUgc2Nyb2xsaW5nLCBwcmludGFibGUgcGFnZS5cbiAqXG4gKiBXaHkgdGhpcyByaWRlcyBgYnVpbGRFbmRgIHJhdGhlciB0aGFuIGNoZWNraW5nIGEgY29uY2F0ZW5hdGVkIGZpbGUgaW50byB0aGUgcmVwbzpcbiAqIGEgY2hlY2tlZC1pbiBjb3B5IHdvdWxkIGJlIGEgc2Vjb25kLCBkcmlmdGluZyB0cmFuc2NyaXB0IG9mIGV2ZXJ5IGNoYXB0ZXIgZmlsZSwgYW5kIHRoZVxuICogcmVwbydzIHJ1bGUgZm9yIGEgZ2VuZXJhdGVkIGZpbGUgaXMgdGhhdCBzb21ldGhpbmcgbXVzdCAqcmVmdXNlKiB3aGVuIGl0IGRyaWZ0cy5cbiAqIEVtaXR0aW5nIGludG8gYG91dERpcmAgcmVtb3ZlcyB0aGUgZHJpZnQgaW5zdGVhZCBvZiBwb2xpY2luZyBpdCBcdTIwMTQgdGhlcmUgaXMgbm9cbiAqIHNlY29uZCBjb3B5IHRvIGZhbGwgYmVoaW5kLiBgcG5wbSBsaW50OmxsbXMgLS1jaGVja2AgY292ZXJzIHRoZSBzYW1lIGdyb3VuZCBmb3JcbiAqIHRoZSBtYXJrZG93biB0d2lucywgYW5kIHRoZSBjaGFwdGVyIGxpc3QgaGFzIGV4YWN0bHkgb25lIGhvbWVcbiAqIChgYm9va0NoYXB0ZXJzKClgIGluIHNpZGViYXIubXRzKSwgcmVhZCBieSB0aGUgbmF2IGFuZCBieSB0aGlzIGZpbGUgYm90aC5cbiAqXG4gKiBUaGUgbWFya2Rvd24gaXMgdGhlIHR3aW4sIG5vdCB0aGUgcmF3IHNvdXJjZTogYHRvVHdpbmAgaXMgd2hhdCBmbGF0dGVucyBhXG4gKiBgPFNjb3BlVG9wb2xvZ3kgLz5gIHRvIHRoZSBwcm9zZSBpdCByZW5kZXJzIGFuZCByZXdyaXRlcyBpbnRlcm5hbCBsaW5rcyB0b1xuICogYWJzb2x1dGUgb25lcy4gQSByZWFkZXIgb2YgYm9vay50eHQgaXMgb2ZmbGluZSwgc28gYSByZWxhdGl2ZSBsaW5rIHdvdWxkIGJlIGRlYWQuXG4gKi9cbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgTWFya2Rvd25JdCBmcm9tICdtYXJrZG93bi1pdCc7XG5pbXBvcnQgeyBib29rQ2hhcHRlcnMsIGZpbGVGb3JMaW5rIH0gZnJvbSAnLi9zaWRlYmFyLm1qcyc7XG5pbXBvcnQgeyBTSVRFLCB0b1R3aW4sIGFsdFR3aW4sIHR5cGUgQXJ0aWZhY3QsIHR5cGUgQ29tcG9uZW50VHdpbiB9IGZyb20gJy4vbGxtcy5tanMnO1xuaW1wb3J0IHsgY29tcG9uZW50T2YsIGZpZ3VyZUNzcywgZmlndXJlS2V5LCB0eXBlIEZpZ3VyZVNldCB9IGZyb20gJy4vZmlndXJlcy5tanMnO1xuXG4vKiogVGhlIGJvb2sncyBvd24gdGl0bGUsIHVzZWQgZm9yIHRoZSBgPHRpdGxlPmAgYW5kIHRoZSBtYXJrZG93biBIMS4gKi9cbmNvbnN0IFRJVExFID0gJ1N1YnN0cmF0LCBlbmQgdG8gZW5kJztcblxuLyoqIFN0cmlwIGEgbGVhZGluZyBgLS0tYCBmcm9udG1hdHRlciBibG9jay4gQ2hhcHRlcnMgY2Fycnkgbm9uZSB0b2RheTsgY2hlYXAgaW5zdXJhbmNlLiAqL1xuY29uc3Qgc3RyaXBGcm9udG1hdHRlciA9IChyYXc6IHN0cmluZyk6IHN0cmluZyA9PlxuICByYXcucmVwbGFjZSgvXi0tLVxccj9cXG5bXFxzXFxTXSo/XFxyP1xcbi0tLVxccj9cXG4/LywgJycpO1xuXG4vKipcbiAqIERyb3AgYSBjaGFwdGVyJ3MgdHJhaWxpbmcgYCoqTmV4dDoqKiBbLi4uXWAgbmF2aWdhdGlvbiBsaW5lLlxuICpcbiAqIEl0IGlzIHJpZ2h0IG9uIGEgd2ViIHBhZ2UgYW5kIHdyb25nIGluIGEgc2luZ2xlIGZpbGUsIHdoZXJlIHRoZSBuZXh0IGNoYXB0ZXIgaXNcbiAqIHRoZSBuZXh0IHRoaW5nIG9uIHRoZSBwYWdlIFx1MjAxNCBhIFwiTmV4dFwiIGxpbmsgdGhlcmUgdGVsbHMgdGhlIHJlYWRlciB0byBqdW1wIHRvXG4gKiB3aGVyZSB0aGV5IGFscmVhZHkgYXJlLlxuICovXG5jb25zdCBzdHJpcE5leHRMaW5rID0gKGJvZHk6IHN0cmluZyk6IHN0cmluZyA9PlxuICBib2R5LnJlcGxhY2UoL1xcbi0tLVxcbitcXHMqKFxcKlxcKk5leHQ6XFwqXFwqfFxcKlRoYXQgaXMgdGhlIGVuZCBvZiB0aGUgYm9va1xcLilbXFxzXFxTXSokLywgJ1xcbicpO1xuXG4vKipcbiAqIFB1c2ggZXZlcnkgaGVhZGluZyBkb3duIG9uZSBsZXZlbCwgc28gdGhlIGNvbmNhdGVuYXRlZCBib29rIGhhcyBPTkUgYGgxYCAoaXRzXG4gKiB0aXRsZSksIGVhY2ggY2hhcHRlciBhcyBhbiBgaDJgLCBhbmQgZWFjaCBjaGFwdGVyJ3Mgc2VjdGlvbnMgYmVsb3cgdGhhdC4gT24gdGhlXG4gKiB3ZWIgZWFjaCBjaGFwdGVyIGlzIGl0cyBvd24gcGFnZSBhbmQgb3ducyBhbiBgaDFgOyBzdGFja2VkIGludG8gb25lIGRvY3VtZW50XG4gKiB0aG9zZSBgaDFgcyB3b3VsZCBiZSBvbmUgZG9jdW1lbnQgcGVyIGNoYXB0ZXIgcmF0aGVyIHRoYW4gb25lIGJvb2ssIGFuZCB0aGUgcHJpbnRcbiAqIHJ1bGUgYmVsb3cgXHUyMDE0IGEgcGFnZSBicmVhayBwZXIgY2hhcHRlciBcdTIwMTQgd291bGQgaGF2ZSBub3RoaW5nIHRvIGtleSBvbi5cbiAqXG4gKiBGZW5jZWQgY29kZSBpcyBza2lwcGVkOiBhIGAjIGNvbW1lbnRgIGluc2lkZSBhIHNoZWxsIGJsb2NrIGlzIG5vdCBhIGhlYWRpbmcuXG4gKi9cbmZ1bmN0aW9uIGRlbW90ZUhlYWRpbmdzKGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBmZW5jZWQgPSBmYWxzZTtcbiAgcmV0dXJuIGJvZHlcbiAgICAuc3BsaXQoJ1xcbicpXG4gICAgLm1hcCgobGluZSkgPT4ge1xuICAgICAgaWYgKC9eXFxzKihgYGB8fn5+KS8udGVzdChsaW5lKSkgZmVuY2VkID0gIWZlbmNlZDtcbiAgICAgIGlmIChmZW5jZWQpIHJldHVybiBsaW5lO1xuICAgICAgcmV0dXJuIC9eI3sxLDV9IC8udGVzdChsaW5lKSA/IGAjJHtsaW5lfWAgOiBsaW5lO1xuICAgIH0pXG4gICAgLmpvaW4oJ1xcbicpO1xufVxuXG4vKiogT25lIGNoYXB0ZXIsIGFzIG1hcmtkb3duIHJlYWR5IHRvIGNvbmNhdGVuYXRlLiBgZGVtb3RlYCBpcyBmYWxzZSBmb3IgdGhlIGZyb250IG1hdHRlci4gKi9cbmZ1bmN0aW9uIGNoYXB0ZXJNYXJrZG93bihcbiAgc3JjRGlyOiBzdHJpbmcsXG4gIGxpbms6IHN0cmluZyxcbiAgZGVtb3RlID0gdHJ1ZSxcbiAgY29tcG9uZW50PzogQ29tcG9uZW50VHdpbixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhqb2luKHNyY0RpciwgZmlsZUZvckxpbmsobGluaykpLCAndXRmOCcpO1xuICBjb25zdCBib2R5ID0gc3RyaXBOZXh0TGluayhzdHJpcEZyb250bWF0dGVyKHRvVHdpbihyYXcsIHNyY0RpciwgY29tcG9uZW50KSkpLnRyaW1FbmQoKTtcbiAgcmV0dXJuIGRlbW90ZSA/IGRlbW90ZUhlYWRpbmdzKGJvZHkpIDogYm9keTtcbn1cblxuLyoqIE9uZSBjaGFwdGVyIG9mIHRoZSBib29rLCBhdCBpdHMgb3duIGhlYWRpbmcgbGV2ZWxzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBCb29rUGFnZSB7XG4gIC8qKiBUaGUgc2lkZWJhcidzIHdvcmRzIGZvciBpdDogYDUuIFRoZSBsaWZlIG9mIG9uZSBldmVudGAuICovXG4gIHRleHQ6IHN0cmluZztcbiAgLyoqIFNpdGUtYWJzb2x1dGUgcm91dGU6IGAvYm9vay8wNS1vbmUtZXZlbnRgLiAqL1xuICBsaW5rOiBzdHJpbmc7XG4gIC8qKiBgMDUtb25lLWV2ZW50YCwgb3IgYGluZGV4YCBmb3IgdGhlIGZyb250IG1hdHRlci4gVGhlIEVQVUIgbmFtZXMgZmlsZXMgYnkgdGhpcy4gKi9cbiAgc2x1Zzogc3RyaW5nO1xuICAvKiogVGhlIHR3aW4ncyBtYXJrZG93biwgaGVhZGluZ3MgdW50b3VjaGVkIFx1MjAxNCBlYWNoIGNoYXB0ZXIgc3RpbGwgb3ducyBpdHMgYGgxYC4gKi9cbiAgbWFya2Rvd246IHN0cmluZztcbn1cblxuLyoqXG4gKiBUaGUgY2hhcHRlcnMgYXMgc2VwYXJhdGUgZG9jdW1lbnRzLCBmb3IgYSBmb3JtYXQgd2hvc2UgdW5pdCBpcyB0aGUgY2hhcHRlci5cbiAqXG4gKiBgYm9va01hcmtkb3duYCBmbGF0dGVucyB0aGVzZSBpbnRvIG9uZSBkb2N1bWVudCBhbmQgZGVtb3RlcyB0aGVpciBoZWFkaW5nczsgdGhlXG4gKiBFUFVCIGRvZXMgdGhlIG9wcG9zaXRlLCBrZWVwaW5nIG9uZSBmaWxlIHBlciBjaGFwdGVyIHNvIGEgcmVhZGVyJ3MgdGFibGUgb2ZcbiAqIGNvbnRlbnRzIGhhcyBzb21ld2hlcmUgdG8gcG9pbnQuIEJvdGggcmVhZCB0aGUgc2FtZSBsaXN0IGFuZCB0aGUgc2FtZSB0d2lucywgc29cbiAqIG5laXRoZXIgZWRpdGlvbiBjYW4gY2FycnkgYSBjaGFwdGVyIHRoZSBvdGhlciBkb2VzIG5vdC5cbiAqXG4gKiBgY29tcG9uZW50YCBpcyBob3cgdGhlIEVQVUIgZ2V0cyB0aGUgY2hhcHRlcnMnIGZpZ3VyZXMgcmF0aGVyIHRoYW4gdGhlaXIgcHJvc2VcbiAqIHR3aW5zIFx1MjAxNCBpdCBpcyBoYW5kZWQgZWFjaCBgPENvbXBvbmVudCAvPmAgbGluZSBhbmQgcmV0dXJucyB3aGF0IHN0YW5kcyBpbiBmb3IgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBib29rUGFnZXMoc3JjRGlyOiBzdHJpbmcsIGNvbXBvbmVudD86IENvbXBvbmVudFR3aW4pOiBCb29rUGFnZVtdIHtcbiAgcmV0dXJuIGJvb2tDaGFwdGVycygpLm1hcCgoYykgPT4gKHtcbiAgICB0ZXh0OiBjLnRleHQsXG4gICAgbGluazogYy5saW5rLFxuICAgIHNsdWc6IGMubGluay5yZXBsYWNlKC9eXFwvYm9va1xcLz8vLCAnJykgfHwgJ2luZGV4JyxcbiAgICBtYXJrZG93bjogY2hhcHRlck1hcmtkb3duKHNyY0RpciwgYy5saW5rLCBmYWxzZSwgY29tcG9uZW50KSxcbiAgfSkpO1xufVxuXG4vKipcbiAqIFRoZSB3aG9sZSBib29rIGFzIG9uZSBtYXJrZG93biBkb2N1bWVudCwgY2hhcHRlcnMgaW4gc2lkZWJhciBvcmRlci5cbiAqXG4gKiBUaGUgZmlyc3QgY2hhcHRlciBpcyB0aGUgZnJvbnQgbWF0dGVyIChcIkhvdyB0byByZWFkIHRoaXNcIiksIHdob3NlIG93biB0aXRsZSBJUyB0aGVcbiAqIGJvb2sncyB0aXRsZSBcdTIwMTQgc28gaXRzIGhlYWRpbmcgaXMgZHJvcHBlZCByYXRoZXIgdGhhbiBkZW1vdGVkLCBhbmQgdGhlIGRvY3VtZW50J3NcbiAqIHNpbmdsZSBgaDFgIGlzIHdyaXR0ZW4gaGVyZSBpbnN0ZWFkLiBPdGhlcndpc2UgdGhlIHRpdGxlIHdvdWxkIGFwcGVhciB0d2ljZSwgb25jZVxuICogYXMgdGhlIGRvY3VtZW50IGFuZCBvbmNlIGFzIGl0cyBvd24gZmlyc3Qgc2VjdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJvb2tNYXJrZG93bihzcmNEaXI6IHN0cmluZywgY29tcG9uZW50PzogQ29tcG9uZW50VHdpbik6IHN0cmluZyB7XG4gIGNvbnN0IFtmcm9udExpbmssIC4uLmNoYXB0ZXJMaW5rc10gPSBib29rQ2hhcHRlcnMoKTtcbiAgLy8gVGhlIGZyb250IG1hdHRlciBrZWVwcyBpdHMgb3duIGhlYWRpbmcgbGV2ZWxzOiBpdCBzaXRzIGRpcmVjdGx5IHVuZGVyIHRoZVxuICAvLyBkb2N1bWVudCB0aXRsZSB3aXRoIG5vIGNoYXB0ZXIgd3JhcHBlciwgc28gZGVtb3RpbmcgaXQgd291bGQgb3BlbiBhdCBgaDNgLlxuICBjb25zdCBmcm9udCA9IGNoYXB0ZXJNYXJrZG93bihzcmNEaXIsIGZyb250TGluayEubGluaywgZmFsc2UsIGNvbXBvbmVudCk7XG4gIGNvbnN0IGNoYXB0ZXJzID0gY2hhcHRlckxpbmtzLm1hcCgoYykgPT4gY2hhcHRlck1hcmtkb3duKHNyY0RpciwgYy5saW5rLCB0cnVlLCBjb21wb25lbnQpKTtcbiAgcmV0dXJuIFtcbiAgICBgIyAke1RJVExFfWAsXG4gICAgJycsXG4gICAgYFRoZSBTdWJzdHJhdCBib29rLCBpbiBvbmUgZmlsZS4gUHVibGlzaGVkIGF0ICR7U0lURX0vYm9vay8gXHUyMDE0IHRoaXMgZWRpdGlvbiBpc2AsXG4gICAgJ2dlbmVyYXRlZCBmcm9tIHRob3NlIGNoYXB0ZXJzIGF0IGJ1aWxkIHRpbWUsIHNvIGl0IGNhbm5vdCBmYWxsIGJlaGluZCB0aGVtLicsXG4gICAgJycsXG4gICAgZnJvbnQucmVwbGFjZSgvXiMgLipcXG4rLywgJycpLFxuICAgICcnLFxuICAgIGNoYXB0ZXJzLmpvaW4oJ1xcblxcbi0tLVxcblxcbicpLFxuICAgICcnLFxuICBdLmpvaW4oJ1xcbicpO1xufVxuXG4vKipcbiAqIFRoZSBwcmludGFibGUgSFRNTCBlZGl0aW9uLlxuICpcbiAqIERlbGliZXJhdGVseSBzZWxmLWNvbnRhaW5lZCBhbmQgdGhlbWUtZnJlZTogbm8gbmF2LCBubyBzZWFyY2gsIG5vIHNpdGUgY2hyb21lLFxuICogb25lIGNvbHVtbiwgYSBwcmludCBzdHlsZXNoZWV0LiBJdHMgd2hvbGUgam9iIGlzIHRvIGJlIHRoZSB0aGluZyB5b3UgaGl0IFx1MjMxOFAgb25cbiAqIG9yIHNhdmUgYXMgYSBQREYsIHdoaWNoIHRoZSBjaGFwdGVyIHBhZ2VzIGFyZSBiYWQgYXQgYW5kIHRoaXMgaXMgZ29vZCBhdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJvb2tIdG1sKHNyY0Rpcjogc3RyaW5nLCBmaWd1cmVzOiBGaWd1cmVTZXQgPSBuZXcgTWFwKCkpOiBzdHJpbmcge1xuICAvLyBgbGlua2lmeTogZmFsc2VgIFx1MjAxNCBzZWUgZXB1Yi5tdHM6IGl0IHR1cm5zIGEgYmFyZSBgUEVSTUlTU0lPTlMubWRgIGludG8gYSBsaW5rIHRvXG4gIC8vIE1vbGRvdmEuIEV2ZXJ5IGxpbmsgaW4gdGhlIGJvb2sgaXMgZXhwbGljaXQgbWFya2Rvd24sIHNvIGl0IGNhbiBvbmx5IGludmVudC5cbiAgY29uc3QgbWQgPSBuZXcgTWFya2Rvd25JdCh7IGh0bWw6IHRydWUsIGxpbmtpZnk6IGZhbHNlLCB0eXBvZ3JhcGhlcjogZmFsc2UgfSk7XG4gIGNvbnN0IGJvZHkgPSBtZC5yZW5kZXIoYm9va01hcmtkb3duKHNyY0RpciwgKG5hbWUsIHByb3BzKSA9PlxuICAgIGZpZ3VyZXMuZ2V0KGZpZ3VyZUtleShuYW1lLCBwcm9wcykpID8/IGFsdFR3aW4obmFtZSwgcHJvcHMpLFxuICApKTtcbiAgcmV0dXJuIGA8IWRvY3R5cGUgaHRtbD5cbjxodG1sIGxhbmc9XCJlblwiPlxuPGhlYWQ+XG48bWV0YSBjaGFyc2V0PVwidXRmLThcIj5cbjxtZXRhIG5hbWU9XCJ2aWV3cG9ydFwiIGNvbnRlbnQ9XCJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MVwiPlxuPHRpdGxlPiR7VElUTEV9PC90aXRsZT5cbjxsaW5rIHJlbD1cImNhbm9uaWNhbFwiIGhyZWY9XCIke1NJVEV9L2Jvb2svcmVhZC5odG1sXCI+XG48c3R5bGU+XG4gIDpyb290IHsgY29sb3Itc2NoZW1lOiBsaWdodCBkYXJrOyAtLWZnOiAjMWExYTFhOyAtLW11dGVkOiAjNWE1YTVhOyAtLWJnOiAjZmZmO1xuICAgICAgICAgIC0tcnVsZTogI2UyZTJlMjsgLS1jb2RlLWJnOiAjZjVmNWY0OyAtLWFjY2VudDogIzBiNmI2MjsgfVxuICBAbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOiBkYXJrKSB7XG4gICAgOnJvb3QgeyAtLWZnOiAjZThlOGU4OyAtLW11dGVkOiAjYTBhMGEwOyAtLWJnOiAjMTYxNjFhO1xuICAgICAgICAgICAgLS1ydWxlOiAjMmUyZTMzOyAtLWNvZGUtYmc6ICMyMDIwMjc7IC0tYWNjZW50OiAjNWZkM2M0OyB9XG4gIH1cbiAgKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IH1cbiAgYm9keSB7IG1hcmdpbjogMCBhdXRvOyBwYWRkaW5nOiAzcmVtIDEuMjVyZW0gNnJlbTsgbWF4LXdpZHRoOiA0NHJlbTtcbiAgICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWJnKTsgY29sb3I6IHZhcigtLWZnKTsgbGluZS1oZWlnaHQ6IDEuNjU7XG4gICAgICAgICBmb250LWZhbWlseTogdWktc2Fucy1zZXJpZiwgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gICAgICAgICBmb250LXNpemU6IDE3cHg7IH1cbiAgaDEsIGgyLCBoMywgaDQgeyBsaW5lLWhlaWdodDogMS4yNTsgZm9udC13ZWlnaHQ6IDY1MDsgbWFyZ2luOiAyLjVlbSAwIDAuNmVtOyB9XG4gIGgxIHsgZm9udC1zaXplOiAycmVtOyBtYXJnaW4tdG9wOiAwOyB9XG4gIGgxICsgcCB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH1cbiAgaDIgeyBmb250LXNpemU6IDEuNDVyZW07IHBhZGRpbmctdG9wOiAwLjZlbTsgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLXJ1bGUpOyB9XG4gIGgzIHsgZm9udC1zaXplOiAxLjE1cmVtOyB9XG4gIHAsIHVsLCBvbCwgYmxvY2txdW90ZSwgdGFibGUgeyBtYXJnaW46IDAgMCAxLjFlbTsgfVxuICBhIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgfVxuICBhOmhvdmVyIHsgdGV4dC1kZWNvcmF0aW9uOiB1bmRlcmxpbmU7IH1cbiAgY29kZSB7IGZvbnQtZmFtaWx5OiB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgbW9ub3NwYWNlOyBmb250LXNpemU6IDAuODdlbTtcbiAgICAgICAgIGJhY2tncm91bmQ6IHZhcigtLWNvZGUtYmcpOyBwYWRkaW5nOiAwLjE1ZW0gMC4zNWVtOyBib3JkZXItcmFkaXVzOiA0cHg7IH1cbiAgcHJlIHsgYmFja2dyb3VuZDogdmFyKC0tY29kZS1iZyk7IHBhZGRpbmc6IDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgb3ZlcmZsb3cteDogYXV0bzsgZm9udC1zaXplOiAwLjg1ZW07IGxpbmUtaGVpZ2h0OiAxLjU7IH1cbiAgcHJlIGNvZGUgeyBiYWNrZ3JvdW5kOiBub25lOyBwYWRkaW5nOiAwOyBmb250LXNpemU6IDFlbTsgfVxuICBibG9ja3F1b3RlIHsgbWFyZ2luLWxlZnQ6IDA7IHBhZGRpbmc6IDAuMmVtIDAgMC4yZW0gMS4xZW07XG4gICAgICAgICAgICAgICBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWFjY2VudCk7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH1cbiAgdGFibGUgeyBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlOyB3aWR0aDogMTAwJTsgZm9udC1zaXplOiAwLjkzZW07IGRpc3BsYXk6IGJsb2NrO1xuICAgICAgICAgIG92ZXJmbG93LXg6IGF1dG87IH1cbiAgdGgsIHRkIHsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tcnVsZSk7IHBhZGRpbmc6IDAuNDVlbSAwLjdlbTsgdGV4dC1hbGlnbjogbGVmdDtcbiAgICAgICAgICAgdmVydGljYWwtYWxpZ246IHRvcDsgfVxuICB0aCB7IGJhY2tncm91bmQ6IHZhcigtLWNvZGUtYmcpOyBmb250LXdlaWdodDogNjAwOyB9XG4gIGhyIHsgYm9yZGVyOiAwOyBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tcnVsZSk7IG1hcmdpbjogMy41ZW0gMDsgfVxuICBAbWVkaWEgcHJpbnQge1xuICAgIGJvZHkgeyBtYXgtd2lkdGg6IG5vbmU7IGZvbnQtc2l6ZTogMTFwdDsgcGFkZGluZzogMDsgY29sb3I6ICMwMDA7IGJhY2tncm91bmQ6ICNmZmY7IH1cbiAgICBhIHsgY29sb3I6ICMwMDA7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9XG4gICAgaDIgeyBicmVhay1iZWZvcmU6IHBhZ2U7IH1cbiAgICBoMSArIHAgeyBicmVhay1hZnRlcjogYXV0bzsgfVxuICAgIHByZSwgYmxvY2txdW90ZSwgdGFibGUgeyBicmVhay1pbnNpZGU6IGF2b2lkOyB9XG4gIH1cbjwvc3R5bGU+XG48c3R5bGU+XG4ke2ZpZ3VyZUNzcyhzcmNEaXIsIFsuLi5maWd1cmVzLmtleXMoKV0ubWFwKGNvbXBvbmVudE9mKSl9XG48L3N0eWxlPlxuPC9oZWFkPlxuPGJvZHk+XG4ke2JvZHl9XG48L2JvZHk+XG48L2h0bWw+XG5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYm9va0FydGlmYWN0cyhzcmNEaXI6IHN0cmluZywgZmlndXJlczogRmlndXJlU2V0ID0gbmV3IE1hcCgpKTogQXJ0aWZhY3RbXSB7XG4gIHJldHVybiBbXG4gICAgeyBwYXRoOiAnYm9vay50eHQnLCBjb250ZW50czogYm9va01hcmtkb3duKHNyY0RpcikgfSxcbiAgICB7IHBhdGg6ICdib29rL3JlYWQuaHRtbCcsIGNvbnRlbnRzOiBib29rSHRtbChzcmNEaXIsIGZpZ3VyZXMpIH0sXG4gIF07XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9maWd1cmVzLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9maWd1cmVzLm10c1wiOy8qKlxuICogVGhlIGJvb2sncyBkaWFncmFtcywgcmVuZGVyZWQgZm9yIGEgZm9ybWF0IHRoYXQgaGFzIG5vIEphdmFTY3JpcHQgKCMxNDAxKS5cbiAqXG4gKiBGaXZlIGNoYXB0ZXJzIGRyYXcgYSBmaWd1cmUgXHUyMDE0IGA8TGF5ZXJTdGFjayAvPmAsIGA8VGVuYW5jeVRyZWUgLz5gLFxuICogYDxTY29wZVRvcG9sb2d5IC8+YCwgYDxQZXJtaXNzaW9uUGlwZWxpbmUgLz5gLCBgPEJsYXN0UmFkaXVzIC8+YCBcdTIwMTQgYW5kIG9uIHRoZSB3ZWJcbiAqIHRob3NlIGFyZSBWdWUgY29tcG9uZW50cyBpbiBgdGhlbWUvY29tcG9uZW50c2AuIEV2ZXJ5IG90aGVyIGVkaXRpb24gb2YgdGhlIGJvb2tcbiAqIGZsYXR0ZW5lZCB0aGVtIHRvIHRoZSBwcm9zZSB0d2luIGluIHRoZSBzaWJsaW5nIGAqLmNvbnRlbnQubXRzYCAoc2VlIGBhbHQubXRzYCksXG4gKiB3aGljaCBpcyB0aGUgcmlnaHQgYW5zd2VyIGZvciBgbGxtcy50eHRgIGFuZCB0aGUgd3Jvbmcgb25lIGZvciBhIHJlYWRlciBob2xkaW5nIGFcbiAqIHBob25lOiB0aGUgd2hvbGUgcG9pbnQgb2YgYSBmaWd1cmUgaXMgdGhhdCB0aGUgc2hhcGUgYXJyaXZlcyBiZWZvcmUgdGhlIHNlbnRlbmNlLlxuICpcbiAqIFNvIHRoZSBFUFVCIGdldHMgdGhlIHBpY3R1cmUuIE5vdCBhIHJlZHJhd2luZyBvZiBpdCBcdTIwMTQgdGhlIGNvbXBvbmVudCBpdHNlbGYsXG4gKiBzZXJ2ZXItcmVuZGVyZWQgZnJvbSB0aGUgc2FtZSBzb3VyY2UgdGhlIHNpdGUgYnVpbGRzLCBzbyB0aGVyZSBpcyBubyBzZWNvbmRcbiAqIGRyYXdpbmcgdG8gZmFsbCBiZWhpbmQgdGhlIGZpcnN0LiBWaXRlIGRvZXMgdGhlIGxvYWRpbmcgKGAudnVlYCArIGA8c2NyaXB0IHNldHVwXG4gKiBsYW5nPVwidHNcIj5gICsgdGhlIGAuY29udGVudC5tdHNgIGltcG9ydHMgYXJlIGl0cyBqb2IsIG5vdCBvdXJzKSBhbmQgVnVlJ3Mgb3duIFNTUlxuICogcmVuZGVyZXIgcHJvZHVjZXMgdGhlIG1hcmt1cC5cbiAqXG4gKiAjIyBUaGUgdGhyZWUgdGhpbmdzIHRoYXQgbWFrZSBpdCBFUFVCLXNoYXBlZCByYXRoZXIgdGhhbiB3ZWItc2hhcGVkXG4gKlxuICogICAxLiAqKlhIVE1MLCBub3QgSFRNTDUuKiogQSBjb250ZW50IGRvY3VtZW50IGlzIHBhcnNlZCBhcyBYTUwsIHdoZXJlIGEgc3RyYXlcbiAqICAgICAgYCZuYnNwO2AgaXMgYW4gdW5kZWNsYXJlZCBlbnRpdHkgYW5kIGFuIHVuY2xvc2VkIHRhZyBpcyBhIGZhdGFsIGVycm9yIFx1MjAxNCBhbmQgYVxuICogICAgICByZWFkZXIncyByZXNwb25zZSB0byBlaXRoZXIgaXMgYSBibGFuayBjaGFwdGVyLCB3aXRoIG5vIG1lc3NhZ2UuIGB0b1hodG1sYFxuICogICAgICBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZSBTU1Igb3V0cHV0IG9uIHRoZSByaWdodCBzaWRlIG9mIHRoYXQuXG4gKiAgIDIuICoqTm8gc2NvcGUgaWRzLioqIFZ1ZSBpc29sYXRlcyBgLmZpZ2AgaW4gb25lIGNvbXBvbmVudCBmcm9tIGAuZmlnYCBpbiBhbm90aGVyXG4gKiAgICAgIHdpdGggYSBgZGF0YS12LVx1MjAyNmAgYXR0cmlidXRlIHBlciBjb21wb25lbnQuIFdlIHN0cmlwIHRob3NlIGFuZCB3cmFwIGVhY2ggZmlndXJlXG4gKiAgICAgIGluIGAuZmlndXJlLS08TmFtZT5gIGluc3RlYWQsIHByZWZpeGluZyB0aGUgY29tcG9uZW50J3Mgb3duIHNlbGVjdG9ycyB0byBtYXRjaFxuICogICAgICAoYHNjb3BlQ3NzYCkuIFNhbWUgaXNvbGF0aW9uLCBubyBkZXBlbmRlbmNlIG9uIGEgaGFzaCB0aGUgcGx1Z2luIGlzIGZyZWUgdG9cbiAqICAgICAgY2hhbmdlLlxuICogICAzLiAqKlRoZSB0b2tlbnMgdHJhdmVsIHdpdGggaXQuKiogVGhlIHN0eWxlc2hlZXQgaXMgd3JpdHRlbiBhZ2FpbnN0IGRlc2lnbiB0b2tlbnNcbiAqICAgICAgKGB2YXIoLS1zdXJmYWNlLWNhcmQpYCwgYHZhcigtLWxheWVyLWtlcm5lbClgKSwgd2hpY2ggbGl2ZSBpbiBgdGhlbWUvdG9rZW5zYFxuICogICAgICBhbmQgcmVhY2ggdGhlIHNpdGUgdGhyb3VnaCB0aGUgdGhlbWUncyBvd24gQ1NTLiBBbiBFUFVCIGxvYWRzIG5vbmUgb2YgdGhhdCwgc29cbiAqICAgICAgdGhlIGA6cm9vdGAgZGVjbGFyYXRpb25zIGFyZSBjb3BpZWQgb250byB0aGUgZmlndXJlIHdyYXBwZXIgXHUyMDE0IHRoZSBsaWdodCBzZXRcbiAqICAgICAgb25seS4gVGhhdCBpcyBkZWxpYmVyYXRlOiBlYWNoIGZpZ3VyZSBwYWludHMgaXRzIG93biBjYXJkLCBzbyBpdCBzdGF5cyBsZWdpYmxlXG4gKiAgICAgIHdoZW4gdGhlIHJlYWRlciBoYXMgcHV0IHRoZSBwYWdlIGludG8gbmlnaHQgbW9kZSwgd2hpY2ggYSBoYWxmLWluaGVyaXRlZFxuICogICAgICBwYWxldHRlIHdvdWxkIG5vdC5cbiAqL1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IHZ1ZSBmcm9tICdAdml0ZWpzL3BsdWdpbi12dWUnO1xuaW1wb3J0IHsgY3JlYXRlU1NSQXBwIH0gZnJvbSAndnVlJztcbmltcG9ydCB7IHJlbmRlclRvU3RyaW5nIH0gZnJvbSAndnVlL3NlcnZlci1yZW5kZXJlcic7XG5cbi8qKiBPbmUgYDxOYW1lIHByb3A9XCJ2YWx1ZVwiIC8+YCBvY2N1cnJlbmNlLCBhcyBgdG9Ud2luYCBoYW5kcyBpdCBvdmVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBGaWd1cmVSZXF1ZXN0IHtcbiAgbmFtZTogc3RyaW5nO1xuICBwcm9wczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuLyoqIFJlbmRlcmVkIGZpZ3VyZXMsIGtleWVkIGJ5IGBmaWd1cmVLZXlgIFx1MjAxNCBhIGNvbXBvbmVudCBwbHVzIHRoZSBwcm9wcyBpdCB3YXMgZ2l2ZW4uICovXG5leHBvcnQgdHlwZSBGaWd1cmVTZXQgPSBNYXA8c3RyaW5nLCBzdHJpbmc+O1xuXG4vKipcbiAqIFRoZSBjYWNoZSBrZXkgZm9yIG9uZSByZW5kZXJpbmcuXG4gKlxuICogUHJvcHMgYXJlIHBhcnQgb2YgaXQgYmVjYXVzZSBhIGNvbXBvbmVudCB0aGF0IHRha2VzIHRoZW0gZHJhd3MgYSBkaWZmZXJlbnQgcGljdHVyZVxuICogZm9yIGVhY2ggKGA8U3RhdGVNYWNoaW5lIGVuZ2luZT1cImJvb2tpbmdcIiAvPmApLiBTb3J0ZWQsIHNvIHR3byBzcGVsbGluZ3Mgb2YgdGhlXG4gKiBzYW1lIHByb3BzIGFyZSBvbmUgZW50cnkuXG4gKlxuICogSlNPTiByYXRoZXIgdGhhbiB0aGUgcXVlcnkgc3RyaW5nIGl0IGxvb2tzIGxpa2UgaXQgd2FudHMgdG8gYmU6IGEgcHJvcCB2YWx1ZSBpc1xuICogYFteXCJdKmAgaW4gYENPTVBPTkVOVF9MSU5FYCwgc28gaXQgbWF5IGNvbnRhaW4gYCZgIGFuZCBgPWAgXHUyMDE0IGFuZCBgeD1cImEmeT1iXCJgIHdvdWxkXG4gKiB0aGVuIGtleSB0aGUgc2FtZSBhcyBgeD1cImFcIiB5PVwiYlwiYCwgd2hpY2ggaXMgb25lIHJlbmRlciBzaWxlbnRseSBhbnN3ZXJpbmcgZm9yIHR3b1xuICogZGlmZmVyZW50IHBpY3R1cmVzLiBUaGUgc2VwYXJhdG9yIGhhcyB0byBiZSBvbmUgdGhlIHZhbHVlcyBjYW5ub3QgY29udGFpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpZ3VyZUtleShuYW1lOiBzdHJpbmcsIHByb3BzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBzdHJpbmcge1xuICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LmVudHJpZXMocHJvcHMpLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpO1xuICByZXR1cm4gZW50cmllcy5sZW5ndGggPT09IDAgPyBuYW1lIDogYCR7bmFtZX0/JHtKU09OLnN0cmluZ2lmeShlbnRyaWVzKX1gO1xufVxuXG4vKipcbiAqIFRoZSBjb21wb25lbnQgaGFsZiBvZiBhIGBmaWd1cmVLZXlgIFx1MjAxNCBgU3RhdGVNYWNoaW5lP1tbXCJlbmdpbmVcIixcImJvb2tpbmdcIl1dYCBcdTIxOTJcbiAqIGBTdGF0ZU1hY2hpbmVgLiBBIGNvbXBvbmVudCBuYW1lIGlzIGBbQS1aXVxcdypgLCBzbyB0aGUgZmlyc3QgYD9gIGlzIGFsd2F5cyB0aGVcbiAqIHNlcGFyYXRvciB3aGF0ZXZlciB0aGUgcHJvcHMgZW5jb2RlIHRvLlxuICovXG5leHBvcnQgY29uc3QgY29tcG9uZW50T2YgPSAoa2V5OiBzdHJpbmcpOiBzdHJpbmcgPT4ga2V5LnNwbGl0KCc/JylbMF0hO1xuXG5jb25zdCBjb21wb25lbnRGaWxlID0gKG5hbWU6IHN0cmluZyk6IHN0cmluZyA9PlxuICBgLy52aXRlcHJlc3MvdGhlbWUvY29tcG9uZW50cy8ke25hbWV9LnZ1ZWA7XG5cbi8qKlxuICogVGhlIG5hbWVkIGVudGl0aWVzIGEgdGVtcGxhdGUgbWF5IGNhcnJ5IHRoYXQgWE1MIGRvZXMgbm90IGRlY2xhcmUuXG4gKlxuICogVnVlJ3MgdGVtcGxhdGUgY29tcGlsZXIgYWxyZWFkeSBkZWNvZGVzIHRoZSBvbmVzIHdyaXR0ZW4gaW4gYSB0ZW1wbGF0ZSBcdTIwMTQgYCZ1YXJyO2BcbiAqIGFycml2ZXMgYXMgYFx1MjE5MWAuIFRoZXNlIHN1cnZpdmUgYmVjYXVzZSB0aGV5IGNvbWUgdGhyb3VnaCBgdi1odG1sYCBvdXQgb2YgYSBjb250ZW50XG4gKiBtb2R1bGUsIHdoaWNoIGlzIGluc2VydGVkIHZlcmJhdGltLiBUaHJlZSB0b2RheTsgYW4gdW5rbm93biBvbmUgaXMgbGVmdCBhbG9uZSBhbmRcbiAqIGNhdWdodCBieSB0aGUgc3RyaWN0IFhNTCBwYXJzZSBpbiBgdGVzdC9lcHViLnRlc3QubXRzYCByYXRoZXIgdGhhbiBzaWxlbnRseVxuICogc2hpcHBpbmcgYSBjaGFwdGVyIG5vIHJlYWRlciB3aWxsIG9wZW4uXG4gKi9cbmNvbnN0IFhNTF9FTlRJVElFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgJyZuYnNwOyc6ICdcdTAwQTAnLFxuICAnJnVhcnI7JzogJ1x1MjE5MScsXG4gICcmZGFycjsnOiAnXHUyMTkzJyxcbn07XG5cbi8qKlxuICogVnVlJ3MgU1NSIEhUTUwgXHUyMTkyIGEgZnJhZ21lbnQgYW4gWE1MIHBhcnNlciBhY2NlcHRzLlxuICpcbiAqIFZ1ZSBoZWxwcyBtb3JlIHRoYW4gaXQgbG9va3M6IGl0IGNsb3NlcyBldmVyeSBlbGVtZW50IGl0IHdyaXRlcywgaW5jbHVkaW5nIHRoZSBTVkdcbiAqIG9uZXMgKGA8cG9seWdvbiBcdTIwMjY+PC9wb2x5Z29uPmApLCBzbyB0aGVyZSBhcmUgbm8gdm9pZCB0YWdzIHRvIHJlcGFpci4gV2hhdCBpcyBsZWZ0XG4gKiBpcyB0aGUgc2NvcGUgYXR0cmlidXRlcywgaXRzIGZyYWdtZW50LWJvdW5kYXJ5IGNvbW1lbnRzLCB0aGUgZW50aXRpZXMgYWJvdmUsIGFuZFxuICogdGhlIG5hbWVzcGFjZSBcdTIwMTQgYW4gaW5saW5lIGA8c3ZnPmAgaW4gWEhUTUwgaXMgb25seSBTVkcgaWYgaXQgc2F5cyBzby5cbiAqL1xuZnVuY3Rpb24gdG9YaHRtbChodG1sOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gaHRtbFxuICAgIC5yZXBsYWNlKC9cXHMrZGF0YS12LVswLTlhLWZdKyg/PVtcXHMvPl0pL2csICcnKVxuICAgIC5yZXBsYWNlKC88IS0tW1xcc1xcU10qPy0tPi9nLCAnJyk7XG4gIGZvciAoY29uc3QgW2VudGl0eSwgY2hhcl0gb2YgT2JqZWN0LmVudHJpZXMoWE1MX0VOVElUSUVTKSkge1xuICAgIG91dCA9IG91dC5yZXBsYWNlQWxsKGVudGl0eSwgY2hhcik7XG4gIH1cbiAgcmV0dXJuIG91dC5yZXBsYWNlKFxuICAgIC88c3ZnKD8hW14+XSpcXHN4bWxucz0pL2csXG4gICAgJzxzdmcgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiJyxcbiAgKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgdGhlIGNvbXBvbmVudHMgYmVoaW5kIGByZXF1ZXN0c2AsIG9uY2UgZWFjaC5cbiAqXG4gKiBPbmUgVml0ZSBzZXJ2ZXIgZm9yIHRoZSB3aG9sZSBzZXQ6IHN0YW5kaW5nIGl0IHVwIGlzIHRoZSBleHBlbnNpdmUgcGFydCwgYW5kIHRoZVxuICogYm9vayBhc2tzIGZvciBmaXZlIGZpZ3VyZXMuIGBjb25maWdGaWxlOiBmYWxzZWAgaXMgZGVsaWJlcmF0ZSBcdTIwMTQgdGhpcyBtdXN0IG5vdCBwaWNrXG4gKiB1cCBgLnZpdGVwcmVzcy9jb25maWcubXRzYCBhbmQgcmVjdXJzZSBpbnRvIHRoZSBidWlsZCB0aGF0IGNhbGxlZCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlckZpZ3VyZXMoXG4gIHNyY0Rpcjogc3RyaW5nLFxuICByZXF1ZXN0czogRmlndXJlUmVxdWVzdFtdLFxuKTogUHJvbWlzZTxGaWd1cmVTZXQ+IHtcbiAgY29uc3Qgd2FudGVkID0gbmV3IE1hcDxzdHJpbmcsIEZpZ3VyZVJlcXVlc3Q+KCk7XG4gIGZvciAoY29uc3QgcmVxdWVzdCBvZiByZXF1ZXN0cykge1xuICAgIHdhbnRlZC5zZXQoZmlndXJlS2V5KHJlcXVlc3QubmFtZSwgcmVxdWVzdC5wcm9wcyksIHJlcXVlc3QpO1xuICB9XG4gIGNvbnN0IGZpZ3VyZXM6IEZpZ3VyZVNldCA9IG5ldyBNYXAoKTtcbiAgaWYgKHdhbnRlZC5zaXplID09PSAwKSByZXR1cm4gZmlndXJlcztcblxuICBjb25zdCBzZXJ2ZXIgPSBhd2FpdCBjcmVhdGVTZXJ2ZXIoe1xuICAgIHJvb3Q6IHNyY0RpcixcbiAgICBjb25maWdGaWxlOiBmYWxzZSxcbiAgICBsb2dMZXZlbDogJ2Vycm9yJyxcbiAgICBhcHBUeXBlOiAnY3VzdG9tJyxcbiAgICBzZXJ2ZXI6IHsgbWlkZGxld2FyZU1vZGU6IHRydWUsIGhtcjogZmFsc2UgfSxcbiAgICAvLyBOb3RoaW5nIGluIHRoaXMgc2VydmVyIGlzIHNlcnZlZCB0byBhIGJyb3dzZXIsIHNvIGNyYXdsaW5nIHRoZSBncmFwaCBmb3JcbiAgICAvLyBkZXBlbmRlbmNpZXMgdG8gcHJlLWJ1bmRsZSBpcyB3b3JrIHdpdGggbm8gb3V0cHV0LlxuICAgIG9wdGltaXplRGVwczogeyBub0Rpc2NvdmVyeTogdHJ1ZSwgaW5jbHVkZTogW10gfSxcbiAgICBwbHVnaW5zOiBbdnVlKCldLFxuICB9KTtcbiAgdHJ5IHtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHJlcXVlc3RdIG9mIHdhbnRlZCkge1xuICAgICAgY29uc3QgbW9kdWxlID0gYXdhaXQgc2VydmVyLnNzckxvYWRNb2R1bGUoY29tcG9uZW50RmlsZShyZXF1ZXN0Lm5hbWUpKTtcbiAgICAgIGNvbnN0IGh0bWwgPSBhd2FpdCByZW5kZXJUb1N0cmluZyhcbiAgICAgICAgY3JlYXRlU1NSQXBwKG1vZHVsZS5kZWZhdWx0IGFzIFBhcmFtZXRlcnM8dHlwZW9mIGNyZWF0ZVNTUkFwcD5bMF0sIHJlcXVlc3QucHJvcHMpLFxuICAgICAgKTtcbiAgICAgIGZpZ3VyZXMuc2V0KFxuICAgICAgICBrZXksXG4gICAgICAgIGA8ZGl2IGNsYXNzPVwiZmlndXJlIGZpZ3VyZS0tJHtyZXF1ZXN0Lm5hbWV9XCI+JHt0b1hodG1sKGh0bWwpfTwvZGl2PmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBzZXJ2ZXIuY2xvc2UoKTtcbiAgfVxuICByZXR1cm4gZmlndXJlcztcbn1cblxuLyoqIEEgY29tcG9uZW50J3MgYDxzdHlsZSBzY29wZWQ+YCBibG9ja3MsIGNvbmNhdGVuYXRlZDsgJycgd2hlbiBpdCBoYXMgbm9uZS4gKi9cbmZ1bmN0aW9uIHNjb3BlZFN0eWxlKHNyY0Rpcjogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBzZmMgPSByZWFkRmlsZVN5bmMoXG4gICAgam9pbihzcmNEaXIsICcudml0ZXByZXNzL3RoZW1lL2NvbXBvbmVudHMnLCBgJHtuYW1lfS52dWVgKSxcbiAgICAndXRmOCcsXG4gICk7XG4gIHJldHVybiBbLi4uc2ZjLm1hdGNoQWxsKC88c3R5bGUgc2NvcGVkPihbXFxzXFxTXSo/KTxcXC9zdHlsZT4vZyldXG4gICAgLm1hcCgobSkgPT4gbVsxXSEpXG4gICAgLmpvaW4oJ1xcbicpO1xufVxuXG4vKiogQXQtcnVsZXMgd2hvc2UgYm9keSBpcyBhIGJsb2NrIG9mIHJ1bGVzLCBhbmQgdGhlcmVmb3JlIGhhcyB0byBiZSBzY29wZWQgdG9vLiAqL1xuY29uc3QgTkVTVEVEX0FUX1JVTEVTID0gbmV3IFNldChbJ21lZGlhJywgJ3N1cHBvcnRzJywgJ2NvbnRhaW5lcicsICdsYXllciddKTtcblxuLyoqIFNwbGl0IGEgc2VsZWN0b3IgbGlzdCBvbiBjb21tYXMgdGhhdCBhcmUgbm90IGluc2lkZSBgKC4uLilgLiAqL1xuZnVuY3Rpb24gc3BsaXRTZWxlY3RvcnMobGlzdDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBkZXB0aCA9IDA7XG4gIGxldCBjdXJyZW50ID0gJyc7XG4gIGZvciAoY29uc3QgY2hhciBvZiBsaXN0KSB7XG4gICAgaWYgKGNoYXIgPT09ICcoJykgZGVwdGggKz0gMTtcbiAgICBlbHNlIGlmIChjaGFyID09PSAnKScpIGRlcHRoIC09IDE7XG4gICAgaWYgKGNoYXIgPT09ICcsJyAmJiBkZXB0aCA9PT0gMCkge1xuICAgICAgb3V0LnB1c2goY3VycmVudCk7XG4gICAgICBjdXJyZW50ID0gJyc7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY3VycmVudCArPSBjaGFyO1xuICB9XG4gIG91dC5wdXNoKGN1cnJlbnQpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIE9uZSBzZWxlY3RvciwgcmV3cml0dGVuIHRvIGFwcGx5IG9ubHkgaW5zaWRlIHRoZSBmaWd1cmUncyB3cmFwcGVyLlxuICpcbiAqIGA6ZGVlcChjb2RlKWAgYmVjb21lcyBwbGFpbiBgY29kZWA6IHRoZSBwaWVyY2Ugb3BlcmF0b3IgZXhpc3RzIHRvIHJlYWNoIHBhc3QgVnVlJ3NcbiAqIHNjb3BlIGF0dHJpYnV0ZSwgYW5kIHRoZXJlIGlzIG5vIHNjb3BlIGF0dHJpYnV0ZSBoZXJlIFx1MjAxNCBhIGRlc2NlbmRhbnQgc2VsZWN0b3IgaXNcbiAqIHdoYXQgaXQgYWx3YXlzIG1lYW50LlxuICovXG5mdW5jdGlvbiBwcmVmaXhTZWxlY3RvcihzZWxlY3Rvcjogc3RyaW5nLCBwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBzZWxlY3RvclxuICAgIC5yZXBsYWNlKC86OnYtZGVlcFxccypcXCgoW14pXSopXFwpL2csICckMScpXG4gICAgLnJlcGxhY2UoLzpkZWVwXFxzKlxcKChbXildKilcXCkvZywgJyQxJylcbiAgICAudHJpbSgpO1xuICByZXR1cm4gY2xlYW5lZCA/IGAke3ByZWZpeH0gJHtjbGVhbmVkfWAgOiBwcmVmaXg7XG59XG5cbi8qKlxuICogUmV3cml0ZSBhIHN0eWxlc2hlZXQgc28gZXZlcnkgcnVsZSBpbiBpdCBpcyBjb25maW5lZCB0byBgcHJlZml4YC5cbiAqXG4gKiBBIGhhbmQtcm9sbGVkIHdhbGsgcmF0aGVyIHRoYW4gYSBDU1MgcGFyc2VyLCBiZWNhdXNlIHRoZSBpbnB1dCBpcyBvbmUgY29tcG9uZW50J3NcbiAqIHNjb3BlZCBibG9jazogcnVsZXMsIHRoZSBvY2Nhc2lvbmFsIGBAbWVkaWFgLCBhbmQgYGNvbnRlbnQ6IFwiXCJgLiBJdCBpc1xuICogc3RyaW5nLWF3YXJlIHNvIHRoYXQgYSBicmFjZSBpbnNpZGUgYSBxdW90ZWQgdmFsdWUgY2Fubm90IGVuZCBhIGJsb2NrIGVhcmx5LCBhbmRcbiAqIGl0IHJlY3Vyc2VzIGludG8gdGhlIGF0LXJ1bGVzIHRoYXQgY29udGFpbiBydWxlcyB3aGlsZSBsZWF2aW5nIGBAa2V5ZnJhbWVzYCBhbmRcbiAqIGBAZm9udC1mYWNlYCBcdTIwMTQgd2hvc2UgYm9kaWVzIGFyZSBub3Qgc2VsZWN0b3JzIFx1MjAxNCBleGFjdGx5IGFzIHdyaXR0ZW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY29wZUNzcyhjc3M6IHN0cmluZywgcHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBzb3VyY2UgPSBjc3MucmVwbGFjZSgvXFwvXFwqW1xcc1xcU10qP1xcKlxcLy9nLCAnJyk7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IHByZWx1ZGUgPSAnJztcbiAgbGV0IGluZGV4ID0gMDtcblxuICAvKiogUmVhZCBmcm9tIGBpbmRleGAgdG8gdGhlIG1hdGNoaW5nIGNsb3NlIGJyYWNlOyByZXR1cm5zIHRoZSBib2R5LiAqL1xuICBjb25zdCByZWFkQmxvY2sgPSAoKTogc3RyaW5nID0+IHtcbiAgICBsZXQgZGVwdGggPSAwO1xuICAgIGNvbnN0IHN0YXJ0ID0gaW5kZXg7XG4gICAgbGV0IHF1b3RlID0gJyc7XG4gICAgZm9yICg7IGluZGV4IDwgc291cmNlLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgICAgY29uc3QgY2hhciA9IHNvdXJjZVtpbmRleF0hO1xuICAgICAgaWYgKHF1b3RlKSB7XG4gICAgICAgIGlmIChjaGFyID09PSAnXFxcXCcpIGluZGV4ICs9IDE7XG4gICAgICAgIGVsc2UgaWYgKGNoYXIgPT09IHF1b3RlKSBxdW90ZSA9ICcnO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChjaGFyID09PSAnXCInIHx8IGNoYXIgPT09IFwiJ1wiKSBxdW90ZSA9IGNoYXI7XG4gICAgICBlbHNlIGlmIChjaGFyID09PSAneycpIGRlcHRoICs9IDE7XG4gICAgICBlbHNlIGlmIChjaGFyID09PSAnfScpIHtcbiAgICAgICAgZGVwdGggLT0gMTtcbiAgICAgICAgaWYgKGRlcHRoID09PSAwKSB7XG4gICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICByZXR1cm4gc291cmNlLnNsaWNlKHN0YXJ0ICsgMSwgaW5kZXggLSAxKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gc291cmNlLnNsaWNlKHN0YXJ0ICsgMSk7XG4gIH07XG5cbiAgd2hpbGUgKGluZGV4IDwgc291cmNlLmxlbmd0aCkge1xuICAgIGNvbnN0IGNoYXIgPSBzb3VyY2VbaW5kZXhdITtcbiAgICBpZiAoY2hhciA9PT0gJ3snKSB7XG4gICAgICBjb25zdCBib2R5ID0gcmVhZEJsb2NrKCk7XG4gICAgICBjb25zdCBoZWFkID0gcHJlbHVkZS50cmltKCk7XG4gICAgICBwcmVsdWRlID0gJyc7XG4gICAgICBpZiAoaGVhZC5zdGFydHNXaXRoKCdAJykpIHtcbiAgICAgICAgY29uc3QgbmFtZSA9IC9eQChbXFx3LV0rKS8uZXhlYyhoZWFkKT8uWzFdID8/ICcnO1xuICAgICAgICBvdXQucHVzaChcbiAgICAgICAgICBORVNURURfQVRfUlVMRVMuaGFzKG5hbWUpXG4gICAgICAgICAgICA/IGAke2hlYWR9IHtcXG4ke3Njb3BlQ3NzKGJvZHksIHByZWZpeCl9XFxufWBcbiAgICAgICAgICAgIDogYCR7aGVhZH0geyR7Ym9keX19YCxcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHNlbGVjdG9ycyA9IHNwbGl0U2VsZWN0b3JzKGhlYWQpXG4gICAgICAgICAgLm1hcCgocykgPT4gcHJlZml4U2VsZWN0b3IocywgcHJlZml4KSlcbiAgICAgICAgICAuam9pbignLCAnKTtcbiAgICAgICAgb3V0LnB1c2goYCR7c2VsZWN0b3JzfSB7JHtib2R5fX1gKTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2hhciA9PT0gJzsnICYmIHByZWx1ZGUudHJpbSgpLnN0YXJ0c1dpdGgoJ0AnKSkge1xuICAgICAgLy8gYEBpbXBvcnRgIC8gYEBjaGFyc2V0YCBcdTIwMTQgYSBzdGF0ZW1lbnQsIG5vdCBhIGJsb2NrLlxuICAgICAgb3V0LnB1c2goYCR7cHJlbHVkZS50cmltKCl9O2ApO1xuICAgICAgcHJlbHVkZSA9ICcnO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBwcmVsdWRlICs9IGNoYXI7XG4gICAgaW5kZXggKz0gMTtcbiAgfVxuICByZXR1cm4gb3V0LmpvaW4oJ1xcbicpO1xufVxuXG4vKiogVGhlIGRlc2lnbi10b2tlbiBmaWxlcywgaW4gdGhlIG9yZGVyIHRoZSB0aGVtZSBsb2FkcyB0aGVtLiAqL1xuY29uc3QgVE9LRU5fRklMRVMgPSBbJ2NvbG9ycy5jc3MnLCAndHlwb2dyYXBoeS5jc3MnLCAnc3BhY2luZy5jc3MnLCAnZWZmZWN0cy5jc3MnXTtcblxuLyoqXG4gKiBFdmVyeSBgLS10b2tlbjogdmFsdWVgIGRlY2xhcmVkIG9uIGA6cm9vdGAsIGFzIG9uZSBibG9jay5cbiAqXG4gKiBMaWdodCBvbmx5LCBhbmQgb25seSB0aGUgZmlyc3QgYDpyb290YCBvZiBlYWNoIGZpbGUgXHUyMDE0IHRoZSBkYXJrIG92ZXJyaWRlcyBsaXZlXG4gKiBiZWhpbmQgYFtkYXRhLXRoZW1lPVwiZGFya1wiXWAsIGEgc3dpdGNoIGFuIEVQVUIgaGFzIG5vIHdheSB0byB0aHJvdy4gQ3VzdG9tXG4gKiBwcm9wZXJ0aWVzIGluaGVyaXQsIHNvIGRlY2xhcmluZyB0aGVtIG9uIHRoZSB3cmFwcGVyIGlzIHRoZSBzYW1lIHJlc29sdXRpb24gdGhlXG4gKiBicm93c2VyIHBlcmZvcm1zLCB3aXRob3V0IHRvdWNoaW5nIGEgYDpyb290YCB0aGUgcmVhZGluZyBzeXN0ZW0gb3ducy5cbiAqL1xuZnVuY3Rpb24gdG9rZW5EZWNsYXJhdGlvbnMoc3JjRGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkZWNsYXJhdGlvbnM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZmlsZSBvZiBUT0tFTl9GSUxFUykge1xuICAgIGNvbnN0IGNzcyA9IHJlYWRGaWxlU3luYyhqb2luKHNyY0RpciwgJy52aXRlcHJlc3MvdGhlbWUvdG9rZW5zJywgZmlsZSksICd1dGY4JylcbiAgICAgIC5yZXBsYWNlKC9cXC9cXCpbXFxzXFxTXSo/XFwqXFwvL2csICcnKTtcbiAgICBjb25zdCByb290ID0gLzpyb290XFxzKlxceyhbXFxzXFxTXSo/KVxcfS8uZXhlYyhjc3MpO1xuICAgIGlmIChyb290KSBkZWNsYXJhdGlvbnMucHVzaChyb290WzFdIS50cmltKCkpO1xuICB9XG4gIHJldHVybiBkZWNsYXJhdGlvbnMuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICogVGhlIHN0eWxlc2hlZXQgZm9yIGEgc2V0IG9mIGZpZ3VyZXM6IHRoZSB0b2tlbnMgdGhleSByZXNvbHZlIGFnYWluc3QsIGEgY2FyZCB0b1xuICogc2l0IG9uLCBhbmQgZWFjaCBjb21wb25lbnQncyBvd24gc2NvcGVkIHJ1bGVzIGNvbmZpbmVkIHRvIGl0cyB3cmFwcGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlndXJlQ3NzKHNyY0Rpcjogc3RyaW5nLCBuYW1lczogc3RyaW5nW10pOiBzdHJpbmcge1xuICBjb25zdCB1bmlxdWUgPSBbLi4ubmV3IFNldChuYW1lcyldLnNvcnQoKTtcbiAgaWYgKHVuaXF1ZS5sZW5ndGggPT09IDApIHJldHVybiAnJztcbiAgY29uc3QgcGFydHMgPSBbXG4gICAgYC8qIEZpZ3VyZXMgXHUyMDE0IHRoZSBib29rJ3MgZGlhZ3JhbXMsIGZyb20gLnZpdGVwcmVzcy90aGVtZS9jb21wb25lbnRzLiAqL2AsXG4gICAgYC5maWd1cmUge1xcbiR7dG9rZW5EZWNsYXJhdGlvbnMoc3JjRGlyKX1cXG59YCxcbiAgICAvLyBBIGZpZ3VyZSBpcyBhIGNhcmQsIHNvIGEgcmVhZGVyIGluIG5pZ2h0IG1vZGUgZ2V0cyBhIHBpY3R1cmUgcGFpbnRlZCBvbiBpdHNcbiAgICAvLyBvd24gbGlnaHQgZ3JvdW5kIHJhdGhlciB0aGFuIG5lYXItYmxhY2sgc3Ryb2tlcyBvbiBhIG5lYXItYmxhY2sgcGFnZS5cbiAgICBgLmZpZ3VyZSB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UtY2FyZCk7IGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnkpO1xuICBwYWRkaW5nOiAxMHB4IDEycHg7IG1hcmdpbjogMS40ZW0gMDsgYm9yZGVyLXJhZGl1czogNnB4O1xuICBwYWdlLWJyZWFrLWluc2lkZTogYXZvaWQ7IGJyZWFrLWluc2lkZTogYXZvaWQ7IH1gLFxuICAgIGAuZmlndXJlIHN2ZyB7IGRpc3BsYXk6IGJsb2NrOyB3aWR0aDogMTAwJTsgaGVpZ2h0OiBhdXRvOyB9YCxcbiAgICBgLmZpZ3VyZSBwLCAuZmlndXJlIGgzIHsgbWFyZ2luOiAwOyB9YCxcbiAgXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHVuaXF1ZSkge1xuICAgIGNvbnN0IHNjb3BlZCA9IHNjb3BlZFN0eWxlKHNyY0RpciwgbmFtZSkudHJpbSgpO1xuICAgIGlmIChzY29wZWQpIHBhcnRzLnB1c2goc2NvcGVDc3Moc2NvcGVkLCBgLmZpZ3VyZS0tJHtuYW1lfWApLnRyaW0oKSk7XG4gIH1cbiAgcmV0dXJuIGAke3BhcnRzLmpvaW4oJ1xcblxcbicpfVxcbmA7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9lcHViLm10c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vVXNlcnMvbWFya3VzL1Byb2plY3RzL3ByaXZhdGUvc3Vic3RyYXQvLndvcmt0cmVlcy9mZWF0L3JlcXVlc3RzLXBhdGgtZmFjZXQtMjc2Mi9hcHBzL2RvY3MvLnZpdGVwcmVzcy9lcHViLm10c1wiOy8qKlxuICogVGhlIEVQVUIgZWRpdGlvbiBvZiB0aGUgYm9vayAoIzE0MDEpIFx1MjAxNCBgL2Jvb2suZXB1YmAsIG9uZSBmaWxlIHRoYXQgb3BlbnMgaW4gQXBwbGVcbiAqIEJvb2tzLCBLb2JvLCBDYWxpYnJlIG9yIGFueXRoaW5nIGVsc2UgdGhhdCByZWFkcyBFUFVCIDMuXG4gKlxuICogYGJvb2sudHh0YCBhbmQgYGJvb2svcmVhZC5odG1sYCBhbHJlYWR5IGV4aXN0LCBhbmQgbmVpdGhlciBpcyBhIGJvb2sgb24gYSBwaG9uZTpcbiAqIGEgcmVhZGVyIHdhbnRzIGEgdGFibGUgb2YgY29udGVudHMgaXQgY2FuIGp1bXAgYXJvdW5kIGluLCByZW1lbWJlcmVkIHBvc2l0aW9uLFxuICogYWRqdXN0YWJsZSB0eXBlLCBhbmQgYSBjb3ZlciBpbiBpdHMgbGlicmFyeS4gVGhhdCBpcyBhIHBhY2thZ2luZyBmb3JtYXQsIG5vdCBhXG4gKiBiaWdnZXIgSFRNTCBmaWxlLCBzbyB0aGlzIGJ1aWxkcyBhIHJlYWwgb25lLlxuICpcbiAqICMjIFdoYXQgYW4gRVBVQiBhY3R1YWxseSBpc1xuICpcbiAqIEEgemlwIHdpdGggcnVsZXMuIFRoZSBvbmVzIHRoYXQgYml0ZSwgYWxsIG9mIHdoaWNoIGFyZSBlbmZvcmNlZCBiZWxvdzpcbiAqXG4gKiAgIDEuIGBtaW1ldHlwZWAgTVVTVCBiZSB0aGUgRklSU1QgZW50cnkgYW5kIE1VU1QgYmUgU1RPUkVELCBub3QgZGVmbGF0ZWQuIEEgcmVhZGVyXG4gKiAgICAgIHNuaWZmcyB0aGUgZmlsZSBieSByZWFkaW5nIHRob3NlIGJ5dGVzIGF0IGEgZml4ZWQgb2Zmc2V0LCBzbyBhIGNvbXByZXNzZWQgb3JcbiAqICAgICAgbGF0ZXItcGxhY2VkIGBtaW1ldHlwZWAgaXMgbm90IGEgdmFsaWQgRVBVQiBldmVuIHRob3VnaCBldmVyeSBmaWxlIGlzIHByZXNlbnQuXG4gKiAgIDIuIENvbnRlbnQgZG9jdW1lbnRzIGFyZSBYSFRNTCBcdTIwMTQgKipYTUwqKiwgbm90IEhUTUw1LiBBbiB1bmNsb3NlZCBgPGJyPmAgaXMgYVxuICogICAgICBwYXJzZSBlcnJvciwgbm90IGEgdG9sZXJhdGVkIHNsb3BwaW5lc3MsIGFuZCB0aGUgZmFpbHVyZSBtb2RlIGluIGEgcmVhZGVyIGlzIGFcbiAqICAgICAgYmxhbmsgY2hhcHRlciByYXRoZXIgdGhhbiBhIG1lc3NhZ2UuIGBtYXJrZG93bi1pdGAncyBgeGh0bWxPdXRgIGlzIHdoYXQga2VlcHNcbiAqICAgICAgdGhlIHJlbmRlcmVkIG1hcmtkb3duIG9uIHRoZSByaWdodCBzaWRlIG9mIHRoYXQuXG4gKiAgIDMuIEV2ZXJ5IGZpbGUgaW4gdGhlIHppcCBtdXN0IGJlIGRlY2xhcmVkIGluIHRoZSBwYWNrYWdlIG1hbmlmZXN0LCBhbmQgZXZlcnlcbiAqICAgICAgcmVhZGFibGUgZG9jdW1lbnQgbXVzdCBhcHBlYXIgaW4gdGhlIHNwaW5lLCBpbiByZWFkaW5nIG9yZGVyLlxuICpcbiAqICMjIFRoZSBmaWd1cmVzXG4gKlxuICogRml2ZSBjaGFwdGVycyBkcmF3IG9uZS4gT24gdGhlIHdlYiB0aGV5IGFyZSBWdWUgY29tcG9uZW50cywgYW5kIGV2ZXJ5IG90aGVyXG4gKiBlZGl0aW9uIG9mIHRoZSBib29rIGZsYXR0ZW5zIHRoZW0gdG8gdGhlIHByb3NlIHR3aW4gYmVzaWRlIHRoZW0gXHUyMDE0IHJpZ2h0IGZvclxuICogYGxsbXMudHh0YCwgd3JvbmcgZm9yIGEgcmVhZGVyIGhvbGRpbmcgYSBwaG9uZSwgd2hlcmUgdGhlIHNoYXBlIGlzIHN1cHBvc2VkIHRvXG4gKiBhcnJpdmUgYmVmb3JlIHRoZSBzZW50ZW5jZS4gU28gdGhlIEVQVUIgY2FycmllcyB0aGUgcGljdHVyZTogdGhlIHNhbWUgY29tcG9uZW50cyxcbiAqIHNlcnZlci1yZW5kZXJlZCB0byBYSFRNTCB3aXRoIHRoZWlyIG93biBzdHlsZXNoZWV0cyBmb2xkZWQgaW50byBgc3R5bGUuY3NzYC4gU2VlXG4gKiBgZmlndXJlcy5tdHNgLCB3aGljaCBpcyBhbHNvIHdoZXJlIHRoZSBYTUwgcnVsZXMgYWJvdmUgbWVldCBWdWUncyBIVE1MIG91dHB1dC5cbiAqXG4gKiAjIyBXaHkgaXQgaXMgZ2VuZXJhdGVkIGFuZCBub3QgY2hlY2tlZCBpblxuICpcbiAqIFNhbWUgcmVhc29uIGFzIHRoZSBvdGhlciB0d28gZWRpdGlvbnMgKGJvb2subXRzKTogYSBjb21taXR0ZWQgYC5lcHViYCBpcyBhIHNlY29uZCxcbiAqIGRyaWZ0aW5nIHRyYW5zY3JpcHQgb2YgZXZlcnkgY2hhcHRlciwgYW5kIGEgYmluYXJ5IG9uZSBub2JvZHkgY2FuIHJldmlldyBpbiBhXG4gKiBkaWZmLiBJdCBpcyBidWlsdCBpbiBgYnVpbGRFbmRgIGZyb20gYGJvb2tQYWdlcygpYCBcdTIwMTQgdGhlIHNhbWUgbGlzdCB0aGUgbmF2IHJlbmRlcnNcbiAqIFx1MjAxNCBzbyBpdCBjYW5ub3QgY29udGFpbiBhIGRpZmZlcmVudCBib29rIGZyb20gdGhlIG9uZSBvbiB0aGUgc2l0ZS5cbiAqXG4gKiBUaGUgY292ZXIgaXMgdGhlIG9uZSBleGNlcHRpb24sIGFuZCBkZWxpYmVyYXRlbHkgc286IGBFUFVCL2NvdmVyLnBuZ2AgaXMgYSBjaGVja2VkLWluXG4gKiAqKmFzc2V0KiogKGBhcHBzL2RvY3MvYXNzZXRzL2Jvb2stY292ZXIucG5nYCksIG5vdCBhIGdlbmVyYXRlZCBmaWxlLiBJdCBjYXJyaWVzIG5vXG4gKiBHRU5FUkFURUQgaGVhZGVyIGFuZCBjbGFpbXMgbm8gZ2F0ZSwgYmVjYXVzZSBpdCBpcyBhcnQgcmF0aGVyIHRoYW4gYSBkZXJpdmF0aW9uIFx1MjAxNFxuICogdGhlIHNhbWUgY2F0ZWdvcnkgYXMgYSBsb2dvLiBgYXNzZXRzL2Jvb2stY292ZXIuc3ZnYCBiZXNpZGUgaXQgaXMgd2hhdCBpdCB3YXMgZHJhd25cbiAqIGZyb20sIGFuZCBgcG5wbSAtLWZpbHRlciBAc3Vic3RyYXQtcnVuL2RvY3MgY292ZXJgIHJlLXJlbmRlcnMgb25lIGZyb20gdGhlIG90aGVyIHdpdGhcbiAqIGByc3ZnLWNvbnZlcnRgLiBUaGF0IGlzIGEgdG9vbCBub2JvZHkncyBDSSBoYXMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoaXMgaXMgYW4gYXNzZXRcbiAqIHBhaXIgYSBodW1hbiBtYWludGFpbnMgYW5kIG5vdCBhIGJ1aWxkIHN0ZXAgdGhhdCB3b3VsZCBiZSByZWQgZXZlcnl3aGVyZSBidXQgaGVyZS5cbiAqL1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHppcFN5bmMsIHN0clRvVTggfSBmcm9tICdmZmxhdGUnO1xuaW1wb3J0IE1hcmtkb3duSXQgZnJvbSAnbWFya2Rvd24taXQnO1xuaW1wb3J0IHsgYm9va1BhZ2VzLCB0eXBlIEJvb2tQYWdlIH0gZnJvbSAnLi9ib29rLm1qcyc7XG5pbXBvcnQgeyBTSVRFLCBhbHRUd2luLCB0eXBlIEFydGlmYWN0LCB0eXBlIENvbXBvbmVudFR3aW4gfSBmcm9tICcuL2xsbXMubWpzJztcbmltcG9ydCB7XG4gIGNvbXBvbmVudE9mLFxuICBmaWd1cmVDc3MsXG4gIGZpZ3VyZUtleSxcbiAgcmVuZGVyRmlndXJlcyxcbiAgdHlwZSBGaWd1cmVSZXF1ZXN0LFxuICB0eXBlIEZpZ3VyZVNldCxcbn0gZnJvbSAnLi9maWd1cmVzLm1qcyc7XG5cbmNvbnN0IFRJVExFID0gJ1N1YnN0cmF0LCBlbmQgdG8gZW5kJztcbmNvbnN0IEFVVEhPUiA9ICdTdWJzdHJhdCc7XG5jb25zdCBMQU5HVUFHRSA9ICdlbic7XG5cbi8qKlxuICogVGhlIGJvb2sncyBpZGVudGl0eSwgYXMgcmVhZGVycyB1c2UgaXQuXG4gKlxuICogQSBzdGFibGUgVVJOIHJhdGhlciB0aGFuIGEgZnJlc2ggVVVJRCBwZXIgYnVpbGQ6IGEgcmVhZGVyIGtleWVkIG9uIHRoZSBpZGVudGlmaWVyXG4gKiB0cmVhdHMgYSBjaGFuZ2VkIG9uZSBhcyBhIERJRkZFUkVOVCBib29rLCBzbyByZS1kb3dubG9hZGluZyBhZnRlciBhIGRvY3MgdXBkYXRlXG4gKiB3b3VsZCBzaGVsdmUgYSBzZWNvbmQgY29weSBiZXNpZGUgdGhlIGZpcnN0IGFuZCBsb3NlIHRoZSByZWFkZXIncyBwb3NpdGlvbiBpbiBpdC5cbiAqIFRoZSBlZGl0aW9uIG1vdmVzIGluIGBkY3Rlcm1zOm1vZGlmaWVkYCBpbnN0ZWFkLCB3aGljaCBpcyB3aGF0IHRoYXQgZmllbGQgaXMgZm9yLlxuICovXG5jb25zdCBCT09LX0lEID0gJ3Vybjp1dWlkOjVmM2I5YzYyLThhNGUtNGQxNy05ZjIxLTdjNmUwYjJhNGQ4Myc7XG5cbi8qKiBYTUwgdGV4dCBlc2NhcGUuIEF0dHJpYnV0ZSB2YWx1ZXMgZ28gdGhyb3VnaCB0aGUgc2FtZSBvbmUgXHUyMDE0IGBcImAgaXMgY292ZXJlZC4gKi9cbmNvbnN0IHhtbCA9IChzOiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgcy5yZXBsYWNlKC8mL2csICcmYW1wOycpLnJlcGxhY2UoLzwvZywgJyZsdDsnKS5yZXBsYWNlKC8+L2csICcmZ3Q7JykucmVwbGFjZSgvXCIvZywgJyZxdW90OycpO1xuXG4vKipcbiAqIGB4aHRtbE91dGAgaXMgdGhlIHdob2xlIHJlYXNvbiB0aGlzIHJlbmRlcmVyIGlzIHNlcGFyYXRlIGZyb20gdGhlIG9uZSBpbiBib29rLm10czpcbiAqIGl0IGNsb3NlcyB2b2lkIGVsZW1lbnRzIChgPGJyIC8+YCwgYDxociAvPmApLCB3aXRob3V0IHdoaWNoIGEgY2hhcHRlciBpcyBhbiBYTUxcbiAqIHBhcnNlIGVycm9yIGFuZCBhIHJlYWRlciBzaG93cyBub3RoaW5nIGF0IGFsbC5cbiAqXG4gKiBgbGlua2lmeWAgaXMgT0ZGLCBhbmQgdGhhdCBpcyBhIGZpeCByYXRoZXIgdGhhbiBhIGRlZmF1bHQuIEl0IHJlYWRzIGEgYmFyZSB0b2tlblxuICogbGlrZSBgUEVSTUlTU0lPTlMubWRgIGFzIGEgaG9zdG5hbWUgXHUyMDE0IGAubWRgIGlzIE1vbGRvdmEgXHUyMDE0IGFuZCBzaGlwcyBhIGxpbmsgdG8gYVxuICogZG9tYWluIG5vYm9keSBvd25zLiBUaGUgYm9vaydzIG93biBsaW5rcyBhcmUgYWxsIGV4cGxpY2l0IG1hcmtkb3duLCBzbyBhdXRvbGlua2luZ1xuICogY291bGQgb25seSBldmVyIGludmVudCBvbmU7IHRoZSBmbGF0dGVuZWQgcHJvc2Ugb2YgYDxQZXJtaXNzaW9uUGlwZWxpbmUgLz5gIGlzIHdoZXJlXG4gKiBpdCBkaWQuXG4gKi9cbmNvbnN0IG1kID0gbmV3IE1hcmtkb3duSXQoeyBodG1sOiB0cnVlLCB4aHRtbE91dDogdHJ1ZSwgbGlua2lmeTogZmFsc2UsIHR5cG9ncmFwaGVyOiBmYWxzZSB9KTtcblxuLyoqIGAwNS1vbmUtZXZlbnRgIFx1MjE5MiBgdGV4dC8wNS1vbmUtZXZlbnQueGh0bWxgOyB0aGUgZnJvbnQgbWF0dGVyIGtlZXBzIGl0cyBvd24gbmFtZS4gKi9cbmNvbnN0IGZpbGVGb3IgPSAocGFnZTogQm9va1BhZ2UpOiBzdHJpbmcgPT4gYHRleHQvJHtwYWdlLnNsdWd9LnhodG1sYDtcblxuLyoqXG4gKiBUaGUgbWFuaWZlc3QgaWQgZm9yIGEgY2hhcHRlci5cbiAqXG4gKiBUaGUgYGNoLWAgcHJlZml4IGlzIG5vdCBkZWNvcmF0aW9uLiBBIG1hbmlmZXN0IGBpZGAgaXMgYW4gWE1MIGBJRGAsIGFuZCBhbiBYTUwgbmFtZVxuICogKiptYXkgbm90IHN0YXJ0IHdpdGggYSBkaWdpdCoqIFx1MjAxNCBzbyBgMDEtd2h5LWEtc3Vic3RyYXRlYCwgdGhlIG9idmlvdXMgaWQsIGlzIGludmFsaWQsXG4gKiBhbmQgYW4gRVBVQiB3aG9zZSBwYWNrYWdlIGRvY3VtZW50IGZhaWxzIHRvIHBhcnNlIGlzIG9uZSBBcHBsZSBCb29rcyBzaWxlbnRseVxuICogZGVjbGluZXMgdG8gb3Blbi4gVGVuIGNoYXB0ZXJzIGFyZSBudW1iZXJlZCwgc28gdGVuIGlkcyB3ZXJlIHdyb25nLlxuICpcbiAqIEEgc3RyaWN0IFhNTCBwYXJzZXIgZG9lcyBub3QgY2F0Y2ggdGhpczogYGlkYCBpcyBvbmx5IGFuIGBJRGAgYnkgdmlydHVlIG9mIHRoZSBPUEZcbiAqIHNjaGVtYSwgYW5kIHdlbGwtZm9ybWVkbmVzcyBoYXMgbm90aGluZyB0byBzYXkgYWJvdXQgaXQuIGBpZE9mYCBpcyB0aGVyZWZvcmUgdGhlIG9uZVxuICogcGxhY2UgaWRzIGFyZSBtaW50ZWQsIGFuZCBgdGVzdC9lcHViLnRlc3QubXRzYCBob2xkcyBldmVyeSBpZCBpbiB0aGUgcGFja2FnZSBkb2N1bWVudFxuICogdG8gdGhlIFhNTCBuYW1lIHByb2R1Y3Rpb24gZGlyZWN0bHkuXG4gKi9cbmNvbnN0IGlkT2YgPSAocGFnZTogQm9va1BhZ2UpOiBzdHJpbmcgPT4gYGNoLSR7cGFnZS5zbHVnfWA7XG5cbi8qKlxuICogRml4IHVwIHRoZSB0d2luJ3MgbGlua3MgZm9yIGEgcmVhZGVyIGhvbGRpbmcgYSBwaG9uZS5cbiAqXG4gKiBgdG9Ud2luYCBtYWtlcyBldmVyeSBsaW5rIGFic29sdXRlIGFuZCBwb2ludHMgaXQgYXQgdGhlIGAubWRgIHR3aW4uIEJvdGggYXJlIHJpZ2h0XG4gKiBmb3IgYGJvb2sudHh0YCBcdTIwMTQgYSByZWFkZXIgb2YgdGhhdCBmaWxlIGhhcyBubyBzaXRlIHJvb3QsIGFuZCB3YW50cyBtYXJrZG93biB3aGVuIGl0XG4gKiBmb2xsb3dzIGEgbGluay4gQm90aCBhcmUgd3JvbmcgaGVyZSwgaW4gZGlmZmVyZW50IHdheXM6XG4gKlxuICogICAtIEEgY3Jvc3MtcmVmZXJlbmNlIHRvIGFub3RoZXIgKipjaGFwdGVyKiogc2hvdWxkIHR1cm4gdGhlIHBhZ2UsIG5vdCBsZWF2ZSBmb3JcbiAqICAgICBTYWZhcmkuIFRob3NlIGJlY29tZSByZWxhdGl2ZSBgLnhodG1sYCBsaW5rcywgd2hpY2ggaXMgd2h5IHRoZSBFUFVCIGtlZXBzIG9uZVxuICogICAgIGZpbGUgcGVyIGNoYXB0ZXIgcmF0aGVyIHRoYW4gb25lIGxvbmcgZG9jdW1lbnQuXG4gKiAgIC0gQSBsaW5rICoqb3V0Kiogb2YgdGhlIGJvb2sgKGAvY29uY2VwdHMvbW9kZWxgKSBnZW51aW5lbHkgZG9lcyBnbyB0byB0aGUgd2ViLCBidXRcbiAqICAgICB0byB0aGUgKnBhZ2UqIFx1MjAxNCBhIGh1bWFuIHRhcHBpbmcgaXQgd2FudHMgdGhlIHJlbmRlcmVkIGFydGljbGUsIG5vdCB0aGUgcmF3XG4gKiAgICAgbWFya2Rvd24gdHdpbi4gU28gdGhlIGAubWRgIGNvbWVzIG9mZi5cbiAqXG4gKiBgL2Jvb2sudHh0YCBhbmQgYC9ib29rL3JlYWQuaHRtbGAgc3Vydml2ZSBib3RoIHJ1bGVzIGludGFjdDogdGhleSBhcmUgdGhlIG90aGVyXG4gKiBlZGl0aW9ucywgdGhleSByZWFsbHkgZG8gbGl2ZSBvbiB0aGUgd2ViLCBhbmQgbmVpdGhlciBpcyBpbnNpZGUgdGhpcyBmaWxlLlxuICovXG5mdW5jdGlvbiByZWxpbmtGb3JFcHViKGh0bWw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBodG1sXG4gICAgLnJlcGxhY2UoXG4gICAgICBuZXcgUmVnRXhwKGAke1NJVEV9L2Jvb2svKFthLXowLTktXSspXFxcXC5tZGAsICdnJyksXG4gICAgICAoX20sIHNsdWc6IHN0cmluZykgPT4gYCR7c2x1Z30ueGh0bWxgLFxuICAgIClcbiAgICAucmVwbGFjZShuZXcgUmVnRXhwKGAke1NJVEV9L2Jvb2svaW5kZXhcXFxcLm1kYCwgJ2cnKSwgJ2luZGV4LnhodG1sJylcbiAgICAucmVwbGFjZShuZXcgUmVnRXhwKGAoJHtTSVRFfS9bXlwiJ10qPylcXFxcLm1kKD89W1wiJyNdKWAsICdnJyksICckMScpO1xufVxuXG4vKiogT25lIGNoYXB0ZXIgYXMgYW4gWEhUTUwgZG9jdW1lbnQuICovXG5mdW5jdGlvbiBjaGFwdGVyRG9jKHBhZ2U6IEJvb2tQYWdlKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiPz5cbjwhRE9DVFlQRSBodG1sPlxuPGh0bWwgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIgeG1sbnM6ZXB1Yj1cImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcHNcIiBsYW5nPVwiJHtMQU5HVUFHRX1cIiB4bWw6bGFuZz1cIiR7TEFOR1VBR0V9XCI+XG48aGVhZD5cbjxtZXRhIGNoYXJzZXQ9XCJVVEYtOFwiLz5cbjx0aXRsZT4ke3htbChwYWdlLnRleHQpfTwvdGl0bGU+XG48bGluayByZWw9XCJzdHlsZXNoZWV0XCIgdHlwZT1cInRleHQvY3NzXCIgaHJlZj1cIi4uL3N0eWxlLmNzc1wiLz5cbjwvaGVhZD5cbjxib2R5IGVwdWI6dHlwZT1cIiR7cGFnZS5zbHVnID09PSAnaW5kZXgnID8gJ2Zyb250bWF0dGVyJyA6ICdib2R5bWF0dGVyJ31cIj5cbjxzZWN0aW9uIGVwdWI6dHlwZT1cImNoYXB0ZXJcIj5cbiR7cmVsaW5rRm9yRXB1YihtZC5yZW5kZXIocGFnZS5tYXJrZG93bikpfVxuPC9zZWN0aW9uPlxuPC9ib2R5PlxuPC9odG1sPlxuYDtcbn1cblxuLyoqIFRoZSB0aXRsZSBwYWdlIFx1MjAxNCB0aGUgZmlyc3QgdGhpbmcgdGhlIHJlYWRlciBzZWVzIG9uIG9wZW5pbmcuICovXG5mdW5jdGlvbiB0aXRsZVBhZ2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiPz5cbjwhRE9DVFlQRSBodG1sPlxuPGh0bWwgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIgeG1sbnM6ZXB1Yj1cImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcHNcIiBsYW5nPVwiJHtMQU5HVUFHRX1cIiB4bWw6bGFuZz1cIiR7TEFOR1VBR0V9XCI+XG48aGVhZD5cbjxtZXRhIGNoYXJzZXQ9XCJVVEYtOFwiLz5cbjx0aXRsZT4ke3htbChUSVRMRSl9PC90aXRsZT5cbjxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwic3R5bGUuY3NzXCIvPlxuPC9oZWFkPlxuPGJvZHkgZXB1Yjp0eXBlPVwiZnJvbnRtYXR0ZXJcIj5cbjxzZWN0aW9uIGVwdWI6dHlwZT1cInRpdGxlcGFnZVwiIGNsYXNzPVwidGl0bGVwYWdlXCI+XG48aDEgY2xhc3M9XCJib29rdGl0bGVcIj5TdWJzdHJhdCw8YnIvPmVuZCB0byBlbmQ8L2gxPlxuPHAgY2xhc3M9XCJzdWJ0aXRsZVwiPkhvdyB0aGUgcGllY2VzIGpvaW4gXHUyMDE0IHRoaXJ0ZWVuIGNoYXB0ZXJzLCBmcm9udCB0byBiYWNrLjwvcD5cbjxwIGNsYXNzPVwiaW1wcmludFwiPiR7eG1sKFNJVEUpfTwvcD5cbjwvc2VjdGlvbj5cbjwvYm9keT5cbjwvaHRtbD5cbmA7XG59XG5cbi8qKiBUaGUgRVBVQiAzIG5hdmlnYXRpb24gZG9jdW1lbnQuIERvdWJsZXMgYXMgdGhlIHJlYWRlcidzIHRhYmxlIG9mIGNvbnRlbnRzLiAqL1xuZnVuY3Rpb24gbmF2RG9jKHBhZ2VzOiBCb29rUGFnZVtdKTogc3RyaW5nIHtcbiAgY29uc3QgaXRlbXMgPSBwYWdlc1xuICAgIC5tYXAoKHApID0+IGAgICAgICA8bGk+PGEgaHJlZj1cIiR7ZmlsZUZvcihwKX1cIj4ke3htbChwLnRleHQpfTwvYT48L2xpPmApXG4gICAgLmpvaW4oJ1xcbicpO1xuICByZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxuPCFET0NUWVBFIGh0bWw+XG48aHRtbCB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIiB4bWxuczplcHViPVwiaHR0cDovL3d3dy5pZHBmLm9yZy8yMDA3L29wc1wiIGxhbmc9XCIke0xBTkdVQUdFfVwiIHhtbDpsYW5nPVwiJHtMQU5HVUFHRX1cIj5cbjxoZWFkPlxuPG1ldGEgY2hhcnNldD1cIlVURi04XCIvPlxuPHRpdGxlPkNvbnRlbnRzPC90aXRsZT5cbjxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwic3R5bGUuY3NzXCIvPlxuPC9oZWFkPlxuPGJvZHk+XG48bmF2IGVwdWI6dHlwZT1cInRvY1wiIGlkPVwidG9jXCIgY2xhc3M9XCJ0b2NcIj5cbiAgPGgxPkNvbnRlbnRzPC9oMT5cbiAgPG9sPlxuJHtpdGVtc31cbiAgPC9vbD5cbjwvbmF2PlxuPG5hdiBlcHViOnR5cGU9XCJsYW5kbWFya3NcIiBoaWRkZW49XCJoaWRkZW5cIj5cbiAgPG9sPlxuICAgIDxsaT48YSBlcHViOnR5cGU9XCJ0b2NcIiBocmVmPVwibmF2LnhodG1sXCI+Q29udGVudHM8L2E+PC9saT5cbiAgICA8bGk+PGEgZXB1Yjp0eXBlPVwiYm9keW1hdHRlclwiIGhyZWY9XCIke2ZpbGVGb3IocGFnZXNbMV0hKX1cIj5TdGFydCBvZiBjb250ZW50PC9hPjwvbGk+XG4gIDwvb2w+XG48L25hdj5cbjwvYm9keT5cbjwvaHRtbD5cbmA7XG59XG5cbi8qKlxuICogVGhlIEVQVUIgMiBuYXZpZ2F0aW9uIG1hcC5cbiAqXG4gKiBFUFVCIDMgcmVwbGFjZWQgaXQgd2l0aCBgbmF2LnhodG1sYCBhYm92ZSwgYW5kIGl0IGlzIGluY2x1ZGVkIGFueXdheSBiZWNhdXNlXG4gKiBzZXZlcmFsIHNoaXBwaW5nIHJlYWRlcnMgc3RpbGwgbG9vayBmb3IgaXQgZmlyc3QgYW5kIHNob3cgYW4gZW1wdHkgdGFibGUgb2ZcbiAqIGNvbnRlbnRzIHdoZW4gaXQgaXMgYWJzZW50LiBJdCBjb3N0cyBhIGtpbG9ieXRlLlxuICovXG5mdW5jdGlvbiBuY3hEb2MocGFnZXM6IEJvb2tQYWdlW10pOiBzdHJpbmcge1xuICBjb25zdCBwb2ludHMgPSBwYWdlc1xuICAgIC5tYXAoXG4gICAgICAocCwgaSkgPT4gYCAgPG5hdlBvaW50IGlkPVwibmF2JHtpICsgMX1cIiBwbGF5T3JkZXI9XCIke2kgKyAxfVwiPlxuICAgIDxuYXZMYWJlbD48dGV4dD4ke3htbChwLnRleHQpfTwvdGV4dD48L25hdkxhYmVsPlxuICAgIDxjb250ZW50IHNyYz1cIiR7ZmlsZUZvcihwKX1cIi8+XG4gIDwvbmF2UG9pbnQ+YCxcbiAgICApXG4gICAgLmpvaW4oJ1xcbicpO1xuICByZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxuPG5jeCB4bWxucz1cImh0dHA6Ly93d3cuZGFpc3kub3JnL3ozOTg2LzIwMDUvbmN4L1wiIHZlcnNpb249XCIyMDA1LTFcIj5cbjxoZWFkPlxuICA8bWV0YSBuYW1lPVwiZHRiOnVpZFwiIGNvbnRlbnQ9XCIke0JPT0tfSUR9XCIvPlxuICA8bWV0YSBuYW1lPVwiZHRiOmRlcHRoXCIgY29udGVudD1cIjFcIi8+XG4gIDxtZXRhIG5hbWU9XCJkdGI6dG90YWxQYWdlQ291bnRcIiBjb250ZW50PVwiMFwiLz5cbiAgPG1ldGEgbmFtZT1cImR0YjptYXhQYWdlTnVtYmVyXCIgY29udGVudD1cIjBcIi8+XG48L2hlYWQ+XG48ZG9jVGl0bGU+PHRleHQ+JHt4bWwoVElUTEUpfTwvdGV4dD48L2RvY1RpdGxlPlxuPG5hdk1hcD5cbiR7cG9pbnRzfVxuPC9uYXZNYXA+XG48L25jeD5cbmA7XG59XG5cbi8qKiBUaGUgcGFja2FnZSBkb2N1bWVudDogbWV0YWRhdGEsIGV2ZXJ5IGZpbGUgaW4gdGhlIHppcCwgYW5kIHRoZSByZWFkaW5nIG9yZGVyLiAqL1xuZnVuY3Rpb24gcGFja2FnZURvYyhwYWdlczogQm9va1BhZ2VbXSwgbW9kaWZpZWQ6IHN0cmluZywgaGFzQ292ZXI6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBjaGFwdGVySXRlbXMgPSBwYWdlc1xuICAgIC5tYXAoXG4gICAgICAocCkgPT5cbiAgICAgICAgYCAgICA8aXRlbSBpZD1cIiR7aWRPZihwKX1cIiBocmVmPVwiJHtmaWxlRm9yKHApfVwiIG1lZGlhLXR5cGU9XCJhcHBsaWNhdGlvbi94aHRtbCt4bWxcIi8+YCxcbiAgICApXG4gICAgLmpvaW4oJ1xcbicpO1xuICBjb25zdCBzcGluZSA9IHBhZ2VzLm1hcCgocCkgPT4gYCAgICA8aXRlbXJlZiBpZHJlZj1cIiR7aWRPZihwKX1cIi8+YCkuam9pbignXFxuJyk7XG4gIHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIj8+XG48cGFja2FnZSB4bWxucz1cImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcGZcIiB2ZXJzaW9uPVwiMy4wXCIgdW5pcXVlLWlkZW50aWZpZXI9XCJib29rLWlkXCIgeG1sOmxhbmc9XCIke0xBTkdVQUdFfVwiPlxuICA8bWV0YWRhdGEgeG1sbnM6ZGM9XCJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xL1wiPlxuICAgIDxkYzppZGVudGlmaWVyIGlkPVwiYm9vay1pZFwiPiR7Qk9PS19JRH08L2RjOmlkZW50aWZpZXI+XG4gICAgPGRjOnRpdGxlPiR7eG1sKFRJVExFKX08L2RjOnRpdGxlPlxuICAgIDxkYzpjcmVhdG9yPiR7eG1sKEFVVEhPUil9PC9kYzpjcmVhdG9yPlxuICAgIDxkYzpsYW5ndWFnZT4ke0xBTkdVQUdFfTwvZGM6bGFuZ3VhZ2U+XG4gICAgPGRjOnB1Ymxpc2hlcj4ke3htbChBVVRIT1IpfTwvZGM6cHVibGlzaGVyPlxuICAgIDxkYzpkZXNjcmlwdGlvbj5Ib3cgU3Vic3RyYXQgd29ya3MsIGVuZCB0byBlbmQ6IHRoZSBwYXRoIG9mIG9uZSByZXF1ZXN0LCB0aGUgbGlmZSBvZiBvbmUgZXZlbnQsIHRoZSB0d28gY2xvY2tzLCBhbmQgZXZlcnl0aGluZyBhIHJlZmVyZW5jZSBwYWdlIGNhbm5vdCBzYXkgYWJvdXQgaG93IHRoZSBwaWVjZXMgam9pbi48L2RjOmRlc2NyaXB0aW9uPlxuICAgIDxkYzpzb3VyY2U+JHt4bWwoYCR7U0lURX0vYm9vay9gKX08L2RjOnNvdXJjZT5cbiAgICA8bWV0YSBwcm9wZXJ0eT1cImRjdGVybXM6bW9kaWZpZWRcIj4ke21vZGlmaWVkfTwvbWV0YT5cbiR7aGFzQ292ZXIgPyAnICAgIDxtZXRhIG5hbWU9XCJjb3ZlclwiIGNvbnRlbnQ9XCJjb3Zlci1pbWFnZVwiLz5cXG4nIDogJyd9ICA8L21ldGFkYXRhPlxuICA8bWFuaWZlc3Q+XG4gICAgPGl0ZW0gaWQ9XCJuYXZcIiBocmVmPVwibmF2LnhodG1sXCIgbWVkaWEtdHlwZT1cImFwcGxpY2F0aW9uL3hodG1sK3htbFwiIHByb3BlcnRpZXM9XCJuYXZcIi8+XG4gICAgPGl0ZW0gaWQ9XCJuY3hcIiBocmVmPVwidG9jLm5jeFwiIG1lZGlhLXR5cGU9XCJhcHBsaWNhdGlvbi94LWR0Ym5jeCt4bWxcIi8+XG4gICAgPGl0ZW0gaWQ9XCJzdHlsZVwiIGhyZWY9XCJzdHlsZS5jc3NcIiBtZWRpYS10eXBlPVwidGV4dC9jc3NcIi8+XG4gICAgPGl0ZW0gaWQ9XCJ0aXRsZXBhZ2VcIiBocmVmPVwidGl0bGVwYWdlLnhodG1sXCIgbWVkaWEtdHlwZT1cImFwcGxpY2F0aW9uL3hodG1sK3htbFwiLz5cbiR7aGFzQ292ZXIgPyAnICAgIDxpdGVtIGlkPVwiY292ZXItaW1hZ2VcIiBocmVmPVwiY292ZXIucG5nXCIgbWVkaWEtdHlwZT1cImltYWdlL3BuZ1wiIHByb3BlcnRpZXM9XCJjb3Zlci1pbWFnZVwiLz5cXG4nIDogJyd9JHtjaGFwdGVySXRlbXN9XG4gIDwvbWFuaWZlc3Q+XG4gIDxzcGluZSB0b2M9XCJuY3hcIj5cbiAgICA8aXRlbXJlZiBpZHJlZj1cInRpdGxlcGFnZVwiLz5cbiAgICA8aXRlbXJlZiBpZHJlZj1cIm5hdlwiLz5cbiR7c3BpbmV9XG4gIDwvc3BpbmU+XG48L3BhY2thZ2U+XG5gO1xufVxuXG4vKiogVGhlIHJlYWRpbmcgc3R5bGVzaGVldC4gUmVzdHJhaW5lZCBvbiBwdXJwb3NlIFx1MjAxNCB0aGUgcmVhZGVyIG93bnMgdHlwZSBzaXplIGFuZCB0aGVtZS4gKi9cbmNvbnN0IFNUWUxFID0gYEBuYW1lc3BhY2UgZXB1YiBcImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcHNcIjtcblxuYm9keSB7IG1hcmdpbjogMCA1JTsgbGluZS1oZWlnaHQ6IDEuNTsgd2lkb3dzOiAyOyBvcnBoYW5zOiAyOyB9XG5oMSwgaDIsIGgzLCBoNCB7IGxpbmUtaGVpZ2h0OiAxLjI1OyBtYXJnaW46IDEuNmVtIDAgMC42ZW07IHBhZ2UtYnJlYWstYWZ0ZXI6IGF2b2lkOyB9XG5oMSB7IGZvbnQtc2l6ZTogMS42ZW07IG1hcmdpbi10b3A6IDA7IH1cbmgyIHsgZm9udC1zaXplOiAxLjI1ZW07IH1cbmgzIHsgZm9udC1zaXplOiAxLjA4ZW07IH1cbnAgeyBtYXJnaW46IDAgMCAwLjllbTsgdGV4dC1hbGlnbjogbGVmdDsgfVxuYSB7IHRleHQtZGVjb3JhdGlvbjogdW5kZXJsaW5lOyB9XG5jb2RlLCBwcmUgeyBmb250LWZhbWlseTogXCJTRiBNb25vXCIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlOyB9XG5jb2RlIHsgZm9udC1zaXplOiAwLjg1ZW07IH1cbnByZSB7IGZvbnQtc2l6ZTogMC43MmVtOyBsaW5lLWhlaWdodDogMS40OyBwYWRkaW5nOiAwLjdlbTsgbWFyZ2luOiAwIDAgMWVtO1xuICAgICAgYmFja2dyb3VuZDogcmdiYSgxMjcsMTI3LDEyNywwLjEyKTsgYm9yZGVyLXJhZGl1czogNHB4O1xuICAgICAgd2hpdGUtc3BhY2U6IHByZS13cmFwOyB3b3JkLXdyYXA6IGJyZWFrLXdvcmQ7IHBhZ2UtYnJlYWstaW5zaWRlOiBhdm9pZDsgfVxucHJlIGNvZGUgeyBmb250LXNpemU6IDFlbTsgfVxuYmxvY2txdW90ZSB7IG1hcmdpbjogMCAwIDFlbSAxZW07IHBhZGRpbmctbGVmdDogMC45ZW07XG4gICAgICAgICAgICAgYm9yZGVyLWxlZnQ6IDNweCBzb2xpZCByZ2JhKDEyNywxMjcsMTI3LDAuNSk7IGZvbnQtc3R5bGU6IGl0YWxpYzsgfVxudWwsIG9sIHsgbWFyZ2luOiAwIDAgMWVtOyBwYWRkaW5nLWxlZnQ6IDEuM2VtOyB9XG5saSB7IG1hcmdpbi1ib3R0b206IDAuMzVlbTsgfVxuaHIgeyBib3JkZXI6IDA7IGJvcmRlci10b3A6IDFweCBzb2xpZCByZ2JhKDEyNywxMjcsMTI3LDAuNCk7IG1hcmdpbjogMmVtIDA7IH1cbnRhYmxlIHsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTsgd2lkdGg6IDEwMCU7IGZvbnQtc2l6ZTogMC44ZW07IG1hcmdpbjogMCAwIDFlbTsgfVxudGgsIHRkIHsgYm9yZGVyOiAxcHggc29saWQgcmdiYSgxMjcsMTI3LDEyNywwLjUpOyBwYWRkaW5nOiAwLjM1ZW0gMC41ZW07XG4gICAgICAgICB0ZXh0LWFsaWduOiBsZWZ0OyB2ZXJ0aWNhbC1hbGlnbjogdG9wOyB9XG50aCB7IGZvbnQtd2VpZ2h0OiBib2xkOyB9XG5cbi8qXG4gKiBUaGUgY29udGVudHMgcGFnZSBudW1iZXJzIGl0c2VsZiB0d2ljZSBvdGhlcndpc2UuIEVQVUIgMyByZXF1aXJlcyB0aGUgdG9jIHRvIGJlIGFuXG4gKiBvcmRlcmVkIGxpc3QsIGFuZCBhIHJlYWRlciBkcmF3cyB0aGF0IGxpc3QncyBtYXJrZXJzIFx1MjAxNCBidXQgZXZlcnkgY2hhcHRlciB0aXRsZSBvcGVuc1xuICogd2l0aCBpdHMgb3duIG51bWJlciwgYmVjYXVzZSB0aGUgbnVtYmVyIGlzIHBhcnQgb2YgdGhlIGNoYXB0ZXIncyBuYW1lIGFuZCBoYXMgdG9cbiAqIHN1cnZpdmUgaW50byBhIHJlYWRlcidzIG93biB0YWJsZS1vZi1jb250ZW50cyBwYW5lbCwgd2hpY2ggaWdub3JlcyB0aGlzIHN0eWxlc2hlZXQuXG4gKiBTbyB0aGUgdGl0bGUga2VlcHMgdGhlIG51bWJlciBhbmQgdGhlIGxpc3QgbWFya2VyIGdvZXMuXG4gKi9cbi50b2Mgb2wgeyBsaXN0LXN0eWxlOiBub25lOyBwYWRkaW5nLWxlZnQ6IDA7IH1cbi50b2Mgb2wgbGkgeyBtYXJnaW4tYm90dG9tOiAwLjZlbTsgfVxuLnRvYyBvbCBhIHsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyB9XG5cbi50aXRsZXBhZ2UgeyB0ZXh0LWFsaWduOiBjZW50ZXI7IHBhZGRpbmctdG9wOiAyMiU7IH1cbi5ib29rdGl0bGUgeyBmb250LXNpemU6IDIuMWVtOyBsaW5lLWhlaWdodDogMS4xNTsgbWFyZ2luOiAwIDAgMC43ZW07IH1cbi5zdWJ0aXRsZSB7IGZvbnQtc2l6ZTogMS4wNWVtOyBmb250LXN0eWxlOiBpdGFsaWM7IG1hcmdpbjogMCAwIDNlbTsgfVxuLmltcHJpbnQgeyBmb250LXNpemU6IDAuODVlbTsgfVxuYDtcblxuLyoqXG4gKiBFdmVyeSBgPENvbXBvbmVudCAvPmAgdGhlIGJvb2sncyBjaGFwdGVycyBkcmF3LCBpbiByZWFkaW5nIG9yZGVyLlxuICpcbiAqIEZvdW5kIGJ5IHdhbGtpbmcgdGhlIHR3aW5zIHdpdGggYSBjb2xsZWN0b3IgcmF0aGVyIHRoYW4gYnkgZ3JlcHBpbmcgdGhlIHNvdXJjZXMsXG4gKiBzbyB0aGUgbGlzdCBpcyBleGFjdGx5IHdoYXQgYHRvVHdpbmAgd291bGQgaGF2ZSBmbGF0dGVuZWQgXHUyMDE0IGEgY29tcG9uZW50IGluc2lkZSBhXG4gKiBmZW5jZWQgY29kZSBibG9jayBpcyBub3QgYSBmaWd1cmUsIGFuZCBub3RoaW5nIGhlcmUgaGFzIHRvIHJlbWVtYmVyIHRoYXQgdHdpY2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWd1cmVSZXF1ZXN0cyhzcmNEaXI6IHN0cmluZyk6IEZpZ3VyZVJlcXVlc3RbXSB7XG4gIGNvbnN0IGZvdW5kOiBGaWd1cmVSZXF1ZXN0W10gPSBbXTtcbiAgYm9va1BhZ2VzKHNyY0RpciwgKG5hbWUsIHByb3BzKSA9PiB7XG4gICAgZm91bmQucHVzaCh7IG5hbWUsIHByb3BzIH0pO1xuICAgIHJldHVybiAnJztcbiAgfSk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBUaGUgZmlndXJlIGZvciBhIGNvbXBvbmVudCBsaW5lLCBmYWxsaW5nIGJhY2sgdG8gaXRzIHByb3NlIHR3aW4uXG4gKlxuICogVGhlIGZhbGxiYWNrIGlzIG5vdCBkZWNvcmF0aW9uOiBgYnVpbGRFcHViYCBpcyBjYWxsYWJsZSB3aXRoIG5vIGZpZ3VyZXMgYXQgYWxsXG4gKiAodGhlIHN5bmMgcGF0aCBhIHRlc3Qgb3IgYSBjYWxsZXIgd2l0aG91dCBhIHJlbmRlcmVyIHRha2VzKSwgYW5kIGEgYm9vayB0aGF0XG4gKiBzaWxlbnRseSBkcm9wcGVkIGZpdmUgZGlhZ3JhbXMgd291bGQgYmUgd29yc2UgdGhhbiBvbmUgdGhhdCBrZWVwcyB0aGUgcHJvc2UuXG4gKi9cbmNvbnN0IHR3aW5XaXRoID1cbiAgKGZpZ3VyZXM6IEZpZ3VyZVNldCk6IENvbXBvbmVudFR3aW4gPT5cbiAgKG5hbWUsIHByb3BzKSA9PlxuICAgIGZpZ3VyZXMuZ2V0KGZpZ3VyZUtleShuYW1lLCBwcm9wcykpID8/IGFsdFR3aW4obmFtZSwgcHJvcHMpO1xuXG4vKipcbiAqIEJ1aWxkIHRoZSBFUFVCLlxuICpcbiAqIGBtaW1ldHlwZWAgaXMgYWRkZWQgZmlyc3Qgd2l0aCBgbGV2ZWw6IDBgIChzdG9yZWQpLiBmZmxhdGUgd3JpdGVzIGVudHJpZXMgaW4gdGhlXG4gKiBvcmRlciBnaXZlbiwgc28gdGhvc2UgdHdvIGZhY3RzIHRvZ2V0aGVyIGFyZSB3aGF0IG1ha2UgdGhlIGFyY2hpdmUgYW4gRVBVQiByYXRoZXJcbiAqIHRoYW4gYSB6aXAgZnVsbCBvZiBFUFVCLXNoYXBlZCBmaWxlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRXB1YihcbiAgc3JjRGlyOiBzdHJpbmcsXG4gIGNvdmVyUG5nPzogVWludDhBcnJheSxcbiAgZmlndXJlczogRmlndXJlU2V0ID0gbmV3IE1hcCgpLFxuKTogVWludDhBcnJheSB7XG4gIGNvbnN0IHBhZ2VzID0gYm9va1BhZ2VzKHNyY0RpciwgdHdpbldpdGgoZmlndXJlcykpO1xuICAvLyBTZWNvbmQtcmVzb2x1dGlvbiBVVEMsIHdoaWNoIGlzIHRoZSBvbmx5IGZvcm0gYGRjdGVybXM6bW9kaWZpZWRgIGFjY2VwdHMuXG4gIGNvbnN0IG1vZGlmaWVkID0gYCR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE5KX1aYDtcbiAgY29uc3QgaGFzQ292ZXIgPSBjb3ZlclBuZyAhPT0gdW5kZWZpbmVkICYmIGNvdmVyUG5nLmxlbmd0aCA+IDA7XG5cbiAgY29uc3QgZmlsZXM6IFJlY29yZDxzdHJpbmcsIFtVaW50OEFycmF5LCB7IGxldmVsOiAwIHwgNiB9XT4gPSB7XG4gICAgbWltZXR5cGU6IFtzdHJUb1U4KCdhcHBsaWNhdGlvbi9lcHViK3ppcCcpLCB7IGxldmVsOiAwIH1dLFxuICAgICdNRVRBLUlORi9jb250YWluZXIueG1sJzogW1xuICAgICAgc3RyVG9VOChgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIj8+XG48Y29udGFpbmVyIHZlcnNpb249XCIxLjBcIiB4bWxucz1cInVybjpvYXNpczpuYW1lczp0YzpvcGVuZG9jdW1lbnQ6eG1sbnM6Y29udGFpbmVyXCI+XG4gIDxyb290ZmlsZXM+XG4gICAgPHJvb3RmaWxlIGZ1bGwtcGF0aD1cIkVQVUIvcGFja2FnZS5vcGZcIiBtZWRpYS10eXBlPVwiYXBwbGljYXRpb24vb2VicHMtcGFja2FnZSt4bWxcIi8+XG4gIDwvcm9vdGZpbGVzPlxuPC9jb250YWluZXI+XG5gKSxcbiAgICAgIHsgbGV2ZWw6IDYgfSxcbiAgICBdLFxuICAgICdFUFVCL3BhY2thZ2Uub3BmJzogW3N0clRvVTgocGFja2FnZURvYyhwYWdlcywgbW9kaWZpZWQsIGhhc0NvdmVyKSksIHsgbGV2ZWw6IDYgfV0sXG4gICAgJ0VQVUIvbmF2LnhodG1sJzogW3N0clRvVTgobmF2RG9jKHBhZ2VzKSksIHsgbGV2ZWw6IDYgfV0sXG4gICAgJ0VQVUIvdG9jLm5jeCc6IFtzdHJUb1U4KG5jeERvYyhwYWdlcykpLCB7IGxldmVsOiA2IH1dLFxuICAgICdFUFVCL3N0eWxlLmNzcyc6IFtcbiAgICAgIC8vIFN0eWxlcyBmb3IgdGhlIGZpZ3VyZXMgYWN0dWFsbHkgZW1iZWRkZWQgXHUyMDE0IG5vdCBmb3IgZXZlcnkgb25lIHRoZSBjaGFwdGVyc1xuICAgICAgLy8gYXNrIGZvciwgc28gdGhlIHN5bmMgcGF0aCBzaGlwcyBubyBydWxlcyBmb3IgcGljdHVyZXMgaXQgZG9lcyBub3QgY2FycnkuXG4gICAgICBzdHJUb1U4KFNUWUxFICsgZmlndXJlQ3NzKHNyY0RpciwgWy4uLmZpZ3VyZXMua2V5cygpXS5tYXAoY29tcG9uZW50T2YpKSksXG4gICAgICB7IGxldmVsOiA2IH0sXG4gICAgXSxcbiAgICAnRVBVQi90aXRsZXBhZ2UueGh0bWwnOiBbc3RyVG9VOCh0aXRsZVBhZ2UoKSksIHsgbGV2ZWw6IDYgfV0sXG4gIH07XG4gIGlmIChoYXNDb3ZlcikgZmlsZXNbJ0VQVUIvY292ZXIucG5nJ10gPSBbY292ZXJQbmcsIHsgbGV2ZWw6IDYgfV07XG4gIGZvciAoY29uc3QgcGFnZSBvZiBwYWdlcykge1xuICAgIGZpbGVzW2BFUFVCLyR7ZmlsZUZvcihwYWdlKX1gXSA9IFtzdHJUb1U4KGNoYXB0ZXJEb2MocGFnZSkpLCB7IGxldmVsOiA2IH1dO1xuICB9XG5cbiAgcmV0dXJuIHppcFN5bmMoZmlsZXMgYXMgdW5rbm93biBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB6aXBTeW5jPlswXSwgeyBsZXZlbDogNiB9KTtcbn1cblxuLyoqIFRoZSBjaGVja2VkLWluIGNvdmVyIGFzc2V0LCBvciB1bmRlZmluZWQgd2hlbiBpdCBpcyBhYnNlbnQuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZENvdmVyKHNyY0Rpcjogc3RyaW5nKTogVWludDhBcnJheSB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KHJlYWRGaWxlU3luYyhqb2luKHNyY0RpciwgJ2Fzc2V0cy9ib29rLWNvdmVyLnBuZycpKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVwdWJBcnRpZmFjdHMoc3JjRGlyOiBzdHJpbmcsIHJlbmRlcmVkPzogRmlndXJlU2V0KTogUHJvbWlzZTxBcnRpZmFjdFtdPiB7XG4gIGNvbnN0IGZpZ3VyZXMgPSByZW5kZXJlZCA/PyBhd2FpdCByZW5kZXJGaWd1cmVzKHNyY0RpciwgZmlndXJlUmVxdWVzdHMoc3JjRGlyKSk7XG4gIHJldHVybiBbeyBwYXRoOiAnYm9vay5lcHViJywgY29udGVudHM6IGJ1aWxkRXB1YihzcmNEaXIsIHJlYWRDb3ZlcihzcmNEaXIpLCBmaWd1cmVzKSB9XTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL21hcmt1cy9Qcm9qZWN0cy9wcml2YXRlL3N1YnN0cmF0Ly53b3JrdHJlZXMvZmVhdC9yZXF1ZXN0cy1wYXRoLWZhY2V0LTI3NjIvYXBwcy9kb2NzLy52aXRlcHJlc3NcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2hlYWRlcnMubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9tYXJrdXMvUHJvamVjdHMvcHJpdmF0ZS9zdWJzdHJhdC8ud29ya3RyZWVzL2ZlYXQvcmVxdWVzdHMtcGF0aC1mYWNldC0yNzYyL2FwcHMvZG9jcy8udml0ZXByZXNzL2hlYWRlcnMubXRzXCI7LyoqXG4gKiBUaGUgc2VjdXJpdHkgaGVhZGVycyBDbG91ZGZsYXJlIFBhZ2VzIHNlcnZlcyB3aXRoIHRoZSBidWlsdCBzaXRlLlxuICpcbiAqIFBhZ2VzIHJlYWRzIGEgYF9oZWFkZXJzYCBmaWxlIGZyb20gdGhlIG91dHB1dCBkaXJlY3RvcnksIHNvIHRoaXMgaXMgd3JpdHRlblxuICogaW50byB0aGUgYnVpbGQgdGhlIHNhbWUgd2F5IHRoZSBsbG1zLnR4dCBhcnRpZmFjdHMgYXJlIFx1MjAxNCBieSBgYnVpbGRFbmRgLCBpbnRvXG4gKiBhIGdpdGlnbm9yZWQgYGRpc3RgLiBUaGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gY2hlY2tlZC1pbiBjb3B5OiB0aGUgcG9saWN5XG4gKiBiZWxvdyBpcyB0aGUgc291cmNlIG9mIHRydXRoLCBgX2hlYWRlcnNgIGlzIGJ1aWxkIG91dHB1dCwgYW5kIGEgaGFuZC1lZGl0IHRvXG4gKiBpdCBjYW5ub3Qgc3Vydml2ZSB0aGUgbmV4dCBidWlsZC5cbiAqXG4gKiAjIyBXaHkgdGhlIHNjcmlwdCBoYXNoZXMgYXJlIGNvbXB1dGVkIHJhdGhlciB0aGFuIHdyaXR0ZW4gZG93blxuICpcbiAqIFZpdGVQcmVzcyBpbmxpbmVzIHRocmVlIHNjcmlwdHMgaW50byBldmVyeSBwYWdlOiB0aGUgZGFyay1tb2RlIHByb2JlICh3aGljaFxuICogaGFzIHRvIHJ1biBiZWZvcmUgZmlyc3QgcGFpbnQgb3IgdGhlIHBhZ2UgZmxhc2hlcyB3aGl0ZSksIHRoZSBtYWNPUyBjbGFzc1xuICogdG9nZ2xlLCBhbmQgYHdpbmRvdy5fX1ZQX0hBU0hfTUFQX19gLiBUaGUgZmlyc3QgdHdvIGFyZSBmaXhlZCBzdHJpbmdzOyB0aGVcbiAqIHRoaXJkIGVtYmVkcyBhIGNvbnRlbnQgaGFzaCBvZiBldmVyeSBwYWdlIGluIHRoZSBzaXRlIGFuZCB0aGVyZWZvcmUgQ0hBTkdFU1xuICogT04gRVZFUlkgQlVJTEQuXG4gKlxuICogVGhhdCBydWxlcyBvdXQgYm90aCBhbHRlcm5hdGl2ZXMuIEEgY2hlY2tlZC1pbiBoYXNoIGxpc3Qgd291bGQgYmUgd3JvbmcgdGhlXG4gKiBmaXJzdCB0aW1lIGFueW9uZSBlZGl0ZWQgYSBwYWdlIFx1MjAxNCBhbmQgd3JvbmcgaW4gdGhlIHdvcnN0IHdheSwgYmVjYXVzZSB0aGVcbiAqIHBhZ2Ugc3RpbGwgcmVuZGVycywgb25seSB1bnN0eWxlZCBhbmQgc3R1Y2sgaW4gbGlnaHQgbW9kZS4gYCd1bnNhZmUtaW5saW5lJ2BcbiAqIHdvdWxkIHdvcmsgZm9yZXZlciBhbmQgYnV5IG5vdGhpbmc6IGl0IHJlLXBlcm1pdHMgZXhhY3RseSB0aGUgaW5qZWN0ZWRcbiAqIGA8c2NyaXB0PmAgdGhlIHBvbGljeSBleGlzdHMgdG8gc3RvcC5cbiAqXG4gKiBTbyB0aGUgaGFzaGVzIGFyZSByZWFkIGJhY2sgb3V0IG9mIHRoZSBIVE1MIFZpdGVQcmVzcyBqdXN0IHdyb3RlLiBUaHJlZVxuICogZGlzdGluY3Qgc2NyaXB0cyBhY3Jvc3MgMTA3IHBhZ2VzIHRvZGF5OyB0aGUgY291bnQgaXMgZGVyaXZlZCwgbm90IGFzc3VtZWQuXG4gKlxuICogIyMgV2h5IHRoZSBtb3VudGVkIGRlc2tzIGFyZSByZWFkIG91dCBvZiB0aGUgbWFya2Rvd25cbiAqXG4gKiBUaGUgc2l0ZS13aWRlIHdpZGdldCBpcyBhIGA8c2NyaXB0PmAgaW4gYDxoZWFkPmAsIHNvIGl0IGlzIGluIHRoZSBidWlsdCBIVE1MIGFuZCB0aGVcbiAqIG9yaWdpbiBndWFyZCBiZWxvdyBzZWVzIGl0LiBUaGUgcGVyLXBhZ2UgbW91bnRzIGFyZSBub3Q6IGBpbmRleC5tZGAgYW5kXG4gKiBgY2hhbmdlbG9nL2luZGV4Lm1kYCBtb3VudCBmb3JtcyB0aGF0IGBmZXRjaGAgYSBkZXNrIHRoZXkgbmFtZSBhcyBhIGBkZXNrYCBhdHRyaWJ1dGUsXG4gKiBhbmQgdGhlIHN1cHBvcnQgd2lkZ2V0IGl0c2VsZiB3YXMgbW91bnRlZCB0aGF0IHdheSBvbiBgZ3VpZGUvc3VwcG9ydC5tZGAgYmVmb3JlIGl0XG4gKiB3ZW50IHNpdGUtd2lkZS4gTm90aGluZyBhYm91dCB0aG9zZSBvcmlnaW5zIHJlYWNoZXMgdGhlIEhUTUwsIHNvIGEgcG9saWN5IGRlcml2ZWRcbiAqIG9ubHkgZnJvbSB0aGUgYnVpbGQgbmFtZWQgYCdzZWxmJ2AgYW5kIHRoZSB0aHJlZSBoYXNoZXMgXHUyMDE0IGFuZCBzdWJzdHJhdC5uZXQgYmxvY2tlZFxuICogaXRzIG93biBzdXBwb3J0IHdpZGdldCB3aGlsZSBldmVyeSBidWlsZCBzdGF5ZWQgZ3JlZW4uXG4gKlxuICogU28gdGhlIGRlc2tzIGFyZSByZWFkIG91dCBvZiB0aGUgcGFnZXMgdGhlIHNpdGUgaXMgYnVpbHQgZnJvbSBcdTIwMTQgZXZlcnkgY29tcG9uZW50IHdpdGhcbiAqIGEgYGRlc2tgIGF0dHJpYnV0ZSwgd2hpY2hldmVyIGNvbXBvbmVudCBpdCBpcywgaXRzIGF0dHJpYnV0ZXMgUEFSU0VEIHJhdGhlciB0aGFuXG4gKiBwYXR0ZXJuLW1hdGNoZWQgXHUyMDE0IGFuZCBldmVyeSBvbmUgb2YgdGhlbSBpcyBpbiB0aGUgcG9saWN5IGJlc2lkZSB0aGUgc2l0ZS13aWRlIGRlc2suXG4gKlxuICogQm90aCBkaXJlY3RpdmVzIGdldCBldmVyeSBkZXNrLCByYXRoZXIgdGhhbiB0aGUgd2lkZ2V0J3MgaW4gYHNjcmlwdC1zcmNgIGFuZCB0aGVcbiAqIGZvcm0ncyBpbiBgY29ubmVjdC1zcmNgLiBUaGF0IGlzIGEgdHJ1ZSBzdGF0ZW1lbnQgcmF0aGVyIHRoYW4gYSBzaG9ydGN1dDogb25lIGRlc2tcbiAqIHNlcnZlcyBib3RoLCB0aGUgd2lkZ2V0IGdlbnVpbmVseSBsb2FkcyBhIHNjcmlwdCBmcm9tIGl0LCBhbmQgdGhlIGZvcm0gZ2VudWluZWx5XG4gKiBmZXRjaGVzIGl0LiBTcGxpdHRpbmcgdGhlIGxpc3Qgd291bGQgbWVhbiB0d28gYXR0cmlidXRlIGNvbnZlbnRpb25zIHRvIHJlbWVtYmVyIGFuZFxuICogd291bGQgbmFycm93IG5vdGhpbmcsIGJlY2F1c2UgdGhlIG9yaWdpbnMgYXJlIHRoZSBzYW1lLlxuICpcbiAqICMjIFdoYXQgaXMgZGVsaWJlcmF0ZWx5IGxvb3NlXG4gKlxuICogYHN0eWxlLXNyY2Aga2VlcHMgYCd1bnNhZmUtaW5saW5lJ2AuIE1lcm1haWQgaW5qZWN0cyBhIGA8c3R5bGU+YCBlbGVtZW50IHBlclxuICogZGlhZ3JhbSBhdCByZW5kZXIgdGltZSBhbmQgc2V0cyBpbmxpbmUgYHN0eWxlYCBhdHRyaWJ1dGVzIGFzIGl0IGxheXMgdGhlbVxuICogb3V0LCBzbyBoYXNoaW5nIGlzIG5vdCBhdmFpbGFibGUgXHUyMDE0IHRoZSBjb250ZW50IGRvZXMgbm90IGV4aXN0IHVudGlsIHRoZVxuICogYnJvd3NlciBoYXMgZHJhd24gdGhlIGRpYWdyYW0uIEFuIGluamVjdGVkIHN0eWxlc2hlZXQgaXMgYSBkZWZhY2VtZW50IGFuZCBhXG4gKiBkYXRhLWV4ZmlsdHJhdGlvbiBzaWRlIGNoYW5uZWwsIHdoaWNoIGlzIHdvcnRoIG5hbWluZyByYXRoZXIgdGhhbiBpbXBseWluZ1xuICogdGhpcyBwb2xpY3kgaXMgYWlydGlnaHQ7IGl0IGlzIG5vdCBzY3JpcHQgZXhlY3V0aW9uLlxuICovXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIHJlYWRkaXJTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgam9pbiwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbi8qKiBJbmxpbmUgYDxzY3JpcHQ+YCBcdTIwMTQgb25lIHdpdGggYSBgc3JjYCBpcyBhIGZldGNoLCBnb3Zlcm5lZCBieSB0aGUgb3JpZ2luIGxpc3QgaW5zdGVhZC4gKi9cbmNvbnN0IElOTElORV9TQ1JJUFQgPSAvPHNjcmlwdCg/IVtePl0qXFxzc3JjPSlbXj5dKj4oW1xcc1xcU10qPyk8XFwvc2NyaXB0Pi9nO1xuXG4vKipcbiAqIEV2ZXJ5IGZpbGUgdW5kZXIgYGRpcmAgd2l0aCB0aGUgZ2l2ZW4gc3VmZml4LlxuICpcbiAqIGBub2RlX21vZHVsZXNgLCB0aGUgYnVpbGQgb3V0cHV0IGFuZCB0aGUgZG90LWRpcmVjdG9yaWVzIGFyZSBza2lwcGVkOiB0aGUgc291cmNlIHdhbGtcbiAqIHJ1bnMgb3ZlciBgYXBwcy9kb2NzYCBpdHNlbGYsIHdoZXJlIGRlc2NlbmRpbmcgaW50byBgbm9kZV9tb2R1bGVzYCB3b3VsZCByZWFkIHRlbnMgb2ZcbiAqIHRob3VzYW5kcyBvZiBmaWxlcyB0byBmaW5kIG5vdGhpbmcuXG4gKi9cbmZ1bmN0aW9uIGZpbGVzV2l0aChkaXI6IHN0cmluZywgc3VmZml4OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGRpciwgZW50cnkubmFtZSk7XG4gICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgIGlmIChlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoJy4nKSB8fCBlbnRyeS5uYW1lID09PSAnbm9kZV9tb2R1bGVzJyB8fCBlbnRyeS5uYW1lID09PSAnZGlzdCcpXG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgb3V0LnB1c2goLi4uZmlsZXNXaXRoKHBhdGgsIHN1ZmZpeCkpO1xuICAgIH0gZWxzZSBpZiAoZW50cnkubmFtZS5lbmRzV2l0aChzdWZmaXgpKSBvdXQucHVzaChwYXRoKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiBodG1sRmlsZXMoZGlyOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBmaWxlc1dpdGgoZGlyLCAnLmh0bWwnKTtcbn1cblxuLyoqXG4gKiBFdmVyeSBkaXN0aW5jdCBpbmxpbmUgc2NyaXB0IGluIHRoZSBidWlsdCBzaXRlLCBhcyBhIENTUCBzb3VyY2UgZXhwcmVzc2lvbi5cbiAqXG4gKiBTb3J0ZWQgc28gYSByZWJ1aWxkIHRoYXQgY2hhbmdlcyBub3RoaW5nIHByb2R1Y2VzIGEgYnl0ZS1pZGVudGljYWwgYF9oZWFkZXJzYFxuICogXHUyMDE0IGRpcmVjdG9yeSBvcmRlciBpcyBub3QgZ3VhcmFudGVlZCwgYW5kIGEgcG9saWN5IHRoYXQgY2h1cm5zIGZvciBubyByZWFzb25cbiAqIGlzIG9uZSBub2JvZHkgcmVhZHMgdGhlIGRpZmYgb2YuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbmxpbmVTY3JpcHRIYXNoZXMob3V0RGlyOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGhhc2hlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgaHRtbEZpbGVzKG91dERpcikpIHtcbiAgICBjb25zdCBodG1sID0gcmVhZEZpbGVTeW5jKGZpbGUsICd1dGY4Jyk7XG4gICAgZm9yIChjb25zdCBbLCBib2R5XSBvZiBodG1sLm1hdGNoQWxsKElOTElORV9TQ1JJUFQpKSB7XG4gICAgICBoYXNoZXMuYWRkKGAnc2hhMjU2LSR7Y3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKGJvZHkgPz8gJycsICd1dGY4JykuZGlnZXN0KCdiYXNlNjQnKX0nYCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4uaGFzaGVzXS5zb3J0KCk7XG59XG5cbi8qKlxuICogQSBjb21wb25lbnQgdGFnLCBhbmQgaXRzIGF0dHJpYnV0ZSBibG9iOiBgPFNpZ251cEZvcm0ga2luZD1cIlx1MjAyNlwiIGRlc2s9XCJcdTIwMjZcIiAvPmAuXG4gKlxuICogVGhlIHVwcGVyY2FzZSBmaXJzdCBsZXR0ZXIgaXMgd2hhdCBrZWVwcyB0aGlzIHRvIFZ1ZSBjb21wb25lbnRzIFx1MjAxNCBubyBIVE1MIGVsZW1lbnQgaXNcbiAqIHNwZWxsZWQgdGhhdCB3YXksIHNvIGA8ZGl2IGRlc2s9XCJcdTIwMjZcIj5gIGNhbm5vdCB3aWRlbiB0aGUgcG9saWN5LlxuICpcbiAqIERlbGliZXJhdGVseSBkb2VzIE5PVCB0cnkgdG8gZmluZCBgZGVza2AgaXRzZWxmLiBUd28gYXR0ZW1wdHMgZGlkLCBhbmQgYm90aCB3ZXJlXG4gKiB3cm9uZyBpbiB0aGUgc2FtZSBkaXJlY3Rpb24gXHUyMDE0IHdpZGVuaW5nIHRoZSBwb2xpY3kgZnJvbSB0ZXh0IHRoYXQgaXMgbm90IGFuIGF0dHJpYnV0ZTpcbiAqXG4gKiAgLSBgXFxiZGVza2AgbWF0Y2hlZCB0aGUgYGRlc2tgIGluIGBkYXRhLWRlc2tgLCBiZWNhdXNlIGEgd29yZCBib3VuZGFyeSBzaXRzIGJldHdlZW5cbiAqICAgIHRoZSBoeXBoZW4gYW5kIHRoZSBgZGA7XG4gKiAgLSBgXFxzZGVza2AgZml4ZWQgdGhhdCBhbmQgc3RpbGwgbWF0Y2hlZCBpbnNpZGUgYSBxdW90ZWQgVkFMVUUsIHNvXG4gKiAgICBgPFNpZ251cEZvcm0gdGl0bGU9J2RlbW8gZGVzaz1cImh0dHBzOi8vdGhpcmQtcGFydHkuZXhhbXBsZVwiJyAvPmAgbmFtZWQgYW4gb3JpZ2luLlxuICpcbiAqIEEgcmVnZXggb3ZlciBhIHRhZyBjYW5ub3Qga25vdyB3aGVyZSBhIHZhbHVlIGVuZHMsIHNvIHRoaXMgb25lIHN0b3BzIGF0IHRoZSB0YWcgYW5kXG4gKiBoYW5kcyB0aGUgcmVzdCB0byBgYXR0cmlidXRlcygpYCBcdTIwMTQgdGhlIHBhcnNlciB0aGlzIGZpbGUgYWxyZWFkeSBoYXMsIHdyaXR0ZW4gZm9yIHRoZVxuICogc2FtZSBjbGFzcyBvZiBidWcgb24gYDxsaW5rIHJlbCBocmVmPmAuIEl0IHRyYWNrcyBxdW90ZSBzdGF0ZSwgc28gdGV4dCBpbnNpZGUgYSB2YWx1ZVxuICogaXMgYSB2YWx1ZS5cbiAqXG4gKiBUaGUgb25lIGxpbWl0YXRpb24gbGVmdCBpcyBzaGFyZWQgd2l0aCBgUkVTT1VSQ0VfVEFHYCBhbmQgc3RhdGVkIHJhdGhlciB0aGFuIGhpZGRlbjpcbiAqIGBbXj5dKmAgZW5kcyBhdCB0aGUgZmlyc3QgYD5gLCBzbyBhbiBhdHRyaWJ1dGUgdmFsdWUgY29udGFpbmluZyBvbmUgdHJ1bmNhdGVzIHRoZVxuICogdGFnLiBUaGF0IGRpcmVjdGlvbiBpcyBzYWZlIFx1MjAxNCBpdCBkcm9wcyBhdHRyaWJ1dGVzIHJhdGhlciB0aGFuIGludmVudGluZyB0aGVtLlxuICovXG5jb25zdCBDT01QT05FTlRfVEFHID0gLzwoW0EtWl1bQS1aYS16MC05XSopXFxiKFtePl0qKT4vZztcblxuLyoqXG4gKiBFdmVyeSBkZXNrIGEgY2hlY2tlZC1pbiBwYWdlIG5hbWVzLlxuICpcbiAqIFJlYWQgZnJvbSB0aGUgbWFya2Rvd24gcmF0aGVyIHRoYW4gZnJvbSB0aGUgYnVpbGQgYmVjYXVzZSB0aGUgdGFncyBjb21waWxlIGF3YXk6IHRoZVxuICogd2lkZ2V0IGFwcGVuZHMgaXRzIGA8c2NyaXB0PmAgYWZ0ZXIgbW91bnQgYW5kIGEgZm9ybSBgZmV0Y2hgZXMgZnJvbSBzY3JpcHQsIHNvIHRoZVxuICogYnVpbHQgSFRNTCBzYXlzIG5vdGhpbmcgYWJvdXQgdGhlIG9yaWdpbiB0aGUgYnJvd3NlciBpcyBhYm91dCB0byBiZSBhc2tlZCB0byByZWFjaC5cbiAqIFNlZSB0aGUgaGVhZGVyLlxuICpcbiAqIEtleWVkIG9uIHRoZSBBVFRSSUJVVEUgcmF0aGVyIHRoYW4gb24gYSBsaXN0IG9mIGNvbXBvbmVudCBuYW1lcywgd2hpY2ggaXMgdGhlIHBhcnRcbiAqIHdvcnRoIGtlZXBpbmc6IGEgbmV3IGNvbXBvbmVudCB0aGF0IHRhbGtzIHRvIGEgZGVzayByZWFjaGVzIHRoZSBwb2xpY3kgYnkgYmVpbmdcbiAqIHdyaXR0ZW4gaW4gdGhlIGhvdXNlIHN0eWxlLCBpbnN0ZWFkIG9mIGJ5IHNvbWVib2R5IHJlbWVtYmVyaW5nIHRvIGFkZCBpdCB0byBhIHJlZ2V4XG4gKiBpbiBhIHNlY3VyaXR5IGZpbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrT3JpZ2lucyhzcmNEaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXNXaXRoKHNyY0RpciwgJy5tZCcpKSB7XG4gICAgZm9yIChjb25zdCBtYXRjaCBvZiByZWFkRmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKS5tYXRjaEFsbChDT01QT05FTlRfVEFHKSkge1xuICAgICAgY29uc3QgZGVzayA9IGF0dHJpYnV0ZXMobWF0Y2hbMl0gPz8gJycpLmdldCgnZGVzaycpO1xuICAgICAgaWYgKGRlc2spIG9yaWdpbnMuYWRkKG5ldyBVUkwoZGVzaykub3JpZ2luKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi5vcmlnaW5zXS5zb3J0KCk7XG59XG5cbi8qKlxuICogVGhlIHBvbGljeSwgYXMgdGhlIGRpcmVjdGl2ZSBsaXN0LlxuICpcbiAqIGB3aWRnZXRPcmlnaW5zYCBhcmUgdGhlIHRpY2tldDAgZGVza3MgdGhpcyBzaXRlIHRhbGtzIHRvOiBldmVyeSBkZXNrIGEgcGFnZSBuYW1lc1xuICogd2l0aCBhIGBkZXNrYCBhdHRyaWJ1dGUsIHBsdXMgdGhlIHNpdGUtd2lkZSB3aWRnZXQncyAoY29uZmlnLm10cykuIEVhY2ggaXMgYSByZWFsIHRoaXJkLXBhcnR5IG9yaWdpbiBvbiB0aGUgZG9jcyBvcmlnaW4gXHUyMDE0IGEgc2NyaXB0IGZvciB0aGVcbiAqIHdpZGdldCwgYSBgZmV0Y2hgIGZvciBhIHNpZ251cCBmb3JtIFx1MjAxNCBzbyBlYWNoIGhhcyB0byBiZSBuYW1lZCBpbiBib3RoIGBzY3JpcHQtc3JjYFxuICogYW5kIGBjb25uZWN0LXNyY2AsIGFuZCB0aGUgZmFjdCB0aGF0IGl0IGhhcyB0byBiZSBuYW1lZCBpcyBtb3N0IG9mIHdoeSB0aGlzIGZpbGUgaXNcbiAqIHdvcnRoIGhhdmluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNzcChzY3JpcHRIYXNoZXM6IHN0cmluZ1tdLCB3aWRnZXRPcmlnaW5zOiByZWFkb25seSBzdHJpbmdbXSA9IFtdKTogc3RyaW5nIHtcbiAgY29uc3Qgc2NyaXB0ID0gW1wiJ3NlbGYnXCIsIC4uLnNjcmlwdEhhc2hlcywgLi4ud2lkZ2V0T3JpZ2luc107XG4gIGNvbnN0IGNvbm5lY3QgPSBbXCInc2VsZidcIiwgLi4ud2lkZ2V0T3JpZ2luc107XG4gIHJldHVybiBbXG4gICAgYGRlZmF1bHQtc3JjICdzZWxmJ2AsXG4gICAgYHNjcmlwdC1zcmMgJHtzY3JpcHQuam9pbignICcpfWAsXG4gICAgLy8gU2VlIHRoZSBoZWFkZXI6IG1lcm1haWQgc3R5bGVzIGRpYWdyYW1zIGFmdGVyIHRoZSBwb2xpY3kgaXMgd3JpdHRlbi5cbiAgICBgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdgLFxuICAgIC8vIGRhdGE6IFx1MjAxNCBrYXRleCBhbmQgbWVybWFpZCBpbmxpbmUgc21hbGwgcmFzdGVyL1NWRyBwYXlsb2Fkcy5cbiAgICBgaW1nLXNyYyAnc2VsZicgZGF0YTpgLFxuICAgIC8vIGRhdGE6IFx1MjAxNCB2cC1pY29ucy5jc3MgaW5saW5lcyBpdHMgd29mZjIgYXMgYmFzZTY0LiBXaXRob3V0IHRoaXMgdGhlIG5hdixcbiAgICAvLyBzaWRlYmFyIGFuZCBleHRlcm5hbC1saW5rIGljb25zIHNpbGVudGx5IHZhbmlzaDsgOTYgYmxvY2tlZCBsb2FkcyBwZXIgcGFnZS5cbiAgICBgZm9udC1zcmMgJ3NlbGYnIGRhdGE6YCxcbiAgICBgY29ubmVjdC1zcmMgJHtjb25uZWN0LmpvaW4oJyAnKX1gLFxuICAgIC8vIFRoZSBzaXRlIGVtYmVkcyBub3RoaW5nIGFuZCBpcyBlbWJlZGRlZCBieSBub3RoaW5nLlxuICAgIGBmcmFtZS1hbmNlc3RvcnMgJ25vbmUnYCxcbiAgICBgZnJhbWUtc3JjICdub25lJ2AsXG4gICAgYG9iamVjdC1zcmMgJ25vbmUnYCxcbiAgICAvLyBBIGRvY3Mgc2l0ZSBwb3N0cyBub3doZXJlOyBib3RoIGNsb3NlIGFuIGluamVjdGVkLW1hcmt1cCBlc2NhcGUgcm91dGVcbiAgICAvLyB0aGF0IHNjcmlwdC1zcmMgZG9lcyBub3QgY292ZXIuXG4gICAgYGJhc2UtdXJpICdub25lJ2AsXG4gICAgYGZvcm0tYWN0aW9uICdub25lJ2AsXG4gIF0uam9pbignOyAnKTtcbn1cblxuLyoqXG4gKiBUaGUgdGFncyB0aGF0IGNhbiBsb2FkIGEgc3VicmVzb3VyY2UgdGhlIENTUCBnb3Zlcm5zLlxuICpcbiAqIE5hdmlnYXRpb24gbGlua3MgYXJlIGRlbGliZXJhdGVseSBub3QgY29sbGVjdGVkIFx1MjAxNCBDU1AgZG9lcyBub3QgZ292ZXJuIHdoZXJlIGFuXG4gKiBgPGEgaHJlZj5gIGdvZXMsIGFuZCB0aGUgc2l0ZSBsaW5rcyBvdXQgdG8gR2l0SHViIG9uIGV2ZXJ5IHBhZ2UuXG4gKi9cbmNvbnN0IFJFU09VUkNFX1RBRyA9IC88KHNjcmlwdHxsaW5rfGltZ3xpZnJhbWUpXFxiKFtePl0qKT4vZ2k7XG5cbi8qKiBPbmUgYXR0cmlidXRlOiBiYXJlLCBvciBkb3VibGUtLCBzaW5nbGUtIG9yIHVuLXF1b3RlZC4gKi9cbmNvbnN0IEFUVFJJQlVURSA9IC8oW2EtekEtWl86XVstXFx3Oi5dKikoPzpcXHMqPVxccyooXCJbXlwiXSpcInwnW14nXSonfFteXFxzXCInYD08Pl0rKSk/L2c7XG5cbi8qKlxuICogQSB0YWcncyBhdHRyaWJ1dGVzLCBieSBsb3dlcmNhc2VkIG5hbWUuXG4gKlxuICogT3JkZXIgYW5kIHF1b3RlIHN0eWxlIGFyZSB0aGUgd2hvbGUgcG9pbnQgb2YgcGFyc2luZyByYXRoZXIgdGhhbiBtYXRjaGluZy4gVGhlXG4gKiByZWdleCB0aGlzIHJlcGxhY2VkIHJlcXVpcmVkIGByZWxgIGJlZm9yZSBgaHJlZmAgYW5kIGRvdWJsZSBxdW90ZXMgb24gYm90aCwgc29cbiAqIGA8bGluayBocmVmPVwiaHR0cHM6Ly9mb250cy5leGFtcGxlL3guY3NzXCIgcmVsPVwic3R5bGVzaGVldFwiPmAgXHUyMDE0IHdoaWNoIGlzIHdoYXRcbiAqIFZpdGVQcmVzcyBlbWl0cyBmb3IgYSBgaGVhZGAgZW50cnkgd2hvc2Ugb2JqZWN0IGhhcHBlbnMgdG8gcHV0IGBocmVmYCBmaXJzdCBcdTIwMTRcbiAqIHdhbGtlZCBzdHJhaWdodCBwYXN0IHRoZSBndWFyZCBhbmQgZmFpbGVkIGluIHRoZSBicm93c2VyIGluc3RlYWQuXG4gKi9cbmZ1bmN0aW9uIGF0dHJpYnV0ZXMocmF3OiBzdHJpbmcpOiBNYXA8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3QgYXR0cnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHJhdy5tYXRjaEFsbChBVFRSSUJVVEUpKSB7XG4gICAgY29uc3QgbmFtZSA9IChtYXRjaFsxXSA/PyAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCB2YWx1ZSA9IG1hdGNoWzJdID8/ICcnO1xuICAgIGNvbnN0IHVucXVvdGVkID0gL15bXCInXS8udGVzdCh2YWx1ZSkgPyB2YWx1ZS5zbGljZSgxLCAtMSkgOiB2YWx1ZTtcbiAgICAvLyBGaXJzdCB3aW5zLCBhcyBhIGJyb3dzZXIgZG9lcyB3aXRoIGEgcmVwZWF0ZWQgYXR0cmlidXRlLlxuICAgIGlmIChuYW1lICYmICFhdHRycy5oYXMobmFtZSkpIGF0dHJzLnNldChuYW1lLCB1bnF1b3RlZCk7XG4gIH1cbiAgcmV0dXJuIGF0dHJzO1xufVxuXG4vKiogVGhlIGByZWxgIHZhbHVlcyB0aGF0IG1ha2UgYSBgPGxpbmsgaHJlZj5gIGEgZmV0Y2ggcmF0aGVyIHRoYW4gYSBoaW50IG9yIGEgbGluay4gKi9cbmNvbnN0IEZFVENISU5HX1JFTFMgPSBuZXcgU2V0KFsnc3R5bGVzaGVldCcsICdwcmVsb2FkJywgJ21vZHVsZXByZWxvYWQnXSk7XG5cbi8qKlxuICogRXZlcnkgYWJzb2x1dGUgaHR0cChzKSBzdWJyZXNvdXJjZSB0aGUgSFRNTCBsb2Fkcy5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdGhlIHRlc3Q6IHRoZSBwYXJzaW5nIGlzIHRoZSBwYXJ0IHdpdGggdGhlIHNoYXJwIGVkZ2UsIGFuZCBkcml2aW5nXG4gKiBpdCB0aHJvdWdoIGEgYnVpbHQgc2l0ZSB3b3VsZCBvbmx5IHByb3ZlIHRoZSBjYXNlcyB0aGF0IHNpdGUgaGFwcGVucyB0byBjb250YWluLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0ZXJuYWxSZXNvdXJjZVVybHMoaHRtbDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCB1cmxzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIGh0bWwubWF0Y2hBbGwoUkVTT1VSQ0VfVEFHKSkge1xuICAgIGNvbnN0IHRhZyA9IChtYXRjaFsxXSA/PyAnJykudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBhdHRycyA9IGF0dHJpYnV0ZXMobWF0Y2hbMl0gPz8gJycpO1xuICAgIGNvbnN0IHVybCA9XG4gICAgICB0YWcgPT09ICdsaW5rJ1xuICAgICAgICA/IChhdHRycy5nZXQoJ3JlbCcpID8/ICcnKVxuICAgICAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgICAgIC5zcGxpdCgvXFxzKy8pXG4gICAgICAgICAgICAuc29tZSgocmVsKSA9PiBGRVRDSElOR19SRUxTLmhhcyhyZWwpKVxuICAgICAgICAgID8gYXR0cnMuZ2V0KCdocmVmJylcbiAgICAgICAgICA6IHVuZGVmaW5lZFxuICAgICAgICA6IGF0dHJzLmdldCgnc3JjJyk7XG4gICAgLy8gQSByZWxhdGl2ZSBvciBgZGF0YTpgIFVSTCBpcyBzYW1lLW9yaWdpbiBvciBhbHJlYWR5IG5hbWVkIGluIHRoZSBwb2xpY3k7XG4gICAgLy8gb25seSBhbm90aGVyIG9yaWdpbiBjYW4gYmUgdGhlIHRoaW5nIHRoZSBDU1AgaGFzIG5vdCBiZWVuIHRvbGQgYWJvdXQuXG4gICAgaWYgKHVybCAmJiAvXmh0dHBzPzpcXC9cXC8vaS50ZXN0KHVybCkpIHVybHMucHVzaCh1cmwpO1xuICB9XG4gIHJldHVybiB1cmxzO1xufVxuXG4vKipcbiAqIFJlZnVzZSB0byBlbWl0IGEgcG9saWN5IHRoZSBidWlsdCBzaXRlIGFscmVhZHkgdmlvbGF0ZXMuXG4gKlxuICogVGhlIGZhaWx1cmUgdGhpcyBndWFyZHMgYWdhaW5zdCBpcyBzaWxlbnQgYW5kIG9uZS1kaXJlY3Rpb25hbDogYWRkIGEgZm9udCBmcm9tXG4gKiBHb29nbGUsIGFuIGFuYWx5dGljcyBzbmlwcGV0LCBhbiBlbWJlZGRlZCB2aWRlbywgYW5kIHRoZSBwYWdlIGtlZXBzIGJ1aWxkaW5nLFxuICoga2VlcHMgcGFzc2luZyBldmVyeSB0ZXN0IGluIHRoZSByZXBvLCBhbmQgbG9zZXMgdGhhdCByZXNvdXJjZSBvbmx5IG9uY2UgaXQgaXNcbiAqIGJlaGluZCB0aGUgcmVhbCBoZWFkZXIgaW4gcHJvZHVjdGlvbi4gVGhlIGJyb3dzZXIgaXMgdGhlIG9ubHkgdGhpbmcgdGhhdCB3b3VsZFxuICogaGF2ZSB0b2xkIHlvdSwgYW5kIGJ5IHRoZW4gaXQgaXMgdGVsbGluZyBhIHZpc2l0b3IuXG4gKlxuICogU28gdGhlIGNoZWNrIHJ1bnMgd2hlcmUgdGhlIHBvbGljeSBpcyB3cml0dGVuLCBhZ2FpbnN0IHRoZSBIVE1MIGl0IGlzIHdyaXR0ZW5cbiAqIGZvciwgYW5kIHNheXMgd2hpY2ggb3JpZ2luIHRvIGFkZCBhbmQgdG8gd2hpY2ggZGlyZWN0aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Tm9VbmFsbG93ZWRPcmlnaW5zKG91dERpcjogc3RyaW5nLCBhbGxvd2VkOiByZWFkb25seSBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBwZXJtaXR0ZWQgPSBuZXcgU2V0KGFsbG93ZWQubWFwKChvKSA9PiBuZXcgVVJMKG8pLm9yaWdpbikpO1xuICBjb25zdCBvZmZlbmRlcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgaHRtbEZpbGVzKG91dERpcikpIHtcbiAgICBmb3IgKGNvbnN0IHVybCBvZiBleHRlcm5hbFJlc291cmNlVXJscyhyZWFkRmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKSkpIHtcbiAgICAgIGNvbnN0IG9yaWdpbiA9IG5ldyBVUkwodXJsKS5vcmlnaW47XG4gICAgICBpZiAoIXBlcm1pdHRlZC5oYXMob3JpZ2luKSkgb2ZmZW5kZXJzLnNldChvcmlnaW4sIGZpbGUpO1xuICAgIH1cbiAgfVxuICBpZiAob2ZmZW5kZXJzLnNpemUgPT09IDApIHJldHVybjtcbiAgY29uc3QgbGluZXMgPSBbLi4ub2ZmZW5kZXJzXS5tYXAoKFtvcmlnaW4sIGZpbGVdKSA9PiBgICAke29yaWdpbn0gKGZpcnN0IHNlZW4gaW4gJHtmaWxlfSlgKTtcbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBoZWFkZXJzLm10czogdGhlIGJ1aWx0IHNpdGUgbG9hZHMgcmVzb3VyY2VzIGZyb20gb3JpZ2lucyB0aGUgQ1NQIGRvZXMgbm90IGFsbG93OlxcbiR7bGluZXMuam9pbignXFxuJyl9XFxuYCArXG4gICAgICBgQWRkIGVhY2ggdG8gdGhlIHJpZ2h0IGRpcmVjdGl2ZSBpbiBjc3AoKSBcdTIwMTQgb3IgZHJvcCB0aGUgcmVzb3VyY2UuIFNoaXBwaW5nIGFzLWlzIGAgK1xuICAgICAgYGJ1aWxkcyBncmVlbiBhbmQgYnJlYWtzIGluIHRoZSBicm93c2VyLCBvbiBwcm9kdWN0aW9uIG9ubHkuYCxcbiAgKTtcbn1cblxuLyoqXG4gKiBXcml0ZSBgX2hlYWRlcnNgIGludG8gdGhlIGJ1aWx0IHNpdGUuXG4gKlxuICogYHNyY0RpcmAgaXMgdGhlIG1hcmtkb3duIHRoZSBzaXRlIHdhcyBidWlsdCBmcm9tIFx1MjAxNCB0aGUgb25seSBwbGFjZSBhIHBhZ2UncyBvd24gZGVza1xuICogbW91bnQgaXMgc3RpbGwgdmlzaWJsZS4gYHNpdGVXaWRlV2lkZ2V0YCBpcyB0aGUgZGVzayBldmVyeSBwYWdlJ3MgYDxoZWFkPmAgbG9hZHMgdGhlXG4gKiB3aWRnZXQgZnJvbSAoYWJzZW50IG9ubHkgdW5kZXIgYFRJQ0tFVDBfV0lER0VUPTBgKSwgd2hpY2ggaXMgaW4gdGhlIEhUTUwgYXMgd2VsbCBidXRcbiAqIGlzIG5hbWVkIGhlcmUgc28gYSBkZXYgYnVpbGQgYW5kIGEgcHJvZHVjdGlvbiBidWlsZCBkZXJpdmUgdGhlIHBvbGljeSB0aGUgc2FtZSB3YXkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbWl0SGVhZGVycyhvdXREaXI6IHN0cmluZywgc3JjRGlyOiBzdHJpbmcsIHNpdGVXaWRlV2lkZ2V0Pzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgd2lkZ2V0cyA9IFtcbiAgICAuLi5uZXcgU2V0KFtcbiAgICAgIC4uLihzaXRlV2lkZVdpZGdldCA/IFtuZXcgVVJMKHNpdGVXaWRlV2lkZ2V0KS5vcmlnaW5dIDogW10pLFxuICAgICAgLi4uZGVza09yaWdpbnMoc3JjRGlyKSxcbiAgICBdKSxcbiAgXS5zb3J0KCk7XG4gIGFzc2VydE5vVW5hbGxvd2VkT3JpZ2lucyhvdXREaXIsIHdpZGdldHMpO1xuICBjb25zdCBwb2xpY3kgPSBjc3AoaW5saW5lU2NyaXB0SGFzaGVzKG91dERpciksIHdpZGdldHMpO1xuICBjb25zdCBib2R5ID0gW1xuICAgICcjIEdFTkVSQVRFRCBieSAudml0ZXByZXNzL2hlYWRlcnMubXRzIGR1cmluZyBgdml0ZXByZXNzIGJ1aWxkYCBcdTIwMTQgZG8gbm90IGVkaXQgYnkgaGFuZC4nLFxuICAgICcjIFRoZSBzY3JpcHQgaGFzaGVzIGFyZSByZWFkIG91dCBvZiB0aGUgYnVpbHQgSFRNTCwgc28gdGhleSBmb2xsb3cgZXZlcnkgcmVidWlsZC4nLFxuICAgICcvKicsXG4gICAgYCAgQ29udGVudC1TZWN1cml0eS1Qb2xpY3k6ICR7cG9saWN5fWAsXG4gICAgJyAgWC1GcmFtZS1PcHRpb25zOiBERU5ZJyxcbiAgICAnICBYLUNvbnRlbnQtVHlwZS1PcHRpb25zOiBub3NuaWZmJyxcbiAgICAnICBSZWZlcnJlci1Qb2xpY3k6IHN0cmljdC1vcmlnaW4td2hlbi1jcm9zcy1vcmlnaW4nLFxuICAgIC8vIE5vIGNhbWVyYS9taWMvZ2VvbG9jYXRpb24gYW55d2hlcmUgb24gYSBkb2N1bWVudGF0aW9uIHNpdGUuXG4gICAgJyAgUGVybWlzc2lvbnMtUG9saWN5OiBhY2NlbGVyb21ldGVyPSgpLCBjYW1lcmE9KCksIGdlb2xvY2F0aW9uPSgpLCBneXJvc2NvcGU9KCksIG1hZ25ldG9tZXRlcj0oKSwgbWljcm9waG9uZT0oKSwgcGF5bWVudD0oKSwgdXNiPSgpJyxcbiAgICAnICBTdHJpY3QtVHJhbnNwb3J0LVNlY3VyaXR5OiBtYXgtYWdlPTMxNTM2MDAwOyBpbmNsdWRlU3ViRG9tYWlucycsXG4gICAgJycsXG4gICAgLy8gVGhlIEVQVUIgZWRpdGlvbiBvZiB0aGUgYm9vayAoZXB1Yi5tdHMpLiBQYWdlcyBndWVzc2VzIGEgY29udGVudCB0eXBlIGZyb20gdGhlXG4gICAgLy8gZXh0ZW5zaW9uIGFuZCBkb2VzIG5vdCBrbm93IHRoaXMgb25lLCBzbyBpdCB3b3VsZCBzZXJ2ZSBgYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtYFxuICAgIC8vIFx1MjAxNCBhbmQgd2l0aCBgbm9zbmlmZmAgc2V0IGFib3ZlLCBub3RoaW5nIGRvd25zdHJlYW0gaXMgYWxsb3dlZCB0byBjb3JyZWN0IHRoYXQuIGlPU1xuICAgIC8vIFNhZmFyaSBkZWNpZGVzIHdoZXRoZXIgdG8gb2ZmZXIgXCJPcGVuIGluIEJvb2tzXCIgZnJvbSB0aGUgY29udGVudCB0eXBlIGFsb25lLCBzb1xuICAgIC8vIHdpdGhvdXQgdGhpcyBsaW5lIHRoZSBmaWxlIGRvd25sb2FkcyBhcyBhbiBhbm9ueW1vdXMgYmxvYiBvbiB0aGUgb25lIGRldmljZSBtb3N0XG4gICAgLy8gbGlrZWx5IHRvIHdhbnQgaXQuXG4gICAgJy9ib29rLmVwdWInLFxuICAgICcgIENvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vZXB1Yit6aXAnLFxuICAgIC8vIFRoZSBzaXRlIG5hbWVzIHRoZSBmaWxlIGBib29rLmVwdWJgLCB3aGljaCBpcyByaWdodCBpbiBhIFVSTCBhbmQgcG9vciBpbiBhIHBob25lJ3NcbiAgICAvLyBGaWxlcyBhcHAgbmV4dCB0byBldmVyeXRoaW5nIGVsc2UgY2FsbGVkIGJvb2stc29tZXRoaW5nLiBCb29rcyB0YWtlcyBpdHMgbGlicmFyeVxuICAgIC8vIHRpdGxlIGZyb20gdGhlIHBhY2thZ2UgbWV0YWRhdGEgZWl0aGVyIHdheSwgc28gdGhpcyBvbmx5IGV2ZXIgbmFtZXMgdGhlIGRvd25sb2FkLlxuICAgICcgIENvbnRlbnQtRGlzcG9zaXRpb246IGF0dGFjaG1lbnQ7IGZpbGVuYW1lPVwic3Vic3RyYXQtZW5kLXRvLWVuZC5lcHViXCInLFxuICAgICcnLFxuICBdLmpvaW4oJ1xcbicpO1xuICB3cml0ZUZpbGVTeW5jKHJlc29sdmUob3V0RGlyLCAnX2hlYWRlcnMnKSwgYm9keSk7XG4gIHJldHVybiBwb2xpY3k7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXlkLFNBQVMsV0FBQUEsZ0JBQWU7QUFDamYsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxtQkFBbUI7OztBQytDNUIsU0FBUyxjQUFBQyxhQUFZLFdBQVcsZ0JBQUFDLGVBQWMscUJBQXFCO0FBQ25FLFNBQVMsV0FBQUMsVUFBUyxTQUFTLFFBQUFDLE9BQU0sV0FBQUMsZ0JBQWU7OztBQ3hDaEQsU0FBUyxZQUFZLGNBQWMsbUJBQW1CO0FBQ3RELFNBQVMsU0FBUyxNQUFNLGVBQWU7QUFDdkMsU0FBUyxxQkFBcUI7QUFaaVIsSUFBTSwyQ0FBMkM7QUFvQnpWLElBQU0sYUFBYTtBQUduQixTQUFTLGNBQWMsTUFBYyxNQUFjO0FBQ3hELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQSxXQUFXO0FBQUEsSUFDWCxPQUFPO0FBQUEsTUFDTCxFQUFFLE1BQU0sWUFBWSxNQUFNLFlBQVksSUFBSSxJQUFJO0FBQUEsTUFDOUMsRUFBRSxNQUFNLDZCQUE2QixNQUFNLFlBQVksSUFBSSxTQUFTO0FBQUEsTUFDcEUsRUFBRSxNQUFNLDRCQUE0QixN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MkJBQTJCLGFBQWEsVUFBVTtBQUFBLE1BQ3pFLEVBQUUsTUFBTSxZQUFZLE1BQU0scUJBQXFCLGFBQWEsYUFBYTtBQUFBLE1BQ3pFLEVBQUUsTUFBTSxXQUFXLE1BQU0sYUFBYSxhQUFhLFlBQVk7QUFBQSxNQUMvRCxFQUFFLE1BQU0sY0FBYyxNQUFNLGdCQUFnQixhQUFhLGVBQWU7QUFBQSxNQUN4RSxFQUFFLE1BQU0sYUFBYSxNQUFNLGVBQWUsYUFBYSxjQUFjO0FBQUEsTUFDckUsRUFBRSxNQUFNLFlBQVksTUFBTSxjQUFjLGFBQWEsYUFBYTtBQUFBLE1BQ2xFLEVBQUUsTUFBTSxhQUFhLE1BQU0sd0JBQXdCLGFBQWEsY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBLE1BSTlFLEVBQUUsTUFBTSxhQUFhLE1BQU0sZUFBZSxhQUFhLGNBQWM7QUFBQSxJQUN2RTtBQUFBLElBRUEsU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBLE1BSVAsVUFBVSxZQUFZO0FBQUEsTUFDdEIsV0FBVyxhQUFhO0FBQUEsTUFDeEIsY0FBYyxhQUFhO0FBQUEsTUFDM0IsYUFBYSxhQUFhO0FBQUEsTUFDMUIsZ0JBQWdCLGFBQWE7QUFBQSxNQUM3QixlQUFlLGFBQWE7QUFBQSxNQUM1QixjQUFjLGFBQWE7QUFBQSxNQUMzQixlQUFlLGFBQWE7QUFBQSxNQUM1QixlQUFlLGlCQUFpQjtBQUFBLElBQ2xDO0FBQUEsSUFFQSxTQUFTLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFO0FBQUEsSUFFekIsYUFBYSxDQUFDLEVBQUUsTUFBTSxVQUFVLE1BQU0sMkNBQTJDLENBQUM7QUFBQSxJQUVsRixRQUFRO0FBQUEsTUFDTixVQUFVO0FBQUEsSUFDWjtBQUFBLElBRUEsUUFBUTtBQUFBLE1BQ04sU0FBUztBQUFBLElBQ1g7QUFBQSxFQUNGO0FBQ0YsQ0FBQyxDQUFDOyIsCiAgIm5hbWVzIjogWyJyZXNvbHZlIiwgImV4aXN0c1N5bmMiLCAicmVhZEZpbGVTeW5jIiwgImRpcm5hbWUiLCAiam9pbiIsICJyZXNvbHZlIiwgImNhcHRpb24iLCAiYWx0IiwgImNhcHRpb24iLCAiYWx0IiwgImNhcHRpb24iLCAiYWx0IiwgImNhcHRpb24iLCAiYWx0IiwgImNhcHRpb24iLCAiYWx0IiwgIm1vZGVsX2RlZmF1bHQiLCAibW9kZWxfZGVmYXVsdCIsICJlZGdlcyIsICJzcGluZSIsICJtb2RlbF9kZWZhdWx0IiwgImFsdCIsICJhbHQiLCAiaGVhZCIsICJwbGFpbiIsICJhbHQiLCAiaGVhZCIsICJzY29wZXMiLCAiY2FwdGlvbiIsICJhbHQiLCAiY2FwdGlvbiIsICJhbHQiLCAicGxhaW4iLCAiYWx0IiwgImFsdCIsICJhbHQiLCAiYWx0IiwgImpvaW4iLCAicmVhZEZpbGVTeW5jIiwgInRleHQiLCAicGF0aCIsICJyZWdpb24iLCAicmVzb2x2ZSIsICJleGlzdHNTeW5jIiwgImRpcm5hbWUiLCAicmVhZEZpbGVTeW5jIiwgImpvaW4iLCAicmVhZEZpbGVTeW5jIiwgImpvaW4iLCAicmVhZEZpbGVTeW5jIiwgImpvaW4iLCAic291cmNlIiwgImhlYWQiLCAicmVhZEZpbGVTeW5jIiwgImpvaW4iLCAibWQiLCAicmVhZEZpbGVTeW5jIiwgImpvaW4iLCAiTWFya2Rvd25JdCIsICJUSVRMRSIsICJNYXJrZG93bkl0IiwgInNwaW5lIiwgInJlYWRGaWxlU3luYyIsICJqb2luIiwgInJlYWRGaWxlU3luYyIsICJyZWFkZGlyU3luYyIsICJ3cml0ZUZpbGVTeW5jIiwgImpvaW4iLCAicmVzb2x2ZSIsICJyZWFkZGlyU3luYyIsICJqb2luIiwgInJlYWRGaWxlU3luYyIsICJ3cml0ZUZpbGVTeW5jIiwgInJlc29sdmUiLCAicmVzb2x2ZSJdCn0K
