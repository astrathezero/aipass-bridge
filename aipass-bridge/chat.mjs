#!/usr/bin/env node
// Talk to aipass from the terminal. Streams the reply, shows server-side tool
// activity (web_search) as it happens, and lists sources at the end.
//
//   npm run chat                 interactive
//   npm run chat -- "question"   one-shot
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: npm run chat [-- "question"] [options]

  --model ID          model to use          (default: whatever the bridge is set to)
  --conversation ID   continue a specific conversation
  --new               start a fresh conversation instead of the most recent
  --bridge URL        bridge base URL       (default: http://127.0.0.1:8787)
  --ratio R           image aspect ratio    (1:1, 3:4, 4:3 — image models only)
  --out DIR           where to save generated images   (default: the cwd)
  --paste-idle MS     how long to wait before treating pasted lines as one
                      message                          (default: 60)

With a question, it answers and exits. Without one it stays interactive, where
/models lists what is available, /model <id> switches, and Ctrl+C quits.`);
  process.exit(0);
}

const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const CONVERSATION = flag('conversation', null);
const NEW = argv.includes('--new');
let model = flag('model', null);
const OUT_DIR = path.resolve(flag('out', process.cwd()));
const RATIO = flag('ratio', null);
const VALUE_FLAGS = new Set(['--model', '--conversation', '--bridge', '--ratio', '--out', '--paste-idle']);
const question = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1])).join(' ').trim();

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const status = await fetch(`${BRIDGE}/status`).then((r) => r.json()).catch(() => null);
if (!status) {
  console.error(red(`No bridge at ${BRIDGE}. Start it with: npm run dev`));
  process.exit(1);
}
if (!status.extensions) {
  console.error(red('The extension is not connected. Open a https://de.aipass.net/chat tab.'));
  process.exit(1);
}
model ??= status.defaultModel;

if (CONVERSATION) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation: CONVERSATION }),
  }).catch(() => {});
} else if (NEW) {
  const made = await fetch(`${BRIDGE}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, message: 'New chat.' }),
  }).then((r) => r.json()).catch(() => null);
  if (made?.id) status.conversation = made.id;
}

// An image model answers with a data URI, which is megabytes of base64 — write
// it out and print where it went, rather than filling the scrollback with it.
let saved = 0;
function keepImages(chunk) {
  return chunk.replace(/!\[image\]\((data:([^;,)]+)[^)]*)\)/g, (whole, uri, mime) => {
    try {
      const comma = uri.indexOf(',');
      if (comma === -1) return whole;
      const ext = (mime.split('/')[1] || 'png').replace(/^jpeg$/, 'jpg');
      const file = path.join(OUT_DIR, `aipass-${Date.now()}-${++saved}.${ext}`);
      fs.writeFileSync(file, Buffer.from(uri.slice(comma + 1), 'base64'));
      return `\n${cyan(`[image saved to ${file}]`)}\n`;
    } catch (err) {
      return `\n[image could not be saved: ${err.message}]\n`;
    }
  });
}

async function ask(text) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: true, messages: [{ role: 'user', content: text }],
      ...(RATIO ? { aspect_ratio: RATIO } : {}),
    }),
  });
  if (!res.ok) {
    console.error(red(`\nbridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let wrote = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) { console.error(red(`\n${evt.error.message}`)); return; }
      const delta = evt.choices?.[0]?.delta ?? {};
      // Tool progress and sources, kept visually distinct from the answer.
      if (delta.reasoning_content) stdout.write(cyan(delta.reasoning_content));
      if (delta.content) { stdout.write(keepImages(delta.content)); wrote = true; }
    }
  }
  stdout.write(wrote ? '\n' : dim('\n(no reply)\n'));
}

if (question) {
  await ask(question);
  // process.exit() drops a stdout write libuv has not finished, which on
  // Windows aborts with 0xC0000409 rather than exiting 0. Flush first. The
  // explicit exit stays: Node's fetch holds a pooled socket open and would
  // otherwise keep the process alive for seconds after the answer is printed.
  await new Promise((resolve) => stdout.write('', resolve));
  process.exit(0);
}

console.log(bold('aipass') + dim(`  model ${model}  ·  conversation ${status.conversation ?? 'resolves on first message'}`));
console.log(dim('/model <id> to switch  ·  /models to list  ·  paste sends as one  ·  Ctrl+C to quit\n'));

// Readline reports one line per newline, so pasting a block used to send it as
// one message per line — a thirteen-line menu became thirteen requests, each
// billed, and the model saw only the first line as the question. A paste
// arrives as a burst of line events within a few milliseconds; nobody types a
// whole line that fast, so a short idle separates a paste from a keystroke.
const PASTE_IDLE_MS = Number(flag('paste-idle', 60));

const rl = readline.createInterface({ input: stdin, output: stdout });
rl.setPrompt(bold('> '));
rl.prompt();

let buffered = [];
let idleTimer = null;
let chain = Promise.resolve();

async function handleBlock(lines) {
  const block = lines.join('\n').trim();
  if (!block) return;

  if (lines.length === 1 && block === '/models') {
    const { data } = await fetch(`${BRIDGE}/v1/models`).then((r) => r.json());
    for (const m of data) console.log(`  ${m.id.padEnd(38)} ${m.name}${m.free_credit ? dim('  [free]') : ''}`);
    return;
  }
  if (lines.length === 1 && block.startsWith('/model ')) {
    model = block.slice(7).trim();
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultModel: model }),
    }).catch(() => {});
    console.log(dim(`  model ${model}`));
    return;
  }

  // Say so, because one message out of many lines is the surprising direction.
  if (lines.length > 1) console.log(dim(`  (${lines.length} lines · sent as one message)`));
  await ask(block);
  console.log();
}

let closed = false;

function submit() {
  const lines = buffered;
  buffered = [];
  chain = chain.then(() => handleBlock(lines)).then(() => { if (!closed) rl.prompt(); });
}

rl.on('line', (raw) => {
  buffered.push(raw);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(submit, PASTE_IDLE_MS);
});

rl.on('SIGINT', () => rl.close());
await new Promise((resolve) => rl.on('close', resolve));
closed = true;
// EOF arrives before the idle timer when input is piped, and end-of-input is a
// submit, not a discard — otherwise a piped block is silently dropped.
clearTimeout(idleTimer);
if (buffered.length) submit();
await chain;
