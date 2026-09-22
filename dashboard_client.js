/* ═══════════════════════════════════════════════════════════════════
   LIVE ODOO DASHBOARD CONTROLLER — SHEIKH FOAM FACTORY
   ═══════════════════════════════════════════════════════════════════ */

const liveDashboard = {
  data: null,
  filters: {
    year: String(new Date().getFullYear()),
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
  growthGrouping: 'month',
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

const formatMoney = (val) => (Math.round(Number(val) || 0).toLocaleString('ar-EG')) + ' ج.م';
const formatNumber = (val) => Math.round(Number(val) || 0).toLocaleString('ar-EG');

async function loadLiveDashboard(forceRefresh = false) {
  const errorNode = document.getElementById('dashboardError');
  if (errorNode) errorNode.hidden = true;
  try {
    const params = new URLSearchParams();
    if (liveDashboard.filters.year) params.set('year', liveDashboard.filters.year);
    if (liveDashboard.filters.month) params.set('month', liveDashboard.filters.month);
    if (liveDashboard.filters.period) params.set('period', liveDashboard.filters.period);
    if (liveDashboard.filters.day) params.set('day', liveDashboard.filters.day);
    if (liveDashboard.filters.startDate) params.set('startDate', liveDashboard.filters.startDate);
    if (liveDashboard.filters.endDate) params.set('endDate', liveDashboard.filters.endDate);
    ['region', 'city', 'rep', 'customer', 'category', 'product', 'query', 'comparison', 'source', 'salesOrderStatus']
      .forEach((key) => {
        if (liveDashboard.filters[key]) params.set(key, liveDashboard.filters[key]);
      });
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
    summaryNode.textContent = (liveDashboard.filters.region || 'كل المناطق') + ' | ' + (liveDashboard.filters.rep || 'كل المندوبين') + ' | سنة ' + (liveDashboard.filters.year || '2026');
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

function renderFilterDropdowns(opts) {
  if (!opts) return;
  fillSelectOptions('regionFilter', opts.regions, 'جميع المناطق', liveDashboard.filters.region);
  fillSelectOptions('cityFilter', opts.cities, 'جميع المدن', liveDashboard.filters.city);
  fillSelectOptions('repFilter', opts.reps, 'جميع المندوبين', liveDashboard.filters.rep);
  fillSelectOptions('customerFilter', opts.customers, 'جميع العملاء', liveDashboard.filters.customer);
  fillSelectOptions('catFilter', opts.categories, 'جميع الفئات', liveDashboard.filters.category);
  fillSelectOptions('productFilter', opts.products, 'جميع المنتجات', liveDashboard.filters.product);
  fillSelectOptions('yearFilter', opts.years, 'كل السنوات', liveDashboard.filters.year);
  fillSelectOptions('monthFilter', opts.months, 'كل الأشهر', liveDashboard.filters.month);
  fillSelectOptions('periodFilter', opts.periods, 'كل الفترات', liveDashboard.filters.period);
  fillSelectOptions('dayFilter', opts.days, 'كل الأيام', liveDashboard.filters.day);
}

function renderDashboardDate(filters = {}, comparison = null) {
  const node = document.getElementById('dashboardDate');
  if (!node) return;
  const format = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ar-EG') : '';
  let text = filters.start && filters.end
    ? `${format(filters.start)} إلى ${format(filters.end)}`
    : 'الفترة الحالية';

  if (comparison && comparison.start && comparison.end) {
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

  const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
  const compLabel = isLastYear ? 'العام الماضي' : 'الفترة السابقة';

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

  const cards = [
    {
      title: 'إجمالي المبيعات',
      sub: 'الإيرادات المعتمدة',
      val: formatMoney(kpis.gross),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.gross)}` : '',
      icon: '💰',
      color: 'blue',
      extra: 'عدد الفواتير: ' + formatNumber(kpis.invoicesCount),
      trend: grossDelta ? `${grossDelta} vs ${compLabel}` : (kpis.collectionRate + '% تحصيل'),
      up: grossDelta ? grossDelta.startsWith('+') : true
    },
    {
      title: 'إجمالي المرتجعات',
      sub: 'إشعارات الخصم والدائن',
      val: formatMoney(kpis.returns),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.returns)}` : '',
      icon: '↩',
      color: 'red',
      extra: 'عدد المرتجعات: ' + formatNumber(kpis.returnsCount),
      trend: returnsDelta ? `${returnsDelta} vs ${compLabel}` : 'مرتجعات معتمدة',
      up: returnsDelta ? returnsDelta.startsWith('-') : false
    },
    {
      title: 'صافي المبيعات',
      sub: 'المبيعات بعد الخصم',
      val: formatMoney(kpis.net),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.net)}` : '',
      icon: '◈',
      color: 'blue',
      extra: 'الصافي الفعلي',
      trend: netDelta ? `${netDelta} vs ${compLabel}` : 'مبيعات حية',
      up: netDelta ? netDelta.startsWith('+') : true
    },
    {
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
      title: 'المديونية القائمة',
      sub: 'الرصيد المتبقي لدى العملاء',
      val: formatMoney(kpis.outstanding),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.outstanding)}` : '',
      icon: '⚠',
      color: 'red',
      extra: 'مستحق السداد',
      trend: outstandingDelta ? `${outstandingDelta} vs ${compLabel}` : 'أرصدة آجلة',
      up: outstandingDelta ? outstandingDelta.startsWith('-') : false
    },
    {
      title: 'عدد الفواتير المعتمدة',
      sub: 'فواتير Posted',
      val: formatNumber(kpis.invoicesCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatNumber(comparisonKpis.invoicesCount)} فاتورة` : '',
      icon: '▤',
      color: 'blue',
      extra: 'فاتورة رسمية',
      trend: invoicesDelta ? `${invoicesDelta} vs ${compLabel}` : 'مكتمل',
      up: invoicesDelta ? invoicesDelta.startsWith('+') : true
    },
    {
      title: 'عدد المرتجعات',
      sub: 'أوامر الإرجاع',
      val: formatNumber(kpis.returnsCount),
      priorText: comparisonKpis ? `${compLabel}: ${formatNumber(comparisonKpis.returnsCount)} إشعار` : '',
      icon: '↩',
      color: 'red',
      extra: 'إشعار دائن',
      trend: 'مرتجع',
      up: false
    },
    {
      title: 'متوسط قيمة الفاتورة',
      sub: 'متوسط المبيعات / فاتورة',
      val: formatMoney(kpis.avgInvoice),
      priorText: comparisonKpis ? `${compLabel}: ${formatMoney(comparisonKpis.avgInvoice)}` : '',
      icon: '📊',
      color: 'purple',
      extra: 'معدل الفاتورة',
      trend: avgInvoiceDelta ? `${avgInvoiceDelta} vs ${compLabel}` : 'نشط',
      up: avgInvoiceDelta ? avgInvoiceDelta.startsWith('+') : true
    }
  ];

  grid.innerHTML = cards.map(c => `
    <div class="kpi-card ${c.color}">
      <div class="kpi-top">
        <div>
          <div class="kpi-sub">${c.sub}</div>
          <div class="kpi-title">${c.title}</div>
        </div>
        <div class="kpi-icon">${c.icon}</div>
      </div>
      <div class="kpi-value">${c.val}</div>
      <div class="kpi-full">${c.priorText || c.val}</div>
      <div class="kpi-footer">
        <div class="kpi-trend ${c.up ? 'up' : 'down'}">${c.trend}</div>
        <div class="kpi-extra"><span>${c.extra}</span></div>
      </div>
    </div>
  `).join('');
}

function renderProductChart(charts) {
  const canvas = document.getElementById('productChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const isTop = liveDashboard.productMode === 'top';
  const products = isTop ? (charts.topProducts || []) : (charts.bottomProducts || []);
  const labels = products.map(p => p.name);
  const values = products.map(p => liveDashboard.metric === 'amount' ? p.amount : p.quantity);

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
        label: liveDashboard.metric === 'amount' ? 'المبيعات (ج.م)' : 'الكمية المباعة',
        data: values,
        backgroundColor: isTop ? '#d6aa5b' : '#b86b5c',
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
            label: (ctx) => liveDashboard.metric === 'amount' ? formatMoney(ctx.raw) : formatNumber(ctx.raw)
          }
        }
      },
      onClick: (_event, elements) => {
        const product = products[elements[0]?.index];
        const card = document.getElementById('productDetailCard');
        if (!product || !card) return;
        card.hidden = false;
        card.textContent = `${product.name} | الكمية: ${formatNumber(product.quantity)} | صافي القيمة: ${formatMoney(product.amount)}`;
      }
    }
  });
}

function renderGrowthChart(charts) {
  const canvas = document.getElementById('growthChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
  const compLegend = isLastYear ? 'مبيعات نفس الفترة من العام الماضي' : 'مبيعات الفترة السابقة';

  const monthLabels = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  const series = charts.growthTimeSeries?.[liveDashboard.growthGrouping] || [];
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

  window._lastGrowthChartData = labels.map((m, i) => ({
    'الشهر': m,
    'الفترة الحالية': netData[i] || 0,
    'فترة المقارنة': comparisonData[i] || 0,
    'نسبة التغير': rows[i]?.growthPercent ?? null
  }));

  if (liveDashboard.charts.growth) {
    liveDashboard.charts.growth.destroy();
  }

  liveDashboard.charts.growth = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'مبيعات الفترة الحالية',
          data: netData,
          borderColor: '#d6aa5b',
          backgroundColor: 'rgba(214,170,91,0.16)',
          fill: true,
          tension: 0.35
        },
        {
          label: compLegend,
          data: comparisonData,
          borderColor: '#70aaa2',
          borderDash: [5, 5],
          tension: 0.35,
          fill: false
        }
      ]
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
      },
      onClick: () => {}
    }
  });
}

function renderRegionalChart(charts) {
  const canvas = document.getElementById('regionalChart');
  if (!canvas || typeof Chart === 'undefined' || !charts) return;

  const regional = (charts.regional || []).slice(0, 10);
  const labels = regional.map(r => r.name);
  const sales = regional.map(r => r.sales);
  const collected = regional.map(r => r.collected);

  window._lastGeoChartData = regional.map(r => ({
    'المحافظة / المنطقة': r.name,
    'المبيعات': r.sales,
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
        { label: 'المبيعات', data: sales, backgroundColor: '#70aaa2' },
        { label: 'المحصل', data: collected, backgroundColor: '#d6aa5b' }
      ]
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

  const miniGrid = document.getElementById('regionMiniGrid');
  if (miniGrid) {
    miniGrid.innerHTML = regional.slice(0, 6).map(r => `
      <div class="region-mini">
        <div class="region-mini-name">${r.name}</div>
        <div class="region-mini-val">${formatMoney(r.sales)}</div>
        <div class="region-mini-rate ${r.rate >= 50 ? 'good' : 'bad'}">${r.rate}%</div>
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
        <td class="rep-explanation">${rep.kpi} (${formatNumber(rep.count)} فاتورة)</td>
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
        <td class="center">${formatNumber(reg.invoices)}</td>
        <td class="center val-normal">${formatNumber(reg.grossQty || 0)}</td>
        <td class="center val-red">${formatNumber(reg.returnedQty || 0)}</td>
        <td class="center val-blue">${formatNumber(reg.netQty || 0)}</td>
        <td class="left val-blue">${formatMoney(reg.sales)}</td>
        <td class="left val-red">${formatMoney(reg.returnedQty ? Math.round(reg.sales * (reg.returnedQty / (reg.grossQty || 1))) : 0)}</td>
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
            <td class="center">${formatNumber(cust.invoices)}</td>
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
        <td class="center val-normal" style="font-weight:700;">${formatNumber(totalInvoices)}</td>
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

  tbody.innerHTML = returns.map(r => `
    <tr>
      <td>${r.product}</td>
      <td>${r.category}</td>
      <td><span class="ret-badge ${r.returnOnSystem ? 'yes' : 'no'}">${r.returnOnSystem ? 'نعم' : 'لا'}</span></td>
      <td style="font-family:monospace;font-size:12px;">${r.creditNote}</td>
      <td>${r.rep}</td>
      <td>${r.region}</td>
      <td>${formatNumber(r.returnedQty)}</td>
      <td class="ret-amt">${formatMoney(r.returns)}</td>
    </tr>
  `).join('');
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

function renderComparisonMatrix(kpis, previous = {}) {
  const tbody = document.querySelector('#comparisonMatrix tbody');
  if (!tbody || !kpis) return;
  window._lastComparisonData = { kpis, previous };

  const isLastYear = liveDashboard.filters.comparison === 'samePeriodLastYear';
  const compHeader = document.getElementById('comparisonMatrixHeader');
  if (compHeader) {
    compHeader.textContent = isLastYear ? 'نفس الفترة من العام الماضي' : 'الفترة السابقة';
  }

  const change = (current, prior) => {
    if (prior === undefined || prior === null) return current ? '+100%' : '0.0%';
    if (prior === 0) return current > 0 ? '+100%' : '0.0%';
    const value = ((current - prior) / Math.abs(prior)) * 100;
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  };
  const rows = [
    ['إجمالي المبيعات', kpis.gross, previous.gross, true],
    ['إجمالي المرتجعات', kpis.returns, previous.returns, true],
    ['صافي المبيعات', kpis.net, previous.net, true],
    ['المبالغ المحصلة', kpis.collected, previous.collected, true],
    ['المديونية القائمة', kpis.outstanding, previous.outstanding, true],
    ['عدد الفواتير المعتمدة', kpis.invoicesCount, previous.invoicesCount, false],
    ['متوسط قيمة الفاتورة', kpis.avgInvoice, previous.avgInvoice, true]
  ].map(([label, current, prior, money]) => {
    const delta = change(current, prior);
    return [label, money ? formatMoney(current) : formatNumber(current), money ? formatMoney(prior) : formatNumber(prior), delta];
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r[0]}</td>
      <td><strong>${r[1]}</strong></td>
      <td>${r[2]}</td>
      <td class="${r[3].startsWith('+') ? 'val-green' : 'val-red'}">${r[3]}</td>
    </tr>
  `).join('');
}

function applyLiveFilters() {
  const getVal = (id) => document.getElementById(id)?.value || '';
  liveDashboard.filters.region = getVal('regionFilter');
  liveDashboard.filters.city = getVal('cityFilter');
  liveDashboard.filters.rep = getVal('repFilter');
  liveDashboard.filters.customer = getVal('customerFilter');
  liveDashboard.filters.category = getVal('catFilter');
  liveDashboard.filters.product = getVal('productFilter');
  liveDashboard.filters.year = getVal('yearFilter') || String(new Date().getFullYear());
  liveDashboard.filters.month = getVal('monthFilter');
  liveDashboard.filters.period = getVal('periodFilter');
  liveDashboard.filters.day = getVal('dayFilter');
  liveDashboard.filters.query = (getVal('globalSearch') || '').trim();
  liveDashboard.filters.startDate = getVal('dateFrom');
  liveDashboard.filters.endDate = getVal('dateTo');
  liveDashboard.filters.comparison = getVal('comparisonFilter') || 'previousPeriod';
  liveDashboard.filters.source = getVal('dataSourceFilter') || 'postedInvoice';
  liveDashboard.filters.salesOrderStatus = getVal('salesOrderStatusFilter') || 'all';

  const statusControl = document.getElementById('salesOrderStatusFilter');
  if (statusControl) statusControl.hidden = liveDashboard.filters.source !== 'salesOrder';

  loadLiveDashboard();
}

function setDateTab(btn, mode) {
  document.querySelectorAll('.date-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  liveDashboard.mode = mode;

  const customDate = document.getElementById('customDate');
  if (customDate) customDate.style.display = mode === 'مخصص' ? 'flex' : 'none';

  const today = new Date();
  const asDate = (date) => date.toISOString().slice(0, 10);
  liveDashboard.filters.startDate = '';
  liveDashboard.filters.endDate = '';
  if (mode === 'يومي') {
    liveDashboard.filters.month = String(today.getMonth() + 1);
    liveDashboard.filters.day = String(today.getDate());
    liveDashboard.filters.period = '';
  } else if (mode === 'أسبوعي') {
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    liveDashboard.filters.month = '';
    liveDashboard.filters.day = '';
    liveDashboard.filters.period = '';
    liveDashboard.filters.startDate = asDate(start);
    liveDashboard.filters.endDate = asDate(end);
  } else if (mode === 'شهري') {
    liveDashboard.filters.day = '';
    liveDashboard.filters.period = '';
    liveDashboard.filters.month = String(today.getMonth() + 1);
  } else if (mode === 'ربع سنوي') {
    liveDashboard.filters.day = '';
    liveDashboard.filters.month = '';
    liveDashboard.filters.period = `Q${Math.floor(today.getMonth() / 3) + 1}`;
  } else if (mode === 'سنوي') {
    liveDashboard.filters.day = '';
    liveDashboard.filters.month = '';
    liveDashboard.filters.period = '';
  }

  const sync = (id, value) => { const control = document.getElementById(id); if (control) control.value = value; };
  sync('yearFilter', liveDashboard.filters.year);
  sync('monthFilter', liveDashboard.filters.month);
  sync('dayFilter', liveDashboard.filters.day);
  sync('periodFilter', liveDashboard.filters.period);
  sync('dateFrom', liveDashboard.filters.startDate);
  sync('dateTo', liveDashboard.filters.endDate);

  loadLiveDashboard();
}

function switchProductChart(mode, btn) {
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active-top', 'active-bot'));
  btn.classList.add(mode === 'top' ? 'active-top' : 'active-bot');
  liveDashboard.productMode = mode;
  renderProductChart(liveDashboard.data?.charts);
}

function toggleView() {
  liveDashboard.metric = liveDashboard.metric === 'amount' ? 'quantity' : 'amount';
  const toggle = document.getElementById('viewToggle');
  if (toggle) toggle.classList.toggle('qty');
  toggle?.setAttribute('aria-pressed', String(liveDashboard.metric === 'quantity'));
  renderProductChart(liveDashboard.data?.charts);
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
  const warnings = liveDashboard.data?.churn || [];
  alert(warnings.length
    ? `يوجد ${warnings.length} تحذير متابعة مرتبط بالفلاتر الحالية.`
    : 'لا توجد تحذيرات متابعة للفلاتر الحالية.');
}

function xlsxDownload(wb, filename) {
  if (typeof XLSX !== 'undefined') {
    XLSX.writeFile(wb, filename);
  } else {
    alert('مكتبة SheetJS قيد التحميل، يرجى المحاولة مرة أخرى.');
  }
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
  const wb = createWorkbook({ المرتجعات: window._lastReturnsData || [] });
  xlsxDownload(wb, 'تقرير-المرتجعات.xlsx');
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
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) {
    console.error('Logout failed:', e);
  }
  window.location.assign('/login.html');
}

window.applyFilters = applyLiveFilters;
window.setDateTab = setDateTab;
window.switchProductChart = switchProductChart;
window.toggleView = toggleView;
window.toggleRepRow = toggleRepRow;
window.toggleRegionDrill = toggleRegionDrill;
window.expandAll = expandAll;
window.collapseAll = collapseAll;
window.toggleNotif = toggleNotif;
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

document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();
  document.getElementById('growthGroupingFilter')?.addEventListener('change', event => {
    liveDashboard.growthGrouping = event.target.value || 'month';
    renderGrowthChart(liveDashboard.data?.charts);
  });
  [
    'regionFilter', 'cityFilter', 'repFilter', 'customerFilter', 'catFilter', 'productFilter',
    'yearFilter', 'monthFilter', 'periodFilter', 'dayFilter', 'comparisonFilter',
    'dataSourceFilter', 'salesOrderStatusFilter', 'dateFrom', 'dateTo'
  ].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyLiveFilters);
  });

  document.getElementById('globalSearch')?.addEventListener('input', () => {
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(applyLiveFilters, 300);
  });

  const activeDateTab = document.querySelector('.date-tab.active');
  if (activeDateTab) setDateTab(activeDateTab, 'شهري');
  else loadLiveDashboard();
});
