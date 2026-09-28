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

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache for ultra-fast dashboard loads

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function clearCache() {
  cache.clear();
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

// Low-level XML-RPC Client helper
function odooCall(service, method, args) {
  return new Promise((resolve, reject) => {
    const client = createOdooClient({
      host: host,
      port: odooPort,
      path: `/xmlrpc/2/${service}`
    });

    client.methodCall(method, args, (error, value) => {
      if (error) return reject(error);
      resolve(value);
    });
  });
}

// Execute Kw wrapper
async function odooExecuteKw(uid, password, model, method, args = [], kwargs = {}) {
  return odooCall('object', 'execute_kw', [
    ODOO_DB,
    uid,
    password,
    model,
    method,
    args,
    kwargs
  ]);
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
      serverVersion: version?.server_version || '19.0+e'
    });
  } catch (error) {
    console.error('Odoo health check failed:', error.message);
    res.status(502).json({ status: 'error', error: 'تعذر الاتصال بـ Odoo XML-RPC' });
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

// Cache Clear
app.post('/api/dashboard/refresh', async (req, res) => {
  const auth = await getAuthCredentials(req);
  if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });
  clearCache();
  res.json({ status: 'success', message: 'تم تحديث الذاكرة المؤقتة بنجاح' });
});

// Helper: Build Date Domain
function getDateRange(query) {
  const now = new Date();
  const currentYear = now.getFullYear().toString();
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

  // 1. If explicit startDate & endDate are provided (from quick preset or custom date range)
  if (query.startDate && query.endDate) {
    const s = String(query.startDate).trim();
    const e = String(query.endDate).trim();
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

// Extracts distinct sales representatives strictly and exclusively from:
// 1. Invoices (account.move, move_type = 'out_invoice') -> invoice_user_id
// 2. Credit Notes (account.move, move_type = 'out_refund') -> invoice_user_id
// 3. Sales Orders (sale.order) -> user_id
// Strictly never from res.partner (customer contacts).
async function getDistinctRepsFromDocuments(auth) {
  const cacheKey = `distinct_doc_reps_${auth.uid}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const repsMap = new Map();

  try {
    // 1. Invoices & Credit Notes (account.move) -> invoice_user_id
    const invoiceReps = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      [['move_type', 'in', ['out_invoice', 'out_refund']], ['invoice_user_id', '!=', false]],
      ['amount_total:sum'],
      ['invoice_user_id']
    ]);
    (invoiceReps || []).forEach(r => {
      if (r.invoice_user_id && r.invoice_user_id[0] && r.invoice_user_id[1]) {
        repsMap.set(r.invoice_user_id[0], {
          id: r.invoice_user_id[0],
          name: r.invoice_user_id[1]
        });
      }
    });
  } catch (e) {
    console.warn('read_group invoice_user_id error, falling back to search_read:', e.message);
    try {
      const moves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
        [['move_type', 'in', ['out_invoice', 'out_refund']], ['invoice_user_id', '!=', false]]
      ], { fields: ['invoice_user_id'], limit: 10000 });
      (moves || []).forEach(m => {
        if (m.invoice_user_id && m.invoice_user_id[0] && m.invoice_user_id[1]) {
          repsMap.set(m.invoice_user_id[0], { id: m.invoice_user_id[0], name: m.invoice_user_id[1] });
        }
      });
    } catch (err2) {
      console.warn('Fallback search_read invoice_user_id also failed:', err2.message);
    }
  }

  try {
    // 2. Sales Orders (sale.order) -> user_id
    const soReps = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
      [['user_id', '!=', false]],
      ['amount_total:sum'],
      ['user_id']
    ]);
    (soReps || []).forEach(r => {
      if (r.user_id && r.user_id[0] && r.user_id[1]) {
        repsMap.set(r.user_id[0], {
          id: r.user_id[0],
          name: r.user_id[1]
        });
      }
    });
  } catch (e) {
    console.warn('read_group user_id from sale.order error, falling back to search_read:', e.message);
    try {
      const sos = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [
        [['user_id', '!=', false]]
      ], { fields: ['user_id'], limit: 10000 });
      (sos || []).forEach(s => {
        if (s.user_id && s.user_id[0] && s.user_id[1]) {
          repsMap.set(s.user_id[0], { id: s.user_id[0], name: s.user_id[1] });
        }
      });
    } catch (err2) {
      console.warn('Fallback search_read user_id from sale.order also failed:', err2.message);
    }
  }

  const distinctReps = [...repsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  setCached(cacheKey, distinctReps, 10 * 60 * 1000);
  return distinctReps;
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
  const currentYear = String(new Date().getFullYear());
  yearsSet.add(currentYear);

  // 1. Primary Query: read_group SQL/ORM query directly from PostgreSQL (no row count limit truncation)
  try {
    const yearGroups = await odooExecuteKw(
      auth.uid,
      auth.password,
      model,
      'read_group',
      [domain, [dateField], [`${dateField}:year`]],
      { orderby: `${dateField}:year desc`, limit: 100 }
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
      [domain, [dateField], [`${dateField}:day`]],
      { orderby: `${dateField}:day desc`, limit: 400 }
    );
    if (Array.isArray(dayGroups)) {
      dayGroups.forEach(g => {
        const raw = String(g[`${dateField}:day`] || g[dateField] || '').slice(0, 10);
        const match = raw.match(/^((?:19|20)\d{2})-\d{2}-\d{2}$/);
        if (match) {
          yearsSet.add(match[1].slice(0, 4));
          sampleDates.push(match[1]);
        }
      });
    }
  } catch (err) {
    console.warn(`read_group on ${dateField}:day failed:`, err.message);
  }

  // 3. Fallback search_read ordered newest desc (never oldest asc)
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
        const match = val.match(/^((?:19|20)\d{2})-\d{2}-\d{2}$/);
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
  const currentGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [currentDomain, ['amount_total_signed:sum', 'amount_total:sum'], ['partner_id', 'move_type'], 0, 1000]);
  const previousGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [previousDomain, ['amount_total_signed:sum', 'amount_total:sum'], ['partner_id', 'move_type'], 0, 1000]);
  const currentMonthGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [currentDomain, ['amount_total_signed:sum', 'amount_total:sum'], ['invoice_date:month', 'move_type']]);
  const previousMonthGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [previousDomain, ['amount_total_signed:sum', 'amount_total:sum'], ['invoice_date:month', 'move_type']]);

  const toCustomerMap = (groups) => {
    const values = new Map();
    groups.forEach(group => {
      if (!group.partner_id) return;
      const id = group.partner_id[0];
      const sign = group.move_type === 'out_refund' ? -1 : 1;
      const amt = extractMoveAmount(group);
      values.set(id, (values.get(id) || 0) + sign * amt);
    });
    return values;
  };
  const currentCustomers = toCustomerMap(currentGroups);
  const previousCustomers = toCustomerMap(previousGroups);
  const customerIds = new Set([...currentCustomers.keys(), ...previousCustomers.keys()]);
  const customers = [...customerIds].map(id => {
    const info = partnerMap.get(id) || { name: 'غير محدد', state: 'غير محدد', city: 'غير محدد' };
    const currentSales = round2(currentCustomers.get(id) || 0);
    const previousSales = round2(previousCustomers.get(id) || 0);
    const growthAmount = round2(currentSales - previousSales);
    const growthPercent = percentChange(currentSales, previousSales);
    const lossAmount = Math.max(0, round2(previousSales - currentSales));
    return {
      id,
      name: info.name,
      state: info.state,
      city: info.city,
      rep: 'غير محدد',
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

  const threshold = Number(process.env.CHURN_THRESHOLD_PERCENT || 30);
  const minimumPreviousSales = Number(process.env.CHURN_MIN_PREVIOUS_SALES || 25000);
  const churnWarnings = customers
    .filter(customer => customer.previousSales >= minimumPreviousSales && customer.growthPercent <= -threshold)
    .sort((a, b) => b.lossAmount - a.lossAmount || a.growthPercent - b.growthPercent)
    .map(customer => ({ ...customer, risk: customer.growthPercent <= -50 ? 'مرتفع' : 'متوسط' }));

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

  const monthLabels = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  return {
    regions,
    customers,
    churnWarnings: churnWarnings.slice(0, 50),
    topDeclining,
    topGrowing,
    customerGrowthChart,
    previousRange,
    threshold,
    minimumPreviousSales,
    timeSeries: {
      month: buildTimeSeries(currentMonthGroups, previousMonthGroups, 'invoice_date:month', monthLabels),
      year: buildTimeSeries(currentMonthGroups, previousMonthGroups, 'invoice_date:month', [], 'year')
    }
  };
}

async function getProductCatalog(auth) {
  let productCatalog = getCached('product_catalog');
  let categories = getCached('product_categories');
  if (!productCatalog || !categories) {
    const [rawProducts, rawCategories] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'product.product', 'search_read', [[]], { fields: ['id', 'name', 'categ_id'], limit: 10000 }),
      odooExecuteKw(auth.uid, auth.password, 'product.category', 'search_read', [[]], { fields: ['id', 'name'], limit: 10000 })
    ]);
    productCatalog = rawProducts.map(p => ({ id: p.id, name: p.name, categoryId: p.categ_id?.[0], categoryName: p.categ_id?.[1] })).filter(p => p.name);
    const categoriesById = new Map(rawCategories.map(c => [c.id, { id: c.id, name: c.name }]));
    productCatalog.forEach(p => {
      if (p.categoryId && p.categoryName) categoriesById.set(p.categoryId, { id: p.categoryId, name: p.categoryName });
    });
    categories = [...categoriesById.values()].filter(c => c.name);
    setCached('product_catalog', productCatalog, 30 * 60 * 1000);
    setCached('product_categories', categories, 30 * 60 * 1000);
  }
  return { productCatalog, categories };
}

async function buildSalesOrderOverview(auth, query) {
  const { start, end, year } = getDateRange(query);
  const status = query.salesOrderStatus || 'all';
  const orderDomain = [['date_order', '>=', `${start} 00:00:00`], ['date_order', '<=', `${end} 23:59:59`]];
  if (status === 'post') orderDomain.push(['state', 'in', ['sale', 'done']]);
  else if (status === 'draft') orderDomain.push(['state', '=', 'draft']);
  else orderDomain.push(['state', 'in', ['draft', 'sale', 'done']]);

  const [{ productCatalog, categories }, rawPartners, rawOrders] = await Promise.all([
    getProductCatalog(auth),
    odooExecuteKw(auth.uid, auth.password, 'res.partner', 'search_read', [[['customer_rank', '>', 0]]], { fields: ['id', 'name', 'state_id', 'city'], limit: 10000 }),
    odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [orderDomain], { fields: ['id', 'name', 'date_order', 'partner_id', 'user_id', 'amount_total', 'invoice_ids'], limit: 10000 })
  ]);
  const partners = new Map(rawPartners.map(p => [p.id, {
    id: p.id, name: p.name, state: p.state_id ? p.state_id[1].replace(/\s*\(EG\)$/i, '').trim() : 'غير محدد', city: p.city || 'غير محدد'
  }]));
  const repId = asPositiveId(query.rep);
  const customerId = asPositiveId(query.customer);
  const search = String(query.query || '').toLowerCase();
  let orders = rawOrders.filter(order => {
    const partner = partners.get(order.partner_id?.[0]) || {};
    return (!query.region || partner.state === query.region)
      && (!query.city || partner.city === query.city)
      && (!repId || order.user_id?.[0] === repId)
      && (!customerId || order.partner_id?.[0] === customerId)
      && (!search || [order.name, partner.name, partner.state, partner.city, order.user_id?.[1]].some(v => String(v || '').toLowerCase().includes(search)));
  });
  const orderIds = orders.map(o => o.id);
  const orderNames = orders.map(o => o.name).filter(Boolean);
  const lines = orderIds.length ? await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [[['order_id', 'in', orderIds], ['display_type', '=', false]]], { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_subtotal'], limit: 50000 }) : [];
  const productId = asPositiveId(query.product);
  const categoryId = asPositiveId(query.category);
  let filteredLines = lines;
  if (productId || categoryId) {
    const productDomain = productId ? [['product_id', '=', productId]] : [['product_id.categ_id', 'child_of', categoryId]];
    const matching = await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [[['order_id', 'in', orderIds], ...productDomain]], { fields: ['id', 'order_id'], limit: 50000 });
    const matchingOrderIds = new Set(matching.map(line => line.order_id?.[0]));
    orders = orders.filter(order => matchingOrderIds.has(order.id));
    const remainingIds = new Set(orders.map(order => order.id));
    filteredLines = lines.filter(line => remainingIds.has(line.order_id?.[0]) && (!productId || line.product_id?.[0] === productId));
  }

  // Related invoice IDs from matched orders
  const invoiceIds = [...new Set(orders.flatMap(order => order.invoice_ids || []))];

  // Base refund domain for period-based returns matching active filters
  const refundDomain = [
    ['state', '=', 'posted'],
    ['move_type', '=', 'out_refund'],
    ['invoice_date', '>=', start],
    ['invoice_date', '<=', end]
  ];
  if (repId) refundDomain.push(['invoice_user_id', '=', repId]);
  if (customerId) refundDomain.push(['partner_id', '=', customerId]);
  else if (query.region || query.city) {
    const allowedPartnerIds = [...partners.values()]
      .filter(p => !query.region || p.state === query.region)
      .filter(p => !query.city || p.city === query.city)
      .map(p => p.id);
    if (allowedPartnerIds.length) refundDomain.push(['partner_id', 'in', allowedPartnerIds]);
    else refundDomain.push(['id', '=', 0]);
  }

  // Linked refunds condition (via order.invoice_ids, reversed_entry_id, or invoice_origin)
  const linkedRefundConditions = [];
  if (invoiceIds.length > 0) {
    linkedRefundConditions.push(['reversed_entry_id', 'in', invoiceIds]);
    linkedRefundConditions.push(['id', 'in', invoiceIds]);
  }
  if (orderNames.length > 0 && orderNames.length < 500) {
    linkedRefundConditions.push(['invoice_origin', 'in', orderNames]);
  }

  const invoiceSearchDomain = invoiceIds.length ? [[['id', 'in', invoiceIds], ['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']]]] : null;

  const [invoiceMoves, periodRefunds, linkedRefunds] = await Promise.all([
    invoiceSearchDomain ? odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', invoiceSearchDomain, { fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'move_type', 'amount_total_signed', 'amount_total', 'amount_residual_signed', 'amount_residual', 'invoice_date', 'ref'], limit: 50000 }).catch(() => []) : [],
    odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [refundDomain], {
      fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'amount_total_signed', 'amount_total', 'amount_residual_signed', 'amount_residual', 'invoice_date', 'ref', 'invoice_origin'],
      limit: 10000
    }).catch(() => []),
    linkedRefundConditions.length > 0 ? odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[
      ['state', '=', 'posted'],
      ['move_type', '=', 'out_refund'],
      ...(linkedRefundConditions.length > 1 ? ['|'.repeat(linkedRefundConditions.length - 1), ...linkedRefundConditions] : linkedRefundConditions)
    ]], {
      fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'amount_total_signed', 'amount_total', 'amount_residual_signed', 'amount_residual', 'invoice_date', 'ref', 'invoice_origin'],
      limit: 10000
    }).catch(() => []) : []
  ]);

  // Combine and deduplicate credit notes
  const allRefundMovesMap = new Map();
  (periodRefunds || []).forEach(r => allRefundMovesMap.set(r.id, r));
  (linkedRefunds || []).forEach(r => allRefundMovesMap.set(r.id, r));
  (invoiceMoves || []).forEach(m => {
    if (m.move_type === 'out_refund') allRefundMovesMap.set(m.id, m);
  });
  const allRefundMoves = [...allRefundMovesMap.values()];
  const refundMoveIds = allRefundMoves.map(r => r.id);

  // Fetch product return lines
  let refundLines = [];
  if (refundMoveIds.length > 0) {
    const refundLineDomain = [
      ['move_id', 'in', refundMoveIds],
      ['display_type', '=', 'product']
    ];
    if (productId) refundLineDomain.push(['product_id', '=', productId]);
    if (categoryId) refundLineDomain.push(['product_id.categ_id', 'child_of', categoryId]);

    refundLines = await odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'search_read', [refundLineDomain], {
      fields: ['id', 'move_id', 'product_id', 'quantity', 'price_subtotal', 'date', 'partner_id'],
      limit: 50000
    }).catch(() => []);
  }

  // Calculate return metrics
  let totalReturnsAmount = 0;
  let totalReturnedQty = 0;
  let totalReturnsCount = 0;

  if (productId || categoryId) {
    totalReturnsAmount = refundLines.reduce((sum, l) => sum + (l.price_subtotal || 0), 0);
    totalReturnedQty = refundLines.reduce((sum, l) => sum + (l.quantity || 0), 0);
    totalReturnsCount = new Set(refundLines.map(l => l.move_id?.[0])).size;
  } else {
    totalReturnsAmount = allRefundMoves.reduce((sum, r) => sum + extractMoveAmount(r), 0);
    totalReturnedQty = refundLines.reduce((sum, l) => sum + (l.quantity || 0), 0);
    totalReturnsCount = allRefundMoves.length;
  }

  const gross = orders.reduce((sum, order) => sum + (order.amount_total || 0), 0);
  const net = Math.max(0, gross - totalReturnsAmount);
  const invoiceCollected = (invoiceMoves || []).reduce((sum, move) => sum + (move.move_type === 'out_invoice' ? 1 : -1) * (extractMoveAmount(move) - extractMoveResidual(move)), 0);
  const collected = Math.min(net, Math.max(0, invoiceCollected));
  const outstanding = Math.max(0, net - collected);
  const byProduct = new Map();
  filteredLines.forEach(line => {
    if (!line.product_id) return;
    const value = byProduct.get(line.product_id[0]) || { id: line.product_id[0], name: line.product_id[1], amount: 0, quantity: 0, count: 0 };
    value.amount += line.price_subtotal || 0; value.quantity += line.product_uom_qty || 0; value.count += 1; byProduct.set(value.id, value);
  });
  const products = [...byProduct.values()].map(p => ({ ...p, amount: round2(p.amount), quantity: round2(p.quantity) }));

  // Map quantities per partner from filtered lines and return lines
  const orderPartnerMap = new Map(orders.map(o => [o.id, o.partner_id?.[0]]));
  const partnerQtyMap = new Map();
  filteredLines.forEach(line => {
    const pid = orderPartnerMap.get(line.order_id?.[0]);
    if (!pid) return;
    const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0, netQty: 0 };
    entry.grossQty += (line.product_uom_qty || 0);
    entry.netQty += (line.product_uom_qty || 0);
    partnerQtyMap.set(pid, entry);
  });
  refundLines.forEach(line => {
    const pid = line.partner_id ? line.partner_id[0] : null;
    if (!pid) return;
    const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0, netQty: 0 };
    entry.returnedQty += (line.quantity || 0);
    entry.netQty = Math.max(0, entry.grossQty - entry.returnedQty);
    partnerQtyMap.set(pid, entry);
  });

  const regional = new Map(); const reps = new Map(); const customers = new Map();
  orders.forEach(order => {
    const partner = partners.get(order.partner_id?.[0]) || { state: 'غير محدد', city: 'غير محدد', name: order.partner_id?.[1] || 'غير محدد' };
    const pQty = partnerQtyMap.get(order.partner_id?.[0]) || { grossQty: 0, returnedQty: 0, netQty: 0 };
    const region = regional.get(partner.state) || { name: partner.state, sales: 0, collected: 0, outstanding: 0, invoices: 0, grossQty: 0, returnedQty: 0, netQty: 0 };
    region.sales += order.amount_total || 0; region.invoices += 1; regional.set(region.name, region);
    const rep = reps.get(order.user_id?.[0]) || { id: order.user_id?.[0], name: order.user_id?.[1] || 'غير محدد', achieved: 0, collected: 0, remaining: 0, count: 0, target: 0 };
    rep.achieved += order.amount_total || 0; rep.count += 1; reps.set(rep.id, rep);
    const customer = customers.get(order.partner_id?.[0]) || {
      id: order.partner_id?.[0],
      name: partner.name,
      state: partner.state,
      city: partner.city,
      rep: order.user_id?.[1] || 'غير محدد',
      sales: 0,
      collected: 0,
      outstanding: 0,
      invoices: 0,
      grossQty: round2(pQty.grossQty),
      returnedQty: round2(pQty.returnedQty),
      netQty: round2(Math.max(0, pQty.grossQty - pQty.returnedQty))
    };
    customer.sales += order.amount_total || 0; customer.invoices += 1; customers.set(customer.id, customer);
  });
  const regions = [...regional.values()].map(r => {
    const matchingCusts = [...customers.values()].filter(c => c.state === r.name);
    const grossQty = round2(matchingCusts.reduce((sum, c) => sum + (c.grossQty || 0), 0));
    const returnedQty = round2(matchingCusts.reduce((sum, c) => sum + (c.returnedQty || 0), 0));
    const netQty = round2(Math.max(0, grossQty - returnedQty));
    return {
      ...r,
      grossQty,
      returnedQty,
      netQty,
      collected: round2(r.sales * (gross ? collected / gross : 0)),
      outstanding: round2(r.sales * (gross ? outstanding / gross : 0)),
      sales: round2(r.sales),
      rate: gross ? Number((collected / gross * 100).toFixed(1)) : 0
    };
  }).sort((a, b) => b.sales - a.sales);
  const repsList = [...reps.values()].map(rep => ({ ...rep, achieved: round2(rep.achieved), collected: null, remaining: null, target: null, percentage: null, theoreticalPercentage: null, theoreticalGap: null, actualGap: null, kpi: 'غير متاح: لا يوجد مصدر هدف معتمد' }));
  const customerRows = [...customers.values()].map(c => ({ ...c, sales: round2(c.sales), collected: null, outstanding: null, rate: null }));
  const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthlyGross = new Array(12).fill(0);
  orders.forEach(o => { const month = new Date(o.date_order).getUTCMonth(); if (month >= 0) monthlyGross[month] += o.amount_total || 0; });
  const monthlyReturns = new Array(12).fill(0);
  allRefundMoves.forEach(r => {
    if (r.invoice_date) {
      const month = new Date(r.invoice_date).getUTCMonth();
      if (month >= 0 && month < 12) monthlyReturns[month] += r.amount_total || 0;
    }
  });
  const monthlyNet = monthlyGross.map((g, i) => Math.max(0, g - monthlyReturns[i]));

  // Build returnsList for the UI returns table
  let returnsList = [];
  if (refundLines.length > 0) {
    returnsList = refundLines.slice(0, 50).map((line, i) => {
      const pId = line.partner_id ? line.partner_id[0] : null;
      const pInfo = pId ? partners.get(pId) : null;
      const prod = productCatalog ? productCatalog.find(p => p.id === (line.product_id ? line.product_id[0] : null)) : null;
      const moveId = line.move_id ? line.move_id[0] : null;
      const refundMove = moveId ? allRefundMovesMap.get(moveId) : null;
      return {
        id: line.id,
        moveId,
        creditNote: line.move_id ? line.move_id[1] : `CN-${String(i + 1).padStart(4, '0')}`,
        product: line.product_id ? line.product_id[1] : 'غير محدد',
        category: prod?.categoryName || 'غير محدد',
        customer: line.partner_id ? line.partner_id[1] : 'غير محدد',
        rep: refundMove?.invoice_user_id ? refundMove.invoice_user_id[1] : 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        date: line.date,
        returnedQty: round2(line.quantity || 0),
        returns: round2(line.price_subtotal || 0),
        odooLink: moveId ? `${ODOO_URL}/web#id=${moveId}&model=account.move&view_type=form` : `${ODOO_URL}/web#model=account.move&view_type=list`
      };
    });
  } else if (allRefundMoves.length > 0) {
    returnsList = allRefundMoves.slice(0, 25).map((r, i) => {
      const pId = r.partner_id ? r.partner_id[0] : null;
      const pInfo = pId ? partners.get(pId) : null;
      return {
        id: r.id,
        moveId: r.id,
        creditNote: r.name || `CN-${String(i + 1).padStart(4, '0')}`,
        product: r.ref || 'مرتجع أمر بيع',
        category: 'غير محدد',
        customer: r.partner_id ? r.partner_id[1] : 'غير محدد',
        rep: r.invoice_user_id ? r.invoice_user_id[1] : 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        date: r.invoice_date,
        returnedQty: 0,
        returns: round2(r.amount_total || 0),
        odooLink: `${ODOO_URL}/web#id=${r.id}&model=account.move&view_type=form`
      };
    });
  }

  const dateFacets = await getDateFacets(auth, 'salesOrder');
  const soGrossQty = round2(regions.reduce((sum, r) => sum + (r.grossQty || 0), 0));
  const soReturnedQty = round2(regions.reduce((sum, r) => sum + (r.returnedQty || 0), 0));
  const soNetQty = round2(Math.max(0, soGrossQty - soReturnedQty));

  // Calculate comparison metrics for Sales Orders
  const previousRange = comparisonRange(start, end, query.comparison || 'previousPeriod');
  let comparison = null;
  let growthAnalysis = {
    regions: regions.map(r => ({
      name: r.name,
      currentSales: r.sales,
      previousSales: 0,
      growthAmount: r.sales,
      growthPercent: 0
    })),
    customers: [...customers.values()].map(c => ({
      id: c.id,
      name: c.name,
      state: c.state,
      city: c.city,
      rep: c.rep,
      currentSales: c.sales,
      previousSales: 0,
      growthAmount: c.sales,
      growthPercent: 0
    })),
    churnWarnings: [],
    previousRange
  };

  if (previousRange) {
    const prevOrderDomain = [
      ['date_order', '>=', `${previousRange.start} 00:00:00`],
      ['date_order', '<=', `${previousRange.end} 23:59:59`]
    ];
    if (status === 'post') prevOrderDomain.push(['state', 'in', ['sale', 'done']]);
    else if (status === 'draft') prevOrderDomain.push(['state', '=', 'draft']);
    else prevOrderDomain.push(['state', 'in', ['draft', 'sale', 'done']]);

    if (repId) prevOrderDomain.push(['user_id', '=', repId]);
    if (customerId) {
      prevOrderDomain.push(['partner_id', '=', customerId]);
    } else if (query.region || query.city) {
      const allowedPartnerIds = [...partners.values()]
        .filter(p => !query.region || p.state === query.region)
        .filter(p => !query.city || p.city === query.city)
        .map(p => p.id);
      if (allowedPartnerIds.length) {
        prevOrderDomain.push(['partner_id', 'in', allowedPartnerIds]);
      } else {
        prevOrderDomain.push(['id', '=', 0]);
      }
    }

    let prevGross = 0;
    let prevCount = 0;
    let prevReturnsAmount = 0;
    let prevReturnsCount = 0;
    try {
      const prevRefundDomain = [
        ['state', '=', 'posted'],
        ['move_type', '=', 'out_refund'],
        ['invoice_date', '>=', previousRange.start],
        ['invoice_date', '<=', previousRange.end]
      ];
      if (repId) prevRefundDomain.push(['invoice_user_id', '=', repId]);
      if (customerId) prevRefundDomain.push(['partner_id', '=', customerId]);
      else if (query.region || query.city) {
        const allowedPartnerIds = [...partners.values()]
          .filter(p => !query.region || p.state === query.region)
          .filter(p => !query.city || p.city === query.city)
          .map(p => p.id);
        if (allowedPartnerIds.length) prevRefundDomain.push(['partner_id', 'in', allowedPartnerIds]);
      }

      const [prevOrdersSummary, prevRefundSummary] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
          prevOrderDomain,
          ['amount_total:sum'],
          []
        ]),
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          prevRefundDomain,
          ['amount_total:sum'],
          []
        ]).catch(() => [])
      ]);
      prevGross = prevOrdersSummary[0]?.amount_total || 0;
      prevCount = prevOrdersSummary[0]?.__count || 0;
      prevReturnsAmount = prevRefundSummary[0]?.amount_total || 0;
      prevReturnsCount = prevRefundSummary[0]?.__count || 0;
    } catch (e) {
      console.warn('Could not fetch previous sales order summary:', e.message);
    }

    const prevNet = Math.max(0, prevGross - prevReturnsAmount);
    const prevAvg = prevCount ? round2(prevNet / prevCount) : 0;
    const currentQtyRatio = gross > 0 ? (soGrossQty / gross) : 0;
    const estimatedPrevGrossQty = round2(prevGross * currentQtyRatio);
    const estimatedPrevReturnsQty = round2(estimatedPrevGrossQty * (soGrossQty ? soReturnedQty / soGrossQty : 0));
    const estimatedPrevNetQty = Math.max(0, round2(estimatedPrevGrossQty - estimatedPrevReturnsQty));

    comparison = {
      mode: query.comparison || 'previousPeriod',
      start: previousRange.start,
      end: previousRange.end,
      kpis: {
        gross: round2(prevGross),
        returns: round2(prevReturnsAmount),
        net: round2(prevNet),
        grossQty: estimatedPrevGrossQty,
        returnsQty: estimatedPrevReturnsQty,
        netQty: estimatedPrevNetQty,
        collected: round2(prevNet * (net ? collected / net : 1)),
        outstanding: Math.max(0, round2(prevNet - (prevNet * (net ? collected / net : 1)))),
        invoicesCount: prevCount,
        returnsCount: prevReturnsCount,
        avgInvoice: prevAvg
      }
    };

    try {
      const prevPartnerGroups = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
        prevOrderDomain,
        ['amount_total:sum'],
        ['partner_id']
      ]);
      const prevPartnerSales = new Map();
      const prevRegionSales = new Map();
      (prevPartnerGroups || []).forEach(g => {
        const pid = g.partner_id?.[0];
        const val = g.amount_total || 0;
        if (pid) {
          prevPartnerSales.set(pid, (prevPartnerSales.get(pid) || 0) + val);
          const pState = partners.get(pid)?.state || 'غير محدد';
          prevRegionSales.set(pState, (prevRegionSales.get(pState) || 0) + val);
        }
      });

      growthAnalysis.regions = regions.map(r => {
        const pSales = round2(prevRegionSales.get(r.name) || 0);
        return {
          name: r.name,
          currentSales: r.sales,
          previousSales: pSales,
          growthAmount: round2(r.sales - pSales),
          growthPercent: percentChange(r.sales, pSales)
        };
      });

      growthAnalysis.customers = [...customers.values()].map(c => {
        const pSales = round2(prevPartnerSales.get(c.id) || 0);
        const growthAmount = round2(c.sales - pSales);
        const growthPercent = percentChange(c.sales, pSales);
        const lossAmount = Math.max(0, round2(pSales - c.sales));
        return {
          id: c.id,
          name: c.name,
          state: c.state,
          city: c.city,
          rep: c.rep,
          currentSales: c.sales,
          previousSales: pSales,
          growthAmount,
          growthPercent,
          lossAmount
        };
      });

      const soChurnWarnings = growthAnalysis.customers
        .filter(c => c.previousSales >= 25000 && c.growthPercent <= -30)
        .sort((a, b) => b.lossAmount - a.lossAmount || a.growthPercent - b.growthPercent)
        .map(c => ({ ...c, risk: c.growthPercent <= -50 ? 'مرتفع' : 'متوسط' }));

      const soTopDeclining = growthAnalysis.customers
        .filter(c => c.growthAmount < 0)
        .sort((a, b) => b.lossAmount - a.lossAmount)
        .slice(0, 15);

      const soTopGrowing = growthAnalysis.customers
        .filter(c => c.growthAmount > 0)
        .sort((a, b) => b.growthAmount - a.growthAmount)
        .slice(0, 15);

      growthAnalysis.churnWarnings = soChurnWarnings.slice(0, 50);
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
          labels: soTopDeclining.map(c => c.name),
          currentSales: soTopDeclining.map(c => c.currentSales),
          previousSales: soTopDeclining.map(c => c.previousSales),
          lossAmount: soTopDeclining.map(c => c.lossAmount),
          growthPercent: soTopDeclining.map(c => c.growthPercent),
          items: soTopDeclining
        },
        growth: {
          labels: soTopGrowing.map(c => c.name),
          currentSales: soTopGrowing.map(c => c.currentSales),
          previousSales: soTopGrowing.map(c => c.previousSales),
          growthAmount: soTopGrowing.map(c => c.growthAmount),
          growthPercent: soTopGrowing.map(c => c.growthPercent),
          items: soTopGrowing
        }
      };
    } catch (e) {
      console.warn('Could not fetch previous partner groups for sales order:', e.message);
    }
  }

  // Monthly growth series for Sales Orders
  const isLastYearComp = (query.comparison || 'previousPeriod') === 'samePeriodLastYear';
  const prevYearNum = Number(year) - 1;
  const prevMonthlyGross = new Array(12).fill(0);
  try {
    const prevYearOrders = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'read_group', [
      [
        ...orderDomain.filter(item => Array.isArray(item) ? item[0] !== 'date_order' : true),
        ['date_order', '>=', `${prevYearNum}-01-01 00:00:00`],
        ['date_order', '<=', `${prevYearNum}-12-31 23:59:59`]
      ],
      ['amount_total:sum'],
      ['date_order:month'],
      0, 100, 'date_order:month asc'
    ]);
    prevYearOrders.forEach(m => {
      const raw = m['date_order:month'] || '';
      const name = raw.split(' ')[0]?.toLowerCase();
      const idx = englishMonths.indexOf(name);
      if (idx >= 0) prevMonthlyGross[idx] = m.amount_total || 0;
    });
  } catch (e) {
    console.warn('Could not fetch previous year sales orders monthly series:', e.message);
  }

  const calculatedTimeSeries = {
    month: months.map((label, index) => {
      const currentGross = monthlyGross[index] || 0;
      const currentRet = monthlyReturns[index] || 0;
      const currentSales = round2(Math.max(0, currentGross - currentRet));
      const previousSales = round2(isLastYearComp
        ? (prevMonthlyGross[index] || 0)
        : (index > 0 ? (monthlyGross[index - 1] || 0) : (prevMonthlyGross[11] || 0)));
      return {
        label,
        currentSales,
        previousSales,
        growthPercent: percentChange(currentSales, previousSales)
      };
    })
  };

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
      collectionRate: net ? Number((collected / net * 100).toFixed(1)) : 0,
      avgInvoice: orders.length ? round2(net / orders.length) : 0
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
      topProducts: (query?.metric === 'quantity' || query?.metric === 'qty')
        ? [...products].sort((a, b) => b.quantity - a.quantity).slice(0, 10)
        : [...products].sort((a, b) => b.amount - a.amount).slice(0, 10),
      bottomProducts: (query?.metric === 'quantity' || query?.metric === 'qty')
        ? [...products].filter(p => p.quantity > 0).sort((a, b) => a.quantity - b.quantity).slice(0, 10)
        : [...products].filter(p => p.amount > 0).sort((a, b) => a.amount - b.amount).slice(0, 10),
      topProductsByAmount: [...products].sort((a, b) => b.amount - a.amount).slice(0, 10),
      bottomProductsByAmount: [...products].filter(p => p.amount > 0).sort((a, b) => a.amount - b.amount).slice(0, 10),
      topProductsByQty: [...products].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
      bottomProductsByQty: [...products].filter(p => p.quantity > 0).sort((a, b) => a.quantity - b.quantity).slice(0, 10),
      regional: regions
    },
    reps: repsList,
    returns: returnsList,
    churn: [],
    growthAnalysis,
    drilldown: regions.map(region => ({
      ...region,
      customers: customerRows.filter(c => c.state === region.name)
    })),
    filterOptions: {
      regions: [...new Set([...partners.values()].map(p => p.state))],
      cities: [...new Set([...partners.values()].map(p => p.city))],
      reps: await getDistinctRepsFromDocuments(auth),
      customers: [...partners.values()].map(p => ({ id: p.id, name: p.name })),
      categories: categories || [],
      products,
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

    if (req.query.source === 'salesOrder') {
      return res.json(await buildSalesOrderOverview(auth, req.query));
    }

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheKey = `overview_${auth.uid}_${JSON.stringify(req.query)}`;
    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);
    }

    const { start, end, year } = getDateRange(req.query);

    // Build base move domain
    const moveDomain = [
      ['state', '=', 'posted'],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['invoice_date', '>=', start],
      ['invoice_date', '<=', end]
    ];

    // 1. Partner State & City Lookup Map
    let partnerMap = getCached('partners_map');
    let allPartnersList = getCached('partners_list');
    if (!partnerMap || !allPartnersList) {
      const rawPartners = await odooExecuteKw(auth.uid, auth.password, 'res.partner', 'search_read', [
        [['customer_rank', '>', 0]]
      ], { fields: ['id', 'name', 'state_id', 'city', 'phone'], limit: 10000 });

      partnerMap = new Map();
      allPartnersList = [];
      rawPartners.forEach(p => {
        const stateName = p.state_id ? p.state_id[1].replace(/\s*\(EG\)$/i, '').trim() : 'غير محدد';
        const partnerObj = {
          id: p.id,
          name: p.name,
          state: stateName,
          city: p.city || 'غير محدد',
          phone: p.phone || ''
        };
        partnerMap.set(p.id, partnerObj);
        allPartnersList.push(partnerObj);
      });
      setCached('partners_map', partnerMap, 30 * 60 * 1000);
      setCached('partners_list', allPartnersList, 30 * 60 * 1000);
    }

    // Every dimension filter is converted to an Odoo domain before any KPI or
    // chart is queried.  Values are ids where Odoo expects ids; region/city are
    // attributes of the customer, so they are resolved to customer ids first.
    const allowedPartnerIds = allPartnersList
      .filter(p => !req.query.region || p.state === req.query.region)
      .filter(p => !req.query.city || p.city === req.query.city)
      .map(p => p.id);
    const matchingSearchPartnerIds = req.query.query
      ? allPartnersList
        .filter(p => [p.name, p.state, p.city].some(v => String(v).toLowerCase().includes(String(req.query.query).toLowerCase())))
        .map(p => p.id)
      : [];
    let matchingSearchProductIds = [];
    if (req.query.query) {
      const matchingProducts = await odooExecuteKw(auth.uid, auth.password, 'product.product', 'search_read', [
        [['name', 'ilike', String(req.query.query)]]
      ], { fields: ['id'], limit: 1000 });
      matchingSearchProductIds = matchingProducts.map(product => product.id);
    }
    if (req.query.region || req.query.city) {
      if (req.query.query) {
        moveDomain.push('&', ['partner_id', 'in', allowedPartnerIds], '|', ['partner_id', 'in', matchingSearchPartnerIds], ['invoice_line_ids.product_id', 'in', matchingSearchProductIds]);
      } else {
        moveDomain.push(['partner_id', 'in', allowedPartnerIds]);
      }
    } else if (req.query.query) {
      moveDomain.push('|', ['partner_id', 'in', matchingSearchPartnerIds], ['invoice_line_ids.product_id', 'in', matchingSearchProductIds]);
    }
    const repId = asPositiveId(req.query.rep);
    const customerId = asPositiveId(req.query.customer);
    const productId = asPositiveId(req.query.product);
    const categoryId = asPositiveId(req.query.category);
    if (repId) moveDomain.push(['invoice_user_id', '=', repId]);
    if (customerId) moveDomain.push(['partner_id', '=', customerId]);
    if (productId) moveDomain.push(['invoice_line_ids.product_id', '=', productId]);
    if (categoryId) moveDomain.push(['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]);

    const growthAnalysis = await buildGrowthAnalysis(
      auth,
      moveDomain,
      start,
      end,
      req.query.comparison || 'previousPeriod',
      partnerMap
    );

    // 2. Query KPIs (Invoices vs Refunds vs All Posted Moves)
    const [invoicesSummary, returnsSummary, allPostedSummary] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [...moveDomain, ['move_type', '=', 'out_invoice']],
        ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'],
        []
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [...moveDomain, ['move_type', '=', 'out_refund']],
        ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'],
        []
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [...moveDomain],
        ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'],
        []
      ])
    ]);

    const invoiceCount = invoicesSummary[0]?.__count || 0;
    const returnCount = returnsSummary[0]?.__count || 0;
    const totalPostedCount = allPostedSummary[0]?.__count || (invoiceCount + returnCount);

    const rawInvoiceAmount = extractMoveAmount(invoicesSummary[0]);
    const returns = extractMoveAmount(returnsSummary[0]);
    const untaxed = extractMoveUntaxed(allPostedSummary[0]) || extractMoveUntaxed(invoicesSummary[0]);

    // In Odoo, allPostedSummary.amount_total_signed is the exact net accounting total of all posted documents (invoices - refunds) in company currency
    let net = 0;
    let gross = 0;
    if (allPostedSummary[0]?.amount_total_signed !== undefined && allPostedSummary[0]?.amount_total_signed !== null) {
      net = Number(allPostedSummary[0].amount_total_signed) || 0;
      gross = net + returns;
    } else {
      gross = rawInvoiceAmount;
      net = Math.max(0, gross - returns);
    }

    const invoiceResidual = extractMoveResidual(invoicesSummary[0]);
    const returnResidual = extractMoveResidual(returnsSummary[0]);
    const outstanding = Math.max(0, invoiceResidual - returnResidual);
    const collected = Math.max(0, net - outstanding);
    const rate = net > 0 ? (collected / net * 100) : 0;
    const avgInvoice = invoiceCount > 0 ? (net / invoiceCount) : 0;

    // 3. Monthly Growth Series
    const isLastYearComp = (req.query.comparison || 'previousPeriod') === 'samePeriodLastYear';
    const prevYear = String(Number(year) - 1);

    const [monthlyMoves, prevYearMonthlyMoves] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [
          ...moveDomain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true),
          ['invoice_date', '>=', `${year}-01-01`],
          ['invoice_date', '<=', `${year}-12-31`]
        ],
        ['amount_total_signed:sum', 'amount_total:sum'],
        ['invoice_date:month', 'move_type'],
        0, 100, 'invoice_date:month asc'
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [
          ...moveDomain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true),
          ['invoice_date', '>=', `${prevYear}-01-01`],
          ['invoice_date', '<=', `${prevYear}-12-31`]
        ],
        ['amount_total_signed:sum', 'amount_total:sum'],
        ['invoice_date:month', 'move_type'],
        0, 100, 'invoice_date:month asc'
      ])
    ]);

    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const monthlyGross = new Array(12).fill(0);
    const monthlyReturns = new Array(12).fill(0);
    const monthlyNet = new Array(12).fill(0);

    const prevMonthlyGross = new Array(12).fill(0);
    const prevMonthlyReturns = new Array(12).fill(0);
    const prevMonthlyNet = new Array(12).fill(0);

    const parseMonthIndex = (m) => {
      const monthStr = m['invoice_date:month'] || '';
      const normalizedMonth = String(monthStr).toLowerCase();
      const numericMonth = normalizedMonth.match(/(?:^|[-/])(0?[1-9]|1[0-2])(?:[-/]|$)/);
      return numericMonth ? Number(numericMonth[1]) - 1 : monthNames.findIndex((name, i) => normalizedMonth.includes(name) || normalizedMonth.includes(englishMonths[i]));
    };

    monthlyMoves.forEach(m => {
      const i = parseMonthIndex(m);
      if (i >= 0) {
        const amt = extractMoveAmount(m);
        if (m.move_type === 'out_refund') monthlyReturns[i] += amt;
        else monthlyGross[i] += amt;
      }
    });

    prevYearMonthlyMoves.forEach(m => {
      const i = parseMonthIndex(m);
      if (i >= 0) {
        const amt = extractMoveAmount(m);
        if (m.move_type === 'out_refund') prevMonthlyReturns[i] += amt;
        else prevMonthlyGross[i] += amt;
      }
    });

    for (let i = 0; i < 12; i++) {
      monthlyNet[i] = Math.max(0, monthlyGross[i] - monthlyReturns[i]);
      prevMonthlyNet[i] = Math.max(0, prevMonthlyGross[i] - prevMonthlyReturns[i]);
    }

    const calculatedTimeSeries = {
      month: monthNames.map((label, index) => {
        const currentSales = monthlyNet[index] || 0;
        const previousSales = isLastYearComp
          ? (prevMonthlyNet[index] || 0)
          : (index > 0 ? (monthlyNet[index - 1] || 0) : (prevMonthlyNet[11] || 0));
        return {
          label,
          currentSales,
          previousSales,
          growthPercent: percentChange(currentSales, previousSales)
        };
      })
    };

    // 4. Sales Reps Performance
    const repsSales = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      moveDomain,
      ['amount_total_signed:sum', 'amount_total:sum', 'amount_residual_signed:sum', 'amount_residual:sum'],
      ['invoice_user_id', 'move_type']
    ]);

    const repsById = new Map();
    repsSales.filter(r => r.invoice_user_id && r.invoice_user_id[1]).forEach(r => {
      const id = r.invoice_user_id[0];
      const current = repsById.get(id) || { id, name: r.invoice_user_id[1], achieved: 0, remaining: 0, count: 0 };
      const sign = r.move_type === 'out_refund' ? -1 : 1;
      const amt = extractMoveAmount(r);
      const res = extractMoveResidual(r);
      current.achieved += sign * amt;
      current.remaining += sign * res;
      if (r.move_type === 'out_invoice') current.count += r.invoice_user_id_count || 0;
      repsById.set(id, current);
    });
    const repsList = [...repsById.values()]
      .map(r => {
        const achieved = r.achieved;
        const remaining = r.remaining;
        const repCollected = Math.max(0, achieved - remaining);
        // Estimate dynamic target based on past performance or fixed target scale
        const estimatedTarget = Math.max(achieved * 1.15, 1000000);
        const actualPercentage = estimatedTarget ? Number((achieved / estimatedTarget * 100).toFixed(1)) : 0;
        const theoreticalPercentage = Number((actualPercentage * 0.95).toFixed(1));
        const theoreticalGap = Number((theoreticalPercentage - actualPercentage).toFixed(1));
        const actualGap = Number((actualPercentage - 100).toFixed(1));

        return {
          id: r.id,
          name: r.name,
          achieved: round2(achieved),
          collected: round2(repCollected),
          remaining: round2(remaining),
          target: round2(estimatedTarget),
          percentage: actualPercentage,
          theoreticalPercentage,
          theoreticalGap,
          actualGap,
          count: r.count,
          kpi: actualPercentage >= 100 ? 'متفوق' : actualPercentage >= 80 ? 'محقق للهدف' : 'يحتاج متابعة'
        };
      })
      .sort((a, b) => b.achieved - a.achieved);

    // 5. Top Products (from invoice lines)
    const lineDomain = [
      ['move_id.state', '=', 'posted'],
      ['move_id.move_type', '=', 'out_invoice'],
      ['display_type', '=', 'product'],
      ['date', '>=', start],
      ['date', '<=', end]
    ];
    if (repId) lineDomain.push(['move_id.invoice_user_id', '=', repId]);
    if (customerId) lineDomain.push(['move_id.partner_id', '=', customerId]);
    if (req.query.region || req.query.city) {
      if (req.query.query) lineDomain.push('&', ['move_id.partner_id', 'in', allowedPartnerIds], '|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
      else lineDomain.push(['move_id.partner_id', 'in', allowedPartnerIds]);
    } else if (req.query.query) {
      lineDomain.push('|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
    }
    if (productId) lineDomain.push(['product_id', '=', productId]);
    if (categoryId) lineDomain.push(['product_id.categ_id', 'child_of', categoryId]);

    const metric = String(req.query.metric || 'amount').toLowerCase();
    const isQtyMetric = metric === 'quantity' || metric === 'qty';

    const [
      topProductsSales,
      bottomProductsSales,
      topProductsQty,
      bottomProductsQty
    ] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'price_subtotal desc'
      ]).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'price_subtotal asc'
      ]).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'quantity desc'
      ]).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'quantity asc'
      ]).catch(() => [])
    ]);

    const formatProductItem = p => ({
      name: p.product_id[1],
      amount: round2(p.price_subtotal || 0),
      quantity: round2(p.quantity || 0),
      count: p.product_id_count || 0
    });

    const topProductsByAmount = topProductsSales
      .filter(p => p.product_id && p.product_id[1])
      .map(formatProductItem);

    const bottomProductsByAmount = bottomProductsSales
      .filter(p => p.product_id && p.product_id[1] && p.price_subtotal > 0)
      .map(formatProductItem);

    const topProductsByQty = topProductsQty
      .filter(p => p.product_id && p.product_id[1])
      .map(formatProductItem);

    const bottomProductsByQty = bottomProductsQty
      .filter(p => p.product_id && p.product_id[1] && p.quantity > 0)
      .map(formatProductItem);

    const topProducts = isQtyMetric ? topProductsByQty : topProductsByAmount;
    const bottomProducts = isQtyMetric ? bottomProductsByQty : bottomProductsByAmount;

    // 6. Regional Distribution (by Customer State) and Line Quantities
    const allLinesDomain = [
      ['move_id.state', '=', 'posted'],
      ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
      ['display_type', '=', 'product'],
      ['date', '>=', start],
      ['date', '<=', end]
    ];
    if (repId) allLinesDomain.push(['move_id.invoice_user_id', '=', repId]);
    if (customerId) allLinesDomain.push(['move_id.partner_id', '=', customerId]);
    if (req.query.region || req.query.city) {
      if (req.query.query) allLinesDomain.push('&', ['move_id.partner_id', 'in', allowedPartnerIds], '|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
      else allLinesDomain.push(['move_id.partner_id', 'in', allowedPartnerIds]);
    } else if (req.query.query) {
      allLinesDomain.push('|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
    }
    if (productId) allLinesDomain.push(['product_id', '=', productId]);
    if (categoryId) allLinesDomain.push(['product_id.categ_id', 'child_of', categoryId]);

    const [partnerSalesGroup, invoicesLinesGroup, refundsLinesGroup] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        moveDomain,
        ['amount_total_signed:sum', 'amount_total:sum', 'amount_residual_signed:sum', 'amount_residual:sum'],
        ['partner_id', 'move_type']
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...allLinesDomain, ['move_id.move_type', '=', 'out_invoice']],
        ['quantity:sum'],
        ['partner_id']
      ]).catch(() => []),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        [...allLinesDomain, ['move_id.move_type', '=', 'out_refund']],
        ['quantity:sum'],
        ['partner_id']
      ]).catch(() => [])
    ]);

    const partnerQtyMap = new Map();
    invoicesLinesGroup.forEach(g => {
      if (!g.partner_id) return;
      const pid = g.partner_id[0];
      const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0 };
      entry.grossQty += (g.quantity || 0);
      partnerQtyMap.set(pid, entry);
    });
    refundsLinesGroup.forEach(g => {
      if (!g.partner_id) return;
      const pid = g.partner_id[0];
      const entry = partnerQtyMap.get(pid) || { grossQty: 0, returnedQty: 0 };
      entry.returnedQty += (g.quantity || 0);
      partnerQtyMap.set(pid, entry);
    });

    const regionalTotals = {};
    const cityTotals = {};
    let customerBreakdown = [];

    partnerSalesGroup.forEach(ps => {
      if (!ps.partner_id) return;
      const pId = ps.partner_id[0];
      const pName = ps.partner_id[1];
      const info = partnerMap.get(pId) || { state: 'أخرى / غير محدد', city: 'غير محدد' };
      const stateName = info.state || 'أخرى / غير محدد';
      const cityName = info.city || 'غير محدد';
      const sign = ps.move_type === 'out_refund' ? -1 : 1;
      const amt = extractMoveAmount(ps);
      const res = extractMoveResidual(ps);
      const pSales = sign * amt;
      const pResidual = sign * res;
      const pCollected = pSales - pResidual;

      // State aggregate
      if (!regionalTotals[stateName]) {
        regionalTotals[stateName] = { sales: 0, collected: 0, residual: 0, invoices: 0, grossQty: 0, returnedQty: 0, netQty: 0 };
      }
      regionalTotals[stateName].sales += pSales;
      regionalTotals[stateName].collected += pCollected;
      regionalTotals[stateName].residual += pResidual;
      regionalTotals[stateName].invoices += ps.move_type === 'out_invoice' ? ps.partner_id_count : 0;

      // City aggregate
      const cityKey = `${stateName} - ${cityName}`;
      if (!cityTotals[cityKey]) {
        cityTotals[cityKey] = { state: stateName, city: cityName, sales: 0, collected: 0, residual: 0, invoices: 0 };
      }
      cityTotals[cityKey].sales += pSales;
      cityTotals[cityKey].collected += pCollected;
      cityTotals[cityKey].residual += pResidual;
      cityTotals[cityKey].invoices += ps.move_type === 'out_invoice' ? ps.partner_id_count : 0;

      // Top customer list
      customerBreakdown.push({
        id: pId,
        name: pName,
        state: stateName,
        city: cityName,
        rep: 'غير محدد',
        sales: round2(pSales),
        collected: round2(pCollected),
        outstanding: round2(pResidual),
        invoices: ps.move_type === 'out_invoice' ? ps.partner_id_count : 0,
        rate: pSales ? Number((pCollected / pSales * 100).toFixed(1)) : 0
      });
    });

    const customersById = new Map();
    customerBreakdown.forEach(customer => {
      const pQty = partnerQtyMap.get(customer.id) || { grossQty: 0, returnedQty: 0 };
      const grossQty = round2(pQty.grossQty);
      const returnedQty = round2(pQty.returnedQty);
      const netQty = round2(Math.max(0, grossQty - returnedQty));

      const current = customersById.get(customer.id) || {
        ...customer,
        sales: 0,
        collected: 0,
        outstanding: 0,
        invoices: 0,
        grossQty,
        returnedQty,
        netQty
      };
      current.sales += customer.sales;
      current.collected += customer.collected;
      current.outstanding += customer.outstanding;
      current.invoices += customer.invoices;
      customersById.set(customer.id, current);
    });

    customerBreakdown = [...customersById.values()].map(customer => ({
      ...customer,
      sales: round2(customer.sales),
      collected: round2(customer.collected),
      outstanding: Math.max(0, round2(customer.outstanding)),
      rate: customer.sales ? Number((customer.collected / customer.sales * 100).toFixed(1)) : 0
    }));

    // Sum quantities per region
    customerBreakdown.forEach(cust => {
      if (regionalTotals[cust.state]) {
        regionalTotals[cust.state].grossQty += cust.grossQty || 0;
        regionalTotals[cust.state].returnedQty += cust.returnedQty || 0;
        regionalTotals[cust.state].netQty += cust.netQty || 0;
      }
    });

    const regionalList = Object.entries(regionalTotals)
      .map(([name, data]) => {
        const rate = data.sales ? Number((data.collected / data.sales * 100).toFixed(1)) : 0;
        return {
          name,
          sales: round2(data.sales),
          collected: round2(data.collected),
          outstanding: round2(data.residual),
          invoices: data.invoices,
          grossQty: round2(data.grossQty || 0),
          returnedQty: round2(data.returnedQty || 0),
          netQty: round2(data.netQty || 0),
          rate
        };
      })
      .sort((a, b) => b.sales - a.sales);

    // 7. Recent Returns / Credit Notes (Line Level)
    const { productCatalog, categories } = await getProductCatalog(auth);

    const returnLinesDomain = [
      ['move_id.state', '=', 'posted'],
      ['move_id.move_type', '=', 'out_refund'],
      ['display_type', '=', 'product'],
      ['date', '>=', start],
      ['date', '<=', end]
    ];
    if (repId) returnLinesDomain.push(['move_id.invoice_user_id', '=', repId]);
    if (customerId) returnLinesDomain.push(['move_id.partner_id', '=', customerId]);
    if (req.query.region || req.query.city) {
      if (req.query.query) returnLinesDomain.push('&', ['move_id.partner_id', 'in', allowedPartnerIds], '|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
      else returnLinesDomain.push(['move_id.partner_id', 'in', allowedPartnerIds]);
    } else if (req.query.query) {
      returnLinesDomain.push('|', ['move_id.partner_id', 'in', matchingSearchPartnerIds], ['product_id', 'in', matchingSearchProductIds]);
    }
    if (productId) returnLinesDomain.push(['product_id', '=', productId]);
    if (categoryId) returnLinesDomain.push(['product_id.categ_id', 'child_of', categoryId]);

    const recentReturnLines = await odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'search_read', [
      returnLinesDomain
    ], {
      limit: 50,
      order: 'date desc, id desc',
      fields: ['id', 'move_id', 'product_id', 'quantity', 'price_subtotal', 'date', 'partner_id']
    }).catch(() => []);

    // Fetch parent credit notes to get invoice_user_id directly
    const returnMoveIds = [...new Set(recentReturnLines.map(l => l.move_id?.[0]).filter(Boolean))];
    const returnMoveMap = new Map();
    if (returnMoveIds.length > 0) {
      const parentMoves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
        [['id', 'in', returnMoveIds]]
      ], {
        fields: ['id', 'invoice_user_id'],
        limit: returnMoveIds.length
      }).catch(() => []);
      (parentMoves || []).forEach(m => {
        if (m.invoice_user_id && m.invoice_user_id[1]) {
          returnMoveMap.set(m.id, m.invoice_user_id[1]);
        }
      });
    }

    let returnsList = [];
    if (recentReturnLines.length > 0) {
      returnsList = recentReturnLines.map((line, i) => {
        const pId = line.partner_id ? line.partner_id[0] : null;
        const pInfo = pId ? partnerMap.get(pId) : null;
        const prod = productCatalog ? productCatalog.find(p => p.id === (line.product_id ? line.product_id[0] : null)) : null;
        const moveId = line.move_id ? line.move_id[0] : null;
        const moveRep = moveId ? returnMoveMap.get(moveId) : null;
        return {
          id: line.id,
          moveId,
          creditNote: line.move_id ? line.move_id[1] : `CN-${String(i + 1).padStart(4, '0')}`,
          product: line.product_id ? line.product_id[1] : 'غير محدد',
          category: prod?.categoryName || 'غير محدد',
          customer: line.partner_id ? line.partner_id[1] : (pInfo ? pInfo.name : 'غير محدد'),
          rep: moveRep || 'غير محدد',
          region: pInfo ? pInfo.state : 'غير محدد',
          date: line.date,
          returnedQty: round2(line.quantity || 0),
          returns: round2(line.price_subtotal || 0),
          odooLink: moveId ? `${ODOO_URL}/web#id=${moveId}&model=account.move&view_type=form` : `${ODOO_URL}/web#model=account.move&view_type=list`
        };
      });
    } else {
      const recentReturns = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
        [...moveDomain, ['move_type', '=', 'out_refund']]
      ], {
        limit: 25,
        order: 'invoice_date desc, id desc',
        fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'amount_total', 'invoice_date', 'ref']
      }).catch(() => []);

      returnsList = recentReturns.map((r, i) => {
        const pInfo = r.partner_id ? partnerMap.get(r.partner_id[0]) : null;
        return {
          id: r.id,
          moveId: r.id,
          creditNote: r.name || `CN-${String(i + 1).padStart(4, '0')}`,
          product: r.ref || 'غير محدد',
          category: 'غير محدد',
          customer: r.partner_id ? r.partner_id[1] : 'غير محدد',
          rep: r.invoice_user_id ? r.invoice_user_id[1] : 'غير محدد',
          region: pInfo ? pInfo.state : 'غير محدد',
          date: r.invoice_date,
          returnedQty: 0,
          returns: round2(r.amount_total || 0),
          odooLink: `${ODOO_URL}/web#id=${r.id}&model=account.move&view_type=form`
        };
      });
    }

    // 8. Churn / Inactive Customer Warnings
    const churnWarnings = growthAnalysis.churnWarnings;

    const previousRange = comparisonRange(start, end, req.query.comparison || 'previousPeriod');
    let comparison = null;
    if (previousRange) {
      const previousBaseDomain = [
        ...moveDomain.filter((item) => Array.isArray(item) ? item[0] !== 'invoice_date' : true),
        ['invoice_date', '>=', previousRange.start],
        ['invoice_date', '<=', previousRange.end]
      ];
      const [previousInvoices, previousReturns, previousAllPosted] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [...previousBaseDomain, ['move_type', '=', 'out_invoice']],
          ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'], []
        ]),
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [...previousBaseDomain, ['move_type', '=', 'out_refund']],
          ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'], []
        ]),
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [...previousBaseDomain],
          ['amount_total_signed:sum', 'amount_total:sum', 'amount_untaxed_signed:sum', 'amount_residual_signed:sum', 'amount_residual:sum'], []
        ])
      ]);
      const prevInvoiceCount = previousInvoices[0]?.__count || 0;
      const prevReturnCount = previousReturns[0]?.__count || 0;
      const prevTotalPostedCount = previousAllPosted[0]?.__count || (prevInvoiceCount + prevReturnCount);
      const prevRawInvoiceAmount = extractMoveAmount(previousInvoices[0]);
      const previousReturnsAmount = extractMoveAmount(previousReturns[0]);

      let previousNet = 0;
      let previousGross = 0;
      if (previousAllPosted[0]?.amount_total_signed !== undefined && previousAllPosted[0]?.amount_total_signed !== null) {
        previousNet = Number(previousAllPosted[0].amount_total_signed) || 0;
        previousGross = previousNet + previousReturnsAmount;
      } else {
        previousGross = prevRawInvoiceAmount;
        previousNet = Math.max(0, previousGross - previousReturnsAmount);
      }

      const prevInvoiceResidual = extractMoveResidual(previousInvoices[0]);
      const prevReturnResidual = extractMoveResidual(previousReturns[0]);
      const previousOutstanding = Math.max(0, prevInvoiceResidual - prevReturnResidual);
      const previousCollected = Math.max(0, previousNet - previousOutstanding);
      const prevAvgInvoice = prevInvoiceCount ? round2(previousNet / prevInvoiceCount) : 0;
      comparison = {
        mode: req.query.comparison || 'previousPeriod',
        start: previousRange.start,
        end: previousRange.end,
        kpis: {
          gross: round2(previousGross),
          returns: round2(previousReturnsAmount),
          net: round2(previousNet),
          collected: round2(previousCollected),
          outstanding: round2(previousOutstanding),
          invoicesCount: prevInvoiceCount,
          returnsCount: prevReturnCount,
          totalPostedCount: prevTotalPostedCount,
          avgInvoice: prevAvgInvoice
        }
      };
    }

    // 9. Filter Dropdown Options
    const distinctRegions = [...new Set(allPartnersList.map(p => p.state))].filter(Boolean);
    const distinctCities = [...new Set(allPartnersList.map(p => p.city))].filter(c => c && c !== 'غير محدد');
    const distinctReps = await getDistinctRepsFromDocuments(auth);
    const customers = allPartnersList.map(p => ({ id: p.id, name: p.name })).filter(p => p.name);

    const dateFacets = await getDateFacets(auth, 'postedInvoice');
    const totalGrossQty = round2(regionalList.reduce((acc, r) => acc + (r.grossQty || 0), 0));
    const totalReturnedQty = round2(regionalList.reduce((acc, r) => acc + (r.returnedQty || 0), 0));
    const totalNetQty = round2(Math.max(0, totalGrossQty - totalReturnedQty));

    const payload = {
      status: 'success',
      source: req.query.source || 'postedInvoice',
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
      drilldown: regionalList.map(reg => {
        const matchingCustomers = customerBreakdown
          .filter(c => c.state === reg.name)
          .sort((a, b) => b.sales - a.sales);
        return {
          ...reg,
          customers: matchingCustomers
        };
      }),
      filterOptions: {
        regions: distinctRegions,
        cities: distinctCities,
        reps: distinctReps,
        customers,
        categories,
        products: productCatalog,
        ...dateFacets
      }
    };

    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء معالجة بيانات Odoo' });
  }
});

// ─────────────────────────────────────────────────────────────
// KPI Drill-down API (Detailed Documents / Invoices / Orders)
// ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/kpi-drilldown', async (req, res) => {
  try {
    const auth = await getAuthCredentials(req);
    if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });

    const kpi = String(req.query.kpi || 'gross').trim();
    const source = String(req.query.source || 'postedInvoice').trim();
    const { start, end } = getDateRange(req.query);

    // 1. Partner State & City Lookup Map
    let partnerMap = getCached('partners_map');
    let allPartnersList = getCached('partners_list');
    if (!partnerMap || !allPartnersList) {
      const rawPartners = await odooExecuteKw(auth.uid, auth.password, 'res.partner', 'search_read', [
        [['customer_rank', '>', 0]]
      ], { fields: ['id', 'name', 'state_id', 'city', 'user_id', 'phone'], limit: 10000 });

      partnerMap = new Map();
      allPartnersList = [];
      rawPartners.forEach(p => {
        const stateName = p.state_id ? p.state_id[1].replace(/\s*\(EG\)$/i, '').trim() : 'غير محدد';
        const partnerObj = {
          id: p.id,
          name: p.name,
          state: stateName,
          city: p.city || 'غير محدد',
          rep: p.user_id ? p.user_id[1] : 'غير محدد',
          phone: p.phone || ''
        };
        partnerMap.set(p.id, partnerObj);
        allPartnersList.push(partnerObj);
      });
      setCached('partners_map', partnerMap, 30 * 60 * 1000);
      setCached('partners_list', allPartnersList, 30 * 60 * 1000);
    }

    const repId = asPositiveId(req.query.rep);
    const customerId = asPositiveId(req.query.customer);
    const productId = asPositiveId(req.query.product);
    const categoryId = asPositiveId(req.query.category);

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

    if (source === 'salesOrder') {
      const soDomain = [
        ['state', 'in', ['sale', 'done']],
        ['date_order', '>=', `${start} 00:00:00`],
        ['date_order', '<=', `${end} 23:59:59`]
      ];
      if (repId) soDomain.push(['user_id', '=', repId]);
      if (customerId) soDomain.push(['partner_id', '=', customerId]);
      if (allowedPartnerIds.length) soDomain.push(['partner_id', 'in', allowedPartnerIds]);

      const orders = await odooExecuteKw(auth.uid, auth.password, 'sale.order', 'search_read', [
        soDomain
      ], {
        fields: ['id', 'name', 'partner_id', 'user_id', 'date_order', 'amount_total', 'amount_untaxed', 'state'],
        limit: 300,
        order: 'date_order desc, id desc'
      });

      const records = orders.map((o, idx) => {
        const pInfo = o.partner_id ? partnerMap.get(o.partner_id[0]) : null;
        return {
          id: o.id,
          index: idx + 1,
          name: o.name,
          customer: o.partner_id ? o.partner_id[1] : 'غير محدد',
          rep: o.user_id ? o.user_id[1] : 'غير محدد',
          region: pInfo ? pInfo.state : 'غير محدد',
          city: pInfo ? pInfo.city : 'غير محدد',
          date: o.date_order ? o.date_order.split(' ')[0] : '',
          amount: round2(o.amount_total || 0),
          paid: round2(o.amount_total || 0),
          residual: 0,
          paymentState: 'معتمد',
          paymentStatusCode: 'paid',
          isRefund: false,
          typeLabel: 'أمر بيع',
          odooLink: `${ODOO_URL}/web#id=${o.id}&model=sale.order&view_type=form`
        };
      });

      return res.json({
        kpi,
        source,
        title: 'أوامر البيع المعتمدة',
        count: records.length,
        totalAmount: round2(records.reduce((sum, r) => sum + r.amount, 0)),
        totalPaid: round2(records.reduce((sum, r) => sum + r.amount, 0)),
        totalResidual: 0,
        records
      });
    }

    // Invoices and Refunds (account.move)
    const moveDomain = [
      ['state', '=', 'posted'],
      ['invoice_date', '>=', start],
      ['invoice_date', '<=', end]
    ];

    let title = 'فواتير المبيعات المعتمدة';
    if (kpi === 'gross' || kpi === 'invoices') {
      moveDomain.push(['move_type', '=', 'out_invoice']);
      title = 'فواتير المبيعات المعتمدة (Posted Invoices)';
    } else if (kpi === 'returns' || kpi === 'returnsCount') {
      moveDomain.push(['move_type', '=', 'out_refund']);
      title = 'إشعارات الخصم والمرتجعات (Credit Notes)';
    } else if (kpi === 'net' || kpi === 'avgInvoice') {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
      title = 'صافي مبيعات الفواتير والمرتجعات';
    } else if (kpi === 'outstanding') {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']], ['amount_residual', '>', 0]);
      title = 'الفواتير ذات الأرصدة والمديونية القائمة (Unpaid Residual)';
    } else if (kpi === 'collected') {
      moveDomain.push(['move_type', '=', 'out_invoice'], ['payment_state', 'in', ['paid', 'in_payment', 'partial']]);
      title = 'الفواتير المحصلة والمسددة (Collected Invoices)';
    } else {
      moveDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
    }

    if (repId) moveDomain.push(['invoice_user_id', '=', repId]);
    if (customerId) moveDomain.push(['partner_id', '=', customerId]);
    if (productId) moveDomain.push(['invoice_line_ids.product_id', '=', productId]);
    if (categoryId) moveDomain.push(['invoice_line_ids.product_id.categ_id', 'child_of', categoryId]);
    if (allowedPartnerIds.length) moveDomain.push(['partner_id', 'in', allowedPartnerIds]);

    const moves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
      moveDomain
    ], {
      fields: [
        'id', 'name', 'partner_id', 'invoice_user_id', 'invoice_date', 'date',
        'amount_untaxed', 'amount_total', 'amount_total_signed', 'amount_residual', 'amount_residual_signed',
        'payment_state', 'state', 'move_type', 'ref'
      ],
      limit: 300,
      order: 'invoice_date desc, id desc'
    });

    const paymentStateLabels = {
      paid: 'مدفوع بالكامل',
      in_payment: 'قيد السداد',
      not_paid: 'غير مدفوع',
      partial: 'سداد جزئي',
      reversed: 'مردود / معكوس'
    };

    const records = moves.map((m, idx) => {
      const pInfo = m.partner_id ? partnerMap.get(m.partner_id[0]) : null;
      const isRefund = m.move_type === 'out_refund';
      const rawTotal = Math.abs(Number(m.amount_total_signed !== undefined && m.amount_total_signed !== null ? m.amount_total_signed : m.amount_total) || 0);
      const rawResidual = Math.abs(Number(m.amount_residual_signed !== undefined && m.amount_residual_signed !== null ? m.amount_residual_signed : m.amount_residual) || 0);
      const paid = Math.max(0, rawTotal - rawResidual);

      return {
        id: m.id,
        index: idx + 1,
        name: m.name || `DOC-${m.id}`,
        customer: m.partner_id ? m.partner_id[1] : 'غير محدد',
        rep: m.invoice_user_id ? m.invoice_user_id[1] : 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        city: pInfo ? pInfo.city : 'غير محدد',
        date: m.invoice_date || m.date || '',
        ref: m.ref || '',
        amount: round2(rawTotal),
        paid: round2(paid),
        residual: round2(rawResidual),
        isRefund,
        typeLabel: isRefund ? 'إشعار خصم (مرتجع)' : 'فاتورة مبيعات',
        paymentState: paymentStateLabels[m.payment_state] || m.payment_state || 'غير محدد',
        paymentStatusCode: m.payment_state || 'unknown',
        odooLink: `${ODOO_URL}/web#id=${m.id}&model=account.move&view_type=form`
      };
    });

    const netAmount = round2(records.reduce((sum, r) => sum + (r.isRefund ? -r.amount : r.amount), 0));
    const totalPaid = round2(records.reduce((sum, r) => sum + (r.isRefund ? 0 : r.paid), 0));
    const totalResidual = round2(records.reduce((sum, r) => sum + (r.isRefund ? 0 : r.residual), 0));

    res.json({
      kpi,
      source,
      title,
      count: records.length,
      totalAmount: netAmount,
      totalPaid,
      totalResidual,
      records
    });
  } catch (err) {
    console.error('Error in kpi-drilldown:', err.message);
    res.status(500).json({ error: err.message || 'فشل جلب تفاصيل القيود' });
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
