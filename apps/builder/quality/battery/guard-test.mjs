import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { guard } from './guard.mjs';
// The paths are this machine's: the sessions' scratch tree, written both ways /tmp may be named, and a home folder.
const SESSIONS = `${realpathSync('/tmp')}/claude-${process.getuid()}`;
const SHORT = `/tmp/claude-${process.getuid()}`;
const HOME = homedir();
const CACHE = `${HOME}/.cache/browsers-abc`; // a prefix the caller allows, as run-tester.sh allows playwright-core
const W = `${SESSIONS}/x/work`; const g = guard(W, [CACHE]);
const OWN = `${SESSIONS}/${W.replace(/\//g, '-')}/abc/notes`; // the run's own scratch folder
const cases = [
  ['Bash', { command: 'lsof -ti:3000 | xargs kill' }, true],
  ['Bash', { command: 'kill $(lsof -t -i:3000)' }, true],
  ['Bash', { command: 'PID=$(lsof -ti tcp:3000); kill -9 $PID' }, true],
  ['Bash', { command: 'pkill -f node' }, true],
  ['Bash', { command: 'npx kill-port 3000' }, true],
  ['Bash', { command: 'kill -9 1' }, true],
  ['Bash', { command: `kill ${process.pid}` }, false],
  ['Bash', { command: 'kill %1' }, false],
  ['Bash', { command: 'kill $SERVER_PID' }, false],
  ['Bash', { command: 'npm install -g nodemon' }, true],
  ['Bash', { command: 'npm install better-sqlite3' }, false],
  ['Bash', { command: 'node server.js & sleep 2; curl -s localhost:3456/' }, false],
  ['Write', { file_path: W + '/a.js' }, false],
  ['Bash', { command: `ls ${HOME}/projects/substrat` }, true],
  ['Bash', { command: `cat ${SHORT}/x/work/a.js` }, false],
  ['Bash', { command: 'kill $(cat .scratch/pid)' }, false],
  ['Bash', { command: "cat > test/a.test.js <<'EOF'\nconst x = '../../lib'; child.kill(); // lsof -ti | xargs kill\nEOF\nnode --test" }, false],
  ['Bash', { command: "cat > a.sh <<'EOF'\nok\nEOF\npkill node" }, true],
  ['Bash', { command: 'kill $(pgrep -f server.js)' }, true],
  ['Bash', { command: 'node --check /tmp/x.js; DB=$TMPDIR/a.db node s.js' }, false],
  ['Bash', { command: `ls ${SHORT}/` }, true],
  ['Bash', { command: `S=${OWN}; mkdir -p $S` }, false],
  ['Write', { file_path: `${OWN}/n.txt` }, false],
  ['Write', { file_path: `${CACHE}/x.js` }, true],
  ['Bash', { command: `ls ${SESSIONS}/other` }, true],
  ['Bash', { command: 'cd ' + W + ' && npm start' }, false],
  ['Bash', { command: 'ls ../..' }, true],
  ['Bash', { command: 'cd .. && ls' }, true],
  ['Bash', { command: `node -e "require('${CACHE}/node_modules/playwright-core')"` }, false],
  ['Read', { file_path: `${HOME}/.claude/CLAUDE.md` }, true],
  ['Read', { file_path: 'src/a.js' }, false],
  ['Grep', { pattern: 'x', path: HOME }, true],
  ['Bash', { command: 'curl -s http://localhost:18800/dev/personas' }, false],
  ['Write', { file_path: 'a/b.js' }, false],
  ['Write', { file_path: '/tmp/a.js' }, true],
  ['Edit', { file_path: W + 'other/a.js' }, true],
];
let bad = 0;
for (const [tool_name, tool_input, want] of cases) {
  const r = await g({ tool_name, tool_input });
  const got = r.hookSpecificOutput?.permissionDecision === 'deny';
  if (got !== want) { bad++; console.log('WRONG', tool_name, JSON.stringify(tool_input), 'denied=', got); }
}
console.log(bad ? `${bad} wrong` : `all ${cases.length} right`);
