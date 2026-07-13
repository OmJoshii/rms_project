'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEscposTicket } = require('../src/escpos');

test('ticket prints separate kitchen and counter copies', () => {
  const ticket = buildEscposTicket({
    name: 'S00208',
    delivery_type: 'pickup',
    items: [{
      qty: 2,
      name: 'Extra Long Chicken Tikka Masala Restaurant Special',
      unit_price: 16,
      subtotal: 32,
      note: 'Spice: Hot',
    }],
    amount_untaxed: 32,
    amount_tax: 2.64,
    amount_total: 34.64,
  }, 'Timur Restaurant').toString('utf8');

  assert.equal((ticket.match(/Timur Indian\nCuisine\n1386 9th Ave SF/g) || []).length, 2);
  assert.match(ticket, /2x Extra Long\nChicken Tikka\nMasala/);
  assert.match(ticket, /Restaurant\nSpecial/);
  assert.match(ticket, /2 @ \$16\.00\s+\$32\.00/);
  assert.match(ticket, /SUBTOTAL\s+\$32\.00/);
  assert.match(ticket, /TAX\s+\$2\.64/);
  assert.match(ticket, /TOTAL \$34\.64/);

  const counterStart = ticket.indexOf('COUNTER\nCOPY');
  assert.ok(counterStart > 0);
  const kitchen = ticket.slice(0, counterStart);
  const counter = ticket.slice(counterStart);
  assert.match(kitchen, /KITCHEN COPY/);
  assert.doesNotMatch(kitchen, /\$32\.00|TOTAL \$/);
  assert.match(counter, /2 @ \$16\.00\s+\$32\.00/);
  assert.match(counter, /TOTAL \$34\.64/);
  assert.match(kitchen, /Special\n[^\n]*\*\*\* Spice: Hot\n[^\n]*\n/);

  const cuts = Buffer.from(ticket, 'utf8').toString('binary').match(/\x1dV\x42\x00/g) || [];
  assert.equal(cuts.length, 2);
});

test('legacy jobs without pricing still render', () => {
  const ticket = buildEscposTicket({
    name: 'S00205',
    items: [{ qty: 1, name: 'Munchurian' }],
  }, 'Timur Restaurant').toString('utf8');

  assert.match(ticket, /1x Munchurian/);
  assert.doesNotMatch(ticket, /TOTAL \$/);
  assert.match(ticket, /PRICE NOT AVAILABLE/);
});
