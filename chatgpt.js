
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const AUTHORIZED_SCOPE = 'chatgpt.tokens.use.direct';
const CREDENTIALS_KEY = 'chatgptCredentials';
const PENDING_KEY = 'chatgptPendingAttempt';
const SERVICE_HOSTS = ['auth.openai.com', 'api.openai.com'];

let credentialQueue = Promise.resolve();

function credentialsLocked(action) {
  const previous = credentialQueue;
  let release;
  credentialQueue = new Promise(resolve => { release = resolve; });
  return previous.then(action).finally(release);
}

function base64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error('Invalid sign-in token encoding.');
  const bytes = Uint8Array.from(atob(
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4),
  ), character => character.charCodeAt(0));
  if (base64url(bytes) !== value)
    throw new Error('Invalid sign-in token encoding.');
  return bytes;
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function form(values) {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function serviceUrl(path) {
  const url = new URL(path, ISSUER);
  if (url.protocol !== 'https:' || !SERVICE_HOSTS.includes(url.hostname) ||
    url.username || url.password || !['', '443'].includes(url.port))
    throw new Error('Invalid ChatGPT service address.');
  return url.href;
}

async function readCredentials() {
  const stored = await browser.storage.local.get(CREDENTIALS_KEY);
  const record = stored[CREDENTIALS_KEY];
  if (!record) return {profiles: {}};
  if (!record.profiles || typeof record.profiles !== 'object' || Array.isArray(record.profiles))
    throw new Error('The saved ChatGPT connection is invalid. Sign in again to repair it.');
  return record;
}

async function saveCredentials(record) {
  await browser.storage.local.set({[CREDENTIALS_KEY]: record});
}

export async function verifyIdToken(token, keys, clientId, nonce = null, subject = null, now = Date.now() / 1000) {
  if (typeof token !== 'string' || token.length > 32768)
    throw new Error('Invalid sign-in token.');
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new Error('Invalid sign-in token.');
  const header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode64(parts[0])));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit || header.b64 === false)
    throw new Error('Unsupported sign-in signature.');
  const matches = keys.filter(key => key.kid === header.kid && key.kty === 'RSA' &&
    (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') &&
    (!key.key_ops || key.key_ops.includes('verify')));
  if (matches.length !== 1)
    throw new Error('The sign-in signing key could not be verified.');
  const signature = decode64(parts[2]);
  if (signature.byteLength < 256 || signature.byteLength > 1024)
    throw new Error('Invalid sign-in signing key.');
  const key = await crypto.subtle.importKey(
    'jwk',
    {...matches[0], ext: true, key_ops: ['verify']},
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))
    throw new Error('The sign-in signature is invalid.');
  const claims = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode64(parts[1])));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    (audiences.length > 1 && claims.azp !== clientId) ||
    !Number.isFinite(claims.exp) || claims.exp <= now ||
    (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
    typeof claims.sub !== 'string' || !claims.sub ||
    (nonce !== null && claims.nonce !== nonce) || (subject !== null && claims.sub !== subject))
    throw new Error('The sign-in identity could not be verified. Please sign in again.');
  return claims;
}

function callbackResult(query, state, clientId = null) {
  if (!query || query.state !== state)
    throw new Error('Invalid sign-in state.');
  if (query.error)
    throw new Error(query.error === 'access_denied' ? 'ChatGPT sign-in was declined.' : 'ChatGPT sign-in failed.');
  const issued = query.client_id || clientId;
  if (!issued || issued === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]{1,256}$/.test(issued) ||
    (clientId && issued !== clientId) || typeof query.code !== 'string' || !query.code)
    throw new Error('ChatGPT registration was incomplete or changed accounts. Try signing in again.');
  return {clientId: issued, code: query.code};
}

function chatgptError(code, status = 0) {
  if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code) || status === 429)
    return new Error('ChatGPT usage is unavailable or a limit was reached. Open Manage usage in Plyph settings.');
  if (code === 'invalid_grant' || status === 401)
    return new Error('Your ChatGPT connection expired. Continue with ChatGPT in Plyph settings.');
  if (status === 403)
    return new Error('ChatGPT plan access was denied. Check permissions in ChatGPT settings.');
  return new Error(status ? `ChatGPT could not complete the request (${status}). Try again.` :
    'ChatGPT could not complete the response. Try again.');
}

function tokensProfile(tokens, previous, identity = null) {
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous.scopes ?? [];
  if (tokens.token_type?.toLowerCase() !== 'bearer' || typeof tokens.access_token !== 'string' || !tokens.access_token ||
    !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
    (typeof (tokens.refresh_token ?? previous.refresh_token) !== 'string' || !(tokens.refresh_token ?? previous.refresh_token)))
    throw new Error('ChatGPT returned an incomplete connection. Please sign in again.');
  return {
    ...previous,
    subject: identity?.sub ?? previous.subject,
    email: identity?.email_verified === false ? '' : identity?.email ?? previous.email ?? '',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? previous.refresh_token,
    id_token: tokens.id_token ?? previous.id_token,
    expires_at: Date.now() / 1000 + tokens.expires_in,
    scopes,
  };
}

class ResponsesStream {
  constructor() {
    this.buffer = '';
    this.size = 0;
    this.output = '';
    this.items = new Map();
    this.completed = false;
  }

  feed(chunk) {
    this.size += chunk.length;
    if (this.size > 8 * 1024 * 1024)
      throw new Error('The ChatGPT response is too large. Select less text.');
    this.buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]')
        continue;
      const event = JSON.parse(data);
      if (event.type === 'error' || event.type === 'response.failed')
        throw chatgptError(event.code ?? event.error?.code ?? event.response?.error?.code);
      if (event.type === 'response.incomplete')
        throw new Error('ChatGPT returned an incomplete response. Try a shorter request.');
      if (event.type === 'response.output_item.done' && event.item?.type === 'message' &&
        Number.isInteger(event.output_index) && event.output_index >= 0)
        this.items.set(event.output_index, event.item);
      if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed')
          throw new Error('ChatGPT did not complete the response.');
        const output = event.response.output?.length ? event.response.output
          : [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        const messages = output.filter(item => item.type === 'message');
        this.output = messages.flatMap(item => item.content ?? [])
          .filter(item => item.type === 'output_text' || item.type === 'refusal')
          .map(item => item.text ?? item.refusal ?? '').join('');
        this.completed = true;
      }
    }
  }

  finish() {
    if (!this.completed)
      throw new Error('ChatGPT disconnected before completing the response. Nothing was replaced.');
    if (!this.output.trim())
      throw new Error('ChatGPT returned no text.');
    return this.output.trim();
  }
}

let callbackRedirectListener = null;

function installCallbackRedirect() {
  removeCallbackRedirect();
  callbackRedirectListener = details => {
    try {
      const url = new URL(details.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return {};
      if (!/^\/auth\/callback(\?.*)?$/.test(url.pathname + url.search)) return {};
      return {redirectUrl: browser.runtime.getURL('chatgpt-callback.html') + url.search};
    } catch { return {}; }
  };
  browser.webRequest.onBeforeRequest.addListener(
    callbackRedirectListener,
    {urls: ['http://127.0.0.1/*'], types: ['main_frame']},
    ['blocking'],
  );
}

function removeCallbackRedirect() {
  if (!callbackRedirectListener) return;
  try { browser.webRequest.onBeforeRequest.removeListener(callbackRedirectListener); } catch {  }
  callbackRedirectListener = null;
}

export class ChatGPTClient {
  async _json(path, data = null, token = null, timeoutMs = 45000) {
    const url = serviceUrl(path);
    let response;
    try {
      response = await fetch(url, {
        method: data === null ? 'GET' : 'POST',
        headers: {
          ...(data === null ? {} : {'Content-Type': 'application/x-www-form-urlencoded'}),
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        ...(data === null ? {} : {body: form(data)}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('Could not reach the ChatGPT service. Check your connection.');
    }
    let result = {};
    try {
      const text = await response.text();
      if (text.trim()) result = JSON.parse(text);
    } catch {
      throw chatgptError(null, response.status);
    }
    if (!response.ok) {
      const code = typeof result.error === 'string' ? result.error : result.error?.code;
      const error = chatgptError(code, response.status);
      error.oauthCode = code;

      const description = result.error_description ?? result.error?.error_description ??
        (typeof result.error?.message === 'string' ? result.error.message : null);
      if (typeof description === 'string' && description.trim())
        error.oauthDescription = description.trim().slice(0, 300);
      throw error;
    }
    return result;
  }

  async _validate(tokens, clientId, nonce, subject) {
    const jwks = await this._json(`${ISSUER}/.well-known/jwks.json`);
    return verifyIdToken(tokens.id_token, jwks.keys ?? [], clientId, nonce, subject);
  }

  async accounts() {
    return credentialsLocked(async () => {
      const record = await readCredentials();
      return Object.entries(record.profiles).map(([id, profile]) => ({
        id,
        label: `${profile.email || 'ChatGPT account'} · ${id.slice(-6)}`,
        connected: Boolean(profile.refresh_token),
        authorized: (profile.scopes ?? []).includes(AUTHORIZED_SCOPE),
      }));
    });
  }

  async signIn(clientId = null) {
    const prepared = await credentialsLocked(async () => {
      const record = await readCredentials();
      if (!record.host_id) {
        record.host_id = `urn:uuid:${crypto.randomUUID()}`;
        await saveCredentials(record);
      }
      if (clientId && !record.profiles[clientId])
        throw new Error('Select a saved ChatGPT account or add a new account.');
      return {host: record.host_id, previous: record.profiles[clientId]};
    });
    try {
      return await this._attemptSignIn(clientId, prepared, null);
    } catch (error) {

      if (!error.retriableExchange || !error.issuedClientId || error.issuedClientId === clientId)
        throw error;
      return await this._attemptSignIn(error.issuedClientId, prepared, null);
    }
  }

  async _attemptSignIn(clientId, prepared, fresh = null) {
    const state = fresh?.state ?? randomToken();
    const nonce = fresh?.nonce ?? randomToken();
    const verifier = fresh?.verifier ?? randomToken();

    const redirect = fresh?.redirect ??
      `http://127.0.0.1:${11000 + crypto.getRandomValues(new Uint16Array(1))[0] % 50000}/auth/callback`;
    const challenge = base64url(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    );
    const params = {
      client_id: clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: prepared.host,
      response_type: 'code',
      redirect_uri: redirect,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    };
    if (!clientId) params.agent_name_hint = 'Plyph';
    else {
      if (prepared.previous?.email) params.login_hint = prepared.previous.email;
      if (prepared.previous?.id_token) params.id_token_hint = prepared.previous.id_token;
    }
    const context = {
      state, clientId, verifier, redirect, nonce,
      previousSubject: prepared.previous?.subject ?? null, ts: Date.now(),
    };
    const query = await this._authorize(params, context);
    return await this._completeSignIn({...context, query});
  }

  async _completeSignIn({query, state, clientId, verifier, redirect, nonce, previousSubject}) {
    try {
      const callback = callbackResult(query, state, clientId);
      let tokens;
      try {
        tokens = await this._json(`${ISSUER}/api/accounts/oauth/token`, {
          grant_type: 'authorization_code',
          client_id: callback.clientId,
          code: callback.code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: RESOURCE,
        });
      } catch (error) {
        if (error.oauthCode === 'invalid_grant') {
          error.issuedClientId = callback.clientId;
          error.retriableExchange = true;

          if (error.oauthDescription)
            error.message = `ChatGPT sign-in failed: ${error.oauthDescription}`;
        }
        throw error;
      }
      const identity = await this._validate(tokens, callback.clientId, nonce, previousSubject);
      const profile = tokensProfile(tokens, {client_id: callback.clientId}, identity);
      await credentialsLocked(async () => {
        const record = await readCredentials();
        const existing = record.profiles[callback.clientId];
        if (existing && existing.subject !== profile.subject)
          throw new Error('The ChatGPT account identity changed. Add it as a new account.');
        record.profiles[callback.clientId] = profile;
        await saveCredentials(record);
      });
      return {id: callback.clientId, authorized: profile.scopes.includes(AUTHORIZED_SCOPE)};
    } finally {
      try { await browser.storage.session.remove(PENDING_KEY); } catch {  }
    }
  }

  _abandonPending() {
    const pending = this._pending;
    this._pending = null;
    if (pending) pending.finish(null, new Error('A newer sign-in attempt replaced this one.'));
  }

  _authorize(params, context = null) {
    this._abandonPending();
    return new Promise((resolve, reject) => {
      let settled = false;
      let windowId = null;
      const timer = setTimeout(
        () => finish(null, new Error('ChatGPT sign-in timed out. Try again.')),
        180000,
      );
      const cleanup = async () => {
        browser.windows.onRemoved.removeListener(onRemoved);
        removeCallbackRedirect();
        const id = windowId;
        windowId = null;
        if (id !== null) {

          setTimeout(() => browser.windows.remove(id).catch(() => {}), 900);
        }
      };
      const attempt = {state: params.state, finish: null};
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._pending === attempt) this._pending = null;

        if (error) {
          try { browser.storage.session.remove(PENDING_KEY).catch(() => {}); } catch {  }
        }
        cleanup().finally(() => {
          if (error) reject(error);
          else resolve(value);
        });
      };
      attempt.finish = finish;
      this._pending = attempt;
      const onRemoved = id => {
        if (id === windowId)
          finish(null, new Error('ChatGPT sign-in was cancelled.'));
      };
      (async () => {

        if (context) {
          try { await browser.storage.session.set({[PENDING_KEY]: context}); } catch {  }
        }
        installCallbackRedirect();
        browser.windows.onRemoved.addListener(onRemoved);
        const created = await browser.windows.create({
          url: `${ISSUER}/api/accounts/authorize?${form(params)}`,
          type: 'popup',
          width: 480,
          height: 720,
          focused: true,
        });
        windowId = created.id;
      })().catch(error => finish(null, error));
    });
  }

  async consumeCallback(query) {
    const pending = this._pending;
    if (pending && query && typeof query.state === 'string' && query.state === pending.state) {
      pending.finish(query);
      return true;
    }
    let attempt = null;
    try {
      attempt = (await browser.storage.session.get(PENDING_KEY))[PENDING_KEY] ?? null;
    } catch {
      return false;
    }
    if (!attempt || !query || query.state !== attempt.state ||
      Date.now() - attempt.ts > 10 * 60 * 1000)
      return false;
    try {
      await browser.storage.session.remove(PENDING_KEY);
    } catch {  }
    await this._completeSignIn({...attempt, query});
    return true;
  }

  async _access() {
    const stored = await browser.storage.local.get('chatgptAccountId');
    const id = stored.chatgptAccountId;
    if (!id)
      throw new Error('Continue with ChatGPT in Plyph settings first.');
    return credentialsLocked(async () => {
      const record = await readCredentials();
      let profile = record.profiles[id];
      if (!profile?.refresh_token)
        throw new Error('Continue with ChatGPT in Plyph settings to reconnect.');
      if (!profile.scopes?.includes(AUTHORIZED_SCOPE))
        throw new Error('ChatGPT plan access was not granted. Continue with ChatGPT and allow plan usage.');
      if (!profile.access_token || profile.expires_at < Date.now() / 1000 + 60) {
        try {
          const tokens = await this._json(`${ISSUER}/api/accounts/oauth/token`, {
            grant_type: 'refresh_token',
            client_id: id,
            refresh_token: profile.refresh_token,
            resource: RESOURCE,
          });
          const identity = tokens.id_token
            ? await this._validate(tokens, id, null, profile.subject) : null;
          profile = tokensProfile(tokens, profile, identity);
          record.profiles[id] = profile;
          await saveCredentials(record);
        } catch (error) {
          if (error.oauthCode === 'invalid_grant') {
            record.profiles[id] = {client_id: id, subject: profile.subject, email: profile.email};
            await saveCredentials(record);
          }
          throw error;
        }
      }
      if (!profile.scopes.includes(AUTHORIZED_SCOPE))
        throw new Error('ChatGPT plan access is not enabled for this connection.');
      return {id, token: profile.access_token};
    });
  }

  async signOut(id) {
    return credentialsLocked(async () => {
      const record = await readCredentials();
      const profile = record.profiles[id];
      if (!profile) return {revoked: true};
      let revoked = !profile.refresh_token;
      if (profile.refresh_token) {
        try {
          const discovery = await this._json(`${ISSUER}/.well-known/openid-configuration`);
          if (!discovery.revocation_endpoint?.startsWith(`${ISSUER}/`))
            throw new Error('Invalid revocation endpoint.');
          await this._json(new URL(discovery.revocation_endpoint).pathname + new URL(discovery.revocation_endpoint).search, {
            token: profile.refresh_token,
            token_type_hint: 'refresh_token',
            client_id: id,
          });
          revoked = true;
        } catch {

        }
      }
      record.profiles[id] = {client_id: id, subject: profile.subject, email: profile.email};
      await saveCredentials(record);
      return {revoked};
    });
  }

  async models() {
    const access = await this._access();
    const stored = await browser.storage.local.get('chatgptAccountId');
    if (stored.chatgptAccountId !== access.id)
      throw new Error('The ChatGPT account changed. Refresh models again.');
    const data = await this._json(`${RESOURCE}/models`, null, access.token);
    return (data.models ?? [])
      .filter(model => model.visibility === 'list' && typeof model.slug === 'string')
      .map(model => ({id: model.slug, name: model.display_name ?? model.slug}));
  }

  async transform(text, instructions, model, effort = 'auto') {
    if (!model)
      throw new Error('Choose a ChatGPT model in Plyph settings first.');
    const access = await this._access();
    const body = {
      model,
      instructions,
      input: [{role: 'user', content: text}],
      store: false,
      stream: true,
    };
    if (['low', 'medium', 'high'].includes(effort))
      body.reasoning = {effort};
    let response;
    try {
      response = await fetch(serviceUrl(`${RESOURCE}/responses`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${access.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw new Error('Could not reach the ChatGPT service. Check your connection.');
    }
    if (!response.ok) {
      let errorBody = '';
      try { errorBody = (await response.text()).slice(0, 65536); } catch {  }
      let error;
      try { error = JSON.parse(errorBody).error; } catch {  }
      if (response.status === 400 &&
        (error?.param === 'reasoning' || error?.param === 'reasoning.effort'))
        throw new Error('This model could not use the selected thinking effort. Set Thinking effort to Auto in Plyph settings or choose another model.');
      throw chatgptError(error?.code, response.status);
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw chatgptError(null, response.status);
    const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
    const parser = new ResponsesStream();
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, {stream: true}));
      }
      parser.feed(decoder.decode());
      const stored = await browser.storage.local.get('chatgptAccountId');
      if (stored.chatgptAccountId !== access.id)
        throw new Error('The ChatGPT account changed. Run the action again.');
      return parser.finish();
    } finally {
      await Promise.resolve(reader.cancel?.()).catch(() => {});
    }
  }
}
