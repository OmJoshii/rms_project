// Kitchen printing is server-backed. Paid orders are queued by Odoo
// automatically; this helper creates explicit manual/reprint jobs.

async function queueManualPrint(orderId) {
    const response = await fetch('/rms/kitchen/print/jobs/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: Number(orderId) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || `Could not queue print job (HTTP ${response.status})`);
    }
    return data;
}

// Compatibility for older KDS call sites. New automatic jobs are created
// by Odoo and do not call this function.
async function epsonPrint(order) {
    if (!order || !order.id) throw new Error('Order ID is required');
    await queueManualPrint(order.id);
    return 'queued';
}
