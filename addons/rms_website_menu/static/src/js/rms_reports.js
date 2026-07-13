(function () {
    'use strict';

    const state = {
        report: null,
        orderPage: 1,
        orderPages: 1,
        loading: false,
    };

    const byId = (id) => document.getElementById(id);
    const startInput = byId('reports-start');
    const endInput = byId('reports-end');
    const rangeSelect = byId('reports-range');
    const loadStatus = byId('reports-load-status');
    const errorBox = byId('reports-error');

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
        })[character]);
    }

    function dateValue(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function setRange(value) {
        const today = new Date();
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        let start = new Date(end);
        if (value === 'yesterday') {
            start.setDate(start.getDate() - 1);
            end.setDate(end.getDate() - 1);
        } else if (value === '7' || value === '30') {
            start.setDate(start.getDate() - (Number(value) - 1));
        } else if (value === 'month') {
            start = new Date(end.getFullYear(), end.getMonth(), 1);
        } else if (value === 'last-month') {
            start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
            end.setDate(0);
        }
        if (value !== 'custom') {
            startInput.value = dateValue(start);
            endInput.value = dateValue(end);
        }
    }

    function currency(value) {
        const code = state.report && state.report.currency ? state.report.currency.code : 'USD';
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency', currency: code, maximumFractionDigits: 2,
            }).format(Number(value || 0));
        } catch (_) {
            return `$${Number(value || 0).toFixed(2)}`;
        }
    }

    function compactCurrency(value) {
        const amount = Number(value || 0);
        if (Math.abs(amount) < 1000) return currency(amount);
        const code = state.report && state.report.currency ? state.report.currency.code : 'USD';
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1,
            }).format(amount);
        } catch (_) {
            return currency(amount);
        }
    }

    function dateLabel(value, includeTime) {
        const dateOnly = /^\d{4}-\d{2}-\d{2}(T12:00:00)?$/.test(value || '');
        const date = new Date(dateOnly ? `${String(value).slice(0, 10)}T12:00:00Z` : value);
        if (Number.isNaN(date.getTime())) return value || '';
        const options = includeTime ? {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
        } : { month: 'short', day: 'numeric' };
        if (dateOnly) {
            options.timeZone = 'UTC';
        } else if (state.report && state.report.period && state.report.period.timezone) {
            options.timeZone = state.report.period.timezone;
        }
        return new Intl.DateTimeFormat(undefined, options).format(date);
    }

    function setError(message) {
        errorBox.textContent = message || '';
        errorBox.style.display = message ? 'block' : 'none';
    }

    async function fetchJson(url) {
        const response = await fetch(url, { credentials: 'same-origin' });
        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error(`Server returned HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);
        return data;
    }

    function reportQuery() {
        const params = new URLSearchParams({ start: startInput.value, end: endInput.value });
        return params.toString();
    }

    function renderChange(elementId, value) {
        const element = byId(elementId);
        if (value == null) {
            element.textContent = 'No previous-period baseline';
            element.className = '';
            return;
        }
        const direction = value >= 0 ? 'up' : 'down';
        element.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(1)}% vs previous period`;
        element.className = direction === 'up' ? 'positive' : 'negative';
    }

    function renderKpis(data) {
        const kpis = data.kpis;
        byId('kpi-gross').textContent = currency(kpis.gross_sales);
        byId('kpi-net').textContent = currency(kpis.net_sales);
        byId('kpi-orders').textContent = kpis.orders.toLocaleString();
        byId('kpi-aov').textContent = currency(kpis.average_order_value);
        byId('kpi-tax').textContent = currency(kpis.tax);
        byId('kpi-items').textContent = kpis.items_per_order.toFixed(1);
        byId('kpi-total-items').textContent = `${kpis.items.toLocaleString()} menu items sold`;
        renderChange('kpi-gross-change', kpis.comparison.gross_sales);
        renderChange('kpi-orders-change', kpis.comparison.orders);
        renderChange('kpi-aov-change', kpis.comparison.average_order_value);
    }

    function pointString(rows, key, max, width, height, padding) {
        if (!rows.length) return '';
        return rows.map((row, index) => {
            const x = rows.length === 1
                ? width / 2
                : padding + (index / (rows.length - 1)) * (width - padding * 2);
            const y = height - padding - ((Number(row[key]) || 0) / (max || 1)) * (height - padding * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    }

    function renderSalesChart(rows) {
        const target = byId('reports-sales-chart');
        if (!rows.length || !rows.some((row) => row.sales || row.orders)) {
            target.innerHTML = '<div class="reports-empty">No sales in this period.</div>';
            return;
        }
        const width = 900;
        const height = 250;
        const padding = 34;
        const maxSales = Math.max(...rows.map((row) => row.sales), 1);
        const maxOrders = Math.max(...rows.map((row) => row.orders), 1);
        const salesPoints = pointString(rows, 'sales', maxSales, width, height, padding);
        const orderPoints = pointString(rows, 'orders', maxOrders, width, height, padding);
        const labelStep = Math.max(1, Math.ceil(rows.length / 6));
        const grid = [0, .25, .5, .75, 1].map((ratio) => {
            const y = height - padding - ratio * (height - padding * 2);
            return `<line class="reports-chart-grid" x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}"/>` +
                `<text class="reports-chart-value" x="2" y="${y + 3}">${escapeHtml(compactCurrency(maxSales * ratio))}</text>`;
        }).join('');
        const labels = rows.map((row, index) => {
            if (index % labelStep !== 0 && index !== rows.length - 1) return '';
            const x = rows.length === 1
                ? width / 2
                : padding + (index / (rows.length - 1)) * (width - padding * 2);
            return `<text class="reports-chart-label" text-anchor="middle" x="${x}" y="244">${escapeHtml(dateLabel(`${row.date}T12:00:00`, false))}</text>`;
        }).join('');
        target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Sales and orders over time">` +
            `${grid}<polyline class="reports-chart-sales" points="${salesPoints}"/>` +
            `<polyline class="reports-chart-orders" points="${orderPoints}"/>${labels}</svg>`;
    }

    function hourLabel(hour) {
        const suffix = hour >= 12 ? 'PM' : 'AM';
        const display = hour % 12 || 12;
        return `${display} ${suffix}`;
    }

    function renderHourly(rows) {
        const max = Math.max(...rows.map((row) => row.sales), 1);
        byId('reports-hourly').innerHTML = rows.map((row) => {
            const heat = (.12 + (row.sales / max) * .88).toFixed(2);
            return `<div class="reports-hour-cell" style="--heat:${heat}">` +
                `<span>${hourLabel(row.hour)}</span><strong>${compactCurrency(row.sales)}</strong></div>`;
        }).join('');
    }

    function renderBars(elementId, rows, valueKey, colors) {
        const target = byId(elementId);
        if (!rows.length || !rows.some((row) => Number(row[valueKey]))) {
            target.innerHTML = '<div class="reports-empty">No data in this period.</div>';
            return;
        }
        const max = Math.max(...rows.map((row) => Number(row[valueKey]) || 0), 1);
        const palette = colors || ['#176b46', '#28679b', '#a35f08', '#9d2525'];
        target.innerHTML = rows.map((row, index) => {
            const value = Number(row[valueKey]) || 0;
            const width = Math.max(value ? 2 : 0, value / max * 100).toFixed(1);
            const displayValue = valueKey === 'revenue'
                ? currency(value)
                : `${value.toLocaleString()} orders`;
            return `<div class="reports-bar-row"><div class="reports-bar-meta">` +
                `<strong title="${escapeHtml(row.name || row.label)}">${escapeHtml(row.name || row.label)}</strong>` +
                `<span>${escapeHtml(displayValue)}</span></div>` +
                `<div class="reports-bar-track"><div class="reports-bar-fill" style="--bar-width:${width}%;--bar-color:${palette[index % palette.length]}"></div></div></div>`;
        }).join('');
    }

    function metric(label, value) {
        return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
    }

    function renderOperations(data) {
        const operations = data.operations;
        const status = operations.statuses;
        byId('reports-operations').innerHTML = [
            metric('Completed orders', status.done || 0),
            metric('Still active', (status.new || 0) + (status.preparing || 0) + (status.ready || 0)),
            metric('Scheduled orders', operations.scheduled_orders),
            metric('Cancelled orders', operations.cancelled_orders),
            metric('Average prep time', operations.average_prep_minutes == null ? 'Collecting data' : `${operations.average_prep_minutes} min`),
            metric('Average completion', operations.average_completion_minutes == null ? 'Collecting data' : `${operations.average_completion_minutes} min`),
            metric('Print jobs sent', `${operations.print_sent} / ${operations.print_jobs}`),
            metric('Print failures', operations.print_failed),
        ].join('');
    }

    function renderRanking(elementId, rows, customerMode) {
        const target = byId(elementId);
        if (!rows.length) {
            target.innerHTML = '<div class="reports-empty">No data in this period.</div>';
            return;
        }
        target.innerHTML = rows.map((row, index) => {
            const secondary = customerMode
                ? `${row.orders} order${row.orders === 1 ? '' : 's'}`
                : `${row.quantity.toLocaleString()} sold`;
            return `<div class="reports-rank-row"><span class="reports-rank-number">${index + 1}</span>` +
                `<span class="reports-rank-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>` +
                `<span class="reports-rank-value"><strong>${escapeHtml(currency(row.revenue))}</strong>` +
                `<span>${escapeHtml(secondary)}</span></span></div>`;
        }).join('');
    }

    function renderCustomers(customers) {
        byId('customer-unique').textContent = customers.unique.toLocaleString();
        byId('customer-new').textContent = customers.new.toLocaleString();
        byId('customer-repeat').textContent = customers.repeat.toLocaleString();
        byId('customer-repeat-rate').textContent = `${customers.repeat_rate.toFixed(1)}%`;
        renderRanking('reports-top-customers', customers.top, true);
    }

    function renderReport(data) {
        state.report = data;
        byId('reports-period-label').textContent = `${dateLabel(`${data.period.start}T12:00:00`)} – ${dateLabel(`${data.period.end}T12:00:00`)} · ${data.period.timezone}`;
        startInput.value = data.period.start;
        endInput.value = data.period.end;
        byId('reports-export').href = `/rms/admin/reports/export.csv?${reportQuery()}`;
        renderKpis(data);
        renderSalesChart(data.trend);
        renderHourly(data.hourly);
        renderBars('reports-fulfillment', data.fulfillment, 'orders');
        renderBars('reports-order-types', data.order_types, 'orders');
        renderOperations(data);
        renderRanking('reports-top-products', data.products.top, false);
        renderRanking('reports-low-products', data.products.lowest, false);
        renderBars('reports-categories', data.products.categories, 'revenue');
        renderCustomers(data.customers);
    }

    function orderFlags(order) {
        const flags = [];
        if (order.scheduled) flags.push('Scheduled');
        if (order.catering) flags.push('Catering');
        return flags.length ? `<span class="reports-order-flags">${flags.join(' · ')}</span>` : '';
    }

    async function loadOrders(page) {
        state.orderPage = page || 1;
        const params = new URLSearchParams({
            start: startInput.value,
            end: endInput.value,
            page: String(state.orderPage),
            search: byId('orders-search').value.trim(),
            fulfillment: byId('orders-fulfillment').value,
            kitchen_status: byId('orders-status').value,
        });
        const body = byId('reports-orders-body');
        body.innerHTML = '<tr><td colspan="7" class="reports-empty">Loading orders...</td></tr>';
        try {
            const data = await fetchJson(`/rms/admin/reports/orders?${params.toString()}`);
            state.orderPage = data.page;
            state.orderPages = data.pages;
            body.innerHTML = data.orders.length ? data.orders.map((order) => (
                `<tr><td><span class="reports-order-name">${escapeHtml(order.name)}</span>${orderFlags(order)}</td>` +
                `<td>${escapeHtml(dateLabel(order.date, true))}</td>` +
                `<td title="${escapeHtml(order.customer)}">${escapeHtml(order.customer)}</td>` +
                `<td>${escapeHtml(order.fulfillment.charAt(0).toUpperCase() + order.fulfillment.slice(1))}</td>` +
                `<td><span class="reports-badge ${escapeHtml(order.kitchen_status)}">${escapeHtml(order.kitchen_status)}</span></td>` +
                `<td class="numeric">${escapeHtml(order.items)}</td><td class="numeric">${escapeHtml(currency(order.total))}</td></tr>`
            )).join('') : '<tr><td colspan="7" class="reports-empty">No matching orders.</td></tr>';
            const first = data.total ? (data.page - 1) * data.page_size + 1 : 0;
            const last = Math.min(data.page * data.page_size, data.total);
            byId('orders-page-label').textContent = `${first}–${last} of ${data.total} orders`;
            byId('orders-prev').disabled = data.page <= 1;
            byId('orders-next').disabled = data.page >= data.pages;
        } catch (error) {
            body.innerHTML = `<tr><td colspan="7" class="reports-empty">${escapeHtml(error.message)}</td></tr>`;
        }
    }

    async function loadReport() {
        if (state.loading) return;
        state.loading = true;
        setError('');
        loadStatus.textContent = 'Loading report...';
        byId('reports-refresh').disabled = true;
        try {
            const data = await fetchJson(`/rms/admin/reports/data?${reportQuery()}`);
            renderReport(data);
            await loadOrders(1);
            loadStatus.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        } catch (error) {
            setError(error.message || 'Could not load reporting data.');
            loadStatus.textContent = 'Report unavailable';
        } finally {
            state.loading = false;
            byId('reports-refresh').disabled = false;
        }
    }

    function debounce(callback, delay) {
        let timer;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(callback, delay);
        };
    }

    rangeSelect.addEventListener('change', () => setRange(rangeSelect.value));
    byId('reports-refresh').addEventListener('click', loadReport);
    byId('orders-prev').addEventListener('click', () => loadOrders(state.orderPage - 1));
    byId('orders-next').addEventListener('click', () => loadOrders(state.orderPage + 1));
    byId('orders-search').addEventListener('input', debounce(() => loadOrders(1), 350));
    byId('orders-fulfillment').addEventListener('change', () => loadOrders(1));
    byId('orders-status').addEventListener('change', () => loadOrders(1));

    document.querySelectorAll('.reports-nav a[href^="#"]').forEach((link) => {
        link.addEventListener('click', () => {
            document.querySelectorAll('.reports-nav a').forEach((item) => item.classList.remove('active'));
            link.classList.add('active');
        });
    });

    setRange('30');
    loadReport();
})();
