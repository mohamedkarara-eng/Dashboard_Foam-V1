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

const formatMoney = (val) => {
  const num = Number(val);
  const safeNum = Number.isFinite(num) ? num : 0;
  return safeNum.toLocaleString('ar-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' ج.م';
};

const formatNumber = (val, decimals = 2) => {
  const num = Number(val);
  const safeNum = Number.isFinite(num) ? num : 0;
  return safeNum.toLocaleString('ar-EG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

const formatCount = (val) => {
  const num = Math.round(Number(val) || 0);
  return num.toLocaleString('ar-EG');
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
    if (forceRefresh) params.set('refresh', '1');

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
    renderAllDashboardComponents();
  } catch (err) {
    console.error('Error loading live dashboard:', err.message);
    const errorNode = document.getElementById('dashboardError');
    if (errorNode) {
      errorNode.textContent = err.message || 'تعذر تحميل بيانات لوحة التحكم';
      errorNode.hidden = false;
    }
  } finally {
    hideLoading();
  }
}

function renderAllDashboardComponents() {
  if (!liveDashboard.data) return;
  const d = liveDashboard.data;

  renderFilterDropdowns(d.filterOptions);
  renderKpis(d.kpis, d.comparison?.kpis);
  renderProductChart(d.charts);
  renderGrowthChart(d.charts);
  renderRegionalChart(d.charts);
  renderRepsTable(d.reps);
  renderDrilldownTable(d.drilldown);
  renderReturnsTable(d.returns);
  renderChurnWarnings(d.churn);
  renderComparisonMatrix(d.kpis, d.comparison?.kpis);

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

function fillSelectOptions(id, items, defaultLabel, currentValue) {
  const select = document.getElementById(id);
  if (!select) return;
  const opts = ['<option value="">' + defaultLabel + '</option>'];
  (items || []).forEach(item => {
    const val = typeof item === 'object' ? (item.id ?? item.value ?? item.name) : item;
    const txt = typeof item === 'object' ? (item.name ?? item.label ?? item.value) : item;
    const sel = String(val) === String(currentValue) ? 'selected' : '';
    opts.push('<option value="' + String(val).replaceAll('"', '&quot;') + '" ' + sel + '>' + txt + '</option>');
  });
  select.innerHTML = opts.join('');
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
  const format = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ar-EG') : '';
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

  const drilldown = liveDashboard.data?.drilldown || [];
  const grossQty = kpis.grossQty ?? drilldown.reduce((sum, r) => sum + (r.grossQty || 0), 0);
  const returnsQty = kpis.returnsQty ?? drilldown.reduce((sum, r) => sum + (r.returnedQty || 0), 0);
  const netQty = kpis.netQty ?? Math.max(0, grossQty - returnsQty);
  const avgQtyInvoice = kpis.invoicesCount ? (netQty / kpis.invoicesCount) : 0;

  const calcChange = (curr, prior) => {
    if (prior === undefined || prior === null) return null;
    if (prior === 0) return curr > 0 ? '+100%' : '0.0%';
    const pct = ((curr - prior) / Math.abs(prior)) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
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
      sub: 'إجمالي الوحدات المباعة',
      val: formatNumber(grossQty) + ' قطعة',
      priorText: 'القيمة النقدية: ' + formatMoney(kpis.gross),
      icon: '📦',
      color: 'blue',
      extra: (isSO ? 'عدد الأوامر: ' : 'عدد الفواتير: ') + formatCount(kpis.invoicesCount),
      trend: 'كميات معتمدة',
      up: true
    },
    {
      key: 'returns',
      title: 'إجمالي الكميات المرتجعة',
      sub: 'إجمالي الوحدات المرتجعة',
      val: formatNumber(returnsQty) + ' قطعة',
      priorText: 'القيمة النقدية: ' + formatMoney(kpis.returns),
      icon: '↩',
      color: 'red',
      extra: 'عدد المرتجعات: ' + formatCount(kpis.returnsCount),
      trend: grossQty ? ((returnsQty / grossQty) * 100).toFixed(1) + '% نسبة إرجاع' : 'مرتجع',
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
      sub: 'إجمالي النقدية المحصلة',
      val: formatMoney(kpis.collected),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.collected)}` : '',
      icon: '💳',
      color: 'green',
      extra: 'نسبة التحصيل: ' + kpis.collectionRate + '%',
      trend: collectedDelta ? `${collectedDelta} vs ${compLabel}` : (kpis.collectionRate + '%'),
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
      title: isSO ? 'عدد أوامر البيع' : 'عدد الفواتير المعتمدة',
      sub: isSO ? 'أوامر بيع معتمدة' : 'إجمالي الحركات المعتمدة (Posted)',
      val: isSO ? formatCount(kpis.invoicesCount) : formatCount(kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount)),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(isSO ? comparisonKpis.invoicesCount : (comparisonKpis.totalPostedCount || comparisonKpis.invoicesCount))} ${isSO ? 'أمر' : 'حركة'}` : '',
      icon: '▤',
      color: 'blue',
      extra: isSO ? 'أمر بيع' : (kpis.returnsCount ? `${formatCount(kpis.invoicesCount)} فاتورة + ${formatCount(kpis.returnsCount)} مرتجع` : 'فاتورة رسمية'),
      trend: invoicesDelta ? `${invoicesDelta} vs ${compLabel}` : 'مكتمل',
      up: invoicesDelta ? invoicesDelta.startsWith('+') : true
    },
    {
      key: 'returnsCount',
      title: 'عدد المرتجعات',
      sub: 'أوامر الإرجاع',
      val: formatCount(kpis.returnsCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(comparisonKpis.returnsCount)} إشعار` : '',
      icon: '↩',
      color: 'red',
      extra: 'إشعار دائن',
      trend: 'مرتجع',
      up: false
    },
    {
      key: 'avgInvoice',
      title: isSO ? 'متوسط كمية أمر البيع' : 'متوسط كمية الفاتورة',
      sub: isSO ? 'متوسط الوحدات / أمر' : 'متوسط الوحدات / فاتورة',
      val: formatNumber(avgQtyInvoice) + ' قطعة',
      priorText: 'المتوسط النقدي: ' + formatMoney(kpis.avgInvoice),
      icon: '📊',
      color: 'purple',
      extra: isSO ? 'معدل أمر البيع (كمية)' : 'معدل الفاتورة (كمية)',
      trend: 'نشط',
      up: true
    }
  ] : [
    {
      key: 'gross',
      title: 'إجمالي المبيعات',
      sub: isSO ? 'إجمالي قيمة أوامر البيع' : 'إجمالي الفواتير (قبل المرتجعات)',
      val: formatMoney(kpis.gross),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.gross)}` : (grossQty ? `${formatNumber(grossQty)} قطعة` : ''),
      icon: '💰',
      color: 'blue',
      extra: (isSO ? 'عدد أوامر البيع: ' : 'عدد فواتير البيع: ') + formatCount(kpis.invoicesCount),
      trend: grossDelta ? `${grossDelta} vs ${compLabel}` : (kpis.collectionRate + '% تحصيل'),
      up: grossDelta ? grossDelta.startsWith('+') : true
    },
    {
      key: 'returns',
      title: 'إجمالي المرتجعات',
      sub: 'إشعارات الخصم والدائن',
      val: formatMoney(kpis.returns),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.returns)}` : (returnsQty ? `${formatNumber(returnsQty)} قطعة` : ''),
      icon: '↩',
      color: 'red',
      extra: 'عدد المرتجعات: ' + formatCount(kpis.returnsCount),
      trend: returnsDelta ? `${returnsDelta} vs ${compLabel}` : 'مرتجعات معتمدة',
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
      sub: 'إجمالي النقدية المحصلة',
      val: formatMoney(kpis.collected),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.collected)}` : '',
      icon: '💳',
      color: 'green',
      extra: 'نسبة التحصيل: ' + kpis.collectionRate + '%',
      trend: collectedDelta ? `${collectedDelta} vs ${compLabel}` : (kpis.collectionRate + '%'),
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
      title: isSO ? 'عدد أوامر البيع' : 'عدد الفواتير المعتمدة',
      sub: isSO ? 'أوامر بيع معتمدة' : 'إجمالي الحركات المعتمدة (Posted)',
      val: isSO ? formatCount(kpis.invoicesCount) : formatCount(kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount)),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(isSO ? comparisonKpis.invoicesCount : (comparisonKpis.totalPostedCount || comparisonKpis.invoicesCount))} ${isSO ? 'أمر' : 'حركة'}` : '',
      icon: '▤',
      color: 'blue',
      extra: isSO ? 'أمر بيع' : (kpis.returnsCount ? `${formatCount(kpis.invoicesCount)} فاتورة + ${formatCount(kpis.returnsCount)} مرتجع` : 'فاتورة رسمية'),
      trend: invoicesDelta ? `${invoicesDelta} vs ${compLabel}` : 'مكتمل',
      up: invoicesDelta ? invoicesDelta.startsWith('+') : true
    },
    {
      key: 'returnsCount',
      title: 'عدد المرتجعات',
      sub: 'أوامر الإرجاع',
      val: formatCount(kpis.returnsCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatCount(comparisonKpis.returnsCount)} إشعار` : '',
      icon: '↩',
      color: 'red',
      extra: 'إشعار دائن',
      trend: 'مرتجع',
      up: false
    },
    {
      key: 'avgInvoice',
      title: isSO ? 'متوسط أمر البيع' : 'متوسط قيمة الفاتورة',
      sub: isSO ? 'متوسط القيمة / أمر بيع' : 'متوسط المبيعات / فاتورة',
      val: formatMoney(kpis.avgInvoice),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.avgInvoice)}` : '',
      icon: '📊',
      color: 'purple',
      extra: isSO ? 'معدل أمر البيع' : 'معدل الفاتورة',
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

function renderProductChart(charts) {
  const canvas = document.getElementById('productChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const isTop = liveDashboard.productMode === 'top';
  const isQty = liveDashboard.metric === 'quantity';

  // Select appropriate dataset from backend charts payload
  let rawList = [];
  if (isQty) {
    rawList = isTop
      ? (charts.topProductsByQty || charts.topProducts || [])
      : (charts.bottomProductsByQty || charts.bottomProducts || []);
  } else {
    rawList = isTop
      ? (charts.topProductsByAmount || charts.topProducts || [])
      : (charts.bottomProductsByAmount || charts.bottomProducts || []);
  }

  // Ensure strict dynamic sorting according to active criterion
  const products = [...rawList].sort((a, b) => {
    const valA = isQty ? (Number(a.quantity) || 0) : (Number(a.amount) || 0);
    const valB = isQty ? (Number(b.quantity) || 0) : (Number(b.amount) || 0);
    return isTop ? (valB - valA) : (valA - valB);
  }).slice(0, 10);

  const labels = products.map(p => p.name);
  const values = products.map(p => isQty ? (p.quantity || 0) : (p.amount || 0));

  window._lastProductChartData = products.map(p => ({
    'المنتج': p.name,
    'القيمة (ج.م)': p.amount,
    'الكمية': p.quantity,
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
        label: isQty ? 'الكمية المباعة (قطعة)' : 'المبيعات (ج.م)',
        data: values,
        backgroundColor: isTop ? '#E65100' : '#CC4800',
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => isQty ? (formatNumber(ctx.raw) + ' قطعة') : formatMoney(ctx.raw)
          }
        }
      },
      scales: {
        x: {
          ticks: {
            callback: (v) => isQty ? formatNumber(v, 0) : (formatNumber(v, 0) + ' ج.م')
          }
        }
      },
      onClick: (_event, elements) => {
        const product = products[elements[0]?.index];
        const card = document.getElementById('productDetailCard');
        if (!product || !card) return;
        card.hidden = false;
        card.textContent = `${product.name} | الكمية: ${formatNumber(product.quantity)} قطعة | صافي القيمة: ${formatMoney(product.amount)}`;
      }
    }
  });

  // Sync local tab buttons on the chart card if present
  const valBtn = document.getElementById('prodMetricValBtn');
  const qtyBtn = document.getElementById('prodMetricQtyBtn');
  if (valBtn) valBtn.classList.toggle('active-top', !isQty);
  if (qtyBtn) qtyBtn.classList.toggle('active-top', isQty);

  const topBtn = document.getElementById('tabTop');
  const botBtn = document.getElementById('tabBot');
  if (topBtn) topBtn.classList.toggle('active-top', isTop);
  if (botBtn) botBtn.classList.toggle('active-bot', !isTop);
}

function renderGrowthChart(charts) {
  const canvas = document.getElementById('growthChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const grouping = liveDashboard.growthGrouping || 'churn';
  const isCustomerLevel = grouping === 'churn' || grouping === 'decline' || grouping === 'growth';

  if (liveDashboard.charts.growth) {
    liveDashboard.charts.growth.destroy();
  }

  if (isCustomerLevel) {
    // ── Customer-Level Churn & Growth Analysis ──
    const custData = charts.customerGrowth?.[grouping] || null;
    let items = [];

    if (custData && Array.isArray(custData.items) && custData.items.length) {
      items = custData.items;
    } else {
      // Fallback from raw customers or churn warnings if chart sub-object is absent
      const allWarnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || liveDashboard.data?.churn || [];
      const allCustomers = liveDashboard.data?.growthAnalysis?.customers || [];

      if (grouping === 'churn') {
        items = allWarnings.slice(0, 15);
      } else if (grouping === 'decline') {
        items = allCustomers
          .filter(c => (c.growthAmount < 0 || c.growthPercent < 0))
          .sort((a, b) => (b.lossAmount || (b.previousSales - b.currentSales)) - (a.lossAmount || (a.previousSales - a.currentSales)))
          .slice(0, 15);
      } else if (grouping === 'growth') {
        items = allCustomers
          .filter(c => c.growthAmount > 0)
          .sort((a, b) => b.growthAmount - a.growthAmount)
          .slice(0, 15);
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

    const labels = items.map(c => {
      const name = c.name || 'عميل';
      return name.length > 16 ? name.slice(0, 16) + '…' : name;
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
    const currColor = isGrowth ? '#00C853' : '#DC2626';
    const currLabel = isGrowth ? 'مبيعات الفترة الحالية (نمو)' : 'مبيعات الفترة الحالية (تراجع)';

    liveDashboard.charts.growth = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'مبيعات الفترة السابقة',
            data: prevData,
            backgroundColor: '#64748b',
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
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, padding: 8 }
          },
          tooltip: {
            callbacks: {
              title: (ctx) => items[ctx[0]?.dataIndex]?.name || '',
              afterTitle: (ctx) => {
                const item = items[ctx[0]?.dataIndex];
                if (!item) return '';
                return `📍 المحافظة: ${item.state || 'غير محدد'} | المندوب: ${item.rep || 'غير محدد'}`;
              },
              label: (ctx) => ` ${ctx.dataset.label}: ${formatMoney(ctx.raw)}`,
              afterBody: (ctx) => {
                const item = items[ctx[0]?.dataIndex];
                if (!item) return '';
                const diff = item.growthAmount;
                const pct = item.growthPercent;
                const changeLabel = diff < 0 ? `قيمة التراجع: -${formatMoney(Math.abs(diff))}` : `قيمة النمو: +${formatMoney(diff)}`;
                const riskLabel = item.risk ? ` | الخطر: ${item.risk}` : '';
                return `${changeLabel} (${pct}%)${riskLabel}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(51,65,85,0.3)' },
            ticks: {
              maxRotation: 35,
              minRotation: 20,
              font: { size: 10 }
            }
          },
          y: {
            grid: { color: 'rgba(51,65,85,0.3)' },
            ticks: {
              callback: (v) => formatNumber(v / 1000, 0) + 'ك'
            }
          }
        },
        onClick: (_event, elements) => {
          const idx = elements[0]?.index;
          if (idx === undefined || !items[idx]) return;
          const cust = items[idx];
          const detail = document.getElementById('churnDetail');
          if (detail) {
            detail.className = `churn-item ${cust.risk === 'مرتفع' ? 'high' : 'medium'}`;
            detail.textContent = `${cust.name} | ${cust.state || ''} | الحالية: ${formatMoney(cust.currentSales)} | السابقة: ${formatMoney(cust.previousSales)} | التغير: ${cust.growthPercent}%`;
          }
          const select = document.getElementById('churnCustomerFilter');
          if (select) {
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].text.includes(cust.name)) {
                select.selectedIndex = i;
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
        borderColor: '#E65100',
        backgroundColor: 'rgba(230,81,0,0.16)',
        fill: true,
        tension: 0.35
      }
    ];

    if (liveDashboard.filters.comparison !== 'none') {
      datasets.push({
        label: compLegend,
        data: comparisonData,
        borderColor: '#8B929E',
        borderDash: [5, 5],
        tension: 0.35,
        fill: false
      });
    }

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
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.label + ': ' + formatMoney(ctx.raw)
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
  const regional = (charts.regional || []).slice(0, 10);
  const labels = regional.map(r => r.name);
  const primaryData = isQty ? regional.map(r => r.grossQty || 0) : regional.map(r => r.sales);
  const secondaryData = isQty ? regional.map(r => r.netQty || 0) : regional.map(r => r.collected);

  window._lastGeoChartData = regional.map(r => ({
    'المحافظة / المنطقة': r.name,
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
        { label: isQty ? 'إجمالي الكمية المباعة' : 'المبيعات', data: primaryData, backgroundColor: '#8B929E' },
        { label: isQty ? 'صافي الكمية المباعة' : 'المحصل', data: secondaryData, backgroundColor: '#E65100' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.dataset.label + ': ' + (isQty ? (formatNumber(ctx.raw) + ' قطعة') : formatMoney(ctx.raw))
          }
        }
      }
    }
  });

  const miniGrid = document.getElementById('regionMiniGrid');
  if (miniGrid) {
    miniGrid.innerHTML = regional.slice(0, 6).map(r => `
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

  tbody.innerHTML = reps.map((rep, idx) => {
    const isExpanded = liveDashboard.expandedReps.has(rep.name);
    const cls = rep.percentage >= 100 ? 'over' : rep.percentage >= 80 ? 'ok' : 'low';
    const escapedName = rep.name.replace(/'/g, "\\'");
    return `
      <tr class="rep-main-row ${isExpanded ? 'is-expanded' : ''}" onclick="toggleRepRow('${escapedName}')">
        <td>
          <span class="rep-toggle">${isExpanded ? '▲' : '▼'}</span>
          <span class="rep-rank">#${idx + 1}</span>
          <span class="rep-name">${rep.name}</span>
        </td>
        <td>
          <span class="rep-bar-track">
            <span class="rep-bar-fill ${cls}" style="display:block;width:${Math.min(rep.percentage, 100)}%;"></span>
          </span>
          <span class="rep-pct ${cls}">${rep.percentage}٪</span>
        </td>
        <td class="rep-value">${formatMoney(rep.achieved)}</td>
        <td class="rep-explanation">${rep.kpi} (${formatCount(rep.count)} فاتورة)</td>
      </tr>
      <tr class="rep-detail-row ${isExpanded ? 'is-expanded' : ''}">
        <td colspan="4">
          <div class="rep-detail-panel">
            <div class="rep-detail-card kpi">
              <span class="rep-detail-label">مؤشر الأداء</span>
              <span class="rep-detail-value">${rep.kpi}</span>
            </div>
            <div class="rep-detail-card target">
              <span class="rep-detail-label">الهدف التقديري</span>
              <span class="rep-detail-value">${formatMoney(rep.target)}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">المبلغ الفعلي المنجز</span>
              <span class="rep-detail-value">${formatMoney(rep.achieved)}</span>
            </div>
            <div class="rep-detail-card kpi">
              <span class="rep-detail-label">المبلغ المحصل</span>
              <span class="rep-detail-value">${formatMoney(rep.collected)}</span>
            </div>
            <div class="rep-detail-card gap">
              <span class="rep-detail-label">المتبقي غير المحصل</span>
              <span class="rep-detail-value">${formatMoney(rep.remaining)}</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">النسبة الفعلية</span>
              <span class="rep-detail-value">${rep.percentage}٪</span>
            </div>
            <div class="rep-detail-card">
              <span class="rep-detail-label">النسبة النظرية</span>
              <span class="rep-detail-value">${rep.theoreticalPercentage}٪</span>
            </div>
            <div class="rep-detail-card gap">
              <span class="rep-detail-label">فجوة الأداء</span>
              <span class="rep-detail-value">${rep.actualGap >= 0 ? '+' : ''}${rep.actualGap}٪</span>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function toggleRegionDrill(regionName) {
  if (liveDashboard.expandedRegions.has(regionName)) {
    liveDashboard.expandedRegions.delete(regionName);
  } else {
    liveDashboard.expandedRegions.add(regionName);
  }
  renderDrilldownTable(liveDashboard.data?.drilldown);
}

function renderDrilldownTable(drilldown) {
  const tbody = document.getElementById('drillTableBody');
  if (!tbody || !drilldown) return;

  const rows = [];
  let totalInvoices = 0;
  let totalGrossQty = 0;
  let totalReturnedQty = 0;
  let totalNetQty = 0;
  let totalSales = 0;
  let totalCollected = 0;
  let totalOutstanding = 0;

  drilldown.forEach(reg => {
    const isExpanded = liveDashboard.expandedRegions.has(reg.name);
    const escapedReg = reg.name.replace(/'/g, "\\'");
    totalInvoices += (reg.invoices || 0);
    totalGrossQty += (reg.grossQty || 0);
    totalReturnedQty += (reg.returnedQty || 0);
    totalNetQty += (reg.netQty || 0);
    totalSales += (reg.sales || 0);
    totalCollected += (reg.collected || 0);
    totalOutstanding += (reg.outstanding || 0);

    rows.push(`
      <tr class="level-state" onclick="toggleRegionDrill('${escapedReg}')">
        <td>
          <div class="row-indent">
            <span class="row-expand expandable ${isExpanded ? 'expanded' : ''}">${isExpanded ? '▼' : '▶'}</span>
            <span class="row-icon">📍</span>
            <span class="row-name state">${reg.name}</span>
          </div>
        </td>
        <td class="center">${formatCount(reg.invoices)}</td>
        <td class="center val-normal">${formatNumber(reg.grossQty || 0)}</td>
        <td class="center val-red">${formatNumber(reg.returnedQty || 0)}</td>
        <td class="center val-blue">${formatNumber(reg.netQty || 0)}</td>
        <td class="left val-blue">${formatMoney(reg.sales)}</td>
        <td class="left val-red">${formatMoney(reg.returnedQty ? (reg.sales * (reg.returnedQty / (reg.grossQty || 1))) : 0)}</td>
        <td class="left val-blue">${formatMoney(reg.sales)}</td>
        <td class="left val-green">${formatMoney(reg.collected)}</td>
        <td class="left val-warn">${formatMoney(reg.outstanding)}</td>
        <td class="center">
          <div class="rate-wrap">
            <div class="rate-bar"><div class="rate-fill ${reg.rate >= 50 ? 'good' : 'bad'}" style="width:${Math.min(reg.rate, 100)}%;"></div></div>
            <span class="rate-pct ${reg.rate >= 50 ? 'good' : 'bad'}">${reg.rate}٪</span>
          </div>
        </td>
      </tr>
    `);

    if (isExpanded && reg.customers) {
      reg.customers.forEach(cust => {
        rows.push(`
          <tr class="level-cust">
            <td style="padding-right: 48px;">
              <div class="row-indent">
                <span class="row-expand leaf">•</span>
                <span class="row-icon">👤</span>
                <div>
                  <span class="row-name cust">${cust.name}</span>
                  <div class="row-subrep">المندوب: ${cust.rep} | المدينة: ${cust.city}</div>
                </div>
              </div>
            </td>
            <td class="center">${formatCount(cust.invoices)}</td>
            <td class="center val-normal">${formatNumber(cust.grossQty || 0)}</td>
            <td class="center val-red">${formatNumber(cust.returnedQty || 0)}</td>
            <td class="center val-blue">${formatNumber(cust.netQty || 0)}</td>
            <td class="left val-blue">${formatMoney(cust.sales)}</td>
            <td class="left val-red">0 ج.م</td>
            <td class="left val-blue">${formatMoney(cust.sales)}</td>
            <td class="left val-green">${formatMoney(cust.collected)}</td>
            <td class="left val-warn">${formatMoney(cust.outstanding)}</td>
            <td class="center">
              <span class="rate-pct ${cust.rate >= 50 ? 'good' : 'bad'}">${cust.rate}٪</span>
            </td>
          </tr>
        `);
      });
    }
  });

  tbody.innerHTML = rows.join('');

  // Update footer totals
  const tfoot = document.querySelector('.table-card table tfoot');
  if (tfoot) {
    const totalRate = totalSales ? Number((totalCollected / totalSales * 100).toFixed(1)) : 0;
    tfoot.innerHTML = `
      <tr>
        <td style="color:#e2e8f0;font-weight:700;">الإجمالي الكلي</td>
        <td class="center val-normal" style="font-weight:700;">${formatCount(totalInvoices)}</td>
        <td class="center val-normal" style="font-weight:700;">${formatNumber(totalGrossQty)}</td>
        <td class="center val-red" style="font-weight:700;">${formatNumber(totalReturnedQty)}</td>
        <td class="center val-blue" style="font-weight:700;">${formatNumber(totalNetQty)}</td>
        <td class="left val-blue" style="font-weight:700;">${formatMoney(totalSales)}</td>
        <td class="left val-red" style="font-weight:700;">${formatMoney(liveDashboard.data?.kpis?.returns || 0)}</td>
        <td class="left val-blue" style="font-weight:700;">${formatMoney(liveDashboard.data?.kpis?.net || totalSales)}</td>
        <td class="left val-green" style="font-weight:700;">${formatMoney(totalCollected)}</td>
        <td class="left val-warn" style="font-weight:700;">${formatMoney(totalOutstanding)}</td>
        <td class="center">
          <div class="rate-wrap">
            <div class="rate-bar"><div class="rate-fill ${totalRate >= 50 ? 'good' : 'bad'}" style="width:${Math.min(totalRate, 100)}%;"></div></div>
            <span class="rate-pct ${totalRate >= 50 ? 'good' : 'bad'}">${totalRate}٪</span>
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
    badgeTexts.forEach(n => { n.textContent = warnings.length + ' تحذيرات'; });
  }

  if (document.getElementById('churnModalOverlay')?.classList.contains('active')) {
    renderChurnModalContent();
  }

  if (!select || !detail) return;
  if (!warnings.length) {
    select.innerHTML = '<option value="">لا توجد تحذيرات حالياً</option>';
    detail.textContent = 'لا توجد تحذيرات تراجع تتجاوز العتبة المحددة';
    return;
  }

  select.innerHTML = warnings.map((warning, index) => `<option value="${index}">${warning.name} | ${warning.growthPercent}%</option>`).join('');
  const renderWarning = () => {
    const warning = warnings[Number(select.value) || 0];
    if (!warning) return;
    detail.className = `churn-item ${warning.risk === 'مرتفع' ? 'high' : 'medium'}`;
    detail.textContent = `${warning.name} | ${warning.state} | الحالية: ${formatMoney(warning.currentSales)} | السابقة: ${formatMoney(warning.previousSales)} | التراجع: ${warning.growthPercent}% | الخطورة: ${warning.risk}`;
  };
  select.onchange = renderWarning;
  renderWarning();
}

function renderComparisonMatrix(kpis, previous = null) {
  const tbody = document.querySelector('#comparisonMatrix tbody');
  if (!tbody || !kpis) return;
  window._lastComparisonData = { kpis, previous };

  const isNone = liveDashboard.filters.comparison === 'none' || !previous || (previous.gross === undefined && previous.invoicesCount === undefined);
  const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
  const compHeader = document.getElementById('comparisonMatrixHeader');
  if (compHeader) {
    compHeader.textContent = isNone ? 'بدون مقارنة' : (isLastYear ? 'نفس الفترة من العام الماضي' : 'الفترة السابقة');
  }

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

  const totalMovesCount = isSO ? kpis.invoicesCount : (kpis.totalPostedCount || (kpis.invoicesCount + kpis.returnsCount));
  const prevTotalMovesCount = isSO ? previous?.invoicesCount : (previous?.totalPostedCount || ((previous?.invoicesCount || 0) + (previous?.returnsCount || 0)));

  const rawRows = isQty ? [
    ['إجمالي الكميات المباعة', grossQty, previous?.grossQty, false, 'قطعة', false],
    ['إجمالي الكميات المرتجعة', returnsQty, previous?.returnsQty, false, 'قطعة', false],
    ['صافي الكميات المباعة', netQty, previous?.netQty, false, 'قطعة', false],
    [isSO ? 'عدد أوامر البيع' : 'عدد الحركات المعتمدة (Posted)', totalMovesCount, prevTotalMovesCount, false, isSO ? 'أمر' : 'حركة', true],
    [isSO ? 'متوسط كمية أمر البيع' : 'متوسط كمية الفاتورة', avgQty, null, false, 'قطعة', false],
    ['المبالغ المحصلة (ج.م)', kpis.collected, previous?.collected, true, '', false],
    [isSO ? 'المبيعات غير المحصلة (ج.م)' : 'المديونية القائمة (ج.م)', kpis.outstanding, previous?.outstanding, true, '', false],
    ['إجمالي المبيعات (ج.م)', kpis.gross, previous?.gross, true, '', false]
  ] : [
    ['إجمالي المبيعات', kpis.gross, previous?.gross, true, '', false],
    ['إجمالي المرتجعات', kpis.returns, previous?.returns, true, '', false],
    ['صافي المبيعات', kpis.net, previous?.net, true, '', false],
    ['المبالغ المحصلة', kpis.collected, previous?.collected, true, '', false],
    [isSO ? 'المبيعات غير المحصلة' : 'المديونية القائمة', kpis.outstanding, previous?.outstanding, true, '', false],
    [isSO ? 'عدد أوامر البيع' : 'عدد الحركات المعتمدة (Posted)', totalMovesCount, prevTotalMovesCount, false, isSO ? 'أمر' : 'حركة', true],
    [isSO ? 'متوسط أمر البيع' : 'متوسط قيمة الفاتورة', kpis.avgInvoice, previous?.avgInvoice, true, '', false]
  ];

  const rows = rawRows.map(([label, current, prior, money, unit, isCount]) => {
    const hasPrior = !isNone && prior !== undefined && prior !== null;
    const formatVal = (v) => isCount
      ? (formatCount(v) + (unit ? ' ' + unit : ''))
      : (money ? formatMoney(v) : (formatNumber(v) + (unit ? ' ' + unit : '')));
    const priorFormatted = hasPrior ? formatVal(prior) : '—';
    const delta = hasPrior ? change(current, prior) : '—';
    return [label, formatVal(current), priorFormatted, delta];
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r[0]}</td>
      <td><strong>${r[1]}</strong></td>
      <td>${r[2]}</td>
      <td class="${r[3].startsWith('+') ? 'val-green' : (r[3] === '—' ? '' : 'val-red')}">${r[3]}</td>
    </tr>
  `).join('');
}

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
  }
  if (compEl) {
    compEl.hidden = false;
    compEl.style.display = '';
  }
  markFiltersPending();
}

function applyLiveFilters() {
  clearFiltersPending();
  const getVal = (id) => document.getElementById(id)?.value || '';
  liveDashboard.filters.region = getVal('regionFilter');
  liveDashboard.filters.city = getVal('cityFilter');
  liveDashboard.filters.rep = getVal('repFilter');
  liveDashboard.filters.customer = getVal('customerFilter');
  liveDashboard.filters.category = getVal('catFilter');
  liveDashboard.filters.product = getVal('productFilter');
  liveDashboard.filters.query = (getVal('globalSearch') || '').trim();
  liveDashboard.filters.comparison = getVal('comparisonFilter') || 'previousPeriod';
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
  const titleEl = document.getElementById('prodChartTitle');
  if (titleEl) {
    titleEl.textContent = mode === 'top' ? 'أفضل المنتجات مبيعاً' : 'أقل المنتجات مبيعاً';
  }
  renderProductChart(liveDashboard.data?.charts);
}

function setProductMetric(metric, btn) {
  toggleView(metric);
}

function toggleView(forceMode = null) {
  if (forceMode === 'amount' || forceMode === 'quantity') {
    liveDashboard.metric = forceMode;
  } else {
    liveDashboard.metric = liveDashboard.metric === 'amount' ? 'quantity' : 'amount';
  }
  const isQty = liveDashboard.metric === 'quantity';

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
  renderKpis(liveDashboard.data?.kpis, liveDashboard.data?.comparison?.kpis);
  renderProductChart(liveDashboard.data?.charts);
  renderRegionalChart(liveDashboard.data?.charts);
  renderComparisonMatrix(liveDashboard.data?.kpis, liveDashboard.data?.comparison?.kpis);
  renderDrilldownTable(liveDashboard.data?.drilldown);
}

function expandAll() {
  (liveDashboard.data?.drilldown || []).forEach(r => liveDashboard.expandedRegions.add(r.name));
  renderDrilldownTable(liveDashboard.data?.drilldown);
}

function collapseAll() {
  liveDashboard.expandedRegions.clear();
  renderDrilldownTable(liveDashboard.data?.drilldown);
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
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || [];
  const totalCountEl = document.getElementById('churnModalTotalCount');
  const highCountEl = document.getElementById('churnModalHighCount');
  const medCountEl = document.getElementById('churnModalMedCount');
  const totalLossEl = document.getElementById('churnModalTotalLoss');

  const highCount = warnings.filter(w => w.risk === 'مرتفع').length;
  const medCount = warnings.filter(w => w.risk === 'متوسط').length;
  const totalLoss = warnings.reduce((acc, w) => acc + Math.max(0, (w.previousSales || 0) - (w.currentSales || 0)), 0);

  if (totalCountEl) totalCountEl.textContent = formatCount(warnings.length);
  if (highCountEl) highCountEl.textContent = formatCount(highCount);
  if (medCountEl) medCountEl.textContent = formatCount(medCount);
  if (totalLossEl) totalLossEl.textContent = formatMoney(totalLoss);

  filterChurnModalTable();
}

function filterChurnModalTable() {
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || [];
  const tbody = document.getElementById('churnModalTableBody');
  if (!tbody) return;

  const q = (document.getElementById('churnModalSearch')?.value || '').trim().toLowerCase();
  const riskFilter = document.getElementById('churnModalRiskFilter')?.value || 'all';

  const filtered = warnings.filter(w => {
    if (riskFilter !== 'all' && w.risk !== riskFilter) return false;
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
          ${warnings.length === 0 ? '✅ لا توجد تحذيرات تراجع للعملاء مطابقة للفلاتر المحددة حالياً.' : 'لا توجد نتائج مطابقة لبحثك في قائمة التحذيرات.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(w => {
    const loss = Math.max(0, (w.previousSales || 0) - (w.currentSales || 0));
    const isHigh = w.risk === 'مرتفع';
    const riskBadge = isHigh
      ? `<span class="churn-risk" style="border:1px solid var(--ks-warning);color:var(--ks-warning);background:rgba(239,68,68,0.15);padding:2px 8px;border-radius:4px;font-weight:700;">🔴 مرتفع (${w.growthPercent}%)</span>`
      : `<span class="churn-risk" style="border:1px solid var(--ks-kinpaku-rich);color:var(--ks-kinpaku-rich);background:rgba(245,158,11,0.15);padding:2px 8px;border-radius:4px;font-weight:700;">🟡 متوسط (${w.growthPercent}%)</span>`;

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
          <button class="tbl-export-btn" style="padding:3px 8px;font-size:11px;" onclick="filterDashboardByCustomer(${w.id}, '${escapedName}')" title="تصفية اللوحة بالكامل حسب هذا العميل">
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
  }
  applyLiveFilters();
}

function exportChurnWarningsToExcel() {
  const warnings = liveDashboard.churnWarnings || liveDashboard.data?.growthAnalysis?.churnWarnings || [];
  if (!warnings.length) return alert('لا توجد تحذيرات متابعة لتصديرها');
  const rows = warnings.map(w => ({
    'اسم العميل': w.name,
    'المحافظة / المنطقة': w.state || 'غير محدد',
    'المدينة': w.city || 'غير محدد',
    'المندوب': w.rep || 'غير محدد',
    'مبيعات الفترة السابقة (ج.م)': w.previousSales || 0,
    'مبيعات الفترة الحالية (ج.م)': w.currentSales || 0,
    'قيمة التراجع (ج.م)': Math.abs(w.growthAmount || (w.currentSales - w.previousSales)),
    'نسبة التراجع (%)': (w.growthPercent || 0) + '%',
    'مستوى الخطورة': w.risk || 'متوسط'
  }));
  const wb = createWorkbook({ 'تحذيرات تراجع العملاء': rows });
  xlsxDownload(wb, 'تقرير-تحذيرات-متابعة-العملاء-Churn.xlsx');
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

  if (titleEl) titleEl.textContent = `تفاصيل القيود والمستندات (Drill-down): ${kpiTitle}`;
  if (headerTitleEl) headerTitleEl.textContent = `مستندات مؤشر: ${kpiTitle}`;
  if (searchInput) searchInput.value = '';
  if (statusFilter) statusFilter.value = 'all';

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

  const start = liveDashboard.data?.filters?.start || liveDashboard.filters.startDate || '2024-01-01';
  const end = liveDashboard.data?.filters?.end || liveDashboard.filters.endDate || '2024-12-31';
  const sourceLabel = liveDashboard.filters.source === 'salesOrder' ? 'أوامر البيع (Sale Orders)' : 'فواتير المبيعات (Posted Invoices)';
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
  params.set('start', start);
  params.set('end', end);
  if (liveDashboard.filters.rep) params.set('rep', liveDashboard.filters.rep);
  if (liveDashboard.filters.customer) params.set('customer', liveDashboard.filters.customer);
  if (liveDashboard.filters.region) params.set('region', liveDashboard.filters.region);
  if (liveDashboard.filters.city) params.set('city', liveDashboard.filters.city);
  if (liveDashboard.filters.product) params.set('product', liveDashboard.filters.product);
  if (liveDashboard.filters.category) params.set('category', liveDashboard.filters.category);

  fetch(`/api/dashboard/kpi-drilldown?${params.toString()}`, { credentials: 'same-origin' })
    .then(res => {
      if (!res.ok) throw new Error('فشل جلب تفاصيل القيود من الخادم');
      return res.json();
    })
    .then(data => {
      liveDashboard.kpiDrilldownData = data;
      renderKpiDrilldownContent(data);
    })
    .catch(err => {
      console.error('kpi-drilldown error:', err);
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" style="text-align:center;padding:32px;color:var(--ks-warning);">
              <div style="font-size:22px;margin-bottom:6px;">⚠️</div>
              <div style="font-size:14px;font-weight:700;">حدث خطأ أثناء تحميل السجلات من Odoo:</div>
              <div style="font-size:12px;margin-top:4px;">${err.message}</div>
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

  if (countEl) countEl.textContent = formatCount(data.count || 0);
  if (amountEl) amountEl.textContent = formatMoney(data.totalAmount || 0);
  if (paidEl) paidEl.textContent = formatMoney(data.totalPaid || 0);
  if (residualEl) residualEl.textContent = formatMoney(data.totalResidual || 0);

  filterKpiDrilldownTable();
}

function filterKpiDrilldownTable() {
  const data = liveDashboard.kpiDrilldownData;
  const records = data?.records || [];
  const tbody = document.getElementById('kpiDrilldownTableBody');
  const footerSummary = document.getElementById('kpiDrilldownFooterSummary');
  if (!tbody) return;

  const q = (document.getElementById('kpiDrilldownSearch')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('kpiDrilldownStatusFilter')?.value || 'all';

  const filtered = records.filter(r => {
    if (statusFilter !== 'all') {
      if (statusFilter === 'refund') {
        if (!r.isRefund) return false;
      } else if (r.paymentStatusCode !== statusFilter) {
        return false;
      }
    }
    if (q) {
      const txt = `${r.name || ''} ${r.customer || ''} ${r.rep || ''} ${r.city || ''} ${r.region || ''} ${r.ref || ''}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  if (footerSummary) {
    footerSummary.textContent = `عرض ${formatCount(filtered.length)} من إجمالي ${formatCount(records.length)} سجل ومستند في Odoo.`;
  }

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align:center;padding:36px;color:var(--ks-text-muted);">
          ${records.length === 0 ? 'لا توجد قيود أو فواتير مسجلة مطابقة للفترة والمحددات المختارة.' : 'لا توجد نتائج مطابقة لبحثك في قائمة السجلات.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const isRefund = r.isRefund;
    const amountClass = isRefund ? 'color:var(--ks-warning);' : 'color:var(--ks-champagne);';
    const amountPrefix = isRefund ? '-' : '';

    let badgeClass = 'payment-badge ';
    if (r.paymentStatusCode === 'paid') badgeClass += 'paid';
    else if (r.paymentStatusCode === 'in_payment') badgeClass += 'in_payment';
    else if (r.paymentStatusCode === 'partial') badgeClass += 'partial';
    else if (r.paymentStatusCode === 'reversed') badgeClass += 'reversed';
    else badgeClass += 'not_paid';

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
        <td style="font-weight:700;${amountClass}">${amountPrefix}${formatMoney(r.amount)}</td>
        <td style="color:var(--ks-success);">${formatMoney(r.paid)}</td>
        <td style="${r.residual > 0 ? 'color:var(--ks-warning);font-weight:600;' : 'color:var(--ks-text-muted);'}">
          ${formatMoney(r.residual)}
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

  const q = (document.getElementById('kpiDrilldownSearch')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('kpiDrilldownStatusFilter')?.value || 'all';

  const rows = records.filter(r => {
    if (statusFilter !== 'all') {
      if (statusFilter === 'refund') {
        if (!r.isRefund) return false;
      } else if (r.paymentStatusCode !== statusFilter) {
        return false;
      }
    }
    if (q) {
      const txt = `${r.name || ''} ${r.customer || ''} ${r.rep || ''} ${r.city || ''} ${r.region || ''} ${r.ref || ''}`.toLowerCase();
      if (!txt.includes(q)) return false;
    }
    return true;
  });

  if (!rows.length) {
    alert('لا توجد سجلات مطابقة للفلتر للتصدير');
    return;
  }

  const excelRows = rows.map((r, idx) => ({
    'م': idx + 1,
    'رقم المستند / القيد': r.name || '',
    'النوع': r.typeLabel || '',
    'العميل': r.customer || '',
    'المندوب': r.rep || '',
    'المنطقة / المحافظة': r.region || '',
    'المدينة': r.city || '',
    'تاريخ المستند': r.date || '',
    'إجمالي القيمة (ج.م)': r.amount,
    'المسدد / المحصل (ج.م)': r.paid,
    'المتبقي / المديونية (ج.م)': r.residual,
    'حالة السداد': r.paymentState || '',
    'رابط المستند في أودو': r.odooLink || ''
  }));

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
    { المؤشر: 'المديونية', القيمة: kpis.outstanding },
    { المؤشر: 'عدد الفواتير', القيمة: kpis.invoicesCount }
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
  const wb = createWorkbook({ المندوبون: rows });
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
  const comparison = liveDashboard.data?.growthAnalysis || {};
  const wb = createWorkbook({ المناطق: comparison.regions || [], العملاء: comparison.customers || [], المؤشرات: [liveDashboard.data?.kpis || {}] });
  xlsxDownload(wb, 'تقرير-المقارنة.xlsx');
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
      'إجمالي المبيعات': reg.sales || 0,
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
        'إجمالي المبيعات': cust.sales || 0,
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

let _repSortDir = 'desc';
function toggleRepSort() {
  _repSortDir = _repSortDir === 'desc' ? 'asc' : 'desc';
  if (liveDashboard.data?.reps) {
    liveDashboard.data.reps.sort((a, b) => _repSortDir === 'desc' ? b.achieved - a.achieved : a.achieved - b.achieved);
    renderRepsTable(liveDashboard.data.reps);
  }
  if (liveDashboard.data?.drilldown) {
    liveDashboard.data.drilldown.forEach(reg => {
      if (reg.customers) {
        reg.customers.sort((a, b) => _repSortDir === 'desc' ? (b.rep || '').localeCompare(a.rep || '') : (a.rep || '').localeCompare(b.rep || ''));
      }
    });
    renderDrilldownTable(liveDashboard.data.drilldown);
  }
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

  const drilldown = liveDashboard.data?.drilldown;
  if (!drilldown) return;

  const getVal = (item) => {
    switch (field) {
      case 'invoices': return item.invoices || 0;
      case 'grossQty': return item.grossQty || 0;
      case 'returnedQty': return item.returnedQty || 0;
      case 'netQty': return item.netQty || 0;
      case 'gross': return item.sales || 0;
      case 'returns': return item.returnedSales || (item.returnedQty ? (item.sales * (item.returnedQty / (item.grossQty || 1))) : 0);
      case 'net': return item.sales || 0;
      case 'collected': return item.collected || 0;
      case 'outstanding': return item.outstanding || 0;
      case 'rate': return item.rate || 0;
      default: return item.sales || 0;
    }
  };

  drilldown.sort((a, b) => {
    const vA = getVal(a);
    const vB = getVal(b);
    return _drillSortAsc ? (vA > vB ? 1 : -1) : (vB > vA ? 1 : -1);
  });

  drilldown.forEach(reg => {
    if (reg.customers) {
      reg.customers.sort((a, b) => {
        const vA = getVal(a);
        const vB = getVal(b);
        return _drillSortAsc ? (vA > vB ? 1 : -1) : (vB > vA ? 1 : -1);
      });
    }
  });

  renderDrilldownTable(drilldown);
}

function updateChartColors() {
  if (typeof Chart === 'undefined') return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  Chart.defaults.color = isLight ? '#475569' : '#94a3b8';
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
    renderGrowthChart(liveDashboard.data?.charts);
  });
  document.getElementById('dataSourceFilter')?.addEventListener('change', onDataSourceChange);
  document.getElementById('salesOrderStatusFilter')?.addEventListener('change', markFiltersPending);
  document.getElementById('comparisonFilter')?.addEventListener('change', markFiltersPending);
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

  document.getElementById('globalSearch')?.addEventListener('input', () => {
    // Search term accumulates silently; click Apply Filters to reload.
    markFiltersPending();
  });

  const activeDateTab = document.querySelector('.date-tab.active');
  if (activeDateTab) {
    // Set the initial date tab state (updates filter state only, no reload)
    setDateTab(activeDateTab, 'شهري');
  }
  // Always load data on initial login — this is the ONLY automatic load
  loadLiveDashboard();
});
