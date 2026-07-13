'use strict';

// ------------------------------------------------------------------ //
// Sound                                                               //
// ------------------------------------------------------------------ //
let soundEnabled  = true;
let audioCtx     = null;
let masterGain   = null;
const ODOO_PING_URL = '/rms/kitchen/ping';

function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}
document.addEventListener('click', () => { try { getAudioCtx().resume(); } catch (_) {} });

function stopAlert() {
    clearTimeout(alertReschedule);
    alertReschedule = null;
    if (masterGain) {
        try { masterGain.gain.setValueAtTime(0, getAudioCtx().currentTime); masterGain.disconnect(); } catch (_) {}
        masterGain = null;
    }
}

function scheduleBeepChunk() {
    try {
        const ctx = getAudioCtx(), beepOn = 0.12, beepOff = 0.22, period = beepOn + beepOff, chunk = 30;
        for (let i = 0; i * period < chunk; i++) {
            const t = ctx.currentTime + i * period;
            const osc = ctx.createOscillator(), env = ctx.createGain();
            osc.connect(env); env.connect(masterGain);
            osc.type = 'sine'; osc.frequency.value = i % 2 === 0 ? 880 : 1046;
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(0.4, t + 0.01);
            env.gain.setValueAtTime(0.4, t + beepOn - 0.01);
            env.gain.linearRampToValueAtTime(0, t + beepOn);
            osc.start(t); osc.stop(t + beepOn + 0.01);
        }
        alertReschedule = setTimeout(scheduleBeepChunk, (chunk - 2) * 1000);
    } catch (_) {}
}
let alertReschedule = null;

function startAlert() {
    if (!soundEnabled) return;
    stopAlert();
    try {
        const ctx = getAudioCtx(); ctx.resume();
        masterGain = ctx.createGain(); masterGain.gain.value = 1;
        masterGain.connect(ctx.destination); scheduleBeepChunk();
    } catch (_) {}
}

// ------------------------------------------------------------------ //
// Clock — California time (America/Los_Angeles)                          //
// ------------------------------------------------------------------ //
function updateClock() {
    const el = document.getElementById('kds-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles'
    });
}
setInterval(updateClock, 1000);
updateClock();

// ------------------------------------------------------------------ //
// Receipt builder + print                                             //
// ------------------------------------------------------------------ //
function buildReceiptHtml(order) {
    const isDelivery = order.delivery_type === 'delivery';
    const typeLabel  = isDelivery ? '🛵 DELIVERY' : '🏃 PICKUP';
    const now = new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
    const itemsHtml = order.items.map(i =>
        `<tr>
            <td class="qty">${i.qty}×</td>
            <td class="name">${i.name}${i.note ? `<div class="note">${i.note}</div>` : ''}</td>
        </tr>`
    ).join('');

    const scheduledHtml = order.scheduled_time
        ? `<div class="scheduled">🕐 SCHEDULED: ${order.scheduled_time}</div>` : '';
    const cateringHtml = order.is_catering
        ? `<div class="catering-badge">🍽 CATERING ORDER</div>` : '';
    const specialRequestHtml = order.special_request
        ? `<div class="special-request">📝 SPECIAL REQUEST: ${order.special_request}</div>` : '';

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: 80mm auto; margin: 0; }
  @media print { html, body { width: 80mm; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Courier New', monospace;
    font-size: 13px;
    width: 80mm;
    padding: 6mm 4mm;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .restaurant { text-align: center; font-size: 15px; font-weight: bold; margin-bottom: 2mm; }
  .divider { border-top: 1px dashed #000; margin: 3mm 0; }
  .order-num { text-align: center; font-size: 22px; font-weight: 900; margin: 3mm 0; letter-spacing: 1px; }
  .type { text-align: center; font-size: 13px; font-weight: bold; margin-bottom: 2mm; }
  .scheduled { background: #eef; text-align: center; padding: 2mm; font-weight: bold; font-size: 12px; margin-bottom: 2mm; }
  .catering-badge { background: #fef3c7; text-align: center; padding: 2mm; font-weight: bold; font-size: 12px; margin-bottom: 2mm; border: 1px solid #000; }
  .special-request { background: #fee2e2; text-align: left; padding: 2mm; font-weight: bold; font-size: 12px; margin-bottom: 2mm; border: 1px solid #000; }
  .section-title { font-size: 10px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 1mm; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1.5mm 1mm; vertical-align: top; }
  td.qty { width: 10mm; font-weight: bold; font-size: 14px; }
  td.name { font-size: 13px; font-weight: 600; }
  .note { font-size: 11px; color: #333; font-style: italic; margin-top: 1mm; }
  .customer { font-size: 12px; }
  .customer td { padding: 1mm 0; }
  .customer td:first-child { color: #555; width: 18mm; }
  .customer td:last-child { font-weight: 600; }
  .footer { text-align: center; font-size: 10px; color: #666; margin-top: 3mm; }
  .timestamp { text-align: center; font-size: 10px; color: #666; margin-bottom: 2mm; }
</style>
</head>
<body>
  <div class="restaurant">🍽 Timur Restaurant</div>
  <div class="timestamp">${now}</div>
  <div class="divider"></div>
  <div class="order-num">${order.name}</div>
  <div class="type">${typeLabel}</div>
  ${cateringHtml}
  ${scheduledHtml}
  <div class="divider"></div>
  <div class="section-title">Order Items</div>
  <table>${itemsHtml}</table>
  ${specialRequestHtml}
  <div class="divider"></div>
  <div class="section-title">Customer</div>
  <table class="customer">
    <tr><td>Name</td><td>${order.customer_name || 'Guest'}</td></tr>
    ${order.customer_phone ? `<tr><td>Phone</td><td>${order.customer_phone}</td></tr>` : ''}
    ${order.customer_email ? `<tr><td>Email</td><td>${order.customer_email}</td></tr>` : ''}
    ${isDelivery && order.delivery_address ? `<tr><td>Address</td><td>${order.delivery_address}</td></tr>` : ''}
  </table>
  <div class="divider"></div>
  <div class="footer">Kitchen Copy — ${order.is_catering ? 'CATERING' : isDelivery ? 'DELIVERY' : 'PICKUP'}</div>
  <div style="margin-top:6mm;border-top:1px dashed #999;padding-top:2mm;text-align:center;font-size:9px;color:#999;">✂ cut</div>
  <div style="height:8mm;"></div>
</body>
</html>`;

    return html;
}

// Manual print — shows receipt preview modal, staff clicks Print to confirm
function previewTicket(order) {
    const html = buildReceiptHtml(order);
    // Build or reuse preview modal
    let modal = document.getElementById('kds-receipt-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'kds-receipt-modal';
        modal.innerHTML = `
            <div class="kds-receipt-backdrop">
                <div class="kds-receipt-box">
                    <div class="kds-receipt-header">
                        <span>🧾 Receipt Preview</span>
                        <button class="kds-receipt-close" id="kds-receipt-close">✕</button>
                    </div>
                    <div class="kds-receipt-preview" id="kds-receipt-preview"></div>
                    <div class="kds-receipt-footer">
                        <button class="kds-receipt-btn-cancel" id="kds-receipt-cancel">Cancel</button>
                        <button class="kds-receipt-btn-print" id="kds-receipt-print">Queue Print</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        document.getElementById('kds-receipt-close').addEventListener('click',  () => modal.style.display = 'none');
        document.getElementById('kds-receipt-cancel').addEventListener('click', () => modal.style.display = 'none');
        document.getElementById('kds-receipt-print').addEventListener('click', async event => {
            const button = event.currentTarget;
            const originalText = button.textContent;
            button.disabled = true;
            button.textContent = 'Queueing...';
            try {
                const job = await queueManualPrint(modal._currentOrder.id);
                button.textContent = `Queued · ${job.job_uuid.slice(0, 8)}`;
                setTimeout(() => { modal.style.display = 'none'; }, 700);
            } catch (error) {
                button.textContent = `Failed: ${error.message}`;
            } finally {
                setTimeout(() => {
                    button.disabled = false;
                    button.textContent = originalText;
                }, 1400);
            }
        });
        // Close on backdrop click
        modal.querySelector('.kds-receipt-backdrop').addEventListener('click', e => {
            if (e.target === e.currentTarget) modal.style.display = 'none';
        });
    }
    modal._currentHtml = html;
    modal._currentOrder = order;
    // Render receipt inside an iframe for accurate preview
    const preview = document.getElementById('kds-receipt-preview');
    preview.innerHTML = `<iframe style="width:100%;height:420px;border:none;" id="kds-receipt-iframe"></iframe>`;
    const previewIframe = document.getElementById('kds-receipt-iframe');
    // Set srcdoc once only — no onload needed, avoids blink/reload loop
    previewIframe.srcdoc = html;
    modal.style.display = 'flex';
}

// ------------------------------------------------------------------ //
// Sound toggle                                                        //
// ------------------------------------------------------------------ //
document.getElementById('kds-sound-toggle').addEventListener('click', function () {
    soundEnabled = !soundEnabled;
    this.classList.toggle('muted', !soundEnabled);
    if (!soundEnabled) stopAlert();
    else try { getAudioCtx().resume(); } catch (_) {}
});

// ------------------------------------------------------------------ //
// Odoo connection status                                             //
// ------------------------------------------------------------------ //
function setOdooStatus(kind, text) {
    const statusEl = document.getElementById('kds-odoo-status');
    const dotEl = document.getElementById('kds-odoo-status-dot');
    const textEl = document.getElementById('kds-odoo-status-text');
    if (!statusEl || !dotEl || !textEl) return;
    dotEl.className = `kds-connection-dot ${kind}`;
    textEl.textContent = text;
    statusEl.title = text;
}

async function fetchOdooStatus() {
    try {
        if (navigator.onLine === false) {
            setOdooStatus('bad', 'Odoo offline');
            return false;
        }
        const resp = await fetch(ODOO_PING_URL, { cache: 'no-store' });
        if (resp.status === 401) {
            setOdooStatus('bad', 'Session expired');
            return false;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        setOdooStatus('ok', 'Odoo connected');
        return true;
    } catch (_) {
        setOdooStatus('bad', 'Odoo unreachable');
        return false;
    }
}

// ------------------------------------------------------------------ //
// Helpers                                                             //
// ------------------------------------------------------------------ //
function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const NEXT_STATUS = { new: 'preparing', preparing: 'ready', ready: 'done' };
const NEXT_LABEL  = { new: 'Start Preparing', preparing: 'Mark Ready', ready: 'Mark Done' };
const NEXT_ICON   = { new: '🔥', preparing: '✅', ready: '🏁' };
const NEXT_CLASS  = { new: 'kds-btn-start', preparing: 'kds-btn-ready', ready: 'kds-btn-done' };

// ------------------------------------------------------------------ //
// Unified card builder — all tabs use this (catering-style layout)  //
// ns = 'live' | 'scheduled' | 'catering' — namespaces IDs          //
// ------------------------------------------------------------------ //
function buildCard(order, animate, ns) {
    ns = ns || 'live';
    const cardId     = `kds-order-${ns}-${order.id}`;
    const isDelivery = order.delivery_type === 'delivery';
    const typeClass  = isDelivery ? 'kds-type-delivery' : 'kds-type-pickup';
    const typeLabel  = isDelivery ? '🛵 Delivery' : '🏃 Pickup';

    const cateringBadge  = order.is_catering
        ? `<span class="kds-badge-catering">🍽 Catering</span>` : '';
    const scheduledBadge = order.scheduled_time
        ? `<div class="kds-scheduled-time">🕐 ${esc(order.scheduled_time)}</div>` : '';
    const specialRequestHtml = order.special_request
        ? `<div class="kds-special-request"><strong>📝 Special Request:</strong> ${esc(order.special_request)}</div>` : '';

    const STATUS_LABEL_MAP = { new: 'In Queue', preparing: 'Preparing', ready: 'Ready', done: 'Done' };
    const statusLabel = STATUS_LABEL_MAP[order.status] || order.status;
    const statusClass = `kds-catering-status-${order.status}`;

    const itemsHtml = order.items.map(i => `
        <div class="kds-item">
            <span class="kds-item-qty">${i.qty}×</span>
            <div class="kds-item-info">
                <div class="kds-item-name">${esc(i.name)}</div>
                ${i.note ? `<div class="kds-item-note">${esc(i.note)}</div>` : ''}
            </div>
        </div>`).join('');

    const nextStatus = NEXT_STATUS[order.status];
    const actionHtml = nextStatus
        ? `<button class="kds-action-btn ${NEXT_CLASS[order.status]}"
                   data-order-id="${order.id}" data-next="${nextStatus}" data-ns="${ns}">
               ${NEXT_ICON[order.status]} ${NEXT_LABEL[order.status]}
           </button>` : '';

    const wrap = document.createElement('div');
    wrap.innerHTML = `
        <div class="kds-catering-card${order.is_catering ? ' kds-card-catering' : ''}${animate ? ' kds-card-new' : ''}"
             id="${cardId}"
             data-order-id="${order.id}"
             data-status="${order.status}"
             data-ns="${ns}"
             data-special-request="${esc(order.special_request || '')}"
             data-scheduled-ts="${order.scheduled_ts || ''}">
            <div class="kds-catering-card-top">
                <div class="kds-catering-card-left">
                    <div class="kds-catering-order-num">${esc(order.name)}</div>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <span class="kds-card-type ${typeClass}">${typeLabel}</span>
                        ${cateringBadge}
                        <span class="kds-catering-status ${statusClass}">${statusLabel}</span>
                    </div>
                </div>
                <div class="kds-catering-card-right">
                    <div class="kds-catering-time-placed">Placed ${esc(order.date)} at ${esc(order.time)}</div>
                    ${scheduledBadge ? `<div class="kds-catering-sched">${scheduledBadge}</div>` : ''}
                </div>
            </div>
            <div class="kds-catering-body">
                <div class="kds-catering-info">
                    <div class="kds-catering-info-title">📋 Customer Info</div>
                    <div class="kds-catering-info-row"><span>Name</span><strong>${esc(order.customer_name || 'Guest')}</strong></div>
                    ${order.customer_phone ? `<div class="kds-catering-info-row"><span>Phone</span><strong>${esc(order.customer_phone)}</strong></div>` : ''}
                    ${order.customer_email ? `<div class="kds-catering-info-row"><span>Email</span><strong>${esc(order.customer_email)}</strong></div>` : ''}
                    ${isDelivery && order.delivery_address ? `<div class="kds-catering-info-row"><span>Address</span><strong>${esc(order.delivery_address)}</strong></div>` : ''}
                </div>
                <div class="kds-catering-items">
                    <div class="kds-catering-info-title">🍽 Order Items</div>
                    ${itemsHtml}
                </div>
            </div>
            ${specialRequestHtml}
            <div class="kds-card-actions">
                ${actionHtml}
                <button class="kds-print-btn" data-order-id="${order.id}" data-ns="${ns}" title="Print ticket">🖨️ Print</button>
            </div>
        </div>`;
    return wrap.firstElementChild;
}

// Alias so catering tab uses same builder
function buildCateringCard(order) { return buildCard(order, false, 'catering'); }

// Patch status badge + action button on existing card without full rebuild
function patchCardStatus(cardEl, order, ns) {
    cardEl.dataset.status = order.status;
    // Update status badge
    const statusEl = cardEl.querySelector('.kds-catering-status');
    if (statusEl) {
        statusEl.className = `kds-catering-status kds-catering-status-${order.status}`;
        const STATUS_LABEL_MAP = { new: 'In Queue', preparing: 'Preparing', ready: 'Ready', done: 'Done' };
        statusEl.textContent = STATUS_LABEL_MAP[order.status] || order.status;
    }
    // Update action button
    const actionsEl = cardEl.querySelector('.kds-card-actions');
    if (!actionsEl) return;
    const nextStatus = NEXT_STATUS[order.status];
    const existingBtn = actionsEl.querySelector('.kds-action-btn');
    if (nextStatus) {
        const btn = existingBtn || document.createElement('button');
        btn.className = `kds-action-btn ${NEXT_CLASS[order.status]}`;
        btn.dataset.orderId = order.id;
        btn.dataset.next    = nextStatus;
        btn.dataset.ns      = ns;
        btn.innerHTML = `${NEXT_ICON[order.status]} ${NEXT_LABEL[order.status]}`;
        btn.disabled = false; // re-enable: the click handler disables this same element while its request is in flight
        if (!existingBtn) actionsEl.insertBefore(btn, actionsEl.firstChild);
    } else if (existingBtn) {
        existingBtn.remove();
    }
}

// ------------------------------------------------------------------ //
// New-order modal                                                     //
// ------------------------------------------------------------------ //
const modalQueue   = [];
let   modalShowing = false;

function showModal(order) {
    modalShowing = true;
    startAlert();
    const overlay    = document.getElementById('kds-alert-overlay');
    const isDelivery = order.delivery_type === 'delivery';
    document.getElementById('kds-alert-num').textContent  = order.name;
    document.getElementById('kds-alert-type').textContent = isDelivery ? '🛵 Delivery' : '🏃 Pickup';
    const addrEl = document.getElementById('kds-alert-addr');
    if (isDelivery && order.delivery_address) {
        addrEl.textContent = '📍 ' + order.delivery_address;
        addrEl.style.display = '';
    } else { addrEl.style.display = 'none'; }
    document.getElementById('kds-alert-items').innerHTML = order.items.map(i =>
        `<div class="kds-alert-item">
            <span class="kds-alert-item-qty">${i.qty}×</span>
            <span class="kds-alert-item-name">${esc(i.name)}${i.note ? ` <em>(${esc(i.note)})</em>` : ''}</span>
        </div>`
    ).join('');
    overlay.style.display = 'flex';
}

async function dismissModal(accept) {
    stopAlert();
    document.getElementById('kds-alert-overlay').style.display = 'none';
    const order = modalQueue[0];
    modalQueue.shift();
    if (accept && order) {
        // Accept = acknowledge the order, keep it in Queue (new)
        // Staff manually moves it to Preparing when they start cooking
        try {
            const response = await fetch('/rms/kitchen/order/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_id: order.id }),
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
        } catch (error) {
            console.error('Could not save order acceptance:', error);
            setOdooStatus('bad', 'Could not save acceptance');
        }
        fetchOrders();
    }
    if (modalQueue.length) showModal(modalQueue[0]);
    else modalShowing = false;
}

document.getElementById('kds-alert-accept').addEventListener('click',  () => dismissModal(true));
document.getElementById('kds-alert-dismiss').addEventListener('click', () => dismissModal(false));

// ------------------------------------------------------------------ //
// Live board — 3 columns: Queue / Preparing / Ready                  //
// ------------------------------------------------------------------ //
const orderState = new Map();
let isFirstLoad  = true;

function getCol(status) {
    const colId = status === 'new'       ? 'kds-col-queue-cards'     :
                  status === 'preparing' ? 'kds-col-preparing-cards' : 'kds-col-ready-cards';
    return document.getElementById(colId);
}

function updateColCount(status) {
    const col    = getCol(status);
    if (!col) return;
    const count  = col.querySelectorAll('.kds-card').length;
    const headerId = status === 'new'       ? 'kds-count-queue'     :
                     status === 'preparing' ? 'kds-count-preparing' : 'kds-count-ready';
    const el = document.getElementById(headerId);
    if (el) el.textContent = count;
}

function updateBoard(orders) {
    const incomingIds = new Set(orders.map(o => o.id));
    let hasNewOrder = false;

    orders.forEach(order => {
        const prev = orderState.get(order.id);
        if (prev === undefined) {
            const col = getCol(order.status);
            if (!col) return;
            const card = buildCard(order, !isFirstLoad, 'live');
            col.appendChild(card);
            orderState.set(order.id, order.status);
            if (!isFirstLoad) {
                // Backend already excludes future scheduled orders from live feed.
                // Any new order appearing here is ready for the kitchen.
                hasNewOrder = true;
                modalQueue.push(order);
            }
        } else if (prev !== order.status) {
            const card   = document.getElementById(`kds-order-live-${order.id}`);
            const newCol = getCol(order.status);
            if (card && newCol) {
                patchCardStatus(card, order, 'live');
                // Move card to new column — appendChild removes from old column automatically
                newCol.appendChild(card);
                orderState.set(order.id, order.status);
                updateColCount(prev);
                updateColCount(order.status);
            }
        }
    });

    orderState.forEach((status, id) => {
        if (!incomingIds.has(id)) {
            document.getElementById(`kds-order-live-${id}`)?.remove();
            updateColCount(status);
            orderState.delete(id);
        }
    });

    if (hasNewOrder && !modalShowing) showModal(modalQueue[0]);
    ['new', 'preparing', 'ready'].forEach(updateColCount);

    const total = document.querySelectorAll('#kds-cols .kds-catering-card').length;
    const emptyCol = document.getElementById('kds-col-empty');
    if (emptyCol) emptyCol.style.display = total === 0 ? 'flex' : 'none';

    if (window._lastStats) {
        const s = window._lastStats;
        const el = id => document.getElementById(id);
        if (el('kds-stat-active')) el('kds-stat-active').textContent = s.active_count;
        if (el('kds-stat-today'))  el('kds-stat-today').textContent  = s.today_count;
        if (el('kds-stat-wait'))   el('kds-stat-wait').textContent   = s.avg_wait_minutes + 'm';
        if (el('kds-stat-ready'))  el('kds-stat-ready').textContent  = s.ready_count;
    }

    isFirstLoad = false;
}

// ------------------------------------------------------------------ //
// Scheduled board                                                     //
// ------------------------------------------------------------------ //
function renderScheduled(orders) {
    const grid  = document.getElementById('kds-scheduled-grid');
    const count = document.getElementById('kds-scheduled-count');
    if (!grid) return;
    count.textContent = orders.length;
    if (!orders.length) {
        grid.innerHTML = '<div class="kds-empty-inline">No upcoming scheduled orders.</div>';
        return;
    }
    grid.innerHTML = '';
    orders.forEach(order => grid.appendChild(buildCard(order, false, 'scheduled')));
}

// Auto-promote scheduled orders whose time has arrived
function promoteScheduledOrders() {
    const now = Date.now();
    document.querySelectorAll('#kds-scheduled-grid .kds-catering-card').forEach(card => {
        const ts = parseInt(card.dataset.scheduledTs || '0');
        if (ts && now >= ts) {
            const orderId = parseInt(card.dataset.orderId);
            fetch('/rms/kitchen/order/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order_id: orderId, status: 'new' }),
            }).then(async () => {
                await fetchOrders();
                await fetchScheduled();
                // fetchOrders() adds the promoted order to the live board and
                // triggers its alert. Its durable print job was already queued
                // by Odoo with available_at set to the scheduled time.
            });
        }
    });
}

// ------------------------------------------------------------------ //
// Catering board                                                      //
// ------------------------------------------------------------------ //
function renderCatering(orders) {
    const grid  = document.getElementById('kds-catering-grid');
    const count = document.getElementById('kds-catering-count');
    if (!grid) return;
    count.textContent = orders.length;
    if (!orders.length) {
        grid.innerHTML = '<div class="kds-empty-inline">No active catering orders.</div>';
        return;
    }
    grid.innerHTML = '';
    orders.forEach(order => grid.appendChild(buildCateringCard(order)));
}

// ------------------------------------------------------------------ //
// Reservations                                                       //
// ------------------------------------------------------------------ //
function reservationTimingLabel(timing) {
    if (timing === 'today') return 'Today';
    if (timing === 'past') return 'Recent';
    return 'Upcoming';
}

function renderReservations(reservations) {
    const grid  = document.getElementById('kds-reservations-grid');
    const count = document.getElementById('kds-reservations-count');
    if (!grid) return;
    const activeReservations = reservations.filter(r => r.timing !== 'past');
    if (count) count.textContent = activeReservations.length;
    if (!reservations.length) {
        grid.innerHTML = '<div class="kds-empty-inline">No reservation requests found.</div>';
        return;
    }
    grid.innerHTML = reservations.map(r => `
        <div class="kds-reservation-card kds-reservation-${esc(r.timing)}" data-reservation-id="${r.id}">
            <div class="kds-reservation-top">
                <div>
                    <div class="kds-reservation-title">${esc(r.occasion || 'Reservation')}</div>
                    <div class="kds-reservation-meta">
                        <span class="kds-reservation-badge">${esc(reservationTimingLabel(r.timing))}</span>
                        ${r.headcount ? `<span>${esc(r.headcount)} guests</span>` : ''}
                    </div>
                </div>
                <div class="kds-reservation-time">
                    <strong>${esc(r.date)}</strong>
                    <span>${esc(r.time)}${r.end_time ? ` - ${esc(r.end_time)}` : ''}</span>
                </div>
            </div>
            <div class="kds-reservation-body">
                <div class="kds-catering-info-row"><span>Name</span><strong>${esc(r.customer_name || 'Guest')}</strong></div>
                ${r.customer_phone ? `<div class="kds-catering-info-row"><span>Phone</span><strong>${esc(r.customer_phone)}</strong></div>` : ''}
                ${r.customer_email ? `<div class="kds-catering-info-row"><span>Email</span><strong>${esc(r.customer_email)}</strong></div>` : ''}
            </div>
            ${r.details ? `<div class="kds-reservation-details"><strong>Details</strong><span>${esc(r.details)}</span></div>` : ''}
        </div>
    `).join('');
}

// ------------------------------------------------------------------ //
// History                                                             //
// ------------------------------------------------------------------ //
const STATUS_LABEL = { new: 'New', preparing: 'Preparing', ready: 'Ready', done: 'Done' };
const STATUS_COLOR = { new: '#e53e3e', preparing: '#dd6b20', ready: '#38a169', done: '#666' };

function renderHistory(orders) {
    const list  = document.getElementById('kds-history-list');
    const count = document.getElementById('kds-history-count');
    count.textContent = orders.length;
    if (!orders.length) {
        list.innerHTML = '<div class="kds-history-empty">No orders in the last 7 days.</div>';
        return;
    }
    list.innerHTML = orders.map(o => {
        const isDelivery   = o.delivery_type === 'delivery';
        const typeClass    = isDelivery ? 'kds-type-delivery' : 'kds-type-pickup';
        const typeLabel    = isDelivery ? '🛵 Delivery' : '🏃 Pickup';
        const cateringBadge = o.is_catering
            ? `<span class="kds-badge-catering kds-badge-sm">🍽 Catering</span>` : '';
        const scheduledBadge = o.scheduled_time
            ? `<div class="kds-scheduled-time">🕐 ${esc(o.scheduled_time)}</div>` : '';
        const specialRequestHtml = o.special_request
            ? `<div class="kds-special-request"><strong>📝 Special Request:</strong> ${esc(o.special_request)}</div>` : '';
        const STATUS_LABEL_MAP = { new: 'In Queue', preparing: 'Preparing', ready: 'Ready', done: 'Done' };
        const statusClass = `kds-catering-status-${o.status}`;
        const itemsHtml = o.items.map(i => `
            <div class="kds-item">
                <span class="kds-item-qty">${i.qty}×</span>
                <div class="kds-item-info">
                    <div class="kds-item-name">${esc(i.name)}</div>
                    ${i.note ? `<div class="kds-item-note">${esc(i.note)}</div>` : ''}
                </div>
            </div>`).join('');

        return `
        <div class="kds-catering-card${o.is_catering ? ' kds-card-catering' : ' kds-hist-card'}"
             id="kds-order-history-${o.id}" data-order-id="${o.id}" data-ns="history"
             data-special-request="${esc(o.special_request || '')}">
            <div class="kds-catering-card-top">
                <div class="kds-catering-card-left">
                    <div class="kds-catering-order-num">${esc(o.name)}</div>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <span class="kds-card-type ${typeClass}">${typeLabel}</span>
                        ${cateringBadge}
                        <span class="kds-catering-status ${statusClass}">${STATUS_LABEL_MAP[o.status] || o.status}</span>
                    </div>
                </div>
                <div class="kds-catering-card-right">
                    <div class="kds-catering-time-placed">Placed ${esc(o.date)} at ${esc(o.time)}</div>
                    ${scheduledBadge ? `<div class="kds-catering-sched">${scheduledBadge}</div>` : ''}
                </div>
            </div>
            <div class="kds-catering-body">
                <div class="kds-catering-info">
                    <div class="kds-catering-info-title">📋 Customer Info</div>
                    <div class="kds-catering-info-row"><span>Name</span><strong>${esc(o.customer_name || 'Guest')}</strong></div>
                    ${o.customer_phone ? `<div class="kds-catering-info-row"><span>Phone</span><strong>${esc(o.customer_phone)}</strong></div>` : ''}
                    ${o.customer_email ? `<div class="kds-catering-info-row"><span>Email</span><strong>${esc(o.customer_email)}</strong></div>` : ''}
                    ${isDelivery && o.delivery_address ? `<div class="kds-catering-info-row"><span>Address</span><strong>${esc(o.delivery_address)}</strong></div>` : ''}
                </div>
                <div class="kds-catering-items">
                    <div class="kds-catering-info-title">🍽 Order Items</div>
                    ${itemsHtml}
                </div>
            </div>
            ${specialRequestHtml}
            <div class="kds-card-actions">
                <button class="kds-print-btn" data-order-id="${o.id}" data-ns="history" title="Print ticket">🖨️ Print</button>
            </div>
        </div>`;
    }).join('');
}

// ------------------------------------------------------------------ //
// Fetch                                                               //
// ------------------------------------------------------------------ //
let currentTab = 'live';

async function fetchOrders() {
    try {
        const resp = await fetch('/rms/kitchen/orders');
        if (resp.status === 401) { window.location.href = '/rms/kitchen'; return; }
        const data = await resp.json();
        if (data.stats) window._lastStats = data.stats;
        updateBoard(data.orders || []);
    } catch (_) {}
}

async function fetchScheduled() {
    try {
        const resp = await fetch('/rms/kitchen/orders/scheduled');
        if (resp.status === 401) { window.location.href = '/rms/kitchen'; return; }
        const data = await resp.json();
        renderScheduled(data.orders || []);
        // Keep tab badge in sync
        const badge = document.getElementById('kds-scheduled-count');
        if (badge) badge.textContent = (data.orders || []).length;
    } catch (_) {}
}

async function fetchCateringOrders() {
    try {
        const resp = await fetch('/rms/kitchen/orders/catering');
        if (resp.status === 401) { window.location.href = '/rms/kitchen'; return; }
        const data = await resp.json();
        renderCatering(data.orders || []);
    } catch (_) {}
}

async function fetchReservations() {
    try {
        const resp = await fetch('/rms/kitchen/reservations');
        if (resp.status === 401) { window.location.href = '/rms/kitchen'; return; }
        const data = await resp.json();
        renderReservations(data.reservations || []);
    } catch (_) {}
}

async function fetchHistory() {
    try {
        const resp = await fetch('/rms/kitchen/orders?history=1');
        if (resp.status === 401) { window.location.href = '/rms/kitchen'; return; }
        const data = await resp.json();
        renderHistory(data.orders || []);
    } catch (_) {}
}

function fetchCurrent() {
    if      (currentTab === 'live')      fetchOrders();
    else if (currentTab === 'scheduled') fetchScheduled();
    else if (currentTab === 'catering')  fetchCateringOrders();
    else if (currentTab === 'reservations') fetchReservations();
    else                                 fetchHistory();
    // Catering badge needs the real catering endpoint (fetchOrders excludes
    // future-scheduled orders), so keep it fresh every tick regardless of tab.
    if (currentTab !== 'catering') fetchCateringOrders();
    if (currentTab !== 'reservations') fetchReservations();
    fetchOdooStatus();
}

// ------------------------------------------------------------------ //
// Tabs                                                                //
// ------------------------------------------------------------------ //
document.querySelectorAll('.kds-tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
        currentTab = btn.dataset.tab;
        document.querySelectorAll('.kds-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('kds-live').style.display          = currentTab === 'live'      ? '' : 'none';
        document.getElementById('kds-scheduled').style.display     = currentTab === 'scheduled' ? '' : 'none';
        document.getElementById('kds-catering-panel').style.display= currentTab === 'catering'  ? '' : 'none';
        document.getElementById('kds-reservations-panel').style.display = currentTab === 'reservations' ? '' : 'none';
        document.getElementById('kds-history').style.display       = currentTab === 'history'   ? 'flex' : 'none';
        const emptyCol = document.getElementById('kds-col-empty');
        if (emptyCol) emptyCol.style.display = 'none';
        fetchCurrent();
    });
});

// ------------------------------------------------------------------ //
// Restaurant hours (administrators only)                             //
// ------------------------------------------------------------------ //
const hoursButton = document.getElementById('kds-hours-btn');
const hoursModal = document.getElementById('kds-hours-modal');

function closeHoursModal() {
    if (hoursModal) hoursModal.style.display = 'none';
}

function setHoursInputsEnabled(row) {
    const enabled = row.querySelector('.kds-hours-enabled').checked;
    row.classList.toggle('closed', !enabled);
    row.querySelectorAll('input[type="time"]').forEach(input => {
        input.disabled = !enabled;
    });
}

function renderHoursEditor(data) {
    const container = document.getElementById('kds-hours-days');
    const timezone = document.getElementById('kds-hours-timezone');
    timezone.textContent = `Timezone: ${data.timezone}`;
    container.innerHTML = data.days.map(day => `
        <div class="kds-hours-row" data-weekday="${day.weekday}">
            <label class="kds-hours-day">
                <input type="checkbox" class="kds-hours-enabled" ${day.enabled ? 'checked' : ''}/>
                <span>${day.label}</span>
            </label>
            <div class="kds-hours-range">
                <input type="time" class="kds-hours-open" value="${day.open}" step="900"/>
                <span>to</span>
                <input type="time" class="kds-hours-close-time" value="${day.close}" step="900"/>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('.kds-hours-row').forEach(row => {
        setHoursInputsEnabled(row);
        row.querySelector('.kds-hours-enabled').addEventListener('change', () => setHoursInputsEnabled(row));
    });
}

async function openHoursEditor() {
    const status = document.getElementById('kds-hours-status');
    status.textContent = '';
    hoursModal.style.display = 'flex';
    try {
        const response = await fetch('/rms/kitchen/hours', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        renderHoursEditor(data);
    } catch (error) {
        status.textContent = `Could not load hours: ${error.message}`;
        status.className = 'kds-hours-status error';
    }
}

async function saveHours() {
    const status = document.getElementById('kds-hours-status');
    const saveButton = document.getElementById('kds-hours-save');
    const days = [...document.querySelectorAll('.kds-hours-row')].map(row => ({
        weekday: Number(row.dataset.weekday),
        enabled: row.querySelector('.kds-hours-enabled').checked,
        open: row.querySelector('.kds-hours-open').value,
        close: row.querySelector('.kds-hours-close-time').value,
    }));

    status.textContent = 'Saving...';
    status.className = 'kds-hours-status';
    saveButton.disabled = true;
    try {
        const response = await fetch('/rms/kitchen/hours/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        renderHoursEditor(data);
        status.textContent = 'Hours saved. Ordering availability is updated.';
        status.className = 'kds-hours-status success';
    } catch (error) {
        status.textContent = `Could not save hours: ${error.message}`;
        status.className = 'kds-hours-status error';
    } finally {
        saveButton.disabled = false;
    }
}

if (hoursButton && hoursModal) {
    hoursButton.addEventListener('click', openHoursEditor);
    document.getElementById('kds-hours-close').addEventListener('click', closeHoursModal);
    document.getElementById('kds-hours-cancel').addEventListener('click', closeHoursModal);
    document.getElementById('kds-hours-save').addEventListener('click', saveHours);
    hoursModal.addEventListener('click', event => {
        if (event.target === hoursModal) closeHoursModal();
    });
}

// ------------------------------------------------------------------ //
// Durable print queue and relay pairing                              //
// ------------------------------------------------------------------ //
const printQueueButton = document.getElementById('kds-print-queue-btn');
const printQueueModal = document.getElementById('kds-print-queue-modal');
let printQueueRefreshTimer = null;

function formatQueueTime(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function renderPrintQueue(data) {
    const counts = data.counts || {};
    const countValues = [counts.pending, counts.claimed, counts.sent, counts.failed];
    document.querySelectorAll('#kds-print-counts strong').forEach((element, index) => {
        element.textContent = countValues[index] || 0;
    });

    const devices = document.getElementById('kds-print-devices');
    devices.innerHTML = data.devices.length ? data.devices.map(device => {
        const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
        const online = device.paired && Date.now() - lastSeen < 30000;
        const state = !device.paired ? 'Not paired' : online ? 'Online' : 'Offline';
        const revoke = data.can_manage_devices && device.active
            ? `<button class="kds-device-revoke" data-device-id="${device.id}">Revoke</button>`
            : '';
        return `<div class="kds-print-list-row">
            <div><strong>${esc(device.name)}</strong><span>${state} · Last seen ${esc(formatQueueTime(device.last_seen_at))}</span></div>
            <div class="kds-print-device-actions"><span class="kds-print-state ${online ? 'sent' : 'failed'}">${state}</span>${revoke}</div>
        </div>`;
    }).join('') : '<p>No print relays have been paired.</p>';

    const jobs = document.getElementById('kds-print-jobs');
    jobs.innerHTML = data.jobs.length ? data.jobs.map(job => `
        <div class="kds-print-list-row">
            <div>
                <strong>${esc(job.order_name)} · ${esc(job.source)}</strong>
                <span>${esc(job.uuid.slice(0, 8))} · attempt ${job.attempts}${job.last_error ? ` · ${esc(job.last_error)}` : ''}</span>
            </div>
            <span class="kds-print-state ${esc(job.state)}">${esc(job.state)}</span>
        </div>
    `).join('') : '<p>No print jobs yet.</p>';
}

async function refreshPrintQueue() {
    const status = document.getElementById('kds-print-queue-status');
    try {
        const response = await fetch('/rms/kitchen/print/jobs/status', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        renderPrintQueue(data);
        status.textContent = '';
    } catch (error) {
        status.textContent = `Could not load print queue: ${error.message}`;
        status.className = 'kds-hours-status error';
    }
}

function closePrintQueue() {
    if (printQueueModal) printQueueModal.style.display = 'none';
    if (printQueueRefreshTimer) clearInterval(printQueueRefreshTimer);
    printQueueRefreshTimer = null;
}

async function generatePairingCode() {
    const status = document.getElementById('kds-print-queue-status');
    const button = document.getElementById('kds-generate-pairing');
    const name = document.getElementById('kds-pairing-name').value.trim() || 'Kitchen Printer';
    button.disabled = true;
    try {
        const response = await fetch('/rms/kitchen/print-agent/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        document.getElementById('kds-pairing-code-value').textContent = data.pairing_code;
        document.getElementById('kds-pairing-code').style.display = 'flex';
        status.textContent = 'Pairing code created.';
        status.className = 'kds-hours-status success';
        refreshPrintQueue();
    } catch (error) {
        status.textContent = `Could not create pairing code: ${error.message}`;
        status.className = 'kds-hours-status error';
    } finally {
        button.disabled = false;
    }
}

async function revokePrintDevice(deviceId) {
    const status = document.getElementById('kds-print-queue-status');
    try {
        const response = await fetch(`/rms/kitchen/print-agent/${deviceId}/revoke`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        status.textContent = 'Relay access revoked.';
        status.className = 'kds-hours-status success';
        refreshPrintQueue();
    } catch (error) {
        status.textContent = `Could not revoke relay: ${error.message}`;
        status.className = 'kds-hours-status error';
    }
}

if (printQueueButton && printQueueModal) {
    printQueueButton.addEventListener('click', () => {
        printQueueModal.style.display = 'flex';
        refreshPrintQueue();
        if (printQueueRefreshTimer) clearInterval(printQueueRefreshTimer);
        printQueueRefreshTimer = setInterval(refreshPrintQueue, 5000);
    });
    document.getElementById('kds-print-queue-close').addEventListener('click', closePrintQueue);
    printQueueModal.addEventListener('click', event => {
        if (event.target === printQueueModal) closePrintQueue();
    });
    const pairingButton = document.getElementById('kds-generate-pairing');
    if (pairingButton) pairingButton.addEventListener('click', generatePairingCode);
    document.getElementById('kds-print-devices').addEventListener('click', event => {
        const button = event.target.closest('.kds-device-revoke');
        if (button) revokePrintDevice(Number(button.dataset.deviceId));
    });
}

// ------------------------------------------------------------------ //
// Customer details toggle (live + scheduled tabs)                    //
// Works via event delegation — IDs are namespaced so no conflicts    //
// ------------------------------------------------------------------ //
document.addEventListener('click', e => {
    const btn = e.target.closest('.kds-details-toggle');
    if (!btn) return;
    const panel = document.getElementById(btn.dataset.target);
    if (!panel) return;
    panel.classList.toggle('open');
    btn.classList.toggle('active', panel.classList.contains('open'));
});

// ------------------------------------------------------------------ //
// Manual print button                                                //
// ------------------------------------------------------------------ //
document.addEventListener('click', e => {
    const btn = e.target.closest('.kds-print-btn');
    if (!btn) return;
    const ns      = btn.dataset.ns || 'live';
    const orderId = parseInt(btn.dataset.orderId);
    const cardEl  = document.getElementById(`kds-order-${ns}-${orderId}`);
    if (!cardEl) return;
    // Reconstruct order data from the card DOM for printTicket
    const orderNum   = cardEl.querySelector('.kds-catering-order-num')?.textContent || '';
    const isDelivery = !!cardEl.querySelector('.kds-type-delivery');
    const isCatering = !!cardEl.querySelector('.kds-badge-catering');
    const schedEl    = cardEl.querySelector('.kds-scheduled-time');
    const items = [...cardEl.querySelectorAll('.kds-item')].map(el => ({
        qty:  el.querySelector('.kds-item-qty')?.textContent?.replace('×','').trim() || '1',
        name: el.querySelector('.kds-item-name')?.textContent || '',
        note: el.querySelector('.kds-item-note')?.textContent || '',
    }));
    const infoRows = cardEl.querySelectorAll('.kds-catering-info-row');
    const infoMap  = {};
    infoRows.forEach(r => {
        const label = r.querySelector('span')?.textContent?.toLowerCase() || '';
        const val   = r.querySelector('strong')?.textContent || '';
        infoMap[label] = val;
    });
    previewTicket({
        id:               orderId,
        name:             orderNum,
        delivery_type:    isDelivery ? 'delivery' : 'pickup',
        is_catering:      isCatering,
        scheduled_time:   schedEl ? schedEl.textContent.replace('🕐','').trim() : null,
        items,
        special_request:  cardEl.dataset.specialRequest || '',
        customer_name:    infoMap['name'] || '',
        customer_phone:   infoMap['phone'] || '',
        customer_email:   infoMap['email'] || '',
        delivery_address: infoMap['address'] || '',
        date: cardEl.querySelector('.kds-catering-time-placed')?.textContent || '',
        time: '',
    });
});

// ------------------------------------------------------------------ //
// Status update — works in all tabs                                  //
// ------------------------------------------------------------------ //
document.addEventListener('click', async e => {
    const btn = e.target.closest('.kds-action-btn');
    if (!btn) return;
    stopAlert();
    btn.disabled = true;
    try {
        await fetch('/rms/kitchen/order/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: parseInt(btn.dataset.orderId), status: btn.dataset.next }),
        });
        // Refresh whatever tabs are relevant
        fetchOrders();
        if (currentTab === 'scheduled') fetchScheduled();
        if (currentTab === 'catering')  fetchCateringOrders();
    } catch (_) {
        btn.disabled = false;
    }
});

// ------------------------------------------------------------------ //
// Boot + polling                                                      //
// ------------------------------------------------------------------ //
fetchOrders();
fetchScheduled();        // populate the Scheduled tab badge immediately on load, not just on tab click / first poll
fetchCateringOrders();   // populate the Catering tab badge from the real catering endpoint (fetchOrders' inferred
                          // count excludes future-scheduled orders, so it can undercount catering orders that are scheduled ahead)
fetchReservations();
fetchOdooStatus();
setInterval(fetchCurrent, 15000);
setInterval(promoteScheduledOrders, 30000);
setInterval(fetchOdooStatus, 10000);
