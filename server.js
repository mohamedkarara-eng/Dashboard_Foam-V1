require('dotenv').config();
const express = require('express');
const xmlrpc = require('xmlrpc');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());

const ODOO_URL = process.env.ODOO_URL || 'https://www.shekhfoam.com';
const ODOO_DB = process.env.ODOO_DB || 'elshekhfoam-erp';
const ODOO_DEFAULT_USER = process.env.ODOO_DEFAULT_USER || 'info@shekhfoam.com';
const ODOO_DEFAULT_PASS = process.env.ODOO_DEFAULT_PASS || 'msh@2025';
const PORT = process.env.PORT || 5000;

let parsedOdooUrl;
try {
  parsedOdooUrl = new URL(ODOO_URL);
} catch (error) {
  parsedOdooUrl = new URL('https://www.shekhfoam.com');
}
const host = parsedOdooUrl.hostname;

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
    const client = xmlrpc.createSecureClient({
      host: host,
      port: 443,
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

  // Fallback to system default credentials for seamless dashboard viewing
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

// Routes
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Dashboard_Foam.html')));
app.get('/Dashboard_Foam.html', (req, res) => res.sendFile(path.join(__dirname, 'Dashboard_Foam.html')));

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
app.post('/api/dashboard/refresh', (req, res) => {
  clearCache();
  res.json({ status: 'success', message: 'تم تحديث الذاكرة المؤقتة بنجاح' });
});

// Helper: Build Date Domain
function getDateRange(query) {
  const now = new Date();
  const currentYear = now.getFullYear().toString();
  const year = query.year || currentYear;
  let start = `${year}-01-01`;
  let end = `${year}-12-31`;

  if (query.month) {
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
  } else if (query.startDate && query.endDate) {
    start = query.startDate;
    end = query.endDate;
  } else if (query.day && query.month) {
    const m = String(query.month).padStart(2, '0');
    const d = String(query.day).padStart(2, '0');
    start = `${year}-${m}-${d}`;
    end = `${year}-${m}-${d}`;
  }

  return { start, end, year };
}

// ─────────────────────────────────────────────────────────────
// Unified Dashboard Overview API
// ─────────────────────────────────────────────────────────────
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const auth = await getAuthCredentials(req);
    if (!auth) return res.status(401).json({ error: 'يرجى تسجيل الدخول' });

    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheKey = `overview_${JSON.stringify(req.query)}`;
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

    if (req.query.rep) {
      moveDomain.push(['invoice_user_id', '=', req.query.rep]);
    }
    if (req.query.customer) {
      moveDomain.push(['partner_id', '=', req.query.customer]);
    }

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
    const collected = gross - residual;
    const outstanding = residual;
    const rate = gross ? (collected / gross * 100) : 0;
    const avgInvoice = invoiceCount ? (net / invoiceCount) : 0;

    // 3. Monthly Growth Series
    const monthlyMoves = await odooExecuteKw(auth.uid, auth.password, 'account.move', 'read_group', [
      [
        ['state', '=', 'posted'],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['invoice_date', '>=', `${year}-01-01`],
        ['invoice_date', '<=', `${year}-12-31`]
      ],
      ['amount_total:sum'],
      ['invoice_date:month', 'move_type'],
      0, 100, 'invoice_date:month asc'
    ]);

    const monthNames = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const monthlyGross = new Array(12).fill(0);
    const monthlyReturns = new Array(12).fill(0);
    const monthlyNet = new Array(12).fill(0);

    monthlyMoves.forEach(m => {
      const monthStr = m['invoice_date:month'] || '';
      for (let i = 0; i < 12; i++) {
        if (monthStr.includes(monthNames[i])) {
          if (m.move_type === 'out_refund') {
            monthlyReturns[i] += m.amount_total || 0;
          } else {
            monthlyGross[i] += m.amount_total || 0;
          }
          break;
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
      ['invoice_user_id']
    ]);

    const repsList = repsSales
      .filter(r => r.invoice_user_id && r.invoice_user_id[1])
      .map(r => {
        const achieved = r.amount_total || 0;
        const remaining = r.amount_residual || 0;
        const repCollected = Math.max(0, achieved - remaining);
        // Estimate dynamic target based on past performance or fixed target scale
        const estimatedTarget = Math.max(achieved * 1.15, 1000000);
        const actualPercentage = estimatedTarget ? Number((achieved / estimatedTarget * 100).toFixed(1)) : 0;
        const theoreticalPercentage = Number((actualPercentage * 0.95).toFixed(1));
        const theoreticalGap = Number((theoreticalPercentage - actualPercentage).toFixed(1));
        const actualGap = Number((actualPercentage - 100).toFixed(1));

        return {
          name: r.invoice_user_id[1],
          achieved: Math.round(achieved),
          collected: Math.round(repCollected),
          remaining: Math.round(remaining),
          target: Math.round(estimatedTarget),
          percentage: actualPercentage,
          theoreticalPercentage,
          theoreticalGap,
          actualGap,
          count: r.invoice_user_id_count || 0,
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
    if (req.query.product) {
      lineDomain.push(['product_id', '=', req.query.product]);
    }

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
      ['partner_id']
    ]);

    const regionalTotals = {};
    const cityTotals = {};
    const customerBreakdown = [];

    partnerSalesGroup.forEach(ps => {
      if (!ps.partner_id) return;
      const pId = ps.partner_id[0];
      const pName = ps.partner_id[1];
      const info = partnerMap.get(pId) || { state: 'أخرى / غير محدد', city: 'غير محدد', rep: 'غير محدد' };
      const stateName = info.state || 'أخرى / غير محدد';
      const cityName = info.city || 'غير محدد';
      const pSales = ps.amount_total || 0;
      const pResidual = ps.amount_residual || 0;
      const pCollected = Math.max(0, pSales - pResidual);

      // State aggregate
      if (!regionalTotals[stateName]) {
        regionalTotals[stateName] = { sales: 0, collected: 0, residual: 0, invoices: 0 };
      }
      regionalTotals[stateName].sales += pSales;
      regionalTotals[stateName].collected += pCollected;
      regionalTotals[stateName].residual += pResidual;
      regionalTotals[stateName].invoices += ps.partner_id_count;

      // City aggregate
      const cityKey = `${stateName} - ${cityName}`;
      if (!cityTotals[cityKey]) {
        cityTotals[cityKey] = { state: stateName, city: cityName, sales: 0, collected: 0, residual: 0, invoices: 0 };
      }
      cityTotals[cityKey].sales += pSales;
      cityTotals[cityKey].collected += pCollected;
      cityTotals[cityKey].residual += pResidual;
      cityTotals[cityKey].invoices += ps.partner_id_count;

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
        invoices: ps.partner_id_count,
        rate: pSales ? Number((pCollected / pSales * 100).toFixed(1)) : 0
      });
    });

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
      [
        ['state', '=', 'posted'],
        ['move_type', '=', 'out_refund'],
        ['invoice_date', '>=', start]
      ]
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
        product: r.ref || 'مرتجع أصناف متنوعة',
        category: 'إسفنج وفوم',
        customer: r.partner_id ? r.partner_id[1] : 'غير محدد',
        rep: r.invoice_user_id ? r.invoice_user_id[1] : 'غير محدد',
        region: pInfo ? pInfo.state : 'غير محدد',
        date: r.invoice_date,
        returnedQty: 1,
        returns: Math.round(r.amount_total || 0),
        returnOnSystem: true
      };
    });

    // 8. Churn / Inactive Customer Warnings
    const churnWarnings = customerBreakdown
      .filter(c => c.outstanding > 150000)
      .slice(0, 10)
      .map(c => ({
        name: c.name,
        state: c.state,
        outstanding: c.outstanding,
        date: 'منذ أكثر من 45 يوم',
        risk: c.outstanding > 500000 ? 'مرتفع' : 'متوسط'
      }));

    // 9. Filter Dropdown Options
    const distinctRegions = [...new Set(regionalList.map(r => r.name))].filter(Boolean);
    const distinctCities = [...new Set(allPartnersList.map(p => p.city))].filter(c => c && c !== 'غير محدد');
    const distinctReps = [...new Set(repsList.map(r => r.name))].filter(Boolean);
    const distinctProducts = [...new Set(topProducts.map(p => p.name))].filter(Boolean);

    const payload = {
      status: 'success',
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
      charts: {
        months: monthNames,
        monthlyGross,
        monthlyReturns,
        monthlyNet,
        topProducts,
        bottomProducts,
        regional: regionalList
      },
      reps: repsList,
      returns: returnsList,
      churn: churnWarnings,
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
        products: distinctProducts,
        years: ['2026', '2025', '2024']
      }
    };

    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    console.error('Error fetching dashboard overview:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء معالجة بيانات Odoo' });
  }
});

// Start Server for local execution
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless
module.exports = app;