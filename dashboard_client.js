/* ═══════════════════════════════════════════════════════════════════
   LIVE ODOO DASHBOARD CONTROLLER — SHEIKH FOAM FACTORY
   ═══════════════════════════════════════════════════════════════════ */

const liveDashboard = {
  data: null,
  filters: {
    dateFilterType: 'quick',
    quickPreset: 'شهري',
    year: '',
    month: '',
    period: '',
    day: '',
    startDate: '',
    endDate: '',
    region: '',
    city: '',
    rep: '',
    customer: '',
    category: '',
    product: '',
    query: '',
    comparison: 'previousPeriod',
    source: 'postedInvoice',
    salesOrderStatus: 'all'
  },
  mode: 'شهري',
  growthGrouping: 'churn',
  productMode: 'top',
  metric: 'amount',
  expandedReps: new Set(),
  expandedRegions: new Set(),
  charts: {
    product: null,
    growth: null,
    regional: null
  }
};

// Language & Digits Localization System:
// - When Arabic is chosen / active: Eastern Arabic numerals (٠، ١، ٢، ٣، ٤، ٥، ٦، ٧، ٨، ٩)
// - When English is chosen / active: Standard Western numerals (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
// No manual switching button — digits automatically synchronize with the active language.

const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

function getDashboardLanguage() {
  try {
    // 1. URL search parameter (?lang=ar or ?lang=en or ?locale=ar)
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const sp = new URLSearchParams(window.location.search);
      const qLang = sp.get('lang') || sp.get('locale');
      if (qLang) return qLang.toLowerCase().startsWith('ar') ? 'ar' : 'en';
    }
    // 2. Saved language preference in localStorage (if any)
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('foam_language') || localStorage.getItem('lang');
      if (saved) return saved.toLowerCase().startsWith('ar') ? 'ar' : 'en';
    }
    // 3. Document HTML lang attribute (<html lang="ar">)
    if (typeof document !== 'undefined') {
      const docLang = document.documentElement?.lang || document.querySelector('html')?.getAttribute('lang');
      if (docLang) return docLang.toLowerCase().startsWith('ar') ? 'ar' : 'en';
    }
  } catch (e) {}
  return 'ar'; // Default language for Sheikh Foam Dashboard
}

function isArabic() {
  return getDashboardLanguage() === 'ar';
}

function toArabicDigits(str) {
  if (str === null || str === undefined) return '';
  if (!isArabic()) return String(str);
  return String(str).replace(/[0-9]/g, d => ARABIC_DIGITS[d]);
}

// Automatically react if HTML lang attribute is changed dynamically
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
  const langObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'lang') {
        renderAllDashboardComponents();
        break;
      }
    }
  });
  langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

const formatMoney = (val) => {
  const num = Number(val);
  const safeNum = Number.isFinite(num) ? num : 0;
  const isNeg = safeNum < 0;
  const absNum = Math.abs(safeNum);
  const formatted = absNum.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const currency = isArabic() ? 'ج.م' : 'EGP';
  const res = `${isNeg ? '-' : ''}${formatted} ${currency}`;
  return toArabicDigits(res);
};

const formatNumber = (val, decimals = 2) => {
  const num = Number(val);
  const safeNum = Number.isFinite(num) ? num : 0;
  const dec = (decimals !== undefined && decimals !== null) ? Number(decimals) : 2;
  const isNeg = safeNum < 0;
  const absNum = Math.abs(safeNum);
  const formatted = absNum.toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec
  });
  const res = `${isNeg ? '-' : ''}${formatted}`;
  return toArabicDigits(res);
};

const formatCount = (val) => {
  const num = Math.round(Number(val) || 0);
  const isNeg = num < 0;
  const absNum = Math.abs(num);
  const formatted = absNum.toLocaleString('en-US');
  const res = `${isNeg ? '-' : ''}${formatted}`;
  return toArabicDigits(res);
};

const round2 = (val) => {
  const num = Number(val);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
};

const formatCompactMoneyAxis = (val) => {
  const num = Number(val) || 0;
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  const currency = isArabic() ? 'ج.م' : 'EGP';
  let res = '';
  if (abs >= 1000000) res = `${sign}${(abs / 1000000).toFixed(1)}M ${currency}`;
  else if (abs >= 1000) res = `${sign}${(abs / 1000).toFixed(0)}K ${currency}`;
  else res = `${sign}${abs.toLocaleString('en-US')} ${currency}`;
  return toArabicDigits(res);
};

const formatCompactQtyAxis = (val) => {
  const num = Number(val) || 0;
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  let res = '';
  if (abs >= 1000000) res = `${sign}${(abs / 1000000).toFixed(1)}M`;
  else if (abs >= 1000) res = `${sign}${(abs / 1000).toFixed(0)}K`;
  else res = `${sign}${abs.toLocaleString('en-US')}`;
  return toArabicDigits(res);
};

function showLoading(message = 'جاري جلب وتحديث البيانات من Odoo...') {
  document.body.classList.add('is-loading');
  const bar = document.getElementById('globalProgressBar');
  const badge = document.getElementById('globalLoadingBadge');
  if (bar) bar.classList.add('active');
  if (badge) {
    const textNode = badge.querySelector('span');
    if (textNode) textNode.textContent = message;
    badge.classList.add('active');
  }
}

function hideLoading() {
  document.body.classList.remove('is-loading');
  const bar = document.getElementById('globalProgressBar');
  const badge = document.getElementById('globalLoadingBadge');
  if (bar) bar.classList.remove('active');
  if (badge) badge.classList.remove('active');
}

/* ── Filter pending indicator ── */
function markFiltersPending() {
  const dot = document.getElementById('filtersPendingDot');
  const btn = document.getElementById('applyFiltersBtn');
  if (dot) dot.hidden = false;
  if (btn) btn.classList.add('has-pending');
}

function clearFiltersPending() {
  const dot = document.getElementById('filtersPendingDot');
  const btn = document.getElementById('applyFiltersBtn');
  if (dot) dot.hidden = true;
  if (btn) btn.classList.remove('has-pending');
}

// ─── High-Speed Client-Side In-Memory Cache for Instant Filter Response ───
const clientOverviewCache = new Map();
const CLIENT_CACHE_TTL_MS = 2.5 * 60 * 1000; // 2.5 minutes cache in browser
const CLIENT_CACHE_MAX = 50;

function getClientCacheKey(params) {
  const sorted = [...params.entries()]
    .filter(([k, v]) => k !== 'refresh' && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([k, v]) => `${k}=${v}`).join('&');
}

async function loadLiveDashboard(forceRefresh = false) {
  clearFiltersPending();
  const errorNode = document.getElementById('dashboardError');
  if (errorNode) errorNode.hidden = true;
  showLoading(forceRefresh ? 'جاري تحديث البيانات من خادم Odoo...' : 'جاري تحميل البيانات...');
  try {
    const params = new URLSearchParams();

    // Isolated Date Filtering Logic
    if (liveDashboard.filters.dateFilterType === 'quick') {
      params.set('dateFilterType', 'quick');
      params.set('quickPreset', liveDashboard.filters.quickPreset || 'شهري');
      if (liveDashboard.filters.startDate) params.set('startDate', liveDashboard.filters.startDate);
      if (liveDashboard.filters.endDate) params.set('endDate', liveDashboard.filters.endDate);
      if (liveDashboard.filters.year) params.set('year', liveDashboard.filters.year);
    } else {
      params.set('dateFilterType', 'custom');
      if (liveDashboard.filters.startDate && liveDashboard.filters.endDate) {
        params.set('startDate', liveDashboard.filters.startDate);
        params.set('endDate', liveDashboard.filters.endDate);
      } else {
        if (liveDashboard.filters.year) params.set('year', liveDashboard.filters.year);
        if (liveDashboard.filters.month) params.set('month', liveDashboard.filters.month);
        if (liveDashboard.filters.period) params.set('period', liveDashboard.filters.period);
        if (liveDashboard.filters.day) params.set('day', liveDashboard.filters.day);
      }
    }

    ['region', 'city', 'rep', 'customer', 'category', 'product', 'query', 'comparison', 'source', 'salesOrderStatus']
      .forEach((key) => {
        if (liveDashboard.filters[key]) params.set(key, liveDashboard.filters[key]);
      });
    params.set('metric', liveDashboard.metric || 'amount');

    const clientKey = getClientCacheKey(params);

    // Instant UI Response: If this exact filter combination was recently loaded, render immediately!
    if (!forceRefresh && clientOverviewCache.has(clientKey)) {
      const cached = clientOverviewCache.get(clientKey);
      if (cached && (Date.now() - cached.timestamp < CLIENT_CACHE_TTL_MS)) {
        liveDashboard.data = cached.payload;
        renderAllDashboardComponents();
        hideLoading();
        return;
      }
    }

    if (forceRefresh) {
      params.set('refresh', '1');
      clientOverviewCache.clear();
    }

    const res = await fetch('/api/dashboard/overview?' + params.toString(), { credentials: 'same-origin' });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const failure = await res.json().catch(() => ({}));
      throw new Error(failure.error || 'تعذر تحميل بيانات لوحة التحكم');
    }

    const payload = await res.json();
    liveDashboard.data = payload;

    // Cache the fresh payload in client browser memory
    if (clientOverviewCache.size >= CLIENT_CACHE_MAX) {
      const oldestKey = clientOverviewCache.keys().next().value;
      clientOverviewCache.delete(oldestKey);
    }
    clientOverviewCache.set(clientKey, { payload, timestamp: Date.now() });

    renderAllDashboardComponents();

    if (payload.isStale && payload.warning) {
      showDashboardAlert(payload.warning, 'warning');
    } else {
      dismissAlertBanner();
    }
  } catch (err) {
    console.error('Error loading live dashboard:', err.message);
    const friendly = formatUserFriendlyError(err);
    showDashboardAlert(friendly, 'error');
  } finally {
    hideLoading();
  }
}

// Client-side Error Sanitizer: Translates any low-level exception into user-friendly Arabic
function formatUserFriendlyError(err) {
  if (!err) return 'تعذر تحميل البيانات من خادم Odoo حالياً. يرجى إعادة المحاولة.';
  const raw = typeof err === 'string' ? err : (err.message || 'تعذر تحميل البيانات');
  const lower = raw.toLowerCase();

  if (
    lower.includes('unknown xml-rpc tag') ||
    lower.includes('title') ||
    lower.includes('doctype') ||
    lower.includes('html') ||
    lower.includes('head') ||
    lower.includes('504') ||
    lower.includes('gateway timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout')
  ) {
    return 'استغرق خادم Odoo وقتاً أطول من المتوقع للاستجابة (مهلة اتصال). يرجى تقليل نطاق الفلترة أو إعادة المحاولة.';
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('socket hang up') ||
    lower.includes('econnreset') ||
    lower.includes('502') ||
    lower.includes('bad gateway') ||
    lower.includes('503') ||
    lower.includes('service unavailable')
  ) {
    return 'تعذر الاتصال بخادم Odoo حالياً. يرجى التحقق من اتصال الشبكة وإعادة المحاولة بعد قليل.';
  }

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('تسجيل الدخول') || lower.includes('session expired')) {
    return 'انتهت صلاحية جلسة العمل. يرجى تسجيل الدخول مجدداً للمتابعة.';
  }

  if (
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.includes('xmlrpc') ||
    lower.includes('xml-rpc') ||
    lower.includes('syntaxerror')
  ) {
    return 'حدث خطأ مؤقت في استجابة خادم Odoo. يرجى الضغط على زر إعادة المحاولة.';
  }

  // If already clean Arabic text without technical leakage
  if (/[\u0600-\u06FF]/.test(raw) && !lower.includes('xml-rpc') && !lower.includes('title')) {
    return raw;
  }

  return 'تعذر جلب البيانات في الوقت الحالي. يرجى الضغط على إعادة المحاولة.';
}

function showDashboardAlert(message, type = 'error') {
  const banner = document.getElementById('dashboardAlertBanner');
  if (!banner) return;
  const titleEl = document.getElementById('alertBannerTitle');
  const msgEl = document.getElementById('alertBannerMsg');

  if (titleEl) {
    titleEl.textContent = type === 'warning' ? 'تنبيه في مزامنة البيانات' : 'تعذر الاتصال بخادم Odoo';
  }
  if (msgEl) {
    msgEl.textContent = message;
  }
  banner.className = 'alert-banner' + (type === 'warning' ? ' warning' : '');
  banner.hidden = false;

  // Also clear legacy dashboardError node to avoid raw text under header
  const errorNode = document.getElementById('dashboardError');
  if (errorNode) {
    errorNode.textContent = '';
    errorNode.hidden = true;
  }
}

function dismissAlertBanner() {
  const banner = document.getElementById('dashboardAlertBanner');
  if (banner) banner.hidden = true;
  const errorNode = document.getElementById('dashboardError');
  if (errorNode) {
    errorNode.textContent = '';
    errorNode.hidden = true;
  }
}

function retryLoadDashboard() {
  dismissAlertBanner();
  loadLiveDashboard(true);
}

function renderAllDashboardComponents() {
  if (!liveDashboard.data) return;
  const d = liveDashboard.data;

  const activeCompKpis = (liveDashboard.filters.comparison === 'none' || d.comparison?.mode === 'none') ? null : d.comparison?.kpis;
  try { renderFilterDropdowns(d.filterOptions); } catch (e) { console.error('Error rendering filter dropdowns:', e); }
  try { renderKpis(d.kpis, activeCompKpis); } catch (e) { console.error('Error rendering KPIs:', e); }
  try { renderProductChart(d.charts); } catch (e) { console.error('Error rendering product chart:', e); }
  try { renderGrowthChart(d.charts); } catch (e) { console.error('Error rendering growth chart:', e); }
  try { renderRegionalChart(d.charts); } catch (e) { console.error('Error rendering regional chart:', e); }
  try { renderRepsTable(d.reps); } catch (e) { console.error('Error rendering reps table:', e); }
  try { renderDrilldownTable(d.drilldown); } catch (e) { console.error('Error rendering drilldown table:', e); }
  try { renderReturnsTable(d.returns); } catch (e) { console.error('Error rendering returns table:', e); }
  try { renderChurnWarnings(d.churn); } catch (e) { console.error('Error rendering churn warnings:', e); }
  try { renderComparisonMatrix(d.kpis, activeCompKpis); } catch (e) { console.error('Error rendering comparison matrix:', e); }

  renderDashboardDate(d.filters, d.comparison);

  const summaryNode = document.getElementById('dashboardFilterSummary');
  if (summaryNode) {
    const periodText = liveDashboard.filters.dateFilterType === 'quick'
      ? (liveDashboard.filters.quickPreset || 'شهري')
      : (liveDashboard.filters.startDate && liveDashboard.filters.endDate
          ? `${liveDashboard.filters.startDate} إلى ${liveDashboard.filters.endDate}`
          : (liveDashboard.filters.year ? `سنة ${liveDashboard.filters.year}` : 'مخصص'));
    summaryNode.textContent = (liveDashboard.filters.region || 'كل المناطق') + ' | ' + (liveDashboard.filters.rep || 'كل المندوبين') + ' | ' + periodText;
  }
}

const SEARCHABLE_SELECT_IDS = ['customerFilter', 'productFilter', 'catFilter', 'regionFilter', 'cityFilter', 'repFilter'];

function normalizeArabic(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

function initSearchableSelects() {
  SEARCHABLE_SELECT_IDS.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel || sel.dataset.searchableInit) return;
    sel.dataset.searchableInit = 'true';

    // Hide native select visually
    sel.style.display = 'none';

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'ss-wrapper';
    wrapper.id = 'ss_wrapper_' + id;

    // Create trigger
    const trigger = document.createElement('div');
    trigger.className = 'ss-trigger';
    trigger.tabIndex = 0;
    const initialText = sel.options[sel.selectedIndex]?.text || sel.options[0]?.text || 'اختر...';
    trigger.innerHTML = `
      <span class="ss-trigger-text">${initialText}</span>
      <span class="ss-arrow">▼</span>
    `;

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'ss-dropdown';
    dropdown.innerHTML = `
      <div class="ss-search-wrap">
        <input type="text" class="ss-search-input" placeholder="بحث سريع..." />
        <span class="ss-search-icon">🔍</span>
      </div>
      <ul class="ss-options-list"></ul>
    `;

    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    sel.parentNode.insertBefore(wrapper, sel.nextSibling);

    const searchInput = dropdown.querySelector('.ss-search-input');
    const optionsList = dropdown.querySelector('.ss-options-list');

    // Toggle dropdown open/close
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.contains('open');
      // Close all other searchable dropdowns
      document.querySelectorAll('.ss-wrapper.open').forEach(w => {
        if (w !== wrapper) w.classList.remove('open');
      });
      if (isOpen) {
        wrapper.classList.remove('open');
      } else {
        wrapper.classList.add('open');
        searchInput.value = '';
        filterOptionsList(optionsList, '');
        searchInput.focus();
        const selected = optionsList.querySelector('.selected');
        if (selected) selected.scrollIntoView({ block: 'nearest' });
      }
    });

    // Keyboard support on trigger
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        trigger.click();
      }
    });

    // Prevent clicks inside dropdown from bubbling up and closing it
    dropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Search input typing
    searchInput.addEventListener('input', (e) => {
      e.stopPropagation();
      filterOptionsList(optionsList, searchInput.value);
    });

    // Keyboard navigation in search input
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        trigger.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const visibleItems = optionsList.querySelectorAll('.ss-option-item:not([style*="display: none"])');
        if (visibleItems.length === 1) {
          visibleItems[0].click();
        }
      }
    });

    // Initial build of options
    updateSearchableSelectUI(id);
  });

  // Global click outside to close dropdowns
  if (!window._ssGlobalClickListener) {
    window._ssGlobalClickListener = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ss-wrapper')) {
        document.querySelectorAll('.ss-wrapper.open').forEach(w => w.classList.remove('open'));
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.ss-wrapper.open').forEach(w => w.classList.remove('open'));
      }
    });
  }
}

function filterOptionsList(listEl, query) {
  const normQ = normalizeArabic(query);
  let matchCount = 0;
  listEl.querySelectorAll('.ss-option-item').forEach(item => {
    const text = item.dataset.searchNormalized || '';
    if (!normQ || text.includes(normQ)) {
      item.style.display = 'flex';
      matchCount++;
    } else {
      item.style.display = 'none';
    }
  });

  let noResults = listEl.querySelector('.ss-no-results');
  if (matchCount === 0) {
    if (!noResults) {
      noResults = document.createElement('li');
      noResults.className = 'ss-no-results';
      noResults.textContent = 'لا توجد نتائج مطابقة';
      listEl.appendChild(noResults);
    }
    noResults.style.display = 'block';
  } else if (noResults) {
    noResults.style.display = 'none';
  }
}

function updateSearchableSelectUI(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const wrapper = document.getElementById('ss_wrapper_' + id);
  if (!wrapper) return;

  const trigger = wrapper.querySelector('.ss-trigger');
  const triggerText = wrapper.querySelector('.ss-trigger-text');
  const optionsList = wrapper.querySelector('.ss-options-list');
  if (!optionsList || !triggerText) return;

  const selectedOpt = sel.options[sel.selectedIndex] || sel.options[0];
  let curText = selectedOpt?.text || 'اختر...';
  if (id === 'catFilter' && selectedOpt && selectedOpt.value) {
    const leaf = selectedOpt.dataset.leaf ? decodeURIComponent(selectedOpt.dataset.leaf) : selectedOpt.text;
    const root = selectedOpt.dataset.root ? decodeURIComponent(selectedOpt.dataset.root) : '';
    curText = (root && root !== leaf) ? `${leaf} (${root})` : leaf;
    if (trigger) trigger.title = selectedOpt.text;
  } else if (trigger) {
    trigger.removeAttribute('title');
  }
  triggerText.textContent = curText;

  const frag = document.createDocumentFragment();
  Array.from(sel.options).forEach((opt) => {
    const li = document.createElement('li');
    li.dataset.value = opt.value;

    if (id === 'catFilter') {
      if (!opt.value) {
        li.className = 'ss-option-item cat-item cat-all' + (opt.selected ? ' selected' : '');
        li.dataset.searchNormalized = normalizeArabic(opt.text);
        li.innerHTML = `
          <div class="cat-item-content">
            <div class="cat-item-main">
              <span class="cat-icon">🌐</span>
              <span class="cat-name-text" style="font-weight:700;">${opt.text}</span>
            </div>
          </div>
          <span class="cat-badge root" style="background:rgba(99, 102, 241, 0.15);color:#a5b4fc;border-color:rgba(99, 102, 241, 0.3);">الكل</span>
        `;
      } else {
        const level = Number(opt.dataset.level) || 0;
        const isRoot = opt.dataset.rootFlag === '1' || level === 0;
        const isParent = opt.dataset.parent === '1';
        const leaf = opt.dataset.leaf ? decodeURIComponent(opt.dataset.leaf) : opt.text;
        const parentPath = opt.dataset.parentPath ? decodeURIComponent(opt.dataset.parentPath) : '';
        const rootName = opt.dataset.root ? decodeURIComponent(opt.dataset.root) : '';

        li.className = 'ss-option-item cat-item' + (isRoot ? ' cat-root' : ' cat-child') + (opt.selected ? ' selected' : '');
        li.dataset.searchNormalized = normalizeArabic(opt.text + ' ' + leaf + ' ' + rootName + ' ' + parentPath);

        const indentPx = 14 + Math.min(level, 4) * 16;
        li.style.paddingRight = `${indentPx}px`;

        if (isRoot) {
          li.innerHTML = `
            <div class="cat-item-content">
              <div class="cat-item-main">
                <span class="cat-icon">📁</span>
                <span class="cat-name-text">${leaf}</span>
              </div>
            </div>
            <span class="cat-badge root">تصنيف رئيسي</span>
          `;
        } else {
          li.innerHTML = `
            <div class="cat-item-content">
              <div class="cat-item-main">
                <span class="cat-tree-branch">↳</span>
                <span class="cat-name-text">${leaf}</span>
              </div>
              ${parentPath ? `<span class="cat-path-breadcrumb">${parentPath}</span>` : ''}
            </div>
            ${isParent ? `<span class="cat-badge sub">فرعي</span>` : ''}
          `;
        }
      }
    } else {
      li.className = 'ss-option-item' + (opt.selected ? ' selected' : '');
      li.dataset.searchNormalized = normalizeArabic(opt.text);
      li.textContent = opt.text;
    }

    li.addEventListener('click', (e) => {
      e.stopPropagation();
      sel.value = opt.value;
      if (id === 'catFilter' && opt.value) {
        const leaf = opt.dataset.leaf ? decodeURIComponent(opt.dataset.leaf) : opt.text;
        const root = opt.dataset.root ? decodeURIComponent(opt.dataset.root) : '';
        triggerText.textContent = (root && root !== leaf) ? `${leaf} (${root})` : leaf;
        if (trigger) trigger.title = opt.text;
      } else {
        triggerText.textContent = opt.text;
        if (trigger) trigger.removeAttribute('title');
      }
      wrapper.classList.remove('open');

      optionsList.querySelectorAll('.ss-option-item').forEach(i => i.classList.remove('selected'));
      li.classList.add('selected');

      // Trigger change event to mark filters pending
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    frag.appendChild(li);
  });

  optionsList.innerHTML = '';
  optionsList.appendChild(frag);
}

function fillSelectOptions(id, items, defaultLabel, currentValue) {
  const select = document.getElementById(id);
  if (!select) return;
  const opts = ['<option value="">' + defaultLabel + '</option>'];
  (items || []).forEach(item => {
    const val = typeof item === 'object' ? (item.id ?? item.value ?? item.name) : item;
    const txt = typeof item === 'object' ? (item.name ?? item.label ?? item.value) : item;
    const sel = String(val) === String(currentValue) ? 'selected' : '';
    if (typeof item === 'object' && id === 'catFilter') {
      const level = item.level ?? 0;
      const isParent = item.isParent ? '1' : '0';
      const isRoot = item.isRoot ? '1' : (level === 0 ? '1' : '0');
      const leaf = encodeURIComponent(item.leafName || txt);
      const parentPath = encodeURIComponent(item.parentPath || '');
      const rootName = encodeURIComponent(item.rootName || '');
      opts.push(`<option value="${String(val).replaceAll('"', '&quot;')}" ${sel} data-level="${level}" data-parent="${isParent}" data-root-flag="${isRoot}" data-leaf="${leaf}" data-parent-path="${parentPath}" data-root="${rootName}">${txt}</option>`);
    } else {
      opts.push('<option value="' + String(val).replaceAll('"', '&quot;') + '" ' + sel + '>' + txt + '</option>');
    }
  });
  select.innerHTML = opts.join('');
  if (SEARCHABLE_SELECT_IDS.includes(id)) {
    updateSearchableSelectUI(id);
  }
}

function updateDayFilterOptions(selectedYear, selectedMonth) {
  const daySelect = document.getElementById('dayFilter');
  if (!daySelect) return;
  const currentDay = daySelect.value;
  const y = String(selectedYear || '').trim();
  const m = String(selectedMonth || '').trim();

  const allDays = liveDashboard.allDays || [];
  let filtered = [];

  if (y) {
    if (m) {
      // Both year and month selected -> only dates in that specific month and year
      const mPad = m.padStart(2, '0');
      const prefix = `${y}-${mPad}`;
      filtered = allDays.filter(d => {
        const val = typeof d === 'object' ? (d.value ?? d.id) : d;
        return String(val).startsWith(prefix);
      });

      // If no transactions in sample, generate calendar days 1..N of that month
      if (filtered.length === 0) {
        const daysInMonth = new Date(Number(y), Number(m), 0).getDate();
        for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) {
          const dPad = String(dayNum).padStart(2, '0');
          const iso = `${y}-${mPad}-${dPad}`;
          filtered.push({ value: iso, name: `${y}/${mPad}/${dPad}` });
        }
      }
    } else {
      // Year selected, all months -> strictly only days belonging to that year!
      filtered = allDays.filter(d => {
        const val = typeof d === 'object' ? (d.value ?? d.id) : d;
        return String(val).startsWith(`${y}-`);
      });

      if (filtered.length === 0) {
        for (let d = 1; d <= 31; d++) {
          filtered.push({ value: String(d), name: `اليوم ${d}` });
        }
      }
    }
  } else if (m) {
    // Month selected, any year
    const mPad = m.padStart(2, '0');
    filtered = allDays.filter(d => {
      const val = typeof d === 'object' ? (d.value ?? d.id) : d;
      return String(val).slice(5, 7) === mPad;
    });
    if (filtered.length === 0) {
      for (let d = 1; d <= 31; d++) {
        filtered.push({ value: String(d), name: `اليوم ${d}` });
      }
    }
  } else {
    // Neither year nor month selected
    filtered = allDays;
  }

  fillSelectOptions('dayFilter', filtered, 'كل الأيام', currentDay);
  liveDashboard.filters.day = daySelect.value;
}

function renderFilterDropdowns(opts) {
  if (!opts) return;
  liveDashboard.allDays = opts.days || [];
  liveDashboard.allYears = opts.years || [];
  liveDashboard.allMonths = opts.months || [];

  fillSelectOptions('regionFilter', opts.regions, 'جميع المناطق', liveDashboard.filters.region);
  fillSelectOptions('cityFilter', opts.cities, 'جميع المدن', liveDashboard.filters.city);
  fillSelectOptions('repFilter', opts.reps, 'جميع المندوبين', liveDashboard.filters.rep);
  fillSelectOptions('customerFilter', opts.customers, 'جميع العملاء', liveDashboard.filters.customer);
  fillSelectOptions('catFilter', opts.categories, 'جميع الفئات', liveDashboard.filters.category);
  fillSelectOptions('productFilter', opts.products, 'جميع المنتجات', liveDashboard.filters.product);
  fillSelectOptions('yearFilter', opts.years, 'كل السنوات', liveDashboard.filters.year);
  fillSelectOptions('monthFilter', opts.months, 'كل الأشهر', liveDashboard.filters.month);
  fillSelectOptions('periodFilter', opts.periods, 'كل الفترات', liveDashboard.filters.period);
  updateDayFilterOptions(liveDashboard.filters.year, liveDashboard.filters.month);
}

function renderDashboardDate(filters = {}, comparison = null) {
  const node = document.getElementById('dashboardDate');
  if (!node) return;
  const format = (value) => {
    if (!value) return '';
    const parts = String(value).split('-');
    if (parts.length === 3) {
      return toArabicDigits(`${parts[0]}/${parts[1]}/${parts[2]}`);
    }
    return toArabicDigits(value);
  };
  let text = filters.start && filters.end
    ? `${format(filters.start)} إلى ${format(filters.end)}`
    : 'الفترة الحالية';

  if (liveDashboard.filters.comparison !== 'none' && comparison && comparison.start && comparison.end) {
    const isLastYear = (comparison.mode === 'samePeriodLastYear') || (liveDashboard.filters.comparison === 'samePeriodLastYear');
    const compLabel = isLastYear ? 'العام الماضي' : 'الفترة السابقة';
    text += ` | مقارنة بـ (${compLabel}): ${format(comparison.start)} إلى ${format(comparison.end)}`;
  }
  node.textContent = text;
}

function renderKpis(kpis, comparisonKpis = null) {
  if (!kpis) return;
  const grid = document.getElementById('kpiGrid');
  if (!grid) return;

  const isNone = liveDashboard.filters.comparison === 'none';
  if (isNone) comparisonKpis = null;

  const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
  const compLabel = isLastYear ? 'العام الماضي' : 'الفترة السابقة';
  const isQty = liveDashboard.metric === 'quantity';
  const isSO = liveDashboard.filters.source === 'salesOrder';
  const soStatus = liveDashboard.filters.salesOrderStatus || 'all';
  const soStatusLabel = soStatus === 'post' ? 'أوامر بيع معتمدة فقط' : (soStatus === 'draft' ? 'عروض أسعار ومسودات' : 'كافة الأوامر (معتمدة ومسودة)');

  const drilldown = liveDashboard.data?.drilldown || [];
  const grossQty = kpis.grossQty ?? drilldown.reduce((sum, r) => sum + (r.grossQty || 0), 0);
  const returnsQty = kpis.returnsQty ?? drilldown.reduce((sum, r) => sum + (r.returnedQty || 0), 0);
  const netQty = kpis.netQty ?? Math.max(0, grossQty - returnsQty);
  const avgQtyInvoice = kpis.invoicesCount ? (grossQty / kpis.invoicesCount) : 0;

  const calcChange = (curr, prior) => {
    if (prior === undefined || prior === null) return null;
    const pctSign = isArabic() ? '٪' : '%';
    if (prior === 0) return curr > 0 ? toArabicDigits(`+100${pctSign}`) : toArabicDigits(`0.0${pctSign}`);
    const pct = ((curr - prior) / Math.abs(prior)) * 100;
    return toArabicDigits(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}${pctSign}`);
  };

  const grossDelta = comparisonKpis ? calcChange(kpis.gross, comparisonKpis.gross) : null;
  const netDelta = comparisonKpis ? calcChange(kpis.net, comparisonKpis.net) : null;
  const returnsDelta = comparisonKpis ? calcChange(kpis.returns, comparisonKpis.returns) : null;
  const collectedDelta = comparisonKpis ? calcChange(kpis.collected, comparisonKpis.collected) : null;
  const outstandingDelta = comparisonKpis ? calcChange(kpis.outstanding, comparisonKpis.outstanding) : null;
  const invoicesDelta = comparisonKpis ? calcChange(kpis.invoicesCount, comparisonKpis.invoicesCount) : null;
  const avgInvoiceDelta = comparisonKpis ? calcChange(kpis.avgInvoice, comparisonKpis.avgInvoice) : null;

  const cards = isQty ? [
    {
      key: 'gross',
      title: 'إجمالي الكميات المباعة',
      sub: isSO ? `إجمالي وحدات ${soStatusLabel}` : 'إجمالي الوحدات المباعة',
      val: formatNumber(grossQty) + ' قطعة',
      priorText: 'القيمة النقدية: ' + formatMoney(kpis.gross),
      icon: '📦',
      color: 'blue',
      extra: (isSO ? 'عدد الأوامر: ' : 'عدد الفواتير: ') + formatCount(kpis.invoicesCount),
      trend: isSO ? soStatusLabel : 'كميات معتمدة',
      up: true
    },
    {
      key: 'returns',
      title: isSO ? 'إجمالي الكميات المرتجعة' : 'إجمالي الكميات المرتجعة',
      sub: isSO ? 'وحدات مرتجعات أوامر البيع' : 'إجمالي الوحدات المرتجعة',
      val: formatNumber(returnsQty) + ' قطعة',
      priorText: 'القيمة النقدية: ' + formatMoney(kpis.returns),
      icon: '↩',
      color: 'red',
      extra: 'عدد المرتجعات: ' + formatCount(kpis.returnsCount),
      trend: grossQty ? toArabicDigits(((returnsQty / grossQty) * 100).toFixed(1) + (isArabic() ? '٪' : '%')) + ' نسبة إرجاع' : 'مرتجع',
      up: false
    },
    {
      key: 'net',
      title: 'صافي الكميات المباعة',
      sub: 'الصافي الفعلي بالوحدات',
      val: formatNumber(netQty) + ' قطعة',
      priorText: 'القيمة النقدية: ' + formatMoney(kpis.net),
      icon: '◈',
      color: 'blue',
      extra: 'الصافي الفعلي',
      trend: 'كميات حية',
      up: true
    },
    {
      key: 'collected',
      title: 'المبالغ المحصلة',
      sub: 'مدفوعات العملاء (inprocess و paid)',
      val: formatMoney(kpis.collected),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.collected)}` : '',
      icon: '💳',
      color: 'green',
      extra: (isArabic() ? 'نسبة التحصيل: ' : 'Collection rate: ') + toArabicDigits((kpis.collectionRate || 0).toFixed(1)) + (isArabic() ? '٪' : '%'),
      trend: collectedDelta ? `${collectedDelta} vs ${compLabel}` : (toArabicDigits(kpis.collectionRate) + (isArabic() ? '٪' : '%')),
      up: collectedDelta ? collectedDelta.startsWith('+') : true
    },
    {
      key: 'outstanding',
      title: isSO ? 'المبيعات غير المحصلة' : 'المديونية القائمة',
      sub: isSO ? 'المتبقي للتحصيل من الأوامر' : 'الرصيد المتبقي لدى العملاء',
      val: formatMoney(kpis.outstanding),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.outstanding)}` : '',
      icon: '⚠',
      color: 'red',
      extra: isSO ? 'أوامر غير محصلة' : 'مستحق السداد',
      trend: outstandingDelta ? `${outstandingDelta} vs ${compLabel}` : (isSO ? 'غير محصل' : 'أرصدة آجلة'),
      up: outstandingDelta ? outstandingDelta.startsWith('-') : false
    },
    {
      key: 'invoices',
      title: isSO ? 'إجمالي أوامر البيع وطلبات الإرجاع (Posted & Confirmed)' : 'إجمالي فواتير البيع والمرتجعات المرحّلة (Posted)',
      sub: isSO ? soStatusLabel : 'عدد الحركات المعتمدة: فواتير بيع وإشعارات خصم',
      val: isSO ? formatCount(kpis.invoicesCount) : formatCount(kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount)),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(isSO ? comparisonKpis.invoicesCount : (comparisonKpis.totalPostedCount || comparisonKpis.invoicesCount))} ${isSO ? 'مستند وأمر' : 'فاتورة ومستند'}` : '',
      icon: '▤',
      color: 'blue',
      extra: isSO ? (soStatus === 'post' ? 'أمر معتمد' : (soStatus === 'draft' ? 'مسودة/عرض سعر' : 'أمر بيع ومسودة')) : (kpis.returnsCount ? `${formatCount(kpis.invoicesCount)} فاتورة بيع | ${formatCount(kpis.returnsCount)} مرتجع` : 'فاتورة رسمية'),
      trend: invoicesDelta ? `${invoicesDelta} vs ${compLabel}` : 'مكتمل',
      up: invoicesDelta ? invoicesDelta.startsWith('+') : true
    },
    {
      key: 'returnsCount',
      title: 'عدد المرتجعات',
      sub: isSO ? 'إشعارات إرجاع أوامر البيع' : 'أوامر الإرجاع',
      val: formatCount(kpis.returnsCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(comparisonKpis.returnsCount)} إشعار` : '',
      icon: '↩',
      color: 'red',
      extra: isSO ? 'إشعار خصم دائن' : 'إشعار دائن',
      trend: 'مرتجع',
      up: false
    },
    {
      key: 'avgInvoice',
      title: isSO ? 'متوسط كمية أمر البيع' : 'متوسط كمية الفاتورة',
      sub: isSO ? 'متوسط الوحدات / أمر' : 'متوسط الوحدات / فاتورة بيع',
      val: formatNumber(avgQtyInvoice) + ' قطعة',
      priorText: 'المتوسط النقدي: ' + formatMoney(kpis.avgInvoice),
      icon: '📊',
      color: 'purple',
      extra: (isSO ? 'عدد أوامر البيع: ' : 'فواتير البيع: ') + formatCount(kpis.invoicesCount),
      trend: 'نشط',
      up: true
    }
  ] : [
    {
      key: 'gross',
      title: isSO ? 'إجمالي أوامر البيع' : 'إجمالي المبيعات',
      sub: isSO ? `إجمالي قيمة ${soStatusLabel}` : 'إجمالي الفواتير (قبل المرتجعات)',
      val: formatMoney(kpis.gross),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.gross)}` : (grossQty ? `${formatNumber(grossQty)} قطعة` : ''),
      icon: '💰',
      color: 'blue',
      extra: (isSO ? 'عدد أوامر البيع: ' : 'عدد فواتير البيع: ') + formatCount(kpis.invoicesCount),
      trend: grossDelta ? `${grossDelta} vs ${compLabel}` : (toArabicDigits(kpis.collectionRate) + (isArabic() ? '٪ تحصيل' : '% collected')),
      up: grossDelta ? grossDelta.startsWith('+') : true
    },
    {
      key: 'returns',
      title: 'إجمالي المرتجعات',
      sub: 'إشعارات الدائن ومرتجعات المبيعات المعتمدة',
      val: formatMoney(kpis.returns),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.returns)}` : (returnsQty ? `${formatNumber(returnsQty)} قطعة` : ''),
      icon: '↩',
      color: 'red',
      extra: 'إشعارات دائن معتمدة: ' + formatCount(kpis.returnsCount),
      trend: returnsDelta ? `${returnsDelta} vs ${compLabel}` : 'إشعارات دائن معتمدة',
      up: returnsDelta ? returnsDelta.startsWith('-') : false
    },
    {
      key: 'net',
      title: 'صافي المبيعات',
      sub: isSO ? 'المبيعات بعد الخصم' : 'المبيعات بعد الخصم (شامل الضريبة)',
      val: formatMoney(kpis.net),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.net)}` : (kpis.untaxed ? `قبل الضريبة: ${formatMoney(kpis.untaxed)}` : (netQty ? `${formatNumber(netQty)} قطعة` : '')),
      icon: '◈',
      color: 'blue',
      extra: 'الصافي الفعلي',
      trend: netDelta ? `${netDelta} vs ${compLabel}` : 'مبيعات حية',
      up: netDelta ? netDelta.startsWith('+') : true
    },
    {
      key: 'collected',
      title: 'المبالغ المحصلة',
      sub: 'مدفوعات العملاء (inprocess و paid)',
      val: formatMoney(kpis.collected),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.collected)}` : '',
      icon: '💳',
      color: 'green',
      extra: (isArabic() ? 'نسبة التحصيل: ' : 'Collection rate: ') + toArabicDigits((kpis.collectionRate || 0).toFixed(1)) + (isArabic() ? '٪' : '%'),
      trend: collectedDelta ? `${collectedDelta} vs ${compLabel}` : (toArabicDigits(kpis.collectionRate) + (isArabic() ? '٪' : '%')),
      up: collectedDelta ? collectedDelta.startsWith('+') : true
    },
    {
      key: 'outstanding',
      title: isSO ? 'المبيعات غير المحصلة' : 'المديونية القائمة',
      sub: isSO ? 'المتبقي للتحصيل من الأوامر' : 'الرصيد المتبقي لدى العملاء',
      val: formatMoney(kpis.outstanding),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.outstanding)}` : '',
      icon: '⚠',
      color: 'red',
      extra: isSO ? 'أوامر غير محصلة' : 'مستحق السداد (الرصيد المتبقي)',
      trend: outstandingDelta ? `${outstandingDelta} vs ${compLabel}` : (isSO ? 'غير محصل' : 'أرصدة آجلة'),
      up: outstandingDelta ? outstandingDelta.startsWith('-') : false
    },
    {
      key: 'invoices',
      title: isSO ? 'إجمالي أوامر البيع (Sale Orders)' : 'إجمالي فواتير البيع والمرتجعات المرحّلة (Posted)',
      sub: isSO ? soStatusLabel : 'عدد الحركات المعتمدة: فواتير بيع وإشعارات خصم',
      val: isSO ? formatCount(kpis.invoicesCount) : formatCount(kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount)),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(isSO ? comparisonKpis.invoicesCount : (comparisonKpis.totalPostedCount || comparisonKpis.invoicesCount))} ${isSO ? 'أمر بيع' : 'فاتورة ومستند'}` : '',
      icon: '▤',
      color: 'blue',
      extra: isSO ? (soStatus === 'post' ? 'أمر معتمد' : (soStatus === 'draft' ? 'مسودة/عرض سعر' : 'أمر بيع ومسودة')) : (kpis.returnsCount ? `${formatCount(kpis.invoicesCount)} فاتورة بيع | ${formatCount(kpis.returnsCount)} مرتجع` : 'فاتورة رسمية'),
      trend: invoicesDelta ? `${invoicesDelta} vs ${compLabel}` : 'مكتمل',
      up: invoicesDelta ? invoicesDelta.startsWith('+') : true
    },
    {
      key: 'returnsCount',
      title: 'عدد إشعارات المرتجعات',
      sub: 'إشعارات الدائن المعتمدة في Odoo',
      val: formatCount(kpis.returnsCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(comparisonKpis.returnsCount)} إشعار` : '',
      icon: '↩',
      color: 'red',
      extra: 'إشعار دائن معتمد',
      trend: 'مرتجع معتمد',
      up: false
    },
    {
      key: 'avgInvoice',
      title: isSO ? 'متوسط أمر البيع' : 'متوسط قيمة الفاتورة',
      sub: isSO ? 'متوسط القيمة / أمر بيع' : 'متوسط المبيعات / فاتورة بيع',
      val: formatMoney(kpis.avgInvoice),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.avgInvoice)}` : '',
      icon: '📊',
      color: 'purple',
      extra: (isSO ? 'عدد أوامر البيع: ' : 'فواتير البيع: ') + formatCount(kpis.invoicesCount),
      trend: avgInvoiceDelta ? `${avgInvoiceDelta} vs ${compLabel}` : 'نشط',
      up: avgInvoiceDelta ? avgInvoiceDelta.startsWith('+') : true
    }
  ];

  grid.innerHTML = cards.map(c => `
    <div class="kpi-card ${c.color} is-clickable" onclick="openKpiDrilldown('${c.key}', '${c.title}')" title="انقر لعرض القيود والمستندات المطابقة في أودو (Drill-down)">
      <div class="kpi-top">
        <div>
          <div class="kpi-sub">${c.sub}</div>
          <div class="kpi-title">${c.title}</div>
        </div>
        <div class="kpi-icon-wrap" onclick="event.stopPropagation(); openKpiDrilldown('${c.key}', '${c.title}')" title="عرض المستندات والقيود في أودو">
          <div class="kpi-icon">${c.icon}</div>
          <div class="kpi-icon-drill-badge">↗</div>
        </div>
      </div>
      <div class="kpi-value">${c.val}</div>
      <div class="kpi-full">${c.priorText || c.val}</div>
      <div class="kpi-footer">
        <div class="kpi-trend ${c.up ? 'up' : 'down'}">${c.trend}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="kpi-extra"><span>${c.extra}</span></div>
          <button class="kpi-drill-btn" onclick="event.stopPropagation(); openKpiDrilldown('${c.key}', '${c.title}')" title="عرض تفاصيل المستندات في أودو">
            <span>عرض القيود</span> ↗
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

function getChartThemeColors() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    isLight,
    textColor: isLight ? '#0f172a' : '#f8fafc',
    mutedColor: isLight ? '#475569' : '#94a3b8',
    axisColor: isLight ? '#1e293b' : '#e2e8f0',
    gridColor: isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.05)',
    legendColor: isLight ? '#0f172a' : '#e2e8f0',
    tooltipBg: isLight ? '#0f172a' : '#1e293b',
    tooltipTitle: '#ffffff',
    tooltipBody: '#e2e8f0',
    tooltipBorder: isLight ? 'rgba(255, 255, 255, 0.2)' : 'rgba(214, 170, 91, 0.4)',
    topProdBar: isLight ? '#2563eb' : '#d6aa5b',
    topProdHover: isLight ? '#1d4ed8' : '#e5be75',
    botProdBar: isLight ? '#dc2626' : '#b86b5c',
    botProdHover: isLight ? '#b91c1c' : '#c97e70',
    regGrossBar: isLight ? '#0284c7' : '#70aaa2',
    regNetBar: isLight ? '#2563eb' : '#d6aa5b',
    churnPriorBar: isLight ? '#94a3b8' : '#64748b',
    churnCurrentBar: isLight ? '#dc2626' : '#ef4444',
    growthCurrentBar: isLight ? '#16a34a' : '#22c55e'
  };
}

function renderProductChart(charts) {
  const canvas = document.getElementById('productChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const isTop = liveDashboard.productMode === 'top';
  const metric = liveDashboard.productMetric || liveDashboard.metric || 'amount';
  const isQty = metric === 'quantity';
  const cColors = getChartThemeColors();

  // Pool all available products across payload arrays to ensure complete data availability
  const pool = [
    ...(charts.topProductsByQty || []),
    ...(charts.topProductsByAmount || []),
    ...(charts.topProducts || []),
    ...(charts.bottomProductsByQty || []),
    ...(charts.bottomProductsByAmount || []),
    ...(charts.bottomProducts || [])
  ];

  // Deduplicate products by name while preserving complete amount, quantity & count info
  const productMap = new Map();
  pool.forEach(p => {
    if (!p || !p.name) return;
    const existing = productMap.get(p.name);
    if (!existing) {
      productMap.set(p.name, {
        name: p.name,
        amount: Number(p.amount) || 0,
        quantity: Number(p.quantity) || 0,
        count: Number(p.count) || 0
      });
    } else {
      if (!existing.amount && p.amount) existing.amount = Number(p.amount) || 0;
      if (!existing.quantity && p.quantity) existing.quantity = Number(p.quantity) || 0;
      if (!existing.count && p.count) existing.count = Number(p.count) || 0;
    }
  });

  const allProducts = [...productMap.values()];

  // Strict dynamic sorting and ranking according to chosen metric
  let products = [];
  if (isTop) {
    if (isQty && charts.topProductsByQty && charts.topProductsByQty.length) {
      products = [...charts.topProductsByQty]
        .sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0))
        .slice(0, 10);
    } else if (!isQty && charts.topProductsByAmount && charts.topProductsByAmount.length) {
      products = [...charts.topProductsByAmount]
        .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
        .slice(0, 10);
    } else {
      products = allProducts
        .sort((a, b) => {
          const valA = isQty ? (Number(a.quantity) || 0) : (Number(a.amount) || 0);
          const valB = isQty ? (Number(b.quantity) || 0) : (Number(b.amount) || 0);
          return valB - valA;
        })
        .slice(0, 10);
    }
  } else {
    // Bottom products: non-zero, sorted ascending
    if (isQty && charts.bottomProductsByQty && charts.bottomProductsByQty.length) {
      products = [...charts.bottomProductsByQty]
        .filter(p => (Number(p.quantity) || 0) > 0)
        .sort((a, b) => (Number(a.quantity) || 0) - (Number(b.quantity) || 0))
        .slice(0, 10);
    } else if (!isQty && charts.bottomProductsByAmount && charts.bottomProductsByAmount.length) {
      products = [...charts.bottomProductsByAmount]
        .filter(p => (Number(p.amount) || 0) > 0)
        .sort((a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0))
        .slice(0, 10);
    } else {
      products = allProducts
        .filter(p => (isQty ? (Number(p.quantity) || 0) : (Number(p.amount) || 0)) > 0)
        .sort((a, b) => {
          const valA = isQty ? (Number(a.quantity) || 0) : (Number(a.amount) || 0);
          const valB = isQty ? (Number(b.quantity) || 0) : (Number(b.amount) || 0);
          return valA - valB;
        })
        .slice(0, 10);
    }
  }

  // Update chart title with the active metric and mode
  const titleEl = document.getElementById('prodChartTitle');
  if (titleEl) {
    const baseTitle = isTop ? 'أفضل المنتجات مبيعاً' : 'أقل المنتجات مبيعاً';
    const subTitle = isQty ? ' (بالكمية)' : ' (بالقيمة)';
    titleEl.textContent = baseTitle + subTitle;
  }

  const labels = products.map(p => p.name);
  const values = products.map(p => isQty ? (Number(p.quantity) || 0) : (Number(p.amount) || 0));

  window._lastProductChartData = products.map((p, idx) => ({
    'الترتيب': idx + 1,
    'المنتج': p.name,
    'الكمية المباعة (قطعة)': p.quantity,
    'صافي القيمة (ج.م)': p.amount,
    'عدد الحركات': p.count
  }));

  if (liveDashboard.charts.product) {
    liveDashboard.charts.product.destroy();
  }

  liveDashboard.charts.product = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: isQty ? 'الكمية المباعة (قطعة)' : 'صافي المبيعات (ج.م)',
        data: values,
        backgroundColor: isTop ? cColors.topProdBar : cColors.botProdBar,
        hoverBackgroundColor: isTop ? cColors.topProdHover : cColors.botProdHover,
        borderRadius: 4,
        barThickness: 16,
        maxBarThickness: 18
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 4,
          right: 16,
          top: 4,
          bottom: 4
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          rtl: true,
          textDirection: 'rtl',
          backgroundColor: cColors.tooltipBg,
          titleColor: cColors.tooltipTitle,
          bodyColor: cColors.tooltipBody,
          borderColor: cColors.tooltipBorder,
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          titleFont: { family: "'Cairo', sans-serif", size: 12, weight: '700' },
          bodyFont: { family: "'Cairo', sans-serif", size: 11 },
          callbacks: {
            title: (items) => {
              const p = products[items[0]?.dataIndex];
              return p ? p.name : '';
            },
            label: (ctx) => {
              const p = products[ctx.dataIndex];
              if (!p) return '';
              const lines = [];
              if (isQty) {
                lines.push(`📦 الكمية المباعة: ${formatNumber(p.quantity, 0)} قطعة`);
                lines.push(`💰 صافي القيمة: ${formatMoney(p.amount)}`);
              } else {
                lines.push(`💰 صافي القيمة: ${formatMoney(p.amount)}`);
                lines.push(`📦 الكمية المباعة: ${formatNumber(p.quantity, 0)} قطعة`);
              }
              if (p.count) lines.push(`📑 عدد الحركات: ${formatCount(p.count)}`);
              return lines;
            }
          }
        }
      },
      scales: {
        y: {
          grid: {
            display: false,
            drawBorder: false
          },
          ticks: {
            autoSkip: false, // CRITICAL: Never omit or skip any product label!
            color: cColors.textColor, // High contrast: dark slate in light mode, crisp white in dark mode
            padding: 8,
            font: {
              family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
              size: 11,
              weight: '700'
            },
            callback: function(val) {
              const label = this.getLabelForValue(val) || '';
              return label.length > 28 ? label.slice(0, 26) + '…' : label;
            }
          }
        },
        x: {
          grid: {
            color: cColors.gridColor,
            drawBorder: false
          },
          ticks: {
            autoSkip: true,
            maxTicksLimit: 5,
            color: cColors.mutedColor,
            font: {
              family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
              size: 10,
              weight: '600'
            },
            callback: (v) => isQty ? formatCompactQtyAxis(v) : formatCompactMoneyAxis(v)
          }
        }
      },
      onClick: (_event, elements) => {
        if (!elements || !elements.length) return;
        const product = products[elements[0].index];
        const card = document.getElementById('productDetailCard');
        if (!product || !card) return;
        card.hidden = false;
        card.innerHTML = `
          <div class="chart-detail-title">${product.name}</div>
          <div>
            <div class="chart-detail-label">الكمية المباعة</div>
            <div class="chart-detail-value" style="color:#60a5fa;">${formatNumber(product.quantity, 0)} قطعة</div>
          </div>
          <div>
            <div class="chart-detail-label">صافي القيمة</div>
            <div class="chart-detail-value" style="color:var(--ks-kinpaku);">${formatMoney(product.amount)}</div>
          </div>
          <div>
            <div class="chart-detail-label">عدد الحركات</div>
            <div class="chart-detail-value">${product.count || '—'}</div>
          </div>
        `;
      }
    }
  });

  // Dynamically update growth/share percentage row below the chart
  const total = products.reduce((acc, p) => acc + (isQty ? (Number(p.quantity) || 0) : (Number(p.amount) || 0)), 0) || 1;
  const growthRow = document.getElementById('prodGrowthRow');
  if (growthRow) {
    if (products.length > 0) {
      growthRow.innerHTML = products.slice(0, 5).map((p, idx) => {
        const val = isQty ? (Number(p.quantity) || 0) : (Number(p.amount) || 0);
        const pct = toArabicDigits(((val / total) * 100).toFixed(1));
        const shortName = p.name.length > 14 ? p.name.slice(0, 12) + '…' : p.name;
        return `<div style="flex:1;min-width:65px;text-align:center;padding:4px 6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;" title="${p.name} - المركز #${toArabicDigits(idx + 1)}">
          <div style="color:var(--ks-text-muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortName}</div>
          <strong style="color:var(--ks-kinpaku);font-size:11px;font-family:'Albert Sans',sans-serif;">${pct}%</strong>
        </div>`;
      }).join('');
    } else {
      growthRow.innerHTML = '';
    }
  }

  // Sync local tab buttons on the chart card
  const valBtn = document.getElementById('prodMetricValBtn');
  const qtyBtn = document.getElementById('prodMetricQtyBtn');
  if (valBtn) valBtn.classList.toggle('active-top', !isQty);
  if (qtyBtn) qtyBtn.classList.toggle('active-top', isQty);

  const topBtn = document.getElementById('tabTop');
  const botBtn = document.getElementById('tabBot');
  if (topBtn) topBtn.classList.toggle('active-top', isTop);
  if (botBtn) botBtn.classList.toggle('active-bot', !isTop);
}

function formatCustomerChartLabel(name) {
  if (!name) return 'عميل';
  const clean = String(name).trim();
  if (clean.length <= 16) return clean;
  const words = clean.split(' ').filter(Boolean);
  if (words.length >= 2) {
    const mid = Math.ceil(words.length / 2);
    const line1 = words.slice(0, mid).join(' ');
    const line2 = words.slice(mid).join(' ');
    const trim1 = line1.length > 20 ? line1.slice(0, 18) + '…' : line1;
    const trim2 = line2.length > 20 ? line2.slice(0, 18) + '…' : line2;
    return [trim1, trim2];
  }
  return clean.length > 20 ? clean.slice(0, 18) + '…' : clean;
}

function renderGrowthChart(charts) {
  const canvas = document.getElementById('growthChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const grouping = liveDashboard.growthGrouping || 'churn';
  const isCustomerLevel = grouping === 'churn' || grouping === 'decline' || grouping === 'growth';

  // Dynamically update card title to explicitly reflect customer-level analysis
  const titleEl = document.getElementById('growthChartTitle');
  if (titleEl) {
    if (grouping === 'churn') {
      titleEl.textContent = 'تحذيرات تراجع العملاء (مقارنة كل عميل بالفترة السابقة)';
    } else if (grouping === 'decline') {
      titleEl.textContent = 'أكبر العملاء انخفاضاً (مقارنة كل عميل بالفترة السابقة)';
    } else if (grouping === 'growth') {
      titleEl.textContent = 'أعلى العملاء نمواً (مقارنة كل عميل بالفترة السابقة)';
    } else if (grouping === 'month') {
      titleEl.textContent = 'التطور الزمني للمبيعات (شهرياً)';
    }
  }

  if (liveDashboard.charts.growth) {
    liveDashboard.charts.growth.destroy();
  }

  if (isCustomerLevel) {
    // ── Customer-Level Churn & Growth Analysis ──
    const custData = charts.customerGrowth?.[grouping] || null;
    let items = [];

    if (grouping === 'churn' && liveDashboard.selectedChurnClient) {
      items = [liveDashboard.selectedChurnClient];
    } else if (custData && Array.isArray(custData.items) && custData.items.length) {
      items = custData.items.slice(0, 12);
    } else {
      // Fallback from raw customers or churn warnings if chart sub-object is absent
      const allWarnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || liveDashboard.data?.churn || [];
      const allCustomers = liveDashboard.data?.growthAnalysis?.customers || [];

      if (grouping === 'churn') {
        items = allWarnings.slice(0, 12);
      } else if (grouping === 'decline') {
        items = allCustomers
          .filter(c => (c.growthAmount < 0 || c.growthPercent < 0))
          .sort((a, b) => (b.lossAmount || (b.previousSales - b.currentSales)) - (a.lossAmount || (a.previousSales - a.currentSales)))
          .slice(0, 12);
      } else if (grouping === 'growth') {
        items = allCustomers
          .filter(c => c.growthAmount > 0)
          .sort((a, b) => b.growthAmount - a.growthAmount)
          .slice(0, 12);
      }
    }

    if (!items.length) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      liveDashboard.charts.growth = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: ['لا توجد تحذيرات تراجع تطابق الفلاتر الحالية'],
          datasets: [{ data: [0], backgroundColor: 'transparent' }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
      });
      return;
    }

    const isSingleClient = items.length === 1 && liveDashboard.selectedChurnClient;
    const labels = items.map(c => {
      const name = c.name || 'عميل';
      if (isSingleClient) return `${name} (تراجع: ${c.growthPercent}%)`;
      return formatCustomerChartLabel(name);
    });
    const prevData = items.map(c => c.previousSales || 0);
    const currData = items.map(c => c.currentSales || 0);

    window._lastGrowthChartData = items.map(c => ({
      'العميل': c.name,
      'المحافظة': c.state || 'غير محدد',
      'المندوب': c.rep || 'غير محدد',
      'مبيعات الفترة السابقة (ج.م)': c.previousSales,
      'مبيعات الفترة الحالية (ج.م)': c.currentSales,
      'قيمة التغير (ج.م)': c.growthAmount,
      'نسبة التغير': (c.growthPercent ?? 0) + '%',
      'مستوى الخطورة': c.risk || (c.growthAmount < 0 ? 'تراجع' : 'نمو')
    }));

    const isGrowth = grouping === 'growth';
    const cColors = getChartThemeColors();
    const currColor = isGrowth ? cColors.growthCurrentBar : cColors.churnCurrentBar;
    const currLabel = isGrowth ? 'مبيعات الفترة الحالية (نمو)' : 'مبيعات الفترة الحالية (تراجع)';

    let datasets = [];
    if (isSingleClient) {
      const c = items[0];
      const isStopped = Number(c.currentSales || 0) === 0;
      datasets = [
        {
          label: 'مبيعات الفترة السابقة',
          data: [c.previousSales || 0],
          backgroundColor: cColors.churnPriorBar,
          borderRadius: 6,
          maxBarThickness: 42
        },
        {
          label: isStopped ? 'مبيعات الفترة الحالية (0 ج.م - توقف تام)' : 'مبيعات الفترة الحالية',
          data: [c.currentSales || 0],
          backgroundColor: isStopped ? 'rgba(239, 68, 68, 0.45)' : cColors.churnCurrentBar,
          borderColor: isStopped ? '#ef4444' : 'transparent',
          borderWidth: isStopped ? 2 : 0,
          borderRadius: 6,
          maxBarThickness: 42
        },
        {
          label: 'قيمة التراجع في المبيعات',
          data: [c.lossAmount || Math.abs(c.growthAmount || (c.currentSales - c.previousSales))],
          backgroundColor: '#f59e0b',
          borderRadius: 6,
          maxBarThickness: 42
        }
      ];
    } else {
      datasets = [
        {
          label: 'مبيعات الفترة السابقة',
          data: prevData,
          backgroundColor: cColors.churnPriorBar,
          borderRadius: 4,
          maxBarThickness: 16
        },
        {
          label: currLabel,
          data: currData,
          backgroundColor: currColor,
          borderRadius: 4,
          maxBarThickness: 16
        }
      ];
    }

    liveDashboard.charts.growth = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            left: 4,
            right: 8,
            top: 4,
            bottom: 6
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 10,
              padding: 8,
              color: cColors.legendColor,
              font: { family: "'Cairo', sans-serif", size: 11, weight: '600' }
            }
          },
          tooltip: {
            rtl: true,
            textDirection: 'rtl',
            backgroundColor: cColors.tooltipBg,
            titleColor: cColors.tooltipTitle,
            bodyColor: cColors.tooltipBody,
            borderColor: isGrowth ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)',
            borderWidth: 1,
            padding: 10,
            boxPadding: 4,
            titleFont: { family: "'Cairo', sans-serif", size: 12, weight: '700' },
            bodyFont: { family: "'Cairo', sans-serif", size: 11 },
            callbacks: {
              title: (ctx) => items[ctx[0]?.dataIndex]?.name || '',
              afterTitle: (ctx) => {
                const item = items[ctx[0]?.dataIndex];
                if (!item) return '';
                return `📍 المحافظة: ${item.state || 'غير محدد'} | 👤 المندوب: ${item.rep || 'غير محدد'}`;
              },
              label: (ctx) => {
                const item = items[ctx.dataIndex];
                if (ctx.datasetIndex === 1 && item && Number(item.currentSales || 0) === 0) {
                  return ` ⚠️ مبيعات الفترة الحالية: 0 ج.م (توقف تام عن الشراء)`;
                }
                return ` ${ctx.dataset.label}: ${formatMoney(ctx.raw)}`;
              },
              afterBody: (ctx) => {
                const item = items[ctx[0]?.dataIndex];
                if (!item) return '';
                const diff = item.growthAmount;
                const pct = item.growthPercent;
                const changeLabel = diff < 0 ? `🔻 قيمة التراجع: -${formatMoney(Math.abs(diff))}` : `🟢 قيمة النمو: +${formatMoney(diff)}`;
                const riskLabel = item.risk ? ` | الخطر: ${item.risk}` : '';
                return `${changeLabel} (${pct}%)${riskLabel}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: cColors.gridColor,
              drawBorder: false
            },
            ticks: {
              autoSkip: false, // CRITICAL: Never skip or omit any customer label!
              color: cColors.textColor,
              maxRotation: 45,
              minRotation: 30,
              padding: 6,
              font: {
                family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
                size: 10,
                weight: '700'
              }
            }
          },
          y: {
            grid: {
              color: cColors.gridColor,
              drawBorder: false
            },
            ticks: {
              color: cColors.mutedColor,
              font: {
                family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
                size: 10,
                weight: '600'
              },
              callback: (v) => formatCompactMoneyAxis(v)
            }
          }
        },
        onClick: (_event, elements) => {
          const idx = elements[0]?.index;
          if (idx === undefined || !items[idx]) return;
          const cust = items[idx];
          const select = document.getElementById('churnCustomerFilter');
          if (select) {
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].text.includes(cust.name)) {
                select.selectedIndex = i;
                select.onchange?.();
                break;
              }
            }
          }
        }
      }
    });
  } else {
    // ── Monthly / Time-series Timeline Fallback ──
    const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
    const compLegend = isLastYear ? 'مبيعات نفس الفترة من العام الماضي' : 'مبيعات الفترة السابقة';

    const monthLabels = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const series = charts.growthTimeSeries?.[grouping] || charts.growthTimeSeries?.month || [];
    const fallback = (charts.months || monthLabels).map((label, index) => ({
      label,
      currentSales: charts.monthlyNet?.[index] || 0,
      previousSales: charts.monthlyGross?.[index] || 0,
      growthPercent: null
    }));
    const rows = series.length ? series : fallback;
    const labels = rows.map(row => row.label);
    const netData = rows.map(row => row.currentSales);
    const comparisonData = rows.map(row => row.previousSales);

    const isNone = liveDashboard.filters.comparison === 'none';
    window._lastGrowthChartData = labels.map((m, i) => {
      const item = {
        'الشهر': m,
        'الفترة الحالية': netData[i] || 0
      };
      if (!isNone) {
        item['فترة المقارنة'] = comparisonData[i] || 0;
        item['نسبة التغير'] = rows[i]?.growthPercent ?? null;
      }
      return item;
    });

    const datasets = [
      {
        label: 'مبيعات الفترة الحالية',
        data: netData,
        borderColor: '#d6aa5b',
        backgroundColor: 'rgba(214,170,91,0.16)',
        fill: true,
        tension: 0.35
      }
    ];

    if (liveDashboard.filters.comparison !== 'none') {
      datasets.push({
        label: compLegend,
        data: comparisonData,
        borderColor: '#70aaa2',
        borderDash: [5, 5],
        tension: 0.35,
        fill: false
      });
    }

    const cColors = getChartThemeColors();
    liveDashboard.charts.growth = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: cColors.legendColor,
              font: { family: "'Cairo', sans-serif", size: 11, weight: '600' }
            }
          },
          tooltip: {
            rtl: true,
            textDirection: 'rtl',
            backgroundColor: cColors.tooltipBg,
            titleColor: cColors.tooltipTitle,
            bodyColor: cColors.tooltipBody,
            borderColor: cColors.tooltipBorder,
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${formatMoney(ctx.raw)}`
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: cColors.gridColor,
              drawBorder: false
            },
            ticks: {
              autoSkip: false,
              color: cColors.textColor,
              font: {
                family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
                size: 10,
                weight: '700'
              }
            }
          },
          y: {
            grid: {
              color: cColors.gridColor,
              drawBorder: false
            },
            ticks: {
              color: cColors.mutedColor,
              font: {
                family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
                size: 10,
                weight: '600'
              },
              callback: (v) => formatCompactMoneyAxis(v)
            }
          }
        }
      }
    });
  }
}

function renderRegionalChart(charts) {
  const canvas = document.getElementById('regionalChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const isQty = liveDashboard.metric === 'quantity';
  const cColors = getChartThemeColors();
  const regional = (charts.regional || []).slice(0, 16);
  const labels = regional.map(r => r.name);
  const primaryData = isQty ? regional.map(r => r.grossQty || 0) : regional.map(r => r.sales);
  const secondaryData = isQty ? regional.map(r => r.netQty || 0) : regional.map(r => r.collected);

  const countBadge = document.getElementById('geoChartCountBadge');
  if (countBadge && charts.regional) {
    countBadge.textContent = `📍 ${formatCount(charts.regional.length)} مدينة / منطقة`;
  }

  window._lastGeoChartData = regional.map(r => ({
    'المدينة / المنطقة': r.name,
    'المبيعات': r.sales,
    'إجمالي الكمية المباعة': r.grossQty || 0,
    'صافي الكمية المباعة': r.netQty || 0,
    'المحصل': r.collected,
    'المديونية': r.outstanding,
    'نسبة التحصيل': r.rate + '%'
  }));

  if (liveDashboard.charts.regional) {
    liveDashboard.charts.regional.destroy();
  }

  liveDashboard.charts.regional = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: isQty ? 'إجمالي الكمية المباعة' : 'المبيعات', data: primaryData, backgroundColor: cColors.regGrossBar },
        { label: isQty ? 'صافي الكمية المباعة' : 'المحصل', data: secondaryData, backgroundColor: cColors.regNetBar }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 4,
          right: 8,
          top: 4,
          bottom: 6
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: cColors.legendColor,
            font: { family: "'Cairo', sans-serif", size: 11, weight: '600' }
          }
        },
        tooltip: {
          rtl: true,
          textDirection: 'rtl',
          backgroundColor: cColors.tooltipBg,
          titleColor: cColors.tooltipTitle,
          bodyColor: cColors.tooltipBody,
          borderColor: cColors.tooltipBorder,
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => ctx.dataset.label + ': ' + (isQty ? (formatNumber(ctx.raw) + ' قطعة') : formatMoney(ctx.raw))
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: cColors.gridColor,
            drawBorder: false
          },
          ticks: {
            autoSkip: false, // Never skip any city!
            color: cColors.textColor,
            maxRotation: 40,
            minRotation: 20,
            font: {
              family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
              size: 10,
              weight: '700'
            }
          }
        },
        y: {
          grid: {
            color: cColors.gridColor,
            drawBorder: false
          },
          ticks: {
            color: cColors.mutedColor,
            font: {
              family: "'Cairo', 'Segoe UI', Tahoma, sans-serif",
              size: 10,
              weight: '600'
            },
            callback: (v) => isQty ? formatCompactQtyAxis(v) : formatCompactMoneyAxis(v)
          }
        }
      }
    }
  });

  const miniGrid = document.getElementById('regionMiniGrid');
  if (miniGrid) {
    miniGrid.innerHTML = regional.slice(0, 8).map(r => `
      <div class="region-mini">
        <div class="region-mini-name">${r.name}</div>
        <div class="region-mini-val">${isQty ? (formatNumber(r.netQty || 0) + ' قطعة') : formatMoney(r.sales)}</div>
        <div class="region-mini-rate ${r.rate >= 50 ? 'good' : 'bad'}">${isQty ? ((r.grossQty ? Math.round((r.netQty / r.grossQty) * 100) : 0) + '%') : (r.rate + '%')}</div>
      </div>
    `).join('');
  }
}

function toggleRepRow(name) {
  if (liveDashboard.expandedReps.has(name)) {
    liveDashboard.expandedReps.delete(name);
  } else {
    liveDashboard.expandedReps.add(name);
  }
  renderRepsTable(liveDashboard.data?.reps);
}

function renderRepsTable(reps) {
  const tbody = document.querySelector('#repList tbody');
  if (!tbody || !reps) return;
  window._lastRepsData = reps;

  const isSalesOrder = (liveDashboard?.filters?.source === 'salesOrder');
  const docTypeLabel = isSalesOrder ? 'أمر بيع' : 'فاتورة';

  tbody.innerHTML = reps.map((rep, idx) => {
    const isExpanded = liveDashboard.expandedReps.has(rep.name);
    const pctSign = isArabic() ? '٪' : '%';
    const hasTarget = Boolean(rep.hasTarget && rep.target && Number(rep.target) > 0);

    const contribPct = (rep.contributionRate !== null && rep.contributionRate !== undefined)
      ? Number(rep.contributionRate)
      : (rep.percentage !== null && !hasTarget ? Number(rep.percentage) : 0);

    const displayPct = hasTarget ? Number(rep.percentage || 0) : contribPct;
    const pctDisplay = `${toArabicDigits(displayPct)}${pctSign}`;
    const barWidth = Math.max(0, Math.min(displayPct, 100));

    const cls = hasTarget
      ? (displayPct >= 100 ? 'over' : displayPct >= 80 ? 'ok' : 'low')
      : (contribPct >= 20 ? 'over' : contribPct >= 5 ? 'ok' : 'low');

    const kpiText = hasTarget
      ? (rep.kpi || (displayPct >= 100 ? 'متفوق' : displayPct >= 80 ? 'محقق للهدف' : 'يحتاج متابعة'))
      : (rep.kpi || 'مبيعات مؤكدة');

    const docCount = rep.invoicesCount || rep.count || 0;
    const explanationText = hasTarget
      ? `تحقيق ${toArabicDigits(displayPct)}${pctSign} من الهدف البيعي (${formatCount(docCount)} ${docTypeLabel})`
      : `مساهمة ${toArabicDigits(contribPct)}${pctSign} من إجمالي المبيعات (${formatCount(docCount)} ${docTypeLabel})`;

    const collectedDisplay = (rep.collected !== null && rep.collected !== undefined) ? formatMoney(rep.collected) : '-';
    const remainingDisplay = (rep.remaining !== null && rep.remaining !== undefined) ? formatMoney(rep.remaining) : '-';
    const grossDisplay = (rep.gross !== undefined && rep.gross !== null) ? formatMoney(rep.gross) : formatMoney(rep.achieved || 0);
    const returnsDisplay = (rep.returns !== undefined && rep.returns !== null) ? formatMoney(rep.returns) : formatMoney(0);
    const collectionRateDisplay = `${toArabicDigits(rep.achieved > 0 ? Number(((rep.collected || 0) / rep.achieved * 100).toFixed(1)) : 0)}${pctSign}`;
    const targetDisplay = hasTarget ? formatMoney(rep.target) : 'بدون قيود Target (مبيعات مؤكدة)';

    const escapedName = (rep.name || 'مندوب غير محدد').replace(/'/g, "\\'");

    return `
      <tr class="rep-main-row ${isExpanded ? 'is-expanded' : ''}" onclick="toggleRepRow('${escapedName}')">
        <td>
          <span class="rep-toggle">${isExpanded ? '▲' : '▼'}</span>
          <span class="rep-rank">#${toArabicDigits(idx + 1)}</span>
          <span class="rep-name">${rep.name || 'غير محدد'} <span style="opacity:0.75;font-weight:600;font-size:0.85em;">(${formatCount(docCount)})</span></span>
        </td>
        <td>
          <span class="rep-bar-track">
            <span class="rep-bar-fill ${cls}" style="display:block;width:${barWidth}%;"></span>
          </span>
          <span class="rep-pct ${cls}">${pctDisplay} ${hasTarget ? '<small style="opacity:0.75;">(هدف)</small>' : '<small style="opacity:0.75;">(مساهمة)</small>'}</span>
        </td>
        <td class="rep-value">${formatMoney(rep.achieved || 0)}</td>
        <td class="rep-explanation">${explanationText}</td>
      </tr>
      <tr class="rep-detail-row ${isExpanded ? 'is-expanded' : ''}">
        <td colspan="4">
          <div class="rep-detail-panel">
            <div class="rep-detail-card kpi">
              <span class="rep-detail-label">مؤشر الأداء</span>
              <span class="rep-detail-value">${kpiText}</span>
            </div>
            <div class="rep-detail-card target">
              <span class="rep-detail-label">الهدف البيعي (Odoo)</span>
              <span class="rep-detail-value">${targetDisplay}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">صافي المبيعات (أودو)</span>
              <span class="rep-detail-value">${formatMoney(rep.achieved || 0)}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">إجمالي الفواتير</span>
              <span class="rep-detail-value">${grossDisplay}</span>
            </div>
            <div class="rep-detail-card gap">
              <span class="rep-detail-label">المرتجعات</span>
              <span class="rep-detail-value">${returnsDisplay}</span>
            </div>
            <div class="rep-detail-card kpi">
              <span class="rep-detail-label">المبلغ المحصل</span>
              <span class="rep-detail-value">${collectedDisplay}</span>
            </div>
            <div class="rep-detail-card gap">
              <span class="rep-detail-label">المديونية المتبقية</span>
              <span class="rep-detail-value">${remainingDisplay}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">نسبة التحصيل</span>
              <span class="rep-detail-value">${collectionRateDisplay}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">نسبة المساهمة من المبيعات</span>
              <span class="rep-detail-value">${toArabicDigits(contribPct)}${pctSign}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">عدد المستندات</span>
              <span class="rep-detail-value">${formatCount(rep.count || 0)} ${docTypeLabel}</span>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function getDrilldownGroupByKeys() {
  const select = document.getElementById('groupByFilter');
  if (!select) return ['region', 'city', 'rep'];
  const selected = Array.from(select.selectedOptions).map(opt => opt.value);
  return selected.length ? selected : ['region', 'city', 'rep'];
}

function onGroupByFilterChange() {
  if (!liveDashboard.expandedDrillPaths) liveDashboard.expandedDrillPaths = new Set();
  liveDashboard.expandedDrillPaths.clear();
  renderDrilldownTable();
}

function parseClientCity(cityName, customerName, stateName) {
  let c = (cityName && typeof cityName === 'string' && cityName.trim() && cityName.trim() !== 'غير محدد') ? cityName.trim() : '';
  if (c && stateName && c.replace(/\s+/g, '') === stateName.replace(/\s+/g, '')) {
    c = '';
  }
  if (!c && customerName) {
    if (customerName.includes('/')) {
      const parts = customerName.split('/');
      if (parts.length > 1) {
        c = parts[parts.length - 1].trim().split('-')[0].trim();
      }
    } else if (customerName.includes('(') && customerName.includes(')')) {
      const match = customerName.match(/\((.*?)\)/);
      if (match) {
        c = match[1].split('-')[0].trim();
      }
    } else if (customerName.includes('-')) {
      const parts = customerName.split('-');
      if (parts.length > 1) {
        c = parts[1].trim();
      }
    }
  }
  if (c) {
    const govSuffixes = ['المنيا', 'بني سويف', 'بنى سويف', 'أسيوط', 'اسيوط', 'سوهاج', 'قنا', 'الأقصر', 'الاقصر', 'أسوان', 'اسوان', 'الجيزة', 'القاهرة'];
    govSuffixes.forEach(gov => {
      if (c.endsWith(' ' + gov) && c.length > gov.length + 2) {
        c = c.slice(0, -(gov.length + 1)).trim();
      }
    });
  }
  return c || 'غير محدد';
}

function getDrilldownFlatRecords() {
  const d = liveDashboard.data;
  const list = (d?.customerBreakdown && Array.isArray(d.customerBreakdown) && d.customerBreakdown.length > 0)
    ? d.customerBreakdown
    : (Array.isArray(d?.drilldown) ? d.drilldown : []);

  const records = [];
  list.forEach(c => {
    if (c.customers && Array.isArray(c.customers)) {
      c.customers.forEach(sub => {
        const subState = sub.state || c.name || 'غير محدد';
        const cleanCity = parseClientCity(sub.city, sub.name, subState);
        const cGross = Number(sub.gross !== undefined && sub.gross !== null ? sub.gross : (Number(sub.sales || 0) + Number(sub.returns || 0))) || 0;
        const cReturns = Number(sub.returns || 0);
        const cSales = Number(sub.sales !== undefined && sub.sales !== null ? sub.sales : Math.max(0, cGross - cReturns)) || 0;
        records.push({
          id: sub.id,
          name: sub.name || 'عميل غير محدد',
          customer: sub.name || 'عميل غير محدد',
          state: subState,
          region: subState,
          city: cleanCity,
          rep: sub.rep || 'غير محدد',
          sales: round2(cSales),
          gross: round2(cGross),
          returns: round2(cReturns),
          collected: Number(sub.collected) || 0,
          outstanding: Number(sub.outstanding) || 0,
          invoices: Number(sub.invoices) || 0,
          grossQty: Number(sub.grossQty) || 0,
          returnedQty: Number(sub.returnedQty) || 0,
          netQty: Number(sub.netQty) || 0,
          rate: Number(sub.rate) || 0
        });
      });
    } else {
      const cState = c.state || c.region || 'غير محدد';
      const cleanCity = parseClientCity(c.city, c.name, cState);
      const cGross = Number(c.gross !== undefined && c.gross !== null ? c.gross : (Number(c.sales || 0) + Number(c.returns || 0))) || 0;
      const cReturns = Number(c.returns || 0);
      const cSales = Number(c.sales !== undefined && c.sales !== null ? c.sales : Math.max(0, cGross - cReturns)) || 0;
      records.push({
        id: c.id,
        name: c.name || 'عميل غير محدد',
        customer: c.name || 'عميل غير محدد',
        state: cState,
        region: cState,
        city: cleanCity,
        rep: c.rep || 'غير محدد',
        sales: round2(cSales),
        gross: round2(cGross),
        returns: round2(cReturns),
        collected: Number(c.collected) || 0,
        outstanding: Number(c.outstanding) || 0,
        invoices: Number(c.invoices) || 0,
        grossQty: Number(c.grossQty) || 0,
        returnedQty: Number(c.returnedQty) || 0,
        netQty: Number(c.netQty) || 0,
        rate: Number(c.rate) || 0
      });
    }
  });
  return records;
}

function buildDrilldownTree(records, groupKeys) {
  if (!groupKeys || !groupKeys.length) groupKeys = ['region', 'city', 'rep'];

  const getDimensionValue = (item, dim) => {
    switch (dim) {
      case 'region': return item.state || item.region || 'غير محدد';
      case 'city': return item.city || 'غير محدد';
      case 'rep': return item.rep || 'غير محدد';
      case 'customer': return item.name || item.customer || 'غير محدد';
      case 'category': return item.category || 'غير محدد';
      case 'product': return item.product || 'غير محدد';
      default: return 'غير محدد';
    }
  };

  const getDimensionLabel = (dim) => {
    switch (dim) {
      case 'region': return 'المنطقة';
      case 'city': return 'المدينة';
      case 'rep': return 'المندوب';
      case 'customer': return 'العميل';
      case 'category': return 'الفئة';
      case 'product': return 'المنتج';
      default: return '';
    }
  };

  const getDimensionIcon = (dim) => {
    switch (dim) {
      case 'region': return '📍';
      case 'city': return '🏙️';
      case 'rep': return '👤';
      case 'customer': return '🏢';
      case 'category': return '🏷️';
      case 'product': return '📦';
      default: return '📁';
    }
  };

  function groupSubtree(items, keyIndex, pathPrefix) {
    if (keyIndex >= groupKeys.length) return [];

    const dim = groupKeys[keyIndex];
    const isLastGroup = keyIndex === groupKeys.length - 1;
    const map = new Map();

    items.forEach(it => {
      const val = getDimensionValue(it, dim);
      if (!map.has(val)) {
        map.set(val, {
          dim,
          name: val,
          items: []
        });
      }
      map.get(val).items.push(it);
    });

    const nodes = [];
    map.forEach((entry, name) => {
      const nodePath = `${pathPrefix}/${dim}:${name}`;
      let invoices = 0, grossQty = 0, returnedQty = 0, netQty = 0, sales = 0, gross = 0, returns = 0, collected = 0, outstanding = 0;
      entry.items.forEach(it => {
        invoices += (it.invoices || 0);
        grossQty += (it.grossQty || 0);
        returnedQty += (it.returnedQty || 0);
        netQty += (it.netQty || 0);
        sales += (it.sales || 0);
        gross += (it.gross || 0);
        returns += (it.returns || 0);
        collected += (it.collected || 0);
        outstanding += (it.outstanding || 0);
      });
      const finalGrossSales = round2(gross > 0 ? gross : (sales + returns));
      const finalReturnedSales = round2(returns);
      const finalNetSales = round2(Math.max(0, finalGrossSales - finalReturnedSales));
      const finalCollected = round2(collected);
      const finalOutstanding = round2(Math.max(0, finalNetSales - finalCollected));
      const rate = finalNetSales > 0 ? Number((finalCollected / finalNetSales * 100).toFixed(1)) : 0;

      const finalGrossQty = round2(grossQty);
      const finalReturnedQty = round2(returnedQty);
      const finalNetQty = round2(Math.max(0, finalGrossQty - finalReturnedQty));

      const children = isLastGroup ? [] : groupSubtree(entry.items, keyIndex + 1, nodePath);

      nodes.push({
        level: keyIndex + 1,
        dim,
        dimLabel: getDimensionLabel(dim),
        icon: getDimensionIcon(dim),
        name,
        path: nodePath,
        invoices,
        grossQty: finalGrossQty,
        returnedQty: finalReturnedQty,
        netQty: finalNetQty,
        sales: finalNetSales,
        grossSales: finalGrossSales,
        returnedSales: finalReturnedSales,
        collected: finalCollected,
        outstanding: finalOutstanding,
        rate,
        isLeaf: isLastGroup,
        leafItems: isLastGroup ? entry.items : [],
        children
      });
    });

    return nodes;
  }

  return groupSubtree(records, 0, 'root');
}

function sortTreeNodes(nodes, sortField, sortAsc, repSortDir) {
  if (!nodes || !nodes.length) return;

  nodes.sort((a, b) => {
    // If rep sort button was toggled AND this level is 'rep':
    if (repSortDir && a.dim === 'rep' && b.dim === 'rep') {
      return repSortDir === 'desc' ? b.sales - a.sales : a.sales - b.sales;
    }

    if (sortField) {
      let vA = a.sales, vB = b.sales;
      switch (sortField) {
        case 'invoices': vA = a.invoices; vB = b.invoices; break;
        case 'grossQty': vA = a.grossQty; vB = b.grossQty; break;
        case 'returnedQty': vA = a.returnedQty; vB = b.returnedQty; break;
        case 'netQty': vA = a.netQty; vB = b.netQty; break;
        case 'gross': vA = a.grossSales || a.sales; vB = b.grossSales || b.sales; break;
        case 'returns': vA = a.returnedSales; vB = b.returnedSales; break;
        case 'net': vA = a.sales; vB = b.sales; break;
        case 'collected': vA = a.collected; vB = b.collected; break;
        case 'outstanding': vA = a.outstanding; vB = b.outstanding; break;
        case 'rate': vA = a.rate; vB = b.rate; break;
        default: vA = a.sales; vB = b.sales;
      }
      return sortAsc ? (vA > vB ? 1 : -1) : (vB > vA ? 1 : -1);
    }

    // Default: highest sales first
    return b.sales - a.sales;
  });

  nodes.forEach(node => {
    if (node.children && node.children.length) {
      sortTreeNodes(node.children, sortField, sortAsc, repSortDir);
    }
    if (node.leafItems && node.leafItems.length) {
      node.leafItems.sort((a, b) => {
        if (repSortDir && node.dim !== 'rep') {
          const comp = repSortDir === 'desc'
            ? (b.rep || '').localeCompare(a.rep || '', 'ar')
            : (a.rep || '').localeCompare(b.rep || '', 'ar');
          if (comp !== 0) return comp;
        }
        return (b.sales || 0) - (a.sales || 0);
      });
    }
  });
}

function toggleDrillNode(path) {
  if (!liveDashboard.expandedDrillPaths) liveDashboard.expandedDrillPaths = new Set();
  if (liveDashboard.expandedDrillPaths.has(path)) {
    liveDashboard.expandedDrillPaths.delete(path);
  } else {
    liveDashboard.expandedDrillPaths.add(path);
  }
  renderDrilldownTable();
}

function toggleRegionDrill(regionName) {
  toggleDrillNode(`root/region:${regionName}`);
}

function renderDrilldownTable(drilldown) {
  const tbody = document.getElementById('drillTableBody');
  if (!tbody) return;

  const records = getDrilldownFlatRecords();
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--ks-text-muted);padding:24px;">لا توجد بيانات متاحة في التقرير التفصيلي</td></tr>';
    return;
  }

  const groupKeys = getDrilldownGroupByKeys();
  const tree = buildDrilldownTree(records, groupKeys);
  sortTreeNodes(tree, _drillSortField, _drillSortAsc, _repSortDir);

  if (!liveDashboard.expandedDrillPaths) liveDashboard.expandedDrillPaths = new Set();

  const rows = [];
  let totalInvoices = 0;
  let totalGrossQty = 0;
  let totalReturnedQty = 0;
  let totalNetQty = 0;
  let totalSales = 0;
  let totalGrossSales = 0;
  let totalReturnedSales = 0;
  let totalCollected = 0;
  let totalOutstanding = 0;

  // Root totals across all level 1 nodes
  tree.forEach(rootNode => {
    totalInvoices += rootNode.invoices;
    totalGrossQty += rootNode.grossQty;
    totalReturnedQty += rootNode.returnedQty;
    totalNetQty += rootNode.netQty;
    totalSales += rootNode.sales;
    totalGrossSales += (rootNode.grossSales || rootNode.sales);
    totalReturnedSales += (rootNode.returnedSales || 0);
    totalCollected += rootNode.collected;
    totalOutstanding += rootNode.outstanding;
  });

  function renderNode(node) {
    const isExpanded = liveDashboard.expandedDrillPaths.has(node.path);
    const escapedPath = node.path.replace(/'/g, "\\'");
    const indentPx = 16 + (node.level - 1) * 32;

    const levelClass = node.dim === 'region' ? 'level-state' : (node.dim === 'city' ? 'level-city' : (node.dim === 'rep' ? 'level-rep' : 'level-cust'));
    const nameClass = node.dim === 'region' ? 'state' : (node.dim === 'city' ? 'city' : (node.dim === 'rep' ? 'rep' : 'cust'));

    let subCountBadge = '';
    if (!node.isLeaf && node.children && node.children.length) {
      const childDimLabel = node.children[0]?.dimLabel || 'عناصر';
      subCountBadge = `<span style="font-size:11px;color:var(--ks-text-muted);font-weight:400;margin-right:6px;">(${node.children.length} ${childDimLabel})</span>`;
    }

    const expander = node.isLeaf
      ? `<span class="row-expand leaf">•</span>`
      : `<span class="row-expand expandable ${isExpanded ? 'expanded' : ''}">${isExpanded ? '▼' : '▶'}</span>`;
    const clickAttr = node.isLeaf ? '' : `onclick="toggleDrillNode('${escapedPath}')"`;
    const cursorStyle = node.isLeaf ? 'cursor:default;' : 'cursor:pointer;';

    rows.push(`
      <tr class="${levelClass}" ${clickAttr} style="${cursorStyle}">
        <td style="padding-right: ${indentPx}px;">
          <div class="row-indent">
            ${expander}
            <span class="row-icon">${node.icon}</span>
            <span class="row-name ${nameClass}">${node.name}</span>
            ${subCountBadge}
          </div>
        </td>
        <td class="center">${formatCount(node.invoices)}</td>
        <td class="center val-normal">${formatNumber(node.grossQty || 0)}</td>
        <td class="center val-red">${formatNumber(node.returnedQty || 0)}</td>
        <td class="center val-blue">${formatNumber(node.netQty || 0)}</td>
        <td class="center val-blue">${formatMoney(node.grossSales)}</td>
        <td class="center val-red">${formatMoney(node.returnedSales)}</td>
        <td class="center val-blue">${formatMoney(node.sales)}</td>
        <td class="center val-green">${formatMoney(node.collected)}</td>
        <td class="center val-warn">${formatMoney(node.outstanding)}</td>
        <td class="center">
          <div class="rate-wrap">
            <div class="rate-bar"><div class="rate-fill ${node.rate >= 50 ? 'good' : 'bad'}" style="width:${Math.min(node.rate, 100)}%;"></div></div>
            <span class="rate-pct ${node.rate >= 50 ? 'good' : 'bad'}">${toArabicDigits(node.rate)}${isArabic() ? '٪' : '%'}</span>
          </div>
        </td>
      </tr>
    `);

    if (isExpanded && !node.isLeaf && node.children && node.children.length) {
      node.children.forEach(child => renderNode(child));
    }
  }

  tree.forEach(rootNode => renderNode(rootNode));
  tbody.innerHTML = rows.join('');

  // Update footer totals
  const tfoot = document.querySelector('.table-card table tfoot');
  if (tfoot) {
    const finalGross = round2(totalGrossSales > 0 ? totalGrossSales : (liveDashboard.data?.kpis?.gross || (totalSales + totalReturnedSales)));
    const finalReturns = round2(totalReturnedSales >= 0 ? totalReturnedSales : (liveDashboard.data?.kpis?.returns || 0));
    const finalNet = round2(Math.max(0, finalGross - finalReturns));
    const finalOutstanding = round2(Math.max(0, finalNet - totalCollected));
    const totalRate = finalNet ? Number((totalCollected / finalNet * 100).toFixed(1)) : 0;
    tfoot.innerHTML = `
      <tr>
        <td style="color:var(--ks-champagne);font-weight:700;">الإجمالي الكلي</td>
        <td class="center val-normal" style="font-weight:700;">${formatCount(totalInvoices)}</td>
        <td class="center val-normal" style="font-weight:700;">${formatNumber(totalGrossQty)}</td>
        <td class="center val-red" style="font-weight:700;">${formatNumber(totalReturnedQty)}</td>
        <td class="center val-blue" style="font-weight:700;">${formatNumber(totalNetQty)}</td>
        <td class="center val-blue" style="font-weight:700;">${formatMoney(finalGross)}</td>
        <td class="center val-red" style="font-weight:700;">${formatMoney(finalReturns)}</td>
        <td class="center val-blue" style="font-weight:700;">${formatMoney(finalNet)}</td>
        <td class="center val-green" style="font-weight:700;">${formatMoney(totalCollected)}</td>
        <td class="center val-warn" style="font-weight:700;">${formatMoney(finalOutstanding)}</td>
        <td class="center">
          <div class="rate-wrap">
            <div class="rate-bar"><div class="rate-fill ${totalRate >= 50 ? 'good' : 'bad'}" style="width:${Math.min(totalRate, 100)}%;"></div></div>
            <span class="rate-pct ${totalRate >= 50 ? 'good' : 'bad'}">${toArabicDigits(totalRate)}${isArabic() ? '٪' : '%'}</span>
          </div>
        </td>
      </tr>
    `;
  }
}

function renderReturnsTable(returns) {
  const tbody = document.getElementById('returnsTableBody');
  if (!tbody) return;
  window._lastReturnsData = returns || [];

  if (!returns || !returns.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--ks-text-muted);padding:24px;">لا توجد مرتجعات مسجلة في الفترة المحددة</td></tr>';
    return;
  }

  tbody.innerHTML = returns.map(r => {
    const odooLink = r.odooLink || (r.moveId ? `https://www.shekhfoam.com/web#id=${r.moveId}&model=account.move&view_type=form` : '');
    const clickAttr = odooLink ? `onclick="window.open('${odooLink}', '_blank')"` : '';
    const rowTitle = odooLink ? `انقر للانتقال لمستند المرتجع في أودو (${r.creditNote || ''}) ↗` : '';

    return `
      <tr class="clickable-return-row" ${clickAttr} title="${rowTitle}">
        <td>
          <div style="display:flex;flex-direction:column;gap:3px;">
            <span style="font-weight:700;color:var(--ks-champagne);">${r.product}</span>
            ${odooLink ? `
              <a href="${odooLink}" target="_blank" rel="noopener noreferrer" class="odoo-direct-link" style="font-size:11px;" onclick="event.stopPropagation()" title="فتح إشعار الخصم في Odoo">
                <span>${r.creditNote || 'إشعار خصم'}</span> <span style="font-size:10px;">↗</span>
              </a>
            ` : (r.creditNote ? `<span style="font-size:11px;color:var(--ks-text-muted);font-family:monospace;">${r.creditNote}</span>` : '')}
          </div>
        </td>
        <td><span style="font-size:12px;color:var(--ks-text-muted);">${r.category || 'غير محدد'}</span></td>
        <td><strong>${r.customer || 'غير محدد'}</strong></td>
        <td>${r.rep || 'غير محدد'}</td>
        <td>${r.region || 'غير محدد'}</td>
        <td style="font-weight:600;">${formatNumber(r.returnedQty)}</td>
        <td class="ret-amt">${formatMoney(r.returns)}</td>
        <td>
          ${odooLink ? `
            <a href="${odooLink}" target="_blank" rel="noopener noreferrer" class="odoo-action-btn" onclick="event.stopPropagation()" title="انتقال مباشر لشاشة المستند في أودو">
              فتح في Odoo ↗
            </a>
          ` : '—'}
        </td>
      </tr>
    `;
  }).join('');
}

function renderChurnWarnings(churn) {
  const select = document.getElementById('churnCustomerFilter');
  const detail = document.getElementById('churnDetail');
  const badgeTexts = document.querySelectorAll('.churn-badge-text');
  const warnings = churn || [];
  liveDashboard.churnWarnings = warnings;

  if (badgeTexts) {
    badgeTexts.forEach(n => { n.textContent = formatCount(warnings.length) + ' تحذيرات'; });
  }

  if (document.getElementById('churnModalOverlay')?.classList.contains('active')) {
    renderChurnModalContent();
  }

  if (!select || !detail) return;
  if (!warnings.length) {
    select.innerHTML = '<option value="">لا توجد تحذيرات حالياً</option>';
    detail.textContent = 'لا توجد تحذيرات تراجع في مبيعات العملاء حالياً';
    return;
  }

  const defaultOption = '<option value="top15" selected>🌟 عرض أعلى 15 عميلاً تراجعاً في الرسم البياني (افتراضي)</option>';
  const customerOptions = warnings.map((warning, index) => {
    const isStopped = Number(warning.currentSales || 0) === 0;
    const tag = isStopped ? ' [توقف تام]' : '';
    const lossFmt = formatMoney(warning.lossAmount || Math.abs(warning.growthAmount || 0));
    return `<option value="${index}">${warning.name} | ${warning.growthPercent}%${tag} (-${lossFmt})</option>`;
  }).join('');

  select.innerHTML = defaultOption + customerOptions;

  const renderWarning = () => {
    const val = select.value;
    if (val === 'top15' || val === '' || val === null) {
      liveDashboard.selectedChurnClient = null;
      renderGrowthChart(liveDashboard.data?.charts);
      detail.className = 'churn-item low';
      detail.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;font-size:12px;color:var(--ks-text-muted);flex-wrap:wrap;gap:6px;">
          <span>📊 يعرض الرسم البياني أعلاه مقارنة أعلى 15 عميلاً تراجعاً. اختر أي عميل لتركيز الرسم عليه وتصفية بياناته.</span>
          <button class="tbl-export-btn" style="padding:2px 8px;font-size:11px;" onclick="openChurnModal()" title="عرض التقرير التفصيلي الكامل">عرض الكل (${warnings.length}) 🔍</button>
        </div>
      `;
      return;
    }

    const warning = warnings[Number(val)];
    if (!warning) return;
    liveDashboard.selectedChurnClient = warning;
    renderGrowthChart(liveDashboard.data?.charts);

    const isStopped = Number(warning.currentSales || 0) === 0;
    const isHigh = warning.risk === 'مرتفع' || isStopped;
    const badgeText = isStopped ? '🔴 خطر مرتفع (توقف تام)' : (isHigh ? `🔴 خطر مرتفع (${warning.growthPercent}%)` : `🟡 خطر متوسط (${warning.growthPercent}%)`);
    const badgeColor = isHigh ? 'var(--ks-warning)' : 'var(--ks-kinpaku-rich)';
    const badgeBg = isHigh ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)';
    const lossVal = warning.lossAmount || Math.abs(warning.growthAmount || (warning.currentSales - warning.previousSales));
    const escapedName = (warning.name || '').replace(/'/g, "\\'");

    detail.className = `churn-item ${isHigh ? 'high' : 'medium'}`;
    detail.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <div style="font-weight:700;color:var(--ks-champagne);font-size:13px;">
            👤 ${warning.name}
            <span style="font-size:11px;font-weight:normal;color:var(--ks-text-muted);margin-right:6px;">📍 ${warning.state || 'غير محدد'} | مندوب: ${warning.rep || 'غير محدد'}</span>
          </div>
          <span class="churn-risk" style="border:1px solid ${badgeColor};color:${badgeColor};background:${badgeBg};padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px;">
            ${badgeText}
          </span>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;background:var(--ks-graphite);border:1px solid var(--ks-rule);padding:6px 10px;border-radius:6px;">
          <span>مبيعات سابقة: <strong style="color:var(--ks-text-muted);">${formatMoney(warning.previousSales)}</strong></span>
          <span>مبيعات حالية: <strong style="color:${isStopped ? 'var(--ks-warning)' : 'var(--ks-champagne)'};">${formatMoney(warning.currentSales)}${isStopped ? ' (توقف تام)' : ''}</strong></span>
          <span style="color:var(--ks-warning);">قيمة التراجع: <strong>-${formatMoney(lossVal)}</strong> (${warning.growthPercent}%)</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:2px;">
          <button class="tbl-export-btn" style="background:var(--ks-gold);color:#0f172a;border-color:var(--ks-gold);font-weight:700;padding:5px 12px;font-size:11px;border-radius:4px;cursor:pointer;" onclick="filterDashboardByCustomer(${warning.id}, '${escapedName}')" title="تصفية اللوحة بالكامل حسب هذا العميل">
            🔍 تصفية لوحة التحكم بالكامل لهذا العميل
          </button>
          <button class="tbl-export-btn" style="padding:5px 10px;font-size:11px;cursor:pointer;" onclick="resetChurnSelection()" title="الرجوع للرسم البياني العام">
            ↩️ العودة لأعلى 15 عميلاً
          </button>
        </div>
      </div>
    `;
  };
  select.onchange = renderWarning;
  renderWarning();
}

function renderComparisonMatrix(kpis, previous = null) {
  const tbody = document.querySelector('#comparisonMatrix tbody');
  if (!tbody || !kpis) return;
  window._lastComparisonData = { kpis, previous };

  const compMode = liveDashboard.filters.comparison || 'previousPeriod';
  const isNone = compMode === 'none';
  const isLastYear = compMode === 'samePeriodLastYear';
  const compHeader = document.getElementById('comparisonMatrixHeader');
  if (compHeader) {
    compHeader.textContent = isNone ? 'فترة المقارنة (بدون مقارنة)' : (isLastYear ? 'فترة المقارنة (العام الماضي)' : 'فترة المقارنة (الفترة السابقة)');
  }

  // Synchronize comparison switcher tabs state
  document.getElementById('matrixTabPrev')?.classList.toggle('active', compMode === 'previousPeriod');
  document.getElementById('matrixTabYear')?.classList.toggle('active', compMode === 'samePeriodLastYear');
  document.getElementById('matrixTabNone')?.classList.toggle('active', compMode === 'none');

  const change = (current, prior) => {
    if (prior === undefined || prior === null) return '—';
    if (prior === 0) return current > 0 ? '+100%' : '0.0%';
    const value = ((current - prior) / Math.abs(prior)) * 100;
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  };
  const isQty = liveDashboard.metric === 'quantity';
  const isSO = liveDashboard.filters.source === 'salesOrder';
  const drilldown = liveDashboard.data?.drilldown || [];
  const grossQty = kpis.grossQty ?? drilldown.reduce((sum, r) => sum + (r.grossQty || 0), 0);
  const returnsQty = kpis.returnsQty ?? drilldown.reduce((sum, r) => sum + (r.returnedQty || 0), 0);
  const netQty = kpis.netQty ?? Math.max(0, grossQty - returnsQty);
  const avgQty = kpis.invoicesCount ? (netQty / kpis.invoicesCount) : 0;
  const prevAvgQty = previous?.invoicesCount ? ((previous.netQty || 0) / previous.invoicesCount) : 0;

  const totalMovesCount = isSO ? kpis.invoicesCount : (kpis.totalPostedCount || ((kpis.invoicesCount || 0) + (kpis.returnsCount || 0)));
  const prevTotalMovesCount = isSO ? previous?.invoicesCount : (previous?.totalPostedCount || ((previous?.invoicesCount || 0) + (previous?.returnsCount || 0)));

  const movesLabel = isSO
    ? 'إجمالي أوامر البيع وطلبات الإرجاع (Posted & Confirmed)'
    : 'إجمالي فواتير البيع والمرتجعات المرحّلة (عدد الحركات المعتمدة - Posted)';

  const rawRows = isQty ? [
    ['إجمالي الكميات المباعة', grossQty, previous?.grossQty, false, 'قطعة', false],
    [isSO ? 'إجمالي مرتجعات أوامر البيع (كميات)' : 'إجمالي الكميات المرتجعة', returnsQty, previous?.returnsQty, false, 'قطعة', false],
    ['صافي الكميات المباعة', netQty, previous?.netQty, false, 'قطعة', false],
    [movesLabel, totalMovesCount, prevTotalMovesCount, false, isSO ? 'مستند وأمر' : 'فاتورة ومستند', true],
    [isSO ? 'متوسط كمية أمر البيع' : 'متوسط كمية الفاتورة', avgQty, prevAvgQty, false, 'قطعة', false],
    ['المبالغ المحصلة (ج.م)', kpis.collected, previous?.collected, true, '', false],
    [isSO ? 'المبيعات غير المحصلة (ج.م)' : 'المديونية القائمة (ج.م)', kpis.outstanding, previous?.outstanding, true, '', false],
    [isSO ? 'إجمالي أوامر البيع (ج.م)' : 'إجمالي المبيعات (ج.م)', kpis.gross, previous?.gross, true, '', false]
  ] : [
    [isSO ? 'إجمالي أوامر البيع' : 'إجمالي المبيعات', kpis.gross, previous?.gross, true, '', false],
    [isSO ? 'إجمالي مرتجعات أوامر البيع' : 'إجمالي المرتجعات', kpis.returns, previous?.returns, true, '', false],
    [isSO ? 'صافي أوامر البيع' : 'صافي المبيعات', kpis.net, previous?.net, true, '', false],
    ['المبالغ المحصلة', kpis.collected, previous?.collected, true, '', false],
    [isSO ? 'المبيعات غير المحصلة' : 'المديونية القائمة', kpis.outstanding, previous?.outstanding, true, '', false],
    [movesLabel, totalMovesCount, prevTotalMovesCount, false, isSO ? 'مستند وأمر' : 'فاتورة ومستند', true],
    [isSO ? 'متوسط أمر البيع' : 'متوسط قيمة الفاتورة', kpis.avgInvoice, previous?.avgInvoice, true, '', false]
  ];

  const rows = rawRows.map(([label, current, prior, money, unit, isCount]) => {
    const hasPrior = !isNone && prior !== undefined && prior !== null;
    const formatVal = (v) => isCount
      ? (formatCount(v) + (unit ? ' ' + unit : ''))
      : (money ? formatMoney(v) : (formatNumber(v) + (unit ? ' ' + unit : '')));

    let priorFormatted = '';
    let deltaFormatted = '';
    let deltaClass = '';

    if (isNone) {
      priorFormatted = `<span style="color:var(--ks-text-muted);font-size:12px;font-weight:600;">بدون مقارنة (غير مفعلة)</span>`;
      deltaFormatted = `<span style="color:var(--ks-text-muted);font-size:12px;font-weight:600;">— (بدون مقارنة)</span>`;
    } else if (hasPrior) {
      priorFormatted = formatVal(prior);
      const chg = change(current, prior);
      const isNegativeMetric = label.includes('مرتجع') || label.includes('المديونية') || label.includes('غير محصل');
      if (chg.startsWith('+')) {
        deltaClass = isNegativeMetric ? 'val-red' : 'val-green';
        deltaFormatted = `<span class="matrix-delta-badge ${isNegativeMetric ? 'down' : 'up'}">↑ ${chg}</span>`;
      } else if (chg.startsWith('-')) {
        deltaClass = isNegativeMetric ? 'val-green' : 'val-red';
        deltaFormatted = `<span class="matrix-delta-badge ${isNegativeMetric ? 'up' : 'down'}">↓ ${chg}</span>`;
      } else if (chg === '0.0%') {
        deltaFormatted = `<span style="color:var(--ks-text-muted);font-weight:600;">0.0%</span>`;
      } else {
        deltaFormatted = `<span style="color:var(--ks-text-muted);">${chg}</span>`;
      }
    } else {
      priorFormatted = `<span style="color:var(--ks-text-muted);font-size:12px;">غير متوفرة</span>`;
      deltaFormatted = `<span style="color:var(--ks-text-muted);">—</span>`;
    }

    return [label, formatVal(current), priorFormatted, deltaFormatted, deltaClass];
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td style="font-weight:600;">${r[0]}</td>
      <td><strong style="color:var(--ks-champagne);">${r[1]}</strong></td>
      <td>${r[2]}</td>
      <td class="${r[4]}">${r[3]}</td>
    </tr>
  `).join('');
}

function setMatrixComparison(mode) {
  liveDashboard.filters.comparison = mode;
  const topSel = document.getElementById('comparisonFilter');
  if (topSel) topSel.value = mode;

  document.getElementById('matrixTabPrev')?.classList.toggle('active', mode === 'previousPeriod');
  document.getElementById('matrixTabYear')?.classList.toggle('active', mode === 'samePeriodLastYear');
  document.getElementById('matrixTabNone')?.classList.toggle('active', mode === 'none');

  if (mode === 'none') {
    renderComparisonMatrix(liveDashboard.data?.kpis, null);
    renderKpis(liveDashboard.data?.kpis, null);
  } else {
    if (liveDashboard.data?.comparison?.mode === mode && liveDashboard.data?.comparison?.kpis) {
      renderComparisonMatrix(liveDashboard.data.kpis, liveDashboard.data.comparison.kpis);
      renderKpis(liveDashboard.data.kpis, liveDashboard.data.comparison.kpis);
    } else {
      loadLiveDashboard();
    }
  }
}
window.setMatrixComparison = setMatrixComparison;

function computeQuickPresetRange(mode) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (mode === 'يومي') {
    const today = fmt(now);
    return { start: today, end: today, year: String(now.getFullYear()) };
  }
  if (mode === 'أسبوعي') {
    // Current week starting Saturday (standard for regional business week)
    const dayOfWeek = now.getDay();
    const diffToSat = (dayOfWeek + 1) % 7;
    const start = new Date(now);
    start.setDate(now.getDate() - diffToSat);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start: fmt(start), end: fmt(end), year: String(start.getFullYear()) };
  }
  if (mode === 'شهري') {
    const y = now.getFullYear();
    const m = now.getMonth();
    const start = `${y}-${pad(m + 1)}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const end = `${y}-${pad(m + 1)}-${pad(lastDay)}`;
    return { start, end, year: String(y) };
  }
  if (mode === 'ربع سنوي') {
    const y = now.getFullYear();
    const q = Math.floor(now.getMonth() / 3);
    const startM = q * 3 + 1;
    const endM = startM + 2;
    const start = `${y}-${pad(startM)}-01`;
    const lastDay = new Date(y, endM, 0).getDate();
    const end = `${y}-${pad(endM)}-${pad(lastDay)}`;
    return { start, end, year: String(y) };
  }
  if (mode === 'سنوي') {
    const y = now.getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31`, year: String(y) };
  }

  return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31`, year: String(now.getFullYear()) };
}

function clearCustomDateInputs() {
  const sync = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  sync('dateFrom', '');
  sync('dateTo', '');
  sync('yearFilter', '');
  sync('monthFilter', '');
  sync('periodFilter', '');
  sync('dayFilter', '');
  liveDashboard.filters.year = '';
  liveDashboard.filters.month = '';
  liveDashboard.filters.period = '';
  liveDashboard.filters.day = '';
}

function activateCustomTab() {
  liveDashboard.filters.dateFilterType = 'custom';
  liveDashboard.mode = 'مخصص';
  liveDashboard.filters.quickPreset = '';
  document.querySelectorAll('.date-tab').forEach(t => {
    if (t.textContent.trim() === 'مخصص') t.classList.add('active');
    else t.classList.remove('active');
  });
  const customDate = document.getElementById('customDate');
  if (customDate) {
    customDate.classList.add('active');
    customDate.style.display = 'flex';
  }
}

function onCustomDateRangeChange() {
  activateCustomTab();
  // Clear dropdowns when manual date range is entered to avoid conflict
  const sync = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  sync('yearFilter', '');
  sync('monthFilter', '');
  sync('periodFilter', '');
  sync('dayFilter', '');
  liveDashboard.filters.year = '';
  liveDashboard.filters.month = '';
  liveDashboard.filters.period = '';
  liveDashboard.filters.day = '';

  const from = document.getElementById('dateFrom')?.value || '';
  const to = document.getElementById('dateTo')?.value || '';
  liveDashboard.filters.startDate = from;
  liveDashboard.filters.endDate = to;
  // NOTE: No auto-load. User must click "تطبيق الفلاتر" button.
  markFiltersPending();
}

function onCustomDropdownChange() {
  activateCustomTab();
  // Clear date range inputs when dropdowns are selected to avoid conflict
  const sync = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  sync('dateFrom', '');
  sync('dateTo', '');
  liveDashboard.filters.startDate = '';
  liveDashboard.filters.endDate = '';

  const getVal = (id) => document.getElementById(id)?.value || '';
  const year = getVal('yearFilter');
  const month = getVal('monthFilter');
  liveDashboard.filters.year = year;
  liveDashboard.filters.month = month;
  liveDashboard.filters.period = getVal('periodFilter');

  // Dynamically update day options strictly based on selected year/month
  updateDayFilterOptions(year, month);
  liveDashboard.filters.day = getVal('dayFilter');

  // NOTE: No auto-load. User must click "تطبيق الفلاتر" button.
  markFiltersPending();
}

function onDataSourceChange() {
  const sourceEl = document.getElementById('dataSourceFilter');
  const statusEl = document.getElementById('salesOrderStatusFilter');
  const compEl = document.getElementById('comparisonFilter');
  const val = sourceEl?.value || 'postedInvoice';
  liveDashboard.filters.source = val;
  if (statusEl) {
    statusEl.hidden = val !== 'salesOrder';
    if (val === 'salesOrder') {
      liveDashboard.filters.salesOrderStatus = statusEl.value || 'all';
    }
  }
  if (compEl) {
    compEl.hidden = false;
    compEl.style.display = '';
  }
  markFiltersPending();
}

function onSalesOrderStatusChange() {
  const statusEl = document.getElementById('salesOrderStatusFilter');
  if (statusEl) {
    liveDashboard.filters.salesOrderStatus = statusEl.value || 'all';
  }
  markFiltersPending();
}

function applyLiveFilters() {
  clearFiltersPending();
  const errorNode = document.getElementById('dashboardError');
  if (errorNode) {
    errorNode.textContent = '';
    errorNode.hidden = true;
  }
  const getVal = (id) => document.getElementById(id)?.value || '';
  liveDashboard.filters.region = getVal('regionFilter');
  liveDashboard.filters.city = getVal('cityFilter');
  liveDashboard.filters.rep = getVal('repFilter');
  liveDashboard.filters.customer = getVal('customerFilter');
  liveDashboard.filters.category = getVal('catFilter');
  liveDashboard.filters.product = getVal('productFilter');
  liveDashboard.filters.query = '';
  liveDashboard.filters.comparison = getVal('comparisonFilter') || 'previousPeriod';
  const compVal = liveDashboard.filters.comparison;
  document.getElementById('matrixTabPrev')?.classList.toggle('active', compVal === 'previousPeriod');
  document.getElementById('matrixTabYear')?.classList.toggle('active', compVal === 'samePeriodLastYear');
  document.getElementById('matrixTabNone')?.classList.toggle('active', compVal === 'none');
  liveDashboard.filters.source = getVal('dataSourceFilter') || 'postedInvoice';
  liveDashboard.filters.salesOrderStatus = getVal('salesOrderStatusFilter') || 'all';

  const statusControl = document.getElementById('salesOrderStatusFilter');
  if (statusControl) statusControl.hidden = liveDashboard.filters.source !== 'salesOrder';
  const compEl = document.getElementById('comparisonFilter');
  if (compEl) {
    compEl.hidden = false;
    compEl.style.display = '';
  }

  // If in custom mode, refresh custom date selections
  if (liveDashboard.filters.dateFilterType === 'custom') {
    const from = getVal('dateFrom');
    const to = getVal('dateTo');
    if (from && to) {
      liveDashboard.filters.startDate = from;
      liveDashboard.filters.endDate = to;
      liveDashboard.filters.year = '';
      liveDashboard.filters.month = '';
      liveDashboard.filters.period = '';
      liveDashboard.filters.day = '';
    } else {
      liveDashboard.filters.startDate = '';
      liveDashboard.filters.endDate = '';
      liveDashboard.filters.year = getVal('yearFilter');
      liveDashboard.filters.month = getVal('monthFilter');
      liveDashboard.filters.period = getVal('periodFilter');
      liveDashboard.filters.day = getVal('dayFilter');
    }
  }

  loadLiveDashboard();
}

function applyFilters() {
  applyLiveFilters();
}

function setDateTab(btn, mode) {
  document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const customDate = document.getElementById('customDate');

  if (mode === 'مخصص') {
    activateCustomTab();
    const from = document.getElementById('dateFrom')?.value || '';
    const to = document.getElementById('dateTo')?.value || '';
    const year = document.getElementById('yearFilter')?.value || '';
    const month = document.getElementById('monthFilter')?.value || '';
    const period = document.getElementById('periodFilter')?.value || '';
    const day = document.getElementById('dayFilter')?.value || '';

    if (from && to) {
      liveDashboard.filters.startDate = from;
      liveDashboard.filters.endDate = to;
    } else if (year || month || period || day) {
      liveDashboard.filters.year = year;
      liveDashboard.filters.month = month;
      liveDashboard.filters.period = period;
      liveDashboard.filters.day = day;
    }
    // NOTE: No auto-load. User must click "تطبيق الفلاتر" button.
    markFiltersPending();
  } else {
    // Quick filter preset — update state only, show pending indicator
    liveDashboard.filters.dateFilterType = 'quick';
    liveDashboard.mode = mode;
    liveDashboard.filters.quickPreset = mode;
    if (customDate) {
      customDate.classList.remove('active');
      customDate.style.display = 'none';
    }
    clearCustomDateInputs();

    const range = computeQuickPresetRange(mode);
    liveDashboard.filters.startDate = range.start;
    liveDashboard.filters.endDate = range.end;
    liveDashboard.filters.year = range.year || '';
    liveDashboard.filters.month = '';
    liveDashboard.filters.period = '';
    liveDashboard.filters.day = '';
    // NOTE: No auto-load. User must click "تطبيق الفلاتر" button.
    markFiltersPending();
  }
}

function switchProductChart(mode, btn) {
  document.querySelectorAll('#tabTop, #tabBot').forEach(t => t.classList.remove('active-top', 'active-bot'));
  if (btn) btn.classList.add(mode === 'top' ? 'active-top' : 'active-bot');
  liveDashboard.productMode = mode;
  const metric = liveDashboard.productMetric || liveDashboard.metric || 'amount';
  const isQty = metric === 'quantity';
  const titleEl = document.getElementById('prodChartTitle');
  if (titleEl) {
    const baseTitle = mode === 'top' ? 'أفضل المنتجات مبيعاً' : 'أقل المنتجات مبيعاً';
    const subTitle = isQty ? ' (بالكمية)' : ' (بالقيمة)';
    titleEl.textContent = baseTitle + subTitle;
  }
  renderProductChart(liveDashboard.data?.charts);
}

function setProductMetric(metric, btn) {
  liveDashboard.productMetric = metric;
  const isQty = metric === 'quantity';

  const valBtn = document.getElementById('prodMetricValBtn');
  const qtyBtn = document.getElementById('prodMetricQtyBtn');
  if (valBtn) valBtn.classList.toggle('active-top', !isQty);
  if (qtyBtn) qtyBtn.classList.toggle('active-top', isQty);

  const isTop = liveDashboard.productMode === 'top';
  const titleEl = document.getElementById('prodChartTitle');
  if (titleEl) {
    const baseTitle = isTop ? 'أفضل المنتجات مبيعاً' : 'أقل المنتجات مبيعاً';
    const subTitle = isQty ? ' (بالكمية)' : ' (بالقيمة)';
    titleEl.textContent = baseTitle + subTitle;
  }

  renderProductChart(liveDashboard.data?.charts);
}

function toggleView(forceMode = null) {
  if (forceMode === 'amount' || forceMode === 'quantity') {
    liveDashboard.metric = forceMode;
  } else {
    liveDashboard.metric = liveDashboard.metric === 'amount' ? 'quantity' : 'amount';
  }
  const isQty = liveDashboard.metric === 'quantity';
  liveDashboard.productMetric = liveDashboard.metric;

  const toggle = document.getElementById('viewToggle');
  if (toggle) {
    toggle.classList.toggle('qty', isQty);
    toggle.setAttribute('aria-pressed', String(isQty));
  }

  const valLabel = document.getElementById('toggleLabelVal');
  const qtyLabel = document.getElementById('toggleLabelQty');
  if (valLabel) valLabel.className = isQty ? 'toggle-label inactive-val' : 'toggle-label active-val';
  if (qtyLabel) qtyLabel.className = isQty ? 'toggle-label active-val' : 'toggle-label inactive-val';

  // Sync product chart local metric tabs
  const prodValBtn = document.getElementById('prodMetricValBtn');
  const prodQtyBtn = document.getElementById('prodMetricQtyBtn');
  if (prodValBtn) prodValBtn.classList.toggle('active-top', !isQty);
  if (prodQtyBtn) prodQtyBtn.classList.toggle('active-top', isQty);

  // Propagate toggle to the ENTIRE dashboard (KPI cards, product chart, regional chart, comparison matrix, drilldown)
  const activeComp = (liveDashboard.filters.comparison === 'none' || liveDashboard.data?.comparison?.mode === 'none') ? null : liveDashboard.data?.comparison?.kpis;
  renderKpis(liveDashboard.data?.kpis, activeComp);
  renderProductChart(liveDashboard.data?.charts);
  renderRegionalChart(liveDashboard.data?.charts);
  renderComparisonMatrix(liveDashboard.data?.kpis, activeComp);
  renderDrilldownTable(liveDashboard.data?.drilldown);
}

function expandAll() {
  if (!liveDashboard.expandedDrillPaths) liveDashboard.expandedDrillPaths = new Set();
  const records = getDrilldownFlatRecords();
  const groupKeys = getDrilldownGroupByKeys();
  const tree = buildDrilldownTree(records, groupKeys);
  function addPaths(nodes) {
    nodes.forEach(n => {
      liveDashboard.expandedDrillPaths.add(n.path);
      if (n.children && n.children.length) addPaths(n.children);
    });
  }
  addPaths(tree);
  renderDrilldownTable();
}

function collapseAll() {
  if (!liveDashboard.expandedDrillPaths) liveDashboard.expandedDrillPaths = new Set();
  liveDashboard.expandedDrillPaths.clear();
  renderDrilldownTable();
}

function toggleNotif() {
  openChurnModal();
}

function openChurnModal() {
  const overlay = document.getElementById('churnModalOverlay');
  if (!overlay) return;
  renderChurnModalContent();
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeChurnModal() {
  const overlay = document.getElementById('churnModalOverlay');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}

function renderChurnModalContent() {
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || liveDashboard.data?.churn || [];
  const source = liveDashboard.filters?.source || liveDashboard.data?.source || 'postedInvoice';
  const isSalesOrder = source === 'salesOrder';

  const sourceLabelEl = document.getElementById('churnModalSourceLabel');
  if (sourceLabelEl) {
    const statusVal = liveDashboard.filters?.salesOrderStatus || 'all';
    const statusText = statusVal === 'post' ? ' (المؤكدة فقط)' : statusVal === 'draft' ? ' (المسودة فقط)' : ' (كافة الحالات)';
    sourceLabelEl.textContent = isSalesOrder ? `أوامر البيع - Sales Orders${statusText}` : 'الفواتير المعتمدة - Posted Invoices';
    sourceLabelEl.style.color = isSalesOrder ? '#93c5fd' : 'var(--ks-champagne)';
  }

  const periodLabelEl = document.getElementById('churnModalPeriodLabel');
  if (periodLabelEl) {
    const curStart = liveDashboard.data?.filters?.start || '';
    const curEnd = liveDashboard.data?.filters?.end || '';
    const prevStart = liveDashboard.data?.comparison?.start || '';
    const prevEnd = liveDashboard.data?.comparison?.end || '';
    if (curStart && curEnd && prevStart && prevEnd) {
      periodLabelEl.textContent = `الفترة الحالية: [${curStart} إلى ${curEnd}] | مقارنة بـ: [${prevStart} إلى ${prevEnd}]`;
    } else {
      periodLabelEl.textContent = '';
    }
  }

  const totalCountEl = document.getElementById('churnModalTotalCount');
  const highCountEl = document.getElementById('churnModalHighCount');
  const medCountEl = document.getElementById('churnModalMedCount');
  const totalLossEl = document.getElementById('churnModalTotalLoss');

  const highCount = warnings.filter(w => w.risk === 'مرتفع' || Number(w.currentSales || 0) === 0 || Number(w.growthPercent || 0) <= -50).length;
  const medCount = Math.max(0, warnings.length - highCount);
  const totalLoss = warnings.reduce((acc, w) => acc + Math.max(0, (w.previousSales || 0) - (w.currentSales || 0)), 0);

  if (totalCountEl) totalCountEl.textContent = formatCount(warnings.length);
  if (highCountEl) highCountEl.textContent = formatCount(highCount);
  if (medCountEl) medCountEl.textContent = formatCount(medCount);
  if (totalLossEl) totalLossEl.textContent = formatMoney(totalLoss);

  filterChurnModalTable();
}

function filterChurnModalTable() {
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || liveDashboard.data?.churn || [];
  const tbody = document.getElementById('churnModalTableBody');
  if (!tbody) return;

  const q = (document.getElementById('churnModalSearch')?.value || '').trim().toLowerCase();
  const riskFilter = document.getElementById('churnModalRiskFilter')?.value || 'all';

  const filtered = warnings.filter(w => {
    const isStopped = Number(w.currentSales || 0) === 0;
    const isHigh = w.risk === 'مرتفع' || isStopped || Number(w.growthPercent || 0) <= -50;
    const currentRisk = isHigh ? 'مرتفع' : 'متوسط';
    if (riskFilter !== 'all' && currentRisk !== riskFilter) return false;
    if (q) {
      const txt = `${w.name} ${w.state || ''} ${w.city || ''} ${w.rep || ''}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align:center;padding:28px;color:var(--ks-text-muted);">
          ${warnings.length === 0 ? '✅ لا توجد تحذيرات تراجع للعملاء مطابقة للفلاتر ومصدر البيانات المحدد حالياً.' : 'لا توجد نتائج مطابقة لبحثك في قائمة التحذيرات.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(w => {
    const loss = Math.max(0, (w.previousSales || 0) - (w.currentSales || 0));
    const isStopped = Number(w.currentSales || 0) === 0;
    const isHigh = w.risk === 'مرتفع' || isStopped || Number(w.growthPercent || 0) <= -50;
    const badgeText = isStopped ? '🔴 مرتفع (توقف تام)' : (isHigh ? `🔴 مرتفع (${w.growthPercent}%)` : `🟡 متوسط (${w.growthPercent}%)`);
    const riskBadge = isHigh
      ? `<span class="churn-risk" style="border:1px solid var(--ks-warning);color:var(--ks-warning);background:rgba(239,68,68,0.15);padding:2px 8px;border-radius:4px;font-weight:700;">${badgeText}</span>`
      : `<span class="churn-risk" style="border:1px solid var(--ks-kinpaku-rich);color:var(--ks-kinpaku-rich);background:rgba(245,158,11,0.15);padding:2px 8px;border-radius:4px;font-weight:700;">${badgeText}</span>`;

    const escapedName = (w.name || '').replace(/'/g, "\\'");
    return `
      <tr>
        <td><strong>${w.name}</strong></td>
        <td>${w.state || 'غير محدد'}</td>
        <td>${w.rep || 'غير محدد'}</td>
        <td>${formatMoney(w.previousSales)}</td>
        <td>${formatMoney(w.currentSales)}</td>
        <td style="color:var(--ks-warning);font-weight:600;">-${formatMoney(loss)}</td>
        <td style="color:var(--ks-warning);font-weight:700;">${w.growthPercent}%</td>
        <td>${riskBadge}</td>
        <td>
          <button class="tbl-export-btn" style="padding:3px 8px;font-size:11px;" onclick="filterDashboardByCustomer(${w.id}, '${escapedName}')" title="تصفية اللوحة بالكامل حسب هذا العميل مع الحفاظ على مصدر البيانات">
            تصفية 🔍
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterDashboardByCustomer(customerId, customerName) {
  closeChurnModal();
  const select = document.getElementById('customerFilter');
  if (select) {
    let exists = false;
    for (let opt of select.options) {
      if (String(opt.value) === String(customerId)) {
        select.value = customerId;
        exists = true;
        break;
      }
    }
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = customerId;
      opt.textContent = customerName;
      opt.selected = true;
      select.appendChild(opt);
    }
    select.value = customerId;
    if (SEARCHABLE_SELECT_IDS.includes('customerFilter')) {
      updateSearchableSelectUI('customerFilter');
    }
  }
  applyLiveFilters();
}

function exportChurnWarningsToExcel() {
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || [];
  if (!warnings.length) return alert('لا توجد تحذيرات متابعة لتصديرها');
  const source = liveDashboard.filters?.source || 'postedInvoice';
  const sourceName = source === 'salesOrder' ? 'أوامر البيع (Sales Orders)' : 'الفواتير المعتمدة (Posted Invoices)';
  const rows = warnings.map(w => ({
    'اسم العميل': w.name,
    'المحافظة / المنطقة': w.state || 'غير محدد',
    'المدينة': w.city || 'غير محدد',
    'المندوب': w.rep || 'غير محدد',
    'مبيعات الفترة السابقة (ج.م)': w.previousSales || 0,
    'مبيعات الفترة الحالية (ج.م)': w.currentSales || 0,
    'قيمة التراجع (ج.م)': Math.abs(w.growthAmount || (w.currentSales - w.previousSales)),
    'نسبة التراجع (%)': (w.growthPercent || 0) + '%',
    'مستوى الخطورة': (Number(w.currentSales || 0) === 0) ? 'مرتفع (توقف تام)' : (w.risk || 'متوسط'),
    'مصدر البيانات': sourceName
  }));
  const wb = createWorkbook({ 'تحذيرات تراجع العملاء': rows });
  xlsxDownload(wb, `تقرير-تحذيرات-متابعة-العملاء-${source === 'salesOrder' ? 'أوامر-البيع' : 'الفواتير-المعتمدة'}.xlsx`);
}

/* ─── KPI DRILL-DOWN MODAL & DIRECT ODOO HYPERLINKS ─── */
liveDashboard.kpiDrilldownData = null;
liveDashboard.kpiDrilldownCurrentKey = null;
liveDashboard.kpiDrilldownCurrentTitle = '';

function openKpiDrilldown(kpiKey, kpiTitle) {
  const overlay = document.getElementById('kpiDrilldownModalOverlay');
  if (!overlay) return;

  liveDashboard.kpiDrilldownCurrentKey = kpiKey;
  liveDashboard.kpiDrilldownCurrentTitle = kpiTitle || 'تفاصيل المؤشر';

  const titleEl = document.getElementById('kpiDrilldownModalTitle');
  const headerTitleEl = document.getElementById('kpiDrilldownHeaderTitle');
  const iconEl = document.getElementById('kpiDrilldownIcon');
  const filterSummaryEl = document.getElementById('kpiDrilldownFilterSummary');
  const tbody = document.getElementById('kpiDrilldownTableBody');
  const searchInput = document.getElementById('kpiDrilldownSearch');
  const statusFilter = document.getElementById('kpiDrilldownStatusFilter');

  const isReturnKpi = kpiKey === 'returns' || kpiKey === 'returnsCount';
  const isCollectedPayment = kpiKey === 'collected';
  const isAvg = kpiKey === 'avgInvoice';
  const isSO = (liveDashboard.filters.source || 'postedInvoice') === 'salesOrder';

  if (titleEl) {
    if (isReturnKpi) {
      titleEl.textContent = `تفاصيل إشعارات الدائن ومرتجعات المبيعات (Credit Notes): ${kpiTitle}`;
    } else if (isAvg) {
      titleEl.textContent = isSO
        ? `تفاصيل أوامر البيع واحتساب المتوسط (Drill-down): ${kpiTitle}`
        : `تفاصيل فواتير المبيعات واحتساب المتوسط (Drill-down): ${kpiTitle}`;
    } else if (isCollectedPayment) {
      titleEl.textContent = `تفاصيل سندات القبض والتحصيلات (Drill-down): ${kpiTitle}`;
    } else {
      titleEl.textContent = isSO
        ? `تفاصيل أوامر البيع (Drill-down): ${kpiTitle}`
        : `تفاصيل فواتير المبيعات والقيود (Drill-down): ${kpiTitle}`;
    }
  }
  if (headerTitleEl) {
    if (isReturnKpi) {
      headerTitleEl.textContent = `إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo (Credit Notes - Out Refund)`;
    } else if (isAvg) {
      headerTitleEl.textContent = isSO
        ? `أوامر البيع المعتمدة واحتساب متوسط أمر البيع`
        : `فواتير المبيعات المعتمدة واحتساب متوسط الفاتورة`;
    } else if (isCollectedPayment) {
      headerTitleEl.textContent = `سندات ومدفوعات العملاء وحركات الخزينة/البنوك المحصلة: ${kpiTitle}`;
    } else {
      headerTitleEl.textContent = isSO
        ? `أوامر البيع المسجلة في Odoo: ${kpiTitle}`
        : `مستندات مؤشر: ${kpiTitle}`;
    }
  }
  const descEl = document.getElementById('kpiDrilldownDesc');
  if (descEl) {
    if (isReturnKpi) {
      descEl.innerHTML = `يعرض هذا الجدول <strong>إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo (Credit Notes - Out Refund)</strong> المطابقة تماماً للفترة المحددة، متوافقة بالكامل مع السجلات المحاسبية وقيد اليومية دون أي تضارب مع أوامر البيع. انقر على رقم الإشعار أو زر <strong>فتح في Odoo ↗</strong> لمعاينته مباشرة.`;
    } else if (isAvg) {
      descEl.innerHTML = isSO
        ? `يعرض الجدول أدناه جميع أوامر البيع المعتمدة لاحتساب متوسط قيمة أمر البيع بدقة: <strong>إجمالي أوامر البيع (البسط) ÷ عدد الأوامر (المقام)</strong>، دون أي تداخل مع حركات الإرجاع.`
        : `يعرض الجدول أدناه جميع فواتير المبيعات المعتمدة فقط لاحتساب متوسط قيمة الفاتورة بدقة: <strong>إجمالي المبيعات (البسط) ÷ عدد فواتير البيع (المقام)</strong>، مستبعداً المرتجعات تماماً لضمان سلامة ودقة المتوسط الحسابي.`;
    } else if (isCollectedPayment) {
      descEl.innerHTML = `يعرض هذا الجدول <strong>سندات ومدفوعات العملاء المحصلة وحركات الدفع الفعلي (Customer Payments - account.payment)</strong> المسجلة في الخزينة أو البنوك والمطابقة تماماً للفترة المحددة، متوافقة بالكامل مع سندات القبض المعتمدة دون أي تداخل مع أوامر البيع. انقر على رقم السند أو زر <strong>فتح في Odoo ↗</strong> للانتقال مباشرة لشاشة السند في نظام أودو.`;
    } else {
      descEl.innerHTML = isSO
        ? `يعرض هذا الجدول أوامر البيع المسجلة في أودو لنفس الفترة والمحددات المطبقة بلوحة التحكم. انقر على رقم أمر البيع أو زر <strong>فتح في Odoo ↗</strong> للانتقال مباشرة لشاشة المستند في نظام أودو.`
        : `يعرض هذا الجدول فواتير المبيعات والقيود المعتمدة المطابقة لنفس الفترة والمحددات المطبقة بلوحة التحكم. انقر على رقم المستند أو زر <strong>فتح في Odoo ↗</strong> للانتقال مباشرة لشاشة المستند في نظام أودو.`;
    }
  }
  if (searchInput) {
    searchInput.value = '';
    if (isReturnKpi) {
      searchInput.placeholder = 'بحث برقم إشعار الدائن، اسم العميل، المندوب، أو المدينة...';
    } else if (isAvg) {
      searchInput.placeholder = isSO
        ? 'بحث برقم أمر البيع، اسم العميل، المندوب، أو المدينة...'
        : 'بحث برقم الفاتورة، اسم العميل، المندوب، أو المدينة...';
    } else if (isCollectedPayment) {
      searchInput.placeholder = 'بحث برقم السند، اسم العميل، الخزينة/البنك، المندوب، أو المدينة...';
    } else {
      searchInput.placeholder = isSO
        ? 'بحث برقم أمر البيع، اسم العميل، المندوب، أو المدينة...'
        : 'بحث برقم المستند، اسم العميل، المندوب، أو المدينة...';
    }
  }
  if (statusFilter) {
    if (isReturnKpi) {
      statusFilter.innerHTML = `
        <option value="all">جميع إشعارات الدائن ومرتجعات المبيعات</option>
        <option value="paid">مسدد / مردود بالكامل</option>
        <option value="in_payment">قيد السداد / الصرف</option>
        <option value="partial">تسوية / رد جزئي</option>
        <option value="not_paid">رصيد دائن قائم للعميل (غير مسوى)</option>
      `;
    } else if (isAvg) {
      statusFilter.innerHTML = `
        <option value="all">جميع فواتير المبيعات المعتمدة</option>
        <option value="paid">مدفوع بالكامل</option>
        <option value="in_payment">قيد السداد</option>
        <option value="partial">سداد جزئي</option>
        <option value="not_paid">غير مدفوع</option>
      `;
    } else if (isCollectedPayment) {
      statusFilter.innerHTML = `
        <option value="all">جميع سندات وحركات الدفع في الخزينة/البنك</option>
        <option value="inbound">سندات القبض (تحصيلات العملاء)</option>
        <option value="outbound">سندات الصرف والرد (مرتجع نقدية للعميل)</option>
        <option value="paid">حركات مكتملة ومحصلة (Paid)</option>
        <option value="in_process">حركات قيد المعالجة (In Process)</option>
      `;
    } else if (isSO) {
      statusFilter.innerHTML = `
        <option value="all">جميع أوامر البيع</option>
        <option value="paid">أوامر معتمدة ومكتملة</option>
        <option value="not_paid">عروض أسعار ومسودات</option>
      `;
    } else {
      statusFilter.innerHTML = `
        <option value="all">جميع حالات السداد</option>
        <option value="paid">مدفوع بالكامل</option>
        <option value="in_payment">قيد السداد</option>
        <option value="partial">سداد جزئي</option>
        <option value="not_paid">غير مدفوع</option>
        <option value="refund">إشعارات خصم (مرتجعات)</option>
      `;
    }
    statusFilter.value = 'all';
  }

  const theadEl = document.querySelector('#kpiDrilldownTable thead');
  if (theadEl) {
    if (isReturnKpi) {
      theadEl.innerHTML = `
        <tr>
          <th style="width:40px;">#</th>
          <th>رقم إشعار الدائن</th>
          <th>نوع المستند</th>
          <th>العميل</th>
          <th>المندوب</th>
          <th>المنطقة / المدينة</th>
          <th>تاريخ إشعار الدائن</th>
          <th>قيمة المرتجع</th>
          <th>المسدد / المردود</th>
          <th>الرصيد الدائن المتبقي</th>
          <th>حالة التسوية</th>
          <th>رابط Odoo</th>
        </tr>
      `;
    } else if (isCollectedPayment) {
      theadEl.innerHTML = `
        <tr>
          <th style="width:40px;">#</th>
          <th>رقم سند القبض / الحركة</th>
          <th>نوع الحركة / الخزينة</th>
          <th>العميل</th>
          <th>المندوب</th>
          <th>المنطقة / المدينة</th>
          <th>تاريخ التحصيل</th>
          <th>المبلغ المحصل</th>
          <th>المسدد للخزينة</th>
          <th>المتبقي</th>
          <th>حالة الحركة</th>
          <th>رابط Odoo</th>
        </tr>
      `;
    } else {
      theadEl.innerHTML = `
        <tr>
          <th style="width:40px;">#</th>
          <th>${isSO ? 'رقم أمر البيع' : 'رقم المستند / القيد'}</th>
          <th>النوع</th>
          <th>العميل</th>
          <th>المندوب</th>
          <th>المنطقة / المدينة</th>
          <th>${isSO ? 'تاريخ أمر البيع' : 'تاريخ المستند'}</th>
          <th>إجمالي القيمة</th>
          <th>${isSO ? 'القيمة المؤكدة' : 'المسدد'}</th>
          <th>${isSO ? 'المتبقي' : 'المتبقي'}</th>
          <th>${isSO ? 'حالة الأمر' : 'حالة السداد'}</th>
          <th>رابط Odoo</th>
        </tr>
      `;
    }
  }

  const iconMap = {
    gross: '💰',
    returns: '↩',
    net: '◈',
    collected: '💳',
    outstanding: '⚠',
    invoices: '▤',
    returnsCount: '↩',
    avgInvoice: '📊'
  };
  if (iconEl) iconEl.textContent = iconMap[kpiKey] || '📑';

  const curYear = new Date().getFullYear();
  const start = liveDashboard.filters?.startDate || liveDashboard.data?.filters?.start || `${curYear}-01-01`;
  const end = liveDashboard.filters?.endDate || liveDashboard.data?.filters?.end || `${curYear}-12-31`;
  let sourceLabel = '';
  if (isReturnKpi) {
    sourceLabel = 'إشعارات الدائن ومرتجعات المبيعات المعتمدة في Odoo (Credit Notes)';
  } else if (isCollectedPayment) {
    sourceLabel = 'سندات القبض وحركات الدفع الفعلي في Odoo (Customer Payments)';
  } else if (isSO) {
    sourceLabel = 'أوامر البيع (Sale Orders)';
  } else {
    sourceLabel = 'فواتير المبيعات (Posted Invoices)';
  }
  let filterDesc = `الفترة: ${start} إلى ${end} | المصدر: ${sourceLabel}`;
  if (liveDashboard.filters.rep) {
    const repSelect = document.getElementById('repFilter');
    const repName = repSelect?.options[repSelect.selectedIndex]?.text || liveDashboard.filters.rep;
    filterDesc += ` | المندوب: ${repName}`;
  }
  if (liveDashboard.filters.customer) {
    const custSelect = document.getElementById('customerFilter');
    const custName = custSelect?.options[custSelect.selectedIndex]?.text || liveDashboard.filters.customer;
    filterDesc += ` | العميل: ${custName}`;
  }
  if (liveDashboard.filters.region) {
    filterDesc += ` | المنطقة: ${liveDashboard.filters.region}`;
  }
  if (liveDashboard.filters.city) {
    filterDesc += ` | المدينة: ${liveDashboard.filters.city}`;
  }
  if (filterSummaryEl) filterSummaryEl.textContent = filterDesc;

  // Reset counters
  const countEl = document.getElementById('kpiDrilldownTotalCount');
  const amountEl = document.getElementById('kpiDrilldownTotalAmount');
  const paidEl = document.getElementById('kpiDrilldownTotalPaid');
  const residualEl = document.getElementById('kpiDrilldownTotalResidual');
  if (countEl) countEl.textContent = '...';
  if (amountEl) amountEl.textContent = '...';
  if (paidEl) paidEl.textContent = '...';
  if (residualEl) residualEl.textContent = '...';

  // Show Loading state
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align:center;padding:44px;color:var(--ks-champagne);">
          <div style="font-size:24px;margin-bottom:8px;">⏳</div>
          <div style="font-size:15px;font-weight:700;">جاري الاتصال بنظام Odoo وجلب القيود والمستندات المطابقة...</div>
          <div style="font-size:12px;color:var(--ks-text-muted);margin-top:4px;">تطبيق نفس فلاتر الفترة، المندوب، والعميل المحددة</div>
        </td>
      </tr>
    `;
  }

  // Open overlay
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Build API Query params
  const params = new URLSearchParams();
  params.set('kpi', kpiKey);
  params.set('source', liveDashboard.filters.source || 'postedInvoice');
  params.set('startDate', start);
  params.set('endDate', end);
  params.set('start', start);
  params.set('end', end);
  if (liveDashboard.filters.year) params.set('year', liveDashboard.filters.year);
  if (liveDashboard.filters.month) params.set('month', liveDashboard.filters.month);
  if (liveDashboard.filters.period) params.set('period', liveDashboard.filters.period);
  if (liveDashboard.filters.day) params.set('day', liveDashboard.filters.day);
  params.set('salesOrderStatus', liveDashboard.filters.salesOrderStatus || 'all');
  if (liveDashboard.filters.rep) params.set('rep', liveDashboard.filters.rep);
  if (liveDashboard.filters.customer) params.set('customer', liveDashboard.filters.customer);
  if (liveDashboard.filters.region) params.set('region', liveDashboard.filters.region);
  if (liveDashboard.filters.city) params.set('city', liveDashboard.filters.city);
  if (liveDashboard.filters.product) params.set('product', liveDashboard.filters.product);
  if (liveDashboard.filters.category) params.set('category', liveDashboard.filters.category);
  if (liveDashboard.filters.query) params.set('query', liveDashboard.filters.query);

  fetch(`/api/dashboard/kpi-drilldown?${params.toString()}`, { credentials: 'same-origin' })
    .then(res => {
      if (!res.ok) {
        return res.json().catch(() => ({})).then(failure => {
          throw new Error(failure.error || 'فشل جلب تفاصيل القيود من الخادم');
        });
      }
      return res.json();
    })
    .then(data => {
      liveDashboard.kpiDrilldownData = data;
      renderKpiDrilldownContent(data);
    })
    .catch(err => {
      console.error('kpi-drilldown error:', err);
      const friendly = formatUserFriendlyError(err);
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" style="text-align:center;padding:36px;color:var(--ks-champagne);">
              <div style="font-size:26px;margin-bottom:8px;">⚠️</div>
              <div style="font-size:14px;font-weight:700;color:var(--ks-warning);margin-bottom:6px;">تعذر تحميل تفاصيل القيود من Odoo</div>
              <div style="font-size:12px;color:var(--ks-text-muted);margin-bottom:14px;max-width:440px;margin-inline:auto;line-height:1.5;">${friendly}</div>
              <button class="export-btn" style="display:inline-flex;margin:0 auto;height:32px;padding:0 16px;font-size:12px;" onclick="fetchKpiDrilldownData('${kpi}', '${source}')">
                <span>🔄</span> <span>إعادة المحاولة</span>
              </button>
            </td>
          </tr>
        `;
      }
    });
}

function closeKpiDrilldownModal() {
  const overlay = document.getElementById('kpiDrilldownModalOverlay');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}

function renderKpiDrilldownContent(data) {
  if (!data) return;
  const countEl = document.getElementById('kpiDrilldownTotalCount');
  const amountEl = document.getElementById('kpiDrilldownTotalAmount');
  const paidEl = document.getElementById('kpiDrilldownTotalPaid');
  const residualEl = document.getElementById('kpiDrilldownTotalResidual');

  const countLbl = document.getElementById('kpiDrilldownTotalCountLbl');
  const amountLbl = document.getElementById('kpiDrilldownTotalAmountLbl');
  const paidLbl = document.getElementById('kpiDrilldownTotalPaidLbl');
  const residualLbl = document.getElementById('kpiDrilldownTotalResidualLbl');

  const kpiKey = liveDashboard.kpiDrilldownCurrentKey;
  const isReturnKpi = kpiKey === 'returns' || kpiKey === 'returnsCount';
  const isAvg = kpiKey === 'avgInvoice';
  const isSO = (liveDashboard.filters.source || 'postedInvoice') === 'salesOrder';
  const isPayment = kpiKey === 'collected';

  if (countLbl) {
    if (isReturnKpi) {
      countLbl.textContent = 'عدد إشعارات الدائن (المرتجعات)';
    } else if (isAvg) {
      countLbl.textContent = isSO ? 'عدد أوامر البيع (المقام)' : 'عدد فواتير البيع (المقام)';
    } else if (isPayment) {
      countLbl.textContent = 'عدد سندات التحصيل';
    } else {
      countLbl.textContent = isSO ? 'إجمالي عدد أوامر البيع' : 'إجمالي عدد المستندات';
    }
  }
  if (amountLbl) {
    if (isReturnKpi) {
      amountLbl.textContent = 'إجمالي قيمة المرتجعات';
    } else if (isAvg) {
      amountLbl.textContent = isSO ? 'إجمالي أوامر البيع (البسط)' : 'إجمالي مبيعات الفواتير (البسط)';
    } else if (isPayment) {
      amountLbl.textContent = 'إجمالي النقدية المقبوضة';
    } else {
      amountLbl.textContent = isSO ? 'إجمالي قيمة الأوامر' : 'إجمالي القيمة';
    }
  }
  if (paidLbl) {
    if (isReturnKpi) {
      paidLbl.textContent = 'المبالغ المردودة / المسواة';
    } else if (isAvg) {
      paidLbl.textContent = isSO ? 'متوسط أمر البيع (الناتج)' : 'متوسط قيمة الفاتورة (الناتج)';
    } else if (isPayment) {
      paidLbl.textContent = 'المسدد للخزينة / البنك';
    } else {
      paidLbl.textContent = isSO ? 'القيمة المؤكدة' : 'المبالغ المسددة / المحصلة';
    }
  }
  if (residualLbl) {
    if (isReturnKpi) {
      residualLbl.textContent = 'الرصيد الدائن المتبقي للعملاء';
    } else if (isAvg) {
      residualLbl.textContent = 'الأرصدة المتبقية (مديونية)';
    } else if (isPayment) {
      residualLbl.textContent = 'المتبقي';
    } else {
      residualLbl.textContent = isSO ? 'المتبقي للتحصيل' : 'الأرصدة المتبقية (مديونية)';
    }
  }

  if (countEl) countEl.textContent = formatCount(data.count || 0);
  if (amountEl) amountEl.textContent = formatMoney(data.totalAmount || 0);
  if (paidEl) {
    if (isAvg) {
      const avgVal = data.avgInvoice ?? (data.count ? (data.totalAmount / data.count) : 0);
      paidEl.textContent = formatMoney(avgVal);
      paidEl.style.color = 'var(--ks-purple, #a855f7)';
    } else {
      paidEl.textContent = formatMoney(data.totalPaid || 0);
      paidEl.style.color = 'var(--ks-success)';
    }
  }
  if (residualEl) residualEl.textContent = formatMoney(data.totalResidual || 0);

  filterKpiDrilldownTable();
}

function filterKpiDrilldownTable() {
  const data = liveDashboard.kpiDrilldownData;
  const records = data?.records || [];
  const tbody = document.getElementById('kpiDrilldownTableBody');
  const footerSummary = document.getElementById('kpiDrilldownFooterSummary');
  if (!tbody) return;

  const curYear = new Date().getFullYear();
  const activeStart = liveDashboard.filters?.startDate || liveDashboard.data?.filters?.start || `${curYear}-01-01`;
  const activeEnd = liveDashboard.filters?.endDate || liveDashboard.data?.filters?.end || `${curYear}-12-31`;

  const q = (document.getElementById('kpiDrilldownSearch')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('kpiDrilldownStatusFilter')?.value || 'all';

  const filtered = records.filter(r => {
    // Strict Date Boundary Enforcement: Never allow records outside [activeStart, activeEnd]
    if (r.date && (r.date < activeStart || r.date > activeEnd)) {
      return false;
    }

    if (statusFilter !== 'all') {
      if (statusFilter === 'inbound') {
        if (r.isRefund) return false;
      } else if (statusFilter === 'outbound') {
        if (!r.isRefund) return false;
      } else if (statusFilter === 'refund') {
        if (!r.isRefund) return false;
      } else if (statusFilter === 'paid') {
        if (r.paymentStatusCode !== 'paid' && !r.paymentState?.includes('معتمد') && !r.paymentState?.includes('مسدد') && !r.paymentState?.includes('مكتمل')) return false;
      } else if (statusFilter === 'in_process') {
        if (r.paymentStatusCode !== 'in_process' && r.paymentStatusCode !== 'inprocess' && !r.paymentState?.includes('قيد المعالجة')) return false;
      } else if (statusFilter === 'not_paid') {
        if (r.paymentStatusCode !== 'not_paid' && !r.paymentState?.includes('مسودة') && !r.paymentState?.includes('عرض سعر') && !r.paymentState?.includes('غير مدفوع') && !r.paymentState?.includes('رصيد دائن قائم')) return false;
      } else if (r.paymentStatusCode !== statusFilter) {
        return false;
      }
    }
    if (q) {
      const txt = `${r.name || ''} ${r.customer || ''} ${r.rep || ''} ${r.city || ''} ${r.region || ''} ${r.ref || ''} ${r.journal || ''} ${r.typeLabel || ''} ${r.paymentState || ''}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  const kpiKey = liveDashboard.kpiDrilldownCurrentKey;
  const isReturnKpi = kpiKey === 'returns' || kpiKey === 'returnsCount';
  const isAvg = kpiKey === 'avgInvoice';

  if (footerSummary) {
    const totalCount = data?.count || records.length;
    if (isReturnKpi) {
      footerSummary.textContent = `عرض ${formatCount(filtered.length)} من إجمالي ${formatCount(records.length)} إشعار دائن ومرتجع معتمد في Odoo للفترة المحددة (${activeStart} إلى ${activeEnd}).`;
    } else if (isAvg) {
      const avgVal = data?.avgInvoice ?? (data?.count ? (data.totalAmount / data.count) : 0);
      const isSO = (liveDashboard.filters.source || 'postedInvoice') === 'salesOrder';
      footerSummary.innerHTML = isSO
        ? `معادلة الاحتساب: إجمالي أوامر البيع (<strong>${formatMoney(data?.totalAmount || 0)}</strong>) ÷ عدد أوامر البيع (<strong>${formatCount(totalCount)}</strong>) = <strong style="color:var(--ks-purple, #a855f7);">${formatMoney(avgVal)}</strong> لكل أمر بيع معتمد.`
        : `معادلة الاحتساب: إجمالي المبيعات (<strong>${formatMoney(data?.totalAmount || 0)}</strong>) ÷ عدد فواتير البيع (<strong>${formatCount(totalCount)}</strong>) = <strong style="color:var(--ks-purple, #a855f7);">${formatMoney(avgVal)}</strong> لكل فاتورة بيع صافية. (تم استبعاد حركات المرتجعات تماماً).`;
    } else if (kpiKey === 'collected') {
      const inboundCnt = data?.inboundCount ?? records.filter(r => !r.isRefund).length;
      const outboundCnt = data?.outboundCount ?? records.filter(r => r.isRefund).length;
      const netPaid = formatMoney(data?.totalPaid ?? data?.totalAmount ?? 0);
      if (outboundCnt > 0) {
        footerSummary.innerHTML = `عرض ${formatCount(filtered.length)} من إجمالي <strong>${formatCount(totalCount)}</strong> حركة دفع في Odoo للفترة (${activeStart} إلى ${activeEnd}) [${formatCount(inboundCnt)} سند قبض و ${formatCount(outboundCnt)} سند صرف/رد للعملاء | الصافي المسدد للخزينة: <strong style="color:var(--ks-success);">${netPaid}</strong> (مطابق لأودو)].`;
      } else {
        footerSummary.textContent = `عرض ${formatCount(filtered.length)} من إجمالي ${formatCount(totalCount)} سند قبض وتحصيل نقدي معتمد في Odoo للفترة المحددة (${activeStart} إلى ${activeEnd}).`;
      }
    } else if (records.length < totalCount) {
      footerSummary.textContent = `عرض أول ${formatCount(records.length)} سجل من إجمالي ${formatCount(totalCount)} سجل ومستند مطابق في Odoo للفترة (${activeStart} إلى ${activeEnd}).`;
    } else {
      footerSummary.textContent = `عرض ${formatCount(filtered.length)} من إجمالي ${formatCount(records.length)} سجل ومستند في Odoo للفترة (${activeStart} إلى ${activeEnd}).`;
    }
  }

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align:center;padding:36px;color:var(--ks-text-muted);">
          ${records.length === 0 ? (kpiKey === 'collected' ? 'لا توجد سندات قبض أو مدفوعات مسجلة مطابقة للفترة والمحددات المختارة.' : 'لا توجد قيود أو فواتير مسجلة مطابقة للفترة والمحددات المختارة.') : 'لا توجد نتائج مطابقة لبحثك في قائمة السجلات.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const isRefund = Boolean(r.isRefund || r.amount < 0);
    const amountClass = isRefund ? 'color:var(--ks-warning);' : 'color:var(--ks-champagne);';

    let badgeClass = 'payment-badge ';
    if (r.paymentStatusCode === 'paid') badgeClass += 'paid';
    else if (r.paymentStatusCode === 'in_payment' || r.paymentStatusCode === 'in_process' || r.paymentStatusCode === 'inprocess') badgeClass += 'in_payment';
    else if (r.paymentStatusCode === 'partial') badgeClass += 'partial';
    else if (isRefund && !isReturnKpi) badgeClass += 'reversed';
    else badgeClass += 'not_paid';

    const displayPaid = isRefund
      ? (r.paid > 0 ? `-${formatMoney(Math.abs(r.paid))}` : formatMoney(0))
      : formatMoney(r.paid);

    const displayResidual = isRefund
      ? (r.residual > 0 ? `-${formatMoney(Math.abs(r.residual))}` : formatMoney(0))
      : formatMoney(r.residual);

    return `
      <tr>
        <td style="color:var(--ks-text-muted);font-size:12px;">${r.index}</td>
        <td>
          <a href="${r.odooLink}" target="_blank" rel="noopener noreferrer" class="odoo-direct-link" title="انقر لفتح المستند مباشرة في Odoo">
            <span>${r.name}</span> <span style="font-size:10px;">↗</span>
          </a>
        </td>
        <td>
          <span style="font-size:11px;font-weight:600;color:${isRefund ? 'var(--ks-warning)' : 'var(--ks-text-muted)'};">
            ${r.typeLabel}
          </span>
        </td>
        <td><strong>${r.customer}</strong></td>
        <td>${r.rep}</td>
        <td>${r.region !== 'غير محدد' ? `${r.region} - ${r.city}` : r.city}</td>
        <td style="font-size:12px;font-family:'Albert Sans', monospace;">${r.date}</td>
        <td style="font-weight:700;${amountClass}">${isRefund ? `-${formatMoney(Math.abs(r.amount))}` : formatMoney(r.amount)}</td>
        <td style="color:${isRefund ? (r.paid > 0 ? 'var(--ks-success)' : 'var(--ks-text-muted)') : 'var(--ks-success)'};">${displayPaid}</td>
        <td style="${r.residual > 0 ? 'color:var(--ks-warning);font-weight:600;' : 'color:var(--ks-text-muted);'}">
          ${displayResidual}
        </td>
        <td>
          <span class="${badgeClass}">${r.paymentState}</span>
        </td>
        <td>
          <a href="${r.odooLink}" target="_blank" rel="noopener noreferrer" class="odoo-action-btn" title="انتقال مباشر لشاشة المستند في أودو">
            فتح في Odoo ↗
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

function exportKpiDrilldownToExcel() {
  const data = liveDashboard.kpiDrilldownData;
  const records = data?.records || [];
  if (!records.length) {
    alert('لا توجد بيانات متاحة للتصدير');
    return;
  }

  const curYear = new Date().getFullYear();
  const activeStart = liveDashboard.filters?.startDate || liveDashboard.data?.filters?.start || `${curYear}-01-01`;
  const activeEnd = liveDashboard.filters?.endDate || liveDashboard.data?.filters?.end || `${curYear}-12-31`;

  const q = (document.getElementById('kpiDrilldownSearch')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('kpiDrilldownStatusFilter')?.value || 'all';

  const rows = records.filter(r => {
    if (r.date && (r.date < activeStart || r.date > activeEnd)) {
      return false;
    }
    if (statusFilter !== 'all') {
      if (statusFilter === 'refund') {
        if (!r.isRefund) return false;
      } else if (r.paymentStatusCode !== statusFilter) {
        return false;
      }
    }
    if (q) {
      const txt = `${r.name || ''} ${r.customer || ''} ${r.rep || ''} ${r.city || ''} ${r.region || ''} ${r.ref || ''} ${r.journal || ''} ${r.typeLabel || ''}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  if (!rows.length) {
    alert('لا توجد سجلات مطابقة للفلتر للتصدير');
    return;
  }

  const kpiKey = liveDashboard.kpiDrilldownCurrentKey;
  const isReturnKpi = kpiKey === 'returns' || kpiKey === 'returnsCount';
  const isSO = (liveDashboard.filters.source || 'postedInvoice') === 'salesOrder';
  const isCollectedPayment = kpiKey === 'collected';

  const excelRows = rows.map((r, idx) => {
    if (isReturnKpi) {
      return {
        'م': idx + 1,
        'رقم إشعار الدائن': r.name || '',
        'نوع المستند': r.typeLabel || 'إشعار دائن مرتجع',
        'العميل': r.customer || '',
        'المندوب': r.rep || '',
        'المنطقة / المحافظة': r.region || '',
        'المدينة': r.city || '',
        'تاريخ إشعار الدائن': r.date || '',
        'قيمة المرتجع (ج.م)': r.amount,
        'المسدد / المردود (ج.م)': r.paid,
        'الرصيد الدائن المتبقي (ج.م)': r.residual,
        'البيان / المرجع': r.ref || '',
        'حالة التسوية': r.paymentState || '',
        'رابط المستند في أودو': r.odooLink || ''
      };
    }
    if (isCollectedPayment) {
      return {
        'م': idx + 1,
        'رقم سند القبض / الحركة': r.name || '',
        'نوع الحركة / الخزينة': r.typeLabel || '',
        'العميل': r.customer || '',
        'المندوب': r.rep || '',
        'المنطقة / المحافظة': r.region || '',
        'المدينة': r.city || '',
        'تاريخ التحصيل': r.date || '',
        'المبلغ المحصل (ج.م)': r.amount,
        'المسدد للخزينة (ج.م)': r.paid,
        'البيان / الملاحظات': r.ref || 'سداد معتمد',
        'حالة الحركة': r.paymentState || '',
        'رابط المستند في أودو': r.odooLink || ''
      };
    }
    return {
      'م': idx + 1,
      'رقم المستند / الأمر': r.name || '',
      'النوع': r.typeLabel || (isSO ? 'أمر بيع' : 'فاتورة بيع'),
      'العميل': r.customer || '',
      'المندوب': r.rep || '',
      'المنطقة / المحافظة': r.region || '',
      'المدينة': r.city || '',
      'التاريخ': r.date || '',
      'إجمالي القيمة (ج.م)': r.amount,
      [isSO ? 'القيمة المؤكدة (ج.م)' : 'المسدد / المحصل (ج.م)']: r.paid,
      [isSO ? 'المتبقي (ج.م)' : 'المتبقي / المديونية (ج.م)']: r.residual,
      [isSO ? 'حالة أمر البيع' : 'حالة السداد']: r.paymentState || '',
      'رابط المستند في أودو': r.odooLink || ''
    };
  });

  const sheetName = (data.title || 'سجلات القيود Odoo').slice(0, 31);
  const wb = createWorkbook({ [sheetName]: excelRows });
  const filename = `تقرير-مستندات-أودو-${liveDashboard.kpiDrilldownCurrentKey || 'kpi'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  xlsxDownload(wb, filename);
}

function xlsxDownload(wb, filename) {
  showLoading('جاري معالجة وتصدير ملف Excel...');
  setTimeout(() => {
    try {
      if (typeof XLSX !== 'undefined') {
        XLSX.writeFile(wb, filename);
      } else {
        alert('مكتبة SheetJS قيد التحميل، يرجى المحاولة مرة أخرى.');
      }
    } finally {
      hideLoading();
    }
  }, 60);
}

function createWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => {
    if (rows?.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  });
  return wb;
}

function exportDashboard() {
  const d = liveDashboard.data || {};
  const kpis = d.kpis || {};
  const rows = [
    { المؤشر: 'إجمالي المبيعات', القيمة: kpis.gross },
    { المؤشر: 'المرتجعات', القيمة: kpis.returns },
    { المؤشر: 'صافي المبيعات', القيمة: kpis.net },
    { المؤشر: 'المحصل', القيمة: kpis.collected },
    { المؤشر: 'إجمالي فواتير البيع والمرتجعات المرحّلة (عدد الحركات المعتمدة - Posted)', القيمة: kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount) },
    { المؤشر: 'عدد فواتير البيع المعتمدة', القيمة: kpis.invoicesCount },
    { المؤشر: 'عدد إشعارات الخصم والمرتجعات', القيمة: kpis.returnsCount }
  ];
  const wb = createWorkbook({
    'الملخص': rows,
    'النمو': window._lastGrowthChartData || [],
    'المناطق': window._lastGeoChartData || [],
    'المنتجات': window._lastProductChartData || [],
    'المندوبون': window._lastRepsData || [],
    'المرتجعات': window._lastReturnsData || [],
    'التفصيلي': d.drilldown || [],
    'العملاء': d.growthAnalysis?.customers || []
  });
  xlsxDownload(wb, 'تقرير-مبيعات-مصنع-الشيخ.xlsx');
}

function exportProductChartToExcel() {
  const rows = window._lastProductChartData || [];
  if (!rows.length) return alert('لا توجد بيانات لتصديرها');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'المنتجات');
  xlsxDownload(wb, 'أفضل-المنتجات.xlsx');
}

function exportSalesRepsToExcel() {
  const rows = window._lastRepsData || liveDashboard.data?.reps || [];
  if (!rows.length) return alert('لا توجد بيانات للمندوبين لتصديرها');
  const exportRows = rows.map((r, idx) => ({
    'م': idx + 1,
    'اسم المندوب': r.name || 'غير محدد',
    'عدد الفواتير والمستندات': r.count || 0,
    'إجمالي المبيعات (ج.م)': (r.gross !== undefined && r.gross !== null) ? r.gross : r.achieved,
    'المرتجعات (ج.م)': r.returns || 0,
    'صافي المبيعات (ج.م)': r.achieved || 0,
    'المبلغ المحصل (ج.م)': r.collected || 0,
    'المديونية المتبقية (ج.م)': r.remaining || 0,
    'نسبة المساهمة من المبيعات': `${r.contributionRate ?? r.percentage ?? 0}%`,
    'الهدف البيعي من أودو': (r.hasTarget && r.target > 0) ? r.target : 'غير محدد في أودو',
    'نسبة تحقيق الهدف': (r.hasTarget && r.target > 0) ? `${r.percentage}%` : 'لا يوجد هدف محدد'
  }));
  const wb = createWorkbook({ 'أداء المندوبين': exportRows });
  xlsxDownload(wb, 'أداء-مندوبي-المبيعات.xlsx');
}

function exportGrowthChartToExcel() {
  const rows = window._lastGrowthChartData || [];
  if (!rows.length) return alert('لا توجد بيانات لتصديرها');
  const wb = createWorkbook({ النمو: rows, العملاء: liveDashboard.data?.growthAnalysis?.customers || [], المناطق: liveDashboard.data?.growthAnalysis?.regions || [] });
  xlsxDownload(wb, 'تقرير-النمو-الشهري.xlsx');
}

function exportGeoChartToExcel() {
  const rows = window._lastGeoChartData || [];
  if (!rows.length) return alert('لا توجد بيانات لتصديرها');
  const wb = createWorkbook({ المناطق: rows, 'مقارنة المناطق': liveDashboard.data?.growthAnalysis?.regions || [] });
  xlsxDownload(wb, 'التوزيع-الجغرافي.xlsx');
}

function exportReturnsToExcel() {
  const returns = window._lastReturnsData || liveDashboard.data?.returns || [];
  if (!returns.length) return alert('لا توجد مرتجعات لتصديرها');
  const rows = returns.map((r, idx) => ({
    'م': idx + 1,
    'اسم الصنف والمنتج': r.product || '',
    'مرجع إشعار الخصم': r.creditNote || '',
    'التصنيف': r.category || 'غير محدد',
    'العميل': r.customer || 'غير محدد',
    'المندوب': r.rep || 'غير محدد',
    'المنطقة / المحافظة': r.region || 'غير محدد',
    'الكمية المرتجعة': r.returnedQty || 0,
    'إجمالي المرتجع (ج.م)': r.returns || 0,
    'رابط المستند في Odoo': r.odooLink || ''
  }));
  const wb = createWorkbook({ 'تقرير المرتجعات': rows });
  xlsxDownload(wb, 'تقرير-المرتجعات-Odoo.xlsx');
}

function exportComparisonMatrixToExcel() {
  const table = document.getElementById('comparisonMatrix');
  if (!table) return alert('لا توجد بيانات متاحة للتصدير');
  const wb = XLSX.utils.table_to_book(table, { sheet: 'المقارنة التحليلية' });
  xlsxDownload(wb, 'تقرير-المقارنة-التحليلية.xlsx');
}

function exportDetailTableToExcel() {
  const drilldown = liveDashboard.data?.drilldown || [];
  const flatRows = [];
  drilldown.forEach(reg => {
    flatRows.push({
      'المستوى': 'محافظة / منطقة',
      'المحافظة / المنطقة': reg.name,
      'المدينة': '—',
      'العميل': '—',
      'المندوب': '—',
      'عدد الفواتير': reg.invoices || 0,
      'إجمالي الكمية المباعة': reg.grossQty || 0,
      'الكمية المرتجعة': reg.returnedQty || 0,
      'صافي الكمية المباعة': reg.netQty || 0,
      'إجمالي المبيعات': reg.gross || (reg.sales + (reg.returns || 0)),
      'المبالغ المرتجعة': reg.returns || 0,
      'صافي المبيعات': reg.sales || 0,
      'المبالغ المحصلة': reg.collected || 0,
      'المديونية القائمة': reg.outstanding || 0,
      'نسبة التحصيل': (reg.rate || 0) + '%'
    });
    (reg.customers || []).forEach(cust => {
      flatRows.push({
        'المستوى': 'عميل',
        'المحافظة / المنطقة': cust.state,
        'المدينة': cust.city,
        'العميل': cust.name,
        'المندوب': cust.rep,
        'عدد الفواتير': cust.invoices || 0,
        'إجمالي الكمية المباعة': cust.grossQty || 0,
        'الكمية المرتجعة': cust.returnedQty || 0,
        'صافي الكمية المباعة': cust.netQty || 0,
        'إجمالي المبيعات': cust.gross || (cust.sales + (cust.returns || 0)),
        'المبالغ المرتجعة': cust.returns || 0,
        'صافي المبيعات': cust.sales || 0,
        'المبالغ المحصلة': cust.collected || 0,
        'المديونية القائمة': cust.outstanding || 0,
        'نسبة التحصيل': (cust.rate || 0) + '%'
      });
    });
  });

  const wb = createWorkbook({
    'التقرير التفصيلي': flatRows,
    'ملخص المناطق': drilldown.map(r => ({
      'المنطقة': r.name,
      'الفواتير': r.invoices,
      'إجمالي الكمية': r.grossQty || 0,
      'المرتجع': r.returnedQty || 0,
      'صافي الكمية': r.netQty || 0,
      'المبيعات': r.sales,
      'المحصل': r.collected,
      'المديونية': r.outstanding,
      'نسبة التحصيل': r.rate + '%'
    })),
    'العملاء': liveDashboard.data?.growthAnalysis?.customers || []
  });
  xlsxDownload(wb, 'التقرير-التفصيلي-للمبيعات.xlsx');
}

async function updateAuthUI() {
  const loginLink = document.getElementById('loginLink');
  const userProfile = document.getElementById('userProfile');
  const userNameDisplay = document.getElementById('userNameDisplay');

  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (response.ok) {
      const data = await response.json();
      if (data && data.authenticated) {
        if (loginLink) {
          loginLink.hidden = true;
          loginLink.style.setProperty('display', 'none', 'important');
        }
        if (userProfile) {
          userProfile.hidden = false;
          userProfile.style.removeProperty('display');
        }
        if (userNameDisplay) {
          userNameDisplay.textContent = `👤 ${data.username || 'مستخدم'}`;
        }
        return;
      }
    }
  } catch (e) {
    console.error('Failed to check auth status:', e);
  }

  // Not authenticated / public mode
  if (loginLink) {
    loginLink.hidden = false;
    loginLink.style.removeProperty('display');
  }
  if (userProfile) {
    userProfile.hidden = true;
    userProfile.style.setProperty('display', 'none', 'important');
  }
}

async function handleLogout() {
  showLoading('جاري تسجيل الخروج...');
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) {
    console.error('Logout failed:', e);
  }
  window.location.assign('/login.html');
}

let _repSortDir = null;
function toggleRepSort() {
  _repSortDir = _repSortDir === 'desc' ? 'asc' : 'desc';
  _drillSortField = null;

  // Visual feedback on the button
  const btn = document.querySelector('button[onclick="toggleRepSort()"]');
  if (btn) {
    btn.innerHTML = _repSortDir === 'desc' ? 'ترتيب المندوبين (تنازلي ↓)' : 'ترتيب المندوبين (تصاعدي ↑)';
    btn.style.borderColor = 'var(--ks-kinpaku-rich)';
    btn.style.color = '#818cf8';
    btn.style.background = 'rgba(99, 102, 241, 0.15)';
  }

  // Also sort reps in reps table card if present
  if (liveDashboard.data?.reps) {
    liveDashboard.data.reps.sort((a, b) => _repSortDir === 'desc' ? b.achieved - a.achieved : a.achieved - b.achieved);
    renderRepsTable(liveDashboard.data.reps);
  }

  // Ensure rep is selected in groupByFilter so user sees reps in tree
  const select = document.getElementById('groupByFilter');
  if (select) {
    const selectedVals = Array.from(select.selectedOptions).map(o => o.value);
    if (!selectedVals.includes('rep')) {
      for (const opt of select.options) {
        if (opt.value === 'rep') opt.selected = true;
      }
    }
  }

  renderDrilldownTable();
}

let _drillSortField = null;
let _drillSortAsc = false;

function sortDrilldown(field) {
  if (_drillSortField === field) {
    _drillSortAsc = !_drillSortAsc;
  } else {
    _drillSortField = field;
    _drillSortAsc = false;
  }

  // Reset rep sort button
  _repSortDir = null;
  const repBtn = document.querySelector('button[onclick="toggleRepSort()"]');
  if (repBtn) {
    repBtn.innerHTML = 'ترتيب المندوبين';
    repBtn.style.removeProperty('border-color');
    repBtn.style.removeProperty('color');
    repBtn.style.removeProperty('background');
  }

  renderDrilldownTable();
}

function updateChartColors() {
  if (typeof Chart === 'undefined') return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  Chart.defaults.color = isLight ? '#0f172a' : '#94a3b8';
  Chart.defaults.font.family = "'Cairo', sans-serif";
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('shekh_theme', next); } catch (e) {}
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = next === 'light' ? '☀️' : '🌙';
  updateChartColors();
  if (liveDashboard.data?.charts) {
    renderProductChart(liveDashboard.data.charts);
    renderGrowthChart(liveDashboard.data.charts);
    renderRegionalChart(liveDashboard.data.charts);
  }
}

function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('shekh_theme') || 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = saved === 'light' ? '☀️' : '🌙';
  updateChartColors();
}

window.applyFilters = applyLiveFilters;
window.onDataSourceChange = onDataSourceChange;
window.markFiltersPending = markFiltersPending;
window.clearFiltersPending = clearFiltersPending;
window.updateDayFilterOptions = updateDayFilterOptions;
window.setDateTab = setDateTab;
window.onCustomDateRangeChange = onCustomDateRangeChange;
window.onCustomDropdownChange = onCustomDropdownChange;
window.switchProductChart = switchProductChart;
window.setProductMetric = setProductMetric;
window.toggleView = toggleView;
window.toggleRepRow = toggleRepRow;
window.toggleRepSort = toggleRepSort;
window.sortDrilldown = sortDrilldown;
window.toggleRegionDrill = toggleRegionDrill;
window.expandAll = expandAll;
window.collapseAll = collapseAll;
window.toggleNotif = toggleNotif;
window.openChurnModal = openChurnModal;
window.closeChurnModal = closeChurnModal;
window.filterChurnModalTable = filterChurnModalTable;
window.filterDashboardByCustomer = filterDashboardByCustomer;
window.exportChurnWarningsToExcel = exportChurnWarningsToExcel;
window.toggleTheme = toggleTheme;
window.exportDashboard = exportDashboard;
window.exportProductChartToExcel = exportProductChartToExcel;
window.exportSalesRepsToExcel = exportSalesRepsToExcel;
window.exportGrowthChartToExcel = exportGrowthChartToExcel;
window.exportGeoChartToExcel = exportGeoChartToExcel;
window.exportReturnsToExcel = exportReturnsToExcel;
window.exportComparisonMatrixToExcel = exportComparisonMatrixToExcel;
window.exportDetailTableToExcel = exportDetailTableToExcel;
window.handleLogout = handleLogout;
window.updateAuthUI = updateAuthUI;
window.updateLoginLink = updateAuthUI;
window.refreshDashboard = () => loadLiveDashboard(true);
window.formatMoney = formatMoney;
window.formatNumber = formatNumber;
window.formatCount = formatCount;
window.openKpiDrilldown = openKpiDrilldown;
window.closeKpiDrilldownModal = closeKpiDrilldownModal;
window.filterKpiDrilldownTable = filterKpiDrilldownTable;
window.exportKpiDrilldownToExcel = exportKpiDrilldownToExcel;

// Back to Top Scroll Listener
window.addEventListener('scroll', () => {
  const btn = document.getElementById('backToTopBtn');
  if (btn) {
    if (window.scrollY > 200) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  }
}, { passive: true });

// Escape key closes modals
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeChurnModal();
    closeKpiDrilldownModal();
  }
});

// Initialize theme immediately
initTheme();

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  updateAuthUI();
  document.getElementById('growthGroupingFilter')?.addEventListener('change', event => {
    liveDashboard.growthGrouping = event.target.value || 'churn';
    liveDashboard.selectedChurnClient = null;
    const churnSel = document.getElementById('churnCustomerFilter');
    if (churnSel) churnSel.value = 'top15';
    renderGrowthChart(liveDashboard.data?.charts);
  });
  document.getElementById('dataSourceFilter')?.addEventListener('change', onDataSourceChange);
  document.getElementById('salesOrderStatusFilter')?.addEventListener('change', onSalesOrderStatusChange);
  document.getElementById('comparisonFilter')?.addEventListener('change', (e) => {
    const val = e.target?.value || 'previousPeriod';
    document.getElementById('matrixTabPrev')?.classList.toggle('active', val === 'previousPeriod');
    document.getElementById('matrixTabYear')?.classList.toggle('active', val === 'samePeriodLastYear');
    document.getElementById('matrixTabNone')?.classList.toggle('active', val === 'none');
    markFiltersPending();
  });
  // NOTE: Filter dropdowns no longer auto-trigger reloads on change.
  // All selections accumulate silently; user must click "تطبيق الفلاتر" to reload data.

  document.querySelectorAll('#drillTableHead th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.title = 'انقر للترتيب حسب هذا العمود';
    th.addEventListener('click', () => {
      const sortKey = th.getAttribute('data-sort');
      if (sortKey) sortDrilldown(sortKey);
    });
  });

  const globalSearchEl = document.getElementById('globalSearch');
  if (globalSearchEl) {
    globalSearchEl.addEventListener('input', () => {
      // Search term accumulates silently; click Apply Filters to reload.
      markFiltersPending();
    });
    globalSearchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyLiveFilters();
      }
    });
  }

  document.getElementById('groupByFilter')?.addEventListener('change', onGroupByFilterChange);

  // Initialize custom searchable selects for filter dropdowns
  initSearchableSelects();

  const activeDateTab = document.querySelector('.date-tab.active');
  if (activeDateTab) {
    // Set the initial date tab state (updates filter state only, no reload)
    setDateTab(activeDateTab, 'شهري');
  }
  // Always load data on initial login — this is the ONLY automatic load
  loadLiveDashboard();
});

function resetChurnSelection() {
  const select = document.getElementById('churnCustomerFilter');
  if (select) {
    select.value = 'top15';
    select.onchange?.();
  }
}

// Global exports for inline HTML event handlers
window.resetChurnSelection = resetChurnSelection;
window.toggleDrillNode = toggleDrillNode;
window.onGroupByFilterChange = onGroupByFilterChange;
window.toggleRepSort = toggleRepSort;
window.expandAll = expandAll;
window.collapseAll = collapseAll;
window.sortDrilldown = sortDrilldown;
window.renderDrilldownTable = renderDrilldownTable;
window.applyFilters = applyFilters;
window.applyLiveFilters = applyLiveFilters;
window.toggleView = toggleView;
window.switchProductChart = switchProductChart;
window.setProductMetric = setProductMetric;
window.setDateTab = setDateTab;
window.openChurnModal = openChurnModal;
window.closeChurnModal = closeChurnModal;
window.openKpiDrilldown = openKpiDrilldown;
window.closeKpiDrilldownModal = closeKpiDrilldownModal;
window.exportDetailTableToExcel = exportDetailTableToExcel;
window.exportDashboard = exportDashboard;
window.exportReturnsToExcel = exportReturnsToExcel;
window.exportComparisonMatrixToExcel = exportComparisonMatrixToExcel;
window.exportProductChartToExcel = exportProductChartToExcel;
window.exportGrowthChartToExcel = exportGrowthChartToExcel;
window.exportGeoChartToExcel = exportGeoChartToExcel;
window.onDataSourceChange = onDataSourceChange;
window.onSalesOrderStatusChange = onSalesOrderStatusChange;
window.onCustomDateRangeChange = onCustomDateRangeChange;
window.onCustomDropdownChange = onCustomDropdownChange;
window.markFiltersPending = markFiltersPending;
window.retryLoadDashboard = retryLoadDashboard;
window.dismissAlertBanner = dismissAlertBanner;
window.showDashboardAlert = showDashboardAlert;
window.toArabicDigits = toArabicDigits;
window.isArabic = isArabic;
window.getDashboardLanguage = getDashboardLanguage;
window.setDashboardLanguage = function(lang) {
  const normalized = (String(lang || '').toLowerCase().startsWith('en')) ? 'en' : 'ar';
  try {
    localStorage.setItem('foam_language', normalized);
  } catch (e) {}
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalized;
    document.documentElement.dir = normalized === 'ar' ? 'rtl' : 'ltr';
  }
  renderAllDashboardComponents();
};


