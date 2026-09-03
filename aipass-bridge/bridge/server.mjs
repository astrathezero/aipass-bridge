// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
const MAX_BODY = 8 * 1024 * 1024;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// Bind newly created conversations to a custom aipass assistant. The form field
// name is not yet confirmed from a capture, so it is configurable; the default
// is the most likely candidate and is harmless if the server ignores it.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
// Only the image models read this; the chat models ignore it. The web UI offers
// 1:1, 3:4 and 4:3, and a request may override the default per call.
let aspectRatio = process.env.AIPASS_ASPECT_RATIO ?? '1:1';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? 'aiAssistantId';

// This bridge has no authentication, so it must not be reachable from arbitrary
// web pages — anything that can talk to it can spend the account's credits.
//
// CORS is therefore OFF by default: the CLI clients ignore CORS entirely and the
// extension reaches the bridge with host-permission privilege, so neither needs
// it. Set AIPASS_CORS_ORIGIN only if you deliberately want a browser page to
// call the bridge. Admin/deployment routes stay off unless AIPASS_ADMIN=1.
const CORS_ORIGIN = process.env.AIPASS_CORS_ORIGIN ?? '';
const ADMIN = process.env.AIPASS_ADMIN === '1';
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '::1', '[::1]',
  ...(process.env.AIPASS_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

// A DNS-rebinding attacker points a name they control at 127.0.0.1 and has the
// victim's browser POST here. Loopback literals are fine; an unexpected domain
// in the Host header is not.
function hostAllowed(req) {
  const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  return !hostname || ALLOWED_HOSTS.has(hostname);
}

const corsHeaders = () => (CORS_ORIGIN
  ? { 'access-control-allow-origin': CORS_ORIGIN, 'access-control-allow-private-network': 'true' }
  : {});

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
  // Unlike the other two this one answers with plain JSON and takes no _routes
  // parameter, so it is parsed rather than turbo-stream decoded.
  quota: '/loaders/get-usage-quota',
};

// list-models carries no field separating chat models from image/video/audio
// generators, so exclude those by id. AIPASS_MODEL_FILTER=all keeps them.
// The loader carries no category field — the tabs in the web UI (สนทนา,
// สร้างรูปภาพ, สร้างวิดีโอ, สร้างเพลง, ค้นคว้าเชิงลึก) are built client-side, so
// the grouping has to be derived here. Each rule below is annotated with the
// models it actually catches in the live list, so it can be checked against a
// fresh capture rather than trusted.
const KINDS = [
  // seedream-4.0, seedream-5.0-lite, gpt-image-2, gemini-3-pro-image, gemini-2.5-flash-image
  ['image', /seedream|gpt-image|-image$|image-preview/i],
  // veo-3.1-fast-generate-001, seedance-2.0{,-fast,-mini}
  ['video', /^veo-|seedance/i],
  // lyria-3-pro-preview, lyria-3-clip-preview
  ['music', /lyria/i],
  // openai-deep-research, sonar-deep-research. Plain sonar and
  // sonar-reasoning-pro stay under chat: they answer conversationally and only
  // search the web on the way, which is not what the deep-research tab holds.
  ['research', /deep-research/i],
];

const kindOf = (id) => KINDS.find(([, re]) => re.test(id))?.[0] ?? 'chat';

// 'all' is the default: an image model you cannot see is one you cannot select.
// Set AIPASS_MODEL_FILTER=chat to get only the models a text client can drive.
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'all';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      const kind = kindOf(id);
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        providerId: v.provider ?? null,
        description: v.description ?? null,
        kind,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        // One model in the live list is ready but not selectable
        // (openthai2.0-legal@jts); the web UI does not offer it.
        selectable: v.selectable !== false,
        isDefault: v.isDefault === true,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: kind !== 'chat' && kind !== 'research',
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  const usable = out.filter((m) => m.ready && m.selectable);
  return MODEL_FILTER === 'chat' ? usable.filter((m) => !m.media) : usable;
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
let rr = 0;

const pickClient = () => {
  const list = [...extClients];
  return list.length ? list[rr++ % list.length] : null;
};

const sendToClient = (client, event, data) =>
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

class Job {
  constructor({ kind = 'chat', modelId, text, parts, conversationId, aspectRatio: ratio, url, message, requestId, assistant, assistantField, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.parts = parts;
    this.conversationId = conversationId;
    this.aspectRatio = ratio;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for the extension'), this.timeoutMs);
  }
  dispatch() {
    const client = pickClient();
    if (!client) return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
    this.client = client;
    sendToClient(client, 'job', this.kind === 'loader'
      ? { jobId: this.id, kind: 'loader', url: this.url }
      : this.kind === 'create'
      ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField }
      : { jobId: this.id, kind: 'chat', conversationId: this.conversationId, modelId: this.modelId, text: this.text, parts: this.parts, aspectRatio: this.aspectRatio });
  }
  delta(part) { if (!this.settled) { this.touch(); this.onDelta(part); } }
  done(value) { if (this.settled) return; this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) { if (this.settled) return; this.cleanup(); this.onError(message); }
  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); jobs.delete(this.id); }
}

const fetchLoader = (url, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });


/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, selectable: true, kind: kindOf(id), thinking: null }));

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  if (!extClients.size) return cachedModels();
  if (modelRefresh) return modelRefresh; // several callers can race; only one should hit the API
  modelRefresh = (async () => {
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        const free = models.filter((m) => m.free).map((m) => m.id);
        const byKind = [...new Set(models.map((m) => m.kind))]
          .map((k) => `${models.filter((m) => m.kind === k).length} ${k}`).join(', ');
        log(`${models.length} models (${byKind})${free.length ? ` · free credit: ${free.join(', ')}` : ''}`);
      }
    } catch (err) {
      log('model refresh failed:', err.message);
    } finally {
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* --------------------------------------------------------------- credits */

// Everything but gemini-3.1-flash-lite draws on a credit pool, and until now the
// only place that number appeared was the web UI. Raw figures are integers
// scaled by creditsDecimals: 10000000000 at 6 decimals is a pool of 10,000.
let quotaCache = { at: 0, value: null };
let quotaRefresh = null;
const QUOTA_TTL_MS = 30_000;

function extractQuota(payload) {
  const credits = payload?.creditStatus?.credits;
  if (!credits) return null;
  const scale = 10 ** Number(payload.creditStatus.creditsDecimals ?? 0);
  const scaled = (v) => (v == null ? null : Number(v) / scale);
  const video = payload?.videoQuotaStatus?.count ?? null;
  return {
    limit: scaled(credits.limit),
    used: scaled(credits.used),
    available: scaled(credits.available),
    periodEndsAt: payload.creditStatus.periodEndsAt ?? null,
    video: video ? { limit: video.limit, used: video.used, remaining: video.remaining, period: video.period } : null,
    fetchedAt: payload.creditStatusFetchedAt ?? Date.now(),
  };
}

// Returns the last known figures rather than throwing when nothing is attached,
// so a caller can render "unknown" instead of an error.
async function getQuota({ force = false } = {}) {
  if (!force && quotaCache.value && Date.now() - quotaCache.at < QUOTA_TTL_MS) return quotaCache.value;
  if (!extClients.size) return quotaCache.value;
  if (quotaRefresh) return quotaRefresh; // several callers can race; only one should hit the API
  quotaRefresh = (async () => {
    try {
      const value = extractQuota(JSON.parse(await fetchLoader(LOADERS.quota)));
      if (value) {
        quotaCache = { at: Date.now(), value };
        log(`credits ${value.available.toFixed(0)} of ${value.limit.toFixed(0)} left`);
      }
    } catch (err) {
      log('credit refresh failed:', err.message);
    } finally {
      quotaRefresh = null;
    }
    return quotaCache.value;
  })();
  return quotaRefresh;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
let conversationCache = null;
let conversationList = [];
let conversationIndex = 0;

async function loadConversations() {
  if (!extClients.size) throw new Error('no extension connected — cannot look up a conversation');
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  conversationList = list;
  return list;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
async function createConversation({ modelId = defaultModel, message = 'Hello', assistant } = {}) {
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const id = findValue(decodeTurboStream(raw), 'conversationId');
  if (!id) throw new Error(`could not read a conversation id from the response: ${raw.slice(0, 200)}`);
  conversationCache = id;
  conversationIndex = 0;
  conversationList = [];
  log(`created conversation ${id}`);
  return id;
}

async function resolveConversation() {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  if (conversationCache) return conversationCache;
  if (!conversationList.length) await loadConversations();
  const pick = conversationList[conversationIndex];
  if (!pick) {
    throw new Error('no usable conversation — open https://de.aipass.net/chat, start one, then POST /config {"conversation":null}');
  }
  conversationCache = pick.id;
  log(`conversation ${conversationCache} (${pick.title ?? 'untitled'})`);
  return conversationCache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ modelId, text, parts, aspectRatio: ratio, onDelta, onDone, onError }) {
  let attempts = 0;
  let delivered = 0;
  let current = null;

  const attempt = async () => {
    attempts++;
    let conversationId;
    try { conversationId = await resolveConversation(); }
    catch (err) { return onError(err.message); }

    current = new Job({
      modelId, text, parts, conversationId, aspectRatio: ratio,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !PINNED_CONVERSATION) {
          log(`conversation ${conversationId} rejected, trying the next one`);
          conversationIndex++;
          conversationCache = null;
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

// True for loopback, link-local and RFC1918 addresses. A bare domain name is
// not classified here — that would need DNS resolution — so this blocks the
// literal-IP SSRF attempts, which is what a URL in a chat message looks like.
function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^\[?(fe80|fc|fd)/i.test(host)) return true;           // IPv6 link-local / unique-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 127 || a === 10) return true;          // this-host, loopback, private
  if (a === 169 && b === 254) return true;                    // link-local incl. cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
  return false;
}

// Fetch remote image and convert to Base64 Data URI with SSRF guard
async function fetchRemoteImageAsDataUri(urlStr) {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error(`refusing private/internal network fetch: ${host}`);
  }

  const res = await fetch(urlStr, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`remote image fetch failed with status ${res.status}`);
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    throw new Error(`expected image content-type, got ${contentType}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
    throw new Error(`image size too large: ${arrayBuffer.byteLength} bytes`);
  }
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

// Extract tool calls (JSON array, XML <tool_call>, or single JSON object) from text
function extractToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Check for ```json ... ``` or raw JSON with "tool_calls"
  const toolCallsMatch = trimmed.match(/\{[\s\S]*"tool_calls"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
  if (toolCallsMatch) {
    try {
      const parsed = JSON.parse(toolCallsMatch[0]);
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        return parsed.tool_calls.map((tc) => ({
          id: tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments || tc.function?.arguments || {}),
          },
        })).filter((tc) => tc.function.name);
      }
    } catch (_) {}
  }

  // 2. Check for <tool_call> tags
  const tagMatches = [...trimmed.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
  if (tagMatches.length > 0) {
    const calls = [];
    for (const match of tagMatches) {
      try {
        const raw = match[1].trim();
        const parsed = JSON.parse(raw);
        const name = parsed.name || parsed.function?.name;
        if (name) {
          calls.push({
            id: parsed.id || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
            type: 'function',
            function: {
              name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || parsed.function?.arguments || {}),
            },
          });
        }
      } catch (_) {}
    }
    if (calls.length > 0) return calls;
  }

  // 3. Check for single JSON tool call: {"name": "...", "arguments": {...}}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      const name = parsed.name || parsed.function?.name;
      if (name && (parsed.arguments || parsed.parameters)) {
        return [{
          id: parsed.id || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          type: 'function',
          function: {
            name,
            arguments: typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        }];
      }
    } catch (_) {}
  }

  return null;
}

// Extract multimodal parts (text and images) from OpenAI formatted messages
async function extractUserParts(messages, payload = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUser = msgs.filter((m) => m.role === 'user').at(-1);
  if (!lastUser && !msgs.some((m) => m.role === 'system')) return { text: '', parts: [] };

  const parts = [];
  const textPieces = [];

  const processContent = async (content) => {
    if (typeof content === 'string') {
      const t = content.trim();
      if (t) textPieces.push(t);
      return;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string') {
          const t = item.text.trim();
          if (t) {
            textPieces.push(t);
            parts.push({ type: 'text', text: t });
          }
        } else if (item.type === 'image_url') {
          const rawUrl = item.image_url?.url || item.url || (typeof item.image === 'string' ? item.image : null);
          if (typeof rawUrl === 'string' && rawUrl.trim()) {
            const urlStr = rawUrl.trim();
            let dataUri = '';
            if (urlStr.startsWith('data:image/')) {
              dataUri = urlStr;
            } else if (/^https?:\/\//i.test(urlStr)) {
              try {
                dataUri = await fetchRemoteImageAsDataUri(urlStr);
              } catch (err) {
                log(`warning: failed to fetch remote image ${urlStr}: ${err.message}`);
              }
            }
            if (dataUri) parts.push({ type: 'image', image: dataUri });
          }
        } else if (item.type === 'image' || item.type === 'file') {
          const raw = item.image || item.url || item.data || '';
          if (typeof raw === 'string' && raw.trim()) {
            const s = raw.trim();
            let dataUri = '';
            if (s.startsWith('data:')) {
              dataUri = s;
            } else if (/^https?:\/\//i.test(s)) {
              try {
                dataUri = await fetchRemoteImageAsDataUri(s);
              } catch (err) {
                log(`warning: failed to fetch remote image ${s}: ${err.message}`);
              }
            }
            if (dataUri) parts.push({ type: 'image', image: dataUri });
          }
        }
      }
    }
  };

  const forwardSystem = process.env.AIPASS_FORWARD_SYSTEM === '1' ||
                        process.env.AIPASS_FORWARD_SYSTEM === 'true' ||
                        Boolean(payload.tools?.length) ||
                        Boolean(payload.forward_system);

  if (forwardSystem) {
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    const systemTexts = systemMsgs.map((m) => typeof m.content === 'string' ? m.content.trim() : '').filter(Boolean);

    let preamble = systemTexts.join('\n\n');

    if (payload.tools && Array.isArray(payload.tools) && payload.tools.length > 0) {
      const toolDefs = JSON.stringify(payload.tools.map((t) => t.function || t), null, 2);
      const toolInstruction = `\n\n[Available Tools & Functions]\n${toolDefs}\n\nWhen you need to call a tool, reply ONLY with a JSON object in this format:\n{\n  "tool_calls": [\n    {\n      "name": "<function_name>",\n      "arguments": { "<param>": "<val>" }\n    }\n  ]\n}`;
      if (!preamble.includes('tool_calls') && !preamble.includes('Available Tools')) {
        preamble += toolInstruction;
      }
    }

    if (lastUser) {
      await processContent(lastUser.content);
    }

    const userText = textPieces.join('\n').trim();
    const combined = preamble ? `${preamble}\n\n${userText}`.trim() : userText;

    return {
      text: combined || (parts.length ? '[Image]' : ''),
      parts: parts.length ? parts : (combined ? [{ type: 'text', text: combined }] : [])
    };
  }

  if (lastUser) {
    await processContent(lastUser.content);
  }

  const text = textPieces.join('\n').trim();
  return {
    text: text || (parts.length ? '[Image]' : ''),
    parts: parts.length ? parts : (text ? [{ type: 'text', text }] : [])
  };
}

/* ------------------------------------------------------------ http plumbing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error') =>
  json(res, status, { error: { message, type } });

/* ---------------------------------------------------------- chat completions */

async function chatCompletions(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }

  const model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  // Not an OpenAI field, so a client that knows about it can send either
  // spelling; otherwise the bridge default applies.
  const ratio = String(payload.aspect_ratio ?? payload.imageAspectRatio ?? aspectRatio).trim() || '1:1';
  const { text, parts } = await extractUserParts(payload.messages, payload);
  if (!text && (!parts || parts.length === 0)) return oaiError(res, 400, 'no user message');

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const imageCount = (parts ?? []).filter(p => p.type === 'image').length;
  log(`chat -> ${model} (${Buffer.byteLength(text)} bytes text${imageCount ? `, ${imageCount} image(s)` : ''})`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(),
    });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    let out = '';
    const hasToolsRequested = Boolean(payload.tools && Array.isArray(payload.tools) && payload.tools.length > 0);
    let buffer = [];
    let isBuffering = hasToolsRequested;

    const flushBuffer = () => {
      if (buffer.length > 0) {
        for (const textChunk of buffer) {
          emit({ content: textChunk });
        }
        buffer = [];
      }
    };

    const job = startChat({
      modelId: model, text, parts, aspectRatio: ratio,
      onDelta: (part) => {
        if (part.kind === 'status') {
          if (TOOL_VISIBILITY === 'off') return;
          if (TOOL_VISIBILITY === 'text') emit({ content: `\n${part.text}\n` });
          else emit({ reasoning_content: `${part.text}\n` });
          return;
        }
        // Chat completions have no field for a generated image, so it goes into
        // the content as markdown — which every client already renders.
        if (part.kind === 'image') {
          out += `\n![image](${part.text})\n`;
          return void emit({ content: `\n![image](${part.text})\n` });
        }
        if (part.kind === 'reasoning') emit({ reasoning_content: part.text });
        else {
          out += part.text;
          if (isBuffering) {
            buffer.push(part.text);
            const trimmed = out.trimStart();
            // If the start does not match potential tool calls ({, `, <), stop buffering and flush
            if (trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('`') && !trimmed.startsWith('<')) {
              isBuffering = false;
              flushBuffer();
            }
          } else {
            emit({ content: part.text });
          }
        }
      },
      onDone: (finishReason) => {
        const toolCalls = extractToolCallsFromText(out);
        const hasTools = Boolean(toolCalls && toolCalls.length > 0);
        if (hasTools) {
          emit({ tool_calls: toolCalls }, 'tool_calls');
        } else {
          flushBuffer();
          emit({}, finishReason === 'length' ? 'length' : 'stop');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text, parts, aspectRatio: ratio,
      onDelta: (p) => {
        if (p.kind === 'status') { if (TOOL_VISIBILITY !== 'off') reasoning += `${p.text}\n`; return; }
        if (p.kind === 'image') { out += `\n![image](${p.text})\n`; return; }
        if (p.kind === 'reasoning') reasoning += p.text;
        else out += p.text;
      },
      onDone: (finishReason) => {
        const toolCalls = extractToolCallsFromText(out);
        const hasTools = Boolean(toolCalls && toolCalls.length > 0);
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: hasTools ? null : out,
              ...(hasTools ? { tool_calls: toolCalls } : {}),
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: hasTools ? 'tool_calls' : (finishReason === 'length' ? 'length' : 'stop'),
          }],
          // Estimates: the upstream stream reports no token counts, but some
          // clients refuse a response without a usage block.
          usage: {
            prompt_tokens: Math.ceil(text.length / 4),
            completion_tokens: Math.ceil(out.length / 4),
            total_tokens: Math.ceil((text.length + out.length) / 4),
          },
        });
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error'); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- image generations */

function resolveImageAspectRatio(ratio, size) {
  if (ratio && typeof ratio === 'string') {
    const trimmed = ratio.trim();
    if (['1:1', '3:4', '4:3'].includes(trimmed)) return trimmed;
    if (trimmed === '9:16') return '3:4';
    if (trimmed === '16:9') return '4:3';
  }
  if (size && typeof size === 'string') {
    const m = size.match(/^(\d+)\s*[xX*]\s*(\d+)$/);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w === h) return '1:1';
      if (h > w) return '3:4';
      if (w > h) return '4:3';
    }
  }
  return aspectRatio || '1:1';
}

async function imageGenerations(req, res) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body'); }

  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) return oaiError(res, 400, 'prompt is required');

  let model = String(payload.model ?? '').replace(/^aipass\//, '').trim();
  if (!model) {
    const models = cachedModels();
    const imageModel = models.find((m) => m.kind === 'image');
    model = imageModel ? imageModel.id : 'gpt-image-2';
  }

  const ratio = resolveImageAspectRatio(payload.aspect_ratio ?? payload.imageAspectRatio, payload.size);
  const responseFormat = String(payload.response_format ?? 'url').trim().toLowerCase();

  let parts = [{ type: 'text', text: prompt }];
  if (payload.image) {
    const rawImage = String(payload.image).trim();
    let dataUri = '';
    if (rawImage.startsWith('data:image/')) {
      dataUri = rawImage;
    } else if (/^https?:\/\//i.test(rawImage)) {
      try {
        dataUri = await fetchRemoteImageAsDataUri(rawImage);
      } catch (err) {
        log(`warning: failed to fetch remote input image ${rawImage}: ${err.message}`);
      }
    }
    if (dataUri) {
      parts.push({ type: 'image', image: dataUri });
    }
  }

  const created = Math.floor(Date.now() / 1000);
  log(`images.generate -> ${model} (${Buffer.byteLength(prompt)} bytes prompt, ratio ${ratio}, format ${responseFormat})`);

  const images = [];
  let outText = '';

  await new Promise((resolve) => {
    const job = startChat({
      modelId: model, text: prompt, parts, aspectRatio: ratio,
      onDelta: (p) => {
        if (p.kind === 'image') {
          images.push(p.text);
        } else if (p.kind === 'text') {
          outText += p.text;
          const matches = p.text.matchAll(/!\[image\]\(([^)]+)\)/g);
          for (const match of matches) {
            if (match[1] && !images.includes(match[1])) images.push(match[1]);
          }
        }
      },
      onDone: (finishReason) => {
        if (!images.length) {
          const matches = outText.matchAll(/!\[image\]\(([^)]+)\)/g);
          for (const match of matches) {
            if (match[1] && !images.includes(match[1])) images.push(match[1]);
          }
        }

        if (!images.length) {
          oaiError(res, 502, outText.trim() || 'no image generated by upstream model', 'upstream_error');
          resolve();
          return;
        }

        const data = images.map((img) => {
          if (responseFormat === 'b64_json') {
            const comma = img.indexOf(',');
            const b64 = comma !== -1 ? img.slice(comma + 1) : img;
            return { b64_json: b64, ...(outText ? { revised_prompt: outText.trim() } : {}) };
          }
          return { url: img, ...(outText ? { revised_prompt: outText.trim() } : {}) };
        });

        json(res, 200, {
          created,
          data,
        });
        resolve();
      },
      onError: (message) => {
        oaiError(res, 502, message, 'upstream_error');
        resolve();
      },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- extension channel */

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...corsHeaders(),
  });
  const client = { id: randomUUID(), res };
  extClients.add(client);
  log(`extension connected (${extClients.size} total)`);
  sendToClient(client, 'ready', { clientId: client.id });
  // Warm the caches a moment after the tab attaches — but only if this client
  // is still the reason to: a tab that closed in the meantime would otherwise
  // send a loader job to whoever connected next.
  const warm = (fn, ms) => setTimeout(() => { if (extClients.has(client)) fn().catch(() => {}); }, ms);
  warm(() => listModels({ force: true }), 500);
  warm(() => getQuota({ force: true }), 900);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    extClients.delete(client);
    log(`extension disconnected (${extClients.size} left)`);
    // Do NOT fail in-flight jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    for (const job of jobs.values()) if (job.client === client) job.client = null;
  });
}

async function extPost(req, res, kind) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { ok: false }); }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') for (const part of body.parts ?? []) job.delta(part);
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else job.fail(body.message ?? 'loader fetch failed');
  } else job.fail(body.message ?? 'extension reported an error');
  return json(res, 200, { ok: true });
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!hostAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden: unexpected Host header\n');
  }

  if (req.method === 'OPTIONS') {
    // Without an explicit AIPASS_CORS_ORIGIN this preflight carries no
    // allow-origin, so a browser page cannot call the bridge cross-origin.
    res.writeHead(204, {
      ...corsHeaders(),
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  try {
    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res);
    if ((path === '/v1/images/generations' || path === '/v1/images/edits') && req.method === 'POST') return await imageGenerations(req, res);

    if (path === '/quota' || path === '/credits') {
      const quota = await getQuota({ force: url.searchParams.get('refresh') === '1' });
      if (!quota) return oaiError(res, 503, 'no credit figures yet — open a de.aipass.net tab', 'unavailable');
      return json(res, 200, quota);
    }

    if (path === '/v1/models') {
      const all = await listModels({ force: url.searchParams.get('refresh') === '1' });
      // ?kind=image (or a comma-separated set) narrows the list the way the web
      // UI's tabs do.
      const want = (url.searchParams.get('kind') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
      const models = want.length ? all.filter((m) => want.includes(m.kind)) : all;
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
          kind: m.kind, description: m.description, is_default: m.isDefault,
        })),
      });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = await createConversation({ modelId: body.model, message: body.message, assistant: body.assistant });
      return json(res, 200, { id });
    }
    if (path === '/conversations') {
      await loadConversations().catch(() => {});
      return json(res, 200, {
        current: PINNED_CONVERSATION || conversationCache,
        conversations: conversationList.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        defaultModel = body.defaultModel.trim();
        log(`default model ${defaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); log(assistantId ? `assistant ${assistantId}` : 'assistant cleared'); }
      if (typeof body.aspectRatio === 'string' && body.aspectRatio.trim()) {
        aspectRatio = body.aspectRatio.trim();
        log(`aspect ratio ${aspectRatio}`);
      }
      if (body.conversation === null || typeof body.conversation === 'string') {
        conversationCache = body.conversation || null;
        conversationIndex = 0;
        if (!conversationCache) conversationList = [];
        log(conversationCache ? `conversation ${conversationCache}` : 'conversation cleared');
      }
      return json(res, 200, { ok: true, defaultModel, assistant: assistantId || null, aspectRatio, conversation: PINNED_CONVERSATION || conversationCache });
    }

    // Container-management routes. Only the Docker deployment needs these, and
    // they can restart processes, so they stay off unless AIPASS_ADMIN=1.
    if (ADMIN) {
      if (path === '/restart' && req.method === 'POST') {
        json(res, 200, { ok: true, message: 'restarting bridge server' });
        setTimeout(() => process.exit(0), 50);
        return;
      }

      if (path === '/logs') {
        const fs = await import('node:fs');
        const target = url.searchParams.get('file') || 'bridge';
        // Whitelist the name: this is interpolated into a path, so anything
        // with a separator or dot would escape /var/log.
        if (!/^[a-z0-9_-]+$/i.test(target)) {
          return json(res, 400, { ok: false, error: 'invalid log name' });
        }
        const logFile = `/var/log/${target}.log`;
        try {
          const content = fs.readFileSync(logFile, 'utf8');
          return json(res, 200, { ok: true, file: logFile, lines: content.slice(-4000) });
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      if (path === '/browser/restart' && req.method === 'POST') {
        import('node:child_process').then(({ exec }) => {
          exec('pkill -f chromium || pkill -f chrome || true');
        });
        return json(res, 200, { ok: true, message: 'restarting browser' });
      }

      if (path === '/ext/reload' && req.method === 'POST') {
        for (const client of extClients) sendToClient(client, 'reload_extension', {});
        return json(res, 200, { ok: true, message: 'reloading extension' });
      }

      if (path === '/tab/reload' && req.method === 'POST') {
        for (const client of extClients) sendToClient(client, 'reload_tab', {});
        return json(res, 200, { ok: true, message: 'reloading tab' });
      }
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path === '/ext/chunk' && req.method === 'POST') return await extPost(req, res, 'chunk');
    if (path === '/ext/done' && req.method === 'POST') return await extPost(req, res, 'done');
    if (path === '/ext/error' && req.method === 'POST') return await extPost(req, res, 'error');
    if (path === '/ext/loader' && req.method === 'POST') return await extPost(req, res, 'loader');

    if (path === '/status' || path === '/health') {
      return json(res, 200, {
        ok: true,
        extensions: extClients.size,
        activeJobs: jobs.size,
        defaultModel,
        conversation: PINNED_CONVERSATION || conversationCache,
        assistant: assistantId || null,
        aspectRatio,
        models: cachedModels(),
        credits: quotaCache.value,
      });
    }

    return oaiError(res, 404, `no route for ${req.method} ${path}`, 'not_found');
  } catch (err) {
    log('unhandled', err);
    if (!res.headersSent) oaiError(res, 500, String(err?.message ?? err), 'server_error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log(`aipass bridge on http://${HOST}:${PORT}`);
  log(`  default model : ${defaultModel}`);
  log(`  conversation  : ${PINNED_CONVERSATION || 'most recent on the account'}`);
  log('  waiting for the Chrome extension…');
});
