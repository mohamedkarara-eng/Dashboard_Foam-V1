require('dotenv').config({ quiet: true });
const express = require('express');
const xmlrpc = require('xmlrpc');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const ODOO_URL = process.env.ODOO_URL || 'https://www.shekhfoam.com';
const ODOO_DB = process.env.ODOO_DB || 'elshekhfoam-erp';
const ODOO_DEFAULT_USER = process.env.ODOO_DEFAULT_USER || '';
const ODOO_DEFAULT_PASS = process.env.ODOO_DEFAULT_PASS || '';
const PORT = process.env.PORT || 5000;

// SECURITY: with this OFF (default), every request must present a valid
// session (i.e. have logged in via /login.html) before it can read live
// Odoo data. Turn it ON only for local development if you want the
// dashboard to load without logging in first — never enable it in
// production, since it makes the live financial dashboard world-readable
// to anyone who has the URL.
const ALLOW_PUBLIC_ACCESS = process.env.ALLOW_PUBLIC_ACCESS === 'true' && process.env.NODE_ENV !== 'production';

if (ALLOW_PUBLIC_ACCESS && (!ODOO_DEFAULT_USER || !ODOO_DEFAULT_PASS)) {
  console.warn('⚠️  ALLOW_PUBLIC_ACCESS=true but ODOO_DEFAULT_USER/ODOO_DEFAULT_PASS are not set in .env — the no-login fallback will fail.');
}

let parsedOdooUrl;
try {
  parsedOdooUrl = new URL(ODOO_URL);
} catch (error) {
  parsedOdooUrl = new URL('https://www.shekhfoam.com');
}
const host = parsedOdooUrl.hostname;
const odooPort = Number(parsedOdooUrl.port) || (parsedOdooUrl.protocol === 'http:' ? 80 : 443);
const createOdooClient = parsedOdooUrl.protocol === 'http:' ? xmlrpc.createClient : xmlrpc.createSecureClient;

// Sessions & Cache — Persistent Stateless Encrypted Tokens + In-Memory Fast Lookup
const sessions = new Map();
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_TTL_MS = Number(process.env.SESSION_TIMEOUT_MS) || (SESSION_DAYS * 24 * 60 * 60 * 1000); // 30 days default
const SESSION_COOKIE = 'foam_session';

// Cryptographic key for stateless session encryption (AES-256-GCM)
const SESSION_SECRET = process.env.SESSION_SECRET || `${ODOO_URL}_${ODOO_DB}_foam_session_secret_2026_salt`;
const SESSION_CIPHER_KEY = crypto.createHash('sha256').update(SESSION_SECRET).digest();

function createSessionToken(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_CIPHER_KEY, iv);
  const data = JSON.stringify(payload);
  let enc = cipher.update(data, 'utf8', 'base64url');
  enc += cipher.final('base64url');
  const tag = cipher.getAuthTag().toString('base64url');
  return `${iv.toString('base64url')}.${tag}.${enc}`;
}

function verifySessionToken(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') return null;
  const parts = tokenString.split('.');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_CIPHER_KEY, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(dataB64, 'base64url', 'utf8');
    dec += decipher.final('utf8');
    const payload = JSON.parse(dec);
    if (!payload || payload.expiresAt <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// High-Performance Multi-Tier In-Memory Cache with LRU & Metrics
// ─────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes default
const MAX_CACHE_ENTRIES = 500;
const CACHE_STATS = { hits: 0, misses: 0, sets: 0, evictions: 0 };

function normalizeCacheKey(prefix, uid, query = {}) {
  const ignoredKeys = new Set(['refresh', '_', 't']);
  const cleanEntries = Object.entries(query)
    .filter(([k, v]) => !ignoredKeys.has(k) && v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => [k, String(v).trim()])
    .sort(([a], [b]) => a.localeCompare(b));

  const serialized = cleanEntries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${prefix}:${uid || 'pub'}:${serialized}`;
}

function getAdaptiveOverviewTTL(query = {}) {
  const currentYear = new Date().getFullYear();
  let queryYear = null;
  if (query.startDate) {
    const y = parseInt(String(query.startDate).slice(0, 4), 10);
    if (!isNaN(y)) queryYear = y;
  } else if (query.year) {
    const y = parseInt(String(query.year), 10);
    if (!isNaN(y)) queryYear = y;
  }

  // Closed historical years (e.g. 2020..2025) are immutable -> 12 hours cache!
  if (queryYear && queryYear < currentYear) {
    return 12 * 60 * 60 * 1000;
  }
  // Active/current period data -> 10 minutes cache
  return 10 * 60 * 1000;
}

function getCached(key) {
  const item = cache.get(key);
  if (!item) {
    CACHE_STATS.misses++;
    return null;
  }
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    CACHE_STATS.misses++;
    return null;
  }
  CACHE_STATS.hits++;
  return item.data;
}

function setCached(key, data, ttlMs = CACHE_DEFAULT_TTL_MS) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    CACHE_STATS.evictions++;
  }
  cache.set(key, { data, expiresAt: Date.now() + ttlMs, createdAt: Date.now() });
  CACHE_STATS.sets++;
}

function clearCache() {
  cache.clear();
  CACHE_STATS.hits = 0;
  CACHE_STATS.misses = 0;
  CACHE_STATS.sets = 0;
  CACHE_STATS.evictions = 0;
}

function getCacheStats() {
  const total = CACHE_STATS.hits + CACHE_STATS.misses;
  const hitRatio = total > 0 ? Number(((CACHE_STATS.hits / total) * 100).toFixed(1)) : 0;
  return {
    size: cache.size,
    maxSize: MAX_CACHE_ENTRIES,
    hits: CACHE_STATS.hits,
    misses: CACHE_STATS.misses,
    sets: CACHE_STATS.sets,
    hitRatio: `${hitRatio}%`
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map(v => v.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function getSession(req) {
  const cookieHeader = req?.headers?.cookie || '';
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;

  // 1. Check in-memory session map first (fastest)
  let session = sessions.get(token);
  if (session) {
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  // 2. Decrypt & verify stateless token (survives container cold starts & server restarts!)
  const payload = verifySessionToken(token);
  if (payload) {
    sessions.set(token, payload);
    return payload;
  }

  return null;
}

// Low-level XML-RPC Client helper with 50s Timeout and HTML/Exception Safeguards
const ODOO_CALL_TIMEOUT_MS = 50000;

function odooCall(service, method, args) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let finished = false;

    const safeReject = (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const safeResolve = (val) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };

    timer = setTimeout(() => {
      safeReject(new Error('انتهت مهلة استجابة خادم Odoo (504 Gateway Timeout) - استغرق الطلب أكثر من 50 ثانية'));
    }, ODOO_CALL_TIMEOUT_MS);

    try {
      const client = createOdooClient({
        host: host,
        port: odooPort,
        path: `/xmlrpc/2/${service}`
      });

      client.methodCall(method, args, (error, value) => {
        if (error) {
          const msg = String(error.message || error.faultString || '');
          const lower = msg.toLowerCase();
          if (
            lower.includes('unknown xml-rpc tag') ||
            lower.includes('title') ||
            lower.includes('doctype') ||
            lower.includes('html') ||
            lower.includes('head') ||
            lower.includes('body') ||
            lower.includes('504') ||
            lower.includes('gateway timeout')
          ) {
            return safeReject(new Error('انتهت مهلة استجابة خادم Odoo (504 Gateway Timeout) - يرجى تقليل نطاق الفلترة أو إعادة المحاولة'));
          }
          if (
            lower.includes('econnrefused') ||
            lower.includes('enotfound') ||
            lower.includes('socket hang up') ||
            lower.includes('econnreset') ||
            lower.includes('502') ||
            lower.includes('bad gateway') ||
            lower.includes('503') ||
            lower.includes('service unavailable')
          ) {
            return safeReject(new Error('تعذر الاتصال بخادم Odoo حالياً. يرجى التحقق من اتصال الشبكة وإعادة المحاولة.'));
          }
          return safeReject(error);
        }
        safeResolve(value);
      });
    } catch (syncErr) {
      safeReject(syncErr);
    }
  });
}

// Central Error Sanitizer: Translates technical exceptions to friendly Arabic messages
function sanitizeErrorMessage(err) {
  if (!err) return 'تعذر إتمام العملية في الوقت الحالي';
  const msg = String(err.message || err.faultString || err || '').trim();
  const lower = msg.toLowerCase();

  // Gateway / Timeout / HTML Response / XML-RPC tag error
  if (
    lower.includes('unknown xml-rpc tag') ||
    lower.includes('title') ||
    lower.includes('doctype') ||
    lower.includes('html') ||
    lower.includes('head') ||
    lower.includes('body') ||
    lower.includes('504') ||
    lower.includes('gateway timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout')
  ) {
    return 'استغرق خادم Odoo وقتاً أطول من المتوقع للاستجابة (مهلة اتصال). يرجى تقليل نطاق الفترة أو إعادة المحاولة.';
  }

  // Network / Connection drops
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('econnreset') ||
    lower.includes('502') ||
    lower.includes('bad gateway') ||
    lower.includes('503') ||
    lower.includes('service unavailable')
  ) {
    return 'تعذر الاتصال بخادم Odoo حالياً. يرجى التحقق من اتصال الشبكة بالخادم والمحاولة بعد قليل.';
  }

  // Auth / Access Denied
  if (
    lower.includes('access denied') ||
    lower.includes('invalid credentials') ||
    lower.includes('uid') ||
    lower.includes('session expired') ||
    lower.includes('unauthorized')
  ) {
    return 'انتهت صلاحية جلسة الاتصال بنظام Odoo. يرجى إعادة تسجيل الدخول.';
  }

  // If it contains Python tracebacks or internal codes, do not expose raw code
  if (
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.includes('syntaxerror') ||
    lower.includes('keyerror') ||
    lower.includes('typeerror') ||
    lower.includes('zerodivision') ||
    lower.includes('xmlrpc') ||
    lower.includes('xml-rpc')
  ) {
    return 'حدث خطأ مؤقت في استجابة خادم Odoo. يرجى إعادة المحاولة.';
  }

  // If already clean Arabic text without technical leakage, return it
  if (/[\u0600-\u06FF]/.test(msg) && !lower.includes('xml-rpc') && !lower.includes('title')) {
    return msg;
  }

  return 'حدث خطأ أثناء معالجة بيانات Odoo. يرجى إعادة المحاولة.';
}

// Execute Kw wrapper with automatic retry on transient errors
async function odooExecuteKw(uid, password, model, method, args = [], kwargs = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await odooCall('object', 'execute_kw', [
        ODOO_DB,
        uid,
        password,
        model,
        method,
        args,
        kwargs
      ]);
    } catch (err) {
      lastErr = err;
      const isAuthErr = /access denied|invalid credentials/i.test(String(err.message || ''));
      if (isAuthErr || attempt === 2) throw err;
      console.warn(`[Odoo] ${model}.${method} attempt ${attempt} failed, retrying...`, err.message);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// Helper to get active credentials (session or system default)
async function getAuthCredentials(req) {
  const session = getSession(req);
  if (session && session.uid && session.password) {
    return { uid: session.uid, password: session.password, username: session.username };
  }

  // Only fall back to a shared system login when explicitly allowed.
  if (!ALLOW_PUBLIC_ACCESS) return null;

  let defaultAuth = getCached('default_auth');
  if (!defaultAuth) {
    const uid = await odooCall('common', 'authenticate', [
      ODOO_DB,
      ODOO_DEFAULT_USER,
      ODOO_DEFAULT_PASS,
      {}
    ]);
    if (uid) {
      defaultAuth = { uid, password: ODOO_DEFAULT_PASS, username: ODOO_DEFAULT_USER };
      setCached('default_auth', defaultAuth, 60 * 60 * 1000);
    }
  }
  return defaultAuth;
}

function setSessionCookie(res, token, req) {
  const host = req?.headers?.host || '';
  const isHttps = req ? (req.secure || req.headers['x-forwarded-proto'] === 'https') : false;
  const isProd = process.env.NODE_ENV === 'production';
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const secure = (isHttps || (isProd && !isLocal)) ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

// Blocks the dashboard page itself for anyone without a valid session,
// so the login screen is actually enforced instead of just decorative.
function requirePageAuth(req, res, next) {
  if (ALLOW_PUBLIC_ACCESS || getSession(req)) return next();
  return res.redirect('/login.html');
}

// Routes
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'Dashboard_Foam.html')));
app.get('/Dashboard_Foam.html', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, 'Dashboard_Foam.html')));

app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, uid: session.uid, username: session.username });
});

// Health Check
app.get('/api/odoo-health', async (req, res) => {
  try {
    const version = await odooCall('common', 'version', []);
    res.json({
      status: 'ok',
      host,
      database: ODOO_DB,
      serverVersion: version?.server_version || '19.0+e',
      cache: getCacheStats()
    });
  } catch (error) {
    console.error('Odoo health check failed:', error.message);
    res.status(502).json({ status: 'error', error: 'تعذر الاتصال بـ Odoo XML-RPC', cache: getCacheStats() });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!username || !password) {
    return res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور' });
  }
  try {
    const uid = await odooCall('common', 'authenticate', [ODOO_DB, username, password, {}]);
    if (!uid) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    const sessionData = { uid, username, password, expiresAt: Date.now() + SESSION_TTL_MS };
    const token = createSessionToken(sessionData);
    sessions.set(token, sessionData);
    setSessionCookie(res, token, req);
    return res.json({ status: 'success', uid, username });
  } catch (error) {
    console.error('Odoo login failed:', error.message);
    return res.status(502).json({ error: 'تعذر الاتصال بخدمة المصادقة في Odoo' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ status: 'success' });
});

// Audit: raw Odoo totals for cross-checking dashboard numbers (read-only)
app.get('/api/dashboard/audit', async (req, res) => {
  try {
    const auth = await getAuthCredentials(req);
    if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
    const start = String(req.query.start || '').trim();
    const end = String(req.query.end || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'use ?start=YYYY-MM-DD&end=YYYY-MM-DD[&status=post|draft|all]' });
    }
    const status = String(req.query.status || 'post').toLowerCase();
    const stateClause = status === 'post' ? ['state', 'in', ['sale', 'done']]
      : status === 'draft' ? ['state', 'in', ['draft', 'sent']] : ['state', '!=', 'cancel'];

    // Cairo offset (hours) for the start date, e.g. +3 in summer
    const offsetHours = (() => {
      try {
        const d = new Date(`${start}T12:00:00Z`);
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).formatToParts(d);
        return Number(parts.find(p => p.type === 'hour').value) - 12;
      } catch (e) { return 2; }
    })();
    const shift = (dateStr, endOfDay) => {
      const base = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
      base.setUTCHours(base.getUTCHours() - offsetHours);
      return base.toISOString().replace('T', ' ').slice(0, 19);
    };

    const ranges = {
      utc: [`${start} 00:00:00`, `${end} 23:59:59`],
      cairo: [shift(start, false), shift(end, true)]
    };
    const out = { offsetHours, ranges, status };

    for (const [key, [from, to]] of Object.entries(ranges)) {
      const domain = [['date_order', '>=', from], ['date_order', '<=', to], stateClause];
      const [total, byRep] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [domain, ['amount_total:sum', 'amount_untaxed:sum'], []]),
        odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [domain, ['amount_total:sum'], ['user_id'], 0, 1000, false, false])
      ]);
      out[key] = {
        count: total?.[0]?.__count || 0,
        amount_total: total?.[0]?.amount_total || 0,
        amount_untaxed: total?.[0]?.amount_untaxed || 0,
        byRep: (byRep || []).map(g => ({
          rep: g.user_id ? g.user_id[1] : 'غير محدد',
          count: g.__count ?? g.user_id_count,
          amount_total: g.amount_total
        })).sort((a, b) => b.amount_total - a.amount_total)
      };
    }

    // Discover custom region / city fields on sale.order (labels containing منطقة / مدينة)
    const fields = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    out.regionLikeFields = Object.entries(fields || {})
      .filter(([name, f]) => /منطق|مدين|region|city|area|zone/i.test(`${f.string} ${name}`))
      .map(([name, f]) => ({ name, label: f.string, type: f.type, relation: f.relation || null }));

    out.resolvedCustomFields = await getSoCustomFields(auth);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: sanitizeErrorMessage(e), raw: String(e.message || e) });
  }
});

// Cache Clear
app.post('/api/dashboard/refresh', async (req, res) => {
  const auth = await getAuthCredentials(req);
  if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
  clearCache();
  res.json({
    status: 'success',
    message: 'تم تحديث الذاكرة المؤقتة بنجاح',
    stats: getCacheStats()
  });
});

// Helper: Build Date Domain
function getDateRange(query) {
  const now = new Date();
  const currentYear = now.getFullYear().toString();
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  // 1. If explicit startDate & endDate or start & end are provided (from quick preset or custom date range)
  const explicitStart = query.startDate || query.start;
  const explicitEnd = query.endDate || query.end;
  if (explicitStart && explicitEnd) {
    const s = String(explicitStart).trim();
    const e = String(explicitEnd).trim();
    if (isoDateRegex.test(s) && isoDateRegex.test(e)) {
      return { start: s, end: e, year: s.slice(0, 4) };
    }
  }

  // 2. Determine year
  let year = /^\d{4}$/.test(String(query.year || '')) ? String(query.year) : currentYear;

  // 3. Day filter
  if (query.day) {
    const dayVal = String(query.day).trim();
    // If day is already a full ISO date (e.g. "2019-09-01" from facet options)
    if (isoDateRegex.test(dayVal)) {
      return { start: dayVal, end: dayVal, year: dayVal.slice(0, 4) };
    }
    // If day is a 1-2 digit number (1-31)
    if (/^\d{1,2}$/.test(dayVal)) {
      const m = query.month && /^\d{1,2}$/.test(String(query.month))
        ? String(query.month).padStart(2, '0')
        : String(now.getMonth() + 1).padStart(2, '0');
      const d = dayVal.padStart(2, '0');
      const dayDate = `${year}-${m}-${d}`;
      return { start: dayDate, end: dayDate, year };
    }
  }

  // 4. Month filter
  if (query.month && /^\d{1,2}$/.test(String(query.month))) {
    const mNum = Number(query.month);
    if (mNum >= 1 && mNum <= 12) {
      const m = String(mNum).padStart(2, '0');
      const start = `${year}-${m}-01`;
      const lastDay = new Date(Number(year), mNum, 0).getDate();
      const end = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
      return { start, end, year };
    }
  }

  // 5. Period / Quarter filter
  if (query.period) {
    const q = String(query.period).toUpperCase().trim();
    if (q === 'Q1') return { start: `${year}-01-01`, end: `${year}-03-31`, year };
    if (q === 'Q2') return { start: `${year}-04-01`, end: `${year}-06-30`, year };
    if (q === 'Q3') return { start: `${year}-07-01`, end: `${year}-09-30`, year };
    if (q === 'Q4') return { start: `${year}-10-01`, end: `${year}-12-31`, year };
  }

  // 6. Year filter
  if (query.year && /^\d{4}$/.test(String(query.year))) {
    return { start: `${year}-01-01`, end: `${year}-12-31`, year };
  }

  return { start: `${currentYear}-01-01`, end: `${currentYear}-12-31`, year: currentYear };
}

function asPositiveId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function resolveCategoryId(queryCat, categoriesList) {
  const numId = asPositiveId(queryCat);
  if (numId) return numId;
  if (!queryCat || typeof queryCat !== 'string') return null;
  const trimmed = queryCat.trim();
  if (!trimmed) return null;
  const match = (categoriesList || []).find(c => 
    c.name === trimmed || 
    c.leafName === trimmed || 
    c.complete_name === trimmed ||
    c.rootName === trimmed ||
    c.name.endsWith('/ ' + trimmed)
  );
  return match ? match.id : null;
}

// Filters and displays use only the custom salesperson field shown in Odoo's list view.
function appendSalespersonFilter(domain, customField, repId, repName = null) {
  if (!customField?.name) {
    domain.push(['id', '=', -1]);
  } else if (customField.type === 'many2one' && repId) {
    domain.push([customField.name, '=', repId]);
  } else {
    domain.push([customField.name, '=', repName || repId]);
  }
}

async function getDistinctRepsFromDocuments(auth) {
  const cacheKey = `distinct_doc_reps_v3_${auth.uid}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const repsMap = new Map();

  const [moveFields, soFields] = await Promise.all([
    getMoveCustomFields(auth).catch(() => ({ rep: null })),
    getSoCustomFields(auth).catch(() => ({ rep: null }))
  ]);
  for (const [model, customField] of [['account.move', moveFields?.rep], ['sale.order', soFields?.rep]]) {
    if (customField?.type !== 'many2one') continue;
    try {
      const groups = await odooExecuteKw(auth.uid, auth.password, model, 'read_group', [
        [[customField.name, '!=', false]],
        ['amount_total:sum'],
        [customField.name]
      ]);
      (groups || []).forEach(group => {
        const rep = group[customField.name];
        if (rep?.[0] && rep?.[1]) repsMap.set(rep[0], { id: rep[0], name: rep[1] });
      });
    } catch (error) {
      console.warn(`read_group ${model}.${customField.name} error:`, error.message);
    }
  }

  const distinctReps = [...repsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  setCached(cacheKey, distinctReps, 10 * 60 * 1000);
  return distinctReps;
}

async function getDistinctRepNameById(auth, repId) {
  if (!repId) return null;
  const reps = await getDistinctRepsFromDocuments(auth);
  return reps.find(rep => String(rep.id) === String(repId))?.name || null;
}

async function getDateFacets(auth, source) {
  const cacheKey = `date_facets_${auth.uid}_${source}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const isSalesOrder = source === 'salesOrder';
  const model = isSalesOrder ? 'sale.order' : 'account.move';
  const dateField = isSalesOrder ? 'date_order' : 'invoice_date';
  const domain = isSalesOrder
    ? [['date_order', '!=', false]]
    : [
        ['state', '=', 'posted'],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['invoice_date', '!=', false]
      ];

  const yearsSet = new Set();
  const currentYearNum = new Date().getFullYear();
  // Include operational history years 2020 through currentYear
  for (let y = 2020; y <= Math.max(currentYearNum, 2026); y++) {
    yearsSet.add(String(y));
  }

  // 1. Primary Query: read_group SQL query directly from PostgreSQL
  try {
    const yearGroups = await odooExecuteKw(
      auth.uid,
      auth.password,
      model,
      'read_group',
      [domain, ['amount_total:sum'], [`${dateField}:year`]],
      0, 100, false, false
    );
    if (Array.isArray(yearGroups)) {
      yearGroups.forEach(g => {
        const raw = String(g[`${dateField}:year`] || g[dateField] || '');
        const match = raw.match(/\b((?:19|20)\d{2})\b/);
        if (match) yearsSet.add(match[1]);
      });
    }
  } catch (err) {
    console.warn(`read_group on ${dateField}:year failed:`, err.message);
  }

  // 2. Query distinct days using read_group grouped by day directly from PostgreSQL
  let sampleDates = [];
  try {
    const dayGroups = await odooExecuteKw(
      auth.uid,
      auth.password,
      model,
      'read_group',
      [domain, ['amount_total:sum'], [`${dateField}:day`]],
      0, 400, false, false
    );
    if (Array.isArray(dayGroups)) {
      dayGroups.forEach(g => {
        const raw = String(g[`${dateField}:day`] || g[dateField] || '').slice(0, 10);
        const match = raw.match(/^((?:19|20)\d{2}-\d{2}-\d{2})$/);
        if (match) {
          yearsSet.add(match[1].slice(0, 4));
          sampleDates.push(match[1]);
        }
      });
    }
  } catch (err) {
    console.warn(`read_group on ${dateField}:day failed:`, err.message);
  }

  // 3. Fallback search_read ordered newest desc
  if (sampleDates.length === 0) {
    try {
      const recentRows = await odooExecuteKw(
        auth.uid,
        auth.password,
        model,
        'search_read',
        [domain],
        {
          fields: [dateField],
          limit: 1000,
          order: `${dateField} desc, id desc`
        }
      );
      (recentRows || []).forEach(row => {
        const val = String(row[dateField] || '').slice(0, 10);
        const match = val.match(/^((?:19|20)\d{2}-\d{2}-\d{2})$/);
        if (match) {
          yearsSet.add(match[1].slice(0, 4));
          sampleDates.push(val);
        }
      });
    } catch (err) {
      console.warn('Fallback search_read for date facets encountered an error:', err.message);
    }
  }

  const sortedYears = [...yearsSet].filter(y => /^\d{4}$/.test(y)).sort().reverse();
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const months = monthNames.map((name, i) => ({ value: String(i + 1), name }));
  const periods = [
    { value: 'Q1', name: 'الربع 1' },
    { value: 'Q2', name: 'الربع 2' },
    { value: 'Q3', name: 'الربع 3' },
    { value: 'Q4', name: 'الربع 4' }
  ];

  // Distinct recent days sorted descending
  const uniqueDates = [...new Set(sampleDates)].sort().reverse();
  const days = uniqueDates.slice(0, 366).map(value => ({
    value,
    name: new Date(`${value}T00:00:00Z`).toLocaleDateString('ar-EG')
  }));

  const facets = {
    years: sortedYears,
    months,
    periods,
    days
  };

  setCached(cacheKey, facets, 30 * 60 * 1000);
  return facets;
}

function comparisonRange(start, end, mode) {
  if (!start || !end || mode === 'none' || !mode) return null;
  const sParts = String(start).split('-').map(Number);
  const eParts = String(end).split('-').map(Number);
  if (sParts.length !== 3 || eParts.length !== 3) return null;

  const [sY, sM, sD] = sParts;
  const [eY, eM, eD] = eParts;

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (mode === 'samePeriodLastYear') {
    const priorStartY = sY - 1;
    const priorEndY = eY - 1;
    const lastDayStart = new Date(priorStartY, sM, 0).getDate();
    const lastDayEnd = new Date(priorEndY, eM, 0).getDate();
    const startDay = Math.min(sD, lastDayStart);
    const endDay = Math.min(eD, lastDayEnd);
    return {
      start: `${priorStartY}-${pad(sM)}-${pad(startDay)}`,
      end: `${priorEndY}-${pad(eM)}-${pad(endDay)}`
    };
  }

  // mode === 'previousPeriod'
  // 1. Full calendar month (e.g. 2026-09-01 to 2026-09-30 -> 2026-08-01 to 2026-08-31)
  const isFullMonth = sY === eY && sM === eM && sD === 1 && eD === new Date(sY, sM, 0).getDate();
  if (isFullMonth) {
    const prevMonthDate = new Date(sY, sM - 2, 1);
    const pY = prevMonthDate.getFullYear();
    const pM = prevMonthDate.getMonth() + 1;
    const pLastDay = new Date(pY, pM, 0).getDate();
    return {
      start: `${pY}-${pad(pM)}-01`,
      end: `${pY}-${pad(pM)}-${pad(pLastDay)}`
    };
  }

  // 2. Full calendar year (e.g. 2026-01-01 to 2026-12-31 -> 2025-01-01 to 2025-12-31)
  const isFullYear = sY === eY && sM === 1 && sD === 1 && eM === 12 && eD === 31;
  if (isFullYear) {
    return {
      start: `${sY - 1}-01-01`,
      end: `${sY - 1}-12-31`
    };
  }

  // 3. Generic date range (days, weeks, custom)
  const startDate = new Date(sY, sM - 1, sD);
  const endDate = new Date(eY, eM - 1, eD);
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const priorEnd = new Date(startDate.getTime() - 86400000);
  const priorStart = new Date(priorEnd.getTime() - (diffDays - 1) * 86400000);

  return {
    start: iso(priorStart),
    end: iso(priorEnd)
  };
}

function replaceDateDomain(domain, start, end) {
  return [
    ...domain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true),
    ['invoice_date', '>=', start],
    ['invoice_date', '<=', end]
  ];
}

function percentChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number(((current - previous) / Math.abs(previous) * 100).toFixed(1));
}

function round2(val) {
  const num = Number(val);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

// ─────────────────────────────────────────────────────────────
// Egyptian Cities & Governorates Dictionary for Accurate Geolocation
// ─────────────────────────────────────────────────────────────
const EGYPT_CITY_STATE_MAP = {
  'دكرنس': 'الدقهلية',
  'المنزلة': 'الدقهلية',
  'محلة دمنة': 'الدقهلية',
  'ميت غمر': 'الدقهلية',
  'المنصورة': 'الدقهلية',
  'بلقاس': 'الدقهلية',
  'السنبلاوين': 'الدقهلية',
  'شربين': 'الدقهلية',
  'أجا': 'الدقهلية',
  'طلخا': 'الدقهلية',
  'منية النصر': 'الدقهلية',
  'نبروه': 'الدقهلية',
  'جمصة': 'الدقهلية',

  'الشرقية': 'الشرقية',
  'الزقازيق': 'الشرقية',
  'العاشر من رمضان': 'الشرقية',
  'العاشر': 'الشرقية',
  'فاقوس': 'الشرقية',
  'بلبيس': 'الشرقية',
  'كفر صقر': 'الشرقية',
  'مشتول السوق': 'الشرقية',
  'مشتول': 'الشرقية',
  'ابو حماد': 'الشرقية',
  'أبو حماد': 'الشرقية',
  'ابو كبير': 'الشرقية',
  'أبو كبير': 'الشرقية',
  'الحسينية': 'الشرقية',
  'الصالحية': 'الشرقية',
  'الصالحية الجديدة': 'الشرقية',
  'ههيا': 'الشرقية',
  'ديرب نجم': 'الشرقية',
  'منيا القمح': 'الشرقية',
  'الإبراهيمية': 'الشرقية',
  'القنايات': 'الشرقية',
  'أولاد صقر': 'الشرقية',

  'كفر الشيخ': 'كفر الشيخ',
  'دسوق': 'كفر الشيخ',
  'فوه': 'كفر الشيخ',
  'بيلا': 'كفر الشيخ',
  'قلين': 'كفر الشيخ',
  'سيدي سالم': 'كفر الشيخ',
  'مطوبس': 'كفر الشيخ',
  'الحامول': 'كفر الشيخ',

  'الغربية': 'الغربية',
  'طنطا': 'الغربية',
  'المحلة الكبرى': 'الغربية',
  'المحلة': 'الغربية',
  'زفتى': 'الغربية',
  'كفر الزيات': 'الغربية',
  'سمنود': 'الغربية',
  'بسيون': 'الغربية',

  'دمياط': 'دمياط',
  'رأس البر': 'دمياط',
  'فارسكور': 'دمياط',
  'الزرقا': 'دمياط',
  'كفر سعد': 'دمياط',
  'كفر البطيخ': 'دمياط',

  'الفيوم': 'الفيوم',
  'إبشواي': 'الفيوم',
  'اطسا': 'الفيوم',
  'طامية': 'الفيوم',
  'سنورس': 'الفيوم',

  'بني سويف': 'بني سويف',
  'الواسطى': 'بني سويف',
  'ناصر': 'بني سويف',
  'ببا': 'بني سويف',
  'الفشن': 'بني سويف',
  'إهناسيا': 'بني سويف',

  'المنيا': 'المنيا',
  'ملوي': 'المنيا',
  'مغاغة': 'المنيا',
  'بني مزار': 'المنيا',
  'سمالوط': 'المنيا',
  'أبو قرقاص': 'المنيا',

  'أسيوط': 'أسيوط',
  'سوهاج': 'سوهاج',
  'قنا': 'قنا',
  'الأقصر': 'الأقصر',
  'أسوان': 'أسوان',

  'الاسكندرية': 'الاسكندرية',
  'الإسكندرية': 'الاسكندرية',
  'برج العرب': 'الاسكندرية',
  'عزبة البرنس': 'الاسكندرية',

  'الجيزة': 'الجيزة',
  '6 أكتوبر': 'الجيزة',
  'أكتوبر': 'الجيزة',
  'الشيخ زايد': 'الجيزة',
  'الهرم': 'الجيزة',
  'فيصل': 'الجيزة',

  'القاهرة': 'القاهرة',
  'مدينة نصر': 'القاهرة',
  'التجمع': 'القاهرة',
  'المعادي': 'القاهرة',
  'حلوان': 'القاهرة',

  'السويس': 'السويس',
  'الاسماعيلية': 'الاسماعيلية',
  'الإسماعيلية': 'الاسماعيلية',
  'القنطرة': 'الاسماعيلية',
  'القنطرة غرب': 'الاسماعيلية',
  'القنطرة شرق': 'الاسماعيلية',
  'فايد': 'الاسماعيلية',
  'التل الكبير': 'الاسماعيلية',
  'القصاصين': 'الاسماعيلية',
  'بورسعيد': 'بورسعيد',

  'البحيرة': 'البحيرة',
  'دمنهور': 'البحيرة',
  'كفر الدوار': 'البحيرة',
  'إيتاي البارود': 'البحيرة',
  'أبو حمص': 'البحيرة',
  'حوش عيسى': 'البحيرة',
  'كوم حمادة': 'البحيرة',
  'رشيد': 'البحيرة',
  'إدكو': 'البحيرة',

  'المنوفية': 'المنوفية',
  'شبين الكوم': 'المنوفية',
  'السادات': 'المنوفية',
  'قويسنا': 'المنوفية',
  'أشمون': 'المنوفية',
  'منوف': 'المنوفية',
  'الباجور': 'المنوفية',
  'تلا': 'المنوفية',
  'بركة السبع': 'المنوفية',

  'القليوبية': 'القليوبية',
  'بنها': 'القليوبية',
  'شبرا الخيمة': 'القليوبية',
  'طوخ': 'القليوبية',
  'العبور': 'القليوبية',
  'قليوب': 'القليوبية',
  'الخانكة': 'القليوبية',
  'شبين القناطر': 'القليوبية',
  'كفر شكر': 'القليوبية',
  'قها': 'القليوبية'
};

function resolvePartnerCityAndState(p, rawMap) {
  let rawCity = (p?.city && typeof p.city === 'string') ? p.city.trim() : '';
  let rawState = (p?.state_id && p.state_id[1]) ? p.state_id[1].replace(/\s*\(EG\)$/i, '').trim() : '';

  // 1. If city missing, look up commercial partner or parent company
  if (!rawCity && rawMap) {
    const parentId = (p?.commercial_partner_id && p.commercial_partner_id[0])
      ? p.commercial_partner_id[0]
      : (p?.parent_id && p.parent_id[0] ? p.parent_id[0] : null);
    if (parentId) {
      const parent = rawMap.get(parentId);
      if (parent?.city && typeof parent.city === 'string' && parent.city.trim()) {
        rawCity = parent.city.trim();
      }
      if (!rawState && parent?.state_id && parent.state_id[1]) {
        rawState = parent.state_id[1].replace(/\s*\(EG\)$/i, '').trim();
      }
    }
  }

  // 2. Scan partner name against known Egyptian cities ONLY (sorted by length descending for exact matching)
  if (!rawCity && p?.name) {
    const pName = String(p.name);
    const sortedCities = Object.keys(EGYPT_CITY_STATE_MAP).sort((a, b) => b.length - a.length);
    for (const knownCity of sortedCities) {
      if (pName.includes(knownCity)) {
        rawCity = knownCity;
        if (!rawState) rawState = EGYPT_CITY_STATE_MAP[knownCity];
        break;
      }
    }
  }

  // 3. Fallback to state as regional center (e.g. 'القليوبية' matching Odoo native row) to avoid 'غير محدد'
  if (!rawCity && rawState) {
    rawCity = rawState;
  }

  rawCity = (rawCity && rawCity !== 'غير محدد') ? rawCity : 'أخرى';

  // 4. State deduction from city if missing
  if (!rawState && rawCity !== 'أخرى') {
    rawState = EGYPT_CITY_STATE_MAP[rawCity] || rawCity;
  }
  rawState = (rawState && rawState !== 'غير محدد') ? rawState : (rawCity !== 'أخرى' ? rawCity : 'أخرى');

  return { city: rawCity, state: rawState };
}

function extractMoveAmount(summary) {
  if (!summary) return 0;
  if (summary.amount_total_signed !== undefined && summary.amount_total_signed !== null) {
    return Math.abs(Number(summary.amount_total_signed) || 0);
  }
  return Math.abs(Number(summary.amount_total) || 0);
}

function extractMoveResidual(summary) {
  if (!summary) return 0;
  if (summary.amount_residual_signed !== undefined && summary.amount_residual_signed !== null) {
    return Math.abs(Number(summary.amount_residual_signed) || 0);
  }
  return Math.abs(Number(summary.amount_residual) || 0);
}

function extractMoveUntaxed(summary) {
  if (!summary) return 0;
  if (summary.amount_untaxed_signed !== undefined && summary.amount_untaxed_signed !== null) {
    return Math.abs(Number(summary.amount_untaxed_signed) || 0);
  }
  return Math.abs(Number(summary.amount_untaxed) || 0);
}

function extractPaymentAmount(summary) {
  if (!summary) return 0;
  if (summary.amount !== undefined && summary.amount !== null) {
    return Math.abs(Number(summary.amount) || 0);
  }
  if (summary['amount:sum'] !== undefined && summary['amount:sum'] !== null) {
    return Math.abs(Number(summary['amount:sum']) || 0);
  }
  return 0;
}

function aggregateTimeGroups(groups, groupField, bucketType = 'month') {
  const values = new Map();
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  groups.forEach(group => {
    const raw = String(group[groupField] || '');
    const yearMatch = raw.match(/\b(20\d{2})\b/);
    const monthMatch = raw.match(/(?:^|[-/ ])(0?[1-9]|1[0-2])(?:[-/ ]|$)/);
    const namedMonth = monthNames.findIndex(name => raw.toLowerCase().includes(name));
    const key = bucketType === 'year'
      ? (yearMatch ? yearMatch[1] : raw)
      : (monthMatch ? String(Number(monthMatch[1])) : (namedMonth >= 0 ? String(namedMonth + 1) : null));
    if (!key) return;
    const entry = values.get(key) || { gross: 0, returns: 0 };
    const amt = extractMoveAmount(group);
    if (group.move_type === 'out_refund') entry.returns += amt;
    else entry.gross += amt;
    values.set(key, entry);
  });
  return values;
}

function buildTimeSeries(currentGroups, previousGroups, groupField, labels, bucketType = 'month') {
  const current = aggregateTimeGroups(currentGroups, groupField, bucketType);
  const previous = aggregateTimeGroups(previousGroups, groupField, bucketType);
  const keys = bucketType === 'year'
    ? [...new Set([...current.keys(), ...previous.keys()])].sort()
    : labels.map((_, index) => String(index + 1));
  return keys.map((key, index) => {
    const currentValue = current.get(key) || { gross: 0, returns: 0 };
    const previousValue = previous.get(key) || { gross: 0, returns: 0 };
    return {
      label: bucketType === 'year' ? key : labels[index],
      currentSales: round2(currentValue.gross - currentValue.returns),
      previousSales: round2(previousValue.gross - previousValue.returns),
      growthPercent: percentChange(currentValue.gross - currentValue.returns, previousValue.gross - previousValue.returns)
    };
  });
}

async function buildGrowthAnalysis(auth, currentDomain, start, end, comparisonMode, partnerMap) {
  const previousRange = comparisonRange(start, end, comparisonMode);
  if (!previousRange) return { regions: [], customers: [], churnWarnings: [], previousRange: null };

  const previousDomain = replaceDateDomain(currentDomain, previousRange.start, previousRange.end);
  const [currentGroups, previousGroups] = await Promise.all([
    odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      currentDomain,
      ['amount_total_signed:sum', 'amount_total:sum'],
      ['partner_id'],
      0, 2000, false, false
    ]).catch(() => []),
    odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      previousDomain,
      ['amount_total_signed:sum', 'amount_total:sum'],
      ['partner_id'],
      0, 2000, false, false
    ]).catch(() => [])
  ]);

  const toCustomerMap = (groups) => {
    const values = new Map();
    (groups || []).forEach(group => {
      if (!group.partner_id) return;
      const id = group.partner_id[0];
      let val = 0;
      if (group.amount_total_signed !== undefined && group.amount_total_signed !== null) {
        val = Number(group.amount_total_signed) || 0;
      } else {
        const sign = group.move_type === 'out_refund' ? -1 : 1;
        val = sign * (Number(group.amount_total) || 0);
      }
      values.set(id, (values.get(id) || 0) + val);
    });
    return values;
  };
  const currentCustomers = toCustomerMap(currentGroups);
  const previousCustomers = toCustomerMap(previousGroups);
  const customerIds = new Set([...currentCustomers.keys(), ...previousCustomers.keys()]);
  const customers = [...customerIds].map(id => {
    const info = partnerMap.get(id) || { name: 'غير محدد', state: 'غير محدد', city: 'غير محدد', rep: 'غير محدد' };
    const currentSales = round2(Math.max(0, currentCustomers.get(id) || 0));
    const previousSales = round2(Math.max(0, previousCustomers.get(id) || 0));
    const growthAmount = round2(currentSales - previousSales);
    const growthPercent = percentChange(currentSales, previousSales);
    const lossAmount = Math.max(0, round2(previousSales - currentSales));
    return {
      id,
      name: info.name || `عميل #${id}`,
      state: info.state || 'غير محدد',
      city: info.city || 'غير محدد',
      rep: info.rep || 'غير محدد',
      currentSales,
      previousSales,
      growthAmount,
      growthPercent,
      lossAmount
    };
  }).sort((a, b) => b.currentSales - a.currentSales);

  const regionMap = new Map();
  customers.forEach(customer => {
    const name = customer.state || 'غير محدد';
    const region = regionMap.get(name) || { name, currentSales: 0, previousSales: 0 };
    region.currentSales += customer.currentSales;
    region.previousSales += customer.previousSales;
    regionMap.set(name, region);
  });
  const regions = [...regionMap.values()].map(region => ({
    ...region,
    currentSales: round2(region.currentSales),
    previousSales: round2(region.previousSales),
    growthAmount: round2(region.currentSales - region.previousSales),
    growthPercent: percentChange(region.currentSales, region.previousSales)
  })).sort((a, b) => b.currentSales - a.currentSales);

  // Churn / Sales drop warnings: any customer with previous sales whose sales declined or stopped completely
  const churnWarnings = customers
    .filter(customer => customer.previousSales > 0 && customer.growthAmount < 0)
    .sort((a, b) => b.lossAmount - a.lossAmount || a.growthPercent - b.growthPercent)
    .map(customer => ({
      ...customer,
      risk: (customer.currentSales === 0 || customer.growthPercent <= -50) ? 'مرتفع' : 'متوسط'
    }));

  const topDeclining = customers
    .filter(customer => customer.growthAmount < 0)
    .sort((a, b) => b.lossAmount - a.lossAmount)
    .slice(0, 15);

  const topGrowing = customers
    .filter(customer => customer.growthAmount > 0)
    .sort((a, b) => b.growthAmount - a.growthAmount)
    .slice(0, 15);

  const customerGrowthChart = {
    churn: {
      labels: churnWarnings.slice(0, 15).map(c => c.name),
      currentSales: churnWarnings.slice(0, 15).map(c => c.currentSales),
      previousSales: churnWarnings.slice(0, 15).map(c => c.previousSales),
      lossAmount: churnWarnings.slice(0, 15).map(c => c.lossAmount),
      growthPercent: churnWarnings.slice(0, 15).map(c => c.growthPercent),
      items: churnWarnings.slice(0, 15)
    },
    decline: {
      labels: topDeclining.map(c => c.name),
      currentSales: topDeclining.map(c => c.currentSales),
      previousSales: topDeclining.map(c => c.previousSales),
      lossAmount: topDeclining.map(c => c.lossAmount),
      growthPercent: topDeclining.map(c => c.growthPercent),
      items: topDeclining
    },
    growth: {
      labels: topGrowing.map(c => c.name),
      currentSales: topGrowing.map(c => c.currentSales),
      previousSales: topGrowing.map(c => c.previousSales),
      growthAmount: topGrowing.map(c => c.growthAmount),
      growthPercent: topGrowing.map(c => c.growthPercent),
      items: topGrowing
    }
  };

  return {
    source: 'postedInvoice',
    regions,
    customers,
    churnWarnings,
    topDeclining,
    topGrowing,
    customerGrowthChart,
    previousRange,
    threshold: 0,
    minimumPreviousSales: 0,
    timeSeries: null
  };
}

async function getProductCatalog(auth) {
  let productCatalog = getCached('product_catalog');
  let categories = getCached('product_categories');
  if (!productCatalog || !categories) {
    const [rawProducts, rawCategories] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'product.product', 'search_read', [[['active', '=', true]]], { fields: ['id', 'name', 'categ_id'], limit: 15000 }).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'product.category', 'search_read', [[]], { fields: ['id', 'name', 'complete_name', 'parent_id', 'parent_path'], limit: 1000 }).catch(() =>
        odooExecuteKw(auth.uid, auth.password, 'product.category', 'search_read', [[]], { fields: ['id', 'name', 'parent_id'], limit: 1000 }).catch(() => [])
      )
    ]);

    productCatalog = (rawProducts || []).map(p => ({
      id: p.id,
      name: p.name,
      categoryId: p.categ_id?.[0],
      categoryName: p.categ_id?.[1]
    })).filter(p => p.name);

    const rawCatMap = new Map((rawCategories || []).map(c => [c.id, c]));

    const getParentId = (c) => {
      if (!c || !c.parent_id) return null;
      return Array.isArray(c.parent_id) ? c.parent_id[0] : c.parent_id;
    };

    const buildCatPath = (catId, visited = new Set()) => {
      if (!catId || visited.has(catId)) return '';
      visited.add(catId);
      const cat = rawCatMap.get(catId);
      if (!cat) return '';
      if (cat.complete_name && !cat.complete_name.includes('All / ') && !cat.complete_name.includes('الكل / ')) {
        return cat.complete_name;
      }
      const pId = getParentId(cat);
      if (!pId || !rawCatMap.has(pId)) return cat.name;
      const parentCat = rawCatMap.get(pId);
      if (parentCat && (parentCat.name === 'All' || parentCat.name === 'الكل')) {
        return cat.name;
      }
      const parentPath = buildCatPath(pId, visited);
      return parentPath ? `${parentPath} / ${cat.name}` : cat.name;
    };

    // If any product has a category not present in rawCatMap, register it
    productCatalog.forEach(p => {
      if (p.categoryId && !rawCatMap.has(p.categoryId)) {
        rawCatMap.set(p.categoryId, {
          id: p.categoryId,
          name: p.categoryName || 'فئة غير محددة',
          complete_name: p.categoryName || 'فئة غير محددة'
        });
      }
    });

    const parentIdSet = new Set();
    rawCatMap.forEach(c => {
      const pId = getParentId(c);
      if (pId) parentIdSet.add(pId);
    });

    const processedCats = [];
    rawCatMap.forEach((c) => {
      // Exclude top-level "All" container if it has no parent
      if ((c.name === 'All' || c.name === 'الكل') && !getParentId(c)) return;

      let fullPath = c.complete_name || buildCatPath(c.id) || c.name;
      fullPath = fullPath.replace(/^(All|الكل|جميع الفئات)\s*\/\s*/i, '').trim();
      if (!fullPath) return;

      const segments = fullPath.split(' / ').map(s => s.trim()).filter(Boolean);
      const level = Math.max(0, segments.length - 1);
      const rootName = segments[0] || c.name;
      const leafName = segments[segments.length - 1] || c.name;
      const parentPath = segments.slice(0, -1).join(' › ');

      processedCats.push({
        id: c.id,
        name: fullPath,
        complete_name: fullPath,
        leafName,
        parentPath,
        rootName,
        level,
        isParent: parentIdSet.has(c.id),
        isRoot: level === 0,
        sortKey: segments.join(' / ')
      });
    });

    // Hierarchical tree sort: group by root category, ensure root is first, then DFS path order
    processedCats.sort((a, b) => {
      if (a.rootName !== b.rootName) {
        return a.rootName.localeCompare(b.rootName, 'ar');
      }
      if (a.isRoot !== b.isRoot) {
        return a.isRoot ? -1 : 1;
      }
      return a.sortKey.localeCompare(b.sortKey, 'ar', { numeric: true });
    });

    categories = processedCats;
    setCached('product_catalog', productCatalog, 60 * 60 * 1000);
    setCached('product_categories', categories, 60 * 60 * 1000);
  }
  return { productCatalog, categories };
}

// ─────────────────────────────────────────────────────────────
// Unified Partner Lookup Helper with Shared 1-Hour Cache
// ─────────────────────────────────────────────────────────────
async function getPartnersLookup(auth) {
  let partnerMap = getCached('partners_map');
  let allPartnersList = getCached('partners_list');
  if (partnerMap && allPartnersList) {
    return { partnerMap, allPartnersList };
  }

  const rawPartners = await odooExecuteKw(auth.uid, auth.password, 'res.partner', 'search_read', [
    []
  ], { fields: ['id', 'name', 'state_id', 'city', 'phone', 'user_id', 'parent_id', 'commercial_partner_id'], limit: 50000 }).catch(err => {
    console.warn('search_read all partners failed, falling back to active query:', err.message);
    return odooExecuteKw(auth.uid, auth.password, 'res.partner', 'search_read', [
      ['|', ['customer_rank', '>', 0], ['active', '=', true]]
    ], { fields: ['id', 'name', 'state_id', 'city', 'phone', 'user_id', 'parent_id', 'commercial_partner_id'], limit: 30000 }).catch(() => []);
  });

  const rawMap = new Map((rawPartners || []).map(p => [p.id, p]));
  partnerMap = new Map();
  allPartnersList = [];

  (rawPartners || []).forEach(p => {
    const { city, state } = resolvePartnerCityAndState(p, rawMap);
    const partnerObj = {
      id: p.id,
      name: p.name,
      state,
      city,
      rep: (p.user_id && p.user_id[1]) ? p.user_id[1] : 'غير محدد',
      repId: (p.user_id && p.user_id[0]) ? p.user_id[0] : null,
      phone: p.phone || ''
    };
    partnerMap.set(p.id, partnerObj);
    allPartnersList.push(partnerObj);
  });

  setCached('partners_map', partnerMap, 60 * 60 * 1000);
  setCached('partners_list', allPartnersList, 60 * 60 * 1000);
  return { partnerMap, allPartnersList };
}

// ─────────────────────────────────────────────────────────────
// Sales Team Targets Lookup Helper from Odoo
// ─────────────────────────────────────────────────────────────
async function getOdooTeamTargets(auth) {
  const cacheKey = 'odoo_team_targets';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const targetMap = new Map();
  try {
    const teams = await odooExecuteKw(auth.uid, auth.password, 'crm.team', 'search_read', [
      [['invoiced_target', '>', 0]]
    ], { fields: ['id', 'name', 'user_id', 'member_ids', 'invoiced_target'], limit: 100 }).catch(() => []);

    (teams || []).forEach(team => {
      const target = Number(team.invoiced_target) || 0;
      if (target > 0) {
        if (team.user_id && team.user_id[0]) {
          targetMap.set(team.user_id[0], target);
        }
        if (Array.isArray(team.member_ids)) {
          team.member_ids.forEach(uid => {
            if (!targetMap.has(uid)) targetMap.set(uid, target);
          });
        }
      }
    });
  } catch (err) {
    console.warn('getOdooTeamTargets search_read failed:', err.message);
  }

  setCached(cacheKey, targetMap, 30 * 60 * 1000);
  return targetMap;
}

// ─────────────────────────────────────────────────────────────
// Account Payment Valid Fields Lookup Helper from Odoo
// ─────────────────────────────────────────────────────────────
async function getAccountPaymentFields(auth) {
  const cacheKey = 'account_payment_fields';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const fieldsInfo = await odooExecuteKw(auth.uid, auth.password, 'account.payment', 'fields_get', [], { attributes: ['type'] });
    if (fieldsInfo && typeof fieldsInfo === 'object') {
      const candidates = ['id', 'name', 'date', 'amount', 'payment_type', 'partner_type', 'partner_id', 'journal_id', 'state', 'ref', 'memo', 'communication', 'payment_reference'];
      const validFields = candidates.filter(f => Boolean(fieldsInfo[f]));
      if (validFields.length > 0) {
        setCached(cacheKey, validFields, 24 * 60 * 60 * 1000);
        return validFields;
      }
    }
  } catch (err) {
    console.warn('fields_get on account.payment failed:', err.message);
  }

  // Safe fallback fields that exist in all Odoo versions
  return ['id', 'name', 'date', 'amount', 'partner_id', 'journal_id', 'state'];
}

// ─────────────────────────────────────────────────────────────
// Odoo-fidelity helpers (Cairo timezone + custom sale.order fields)
// ─────────────────────────────────────────────────────────────
function cairoOffsetHours(dateStr) {
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false }).formatToParts(d);
    let h = Number(parts.find(p => p.type === 'hour').value);
    if (h === 24) h = 0;
    return h - 12;
  } catch (e) { return 2; }
}

// Converts a local (Cairo) calendar range to the UTC datetime strings Odoo stores in date_order.
function cairoUtcRange(start, end) {
  const toUtc = (dateStr, time) => {
    const base = new Date(`${dateStr}T${time}Z`);
    base.setUTCHours(base.getUTCHours() - cairoOffsetHours(dateStr));
    return base.toISOString().replace('T', ' ').slice(0, 19);
  };
  return { from: toUtc(start, '00:00:00'), to: toUtc(end, '23:59:59') };
}

// UTC "YYYY-MM-DD HH:MM:SS" -> Cairo "YYYY-MM-DD"
function cairoDateOf(utcDateTime) {
  if (!utcDateTime) return '';
  const day = String(utcDateTime).split(' ')[0];
  const d = new Date(String(utcDateTime).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return day;
  d.setUTCHours(d.getUTCHours() + cairoOffsetHours(day));
  return d.toISOString().slice(0, 10);
}

const normalizeArabicLabel = (s) => String(s || '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي')
  .replace(/[()\s_\-]/g, '')
  .toLowerCase();

function findMatchingField(entries, candidateLabels, excludeNames = []) {
  const normCandidates = candidateLabels.map(normalizeArabicLabel);
  // 1. Exact normalized match first
  for (const cand of normCandidates) {
    const hit = entries.find(([name, f]) => !excludeNames.includes(name) && normalizeArabicLabel(f.string) === cand);
    if (hit) return { name: hit[0], type: hit[1].type, relation: hit[1].relation || null, label: hit[1].string };
  }
  // 2. Substring / contains match
  for (const cand of normCandidates) {
    const hit = entries.find(([name, f]) => !excludeNames.includes(name) && (normalizeArabicLabel(f.string).includes(cand) || cand.includes(normalizeArabicLabel(f.string))));
    if (hit) return { name: hit[0], type: hit[1].type, relation: hit[1].relation || null, label: hit[1].string };
  }
  return null;
}

// Finds the custom fields Odoo's list view groups by. Cached for a day.
async function getSoCustomFields(auth) {
  const cacheKey = 'so_custom_fields_v3';
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const result = { rep: null, region: null, city: null };
  try {
    const fields = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'fields_get', [], { attributes: ['string', 'type', 'relation', 'store'] });
    const entries = Object.entries(fields || {}).filter(([, f]) => f.store !== false && ['many2one', 'char', 'selection'].includes(f.type));

    result.region = findMatchingField(entries, ['المنطقة الجغرافية', 'المنطقه الجغرافيه', 'المنطقة', 'المنطقه', 'منطقة جغرافية', 'منطقه جغرافيه', 'منطقة', 'منطقه', 'الإقليم', 'المحافظة', 'region', 'zone']);
    result.rep = findMatchingField(entries, ['مندوب المبيعات', 'مندوب مبيعات', 'مندوب', 'المندوب', 'مسؤول المبيعات', 'البائع', 'salesperson', 'sales_person', 'rep']);
    result.city = findMatchingField(entries, ['المدينة', 'المدينه', 'مدينة', 'مدينه', 'الفرع', 'city', 'branch']);

    console.log('[SO] custom fields resolved:', JSON.stringify(result));
    if (result.rep || result.region) setCached(cacheKey, result, 24 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[SO] getSoCustomFields failed:', e.message);
  }
  return result;
}

// Finds the custom fields on account.move Odoo's list view groups by (e.g. 'مندوب المبيعات', 'المنطقة الجغرافية', 'المدينة')
async function getMoveCustomFields(auth) {
  const cacheKey = 'move_custom_fields_v4';
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const result = { rep: null, region: null, city: null };
  try {
    const fields = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'fields_get', [], { attributes: ['string', 'type', 'relation', 'store'] });
    const entries = Object.entries(fields || {}).filter(([, f]) => f.store !== false && ['many2one', 'char', 'selection'].includes(f.type));

    result.region = findMatchingField(entries, ['المنطقة الجغرافية', 'المنطقه الجغرافيه', 'المنطقة', 'المنطقه', 'منطقة جغرافية', 'منطقه جغرافيه', 'منطقة', 'منطقه', 'الإقليم', 'المحافظة', 'region', 'zone']);
    result.rep = findMatchingField(entries, ['مندوب المبيعات', 'مندوب مبيعات', 'مندوب', 'المندوب', 'مسؤول المبيعات', 'البائع', 'salesperson', 'sales_person', 'rep'], ['invoice_user_id', 'user_id']);
    result.city = findMatchingField(entries, ['المدينة', 'المدينه', 'مدينة', 'مدينه', 'الفرع', 'city', 'branch']);

    console.log('[Move] custom fields resolved:', JSON.stringify(result));
    if (result.rep || result.region) setCached(cacheKey, result, 24 * 60 * 60 * 1000);
  } catch (e) {
    console.warn('[Move] getMoveCustomFields failed:', e.message);
  }
  return result;
}

// Reads many2one ([id,name]) / char / selection values uniformly into { key, name }
function fieldValue(raw, fallbackName = 'غير محدد') {
  if (Array.isArray(raw)) return { key: raw[0], name: raw[1] || fallbackName };
  if (raw === false || raw === null || raw === undefined || raw === '') return { key: null, name: fallbackName };
  return { key: String(raw), name: String(raw) };
}

function paymentQueryFailedGuard(data) {
  return Boolean(data && data._partial);
}

async function buildSalesOrderOverview(auth, query) {
  const { start, end, year } = getDateRange(query);
  const status = String(query.salesOrderStatus || 'all').toLowerCase();
  const isDraftStatus = status === 'draft';

  const repId = asPositiveId(query.rep);
  const repName = await getDistinctRepNameById(auth, repId);
  const customerId = asPositiveId(query.customer);
  const productId = asPositiveId(query.product);
  const search = String(query.query || '').toLowerCase();

  const [{ productCatalog, categories }, { partnerMap: partners, allPartnersList }, odooTargetMap, soFields, dateFacets] = await Promise.all([
    getProductCatalog(auth).catch(() => ({ productCatalog: [], categories: [] })),
    getPartnersLookup(auth).catch(() => ({ partnerMap: new Map(), allPartnersList: [] })),
    getOdooTeamTargets(auth).catch(() => new Map()),
    getSoCustomFields(auth).catch(() => ({ rep: null, region: null, city: null })),
    getDateFacets(auth, 'salesOrder').catch(() => ({}))
  ]);
  const categoryId = resolveCategoryId(query.category, categories);

  let allowedPartnerIds = [];
  if (query.region || query.city) {
    allowedPartnerIds = [...partners.values()]
      .filter(p => !query.region || p.state === query.region)
      .filter(p => !query.city || p.city === query.city)
      .map(p => p.id);
    if (!allowedPartnerIds.length) allowedPartnerIds = [-1];
  }

  // Cairo UTC Datetime Range for date_order
  const soUtc = cairoUtcRange(start, end);
  const orderDomain = [
    ['date_order', '>=', soUtc.from],
    ['date_order', '<=', soUtc.to]
  ];
  if (status === 'post') orderDomain.push(['state', 'in', ['sale', 'done']]);
  else if (status === 'draft') orderDomain.push(['state', 'in', ['draft', 'sent']]);
  else orderDomain.push(['state', '!=', 'cancel']);

  if (repId) appendSalespersonFilter(orderDomain, soFields?.rep, repId, repName);
  if (customerId) orderDomain.push(['partner_id', '=', customerId]);
  else if (allowedPartnerIds.length) orderDomain.push(['partner_id', 'in', allowedPartnerIds]);
  if (productId) orderDomain.push(['order_line.product_id', '=', productId]);
  if (categoryId) orderDomain.push(['order_line.product_id.categ_id', 'child_of', categoryId]);
  if (search) {
    const matchingProducts = (productCatalog || []).filter(p => p.name.toLowerCase().includes(search));
    const matchingProdIds = matchingProducts.map(p => p.id);
    const searchClauses = [
      ['name', 'ilike', search],
      ['partner_id.name', 'ilike', search]
    ];
    if (soFields?.rep?.name) searchClauses.push([`${soFields.rep.name}.name`, 'ilike', search]);
    if (matchingProdIds.length) searchClauses.push(['order_line.product_id', 'in', matchingProdIds]);
    for (let i = 0; i < searchClauses.length - 1; i++) orderDomain.push('|');
    searchClauses.forEach(c => orderDomain.push(c));
  }

  // Payment domain
  const paymentDomain = [
    ['partner_type', '=', 'customer'],
    ['state', 'in', ['in_process', 'inprocess', 'paid', 'posted']],
    ['date', '>=', start],
    ['date', '<=', end]
  ];
  if (customerId) paymentDomain.push(['partner_id', '=', customerId]);
  else if (allowedPartnerIds.length) paymentDomain.push(['partner_id', 'in', allowedPartnerIds]);
  if (repId) {
    const repPartnerIds = (allPartnersList || []).filter(p => p.repId === repId).map(p => p.id);
    paymentDomain.push(['partner_id', 'in', repPartnerIds.length ? repPartnerIds : [-1]]);
  }

  // Yearly monthly series cached
  const isLastYearComp = (query.comparison || 'previousPeriod') === 'samePeriodLastYear';
  const prevYearNum = Number(year) - 1;
  const yearKey = `monthly_series_so_${auth.uid}_${year}_${repId || 0}_${customerId || 0}_${status}`;
  let yearlySeriesData = getCached(yearKey);

  // Comparison setup
  const previousRange = comparisonRange(start, end, query.comparison || 'previousPeriod');

  const soFieldsToFetch = ['id', 'name', 'date_order', 'partner_id', 'user_id', 'amount_total', 'amount_untaxed', 'state', 'invoice_ids'];
  if (soFields?.rep?.name && !soFieldsToFetch.includes(soFields.rep.name)) soFieldsToFetch.push(soFields.rep.name);
  if (soFields?.region?.name && !soFieldsToFetch.includes(soFields.region.name)) soFieldsToFetch.push(soFields.region.name);

  // 1. Parallel Batch 1: Orders, Lines, Refunds, Payments, Yearly Series, Comparison
  const [rawOrders, rawPayments, rawCustomerPayments, fetchedYearlyData, prevOrdersData, prevPaymentsData] = await Promise.all([
    odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [orderDomain], {
      fields: soFieldsToFetch,
      limit: 5000,
      order: 'date_order desc, id desc'
    }).catch(err => { console.warn('[SO] search_read orders failed:', err.message); return []; }),
    odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
      paymentDomain,
      ['amount:sum'],
      ['payment_type']
    ]).catch(() => []),
    odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
      paymentDomain,
      ['amount:sum'],
      ['partner_id', 'payment_type'],
      0, 5000, false, false
    ]).catch(() => []),
    yearlySeriesData ? Promise.resolve(yearlySeriesData) : Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
        [
          ...orderDomain.filter(item => Array.isArray(item) ? item[0] !== 'date_order' : true),
          ['date_order', '>=', `${year}-01-01 00:00:00`],
          ['date_order', '<=', `${year}-12-31 23:59:59`]
        ],
        ['amount_total:sum'],
        ['date_order:month'],
        0, 100, 'date_order:month asc'
      ]).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
        [
          ...orderDomain.filter(item => Array.isArray(item) ? item[0] !== 'date_order' : true),
          ['date_order', '>=', `${prevYearNum}-01-01 00:00:00`],
          ['date_order', '<=', `${prevYearNum}-12-31 23:59:59`]
        ],
        ['amount_total:sum'],
        ['date_order:month'],
        0, 100, 'date_order:month asc'
      ]).catch(() => [])
    ]).then(([curYearOrders, prevYearOrders]) => {
      const data = { curYearOrders, prevYearOrders };
      setCached(yearKey, data, 30 * 60 * 1000);
      return data;
    }),
    previousRange ? (async () => {
      const prevUtc = cairoUtcRange(previousRange.start, previousRange.end);
      const prevDomain = [
        ...orderDomain.filter(item => Array.isArray(item) ? item[0] !== 'date_order' : true),
        ['date_order', '>=', prevUtc.from],
        ['date_order', '<=', prevUtc.to]
      ];
      return odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
        prevDomain,
        ['amount_total:sum'],
        ['partner_id'],
        0, 5000, false, false
      ]).catch(() => []);
    })() : Promise.resolve([]),
    previousRange ? (async () => {
      const prevPayDomain = [
        ...paymentDomain.filter(item => Array.isArray(item) ? item[0] !== 'date' : true),
        ['date', '>=', previousRange.start],
        ['date', '<=', previousRange.end]
      ];
      return odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
        prevPayDomain,
        ['amount:sum'],
        ['payment_type']
      ]).catch(() => []);
    })() : Promise.resolve([])
  ]);

  // 2. Parallel Batch 2: Fetch order lines & linked posted invoice residuals
  const orders = rawOrders || [];
  const orderIds = orders.map(o => o.id);
  const orderRepInfo = new Map(orders.map(order => {
    const customRep = soFields?.rep?.name ? fieldValue(order[soFields.rep.name]) : null;
    const id = customRep?.key ?? null;
    const name = customRep?.name || 'غير محدد';
    return [order.id, { id, name }];
  }));
  const confirmedOrderInvoiceIds = [...new Set(
    orders
      .filter(o => o.state === 'sale' || o.state === 'done')
      .flatMap(o => o.invoice_ids || [])
  )];

  const [rawOrderLines, rawInvoiceMoves] = await Promise.all([
    orderIds.length > 0 ? odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [
      [['order_id', 'in', orderIds.slice(0, 1500)], ['display_type', '=', false]]
    ], { fields: ['id', 'order_id', 'product_id', 'product_uom_qty', 'price_subtotal'], limit: 10000 }).catch(() => []) : [],
    confirmedOrderInvoiceIds.length > 0 ? odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
      [['id', 'in', confirmedOrderInvoiceIds.slice(0, 1500)], ['state', '=', 'posted'], ['move_type', '=', 'out_invoice']]
    ], { fields: ['id', 'amount_total', 'amount_residual', 'state', 'move_type'], limit: 1500 }).catch(() => []) : []
  ]);
  const orderLineIds = (rawOrderLines || []).map(line => line.id);
  const orderIdByLineId = new Map((rawOrderLines || []).map(line => [line.id, line.order_id?.[0]]));
  const [rawRefundLines, reversedRefundMoves] = await Promise.all([
    (!isDraftStatus && orderLineIds.length > 0) ? odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'search_read', [[
      ['sale_line_ids', 'in', orderLineIds.slice(0, 10000)],
      ['move_id.state', '=', 'posted'],
      ['move_id.move_type', '=', 'out_refund'],
      ['display_type', '=', 'product'],
      ...(productId ? [['product_id', '=', productId]] : []),
      ...(categoryId ? [['product_id.categ_id', 'child_of', categoryId]] : [])
    ]], { fields: ['id', 'move_id', 'sale_line_ids', 'product_id', 'quantity', 'price_subtotal', 'date', 'partner_id'], limit: 20000 }).catch(err => {
      console.warn('[SO] linked credit note lines query failed:', err.message);
      return [];
    }) : [],
    (!isDraftStatus && confirmedOrderInvoiceIds.length > 0) ? odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[
      ['reversed_entry_id', 'in', confirmedOrderInvoiceIds.slice(0, 1500)],
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_refund'],
      ...(productId ? [['invoice_line_ids.product_id', '=', productId]] : []),
      ...(categoryId ? [['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]] : [])
    ]], { fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'reversed_entry_id', 'move_type', 'amount_total_signed', 'amount_total', 'invoice_date', 'date', 'ref'], limit: 5000, order: 'invoice_date desc, id desc' }).catch(() => []) : []
  ]);
  const refundMoveIds = [...new Set([
    ...(rawRefundLines || []).map(line => line.move_id?.[0]),
    ...(reversedRefundMoves || []).map(refund => refund.id)
  ].filter(Boolean))];
  const rawRefundMoves = refundMoveIds.length > 0 ? await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[
    ['id', 'in', refundMoveIds.slice(0, 5000)],
    ['state', '=', 'posted'],
    ['move_type', '=', 'out_refund']
  ]], { fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'reversed_entry_id', 'move_type', 'amount_total_signed', 'amount_total', 'invoice_date', 'date', 'ref'], limit: 5000, order: 'invoice_date desc, id desc' }).catch(() => []) : [];

  const relatedOrdersByMoveId = new Map();
  const orderById = new Map(orders.map(order => [order.id, order]));
  orders.forEach(order => (order.invoice_ids || []).forEach(moveId => {
    const linkedOrders = relatedOrdersByMoveId.get(moveId) || [];
    linkedOrders.push(order);
    relatedOrdersByMoveId.set(moveId, linkedOrders);
  }));
  const addRelatedOrder = (moveId, orderId) => {
    const order = orderById.get(orderId);
    if (!moveId || !order) return;
    const linkedOrders = relatedOrdersByMoveId.get(moveId) || [];
    if (!linkedOrders.some(candidate => candidate.id === orderId)) linkedOrders.push(order);
    relatedOrdersByMoveId.set(moveId, linkedOrders);
  };
  (rawRefundMoves || []).forEach(refund => {
    const reversedInvoiceId = refund.reversed_entry_id?.[0];
    (relatedOrdersByMoveId.get(reversedInvoiceId) || []).forEach(order => addRelatedOrder(refund.id, order.id));
  });
  (rawRefundLines || []).forEach(line => {
    (line.sale_line_ids || []).forEach(lineId => addRelatedOrder(line.move_id?.[0], orderIdByLineId.get(lineId)));
  });

  // Map of posted invoice balances
  const invoiceMap = new Map();
  (rawInvoiceMoves || []).forEach(inv => {
    const invTotal = Math.abs(Number(inv.amount_total) || 0);
    const invResidual = Math.abs(Number(inv.amount_residual) || 0);
    invoiceMap.set(inv.id, {
      id: inv.id,
      total: invTotal,
      residual: invResidual,
      paid: Math.max(0, invTotal - invResidual)
    });
  });

  // Calculate product lines
  const byProduct = new Map();
  (rawOrderLines || []).forEach(line => {
    if (!line.product_id) return;
    const val = byProduct.get(line.product_id[0]) || { id: line.product_id[0], name: line.product_id[1], amount: 0, quantity: 0, count: 0 };
    val.amount += line.price_subtotal || 0;
    val.quantity += line.product_uom_qty || 0;
    val.count += 1;
    byProduct.set(val.id, val);
  });
  const products = [...byProduct.values()].map(p => ({ ...p, amount: round2(p.amount), quantity: round2(p.quantity) }));

  // Map order lines amounts per order
  const orderLineAmountMap = new Map();
  const orderPartnerMap = new Map(orders.map(o => [o.id, o.partner_id?.[0]]));
  const partnerQtyMap = new Map();

  (rawOrderLines || []).forEach(line => {
    const oid = line.order_id?.[0];
    if (oid) {
      orderLineAmountMap.set(oid, (orderLineAmountMap.get(oid) || 0) + (line.price_subtotal || 0));
    }
    const pid = orderPartnerMap.get(oid);
    if (pid) {
      const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0, netQty: 0 };
      entry.grossQty += (line.product_uom_qty || 0);
      entry.netQty += (line.product_uom_qty || 0);
      partnerQtyMap.set(pid, entry);
    }
  });

  (rawRefundLines || []).forEach(line => {
    const pid = line.partner_id ? line.partner_id[0] : null;
    if (pid) {
      const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0, netQty: 0 };
      entry.returnedQty += Math.abs(Number(line.quantity) || 0);
      entry.netQty = Math.max(0, entry.grossQty - entry.returnedQty);
      partnerQtyMap.set(pid, entry);
    }
  });

  const isProductFilter = Boolean(productId || categoryId);
  const getOrderAmount = (order) => {
    if (isProductFilter) return orderLineAmountMap.get(order.id) || 0;
    return Number(order.amount_total) || 0;
  };

  // Payments aggregation
  let totalInboundPaymentAmt = 0;
  let totalOutboundPaymentAmt = 0;
  (rawPayments || []).forEach(p => {
    const amt = Math.abs(Number(p.amount) || 0);
    if (p.payment_type === 'outbound') {
      totalOutboundPaymentAmt += amt;
    } else {
      totalInboundPaymentAmt += amt;
    }
  });
  const collected = Math.max(0, round2(totalInboundPaymentAmt - totalOutboundPaymentAmt));

  const partnerPaymentMap = new Map();
  (rawCustomerPayments || []).forEach(p => {
    const pid = p.partner_id ? p.partner_id[0] : null;
    if (!pid) return;
    const amt = Math.abs(Number(p.amount) || 0);
    if (p.payment_type === 'outbound') {
      partnerPaymentMap.set(pid, (partnerPaymentMap.get(pid) || 0) - amt);
    } else {
      partnerPaymentMap.set(pid, (partnerPaymentMap.get(pid) || 0) + amt);
    }
  });

  // Compute order-level exact invoice-based paid & residual
  const orderPaymentMap = new Map();
  const customerOrderPaidMap = new Map();
  const customerOrderResidualMap = new Map();

  orders.forEach(order => {
    const isDraft = order.state === 'draft' || order.state === 'sent';
    const orderTotal = round2(getOrderAmount(order));
    const pid = order.partner_id?.[0];

    if (isDraft) {
      orderPaymentMap.set(order.id, { paid: 0, residual: orderTotal });
      if (pid) {
        customerOrderResidualMap.set(pid, (customerOrderResidualMap.get(pid) || 0) + orderTotal);
      }
      return;
    }

    const linkedInvoices = (order.invoice_ids || []).map(id => invoiceMap.get(id)).filter(Boolean);
    if (linkedInvoices.length === 0) {
      orderPaymentMap.set(order.id, { paid: 0, residual: orderTotal });
      if (pid) {
        customerOrderResidualMap.set(pid, (customerOrderResidualMap.get(pid) || 0) + orderTotal);
      }
    } else {
      const invTotal = linkedInvoices.reduce((sum, inv) => sum + inv.total, 0);
      const invResidual = linkedInvoices.reduce((sum, inv) => sum + inv.residual, 0);
      const invPaid = Math.max(0, invTotal - invResidual);
      const uninvoicedPortion = Math.max(0, orderTotal - invTotal);

      const paid = round2(Math.min(orderTotal, invPaid));
      const residual = round2(Math.max(0, invResidual + uninvoicedPortion));

      orderPaymentMap.set(order.id, { paid, residual });
      if (pid) {
        customerOrderPaidMap.set(pid, (customerOrderPaidMap.get(pid) || 0) + paid);
        customerOrderResidualMap.set(pid, (customerOrderResidualMap.get(pid) || 0) + residual);
      }
    }
  });

  // Calculate return totals
  const totalReturnsAmount = isDraftStatus ? 0 : round2((rawRefundMoves || []).reduce((sum, r) => sum + extractMoveAmount(r), 0));
  const totalReturnsCount = isDraftStatus ? 0 : (rawRefundMoves || []).length;
  const totalReturnedQty = isDraftStatus ? 0 : round2((rawRefundLines || []).reduce((sum, l) => sum + Math.abs(Number(l.quantity) || 0), 0));

  const gross = round2(orders.reduce((sum, o) => sum + getOrderAmount(o), 0));
  const net = Math.max(0, round2(gross - totalReturnsAmount));
  const outstanding = isDraftStatus
    ? gross
    : round2(orders.reduce((sum, o) => sum + (orderPaymentMap.get(o.id)?.residual ?? getOrderAmount(o)), 0));

  // Regional & Reps & Customers Aggregation
  const regional = new Map();
  const reps = new Map();
  const customers = new Map();

  orders.forEach(order => {
    const pid = order.partner_id?.[0];
    const partner = partners.get(pid) || { state: 'غير محدد', city: 'غير محدد', name: order.partner_id?.[1] || 'غير محدد', rep: 'غير محدد' };
    const pQty = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0, netQty: 0 };
    const orderAmt = getOrderAmount(order);

    // Custom Odoo grouping fields if present
    const customRegVal = soFields?.region?.name ? fieldValue(order[soFields.region.name]) : null;
    const customRepVal = soFields?.rep?.name ? fieldValue(order[soFields.rep.name]) : null;

    const geoKey = (customRegVal && customRegVal.name !== 'غير محدد')
      ? customRegVal.name
      : ((partner.city && partner.city !== 'غير محدد') ? partner.city : ((partner.state && partner.state !== 'غير محدد' && partner.state !== 'أخرى / غير محدد') ? partner.state : 'أخرى'));
    const stateName = partner.state || geoKey;
    const cityName = partner.city || geoKey;

    const repName = customRepVal?.name || 'غير محدد';
    const repId = customRepVal?.key ?? null;
    const repKey = normalizeArabicLabel(repName) || 'unassigned';

    // Regional map
    const reg = regional.get(geoKey) || {
      name: geoKey,
      state: stateName,
      city: cityName,
      sales: 0,
      gross: 0,
      returns: 0,
      collected: 0,
      outstanding: 0,
      invoices: 0,
      grossQty: 0,
      returnedQty: 0,
      netQty: 0
    };
    reg.sales += orderAmt;
    reg.gross += orderAmt;
    reg.invoices += 1;
    regional.set(geoKey, reg);

    // Reps map
    const rep = reps.get(repKey) || { id: repId, name: repName, achieved: 0, gross: 0, returns: 0, returnsCount: 0, collected: 0, remaining: 0, count: 0, target: 0 };
    if (!rep.id && repId) rep.id = repId;
    rep.gross += orderAmt;
    rep.achieved += orderAmt;
    rep.count += 1;
    reps.set(repKey, rep);

    // Customers map
    const cust = customers.get(pid) || {
      id: pid,
      name: partner.name || order.partner_id?.[1] || 'غير محدد',
      state: stateName,
      city: cityName,
      geoKey,
      rep: repName,
      repId: repKey,
      sales: 0,
      collected: 0,
      outstanding: 0,
      invoices: 0,
      grossQty: round2(pQty.grossQty),
      returnedQty: round2(pQty.returnedQty),
      netQty: round2(Math.max(0, pQty.grossQty - pQty.returnedQty))
    };
    cust.sales += orderAmt;
    cust.invoices += 1;
    customers.set(pid, cust);
  });

  (rawRefundMoves || []).forEach(refund => {
    const linkedOrders = relatedOrdersByMoveId.get(refund.id) || [];
    if (!linkedOrders.length) return;

    const totalWeight = linkedOrders.reduce((sum, order) => sum + Math.max(0, getOrderAmount(order)), 0);
    const refundAmount = extractMoveAmount(refund);
    let allocatedAmount = 0;
    const repAllocations = new Map();

    linkedOrders.forEach((order, index) => {
      const orderWeight = Math.max(0, getOrderAmount(order));
      const allocation = index === linkedOrders.length - 1
        ? round2(refundAmount - allocatedAmount)
        : round2(totalWeight > 0 ? refundAmount * orderWeight / totalWeight : refundAmount / linkedOrders.length);
      allocatedAmount += allocation;
      const repInfo = orderRepInfo.get(order.id);
      if (!repInfo) return;
      const repKey = normalizeArabicLabel(repInfo.name) || 'unassigned';
      const repAllocation = repAllocations.get(repKey) || { amount: 0, name: repInfo.name };
      repAllocation.amount += allocation;
      repAllocations.set(repKey, repAllocation);
    });

    repAllocations.forEach((allocation, repKey) => {
      const rep = reps.get(repKey);
      if (!rep) return;
      rep.returns += allocation.amount;
      rep.returnsCount += 1;
    });
  });

  // Calculate customer collected & outstanding
  const customerRows = [...customers.values()].map(c => {
    const sales = round2(c.sales);
    const custPaid = isDraftStatus ? 0 : round2(customerOrderPaidMap.get(c.id) || 0);
    const custResidual = isDraftStatus ? sales : round2(customerOrderResidualMap.get(c.id) ?? Math.max(0, sales - custPaid));
    const rate = sales > 0 ? Number((custPaid / sales * 100).toFixed(1)) : 0;
    return {
      ...c,
      sales,
      collected: custPaid,
      outstanding: custResidual,
      rate
    };
  });

  // Regional aggregated numbers
  const regionalDataMap = new Map();
  customerRows.forEach(c => {
    const geoKey = c.geoKey || c.city || c.state || 'أخرى';
    const entry = regionalDataMap.get(geoKey) || { collected: 0, outstanding: 0, grossQty: 0, returnedQty: 0, netQty: 0 };
    entry.collected += c.collected;
    entry.outstanding += c.outstanding;
    entry.grossQty += c.grossQty;
    entry.returnedQty += c.returnedQty;
    entry.netQty += c.netQty;
    regionalDataMap.set(geoKey, entry);
  });

  const regions = [...regional.values()].map(r => {
    const regData = regionalDataMap.get(r.name) || { collected: 0, outstanding: 0, grossQty: 0, returnedQty: 0, netQty: 0 };
    const rSales = round2(r.sales);
    const rCollected = round2(regData.collected);
    const rOutstanding = round2(regData.outstanding);
    return {
      ...r,
      sales: rSales,
      gross: rSales,
      grossQty: round2(regData.grossQty),
      returnedQty: round2(regData.returnedQty),
      netQty: round2(regData.netQty),
      collected: rCollected,
      outstanding: rOutstanding,
      rate: rSales > 0 ? Number((rCollected / rSales * 100).toFixed(1)) : 0
    };
  }).sort((a, b) => b.sales - a.sales);

  const soGrossQty = round2(regions.reduce((sum, r) => sum + (r.grossQty || 0), 0));
  const soReturnedQty = round2(regions.reduce((sum, r) => sum + (r.returnedQty || 0), 0));
  const soNetQty = round2(Math.max(0, soGrossQty - soReturnedQty));

  // Reps Performance
  const repDataMap = new Map();
  customerRows.forEach(c => {
    const entryId = (c.repId !== null && c.repId !== undefined) ? repDataMap.get(c.repId) : null;
    const entryName = c.rep ? repDataMap.get(c.rep) : null;
    const entry = entryId || entryName || { collected: 0, remaining: 0 };
    entry.collected += c.collected;
    entry.remaining += c.outstanding;
    if (c.repId) repDataMap.set(c.repId, entry);
    if (c.rep) repDataMap.set(c.rep, entry);
  });

  const totalCompanySoAmt = Number(net) || [...reps.values()].reduce((sum, r) => sum + r.achieved, 0);

  const repsList = [...reps.values()].map(rep => {
    const achieved = Math.max(0, round2(rep.gross - rep.returns));
    const rData = (rep.id ? repDataMap.get(rep.id) : null) || (rep.name ? repDataMap.get(rep.name) : null) || { collected: 0, remaining: 0 };
    const repCollected = round2(rData.collected);
    const repRemaining = round2(rData.remaining);

    const targetFromOdoo = rep.id ? odooTargetMap?.get(rep.id) : null;
    const hasTarget = Boolean(targetFromOdoo && Number(targetFromOdoo) > 0);
    const target = hasTarget ? round2(targetFromOdoo) : null;
    const targetPercentage = hasTarget ? Number((achieved / target * 100).toFixed(1)) : null;

    const contributionRate = totalCompanySoAmt > 0 ? Number((Math.max(0, achieved) / totalCompanySoAmt * 100).toFixed(1)) : 0;
    const percentage = hasTarget ? targetPercentage : contributionRate;

    const kpi = hasTarget
      ? (targetPercentage >= 100 ? 'متفوق' : targetPercentage >= 80 ? 'محقق للهدف' : (achieved > 0 ? 'يحتاج متابعة' : 'لا توجد مبيعات'))
      : (achieved > 0 ? 'أوامر مسجلة' : 'بدون مبيعات');

    const repCustomers = customerRows.filter(c => c.repId === rep.id || c.rep === rep.name).sort((a, b) => b.sales - a.sales);

    return {
      ...rep,
      achieved,
      gross: round2(rep.gross),
      returns: round2(rep.returns),
      collected: repCollected,
      remaining: repRemaining,
      target,
      hasTarget,
      percentage,
      contributionRate,
      theoreticalPercentage: null,
      theoreticalGap: null,
      actualGap: hasTarget ? Number((targetPercentage - 100).toFixed(1)) : null,
      count: rep.count || 0,
      kpi,
      customers: repCustomers
    };
  }).sort((a, b) => b.achieved - a.achieved);

  // Recent Returns / Credit notes list
  const returnsList = (rawRefundMoves || []).slice(0, 30).map((r, i) => {
    const pInfo = r.partner_id ? partners.get(r.partner_id[0]) : null;
    const moveLines = (rawRefundLines || []).filter(l => l.move_id?.[0] === r.id);
    const mainProduct = moveLines[0]?.product_id?.[1] || r.ref || 'مرتجع أمر بيع';
    const totalQty = moveLines.reduce((s, l) => s + Math.abs(Number(l.quantity) || 0), 0);
    return {
      id: r.id,
      moveId: r.id,
      creditNote: r.name || `CN-${String(i + 1).padStart(4, '0')}`,
      product: mainProduct,
      category: 'غير محدد',
      customer: r.partner_id ? r.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
      rep: [...new Set((relatedOrdersByMoveId.get(r.id) || []).map(order => orderRepInfo.get(order.id)?.name).filter(Boolean))].join('، ') || 'غير محدد',
      region: pInfo ? pInfo.state : 'غير محدد',
      date: r.invoice_date || r.date,
      returnedQty: round2(totalQty),
      returns: round2(extractMoveAmount(r)),
      odooLink: `${ODOO_URL}/web#id=${r.id}&model=account.move&view_type=form`
    };
  });

  // Monthly 12-month series
  const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const parseMonthIndex = (val) => {
    if (!val) return -1;
    const str = String(val).toLowerCase().trim();
    const numMatch = str.match(/(?:^|[-/ ])(0?[1-9]|1[0-2])(?:[-/ ]|$)/);
    if (numMatch) return Number(numMatch[1]) - 1;
    const arIdx = months.findIndex(m => str.includes(m));
    if (arIdx >= 0) return arIdx;
    const enIdx = englishMonths.findIndex(m => str.includes(m));
    if (enIdx >= 0) return enIdx;
    return -1;
  };

  const monthlyGross = new Array(12).fill(0);
  const monthlyReturns = new Array(12).fill(0);
  const monthlyNet = new Array(12).fill(0);
  const prevMonthlyGross = new Array(12).fill(0);

  (fetchedYearlyData?.curYearOrders || []).forEach(m => {
    const idx = parseMonthIndex(m['date_order:month'] || m.date_order);
    if (idx >= 0 && idx < 12) {
      monthlyGross[idx] = Number(m.amount_total) || 0;
      monthlyNet[idx] = monthlyGross[idx];
    }
  });

  (fetchedYearlyData?.prevYearOrders || []).forEach(m => {
    const idx = parseMonthIndex(m['date_order:month'] || m.date_order);
    if (idx >= 0 && idx < 12) prevMonthlyGross[idx] = Number(m.amount_total) || 0;
  });

  const calculatedTimeSeries = {
    month: months.map((label, index) => {
      const currentSales = monthlyGross[index] || 0;
      const previousSales = isLastYearComp
        ? (prevMonthlyGross[index] || 0)
        : (index > 0 ? (monthlyGross[index - 1] || 0) : (prevMonthlyGross[11] || 0));
      return {
        label,
        currentSales,
        previousSales,
        growthPercent: percentChange(currentSales, previousSales)
      };
    })
  };

  // Comparison & Churn Analysis
  let comparison = null;
  let soChurnWarnings = [];
  let growthAnalysis = {
    source: 'salesOrder',
    regions: regions.map(r => ({ name: r.name, currentSales: r.sales, previousSales: 0, growthAmount: r.sales, growthPercent: 0 })),
    customers: customerRows.map(c => ({ id: c.id, name: c.name, state: c.state, city: c.city, rep: c.rep, currentSales: c.sales, previousSales: 0, growthAmount: c.sales, growthPercent: 0, lossAmount: 0 })),
    churnWarnings: [],
    topDeclining: [],
    topGrowing: [],
    customerGrowthChart: {
      churn: { labels: [], currentSales: [], previousSales: [], lossAmount: [], growthPercent: [], items: [] },
      decline: { labels: [], currentSales: [], previousSales: [], lossAmount: [], growthPercent: [], items: [] },
      growth: { labels: [], currentSales: [], previousSales: [], growthAmount: [], growthPercent: [], items: [] }
    },
    previousRange
  };

  if (previousRange && Array.isArray(prevOrdersData)) {
    const prevPartnerMap = new Map();
    let prevGrossTotal = 0;
    let prevOrderCount = 0;

    prevOrdersData.forEach(g => {
      const pid = g.partner_id ? g.partner_id[0] : null;
      const amt = Number(g.amount_total) || 0;
      const count = Number(g.__count || g.partner_id_count) || 1;
      prevGrossTotal += amt;
      prevOrderCount += count;
      if (pid) prevPartnerMap.set(pid, (prevPartnerMap.get(pid) || 0) + amt);
    });

    let prevInbound = 0;
    let prevOutbound = 0;
    (prevPaymentsData || []).forEach(g => {
      const amt = Number(g.amount) || 0;
      if (g.payment_type === 'outbound') prevOutbound += amt;
      else prevInbound += amt;
    });
    const prevCollected = Math.max(0, round2(prevInbound - prevOutbound));

    comparison = {
      mode: query.comparison || 'previousPeriod',
      start: previousRange.start,
      end: previousRange.end,
      kpis: {
        gross: round2(prevGrossTotal),
        returns: 0,
        net: round2(prevGrossTotal),
        grossQty: gross > 0 ? round2(prevGrossTotal * (soGrossQty / gross)) : 0,
        returnsQty: 0,
        netQty: gross > 0 ? round2(prevGrossTotal * (soGrossQty / gross)) : 0,
        collected: round2(prevCollected),
        outstanding: Math.max(0, round2(prevGrossTotal - prevCollected)),
        invoicesCount: prevOrderCount,
        returnsCount: 0,
        totalPostedCount: prevOrderCount,
        avgInvoice: prevOrderCount ? round2(prevGrossTotal / prevOrderCount) : 0
      }
    };

    const allCustomerIds = new Set([...customers.keys(), ...prevPartnerMap.keys()]);
    growthAnalysis.customers = [...allCustomerIds].map(pid => {
      const c = customers.get(pid);
      const pPartner = partners.get(pid);
      const name = c?.name || pPartner?.name || `عميل #${pid}`;
      const state = c?.state || pPartner?.state || 'غير محدد';
      const city = c?.city || pPartner?.city || 'غير محدد';
      const rep = c?.rep || pPartner?.rep || 'غير محدد';
      const currentSales = round2(c?.sales || 0);
      const pSales = round2(prevPartnerMap.get(pid) || 0);
      const growthAmount = round2(currentSales - pSales);
      const growthPercent = percentChange(currentSales, pSales);
      const lossAmount = Math.max(0, round2(pSales - currentSales));
      return { id: pid, name, state, city, rep, currentSales, previousSales: pSales, growthAmount, growthPercent, lossAmount };
    }).sort((a, b) => b.currentSales - a.currentSales);

    soChurnWarnings = growthAnalysis.customers
      .filter(c => c.previousSales > 0 && c.growthAmount < 0)
      .sort((a, b) => b.lossAmount - a.lossAmount || a.growthPercent - b.growthPercent)
      .map(c => ({
        ...c,
        risk: (c.currentSales === 0 || c.growthPercent <= -50) ? 'مرتفع' : 'متوسط'
      }));

    growthAnalysis.churnWarnings = soChurnWarnings;
    growthAnalysis.topDeclining = growthAnalysis.customers.filter(c => c.growthAmount < 0).slice(0, 15);
    growthAnalysis.topGrowing = growthAnalysis.customers.filter(c => c.growthAmount > 0).slice(0, 15);
    growthAnalysis.customerGrowthChart = {
      churn: {
        labels: soChurnWarnings.slice(0, 15).map(c => c.name),
        currentSales: soChurnWarnings.slice(0, 15).map(c => c.currentSales),
        previousSales: soChurnWarnings.slice(0, 15).map(c => c.previousSales),
        lossAmount: soChurnWarnings.slice(0, 15).map(c => c.lossAmount),
        growthPercent: soChurnWarnings.slice(0, 15).map(c => c.growthPercent),
        items: soChurnWarnings.slice(0, 15)
      },
      decline: {
        labels: growthAnalysis.topDeclining.map(c => c.name),
        currentSales: growthAnalysis.topDeclining.map(c => c.currentSales),
        previousSales: growthAnalysis.topDeclining.map(c => c.previousSales),
        lossAmount: growthAnalysis.topDeclining.map(c => c.lossAmount),
        growthPercent: growthAnalysis.topDeclining.map(c => c.growthPercent),
        items: growthAnalysis.topDeclining
      },
      growth: {
        labels: growthAnalysis.topGrowing.map(c => c.name),
        currentSales: growthAnalysis.topGrowing.map(c => c.currentSales),
        previousSales: growthAnalysis.topGrowing.map(c => c.previousSales),
        growthAmount: growthAnalysis.topGrowing.map(c => c.growthAmount),
        growthPercent: growthAnalysis.topGrowing.map(c => c.growthPercent),
        items: growthAnalysis.topGrowing
      }
    };
  }

  // Top / bottom products by amount and qty
  const topProductsByAmount = [...products].sort((a, b) => b.amount - a.amount).slice(0, 15);
  const bottomProductsByAmount = [...products].filter(p => p.amount > 0).sort((a, b) => a.amount - b.amount).slice(0, 15);
  const topProductsByQty = [...products].sort((a, b) => b.quantity - a.quantity).slice(0, 15);
  const bottomProductsByQty = [...products].filter(p => p.quantity > 0).sort((a, b) => a.quantity - b.quantity).slice(0, 15);

  return {
    status: 'success',
    source: 'salesOrder',
    timestamp: new Date().toISOString(),
    filters: { start, end, year },
    kpis: {
      gross: round2(gross),
      returns: round2(totalReturnsAmount),
      net: round2(net),
      grossQty: soGrossQty,
      returnsQty: soReturnedQty,
      netQty: soNetQty,
      collected: round2(collected),
      outstanding: round2(outstanding),
      invoicesCount: orders.length,
      returnsCount: totalReturnsCount,
      totalPostedCount: orders.length,
      collectionRate: net ? Number((collected / net * 100).toFixed(1)) : 0,
      avgInvoice: orders.length ? round2(gross / orders.length) : 0
    },
    comparison,
    charts: {
      months,
      monthlyGross: monthlyGross.map(round2),
      monthlyReturns: monthlyReturns.map(round2),
      monthlyNet: monthlyNet.map(round2),
      growthTimeSeries: calculatedTimeSeries,
      customerGrowth: growthAnalysis.customerGrowthChart,
      customerGrowthItems: growthAnalysis.customers,
      churnWarnings: growthAnalysis.churnWarnings || [],
      topProducts: (query?.metric === 'quantity' || query?.metric === 'qty') ? topProductsByQty : topProductsByAmount,
      bottomProducts: (query?.metric === 'quantity' || query?.metric === 'qty') ? bottomProductsByQty : bottomProductsByAmount,
      topProductsByAmount,
      bottomProductsByAmount,
      topProductsByQty,
      bottomProductsByQty,
      regional: regions
    },
    reps: repsList,
    returns: returnsList,
    churn: soChurnWarnings,
    growthAnalysis,
    drilldown: regions.map(reg => ({
      ...reg,
      customers: customerRows
        .filter(c => c.city === reg.name || c.state === reg.name || c.geoKey === reg.name)
        .sort((a, b) => b.sales - a.sales)
    })),
    filterOptions: {
      regions: [...new Set(allPartnersList.map(p => p.state))].filter(s => s && s !== 'غير محدد' && s !== 'أخرى / غير محدد' && s !== 'أخرى').sort((a, b) => a.localeCompare(b, 'ar')),
      cities: [...new Set(allPartnersList.map(p => p.city))].filter(c => c && c !== 'غير محدد').sort((a, b) => a.localeCompare(b, 'ar')),
      reps: await getDistinctRepsFromDocuments(auth).catch(() => []),
      customers: allPartnersList.map(p => ({ id: p.id, name: p.name })).filter(p => p.name),
      categories: categories || [],
      products: productCatalog || [],
      ...dateFacets
    }
  };
}

async function buildSalesInvoiceOverview(auth, query) {
  const { start, end, year } = getDateRange(query);

  const repId = asPositiveId(query.rep);
  const repName = await getDistinctRepNameById(auth, repId);
  const customerId = asPositiveId(query.customer);
  const productId = asPositiveId(query.product);
  const search = String(query.query || '').toLowerCase();

  const [{ partnerMap, allPartnersList }, { productCatalog, categories }, odooTargetMap, moveFields, dateFacets] = await Promise.all([
    getPartnersLookup(auth).catch(() => ({ partnerMap: new Map(), allPartnersList: [] })),
    getProductCatalog(auth).catch(() => ({ productCatalog: [], categories: [] })),
    getOdooTeamTargets(auth).catch(() => new Map()),
    getMoveCustomFields(auth).catch(() => ({ rep: null, region: null, city: null })),
    getDateFacets(auth, 'postedInvoice').catch(() => ({}))
  ]);
  const categoryId = resolveCategoryId(query.category, categories);

  let allowedPartnerIds = [];
  if (query.region || query.city) {
    allowedPartnerIds = allPartnersList
      .filter(p => !query.region || p.state === query.region || p.city === query.region)
      .filter(p => !query.city || p.city === query.city)
      .map(p => p.id);
    if (!allowedPartnerIds.length) allowedPartnerIds = [-1];
  }

  // Build base moveDomain
  const moveDomain = [
    ['state', '=', 'posted'],
    ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['invoice_date', '>=', start],
    ['invoice_date', '<=', end]
  ];
  if (repId) {
    appendSalespersonFilter(moveDomain, moveFields?.rep, repId, repName);
  }
  if (customerId) moveDomain.push(['partner_id', '=', customerId]);
  else if (allowedPartnerIds.length) moveDomain.push(['partner_id', 'in', allowedPartnerIds]);
  if (productId) moveDomain.push(['invoice_line_ids.product_id', '=', productId]);
  if (categoryId) moveDomain.push(['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]);
  if (search) {
    const matchingProducts = (productCatalog || []).filter(p => p.name.toLowerCase().includes(search));
    const matchingProdIds = matchingProducts.map(p => p.id);
    const searchClauses = [
      ['name', 'ilike', search],
      ['partner_id.name', 'ilike', search]
    ];
    if (moveFields?.rep?.name) searchClauses.push([`${moveFields.rep.name}.name`, 'ilike', search]);
    if (matchingProdIds.length) searchClauses.push(['invoice_line_ids.product_id', 'in', matchingProdIds]);
    for (let i = 0; i < searchClauses.length - 1; i++) moveDomain.push('|');
    searchClauses.forEach(c => moveDomain.push(c));
  }

  // Build lineDomain (product_id != false ensures real product lines in Odoo)
  const lineDomain = [
    ['move_id.state', '=', 'posted'],
    ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
    ['product_id', '!=', false],
    ['date', '>=', start],
    ['date', '<=', end]
  ];
  if (repId) {
    const lineRepField = moveFields?.rep ? { ...moveFields.rep, name: `move_id.${moveFields.rep.name}` } : null;
    appendSalespersonFilter(lineDomain, lineRepField, repId, repName);
  }
  if (customerId) lineDomain.push(['move_id.partner_id', '=', customerId]);
  else if (allowedPartnerIds.length) lineDomain.push(['move_id.partner_id', 'in', allowedPartnerIds]);
  if (productId) lineDomain.push(['product_id', '=', productId]);
  if (categoryId) lineDomain.push(['product_id.categ_id', 'child_of', categoryId]);

  // Payment domain
  const paymentDomain = [
    ['partner_type', '=', 'customer'],
    ['state', 'in', ['in_process', 'inprocess', 'paid', 'posted']],
    ['date', '>=', start],
    ['date', '<=', end]
  ];
  if (customerId) paymentDomain.push(['partner_id', '=', customerId]);
  else if (allowedPartnerIds.length) paymentDomain.push(['partner_id', 'in', allowedPartnerIds]);
  if (repId) {
    const repPartnerIds = allPartnersList.filter(p => p.repId === repId).map(p => p.id);
    paymentDomain.push(['partner_id', 'in', repPartnerIds.length ? repPartnerIds : [-1]]);
  }

  // Yearly monthly series cached
  const isLastYearComp = (query.comparison || 'previousPeriod') === 'samePeriodLastYear';
  const prevYear = String(Number(year) - 1);
  const yearKey = `monthly_series_inv_${auth.uid}_${year}_${repId || 0}_${customerId || 0}`;
  let yearlySeriesData = getCached(yearKey);

  // Comparison setup
  const previousRange = comparisonRange(start, end, query.comparison || 'previousPeriod');

  const moveFieldsToFetch = ['id', 'name', 'invoice_date', 'date', 'move_type', 'partner_id', 'invoice_user_id', 'user_id', 'amount_total', 'amount_untaxed', 'amount_residual', 'state', 'ref'];
  if (moveFields?.rep?.name && !moveFieldsToFetch.includes(moveFields.rep.name)) moveFieldsToFetch.push(moveFields.rep.name);
  if (moveFields?.region?.name && !moveFieldsToFetch.includes(moveFields.region.name)) moveFieldsToFetch.push(moveFields.region.name);
  if (moveFields?.city?.name && !moveFieldsToFetch.includes(moveFields.city.name)) moveFieldsToFetch.push(moveFields.city.name);

  // Single Parallel Batch: Moves search_read + fast SQL aggregates (<300ms total)
  const [
    rawMoves,
    paymentSummaryGroups,
    lineQtySummaryGroups,
    customerPayGroups,
    topProductsAmtGroups,
    topProductsQtyGroups,
    fetchedYearlyData,
    prevMovesData,
    prevPaymentsData
  ] = await Promise.all([
    // 1. All moves of the period with essential fields (for reps, customers, regional & drilldown)
    odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [moveDomain], {
      fields: moveFieldsToFetch,
      limit: 10000,
      order: 'invoice_date desc, id desc'
    }).catch(err => { console.warn('overview search_read moves failed:', err.message); return []; }),

    // 2. Authoritative Payment Totals via PostgreSQL read_group
    odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
      paymentDomain,
      ['amount:sum'],
      ['payment_type']
    ]).catch(err => { console.warn('overview payment read_group failed:', err.message); return []; }),

    // 3. Separate invoice and credit-note quantities to avoid ambiguous related-field group values.
    Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...lineDomain, ['move_id.move_type', '=', 'out_invoice']],
        ['quantity:sum'],
        []
      ]).catch(err => { console.warn('overview invoice qty read_group failed:', err.message); return []; }),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...lineDomain, ['move_id.move_type', '=', 'out_refund']],
        ['quantity:sum'],
        []
      ]).catch(err => { console.warn('overview refund qty read_group failed:', err.message); return []; })
    ]).then(([invoiceQtyGroups, refundQtyGroups]) => ({
      gross: Number(invoiceQtyGroups?.[0]?.quantity) || 0,
      returns: Number(refundQtyGroups?.[0]?.quantity) || 0
    })),

    // 4. Customer Payments Breakdown via read_group
    odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
      paymentDomain,
      ['amount:sum'],
      ['partner_id', 'payment_type'],
      0, 5000, false, false
    ]).catch(err => { console.warn('overview customer payments read_group failed:', err.message); return []; }),

    // 5. Top 30 Products by Amount via SQL aggregation
    odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
      [...lineDomain, ['move_id.move_type', '=', 'out_invoice']],
      ['price_subtotal', 'quantity'],
      ['product_id']
    ], {
      limit: 30,
      orderby: 'price_subtotal desc'
    }).catch(err => {
      console.warn('overview top prod amount read_group failed:', err.message);
      return odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...lineDomain, ['move_id.move_type', '=', 'out_invoice']],
        ['price_subtotal', 'quantity'],
        ['product_id']
      ], { limit: 100 }).catch(() => []);
    }),

    // 6. Top 30 Products by Quantity via SQL aggregation
    odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
      [...lineDomain, ['move_id.move_type', '=', 'out_invoice']],
      ['price_subtotal', 'quantity'],
      ['product_id']
    ], {
      limit: 30,
      orderby: 'quantity desc'
    }).catch(err => {
      console.warn('overview top prod qty read_group failed:', err.message);
      return odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...lineDomain, ['move_id.move_type', '=', 'out_invoice']],
        ['price_subtotal', 'quantity'],
        ['product_id']
      ], { limit: 100 }).catch(() => []);
    }),

    // 7. Yearly Monthly Series (cached)
    yearlySeriesData ? Promise.resolve(yearlySeriesData) : (async () => {
      const baseMoveFilter = moveDomain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true);
      const [curYearMoves, prevYearMoves] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [
            ...baseMoveFilter,
            ['invoice_date', '>=', `${year}-01-01`],
            ['invoice_date', '<=', `${year}-12-31`]
          ],
          ['amount_total:sum'],
          ['invoice_date:month', 'move_type'],
          0, 100, 'invoice_date:month asc'
        ]).catch(() => []),
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [
            ...baseMoveFilter,
            ['invoice_date', '>=', `${prevYear}-01-01`],
            ['invoice_date', '<=', `${prevYear}-12-31`]
          ],
          ['amount_total:sum'],
          ['invoice_date:month', 'move_type'],
          0, 100, 'invoice_date:month asc'
        ]).catch(() => [])
      ]);
      const data = { curYearMoves, prevYearMoves };
      setCached(yearKey, data, 30 * 60 * 1000);
      return data;
    })(),

    // 8. Comparison Moves
    previousRange ? (async () => {
      const prevDomain = [
        ...moveDomain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true),
        ['invoice_date', '>=', previousRange.start],
        ['invoice_date', '<=', previousRange.end]
      ];
      return odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
        prevDomain
      ], {
        fields: ['id', 'partner_id', 'amount_total', 'move_type'],
        limit: 10000
      }).catch(() => []);
    })() : Promise.resolve([]),

    // 9. Comparison Payments
    previousRange ? (async () => {
      const prevPayDomain = [
        ...paymentDomain.filter((item) => Array.isArray(item) ? item[0] !== 'date' : true),
        ['date', '>=', previousRange.start],
        ['date', '<=', previousRange.end]
      ];
      return odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
        prevPayDomain,
        ['amount:sum'],
        ['payment_type']
      ]).catch(() => []);
    })() : Promise.resolve([])
  ]);

  // 1. Authoritative Invoice & Refund Summary from rawMoves
  const moves = rawMoves || [];
  const invoices = moves.filter(m => m.move_type === 'out_invoice');
  const refunds = moves.filter(m => m.move_type === 'out_refund');
  const invoiceCount = invoices.length;
  const returnCount = refunds.length;
  const totalPostedCount = moves.length;

  const gross = round2(invoices.reduce((sum, m) => sum + (Math.abs(Number(m.amount_total)) || 0), 0));
  const returns = round2(refunds.reduce((sum, m) => sum + (Math.abs(Number(m.amount_total)) || 0), 0));
  const net = Math.max(0, round2(gross - returns));

  const untaxedGross = invoices.reduce((sum, m) => sum + (Math.abs(Number(m.amount_untaxed)) || 0), 0);
  const untaxedReturns = refunds.reduce((sum, m) => sum + (Math.abs(Number(m.amount_untaxed)) || 0), 0);
  const untaxed = Math.max(0, round2(untaxedGross - untaxedReturns));

  const invoiceResidual = invoices.reduce((sum, m) => sum + (Math.abs(Number(m.amount_residual)) || 0), 0);
  const returnResidual = refunds.reduce((sum, m) => sum + (Math.abs(Number(m.amount_residual)) || 0), 0);
  const outstanding = Math.max(0, round2(invoiceResidual - returnResidual));

  // 2. Authoritative Payments Summary (Matches drill-down 100% to the cent)
  let totalInboundPaymentAmt = 0;
  let totalOutboundPaymentAmt = 0;
  (paymentSummaryGroups || []).forEach(p => {
    const amt = Math.abs(Number(p.amount) || 0);
    if (p.payment_type === 'outbound') {
      totalOutboundPaymentAmt += amt;
    } else {
      totalInboundPaymentAmt += amt;
    }
  });
  const collected = Math.max(0, round2(totalInboundPaymentAmt - totalOutboundPaymentAmt));
  const rate = net > 0 ? (collected / net * 100) : 0;
  const avgInvoice = invoiceCount > 0 ? round2(gross / invoiceCount) : 0;

  // 3. Line Quantities
  const totalGrossQty = round2(Math.abs(Number(lineQtySummaryGroups?.gross) || 0));
  const totalReturnedQty = round2(Math.abs(Number(lineQtySummaryGroups?.returns) || 0));
  const totalNetQty = round2(Math.max(0, totalGrossQty - totalReturnedQty));

  // 4. Sales Reps Performance
  const repsMap = new Map();
  moves.forEach(m => {
    const customRepVal = moveFields?.rep?.name ? fieldValue(m[moveFields.rep.name]) : null;
    const repId = customRepVal?.key ?? null;
    const repName = customRepVal?.name || 'غير محدد';
    const key = normalizeArabicLabel(repName) || (repId !== null ? String(repId) : 'unassigned');
    const entry = repsMap.get(key) || {
      id: repId,
      name: repName,
      gross: 0,
      returns: 0,
      achieved: 0,
      remaining: 0,
      count: 0,
      invoicesCount: 0,
      returnsCount: 0
    };
    const amt = Math.abs(Number(m.amount_total)) || 0;
    const res = Math.abs(Number(m.amount_residual)) || 0;

    if (m.move_type === 'out_refund') {
      entry.returns += amt;
      entry.returnsCount += 1;
      entry.achieved -= amt;
      entry.remaining -= res;
    } else {
      entry.gross += amt;
      entry.invoicesCount += 1;
      entry.achieved += amt;
      entry.remaining += res;
    }
    entry.count += 1;
    repsMap.set(key, entry);
  });

  const repsList = [...repsMap.values()].map(r => {
    const grossAmt = round2(r.gross);
    const returnsAmt = round2(r.returns);
    const achieved = Math.max(0, round2(grossAmt - returnsAmt));
    const remaining = Math.max(0, round2(r.remaining));
    const repCollected = Math.min(achieved, Math.max(0, round2(achieved - remaining)));
    const repRemaining = Math.max(0, round2(achieved - repCollected));

    const targetFromOdoo = r.id ? odooTargetMap?.get(r.id) : null;
    const hasTarget = Boolean(targetFromOdoo && Number(targetFromOdoo) > 0);
    const target = hasTarget ? round2(targetFromOdoo) : null;
    const targetPercentage = hasTarget ? Number((achieved / target * 100).toFixed(1)) : null;

    const contributionRate = net > 0 ? Number((Math.max(0, achieved) / net * 100).toFixed(1)) : 0;
    const percentage = hasTarget ? targetPercentage : contributionRate;

    return {
      id: r.id,
      name: r.name,
      achieved,
      gross: grossAmt,
      returns: returnsAmt,
      collected: repCollected,
      remaining: repRemaining,
      target,
      hasTarget,
      percentage,
      contributionRate,
      theoreticalPercentage: null,
      theoreticalGap: null,
      actualGap: hasTarget ? Number((targetPercentage - 100).toFixed(1)) : null,
      count: r.count,
      invoicesCount: r.invoicesCount,
      returnsCount: r.returnsCount,
      kpi: achieved > 0 ? 'مبيعات مؤكدة' : 'بدون مبيعات'
    };
  }).sort((a, b) => b.achieved - a.achieved);

  // 5. Customers & Regional Aggregation
  const partnerPaymentMap = new Map();
  (customerPayGroups || []).forEach(p => {
    const pid = p.partner_id ? p.partner_id[0] : null;
    if (!pid) return;
    const amt = Math.abs(Number(p.amount) || 0);
    if (p.payment_type === 'outbound') {
      partnerPaymentMap.set(pid, (partnerPaymentMap.get(pid) || 0) - amt);
    } else {
      partnerPaymentMap.set(pid, (partnerPaymentMap.get(pid) || 0) + amt);
    }
  });

  const customersMap = new Map();
  const customerBreakdownMap = new Map();
  const regionalTotals = {};

  moves.forEach(m => {
    if (!m.partner_id) return;
    const pId = m.partner_id[0];
    const pName = m.partner_id[1];
    const customRepVal = moveFields?.rep?.name ? fieldValue(m[moveFields.rep.name]) : null;
    const repId = customRepVal?.key ?? null;
    const repName = customRepVal?.name || 'غير محدد';

    const customRegVal = moveFields?.region?.name ? fieldValue(m[moveFields.region.name]) : null;
    const customCityVal = moveFields?.city?.name ? fieldValue(m[moveFields.city.name]) : null;

    const info = partnerMap.get(pId) || { state: 'أخرى', city: 'غير محدد', rep: 'غير محدد' };

    const cityName = (customCityVal && customCityVal.name !== 'غير محدد')
      ? customCityVal.name
      : ((info.city && info.city !== 'غير محدد') ? info.city : ((info.state && info.state !== 'أخرى / غير محدد' && info.state !== 'غير محدد') ? info.state : 'أخرى'));
    const stateName = (customRegVal && customRegVal.name !== 'غير محدد')
      ? customRegVal.name
      : ((info.state && info.state !== 'أخرى / غير محدد' && info.state !== 'غير محدد') ? info.state : cityName);
    const geoKey = (customRegVal && customRegVal.name !== 'غير محدد') ? customRegVal.name : cityName;

    const amt = Math.abs(Number(m.amount_total)) || 0;
    const res = Math.abs(Number(m.amount_residual)) || 0;

    // Overall customer entry (for growth analysis and partner lists)
    const cust = customersMap.get(pId) || {
      id: pId,
      name: pName,
      state: stateName,
      city: cityName,
      geoKey,
      rep: repName,
      gross: 0,
      returns: 0,
      sales: 0,
      collected: 0,
      outstanding: 0,
      invoices: 0,
      grossQty: 0,
      returnedQty: 0,
      netQty: 0
    };

    // Detailed customer-rep breakdown entry (strictly grouped by actual invoice rep in Odoo)
    const custRepKey = `${pId}_${repId || repName || 'unassigned'}`;
    const custRep = customerBreakdownMap.get(custRepKey) || {
      id: pId,
      repId,
      name: pName,
      state: stateName,
      city: cityName,
      geoKey,
      rep: repName,
      gross: 0,
      returns: 0,
      sales: 0,
      collected: 0,
      outstanding: 0,
      invoices: 0,
      grossQty: 0,
      returnedQty: 0,
      netQty: 0
    };

    if (m.move_type === 'out_refund') {
      cust.returns += amt;
      custRep.returns += amt;
    } else {
      cust.gross += amt;
      cust.invoices += 1;
      cust.collected += Math.max(0, amt - res);
      cust.outstanding += res;

      custRep.gross += amt;
      custRep.invoices += 1;
      custRep.collected += Math.max(0, amt - res);
      custRep.outstanding += res;
    }
    customersMap.set(pId, cust);
    customerBreakdownMap.set(custRepKey, custRep);

    if (!regionalTotals[geoKey]) {
      regionalTotals[geoKey] = {
        name: geoKey,
        state: stateName,
        city: cityName,
        sales: 0,
        gross: 0,
        returns: 0,
        collected: 0,
        residual: 0,
        invoices: 0,
        grossQty: 0,
        returnedQty: 0,
        netQty: 0
      };
    }
    if (m.move_type === 'out_refund') {
      regionalTotals[geoKey].returns += amt;
    } else {
      regionalTotals[geoKey].gross += amt;
      regionalTotals[geoKey].invoices += 1;
      regionalTotals[geoKey].collected += Math.max(0, amt - res);
      regionalTotals[geoKey].residual += res;
    }
  });

  // Authoritatively finalize customer sales for growth analysis
  customersMap.forEach(cust => {
    cust.gross = round2(cust.gross);
    cust.returns = round2(cust.returns);
    cust.sales = Math.max(0, round2(cust.gross - cust.returns));
    cust.collected = round2(cust.collected);
    cust.outstanding = round2(cust.outstanding);
  });

  const customerBreakdown = [...customerBreakdownMap.values()].map(c => {
    const cGross = round2(c.gross);
    const cReturns = round2(c.returns);
    const cSales = Math.max(0, round2(cGross - cReturns));
    const cPaid = round2(c.collected);
    const cOutstanding = round2(Math.max(0, cSales - cPaid));
    const cGrossRatio = gross > 0 ? (cGross / gross) : 0;
    const custGrossQty = round2(totalGrossQty * cGrossRatio);
    const custReturnedQty = round2(totalReturnedQty * (returns > 0 ? (cReturns / returns) : 0));
    const custNetQty = round2(Math.max(0, custGrossQty - custReturnedQty));
    return {
      ...c,
      gross: cGross,
      returns: cReturns,
      sales: cSales,
      collected: cPaid,
      outstanding: cOutstanding,
      grossQty: custGrossQty,
      returnedQty: custReturnedQty,
      netQty: custNetQty,
      rate: cSales > 0 ? Number((cPaid / cSales * 100).toFixed(1)) : 0
    };
  }).sort((a, b) => b.sales - a.sales);

  const regionalList = Object.values(regionalTotals).map(r => {
    const rGross = round2(r.gross);
    const rReturns = round2(r.returns);
    const rSales = Math.max(0, round2(rGross - rReturns));
    const rCollected = round2(r.collected);
    const rResidual = round2(r.residual);
    const regGrossRatio = gross > 0 ? (rGross / gross) : 0;
    const regGrossQty = round2(totalGrossQty * regGrossRatio);
    const regReturnedQty = round2(totalReturnedQty * (returns > 0 ? (rReturns / returns) : 0));
    const regNetQty = round2(Math.max(0, regGrossQty - regReturnedQty));
    return {
      ...r,
      gross: rGross,
      returns: rReturns,
      sales: rSales,
      collected: rCollected,
      outstanding: rResidual,
      grossQty: regGrossQty,
      returnedQty: regReturnedQty,
      netQty: regNetQty,
      rate: rSales > 0 ? Number((rCollected / rSales * 100).toFixed(1)) : 0
    };
  }).sort((a, b) => b.sales - a.sales);

  // 6. Top & Bottom Products
  let topProductsByAmount = (topProductsAmtGroups || []).map(g => ({
    name: g.product_id ? g.product_id[1] : 'منتج غير محدد',
    amount: round2(g.price_subtotal || 0),
    quantity: round2(g.quantity || 0),
    count: Number(g.__count || g.product_id_count) || 1
  })).filter(p => p.amount > 0 || p.quantity > 0).slice(0, 15);

  let topProductsByQty = (topProductsQtyGroups || []).map(g => ({
    name: g.product_id ? g.product_id[1] : 'منتج غير محدد',
    amount: round2(g.price_subtotal || 0),
    quantity: round2(g.quantity || 0),
    count: Number(g.__count || g.product_id_count) || 1
  })).filter(p => p.amount > 0 || p.quantity > 0).slice(0, 15);

  // Fallback: If read_group on move.line was restricted by Odoo version, fetch recent sample invoice lines
  if (topProductsByAmount.length === 0 && moves.length > 0) {
    try {
      const topMoveIds = moves.slice(0, 300).map(m => m.id);
      const sampleLines = await odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'search_read', [
        [['move_id', 'in', topMoveIds], ['product_id', '!=', false]]
      ], { fields: ['product_id', 'price_subtotal', 'quantity'], limit: 2000 }).catch(() => []);
      
      const fallbackProdMap = new Map();
      (sampleLines || []).forEach(l => {
        if (!l.product_id) return;
        const pid = l.product_id[0];
        const pname = l.product_id[1];
        const entry = fallbackProdMap.get(pid) || { name: pname, amount: 0, quantity: 0, count: 0 };
        entry.amount += (Number(l.price_subtotal) || 0);
        entry.quantity += (Number(l.quantity) || 0);
        entry.count += 1;
        fallbackProdMap.set(pid, entry);
      });
      if (fallbackProdMap.size > 0) {
        topProductsByAmount = [...fallbackProdMap.values()].map(p => ({ ...p, amount: round2(p.amount), quantity: round2(p.quantity) })).sort((a, b) => b.amount - a.amount).slice(0, 15);
        topProductsByQty = [...fallbackProdMap.values()].map(p => ({ ...p, amount: round2(p.amount), quantity: round2(p.quantity) })).sort((a, b) => b.quantity - a.quantity).slice(0, 15);
      }
    } catch (err) {
      console.warn('fallback product line query error:', err.message);
    }
  }

  const bottomProductsByAmount = [...topProductsByAmount].filter(p => p.amount > 0).reverse().slice(0, 15);
  const bottomProductsByQty = [...topProductsByQty].filter(p => p.quantity > 0).reverse().slice(0, 15);

  const metric = String(query.metric || 'amount').toLowerCase();
  const isQtyMetric = metric === 'quantity' || metric === 'qty';
  const topProducts = isQtyMetric ? topProductsByQty : topProductsByAmount;
  const bottomProducts = isQtyMetric ? bottomProductsByQty : bottomProductsByAmount;

  // 7. Recent Returns List
  const returnsList = (refunds || []).slice(0, 30).map((r, i) => {
    const pInfo = r.partner_id ? partnerMap.get(r.partner_id[0]) : null;
    const customRepVal = moveFields?.rep?.name ? fieldValue(r[moveFields.rep.name]) : null;
    const repName = customRepVal?.name || 'غير محدد';
    const customRegVal = moveFields?.region?.name ? fieldValue(r[moveFields.region.name]) : null;
    const regionName = (customRegVal && customRegVal.name !== 'غير محدد')
      ? customRegVal.name
      : (pInfo ? pInfo.state : 'غير محدد');
    return {
      id: r.id,
      moveId: r.id,
      creditNote: r.name || `CN-${String(i + 1).padStart(4, '0')}`,
      product: r.ref || 'مرتجع مبيعات',
      category: 'غير محدد',
      customer: r.partner_id ? r.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
      rep: repName,
      region: regionName,
      date: r.invoice_date || r.date,
      returnedQty: 1,
      returns: round2(Math.abs(Number(r.amount_total)) || 0),
      odooLink: `${ODOO_URL}/web#id=${r.id}&model=account.move&view_type=form`
    };
  });

  // 8. Yearly 12-Month Series
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const parseMonthIndex = (val) => {
    if (!val) return -1;
    const str = String(val).toLowerCase().trim();
    const numMatch = str.match(/(?:^|[-/ ])(0?[1-9]|1[0-2])(?:[-/ ]|$)/);
    if (numMatch) return Number(numMatch[1]) - 1;
    const arIdx = monthNames.findIndex(m => str.includes(m));
    if (arIdx >= 0) return arIdx;
    const enIdx = englishMonths.findIndex(m => str.includes(m));
    if (enIdx >= 0) return enIdx;
    return -1;
  };

  const monthlyGross = new Array(12).fill(0);
  const monthlyReturns = new Array(12).fill(0);
  const monthlyNet = new Array(12).fill(0);
  const prevMonthlyGross = new Array(12).fill(0);

  (fetchedYearlyData?.curYearMoves || []).forEach(m => {
    const idx = parseMonthIndex(m['invoice_date:month'] || m.invoice_date);
    if (idx >= 0 && idx < 12) {
      const amt = Math.abs(Number(m.amount_total)) || 0;
      if (m.move_type === 'out_refund') {
        monthlyReturns[idx] += amt;
      } else {
        monthlyGross[idx] += amt;
      }
      monthlyNet[idx] = Math.max(0, monthlyGross[idx] - monthlyReturns[idx]);
    }
  });

  (fetchedYearlyData?.prevYearMoves || []).forEach(m => {
    const idx = parseMonthIndex(m['invoice_date:month'] || m.invoice_date);
    if (idx >= 0 && idx < 12) {
      const amt = Math.abs(Number(m.amount_total)) || 0;
      if (m.move_type !== 'out_refund') {
        prevMonthlyGross[idx] += amt;
      }
    }
  });

  const calculatedTimeSeries = {
    month: monthNames.map((label, index) => {
      const currentSales = monthlyGross[index] || 0;
      const previousSales = isLastYearComp
        ? (prevMonthlyGross[index] || 0)
        : (index > 0 ? (monthlyGross[index - 1] || 0) : (prevMonthlyGross[11] || 0));
      return {
        label,
        currentSales,
        previousSales,
        growthPercent: percentChange(currentSales, previousSales)
      };
    })
  };

  // 9. Comparison & Growth / Churn Analysis
  let comparison = null;
  let churnWarnings = [];
  let growthAnalysis = {
    source: 'postedInvoice',
    regions: regionalList.map(r => ({ name: r.name, currentSales: r.sales, previousSales: 0, growthAmount: r.sales, growthPercent: 0 })),
    customers: customerBreakdown.map(c => ({ id: c.id, name: c.name, state: c.state, city: c.city, rep: c.rep, currentSales: c.sales, previousSales: 0, growthAmount: c.sales, growthPercent: 0, lossAmount: 0 })),
    churnWarnings: [],
    topDeclining: [],
    topGrowing: [],
    customerGrowthChart: {
      churn: { labels: [], currentSales: [], previousSales: [], lossAmount: [], growthPercent: [], items: [] },
      decline: { labels: [], currentSales: [], previousSales: [], lossAmount: [], growthPercent: [], items: [] },
      growth: { labels: [], currentSales: [], previousSales: [], growthAmount: [], growthPercent: [], items: [] }
    },
    previousRange
  };

  if (previousRange && Array.isArray(prevMovesData)) {
    const prevPartnerMap = new Map();
    let prevGrossTotal = 0;
    let prevReturnsTotal = 0;
    let prevInvoiceCount = 0;
    let prevReturnCount = 0;

    prevMovesData.forEach(g => {
      const pid = g.partner_id ? g.partner_id[0] : null;
      const amt = Math.abs(Number(g.amount_total)) || 0;

      if (g.move_type === 'out_refund') {
        prevReturnsTotal += amt;
        prevReturnCount += 1;
        if (pid) prevPartnerMap.set(pid, (prevPartnerMap.get(pid) || 0) - amt);
      } else {
        prevGrossTotal += amt;
        prevInvoiceCount += 1;
        if (pid) prevPartnerMap.set(pid, (prevPartnerMap.get(pid) || 0) + amt);
      }
    });

    const prevNetTotal = Math.max(0, round2(prevGrossTotal - prevReturnsTotal));

    let prevInbound = 0;
    let prevOutbound = 0;
    (prevPaymentsData || []).forEach(g => {
      const amt = Math.abs(Number(g.amount)) || 0;
      if (g.payment_type === 'outbound') prevOutbound += amt;
      else prevInbound += amt;
    });
    const prevCollected = Math.max(0, round2(prevInbound - prevOutbound));

    comparison = {
      mode: query.comparison || 'previousPeriod',
      start: previousRange.start,
      end: previousRange.end,
      kpis: {
        gross: round2(prevGrossTotal),
        returns: round2(prevReturnsTotal),
        net: prevNetTotal,
        grossQty: gross > 0 ? round2(prevGrossTotal * (totalGrossQty / gross)) : 0,
        returnsQty: returns > 0 ? round2(prevReturnsTotal * (totalReturnedQty / returns)) : 0,
        netQty: gross > 0 ? round2(prevNetTotal * (totalNetQty / (net || 1))) : 0,
        collected: round2(prevCollected),
        outstanding: Math.max(0, round2(prevNetTotal - prevCollected)),
        invoicesCount: prevInvoiceCount,
        returnsCount: prevReturnCount,
        totalPostedCount: prevInvoiceCount + prevReturnCount,
        avgInvoice: prevInvoiceCount ? round2(prevGrossTotal / prevInvoiceCount) : 0
      }
    };

    const allCustomerIds = new Set([...customersMap.keys(), ...prevPartnerMap.keys()]);
    growthAnalysis.customers = [...allCustomerIds].map(pid => {
      const c = customersMap.get(pid);
      const pPartner = partnerMap.get(pid);
      const name = c?.name || pPartner?.name || `عميل #${pid}`;
      const state = c?.state || pPartner?.state || 'غير محدد';
      const city = c?.city || pPartner?.city || 'غير محدد';
      const rep = c?.rep || pPartner?.rep || 'غير محدد';
      const currentSales = round2(c?.sales || 0);
      const pSales = round2(Math.max(0, prevPartnerMap.get(pid) || 0));
      const growthAmount = round2(currentSales - pSales);
      const growthPercent = percentChange(currentSales, pSales);
      const lossAmount = Math.max(0, round2(pSales - currentSales));
      return { id: pid, name, state, city, rep, currentSales, previousSales: pSales, growthAmount, growthPercent, lossAmount };
    }).sort((a, b) => b.currentSales - a.currentSales);

    churnWarnings = growthAnalysis.customers
      .filter(c => c.previousSales > 0 && c.growthAmount < 0)
      .sort((a, b) => b.lossAmount - a.lossAmount || a.growthPercent - b.growthPercent)
      .map(c => ({
        ...c,
        risk: (c.currentSales === 0 || c.growthPercent <= -50) ? 'مرتفع' : 'متوسط'
      }));

    growthAnalysis.churnWarnings = churnWarnings;
    growthAnalysis.topDeclining = growthAnalysis.customers.filter(c => c.growthAmount < 0).slice(0, 15);
    growthAnalysis.topGrowing = growthAnalysis.customers.filter(c => c.growthAmount > 0).slice(0, 15);
    growthAnalysis.customerGrowthChart = {
      churn: {
        labels: churnWarnings.slice(0, 15).map(c => c.name),
        currentSales: churnWarnings.slice(0, 15).map(c => c.currentSales),
        previousSales: churnWarnings.slice(0, 15).map(c => c.previousSales),
        lossAmount: churnWarnings.slice(0, 15).map(c => c.lossAmount),
        growthPercent: churnWarnings.slice(0, 15).map(c => c.growthPercent),
        items: churnWarnings.slice(0, 15)
      },
      decline: {
        labels: growthAnalysis.topDeclining.map(c => c.name),
        currentSales: growthAnalysis.topDeclining.map(c => c.currentSales),
        previousSales: growthAnalysis.topDeclining.map(c => c.previousSales),
        lossAmount: growthAnalysis.topDeclining.map(c => c.lossAmount),
        growthPercent: growthAnalysis.topDeclining.map(c => c.growthPercent),
        items: growthAnalysis.topDeclining
      },
      growth: {
        labels: growthAnalysis.topGrowing.map(c => c.name),
        currentSales: growthAnalysis.topGrowing.map(c => c.currentSales),
        previousSales: growthAnalysis.topGrowing.map(c => c.previousSales),
        growthAmount: growthAnalysis.topGrowing.map(c => c.growthAmount),
        growthPercent: growthAnalysis.topGrowing.map(c => c.growthPercent),
        items: growthAnalysis.topGrowing
      }
    };
  }

  return {
    status: 'success',
    source: 'postedInvoice',
    timestamp: new Date().toISOString(),
    filters: { start, end, year },
    kpis: {
      gross: round2(gross),
      returns: round2(returns),
      net: round2(net),
      untaxed: round2(untaxed),
      grossQty: totalGrossQty,
      returnsQty: totalReturnedQty,
      netQty: totalNetQty,
      collected: round2(collected),
      outstanding: round2(outstanding),
      invoicesCount: invoiceCount,
      returnsCount: returnCount,
      totalPostedCount: totalPostedCount,
      collectionRate: Number(rate.toFixed(1)),
      avgInvoice: round2(avgInvoice)
    },
    comparison,
    charts: {
      months: monthNames,
      monthlyGross: monthlyGross.map(round2),
      monthlyReturns: monthlyReturns.map(round2),
      monthlyNet: monthlyNet.map(round2),
      growthTimeSeries: calculatedTimeSeries,
      customerGrowth: growthAnalysis.customerGrowthChart,
      customerGrowthItems: growthAnalysis.customers,
      churnWarnings: growthAnalysis.churnWarnings || [],
      topProducts,
      bottomProducts,
      topProductsByAmount,
      bottomProductsByAmount,
      topProductsByQty,
      bottomProductsByQty,
      regional: regionalList
    },
    reps: repsList,
    returns: returnsList,
    churn: churnWarnings,
    growthAnalysis,
    customerBreakdown,
    drilldown: customerBreakdown,
    filterOptions: {
      regions: [...new Set([...allPartnersList.map(p => p.state), ...regionalList.map(r => r.name)])].filter(s => s && s !== 'غير محدد' && s !== 'أخرى / غير محدد' && s !== 'أخرى').sort((a, b) => a.localeCompare(b, 'ar')),
      cities: [...new Set(allPartnersList.map(p => p.city))].filter(c => c && c !== 'غير محدد').sort((a, b) => a.localeCompare(b, 'ar')),
      reps: await getDistinctRepsFromDocuments(auth, 'postedInvoice').catch(() => []),
      customers: allPartnersList.map(p => ({ id: p.id, name: p.name })).filter(p => p.name),
      categories: categories || [],
      products: productCatalog || [],
      ...dateFacets
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Unified Dashboard Overview API
// ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const auth = await getAuthCredentials(req);
    if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheKey = normalizeCacheKey('overview', auth.uid, req.query);

    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    }
    res.setHeader('X-Cache', 'MISS');

    let payload;
    if (req.query.source === 'salesOrder') {
      payload = await buildSalesOrderOverview(auth, req.query);
    } else {
      payload = await buildSalesInvoiceOverview(auth, req.query);
    }

    const ttl = getAdaptiveOverviewTTL(req.query);
    setCached(cacheKey, payload, ttl);
    return res.json(payload);
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    try {
      const auth = await getAuthCredentials(req);
      if (auth) {
        const cacheKey = normalizeCacheKey('overview', auth.uid, req.query);
        const stale = getCached(cacheKey);
        if (stale) {
          res.setHeader('X-Cache', 'STALE-FALLBACK');
          return res.json({
            ...stale,
            isStale: true,
            warning: 'تم عرض آخر بيانات متوفرة نظراً لبطء اتصال خادم Odoo حالياً (انقر إعادة المحاولة للتحديث).'
          });
        }
      }
    } catch (_) {}

    const friendlyError = sanitizeErrorMessage(error);
    return res.status(500).json({ error: friendlyError, code: 'ODOO_SERVER_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/kpi-drilldown', async (req, res) => {
  try {
    const auth = await getAuthCredentials(req);
    if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheKey = normalizeCacheKey('drilldown', auth.uid, req.query);

    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }
    }
    res.setHeader('X-Cache', 'MISS');

    const kpi = String(req.query.kpi || 'gross').trim();
    const source = String(req.query.source || 'postedInvoice').trim();
    const { start, end } = getDateRange(req.query);

    // 1. Partner State & City Lookup Map and Product Catalog (from shared cache)
    const [{ partnerMap, allPartnersList }, { categories }] = await Promise.all([
      getPartnersLookup(auth),
      getProductCatalog(auth)
    ]);

    const repId = asPositiveId(req.query.rep);
    const repName = await getDistinctRepNameById(auth, repId);
    const customerId = asPositiveId(req.query.customer);
    const productId = asPositiveId(req.query.product);
    const categoryId = resolveCategoryId(req.query.category, categories);

    let allowedPartnerIds = [];
    if (req.query.region || req.query.city) {
      allowedPartnerIds = allPartnersList
        .filter(p => {
          if (req.query.region && p.state !== req.query.region) return false;
          if (req.query.city && p.city !== req.query.city) return false;
          return true;
        })
        .map(p => p.id);
      if (!allowedPartnerIds.length) allowedPartnerIds = [-1];
    }

    // -------------------------------------------------------------
    // Customer Payments & Treasury/Bank Receipts (account.payment)
    // Specifically for "المبالغ المحصلة / إجمالي النقدية المحصلة"
    // In accounting, collected amounts exclusively come from account.payment
    // regardless of whether the filter is salesOrder or postedInvoice.
    // -------------------------------------------------------------
    if (kpi === 'collected') {
      const paymentDomain = [
        ['partner_type', '=', 'customer'],
        ['state', 'in', ['in_process', 'inprocess', 'paid', 'posted']],
        ['date', '>=', start],
        ['date', '<=', end]
      ];

      if (customerId) paymentDomain.push(['partner_id', '=', customerId]);
      if (allowedPartnerIds.length) paymentDomain.push(['partner_id', 'in', allowedPartnerIds]);
      if (repId) {
        const repPartnerIds = allPartnersList.filter(p => p.repId === repId).map(p => p.id);
        paymentDomain.push(['partner_id', 'in', repPartnerIds.length ? repPartnerIds : [-1]]);
      }
      if (req.query.query) {
        const q = String(req.query.query).trim();
        paymentDomain.push('|', ['name', 'ilike', q], ['partner_id.name', 'ilike', q]);
      }

      const validPaymentFields = await getAccountPaymentFields(auth);

      const [inboundSummaryGroups, outboundSummaryGroups, settledInboundGroups, settledOutboundGroups, payments] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
          [...paymentDomain, ['payment_type', '=', 'inbound']],
          ['amount:sum'],
          []
        ]).catch(err => {
          console.warn('account.payment inbound read_group error:', err.message);
          return [];
        }),
        odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
          [...paymentDomain, ['payment_type', '=', 'outbound']],
          ['amount:sum'],
          []
        ]).catch(err => {
          console.warn('account.payment outbound read_group error:', err.message);
          return [];
        }),
        odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
          [...paymentDomain, ['payment_type', '=', 'inbound'], ['state', 'in', ['paid', 'posted']]],
          ['amount:sum'],
          []
        ]).catch(err => {
          console.warn('account.payment settled inbound read_group error:', err.message);
          return null;
        }),
        odooExecuteKw(auth.uid, auth.password, 'account.payment', 'read_group', [
          [...paymentDomain, ['payment_type', '=', 'outbound'], ['state', 'in', ['paid', 'posted']]],
          ['amount:sum'],
          []
        ]).catch(err => {
          console.warn('account.payment settled outbound read_group error:', err.message);
          return null;
        }),
        odooExecuteKw(auth.uid, auth.password, 'account.payment', 'search_read', [
          paymentDomain
        ], {
          fields: validPaymentFields,
          limit: 15000,
          order: 'date desc, id desc'
        }).catch(err => {
          console.error('account.payment search_read error:', err.message);
          return [];
        })
      ]);

      const dbInboundCount = Number(inboundSummaryGroups[0]?.__count) || 0;
      const dbOutboundCount = Number(outboundSummaryGroups[0]?.__count) || 0;
      const dbTotalCount = dbInboundCount + dbOutboundCount;
      const dbInboundAmt = extractPaymentAmount(inboundSummaryGroups[0]);
      const dbOutboundAmt = extractPaymentAmount(outboundSummaryGroups[0]);
      const dbSettledInboundAmt = extractPaymentAmount(settledInboundGroups?.[0]);
      const dbSettledOutboundAmt = extractPaymentAmount(settledOutboundGroups?.[0]);
      const dbNetCollected = round2(dbInboundAmt - dbOutboundAmt);
      const dbNetSettled = round2(dbSettledInboundAmt - dbSettledOutboundAmt);
      const hasSettledSummary = Array.isArray(settledInboundGroups) && Array.isArray(settledOutboundGroups);

      const validPayments = (payments || []).filter(p => {
        const docDate = p.date ? String(p.date).split(' ')[0] : '';
        return Boolean(docDate && docDate >= start && docDate <= end);
      });

      const records = validPayments.map((p, idx) => {
        const pInfo = p.partner_id ? partnerMap.get(p.partner_id[0]) : null;
        const journalName = p.journal_id ? p.journal_id[1] : 'الخزينة / البنك';
        const rawAmt = Math.abs(Number(p.amount) || 0);
        const isOutbound = p.payment_type === 'outbound';
        const signedAmt = isOutbound ? -rawAmt : rawAmt;
        const isSettled = ['paid', 'posted'].includes(String(p.state || '').toLowerCase());
        const refNote = p.ref || p.memo || p.communication || p.payment_reference || '';
        const stateLabel = (p.state === 'in_process' || p.state === 'inprocess')
          ? 'قيد المعالجة (In Process)'
          : (p.state === 'paid' ? 'مسدد / محصل (Paid)' : (p.state === 'posted' ? 'معتمد (Posted)' : (p.state || 'معتمد')));

        const typeLabel = isOutbound ? `سند صرف / رد للعميل (${journalName})` : `سند قبض (${journalName})`;

        return {
          id: p.id,
          index: idx + 1,
          name: p.name || `PAY-${p.id}`,
          customer: p.partner_id ? p.partner_id[1] : (pInfo ? pInfo.name : 'عميل غير محدد'),
          rep: pInfo?.rep || 'غير محدد',
          region: pInfo ? pInfo.state : 'غير محدد',
          city: pInfo ? pInfo.city : 'غير محدد',
          date: p.date ? String(p.date).split(' ')[0] : '',
          ref: refNote,
          amount: signedAmt,
          paid: isSettled ? signedAmt : 0,
          residual: isSettled ? 0 : signedAmt,
          isRefund: isOutbound,
          typeLabel,
          paymentState: stateLabel,
          paymentStatusCode: p.state || 'paid',
          journal: journalName,
          odooLink: `${ODOO_URL}/web#id=${p.id}&model=account.payment&view_type=form`
        };
      });

      const totalInbound = round2(records.filter(r => !r.isRefund).reduce((sum, r) => sum + r.amount, 0));
      const totalOutbound = round2(records.filter(r => r.isRefund).reduce((sum, r) => sum + Math.abs(r.amount), 0));
      const netCollected = round2(totalInbound - totalOutbound);
      const settledNetFromRecords = round2(records.reduce((sum, r) => sum + r.paid, 0));

      const finalAmount = dbTotalCount > 0 ? dbNetCollected : netCollected;
      const finalPaid = dbTotalCount > 0 && hasSettledSummary ? dbNetSettled : settledNetFromRecords;
      const finalResidual = round2(finalAmount - finalPaid);
      const finalCount = dbTotalCount > 0 ? dbTotalCount : records.length;
      const finalInboundAmt = dbInboundAmt > 0 ? dbInboundAmt : totalInbound;
      const finalOutboundAmt = dbOutboundAmt > 0 ? dbOutboundAmt : totalOutbound;
      const finalInboundCount = dbInboundCount > 0 ? dbInboundCount : records.filter(r => !r.isRefund).length;
      const finalOutboundCount = dbOutboundCount > 0 ? dbOutboundCount : records.filter(r => r.isRefund).length;

      const drilldownResult = {
        kpi,
        source: 'payment',
        sourceName: 'سندات ومدفوعات العملاء المحصلة في Odoo (Customer Payments - In Process & Paid)',
        title: 'مدفوعات وسندات قبض العملاء المحصلة في Odoo (Customer Payments)',
        count: finalCount,
        totalAmount: finalAmount,
        totalPaid: finalPaid,
        totalInbound: finalInboundAmt,
        totalOutbound: finalOutboundAmt,
        inboundCount: finalInboundCount,
        outboundCount: finalOutboundCount,
        totalResidual: finalResidual,
        records
      };

      if (records.length > 0 || dbTotalCount === 0) {
        setCached(cacheKey, drilldownResult, 10 * 60 * 1000);
      }
      return res.json(drilldownResult);
    }

    if (source === 'salesOrder') {
      const isReturnKpi = kpi === 'returns' || kpi === 'returnsCount';
      if (isReturnKpi) {
        if (req.query.salesOrderStatus === 'draft') {
          const drilldownResult = {
            kpi,
            source: 'creditNote',
            sourceName: 'إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo',
            title: 'لا توجد مرتجعات لعروض الأسعار والمسودات (Quotations & Drafts)',
            count: 0,
            totalAmount: 0,
            totalPaid: 0,
            totalResidual: 0,
            records: []
          };
          return res.json(drilldownResult);
        }
        const status = String(req.query.salesOrderStatus || 'all').toLowerCase();
        const soCustom = await getSoCustomFields(auth).catch(() => ({ rep: null }));
        const soUtcRange = cairoUtcRange(start, end);
        const soDomain = [
          ['date_order', '>=', soUtcRange.from],
          ['date_order', '<=', soUtcRange.to]
        ];
        if (status === 'post') soDomain.push(['state', 'in', ['sale', 'done']]);
        else if (status === 'draft') soDomain.push(['state', 'in', ['draft', 'sent']]);
        else soDomain.push(['state', '!=', 'cancel']);
        if (repId) appendSalespersonFilter(soDomain, soCustom.rep, repId, repName);
        if (customerId) soDomain.push(['partner_id', '=', customerId]);
        else if (allowedPartnerIds.length) soDomain.push(['partner_id', 'in', allowedPartnerIds]);
        if (productId) soDomain.push(['order_line.product_id', '=', productId]);
        if (categoryId) soDomain.push(['order_line.product_id.categ_id', 'child_of', categoryId]);
        if (req.query.query) {
          const q = String(req.query.query).trim();
          const clauses = [['name', 'ilike', q], ['partner_id.name', 'ilike', q]];
          if (soCustom.rep?.name) clauses.push([`${soCustom.rep.name}.name`, 'ilike', q]);
          for (let i = 0; i < clauses.length - 1; i++) soDomain.push('|');
          clauses.forEach(clause => soDomain.push(clause));
        }

        const customRepField = soCustom.rep?.name;
        const selectedOrders = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [soDomain], {
          fields: ['id', 'invoice_ids', 'order_line', 'user_id', ...(customRepField ? [customRepField] : [])],
          limit: 5000,
          order: 'date_order desc, id desc'
        }).catch(() => []);
        const orderIdsByCreditNote = new Map();
        const ordersByInvoiceId = new Map();
        const addCreditNoteRep = (moveId, repName) => {
          const repNames = orderIdsByCreditNote.get(moveId) || new Set();
          repNames.add(repName);
          orderIdsByCreditNote.set(moveId, repNames);
        };
        (selectedOrders || []).forEach(order => {
          const customRep = customRepField ? fieldValue(order[customRepField]) : null;
          const repName = customRep?.name || 'غير محدد';
          (order.invoice_ids || []).forEach(moveId => {
            const linkedOrders = ordersByInvoiceId.get(moveId) || [];
            linkedOrders.push(repName);
            ordersByInvoiceId.set(moveId, linkedOrders);
          });
        });
        const selectedOrderLineIds = [...new Set((selectedOrders || []).flatMap(order => order.order_line || []))];
        const [linkedCreditLines, reversedCreditNotes] = await Promise.all([
          selectedOrderLineIds.length > 0 ? odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'search_read', [[
            ['sale_line_ids', 'in', selectedOrderLineIds.slice(0, 10000)],
            ['move_id.state', '=', 'posted'],
            ['move_id.move_type', '=', 'out_refund'],
            ['display_type', '=', 'product'],
            ...(productId ? [['product_id', '=', productId]] : []),
            ...(categoryId ? [['product_id.categ_id', 'child_of', categoryId]] : [])
          ]], { fields: ['id', 'move_id', 'sale_line_ids', 'quantity'], limit: 20000 }).catch(() => []) : [],
          ordersByInvoiceId.size > 0 ? odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[
            ['reversed_entry_id', 'in', [...ordersByInvoiceId.keys()].slice(0, 5000)],
            ['state', '=', 'posted'],
            ['move_type', '=', 'out_refund'],
            ...(productId ? [['invoice_line_ids.product_id', '=', productId]] : []),
            ...(categoryId ? [['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]] : [])
          ]], { fields: ['id', 'reversed_entry_id'], limit: 5000 }).catch(() => []) : []
        ]);
        const orderLines = selectedOrderLineIds.length > 0 ? await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [[
          ['id', 'in', selectedOrderLineIds.slice(0, 10000)]
        ]], { fields: ['id', 'order_id'], limit: 10000 }).catch(() => []) : [];
        const repByOrderId = new Map((selectedOrders || []).map(order => {
          const customRep = customRepField ? fieldValue(order[customRepField]) : null;
          const repName = customRep?.name || 'غير محدد';
          return [order.id, repName];
        }));
        const repByOrderLineId = new Map((orderLines || []).map(line => [line.id, repByOrderId.get(line.order_id?.[0]) || 'غير محدد']));
        const returnQtyByMoveId = new Map();
        (linkedCreditLines || []).forEach(line => {
          const moveId = line.move_id?.[0];
          returnQtyByMoveId.set(moveId, (returnQtyByMoveId.get(moveId) || 0) + Math.abs(Number(line.quantity) || 0));
          (line.sale_line_ids || []).forEach(lineId => addCreditNoteRep(moveId, repByOrderLineId.get(lineId) || 'غير محدد'));
        });
        (reversedCreditNotes || []).forEach(refund => {
          (ordersByInvoiceId.get(refund.reversed_entry_id?.[0]) || []).forEach(repName => addCreditNoteRep(refund.id, repName));
        });
        const linkedMoveIds = [...orderIdsByCreditNote.keys()];
        const validMoves = linkedMoveIds.length > 0 ? await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[
          ['id', 'in', linkedMoveIds.slice(0, 5000)],
          ['state', '=', 'posted'],
          ['move_type', '=', 'out_refund'],
          ...(productId ? [['invoice_line_ids.product_id', '=', productId]] : []),
          ...(categoryId ? [['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]] : [])
        ]], {
          fields: [
            'id', 'name', 'partner_id', 'invoice_user_id', 'invoice_date', 'date',
            'amount_untaxed', 'amount_total', 'amount_total_signed', 'amount_residual',
            'payment_state', 'state', 'move_type', 'ref'
          ],
          limit: 5000,
          order: 'invoice_date desc, id desc'
        }).catch(() => []) : [];

        const records = validMoves.map((m, idx) => {
          const pInfo = m.partner_id ? partnerMap.get(m.partner_id[0]) : null;
          const rawTotal = Math.abs(Number(m.amount_total_signed !== undefined && m.amount_total_signed !== null ? m.amount_total_signed : m.amount_total) || 0);
          const rawResidual = Math.abs(Number(m.amount_residual !== undefined && m.amount_residual !== null ? m.amount_residual : 0) || 0);
          const paid = Math.max(0, rawTotal - rawResidual);

          return {
            id: m.id,
            index: idx + 1,
            name: m.name || `CN-${m.id}`,
            customer: m.partner_id ? m.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
            rep: [...(orderIdsByCreditNote.get(m.id) || [])].join('، ') || 'غير محدد',
            region: pInfo ? pInfo.state : 'غير محدد',
            city: pInfo ? pInfo.city : 'غير محدد',
            date: m.invoice_date || (m.date ? String(m.date).split(' ')[0] : ''),
            amount: round2(rawTotal),
            returnedQty: round2(returnQtyByMoveId.get(m.id) || 0),
            paid: round2(paid),
            residual: round2(rawResidual),
            paymentState: 'إشعار دائن (مرتجع)',
            paymentStatusCode: 'refund',
            isRefund: true,
            typeLabel: 'إشعار دائن مرتجع',
            ref: m.ref || '',
            odooLink: `${ODOO_URL}/web#id=${m.id}&model=account.move&view_type=form`
          };
        });

        const recAmt = round2(records.reduce((sum, r) => sum + r.amount, 0));
        const recPaid = round2(records.reduce((sum, r) => sum + r.paid, 0));
        const recResidual = round2(records.reduce((sum, r) => sum + r.residual, 0));

        const drilldownResult = {
          kpi,
          source: 'creditNote',
          sourceName: 'إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo',
          title: 'إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo (Credit Notes - Out Refund)',
          count: records.length,
          totalAmount: recAmt,
          totalPaid: recPaid,
          totalResidual: recResidual,
          records
        };
        if (records.length > 0) {
          setCached(cacheKey, drilldownResult, 10 * 60 * 1000);
        }
        return res.json(drilldownResult);
      }

      const status = String(req.query.salesOrderStatus || 'all').toLowerCase();
      const soCustom = await getSoCustomFields(auth).catch(() => ({ rep: null, region: null, city: null }));
      const soUtcRange = cairoUtcRange(start, end);
      const soDomain = [
        ['date_order', '>=', soUtcRange.from],
        ['date_order', '<=', soUtcRange.to]
      ];
      if (status === 'post') soDomain.push(['state', 'in', ['sale', 'done']]);
      else if (status === 'draft') soDomain.push(['state', 'in', ['draft', 'sent']]);
      else soDomain.push(['state', '!=', 'cancel']);
      if (repId) appendSalespersonFilter(soDomain, soCustom.rep, repId, repName);
      if (customerId) soDomain.push(['partner_id', '=', customerId]);
      if (allowedPartnerIds.length) soDomain.push(['partner_id', 'in', allowedPartnerIds]);

      if (productId || categoryId) {
        const productDomain = productId ? [['product_id', '=', productId]] : [['product_id.categ_id', 'child_of', categoryId]];
        const matchingLines = await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [
          [['display_type', '=', false], ...productDomain]
        ], { fields: ['order_id'], limit: 5000 }).catch(() => []);
        const matchingOrderIds = [...new Set(matchingLines.map(l => l.order_id?.[0]).filter(Boolean))];
        if (matchingOrderIds.length) {
          soDomain.push(['id', 'in', matchingOrderIds]);
        } else {
          soDomain.push(['id', '=', -1]);
        }
      }

      if (req.query.query) {
        const q = String(req.query.query).trim();
        const clauses = [['name', 'ilike', q], ['partner_id.name', 'ilike', q]];
        if (soCustom.rep?.name) clauses.push([`${soCustom.rep.name}.name`, 'ilike', q]);
        for (let i = 0; i < clauses.length - 1; i++) soDomain.push('|');
        clauses.forEach(clause => soDomain.push(clause));
      }

      const paymentDomain = [
        ['partner_type', '=', 'customer'],
        ['state', 'in', ['in_process', 'inprocess', 'paid', 'posted']],
        ['date', '>=', start],
        ['date', '<=', end]
      ];
      if (customerId) paymentDomain.push(['partner_id', '=', customerId]);
      else if (allowedPartnerIds.length) paymentDomain.push(['partner_id', 'in', allowedPartnerIds]);
      if (repId) {
        const repPartnerIds = allPartnersList.filter(p => p.repId === repId).map(p => p.id);
        paymentDomain.push(['partner_id', 'in', repPartnerIds.length ? repPartnerIds : [-1]]);
      }

      const soExtraFields = [soCustom.rep?.name, soCustom.region?.name].filter(Boolean);

      const orders = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [
        soDomain
      ], {
        fields: ['id', 'name', 'partner_id', 'user_id', 'date_order', 'amount_total', 'amount_untaxed', 'state', 'invoice_ids', ...soExtraFields],
        limit: 3000,
        order: 'date_order desc, id desc'
      });

      const validOrders = (orders || []).filter(o => {
        const docDate = o.date_order ? cairoDateOf(o.date_order) : '';
        return Boolean(docDate && docDate >= start && docDate <= end);
      });

      // Fetch linked posted invoices for all valid orders
      const allInvoiceIds = [...new Set(validOrders.flatMap(o => o.invoice_ids || []))];
      const invoiceMap = new Map();
      if (allInvoiceIds.length > 0) {
        const moves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
          [['id', 'in', allInvoiceIds], ['state', '=', 'posted'], ['move_type', '=', 'out_invoice']]
        ], {
          fields: ['id', 'amount_total', 'amount_total_signed', 'amount_residual', 'payment_state'],
          limit: 3000
        }).catch(() => []);

        (moves || []).forEach(m => {
          const invTotal = Math.abs(Number(m.amount_total_signed !== undefined && m.amount_total_signed !== null ? m.amount_total_signed : m.amount_total) || 0);
          const invResidual = Math.abs(Number(m.amount_residual !== undefined && m.amount_residual !== null ? m.amount_residual : 0) || 0);
          invoiceMap.set(m.id, {
            id: m.id,
            total: invTotal,
            residual: invResidual,
            paid: Math.max(0, invTotal - invResidual)
          });
        });
      }

      const orderPaymentMap = new Map();
      validOrders.forEach(o => {
        const isDraft = o.state === 'draft' || o.state === 'sent';
        const orderTotal = round2(o.amount_total || 0);

        if (isDraft) {
          orderPaymentMap.set(o.id, { paid: 0, residual: orderTotal, status: 'not_paid' });
          return;
        }

        const linkedInvoices = (o.invoice_ids || []).map(id => invoiceMap.get(id)).filter(Boolean);

        if (linkedInvoices.length === 0) {
          // Confirmed order not invoiced yet -> residual is entire order amount
          orderPaymentMap.set(o.id, { paid: 0, residual: orderTotal, status: 'not_paid' });
        } else {
          const invTotal = linkedInvoices.reduce((sum, inv) => sum + inv.total, 0);
          const invResidual = linkedInvoices.reduce((sum, inv) => sum + inv.residual, 0);
          const invPaid = Math.max(0, invTotal - invResidual);
          const uninvoicedPortion = Math.max(0, orderTotal - invTotal);

          const paid = round2(Math.min(orderTotal, invPaid));
          const residual = round2(Math.max(0, invResidual + uninvoicedPortion));
          const status = residual === 0 ? 'paid' : (paid > 0 ? 'partial' : 'not_paid');

          orderPaymentMap.set(o.id, { paid, residual, status });
        }
      });

      let records = validOrders.map((o, idx) => {
        const pInfo = o.partner_id ? partnerMap.get(o.partner_id[0]) : null;
        const stateLabels = {
          sale: 'أمر بيع معتمد',
          done: 'أمر بيع مكتمل',
          draft: 'مسودة',
          sent: 'عرض سعر مرسل',
          cancel: 'ملغي'
        };
        const isDraft = o.state === 'draft' || o.state === 'sent';
        const payInfo = orderPaymentMap.get(o.id) || { paid: 0, residual: round2(o.amount_total || 0), status: isDraft ? 'not_paid' : 'paid' };

        let paymentStatusCode = payInfo.status || 'paid';
        let paymentState = stateLabels[o.state] || 'معتمد';
        if (isDraft) {
          paymentStatusCode = 'not_paid';
          paymentState = 'عرض سعر';
        } else if (payInfo.residual > 0 && payInfo.paid > 0) {
          paymentStatusCode = 'partial';
          paymentState = 'سداد جزئي';
        } else if (payInfo.residual > 0) {
          paymentStatusCode = 'not_paid';
          paymentState = 'غير محصل';
        } else {
          paymentStatusCode = 'paid';
          paymentState = 'محصل بالكامل';
        }

        return {
          id: o.id,
          index: idx + 1,
          name: o.name,
          customer: o.partner_id ? o.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
          rep: soCustom.rep ? fieldValue(o[soCustom.rep.name]).name : 'غير محدد',
          region: soCustom.region ? fieldValue(o[soCustom.region.name]).name : (pInfo ? pInfo.state : 'غير محدد'),
          city: soCustom.region ? fieldValue(o[soCustom.region.name]).name : (pInfo ? pInfo.city : 'غير محدد'),
          date: o.date_order ? cairoDateOf(o.date_order) : '',
          amount: round2(o.amount_total || 0),
          paid: payInfo.paid,
          residual: payInfo.residual,
          paymentState,
          paymentStatusCode,
          isRefund: false,
          typeLabel: isDraft ? 'عرض سعر' : 'أمر بيع',
          odooLink: `${ODOO_URL}/web#id=${o.id}&model=sale.order&view_type=form`
        };
      });

      if (kpi === 'outstanding') {
        records = records.filter(r => r.residual > 0);
      }

      records.forEach((r, idx) => { r.index = idx + 1; });

      const soTitleMap = {
        gross: 'إجمالي أوامر البيع',
        invoices: 'عدد أوامر البيع',
        net: 'صافي أوامر البيع',
        outstanding: 'أوامر البيع غير المحصلة',
        avgInvoice: 'أوامر البيع واحتساب متوسط أمر البيع'
      };

      const finalAmount = kpi === 'outstanding'
        ? round2(records.reduce((sum, r) => sum + r.residual, 0))
        : round2(records.reduce((sum, r) => sum + r.amount, 0));
      const finalCount = records.length;
      const totalResidual = round2(records.reduce((sum, r) => sum + r.residual, 0));
      const totalPaid = round2(records.reduce((sum, r) => sum + r.paid, 0));
      const computedAvg = finalCount > 0 ? round2(finalAmount / finalCount) : 0;

      const drilldownResult = {
        kpi,
        source,
        title: soTitleMap[kpi] || 'أوامر البيع',
        count: finalCount,
        totalAmount: finalAmount,
        totalPaid,
        totalResidual,
        avgInvoice: computedAvg,
        records
      };
      if (records.length > 0) {
        setCached(cacheKey, drilldownResult, 10 * 60 * 1000);
      }
      return res.json(drilldownResult);
    }

    // Invoices and Refunds (account.move)
    const moveCustom = await getMoveCustomFields(auth).catch(() => ({ rep: null }));
    const moveDomain = [
      ['state', '=', 'posted'],
      ['invoice_date', '>=', start],
      ['invoice_date', '<=', end]
    ];

    let title = 'فواتير المبيعات المعتمدة';
    if (kpi === 'gross') {
      moveDomain.push(['move_type', '=', 'out_invoice']);
      title = 'فواتير المبيعات المعتمدة (Posted Invoices)';
    } else if (kpi === 'invoices') {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
      title = 'إجمالي فواتير البيع والمرتجعات المرحّلة (عدد الحركات المعتمدة - Posted)';
    } else if (kpi === 'returns' || kpi === 'returnsCount') {
      moveDomain.push(['move_type', '=', 'out_refund']);
      title = 'إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo (Credit Notes - Out Refund)';
    } else if (kpi === 'avgInvoice') {
      moveDomain.push(['move_type', '=', 'out_invoice']);
      title = 'فواتير المبيعات المعتمدة واحتساب متوسط الفاتورة';
    } else if (kpi === 'net') {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
      title = 'صافي مبيعات الفواتير والمرتجعات';
    } else if (kpi === 'outstanding') {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']], ['amount_residual', '>', 0]);
      title = 'الفواتير ذات الأرصدة والمديونية القائمة (Unpaid Residual)';
    } else {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
    }

    if (repId) appendSalespersonFilter(moveDomain, moveCustom.rep, repId, repName);
    if (customerId) moveDomain.push(['partner_id', '=', customerId]);
    if (productId) moveDomain.push(['invoice_line_ids.product_id', '=', productId]);
    if (categoryId) moveDomain.push(['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]);
    if (allowedPartnerIds.length) moveDomain.push(['partner_id', 'in', allowedPartnerIds]);
    if (req.query.query) {
      const q = String(req.query.query).trim();
      const clauses = [['name', 'ilike', q], ['partner_id.name', 'ilike', q]];
      if (moveCustom.rep?.name) clauses.push([`${moveCustom.rep.name}.name`, 'ilike', q]);
      for (let i = 0; i < clauses.length - 1; i++) moveDomain.push('|');
      clauses.forEach(clause => moveDomain.push(clause));
    }

    const moves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
      moveDomain
    ], {
      fields: [
        'id', 'name', 'partner_id', 'invoice_user_id', 'invoice_date', 'date',
        'amount_untaxed', 'amount_total', 'amount_total_signed', 'amount_residual',
        'payment_state', 'state', 'move_type', 'ref', ...(moveCustom.rep?.name ? [moveCustom.rep.name] : [])
      ],
      limit: 3000,
      order: 'invoice_date desc, id desc'
    });

    const paymentStateLabels = {
      paid: 'مدفوع بالكامل',
      in_payment: 'قيد السداد',
      not_paid: 'غير مدفوع',
      partial: 'سداد جزئي',
      reversed: 'مردود / معكوس'
    };

    const validMoves = (moves || []).filter(m => {
      const docDate = m.invoice_date || (m.date ? String(m.date).split(' ')[0] : '');
      return Boolean(docDate && docDate >= start && docDate <= end);
    });

    const records = validMoves.map((m, idx) => {
      const pInfo = m.partner_id ? partnerMap.get(m.partner_id[0]) : null;
      const isRefund = m.move_type === 'out_refund';
      const rawTotal = Math.abs(Number(m.amount_total_signed !== undefined && m.amount_total_signed !== null ? m.amount_total_signed : m.amount_total) || 0);
      const rawResidual = Math.abs(Number(m.amount_residual !== undefined && m.amount_residual !== null ? m.amount_residual : 0) || 0);
      
      const isPaidOrInPayment = ['paid', 'in_payment', 'inpayment', 'reversed'].includes(m.payment_state) || rawResidual === 0;
      const paid = isPaidOrInPayment ? rawTotal : Math.max(0, rawTotal - rawResidual);
      const residual = Math.max(0, rawTotal - paid);

      const statusLabel = isRefund
        ? (paymentStateLabels[m.payment_state] || (isPaidOrInPayment ? 'مردود / مسوى (Paid)' : 'رصيد دائن قائم للعميل'))
        : (paymentStateLabels[m.payment_state] || m.payment_state || 'غير محدد');

      const customRep = moveCustom.rep?.name ? fieldValue(m[moveCustom.rep.name]) : null;

      return {
        id: m.id,
        index: idx + 1,
        name: m.name || `DOC-${m.id}`,
        customer: m.partner_id ? m.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
        rep: customRep?.name || 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        city: pInfo ? pInfo.city : 'غير محدد',
        date: m.invoice_date || m.date || '',
        ref: m.ref || '',
        amount: round2(rawTotal),
        paid: round2(paid),
        residual: round2(residual),
        isRefund,
        typeLabel: isRefund ? 'إشعار خصم (مرتجع)' : 'فاتورة مبيعات',
        paymentState: statusLabel,
        paymentStatusCode: m.payment_state || 'unknown',
        odooLink: `${ODOO_URL}/web#id=${m.id}&model=account.move&view_type=form`
      };
    });

    let recordsFiltered = records;
    if (kpi === 'outstanding') {
      recordsFiltered = records.filter(r => r.residual > 0);
    }
    recordsFiltered.forEach((r, idx) => { r.index = idx + 1; });

    let finalAmount = 0;
    let finalPaid = 0;
    let finalResidual = 0;

    if (kpi === 'returns' || kpi === 'returnsCount') {
      finalAmount = round2(recordsFiltered.reduce((sum, r) => sum + r.amount, 0));
      finalPaid = round2(recordsFiltered.reduce((sum, r) => sum + r.paid, 0));
      finalResidual = round2(Math.max(0, finalAmount - finalPaid));
    } else if (kpi === 'gross' || kpi === 'invoices' || kpi === 'avgInvoice') {
      finalAmount = round2(recordsFiltered.filter(r => !r.isRefund).reduce((sum, r) => sum + r.amount, 0));
      finalPaid = round2(recordsFiltered.filter(r => !r.isRefund).reduce((sum, r) => sum + r.paid, 0));
      finalResidual = round2(recordsFiltered.filter(r => !r.isRefund).reduce((sum, r) => sum + r.residual, 0));
    } else if (kpi === 'net') {
      finalAmount = round2(recordsFiltered.reduce((sum, r) => sum + (r.isRefund ? -r.amount : r.amount), 0));
      finalPaid = round2(recordsFiltered.reduce((sum, r) => sum + (r.isRefund ? -r.paid : r.paid), 0));
      finalResidual = round2(recordsFiltered.reduce((sum, r) => sum + (r.isRefund ? -r.residual : r.residual), 0));
    } else if (kpi === 'outstanding') {
      finalAmount = round2(recordsFiltered.reduce((sum, r) => sum + r.residual, 0));
      finalResidual = finalAmount;
      finalPaid = 0;
    } else {
      finalAmount = round2(recordsFiltered.reduce((sum, r) => sum + (r.isRefund ? -r.amount : r.amount), 0));
      finalPaid = round2(recordsFiltered.reduce((sum, r) => sum + r.paid, 0));
      finalResidual = round2(recordsFiltered.reduce((sum, r) => sum + r.residual, 0));
    }

    const finalCount = recordsFiltered.length;
    const computedAvg = finalCount > 0 ? round2(finalAmount / finalCount) : 0;

    const drilldownResult = {
      kpi,
      source,
      title,
      count: finalCount,
      totalAmount: finalAmount,
      totalPaid: finalPaid,
      totalResidual: finalResidual,
      avgInvoice: computedAvg,
      records: recordsFiltered
    };
    if (records.length > 0) {
      setCached(cacheKey, drilldownResult, 10 * 60 * 1000);
    }
    res.json(drilldownResult);
  } catch (err) {
    console.error('Error in kpi-drilldown:', err.message);
    const friendlyError = sanitizeErrorMessage(err);
    res.status(500).json({ error: friendlyError, code: 'DRILLDOWN_ERROR' });
  }
});

// Always listen if not running in Vercel Serverless environment
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;
