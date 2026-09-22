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

// In-Memory Sessions & Cache
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE = 'foam_session';

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
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
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

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
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
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { uid, username, password, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
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
  const year = /^\d{4}$/.test(String(query.year || '')) ? String(query.year) : currentYear;
  let start = `${currentYear}-01-01`;
  let end = `${currentYear}-12-31`;

  // An explicit range is the user's strongest date choice.  It must win over
  // the month/day controls, which can still contain their previous values.
  if (query.startDate && query.endDate) {
    start = query.startDate;
    end = query.endDate;
  } else if (query.day && query.month) {
    const m = String(query.month).padStart(2, '0');
    const d = String(query.day).padStart(2, '0');
    start = `${year}-${m}-${d}`;
    end = `${year}-${m}-${d}`;
  } else if (query.month) {
    const m = String(query.month).padStart(2, '0');
    start = `${year}-${m}-01`;
    const lastDay = new Date(Number(year), Number(query.month), 0).getDate();
    end = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;
  } else if (query.period) {
    const q = query.period.toUpperCase();
    if (q === 'Q1') { start = `${year}-01-01`; end = `${year}-03-31`; }
    else if (q === 'Q2') { start = `${year}-04-01`; end = `${year}-06-30`; }
    else if (q === 'Q3') { start = `${year}-07-01`; end = `${year}-09-30`; }
    else if (q === 'Q4') { start = `${year}-10-01`; end = `${year}-12-31`; }
  } else if (query.year) {
    start = `${year}-01-01`;
    end = `${year}-12-31`;
  }

  return { start, end, year };
}

function asPositiveId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getDateFacets(auth, source) {
  const cacheKey = `date_facets_${auth.uid}_${source}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const isSalesOrder = source === 'salesOrder';
  const rows = await odooExecuteKw(
    auth.uid,
    auth.password,
    isSalesOrder ? 'sale.order' : 'account.move',
    'search_read',
    [isSalesOrder ? [['date_order', '!=', false]] : [['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']], ['invoice_date', '!=', false]]],
    { fields: [isSalesOrder ? 'date_order' : 'invoice_date'], limit: 10000, order: `${isSalesOrder ? 'date_order' : 'invoice_date'} asc` }
  );
  const dates = [...new Set(rows.map(row => String(row[isSalesOrder ? 'date_order' : 'invoice_date'] || '').slice(0, 10)).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))];
  const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const facets = {
    years: [...new Set(dates.map(date => date.slice(0, 4)))].sort().reverse(),
    months: [...new Set(dates.map(date => Number(date.slice(5, 7))))].sort((a, b) => a - b).map(value => ({ value: String(value), name: monthNames[value - 1] })),
    periods: [...new Set(dates.map(date => `Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`))].sort().map(value => ({ value, name: `الربع ${value.slice(1)}` })),
    days: dates.map(value => ({ value, name: new Date(`${value}T00:00:00Z`).toLocaleDateString('ar-EG') }))
  };
  setCached(cacheKey, facets, 30 * 60 * 1000);
  return facets;
}

function comparisonRange(start, end, mode) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (mode === 'samePeriodLastYear') {
    startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
    endDate.setUTCFullYear(endDate.getUTCFullYear() - 1);
  } else {
    const duration = endDate.getTime() - startDate.getTime();
    endDate.setTime(startDate.getTime() - 86400000);
    startDate.setTime(endDate.getTime() - duration);
  }
  const iso = (date) => date.toISOString().slice(0, 10);
  return { start: iso(startDate), end: iso(endDate) };
}

function replaceDateDomain(domain, start, end) {
  return [
    ...domain.filter(([field]) => field !== 'invoice_date'),
    ['invoice_date', '>=', start],
    ['invoice_date', '<=', end]
  ];
}

function percentChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Number(((current - previous) / Math.abs(previous) * 100).toFixed(1));
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
    if (group.move_type === 'out_refund') entry.returns += group.amount_total || 0;
    else entry.gross += group.amount_total || 0;
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
      currentSales: Math.round(currentValue.gross - currentValue.returns),
      previousSales: Math.round(previousValue.gross - previousValue.returns),
      growthPercent: percentChange(currentValue.gross - currentValue.returns, previousValue.gross - previousValue.returns)
    };
  });
}

async function buildGrowthAnalysis(auth, currentDomain, start, end, comparisonMode, partnerMap) {
  const previousRange = comparisonRange(start, end, comparisonMode);
  if (!previousRange) return { regions: [], customers: [], churnWarnings: [], previousRange: null };

  const previousDomain = replaceDateDomain(currentDomain, previousRange.start, previousRange.end);
  const currentGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [currentDomain, ['amount_total:sum'], ['partner_id', 'move_type']]);
  const previousGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [previousDomain, ['amount_total:sum'], ['partner_id', 'move_type']]);
  const currentMonthGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [currentDomain, ['amount_total:sum'], ['invoice_date:month', 'move_type']]);
  const previousMonthGroups = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [previousDomain, ['amount_total:sum'], ['invoice_date:month', 'move_type']]);

  const toCustomerMap = (groups) => {
    const values = new Map();
    groups.forEach(group => {
      if (!group.partner_id) return;
      const id = group.partner_id[0];
      const sign = group.move_type === 'out_refund' ? -1 : 1;
      values.set(id, (values.get(id) || 0) + sign * (group.amount_total || 0));
    });
    return values;
  };
  const currentCustomers = toCustomerMap(currentGroups);
  const previousCustomers = toCustomerMap(previousGroups);
  const customerIds = new Set([...currentCustomers.keys(), ...previousCustomers.keys()]);
  const customers = [...customerIds].map(id => {
    const info = partnerMap.get(id) || { name: 'غير محدد', state: 'غير محدد', city: 'غير محدد', rep: 'غير محدد' };
    const currentSales = Math.round(currentCustomers.get(id) || 0);
    const previousSales = Math.round(previousCustomers.get(id) || 0);
    return { id, name: info.name, state: info.state, city: info.city, rep: info.rep, currentSales, previousSales, growthAmount: currentSales - previousSales, growthPercent: percentChange(currentSales, previousSales) };
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
    currentSales: Math.round(region.currentSales),
    previousSales: Math.round(region.previousSales),
    growthAmount: Math.round(region.currentSales - region.previousSales),
    growthPercent: percentChange(region.currentSales, region.previousSales)
  })).sort((a, b) => b.currentSales - a.currentSales);

  const threshold = Number(process.env.CHURN_THRESHOLD_PERCENT || 30);
  const minimumPreviousSales = Number(process.env.CHURN_MIN_PREVIOUS_SALES || 25000);
  const churnWarnings = customers
    .filter(customer => customer.previousSales >= minimumPreviousSales && customer.growthPercent <= -threshold)
    .sort((a, b) => a.growthPercent - b.growthPercent)
    .map(customer => ({ ...customer, risk: customer.growthPercent <= -50 ? 'مرتفع' : 'متوسط' }))
    .slice(0, 50);

  const monthLabels = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  return {
    regions,
    customers,
    churnWarnings,
    previousRange,
    threshold,
    minimumPreviousSales,
    timeSeries: {
      month: buildTimeSeries(currentMonthGroups, previousMonthGroups, 'invoice_date:month', monthLabels),
      year: buildTimeSeries(currentMonthGroups, previousMonthGroups, 'invoice_date:month', [], 'year')
    }
  };
}

async function buildSalesOrderOverview(auth, query) {
  const { start, end, year } = getDateRange(query);
  const status = query.salesOrderStatus || 'all';
  const orderDomain = [['date_order', '>=', `${start} 00:00:00`], ['date_order', '<=', `${end} 23:59:59`]];
  if (status === 'post') orderDomain.push(['state', 'in', ['sale', 'done']]);
  else if (status === 'draft') orderDomain.push(['state', '=', 'draft']);
  else orderDomain.push(['state', 'in', ['draft', 'sale', 'done']]);

  const [rawPartners, rawOrders] = await Promise.all([
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
  const lines = orderIds.length ? await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [[['order_id', 'in', orderIds], ['display_type', '=', false]]], { fields: ['order_id', 'product_id', 'product_uom_qty', 'price_subtotal'], limit: 50000 }) : [];
  const productId = asPositiveId(query.product);
  const categoryId = asPositiveId(query.category);
  let filteredLines = lines;
  if (productId || categoryId) {
    const productDomain = productId ? [['product_id', '=', productId]] : [['product_id.categ_id', '=', categoryId]];
    const matching = await odooExecuteKw(auth.uid, auth.password, 'sale.order.line', 'search_read', [[['order_id', 'in', orderIds], ...productDomain]], { fields: ['id', 'order_id'], limit: 50000 });
    const matchingOrderIds = new Set(matching.map(line => line.order_id?.[0]));
    orders = orders.filter(order => matchingOrderIds.has(order.id));
    const remainingIds = new Set(orders.map(order => order.id));
    filteredLines = lines.filter(line => remainingIds.has(line.order_id?.[0]) && (!productId || line.product_id?.[0] === productId));
  }
  const invoiceIds = [...new Set(orders.flatMap(order => order.invoice_ids || []))];
  const invoiceMoves = invoiceIds.length ? await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [[['id', 'in', invoiceIds], ['state', '=', 'posted'], ['move_type', 'in', ['out_invoice', 'out_refund']]]], { fields: ['move_type', 'amount_total', 'amount_residual'], limit: 50000 }) : [];
  const gross = orders.reduce((sum, order) => sum + (order.amount_total || 0), 0);
  const invoiceCollected = invoiceMoves.reduce((sum, move) => sum + (move.move_type === 'out_invoice' ? 1 : -1) * ((move.amount_total || 0) - (move.amount_residual || 0)), 0);
  const collected = Math.min(gross, Math.max(0, invoiceCollected));
  const outstanding = Math.max(0, gross - collected);
  const byProduct = new Map();
  filteredLines.forEach(line => {
    if (!line.product_id) return;
    const value = byProduct.get(line.product_id[0]) || { id: line.product_id[0], name: line.product_id[1], amount: 0, quantity: 0, count: 0 };
    value.amount += line.price_subtotal || 0; value.quantity += line.product_uom_qty || 0; value.count += 1; byProduct.set(value.id, value);
  });
  const products = [...byProduct.values()].map(p => ({ ...p, amount: Math.round(p.amount), quantity: Math.round(p.quantity) }));
  const regional = new Map(); const reps = new Map(); const customers = new Map();
  orders.forEach(order => {
    const partner = partners.get(order.partner_id?.[0]) || { state: 'غير محدد', city: 'غير محدد', name: order.partner_id?.[1] || 'غير محدد' };
    const region = regional.get(partner.state) || { name: partner.state, sales: 0, collected: 0, outstanding: 0, invoices: 0 };
    region.sales += order.amount_total || 0; region.invoices += 1; regional.set(region.name, region);
    const rep = reps.get(order.user_id?.[0]) || { id: order.user_id?.[0], name: order.user_id?.[1] || 'غير محدد', achieved: 0, collected: 0, remaining: 0, count: 0, target: 0 };
    rep.achieved += order.amount_total || 0; rep.count += 1; reps.set(rep.id, rep);
    const customer = customers.get(order.partner_id?.[0]) || { id: order.partner_id?.[0], name: partner.name, state: partner.state, city: partner.city, rep: order.user_id?.[1] || 'غير محدد', sales: 0, collected: 0, outstanding: 0, invoices: 0 };
    customer.sales += order.amount_total || 0; customer.invoices += 1; customers.set(customer.id, customer);
  });
  const regions = [...regional.values()].map(r => ({ ...r, collected: Math.round(r.sales * (gross ? collected / gross : 0)), outstanding: Math.round(r.sales * (gross ? outstanding / gross : 0)), sales: Math.round(r.sales), rate: gross ? Number((collected / gross * 100).toFixed(1)) : 0 })).sort((a, b) => b.sales - a.sales);
  const repsList = [...reps.values()].map(rep => ({ ...rep, achieved: Math.round(rep.achieved), collected: null, remaining: null, target: null, percentage: null, theoreticalPercentage: null, theoreticalGap: null, actualGap: null, kpi: 'غير متاح: لا يوجد مصدر هدف معتمد' }));
  const customerRows = [...customers.values()].map(c => ({ ...c, sales: Math.round(c.sales), collected: null, outstanding: null, rate: null }));
  const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']; const monthlyGross = new Array(12).fill(0);
  orders.forEach(o => { const month = new Date(o.date_order).getUTCMonth(); if (month >= 0) monthlyGross[month] += o.amount_total || 0; });
  const dateFacets = await getDateFacets(auth, 'salesOrder');
  return { status: 'success', source: 'salesOrder', timestamp: new Date().toISOString(), filters: { start, end, year }, kpis: { gross: Math.round(gross), returns: 0, net: Math.round(gross), collected: Math.round(collected), outstanding: Math.round(outstanding), invoicesCount: orders.length, returnsCount: 0, collectionRate: gross ? Number((collected / gross * 100).toFixed(1)) : 0, avgInvoice: orders.length ? Math.round(gross / orders.length) : 0 }, comparison: null, charts: { months, monthlyGross: monthlyGross.map(Math.round), monthlyReturns: new Array(12).fill(0), monthlyNet: monthlyGross.map(Math.round), topProducts: [...products].sort((a, b) => b.amount - a.amount).slice(0, 10), bottomProducts: [...products].sort((a, b) => a.amount - b.amount).slice(0, 10), regional: regions }, reps: repsList, returns: [], churn: [], drilldown: regions.map(region => ({ ...region, customers: customerRows.filter(c => c.state === region.name) })), filterOptions: { regions: [...new Set([...partners.values()].map(p => p.state))], cities: [...new Set([...partners.values()].map(p => p.city))], reps: [...reps.values()].map(r => ({ id: r.id, name: r.name })), customers: [...partners.values()].map(p => ({ id: p.id, name: p.name })), categories: [], products, ...dateFacets } };
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

    // Every dimension filter is converted to an Odoo domain before any KPI or
    // chart is queried.  Values are ids where Odoo expects ids; region/city are
    // attributes of the customer, so they are resolved to customer ids first.
    const allowedPartnerIds = allPartnersList
      .filter(p => !req.query.region || p.state === req.query.region)
      .filter(p => !req.query.city || p.city === req.query.city)
      .map(p => p.id);
    const matchingSearchPartnerIds = req.query.query
      ? allPartnersList
        .filter(p => [p.name, p.state, p.city, p.rep].some(v => String(v).toLowerCase().includes(String(req.query.query).toLowerCase())))
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
    if (categoryId) moveDomain.push(['invoice_line_ids.product_id.categ_id', '=', categoryId]);

    const growthAnalysis = await buildGrowthAnalysis(
      auth,
      moveDomain,
      start,
      end,
      req.query.comparison || 'previousPeriod',
      partnerMap
    );

    // 2. Query KPIs (Invoices vs Refunds)
    const [invoicesSummary, returnsSummary] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [...moveDomain, ['move_type', '=', 'out_invoice']],
        ['amount_total:sum', 'amount_residual:sum'],
        []
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
        [...moveDomain, ['move_type', '=', 'out_refund']],
        ['amount_total:sum'],
        []
      ])
    ]);

    const gross = invoicesSummary[0]?.amount_total || 0;
    const residual = invoicesSummary[0]?.amount_residual || 0;
    const invoiceCount = invoicesSummary[0]?.__count || 0;
    const returns = returnsSummary[0]?.amount_total || 0;
    const returnCount = returnsSummary[0]?.__count || 0;
    const net = gross - returns;
    const collected = Math.min(Math.max(0, gross - residual), Math.max(0, net));
    const outstanding = Math.max(0, net - collected);
    const rate = net ? (collected / net * 100) : 0;
    const avgInvoice = invoiceCount ? (net / invoiceCount) : 0;

    // 3. Monthly Growth Series
    const monthlyMoves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      [
        ...moveDomain.filter(([field]) => field !== 'invoice_date'),
        ['invoice_date', '>=', `${year}-01-01`],
        ['invoice_date', '<=', `${year}-12-31`]
      ],
      ['amount_total:sum'],
      ['invoice_date:month', 'move_type'],
      0, 100, 'invoice_date:month asc'
    ]);

    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const monthlyGross = new Array(12).fill(0);
    const monthlyReturns = new Array(12).fill(0);
    const monthlyNet = new Array(12).fill(0);

    monthlyMoves.forEach(m => {
      const monthStr = m['invoice_date:month'] || '';
      const normalizedMonth = String(monthStr).toLowerCase();
      const numericMonth = normalizedMonth.match(/(?:^|[-/])(0?[1-9]|1[0-2])(?:[-/]|$)/);
      const monthIndex = numericMonth ? Number(numericMonth[1]) - 1 : monthNames.findIndex((name, i) => normalizedMonth.includes(name) || normalizedMonth.includes(englishMonths[i]));
      if (monthIndex >= 0) {
        const i = monthIndex;
          if (m.move_type === 'out_refund') {
            monthlyReturns[i] += m.amount_total || 0;
          } else {
            monthlyGross[i] += m.amount_total || 0;
          }
      }
    });

    for (let i = 0; i < 12; i++) {
      monthlyNet[i] = Math.max(0, monthlyGross[i] - monthlyReturns[i]);
    }

    // 4. Sales Reps Performance
    const repsSales = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      moveDomain,
      ['amount_total:sum', 'amount_residual:sum'],
      ['invoice_user_id', 'move_type']
    ]);

    const repsById = new Map();
    repsSales.filter(r => r.invoice_user_id && r.invoice_user_id[1]).forEach(r => {
      const id = r.invoice_user_id[0];
      const current = repsById.get(id) || { id, name: r.invoice_user_id[1], achieved: 0, remaining: 0, count: 0 };
      const sign = r.move_type === 'out_refund' ? -1 : 1;
      current.achieved += sign * (r.amount_total || 0);
      current.remaining += sign * (r.amount_residual || 0);
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
          achieved: Math.round(achieved),
          collected: Math.round(repCollected),
          remaining: Math.round(remaining),
          target: Math.round(estimatedTarget),
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
    if (categoryId) lineDomain.push(['product_id.categ_id', '=', categoryId]);

    const [topProductsSales, bottomProductsSales] = await Promise.all([
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'price_subtotal desc'
      ]),
      odooExecuteKw(auth.uid, auth.password, 'account.move.line', 'read_group', [
        lineDomain,
        ['price_subtotal:sum', 'quantity:sum'],
        ['product_id'],
        0, 10, 'price_subtotal asc'
      ])
    ]);

    const topProducts = topProductsSales
      .filter(p => p.product_id && p.product_id[1])
      .map(p => ({
        name: p.product_id[1],
        amount: Math.round(p.price_subtotal || 0),
        quantity: Math.round(p.quantity || 0),
        count: p.product_id_count || 0
      }));

    const bottomProducts = bottomProductsSales
      .filter(p => p.product_id && p.product_id[1] && p.price_subtotal > 0)
      .map(p => ({
        name: p.product_id[1],
        amount: Math.round(p.price_subtotal || 0),
        quantity: Math.round(p.quantity || 0),
        count: p.product_id_count || 0
      }));

    // 6. Regional Distribution (by Customer State)
    const partnerSalesGroup = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      moveDomain,
      ['amount_total:sum', 'amount_residual:sum'],
      ['partner_id', 'move_type']
    ]);

    const regionalTotals = {};
    const cityTotals = {};
    let customerBreakdown = [];

    partnerSalesGroup.forEach(ps => {
      if (!ps.partner_id) return;
      const pId = ps.partner_id[0];
      const pName = ps.partner_id[1];
      const info = partnerMap.get(pId) || { state: 'أخرى / غير محدد', city: 'غير محدد', rep: 'غير محدد' };
      const stateName = info.state || 'أخرى / غير محدد';
      const cityName = info.city || 'غير محدد';
      const sign = ps.move_type === 'out_refund' ? -1 : 1;
      const pSales = sign * (ps.amount_total || 0);
      const pResidual = sign * (ps.amount_residual || 0);
      const pCollected = pSales - pResidual;

      // State aggregate
      if (!regionalTotals[stateName]) {
        regionalTotals[stateName] = { sales: 0, collected: 0, residual: 0, invoices: 0 };
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
        rep: info.rep,
        sales: Math.round(pSales),
        collected: Math.round(pCollected),
        outstanding: Math.round(pResidual),
        invoices: ps.move_type === 'out_invoice' ? ps.partner_id_count : 0,
        rate: pSales ? Number((pCollected / pSales * 100).toFixed(1)) : 0
      });
    });

    const customersById = new Map();
    customerBreakdown.forEach(customer => {
      const current = customersById.get(customer.id) || { ...customer, sales: 0, collected: 0, outstanding: 0, invoices: 0 };
      current.sales += customer.sales;
      current.collected += customer.collected;
      current.outstanding += customer.outstanding;
      current.invoices += customer.invoices;
      customersById.set(customer.id, current);
    });
    customerBreakdown = [...customersById.values()].map(customer => ({
      ...customer,
      sales: Math.round(customer.sales),
      collected: Math.round(customer.collected),
      outstanding: Math.max(0, Math.round(customer.outstanding)),
      rate: customer.sales ? Number((customer.collected / customer.sales * 100).toFixed(1)) : 0
    }));

    const regionalList = Object.entries(regionalTotals)
      .map(([name, data]) => {
        const rate = data.sales ? Number((data.collected / data.sales * 100).toFixed(1)) : 0;
        return {
          name,
          sales: Math.round(data.sales),
          collected: Math.round(data.collected),
          outstanding: Math.round(data.residual),
          invoices: data.invoices,
          rate
        };
      })
      .sort((a, b) => b.sales - a.sales);

    // 7. Recent Returns / Credit Notes
    const recentReturns = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'search_read', [
      [...moveDomain, ['move_type', '=', 'out_refund']]
    ], {
      limit: 25,
      order: 'invoice_date desc, id desc',
      fields: ['id', 'name', 'partner_id', 'invoice_user_id', 'amount_total', 'invoice_date', 'ref']
    });

    const returnsList = recentReturns.map((r, i) => {
      const pInfo = r.partner_id ? partnerMap.get(r.partner_id[0]) : null;
      return {
        id: r.id,
        creditNote: r.name || `CN-${String(i + 1).padStart(4, '0')}`,
        product: r.ref || 'غير محدد',
        category: 'غير محدد',
        customer: r.partner_id ? r.partner_id[1] : 'غير محدد',
        rep: r.invoice_user_id ? r.invoice_user_id[1] : 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        date: r.invoice_date,
        returnedQty: 0,
        returns: Math.round(r.amount_total || 0),
        returnOnSystem: true
      };
    });

    // 8. Churn / Inactive Customer Warnings
    const churnWarnings = growthAnalysis.churnWarnings;

    const previousRange = comparisonRange(start, end, req.query.comparison);
    let comparison = null;
    if (previousRange) {
      const previousBaseDomain = [
        ...moveDomain.filter(([field]) => field !== 'invoice_date'),
        ['invoice_date', '>=', previousRange.start],
        ['invoice_date', '<=', previousRange.end]
      ];
      const [previousInvoices, previousReturns] = await Promise.all([
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [...previousBaseDomain, ['move_type', '=', 'out_invoice']],
          ['amount_total:sum', 'amount_residual:sum'], []
        ]),
        odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
          [...previousBaseDomain, ['move_type', '=', 'out_refund']],
          ['amount_total:sum'], []
        ])
      ]);
      const previousGross = previousInvoices[0]?.amount_total || 0;
      const previousReturnsAmount = previousReturns[0]?.amount_total || 0;
      const previousNet = previousGross - previousReturnsAmount;
      const previousCollected = Math.min(Math.max(0, previousGross - (previousInvoices[0]?.amount_residual || 0)), Math.max(0, previousNet));
      const previousOutstanding = Math.max(0, previousNet - previousCollected);
      comparison = {
        start: previousRange.start,
        end: previousRange.end,
        kpis: {
          gross: Math.round(previousGross), returns: Math.round(previousReturnsAmount), net: Math.round(previousNet),
          collected: Math.round(previousCollected), outstanding: Math.round(previousOutstanding),
          invoicesCount: previousInvoices[0]?.__count || 0
        }
      };
    }

    // 9. Filter Dropdown Options
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
    const distinctRegions = [...new Set(allPartnersList.map(p => p.state))].filter(Boolean);
    const distinctCities = [...new Set(allPartnersList.map(p => p.city))].filter(c => c && c !== 'غير محدد');
    const distinctReps = repsSales.filter(r => r.invoice_user_id).map(r => ({ id: r.invoice_user_id[0], name: r.invoice_user_id[1] }));
    const customers = allPartnersList.map(p => ({ id: p.id, name: p.name })).filter(p => p.name);

    const dateFacets = await getDateFacets(auth, 'postedInvoice');
    const payload = {
      status: 'success',
      source: req.query.source || 'postedInvoice',
      timestamp: new Date().toISOString(),
      filters: { start, end, year },
      kpis: {
        gross: Math.round(gross),
        returns: Math.round(returns),
        net: Math.round(net),
        collected: Math.round(collected),
        outstanding: Math.round(outstanding),
        invoicesCount: invoiceCount,
        returnsCount: returnCount,
        collectionRate: Number(rate.toFixed(1)),
        avgInvoice: Math.round(avgInvoice)
      },
      comparison,
      charts: {
        months: monthNames,
        monthlyGross,
        monthlyReturns,
        monthlyNet,
        growthTimeSeries: growthAnalysis.timeSeries,
        topProducts,
        bottomProducts,
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

// Always listen if not running in Vercel Serverless environment
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;
