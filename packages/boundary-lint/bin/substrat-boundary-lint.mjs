#!/usr/bin/env node
// The bin is this checked-in launcher rather than `dist/cli.js` directly, because a package
// manager creates the bin symlink at INSTALL time and this package's dist does not exist yet
// then. In a workspace that installs before it builds — which is every CI job, including the
// generated Substrat deploy workflow — a bin pointing straight at dist is silently never
// linked, and `substrat-boundary-lint` is "not found" at the moment the gate needs it.
// Published installs are unaffected: the tarball carries dist, and this file just forwards.
import './../dist/cli.js';
