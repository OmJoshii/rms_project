'use strict';

// Mirrors addons/rms_website_menu/controllers/menu.py :: _build_escpos_ticket
// Keep this in sync if the Odoo-side ticket layout changes.

const ESC = Buffer.from([0x1b]);
const GS = Buffer.from([0x1d]);

const INIT = Buffer.concat([ESC, Buffer.from('@')]);
const ALIGN_CENTER = Buffer.concat([ESC, Buffer.from('a'), Buffer.from([0x01])]);
const ALIGN_LEFT = Buffer.concat([ESC, Buffer.from('a'), Buffer.from([0x00])]);
const BOLD_ON = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([0x01])]);
const BOLD_OFF = Buffer.concat([ESC, Buffer.from('E'), Buffer.from([0x00])]);
const DOUBLE_ON = Buffer.concat([GS, Buffer.from('!'), Buffer.from([0x11])]);
const DOUBLE_OFF = Buffer.concat([GS, Buffer.from('!'), Buffer.from([0x00])]);
const FEED_3 = Buffer.from('\n\n\n');
const CUT = Buffer.concat([GS, Buffer.from('V'), Buffer.from([0x42]), Buffer.from([0x00])]);

function line(text = '') {
  return Buffer.from(text + '\n', 'utf8');
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : null;
}

function wrap(text, width) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const rows = [];
  for (const word of words) {
    if (!rows.length || `${rows[rows.length - 1]} ${word}`.length > width) rows.push(word);
    else rows[rows.length - 1] += ` ${word}`;
  }
  return rows.length ? rows : [''];
}

function formatDate(d) {
  // e.g. "Jul 01, 10:42 AM" — matches the Python strftime('%b %d, %I:%M %p') style
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = months[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${mon} ${day}, ${String(hours).padStart(2, '0')}:${mins} ${ampm}`;
}

/**
 * Build the raw ESC/POS byte sequence for an 80mm kitchen ticket.
 * @param {object} order - order dict as returned by /rms/kitchen/orders
 * @param {string} restaurantName
 */
function buildEscposTicket(order, restaurantName) {
  const chunks = [];
  const push = (buf) => chunks.push(buf);

  const pushRestaurantHeader = () => {
    push(ALIGN_CENTER);
    push(DOUBLE_ON);
    push(BOLD_ON);
    push(line('Timur Indian'));
    push(line('Cuisine'));
    push(line('1386 9th Ave SF'));
    push(DOUBLE_OFF);
    push(BOLD_OFF);
  };

  push(INIT);
  pushRestaurantHeader();

  push(line(formatDate(new Date())));
  push(line('-'.repeat(32)));

  push(DOUBLE_ON);
  push(BOLD_ON);
  push(line(order.name || ''));
  push(DOUBLE_OFF);
  push(BOLD_OFF);

  const isDelivery = order.delivery_type === 'delivery';
  push(BOLD_ON);
  push(line(isDelivery ? 'DELIVERY' : 'PICKUP'));
  push(BOLD_OFF);

  if (order.is_catering) {
    push(line('*** CATERING ORDER ***'));
  }
  if (order.scheduled_time) {
    push(line(`SCHEDULED: ${order.scheduled_time}`));
  }

  push(line('-'.repeat(32)));
  push(ALIGN_LEFT);
  push(BOLD_ON);
  push(line('ORDER ITEMS'));
  push(BOLD_OFF);

  for (const item of order.items || []) {
    const qty = String(item.qty != null ? item.qty : 1);
    const itemRows = wrap(`${qty}x ${item.name || ''}`, 16);
    push(DOUBLE_ON);
    push(BOLD_ON);
    itemRows.forEach((row) => push(line(row)));
    push(DOUBLE_OFF);
    push(BOLD_OFF);
    if (item.note) {
      push(BOLD_ON);
      wrap(`*** ${item.note}`, 32).forEach((row) => push(line(row)));
      push(BOLD_OFF);
    }
    push(line());
  }

  push(line('-'.repeat(32)));
  push(BOLD_ON);
  push(line('CUSTOMER'));
  push(BOLD_OFF);
  if (order.customer_name) push(line(`Name:  ${order.customer_name}`));
  if (order.customer_phone) push(line(`Phone: ${order.customer_phone}`));
  if (isDelivery && order.delivery_address) push(line(`Addr:  ${order.delivery_address}`));

  if (order.special_request) {
    push(line('-'.repeat(32)));
    push(BOLD_ON);
    push(line('SPECIAL REQUEST'));
    push(BOLD_OFF);
    push(line(order.special_request));
  }

  push(line('-'.repeat(32)));
  push(ALIGN_CENTER);
  push(BOLD_ON);
  push(line('KITCHEN COPY'));
  push(BOLD_OFF);
  push(line((isDelivery ? 'DELIVERY' : 'PICKUP') + ' | ' + (order.is_catering ? 'CATERING' : 'REGULAR')));
  push(FEED_3);
  push(CUT);

  // A separately cut counter copy keeps billing information out of the
  // kitchen's preparation ticket while giving front-counter staff a bill.
  push(INIT);
  pushRestaurantHeader();
  push(line('-'.repeat(32)));
  push(DOUBLE_ON);
  push(BOLD_ON);
  push(line('COUNTER'));
  push(line('COPY'));
  push(DOUBLE_OFF);
  push(BOLD_OFF);
  push(line(formatDate(new Date())));
  push(line('-'.repeat(32)));
  push(DOUBLE_ON);
  push(BOLD_ON);
  push(line(order.name || ''));
  push(DOUBLE_OFF);
  push(BOLD_OFF);
  push(line(isDelivery ? 'DELIVERY' : 'PICKUP'));
  push(line('-'.repeat(32)));
  push(ALIGN_LEFT);

  for (const item of order.items || []) {
    const qty = String(item.qty != null ? item.qty : 1);
    push(DOUBLE_ON);
    push(BOLD_ON);
    wrap(`${qty}x ${item.name || ''}`, 16).forEach((row) => push(line(row)));
    push(DOUBLE_OFF);
    push(BOLD_OFF);
    const itemTotal = money(item.subtotal);
    if (itemTotal) {
      const unitPrice = money(item.unit_price);
      const detail = Number(qty) > 1 && unitPrice ? `${qty} @ ${unitPrice}` : '';
      push(line(`${detail.padEnd(24)}${itemTotal.padStart(8)}`));
    }
    push(line());
  }

  const total = money(order.amount_total);
  if (total) {
    push(line('-'.repeat(32)));
    const subtotal = money(order.amount_untaxed);
    const tax = money(order.amount_tax);
    if (subtotal) push(line(`${'SUBTOTAL'.padEnd(24)}${subtotal.padStart(8)}`));
    if (tax) push(line(`${'TAX'.padEnd(24)}${tax.padStart(8)}`));
    push(DOUBLE_ON);
    push(BOLD_ON);
    push(line(`TOTAL ${total}`));
    push(DOUBLE_OFF);
    push(BOLD_OFF);
  } else {
    push(BOLD_ON);
    push(line('PRICE NOT AVAILABLE'));
    push(BOLD_OFF);
  }

  push(line('-'.repeat(32)));
  if (order.customer_name) push(line(`Name:  ${order.customer_name}`));
  if (order.customer_phone) push(line(`Phone: ${order.customer_phone}`));
  push(ALIGN_CENTER);
  push(BOLD_ON);
  push(line('COUNTER COPY'));
  push(BOLD_OFF);
  push(FEED_3);
  push(CUT);

  return Buffer.concat(chunks);
}

module.exports = { buildEscposTicket };
