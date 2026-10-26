// Health SA's proxy to the Claude API. The dashboard can't hold the Anthropic key, so it
// calls this Worker, which:
//   - answers only the dashboard's own origins (CORS), never a request without one;
//   - requires a signed-in Supabase user, checked with Supabase Auth on every request;
//   - rate-limits each address and each user, in D1 (failed sign-ins count too);
//   - forwards only what the dashboard sends: one allow-listed model, a max_tokens cap
//     and plain-text messages. Everything else in the body is dropped.
//
// Config lives in wrangler.jsonc: vars ALLOWED_ORIGINS, SUPABASE_URL and SUPABASE_ANON_KEY,
// the secret ANTHROPIC_API_KEY, and the D1 binding DB (schema in migrations/). If any of
// them is missing, the Worker refuses every request rather than run open.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ALLOWED_MODELS = new Set(['claude-haiku-4-5-20251001']);
const MAX_TOKENS = 1024; // what the dashboard asks for
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SYSTEM_CHARS = 20_000; // the dashboard's prompt is ~7K characters, ~10K with long goals
const MAX_MESSAGES = 6; // the dashboard keeps at most the last 6
const MAX_MESSAGE_CHARS = 10_000; // a 1,024-token reply is ~5K characters

// Requests allowed per 10 minutes and per day. At most ~16K input and 1,024 output tokens
// each for English text, so one user spends about $1.20 a day at most on Haiku 4.5.
const LIMITS = {
  ip: { burst: 30, daily: 150 },
  user: { burst: 15, daily: 60 },
};
const BURST_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

// Records the request against a bucket only while the bucket is under both of its limits.
// It's one statement, so requests that arrive together can't all see a low count.
const TAKE_SLOT = `INSERT INTO rate_events (bucket, at) SELECT ?, ?
  WHERE (SELECT COUNT(*) FROM rate_events WHERE bucket = ? AND at > ?) < ?
    AND (SELECT COUNT(*) FROM rate_events WHERE bucket = ? AND at > ?) < ?`;

const REQUIRED_CONFIG = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ALLOWED_ORIGINS', 'DB'];

export default {
  async fetch(request, env) {
    const response = await handle(request, env);
    // An answer sent without reading the body can break the connection for the next request,
    // so drain a small unread body. A large or unsized one is cancelled instead of read.
    if (request.body && !request.bodyUsed) {
      const length = request.headers.get('Content-Length');
      const small = length !== null && Number(length) <= MAX_BODY_BYTES;
      await (small ? request.body.pipeTo(new WritableStream()) : request.body.cancel()).catch(() => {});
    }
    return response;
  },
};

async function handle(request, env) {
  const missing = REQUIRED_CONFIG.filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Refusing requests until configured: ${missing.join(', ')}`);
    return error(503, 'not_configured', 'The AI service is not set up yet.');
  }

  // Keeps other sites' pages from using a visitor's browser. It is not authentication: a script
  // can send any Origin, which is why every request also needs a Supabase session.
  const origin = request.headers.get('Origin');
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  if (!origin || !allowedOrigins.includes(origin)) {
    return error(403, 'forbidden_origin', 'This site may not use the AI service.');
  }
  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    return await proxy(request, env, cors);
  } catch (err) {
    // Still closed (e.g. D1 is down), but answered with CORS so the dashboard can show it.
    console.error(`Request failed: ${err}`);
    return error(503, 'unavailable', 'The AI service is unavailable right now. Please try again shortly.', cors);
  }
}

async function proxy(request, env, cors) {
  if (request.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST.', cors);
  if (new URL(request.url).pathname !== '/') return error(404, 'not_found', 'Not found.', cors);
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') ?? '')) {
    return error(415, 'unsupported_media_type', 'Send the request as JSON.', cors);
  }

  const signedOut = () => error(401, 'auth_error', 'Your sign-in has expired. Sign in again to use the AI analysis.', cors);
  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, '');
  const token = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)$/i)?.[1];
  const now = Date.now();
  if (!token || !looksLikeSession(token, supabaseUrl, now)) return signedOut();

  const text = await readBody(request, MAX_BODY_BYTES);
  if (text === null) return error(413, 'request_too_large', 'The request is too large.', cors);
  const parsed = parseBody(text);
  if (parsed.error) return error(400, 'invalid_request_error', parsed.error, cors);

  // Count the attempt against the address before asking Supabase, so a flood of bad tokens
  // from one place is cut off. Also clears out rows older than the longest window.
  const address = addressBucket(request.headers.get('CF-Connecting-IP') ?? 'unknown');
  const [, ipSlot] = await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_events WHERE at <= ?').bind(now - DAY_MS),
    takeSlot(env.DB, `ip:${address}`, LIMITS.ip, now),
  ]);
  if (ipSlot.meta.changes !== 1) {
    console.warn(`Rate limited ip:${address}`);
    return error(429, 'rate_limit_error', 'Too many AI requests from your network. Please wait a few minutes and try again.', cors);
  }

  const auth = await supabaseUser(token, supabaseUrl, env.SUPABASE_ANON_KEY);
  if (auth.unavailable) return error(503, 'auth_unavailable', 'Sign-in could not be checked right now. Please try again shortly.', cors);
  if (!auth.userId) return signedOut();

  const userSlot = await takeSlot(env.DB, `user:${auth.userId}`, LIMITS.user, now).run();
  if (userSlot.meta.changes !== 1) {
    // Only this user is over their limit, so the request doesn't count against their network.
    await releaseSlots(env.DB, ipSlot);
    console.warn(`Rate limited user:${auth.userId}`);
    const { burst, daily } = LIMITS.user;
    return error(429, 'rate_limit_error', `You've reached the AI limit (${burst} requests per 10 minutes, ${daily} per day). Please try again later.`, cors);
  }

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      // The user id is the Supabase UUID: opaque, and lets Anthropic attribute abuse to one user.
      body: JSON.stringify({ ...parsed.body, metadata: { user_id: auth.userId } }),
    });
  } catch (err) {
    console.error(`Claude API unreachable: ${err}`);
    await releaseSlots(env.DB, ipSlot, userSlot);
    return error(502, 'api_error', 'The AI service could not be reached. Please try again.', cors);
  }

  if (!upstream.ok) {
    // Keep Anthropic's own errors (bad key, billing, rate limits) out of the browser.
    console.error(`Claude API error ${upstream.status}: ${(await upstream.text()).slice(0, 500)}`);
    if (upstream.status === 400) return error(400, 'invalid_request_error', 'The AI service could not process this request.', cors);
    // Anything else isn't the user's doing, so it doesn't use up their allowance.
    await releaseSlots(env.DB, ipSlot, userSlot);
    if (upstream.status === 429 || upstream.status >= 500) {
      return error(503, 'overloaded_error', 'The AI service is busy. Please try again in a minute.', cors);
    }
    return error(502, 'api_error', 'The AI service is unavailable right now.', cors);
  }

  // Stream the answer through, without Anthropic's account and rate-limit headers.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function error(status, type, message, headers = {}) {
  return Response.json({ error: { type, message } }, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

// Cheap checks before asking Supabase: a JWT issued by this project's Auth server (not the
// public anon key) that hasn't expired. Supabase Auth still checks the signature and session.
function looksLikeSession(token, supabaseUrl, now) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let claims;
  try {
    const binary = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    return false;
  }
  return claims?.iss === `${supabaseUrl}/auth/v1` && typeof claims.exp === 'number' && claims.exp * 1000 > now;
}

// Asks Supabase Auth who the token belongs to. Supabase recommends this check for projects on
// the legacy JWT secret; it also notices sign-outs and deleted users straight away.
async function supabaseUser(token, supabaseUrl, anonKey) {
  let res;
  try {
    res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`Supabase Auth unreachable: ${err}`);
    return { unavailable: true };
  }
  if (res.status === 429 || res.status >= 500) {
    console.error(`Supabase Auth error ${res.status}`);
    return { unavailable: true };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    // Supabase's gateway answers 401 "Invalid API key" or "No API key found" when the anon key is
    // wrong. That's this Worker's config, not the user's session.
    if (res.status === 401 && /api key/i.test(detail)) {
      console.error(`Supabase rejected SUPABASE_ANON_KEY: ${res.status} ${detail}`);
      return { unavailable: true };
    }
    console.warn(`Supabase Auth refused a token: ${res.status} ${detail}`);
    return {};
  }
  const user = await res.json().catch(() => null);
  // Anonymous (guest) sign-ins also get role "authenticated"; they don't get the AI.
  if (typeof user?.id !== 'string' || user.is_anonymous) return {};
  return { userId: user.id };
}

// IPv6 users usually hold a whole /64, so an IPv6 address counts by its first four groups.
function addressBucket(ip) {
  if (ip.includes('.')) return ip.slice(ip.lastIndexOf(':') + 1); // IPv4, or IPv4-mapped IPv6
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    groups.push(...Array(Math.max(0, 8 - groups.length - rest.length)).fill('0'), ...rest);
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function takeSlot(db, bucket, { burst, daily }, now) {
  return db.prepare(TAKE_SLOT).bind(bucket, now, bucket, now - BURST_WINDOW_MS, burst, bucket, now - DAY_MS, daily);
}

function releaseSlots(db, ...slots) {
  return db.batch(slots.map((slot) => db.prepare('DELETE FROM rate_events WHERE rowid = ?').bind(slot.meta.last_row_id)));
}

// Reads at most maxBytes of the body; null if it is larger.
async function readBody(request, maxBytes) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Rebuilds the body from the fields the dashboard uses, so nothing else (tools, thinking,
// other models, bigger budgets, URL-fetched images or documents) reaches the API.
function parseBody(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    return { error: 'The request body is not valid JSON.' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'The request body must be a JSON object.' };

  const { model, max_tokens: maxTokens, stream, system, messages } = input;
  if (!ALLOWED_MODELS.has(model)) return { error: `model must be ${[...ALLOWED_MODELS].join(' or ')}.` };
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    return { error: `max_tokens must be a whole number from 1 to ${MAX_TOKENS}.` };
  }
  if (system !== undefined && (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS)) {
    return { error: `system must be text of at most ${MAX_SYSTEM_CHARS} characters.` };
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    return { error: `messages must be a list of 1 to ${MAX_MESSAGES} messages.` };
  }
  // The API also refuses blank messages and a conversation that starts with the assistant.
  const plainText = (m) =>
    (m?.role === 'user' || m?.role === 'assistant') &&
    typeof m.content === 'string' &&
    m.content.trim() !== '' &&
    m.content.length <= MAX_MESSAGE_CHARS;
  if (!messages.every(plainText)) {
    return { error: `Each message needs the role user or assistant and text of 1 to ${MAX_MESSAGE_CHARS} characters.` };
  }
  if (messages[0].role !== 'user') return { error: 'The conversation must start with a user message.' };

  const body = { model, max_tokens: maxTokens, messages: messages.map(({ role, content }) => ({ role, content })) };
  if (system) body.system = system;
  if (stream === true) body.stream = true;
  return { body };
}
