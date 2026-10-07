-- ==============================================================================
-- 🚀 Odoo PostgreSQL Performance Indexes for El-Sheikh Foam Sales Dashboard
-- Ticket: TC-DASH-05: تحسين أداء وسرعة تحميل البيانات عند تطبيق الفلاتر
-- Target Models: account.move, account.move.line, sale.order, sale.order.line, res.partner
-- ==============================================================================
-- ملاحظة هامة:
-- يتم استخدام CONCURRENTLY لإنشاء الفهارس في الخلفية دون قفل الجداول (Zero Downtime)،
-- مما يضمن استمرار عمل نظام أودو والعمليات البيعية والمحاسبية دون أي توقف.
-- ==============================================================================

-- 1. الفهارس المركبة لجدول الفواتير والقيود المحاسبية (account_move)
-- يسرع استعلامات الفلترة حسب التاريخ وحالة الاعتماد ونوع المستند (فواتير/مرتجعات)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_move_dashboard_state_type_date 
    ON account_move (state, move_type, invoice_date) 
    WHERE state = 'posted';

-- تسريع الفلترة والتجميع حسب مندوب المبيعات (Sales Rep)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_move_dashboard_rep 
    ON account_move (invoice_user_id, state, move_type, invoice_date) 
    WHERE state = 'posted';

-- تسريع الفلترة حسب العميل (Customer / Partner)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_move_dashboard_partner 
    ON account_move (partner_id, state, move_type, invoice_date) 
    WHERE state = 'posted' AND partner_id IS NOT NULL;

-- تسريع حساب المديونية المتبقية والتحصيلات (Residual & Payment State)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_move_dashboard_residual 
    ON account_move (state, move_type, amount_residual) 
    WHERE state = 'posted' AND amount_residual > 0;


-- 2. الفهارس المركبة لجدول بنود الفواتير (account_move_line)
-- وهو الجدول الأكبر حجماً والأكثر تأثيراً على سرعة لوحة التحكم (الكميات، المبيعات حسب الصنف)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aml_dashboard_date_display_prod 
    ON account_move_line (date, display_type, product_id) 
    WHERE display_type = 'product';

-- تسريع ربط البنود بالفاتورة الأم مع نوع الصنف
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aml_dashboard_move_display_prod 
    ON account_move_line (move_id, display_type, product_id);

-- تسريع استعلامات تجميع كميات ومبيعات كل عميل (Partner Grouping)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aml_dashboard_partner_date 
    ON account_move_line (partner_id, display_type, date) 
    WHERE display_type = 'product';

-- تسريع استعلامات أفضل وأقل المنتجات مبيعاً (Top / Bottom Products)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_aml_dashboard_prod_subtotal 
    ON account_move_line (product_id, price_subtotal, quantity) 
    WHERE display_type = 'product';


-- 3. الفهارس المركبة لجدول أوامر البيع (sale_order)
-- تسريع التبديل إلى مصدر "أوامر البيع" وتطبيق فلاتر التاريخ والحالة
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_order_dashboard_date_state 
    ON sale_order (date_order, state);

-- تسريع فلترة أوامر البيع حسب مندوب المبيعات
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_order_dashboard_user_date 
    ON sale_order (user_id, date_order);

-- تسريع فلترة أوامر البيع حسب العميل
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_order_dashboard_partner_date 
    ON sale_order (partner_id, date_order);

-- فهارس التغطية الشاملة (Covering Composite Indexes) لتسريع الدمج الكلي All (Post and Draft)
-- وتفادي خطأ المهلة Odoo Connection / 504 Gateway Timeout عند تجميع مبيعات العملاء والمندوبين
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_order_dashboard_state_date_partner
    ON sale_order (state, date_order, partner_id, amount_total)
    WHERE state != 'cancel';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sale_order_dashboard_state_date_user
    ON sale_order (state, date_order, user_id, amount_total)
    WHERE state != 'cancel';


-- 4. الفهارس المركبة لجدول بنود أوامر البيع (sale_order_line)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sol_dashboard_order_disp_prod 
    ON sale_order_line (order_id, display_type, product_id);


-- 5. جدول العملاء وجهات الاتصال (res_partner)
-- تسريع بناء قائمة العملاء والمحافظات والمدن (Dropdowns & Geographic Distribution)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_res_partner_customer_rank_state_city 
    ON res_partner (customer_rank, state_id, city) 
    WHERE customer_rank > 0;

-- تسريع الربط الجغرافي الشامل لكافة فواتير المبيعات وتجميع المدن (بدون استثناء أي جهة اتصال)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_res_partner_id_city_state 
    ON res_partner (id, city, state_id);


-- 6. جدول المنتجات والتصنيفات (product_product & product_template)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_product_active_template 
    ON product_product (active, product_tmpl_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_template_categ_active 
    ON product_template (categ_id, active);


-- 7. جدول مدفوعات وسندات قبض العملاء وحركات الخزينة/البنوك (account_payment)
-- يسرع استعلام مؤشر إجمالي النقدية المحصلة وتفاصيل الـ Drill-down
-- يعتمد حصرياً على سندات قبض العملاء (Inbound) في حالتي (inprocess / in_process و paid) لضمان دقة الأرقام وعدم تضخمها
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_payment_dashboard_inbound 
    ON account_payment (payment_type, partner_type, state, date) 
    WHERE state IN ('in_process', 'inprocess', 'paid', 'posted');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_account_payment_dashboard_partner_date 
    ON account_payment (partner_id, state, date) 
    WHERE state IN ('in_process', 'inprocess', 'paid', 'posted') AND partner_id IS NOT NULL;


-- ==============================================================================
-- تحديث إحصائيات الجداول (ANALYZE) لتمكين PostgreSQL Query Planner من اختيار الفهارس فوراً
-- ==============================================================================
ANALYZE account_move;
ANALYZE account_move_line;
ANALYZE account_payment;
ANALYZE sale_order;
ANALYZE sale_order_line;
ANALYZE res_partner;
ANALYZE product_product;
ANALYZE product_template;

-- ==============================================================================
-- استعلام التحقق من نجاح إنشاء الفهارس وأحجامها
-- ==============================================================================
SELECT 
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid::regclass)) AS index_size
FROM pg_stat_user_indexes
WHERE indexname LIKE 'idx_%dashboard%' OR indexname LIKE 'idx_aml_%' OR indexname LIKE 'idx_sol_%'
ORDER BY tablename, indexname;

-- ==============================================================================
-- 📊 استعلام Odoo / PostgreSQL المعياري لتجميع المبيعات والتحصيلات جغرافياً حسب المدينة
-- يطابق تماماً تجميع Odoo (العنوان / المدينة) ولوحة التحكم (Dashboard) للفواتير المؤكدة
-- مع دعم commercial_partner_id في حال عدم وجود مدينة للفرع ومنع ظهور القيم السالبة أو غير المحددة
-- ==============================================================================
-- SELECT 
--     COALESCE(
--         NULLIF(TRIM(rp.city), ''),
--         NULLIF(TRIM(comm_p.city), ''),
--         rp_state.name,
--         'أخرى'
--     ) AS city_name,
--     COUNT(CASE WHEN am.move_type = 'out_invoice' THEN 1 END) AS invoices_count,
--     ROUND(SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END)::numeric, 2) AS gross_sales,
--     ROUND(SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)::numeric, 2) AS returns_amount,
--     ROUND(GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END))::numeric, 2) AS net_sales,
--     ROUND(LEAST(
--         GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)),
--         GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN (am.amount_total_signed - am.amount_residual_signed) ELSE 0 END))
--     )::numeric, 2) AS collected_amount,
--     ROUND(GREATEST(0, 
--         (GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END))) -
--         LEAST(
--             GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)),
--             GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN (am.amount_total_signed - am.amount_residual_signed) ELSE 0 END))
--         )
--     )::numeric, 2) AS residual_amount,
--     ROUND((CASE WHEN SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) > 0 
--         THEN (LEAST(
--             GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)),
--             GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN (am.amount_total_signed - am.amount_residual_signed) ELSE 0 END))
--         ) / NULLIF(GREATEST(0, SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) - SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)), 0) * 100) 
--         ELSE 0 END)::numeric, 1) AS collection_rate_pct
-- FROM account_move am
-- JOIN res_partner rp ON am.partner_id = rp.id
-- LEFT JOIN res_partner comm_p ON rp.commercial_partner_id = comm_p.id
-- LEFT JOIN res_country_state rp_state ON rp.state_id = rp_state.id
-- WHERE am.state = 'posted'
--   AND am.move_type IN ('out_invoice', 'out_refund')
--   AND am.invoice_date >= '2026-10-01' AND am.invoice_date <= '2026-10-31'
-- GROUP BY 1
-- HAVING COUNT(CASE WHEN am.move_type = 'out_invoice' THEN 1 END) > 0 OR SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END) > 0
-- ORDER BY net_sales DESC;

-- ==============================================================================
-- 📊 استعلام Odoo / PostgreSQL المعياري لتجميع مبيعات وأداء مناديب المبيعات (Sales Reps)
-- يعتمد كلياً وبشكل حصري على حقل مندوب المبيعات العادي المضاف في الفواتير والمرتجعات (am.invoice_user_id)
-- يطابق تماماً تجميع Odoo الافتراضي (Group By: مندوب المبيعات / Salesperson)
-- للفواتير المؤكدة (Posted Invoices & Credit Notes) دون قيود Target افتراضية أو أرقام وهمية
-- ==============================================================================
-- SELECT 
--     COALESCE(ru_partner.name, 'غير محدد') AS salesperson_name,
--     COUNT(am.id) AS documents_count,
--     COUNT(CASE WHEN am.move_type = 'out_invoice' THEN 1 END) AS invoices_count,
--     COUNT(CASE WHEN am.move_type = 'out_refund' THEN 1 END) AS refunds_count,
--     ROUND(SUM(CASE WHEN am.move_type = 'out_invoice' THEN am.amount_total_signed ELSE 0 END)::numeric, 2) AS gross_sales,
--     ROUND(SUM(CASE WHEN am.move_type = 'out_refund' THEN ABS(am.amount_total_signed) ELSE 0 END)::numeric, 2) AS returns_amount,
--     ROUND(SUM(am.amount_total_signed)::numeric, 2) AS net_sales,
--     ROUND(SUM(am.amount_total_signed - am.amount_residual_signed)::numeric, 2) AS collected_amount,
--     ROUND(SUM(am.amount_residual_signed)::numeric, 2) AS residual_amount,
--     ROUND((CASE WHEN SUM(am.amount_total_signed) > 0 
--         THEN (SUM(am.amount_total_signed - am.amount_residual_signed) / SUM(am.amount_total_signed) * 100) 
--         ELSE 0 END)::numeric, 1) AS collection_rate_pct,
--     ROUND((SUM(am.amount_total_signed) / NULLIF(SUM(SUM(am.amount_total_signed)) OVER (), 0) * 100)::numeric, 1) AS contribution_pct
-- FROM account_move am
-- LEFT JOIN res_users ru ON am.invoice_user_id = ru.id
-- LEFT JOIN res_partner ru_partner ON ru.partner_id = ru_partner.id
-- WHERE am.state = 'posted'
--   AND am.move_type IN ('out_invoice', 'out_refund')
--   AND am.invoice_date >= '2026-10-01' AND am.invoice_date <= '2026-10-31'
-- GROUP BY 1
-- ORDER BY net_sales DESC;

-- ==============================================================================
-- 📊 8. استعلامات Odoo / PostgreSQL المعمارية لأوامر البيع (Sales Order Domain Reverse Engineering)
-- تغطي الحالات الثلاث بدقة رياضية صارمة وتمنع الازدواجية (Double Counting) وانهيار الخادم:
-- الحالة 1: Post (Confirmed Sales Orders) -> state IN ('sale', 'done')
-- الحالة 2: Draft (Quotations)            -> state IN ('draft', 'sent')
-- الحالة 3: All (Post and Draft)          -> state IN ('draft', 'sent', 'sale', 'done') / state != 'cancel'
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- أ) استعلام المؤشرات الرئيسية للكاردات (KPIs Reconciliation Query):
-- ------------------------------------------------------------------------------
-- WITH filtered_orders AS (
--     SELECT 
--         id,
--         name,
--         partner_id,
--         user_id,
--         amount_total,
--         state,
--         date_order
--     FROM sale_order
--     WHERE date_order >= '2026-10-01 00:00:00' 
--       AND date_order <= '2026-10-31 23:59:59'
--       -- [اختيار الحالة ديناميكياً]:
--       -- للمعتمد فقط:       AND state IN ('sale', 'done')
--       -- للمسودات فقط:      AND state IN ('draft', 'sent')
--       -- لكافة الحالات All: AND state != 'cancel'
--       AND state != 'cancel'
-- ),
-- period_returns AS (
--     -- ملاحظة هامة: المرتجعات ترتبط حصرياً بالأوامر المعتمدة (لا توجد مرتجعات لمسودات أو عروض أسعار)
--     SELECT 
--         COALESCE(SUM(ABS(amount_total_signed)), 0) AS total_returns,
--         COUNT(id) AS returns_count
--     FROM account_move
--     WHERE state = 'posted'
--       AND move_type = 'out_refund'
--       AND invoice_date >= '2026-10-01' AND invoice_date <= '2026-10-31'
--       -- في حالة اختيار مسودة فقط (Draft): يتم إرجاع 0 فوراً
--       -- AND false
-- ),
-- period_collections AS (
--     -- ملاحظة هامة: التحصيلات تأتي حصرياً من جدول مدفوعات العملاء (account.payment)
--     -- مع تضمين الحالتين (inprocess / in_process و paid) معاً لضمان دقة الأرقام وعدم تضخمها
--     SELECT 
--         COALESCE(SUM(amount), 0) AS total_collected
--     FROM account_payment
--     WHERE payment_type = 'inbound'
--       AND partner_type = 'customer'
--       AND state IN ('in_process', 'inprocess', 'paid', 'posted')
--       AND date >= '2026-10-01' AND date <= '2026-10-31'
--       -- في حالة اختيار مسودة فقط (Draft): يتم إرجاع 0 فوراً
--       -- AND false
-- )
-- SELECT 
--     COUNT(fo.id) AS orders_count,
--     ROUND(COALESCE(SUM(fo.amount_total), 0)::numeric, 2) AS gross_sales,
--     ROUND(pr.total_returns::numeric, 2) AS returns_amount,
--     ROUND((COALESCE(SUM(fo.amount_total), 0) - pr.total_returns)::numeric, 2) AS net_sales,
--     ROUND(pc.total_collected::numeric, 2) AS collected_amount,
--     ROUND(GREATEST(0, (COALESCE(SUM(fo.amount_total), 0) - pr.total_returns) - pc.total_collected)::numeric, 2) AS uncollected_balance,
--     ROUND((pc.total_collected / NULLIF(COALESCE(SUM(fo.amount_total), 0) - pr.total_returns, 0) * 100)::numeric, 1) AS collection_rate_pct,
--     ROUND((COALESCE(SUM(fo.amount_total), 0) / NULLIF(COUNT(fo.id), 0))::numeric, 2) AS avg_order_value
-- FROM filtered_orders fo
-- CROSS JOIN period_returns pr
-- CROSS JOIN period_collections pc
-- GROUP BY pr.total_returns, pr.returns_count, pc.total_collected;


-- ------------------------------------------------------------------------------
-- ب) استعلام تجميع وتحليل العملاء وربطهم الجغرافي بدقة (Customer Analysis & Drilldown):
-- يمنع التكرار (Double Counting) تماماً عبر التجميع الفريد على مستوى (partner_id)
-- ------------------------------------------------------------------------------
-- SELECT 
--     rp.id AS customer_id,
--     rp.name AS customer_name,
--     COALESCE(NULLIF(TRIM(rp.city), ''), rp_state.name, 'غير محدد') AS city_name,
--     COALESCE(rp_state.name, 'غير محدد') AS state_name,
--     COALESCE(ru_partner.name, 'غير محدد') AS rep_name,
--     COUNT(so.id) AS orders_count,
--     ROUND(SUM(so.amount_total)::numeric, 2) AS customer_sales,
--     -- تجميع الكميات من بنود الأوامر
--     COALESCE(SUM(sol.product_uom_qty), 0) AS total_qty
-- FROM sale_order so
-- JOIN res_partner rp ON so.partner_id = rp.id
-- LEFT JOIN res_country_state rp_state ON rp.state_id = rp_state.id
-- LEFT JOIN res_users ru ON so.user_id = ru.id
-- LEFT JOIN res_partner ru_partner ON ru.partner_id = ru_partner.id
-- LEFT JOIN sale_order_line sol ON sol.order_id = so.id AND sol.display_type IS NULL
-- WHERE so.date_order >= '2026-10-01 00:00:00' 
--   AND so.date_order <= '2026-10-31 23:59:59'
--   -- حالة الفلتر المختارة (Post: state in ('sale','done') | Draft: state in ('draft','sent') | All: state != 'cancel')
--   AND so.state IN ('sale', 'done')
-- GROUP BY rp.id, rp.name, rp.city, rp_state.name, ru_partner.name
-- ORDER BY customer_sales DESC;


-- ------------------------------------------------------------------------------
-- ج) استعلام تحليل تراجع ونمو العملاء وتحذيرات الفقد (Customer Growth & Churn Analysis):
-- يقارن مبيعات الفترة الحالية بمبيعات الفترة السابقة لنفس حالة أمر البيع بدقة
-- ------------------------------------------------------------------------------
-- WITH current_period_sales AS (
--     SELECT 
--         partner_id,
--         SUM(amount_total) AS current_sales
--     FROM sale_order
--     WHERE date_order >= '2026-10-01 00:00:00' AND date_order <= '2026-10-31 23:59:59'
--       AND state IN ('sale', 'done') -- أو الفلتر المختار
--     GROUP BY partner_id
-- ),
-- previous_period_sales AS (
--     SELECT 
--         partner_id,
--         SUM(amount_total) AS previous_sales
--     FROM sale_order
--     WHERE date_order >= '2026-09-01 00:00:00' AND date_order <= '2026-09-30 23:59:59'
--       AND state IN ('sale', 'done') -- أو الفلتر المختار
--     GROUP BY partner_id
-- )
-- SELECT 
--     rp.id AS customer_id,
--     rp.name AS customer_name,
--     COALESCE(ru_partner.name, 'غير محدد') AS salesperson_name,
--     ROUND(COALESCE(cps.current_sales, 0)::numeric, 2) AS current_sales,
--     ROUND(COALESCE(pps.previous_sales, 0)::numeric, 2) AS previous_sales,
--     ROUND((COALESCE(cps.current_sales, 0) - COALESCE(pps.previous_sales, 0))::numeric, 2) AS growth_amount,
--     ROUND((CASE 
--         WHEN COALESCE(pps.previous_sales, 0) > 0 
--         THEN ((COALESCE(cps.current_sales, 0) - pps.previous_sales) / pps.previous_sales * 100)
--         ELSE 0 END)::numeric, 1) AS growth_percent,
--     -- تصنيف تحذيرات الفقد (Churn Warnings):
--     CASE 
--         WHEN COALESCE(cps.current_sales, 0) = 0 AND COALESCE(pps.previous_sales, 0) > 0 THEN 'مرتفع (فقد كلي)'
--         WHEN (COALESCE(cps.current_sales, 0) - pps.previous_sales) / pps.previous_sales <= -0.5 THEN 'مرتفع (تراجع > 50%)'
--         WHEN (COALESCE(cps.current_sales, 0) - pps.previous_sales) < 0 THEN 'متوسط'
--         ELSE 'لا يوجد'
--     END AS churn_risk
-- FROM res_partner rp
-- LEFT JOIN current_period_sales cps ON rp.id = cps.partner_id
-- LEFT JOIN previous_period_sales pps ON rp.id = pps.partner_id
-- LEFT JOIN res_users ru ON rp.user_id = ru.id
-- LEFT JOIN res_partner ru_partner ON ru.partner_id = ru_partner.id
-- WHERE (COALESCE(cps.current_sales, 0) > 0 OR COALESCE(pps.previous_sales, 0) > 0)
--   AND (COALESCE(pps.previous_sales, 0) > COALESCE(cps.current_sales, 0)) -- عملاء متراجعون/مفقودون
-- ORDER BY (COALESCE(pps.previous_sales, 0) - COALESCE(cps.current_sales, 0)) DESC;

