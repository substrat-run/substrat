#!/usr/bin/env node
// Renders tools/landing-video/hero.html into the landing page's hero video.
//
//   npm i --prefix /tmp/pw playwright-core          # once; not a workspace dependency
//   npx --prefix /tmp/pw playwright-core install chromium-headless-shell
//   (cd /tmp/pw && node <repo>/tools/landing-video/render-hero.mjs)
//
// Writes apps/docs/assets/hero/hero.mp4 and poster.webp. Needs ffmpeg with libx264
// and libwebp on PATH. CHROME_PATH overrides the browser Playwright would launch.
//
// Why a screencast and not Playwright's recordVideo: recordVideo encodes at 1x and a
// low bitrate, which smears 15 px monospace. The CDP screencast hands over each painted
// frame at 2x with its timestamp, and ffmpeg's concat demuxer keeps those timings. A
// 2 px element animates for the whole take so a still scene still produces frames.
//
// playwright-core is resolved from the directory you run this in, on purpose: it is a
// one-off authoring tool, and a workspace dependency would put a browser download in
// every `pnpm install` for a video re-rendered a few times a year.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../apps/docs/assets/hero');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'substrat-hero-'));
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright-core');

const html = fs.readFileSync(path.join(here, 'hero.html'));
const server = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${server.address().port}/`);
await page.evaluate(() => document.fonts.ready);
if (!(await page.evaluate(() => document.fonts.check('600 20px Geist') && document.fonts.check('400 20px "Geist Mono"')))) {
  throw new Error('Geist did not load (the page reads it from Google Fonts): refusing to record a fallback font');
}
await page.addStyleTag({ content: '#tick{position:fixed;right:0;bottom:0;width:2px;height:2px;background:#0E1017;animation:t 1s linear infinite}@keyframes t{0%{opacity:.02}50%{opacity:.03}100%{opacity:.02}}' });
await page.evaluate(() => { const d = document.createElement('div'); d.id = 'tick'; document.body.append(d); });

const cdp = await page.context().newCDPSession(page);
const frames = [];
let recording = false;
cdp.on('Page.screencastFrame', (f) => {
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  if (!recording) return;
  const file = path.join(work, `${String(frames.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, t: f.metadata.timestamp });
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1, maxWidth: 2880, maxHeight: 1620 });
await page.waitForTimeout(200);
recording = true;
await page.evaluate(() => window.play());
const stop = Date.now() / 1000;
recording = false;
await cdp.send('Page.stopScreencast');
const posterAt = await page.evaluate(() => window.posterAt);
await browser.close();
server.close();

let list = '';
frames.forEach((f, i) => {
  const d = (frames[i + 1]?.t ?? stop) - f.t;
  list += `file '${f.file}'\nduration ${Math.max(d, 0.001).toFixed(4)}\n`;
});
list += `file '${frames.at(-1).file}'\n`;
fs.writeFileSync(path.join(work, 'frames.txt'), list);

const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
};
ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'),
  '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-tune', 'animation', '-movflags', '+faststart', '-an',
  path.join(outDir, 'hero.mp4')]);
const poster = frames.find((f) => f.t >= posterAt) ?? frames.at(-1);
ffmpeg(['-i', poster.file, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libwebp', '-quality', '88', path.join(outDir, 'poster.webp')]);

fs.rmSync(work, { recursive: true, force: true });
console.log(`${frames.length} frames over ${(stop - frames[0].t).toFixed(1)} s → ${outDir}/hero.mp4, poster.webp`);
