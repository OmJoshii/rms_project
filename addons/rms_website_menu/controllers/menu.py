import json
import html
import hashlib
import logging
import math
import re
import secrets
import socket
import urllib.parse
import urllib.request
import hmac
from decimal import Decimal, InvalidOperation
from datetime import datetime, timedelta

import pytz

from odoo import fields, http
from odoo.http import request
from odoo.addons.website_sale.controllers.main import WebsiteSale

_logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Business hours (America/Los_Angeles)                               #
# Defaults are used until an administrator saves hours from KDS.     #
# ------------------------------------------------------------------ #
RESTAURANT_TZ  = pytz.timezone('America/Los_Angeles')
BUSINESS_HOURS_PARAM = 'rms_website_menu.business_hours'
DEFAULT_BUSINESS_HOURS = {
    0: (11, 00, 22, 00),
    1: (11, 00, 22, 00),
    2: (11, 00, 22, 00),
    3: (11, 00, 22, 00),
    4: (11, 00, 22, 00),
    5: (11, 00, 22, 00),
    6: (11, 00, 22, 00),
}
BUSINESS_DAY_NAMES = (
    'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday', 'Sunday',
)

ORDER_TRACKING_SERVICE_WORKER = """'use strict';
const CACHE_NAME = 'rms-order-tracking-v1';
const STATIC_ASSETS = [
  '/rms_website_menu/static/src/css/rms_order_tracking.css',
  '/rms_website_menu/static/src/js/rms_order_tracking.js',
  '/rms_website_menu/static/src/img/order-tracking-192.png',
  '/rms_website_menu/static/src/img/order-tracking-512.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!STATIC_ASSETS.includes(url.pathname)) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || fetch(event.request))
  );
});
"""


def _parse_hhmm(value):
    hour, minute = str(value).split(':', 1)
    hour, minute = int(hour), int(minute)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError('Invalid time')
    return hour, minute


def _get_business_hours():
    """Return configured Mon-Sun hours as weekday -> (oh, om, ch, cm)."""
    try:
        raw = request.env['ir.config_parameter'].sudo().get_param(BUSINESS_HOURS_PARAM)
        if not raw:
            return dict(DEFAULT_BUSINESS_HOURS)
        saved = json.loads(raw)
        hours = {}
        for weekday in range(7):
            day = saved.get(str(weekday), {})
            if not day.get('enabled'):
                continue
            oh, om = _parse_hhmm(day.get('open'))
            ch, cm = _parse_hhmm(day.get('close'))
            if (ch, cm) <= (oh, om):
                raise ValueError('Closing time must be after opening time')
            hours[weekday] = (oh, om, ch, cm)
        return hours
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        _logger.warning('Invalid RMS business-hours configuration: %s', exc)
        return dict(DEFAULT_BUSINESS_HOURS)


def _business_hours_payload():
    hours = _get_business_hours()
    days = []
    for weekday, label in enumerate(BUSINESS_DAY_NAMES):
        value = hours.get(weekday)
        days.append({
            'weekday': weekday,
            'label': label,
            'enabled': value is not None,
            'open': f'{value[0]:02d}:{value[1]:02d}' if value else '11:00',
            'close': f'{value[2]:02d}:{value[3]:02d}' if value else '22:00',
        })
    return days


def _business_hours_json():
    return json.dumps({
        str(day['weekday']): [day['open'], day['close']]
        for day in _business_hours_payload() if day['enabled']
    })


def _format_local_time(hour, minute):
    marker = 'AM' if hour < 12 else 'PM'
    display_hour = hour % 12 or 12
    return f'{display_hour}:{minute:02d} {marker}'


def _next_opening(now, hours):
    for offset in range(8):
        day = now.date() + timedelta(days=offset)
        value = hours.get(day.weekday())
        if not value:
            continue
        opening = RESTAURANT_TZ.localize(
            datetime(day.year, day.month, day.day, value[0], value[1])
        )
        if opening > now:
            return opening
    return None


# ------------------------------------------------------------------ #
# Restaurant location (update if the restaurant moves)               #
# Used for delivery distance check (10-mile radius)                 #
# ------------------------------------------------------------------ #
RESTAURANT_LAT  = 37.762627630591126   # Restaurant correct location extracted from google maps
RESTAURANT_LNG  = -122.46596312886689 
DELIVERY_RADIUS_MILES = 10


def _haversine_miles(lat1, lng1, lat2, lng2):
    """Straight-line distance in miles between two lat/lng points."""
    R = 3958.8  # Earth radius in miles
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lng / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def _geocode_address(address):
    """
    Geocode a free-text address using OpenStreetMap Nominatim (no API key needed).
    Returns (lat, lng) floats or (None, None) if geocoding fails.
    """
    try:
        params = urllib.parse.urlencode({
            'q':              address,
            'format':         'json',
            'limit':          1,
            'addressdetails': 0,
        })
        url = f"https://nominatim.openstreetmap.org/search?{params}"
        req = urllib.request.Request(url, headers={'User-Agent': 'TimurRMS/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        if data:
            return float(data[0]['lat']), float(data[0]['lon'])
    except Exception as e:
        _logger.warning("RMS geocode failed for %r: %s", address, e)
    return None, None


def _is_open_now():
    now = datetime.now(tz=RESTAURANT_TZ)
    business_hours = _get_business_hours()
    hours = business_hours.get(now.weekday())
    if hours is None:
        reopening = _next_opening(now, business_hours)
        if reopening:
            return False, (
                f"We're closed today. We reopen {reopening.strftime('%A')} at "
                f"{_format_local_time(reopening.hour, reopening.minute)}."
            )
        return False, "We're currently closed."
    oh, om, ch, cm = hours
    open_t  = now.replace(hour=oh, minute=om,  second=0, microsecond=0)
    close_t = now.replace(hour=ch, minute=cm, second=0, microsecond=0)
    if now < open_t:
        return False, f"We're not open yet — kitchen opens at {_format_local_time(oh, om)} today."
    if now >= close_t:
        reopening = _next_opening(now, business_hours)
        reopen_msg = ''
        if reopening:
            reopen_msg = (
                f" We reopen {reopening.strftime('%A')} at "
                f"{_format_local_time(reopening.hour, reopening.minute)}."
            )
        return False, f"We've closed for the night (kitchen closes at {_format_local_time(ch, cm)}).{reopen_msg}"
    return True, ""


def _generate_schedule_slots():
    """
    Returns schedule data grouped by date for two-step UI (pick date, then time):
        [
          {
            'date_value': '2026-06-12',
            'date_label': 'Thursday, Jun 12',
            'times': [
              {'value': '11:00', 'label': '11:00 AM'},
              {'value': '11:30', 'label': '11:30 AM'},
              ...
            ]
          },
          ...
        ]

    Rules:
    - Covers today through today+7 (8 days total)
    - Only slots within the configured business hours
    - For today, skip any slot that is <= 30 minutes from now
    - 30-minute intervals, restaurant local timezone (America/Los_Angeles)
    """
    days = []
    now_local = datetime.now(tz=RESTAURANT_TZ)
    cutoff = now_local + timedelta(minutes=30)
    business_hours = _get_business_hours()

    for day_offset in range(8):
        day = now_local.date() + timedelta(days=day_offset)
        hours = business_hours.get(day.weekday())
        if hours is None:
            continue
        open_h, open_m, close_h, close_m = hours

        slot_dt = RESTAURANT_TZ.localize(
            datetime(day.year, day.month, day.day, open_h, open_m)
        )
        close_dt = RESTAURANT_TZ.localize(
            datetime(day.year, day.month, day.day, close_h, close_m)
        )

        times = []
        while slot_dt < close_dt:
            if slot_dt > cutoff:
                times.append({
                    'value': slot_dt.strftime('%H:%M'),
                    'label': slot_dt.strftime('%-I:%M %p'),
                })
            slot_dt += timedelta(minutes=30)

        if times:   # skip today if all slots already passed
            days.append({
                'date_value': day.strftime('%Y-%m-%d'),
                'date_label': day.strftime('%A, %b %-d'),
                'times':      times,
            })

    return days


SPICE_CATEGORIES = {'vegan_curry', 'main_entrees', 'biryani', 'tandoor', 'from_kathmandu'}

CATERING_CATEGORY_ORDER = [
    'starters', 'tandoor', 'veg_mains', 'chicken',
    'seafood', 'rice_noodles', 'breads', 'desserts',
]

# Kitchen access is controlled by Odoo login + 'Kitchen Staff' group
# membership (see _kitchen_auth_ok below) — no shared PIN.

CATEGORY_ORDER = [
    'small_plates',
    'soups_greens',
    'from_kathmandu',
    'from_south_india',
    'tandoor',
    'vegan_curry',
    'main_entrees',
    'bread',
    'gluten_free_bread',
    'rice',
    'biryani',
    'accompaniments',
    'sweet_tooth',
    'beverages',
    'beer',
    'white_wine',
    'red_wine',
    'sake',
    'cocktails',
]

CURRY_ORDER = [
    'korma', 'kerala', 'ginger_garlic', 'tikka_masala',
    'kashmiri', 'vindaloo', 'saag', 'kadai', 'signature',
]


def _get_cart(force_create=False):
    try:
        order = request.cart
        if order:
            return order
    except AttributeError:
        pass
    try:
        order = request.website._get_and_cache_current_cart()
        if order:
            return order
        if force_create:
            return request.website._create_cart()
        return request.env['sale.order'].sudo().browse()
    except AttributeError:
        pass
    return request.env['sale.order'].sudo().browse()


SPICE_LABELS = {
    'mild':      'Mild',
    'medium':    'Medium',
    'hot':       'Hot',
    'extra_hot': 'Extra Hot',
}


def _spice_note(spice_level):
    label = SPICE_LABELS.get(spice_level, spice_level)
    return f'Spice: {label}' if label else ''


def _extract_note(line_name, product_name):
    if not line_name:
        return ''
    parts = line_name.replace(product_name, '', 1).strip()
    return parts.lstrip('\n').strip()


def _cart_payload(order):
    if not order or not order.id:
        return {'items': [], 'total': 0.0, 'count': 0}
    items = [
        {
            'line_id':    l.id,
            'product_id': l.product_id.id,
            'name':       l.product_id.name,
            'note':       _extract_note(l.name, l.product_id.name),
            'qty':        int(l.product_uom_qty),
            'price':      l.price_unit,
            'subtotal':   l.price_subtotal,
        }
        for l in order.order_line if l.product_id
    ]
    return {
        'items': items,
        'total': order.amount_total,
        'count': int(sum(l.product_uom_qty for l in order.order_line)),
    }


def _json_response(result, req_id=None):
    return request.make_json_response({
        'jsonrpc': '2.0',
        'id':      req_id,
        'result':  result,
    })


def _group_products(products):
    """
    Split products into grouped cards and solo cards.
    Returns a list of card dicts:
      Solo:   {'type': 'solo',   'product': <record>}
      Group:  {'type': 'group',  'group_key': str, 'label': str,
                'description': str, 'variants': [<record>, ...],
                'is_available': bool,
                'is_vegan': bool, 'is_vegetarian': bool,
                'is_gluten_free': bool, 'contains_nuts': bool}
    """
    groups = {}   # group_key -> list of products
    solos  = []

    for p in products:
        if p.rms_group_key:
            groups.setdefault(p.rms_group_key, []).append(p)
        else:
            solos.append(p)

    # Sort variants within each group by rms_group_sort
    for key in groups:
        groups[key].sort(key=lambda p: (p.rms_group_sort, p.rms_protein_label or ''))

    # Build ordered card list — preserve original product order for solos,
    # insert group card at the position of the first variant encountered
    seen_groups = set()
    cards = []
    for p in products:
        if p.rms_group_key:
            if p.rms_group_key not in seen_groups:
                seen_groups.add(p.rms_group_key)
                variants = groups[p.rms_group_key]
                # Use the first variant's description as the group description
                desc = next((v.description_sale for v in variants if v.description_sale), '')
                # Dietary flags — true if ALL variants have the flag
                cards.append({
                    'type':          'group',
                    'group_key':     p.rms_group_key,
                    'label':         p.name.rsplit(' - ', 1)[0] if ' - ' in p.name else p.name,
                    'description':   desc,
                    'variants':      variants,
                    'first_variant': next((v for v in variants if v.rms_is_available), variants[0]),  # ADD THIS
                    'is_available':  any(v.rms_is_available for v in variants),
                    'is_vegan':      all(v.rms_is_vegan for v in variants),
                    'is_vegetarian': all(v.rms_is_vegetarian for v in variants),
                    'is_gluten_free':all(v.rms_is_gluten_free for v in variants),
                    'contains_nuts': any(v.rms_contains_nuts for v in variants),
})
        else:
            cards.append({'type': 'solo', 'product': p})

    return cards


class RmsMenuController(WebsiteSale):

    @http.route('/menu', type='http', auth='public', website=True, sitemap=True)
    def menu_page(self, **kwargs):
        ProductTemplate = request.env['product.template'].sudo()

        products = ProductTemplate.search(
            [('rms_is_menu_item', '=', True)],
            order='rms_menu_category, rms_group_key, rms_group_sort, name',
        )

        cat_field   = ProductTemplate._fields['rms_menu_category']
        cat_labels  = dict(cat_field.selection)
        curry_field = ProductTemplate._fields['rms_curry_type']
        curry_labels = dict(curry_field.selection)

        # Bucket products by category
        cat_map = {key: [] for key in CATEGORY_ORDER}
        for p in products:
            key = p.rms_menu_category
            if key and key in cat_map:
                cat_map[key].append(p)

        def _build_main_entrees(items):
            """For main entrees, group by curry_type first, then by group_key."""
            sub_map = {k: [] for k in CURRY_ORDER}
            sub_map['_other'] = []
            for p in items:
                ct = p.rms_curry_type or '_other'
                bucket = sub_map.get(ct, sub_map['_other'])
                bucket.append(p)

            result = []
            for k in CURRY_ORDER:
                if sub_map[k]:
                    cards = _group_products(sub_map[k])
                    result.append({
                        'key':   k,
                        'label': curry_labels.get(k, k),
                        'cards': cards,
                    })
            if sub_map['_other']:
                cards = _group_products(sub_map['_other'])
                result.append({'key': '_other', 'label': 'Other', 'cards': cards})
            return result

        grouped = []
        for key in CATEGORY_ORDER:
            if not cat_map[key]:
                continue
            if key == 'main_entrees':
                grouped.append({
                    'key':            key,
                    'label':          cat_labels.get(key, key),
                    'type':           'main_entrees',
                    'subcategories':  _build_main_entrees(cat_map[key]),
                })
            else:
                grouped.append({
                    'key':   key,
                    'label': cat_labels.get(key, key),
                    'type':  'normal',
                    'cards': _group_products(cat_map[key]),
                })

        is_open, closed_msg = _is_open_now()

        return request.render('rms_website_menu.menu_page', {
            'grouped_products': grouped,
            'spice_categories': SPICE_CATEGORIES,
            'is_open':          is_open,
            'closed_msg':       closed_msg,
        })

    @http.route('/menu/all', type='http', auth='public', website=True, sitemap=True)
    def simple_menu_page(self, **kwargs):
        """
        Flat 'browse everything' view — every available menu item in one
        grid, no category sidebar, no accordion sections. Reuses the
        same grouping/card logic as /menu (so multi-protein dishes still
        merge into one card, and the spice picker still appears for the
        right dishes) — it's the same data, just laid out without the
        category structure around it.
        """
        ProductTemplate = request.env['product.template'].sudo()

        products = ProductTemplate.search(
            [('rms_is_menu_item', '=', True), ('rms_is_available', '=', True)],
            order='rms_menu_category, rms_group_key, rms_group_sort, name',
        )

        # Bucket by category only so each card can carry its real
        # category as cat_key (needed for the spice picker to show up
        # on the right dishes) — but we flatten everything afterward
        # into one list for the template, no per-category sections.
        cat_map = {}
        for p in products:
            key = p.rms_menu_category or '_other'
            cat_map.setdefault(key, []).append(p)

        flat_cards = []
        for cat_key, items in cat_map.items():
            for card in _group_products(items):
                card['cat_key'] = cat_key
                flat_cards.append(card)

        is_open, closed_msg = _is_open_now()

        return request.render('rms_website_menu.simple_menu_page', {
            'cards':            flat_cards,
            'spice_categories': SPICE_CATEGORIES,
            'is_open':          is_open,
            'closed_msg':       closed_msg,
        })

    # ------------------------------------------------------------------ #
    # Cart API                                                             #
    # ------------------------------------------------------------------ #

    @http.route('/rms/cart', type='http', auth='public', website=True, methods=['POST'], csrf=False)
    def rms_cart_get(self, **kwargs):
        body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        return _json_response(_cart_payload(_get_cart()), body.get('id'))

    @http.route('/rms/cart/add', type='http', auth='public', website=True, methods=['POST'], csrf=False)
    def rms_cart_add(self, **kwargs):
        body    = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        params  = body.get('params', {})
        product_id = int(params.get('product_id', 0))
        quantity   = int(params.get('quantity', 1))

        if not product_id:
            return _json_response({'error': 'Missing product_id'}, body.get('id'))

        order = _get_cart(force_create=True)
        if not order or not order.id:
            return _json_response({'error': 'Could not create cart'}, body.get('id'))

        spice_level = params.get('spice_level', '').strip()
        note = _spice_note(spice_level)

        if note:
            matched = None
            for l in order.order_line:
                if l.product_id.id == product_id and note in (l.name or ''):
                    matched = l
                    break
            if matched:
                matched.sudo().write({'product_uom_qty': matched.product_uom_qty + quantity})
            else:
                product = request.env['product.product'].sudo().browse(product_id)
                request.env['sale.order.line'].sudo().create({
                    'order_id':       order.id,
                    'product_id':     product_id,
                    'product_uom_qty':quantity,
                    'price_unit':     product.list_price,
                    'name':           f"{product.name}\n{note}",
                })
        else:
            order.sudo()._cart_add(product_id=product_id, quantity=quantity)

        return _json_response(_cart_payload(order), body.get('id'))

    @http.route('/rms/cart/update', type='http', auth='public', website=True, methods=['POST'], csrf=False)
    def rms_cart_update(self, **kwargs):
        body   = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        params = body.get('params', {})
        line_id  = int(params.get('line_id', 0))
        quantity = int(params.get('quantity', 0))
        order = _get_cart()
        if not order or not order.id:
            return _json_response({'error': 'No active cart'}, body.get('id'))
        order.sudo()._cart_update_line_quantity(line_id=line_id, quantity=quantity)
        return _json_response(_cart_payload(order), body.get('id'))

    @http.route('/rms/cart/set_delivery', type='http', auth='public', website=True, methods=['POST'], csrf=False)
    def rms_set_delivery(self, **kwargs):
        body             = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        delivery_type    = body.get('delivery_type', '').strip()
        delivery_address = body.get('delivery_address', '').strip()
        if delivery_type not in ('pickup', 'delivery'):
            return request.make_json_response({'error': 'Invalid delivery type'}, status=400)
        order = _get_cart()
        if not order or not order.id:
            return request.make_json_response({'error': 'No active cart'}, status=400)
        vals = {'rms_delivery_type': delivery_type}
        if delivery_type == 'delivery':
            vals['rms_delivery_address'] = delivery_address
            vals['note'] = f"Delivery to: {delivery_address}" if delivery_address else "Delivery (address TBC)"
        else:
            vals['rms_delivery_address'] = False
            vals['note'] = 'Pickup order'
        order.sudo().write(vals)
        return request.make_json_response({'ok': True, 'delivery_type': delivery_type})

    # ------------------------------------------------------------------ #
    # Checkout                                                             #
    # ------------------------------------------------------------------ #

    @http.route('/shop/address', type='http', auth='public', website=True, sitemap=False)
    def rms_redirect_shop_address(self, **kwargs):
        """
        Override Odoo's native /shop/address page entirely.
        We never need this page — contact info and delivery address are
        collected directly on /rms/checkout for both logged-in and guest users.

        If the order already has rms_delivery_type set (checkout was completed),
        go straight to payment. Otherwise send them to our checkout page.
        """
        order = _get_cart()
        if order and order.id and order.rms_delivery_type:
            return request.redirect('/shop/payment')
        return request.redirect('/rms/checkout')

    @http.route('/shop/checkout', type='http', auth='public', website=True, sitemap=False)
    def rms_redirect_shop_checkout(self, **kwargs):
        """
        Odoo's native flow goes /shop/cart -> /shop/address -> /shop/checkout
        (delivery method) -> /shop/payment. We don't use Odoo's native
        delivery-method step — pickup/delivery and scheduling are chosen
        on /rms/checkout instead. So whenever this route is hit, send the
        customer there. If they already completed /rms/checkout
        (rms_delivery_type is set on the order), skip straight to payment
        instead of bouncing them back.
        """
        order = _get_cart()
        if order and order.id and order.rms_delivery_type:
            response = request.redirect('/shop/payment')
            # Remember the order id in a cookie — Odoo's own payment flow
            # clears sale_order_id from the session on success, which
            # would otherwise leave us with no way to find the order
            # again once the customer lands back on /shop or
            # /shop/confirmation after paying.
            response.set_cookie('rms_last_order_id', str(order.id), max_age=3600)
            return response
        return request.redirect('/rms/checkout')

    @http.route('/rms/checkout', type='http', auth='public', website=True, sitemap=False)
    def rms_checkout_page(self, **kwargs):
        is_open, closed_msg = _is_open_now()
        order = _get_cart()
        return request.render('rms_website_menu.order_summary', {
            'order':          order,
            'error':          kwargs.get('error', ''),
            'is_closed':      False,
            'off_hours':      not is_open,
            'closed_msg':     closed_msg,
            'schedule_slots': _generate_schedule_slots(),
            'prefill_pickup': False,
        })

    @http.route('/rms/checkout/save', type='http', auth='public', website=True, methods=['POST'], csrf=False, sitemap=False)
    def rms_checkout_save(self, **kwargs):
        is_open, closed_msg = _is_open_now()
        order = _get_cart()
        if not order or not order.id:
            return request.redirect('/menu')
        delivery_type    = kwargs.get('delivery_type', '').strip()
        delivery_address = kwargs.get('delivery_address', '').strip()
        pickup_name      = kwargs.get('pickup_name', '').strip()
        pickup_phone     = kwargs.get('pickup_phone', '').strip()
        pickup_email     = kwargs.get('pickup_email', '').strip()   # optional
        addr_name        = kwargs.get('addr_name', '').strip()
        addr_phone       = kwargs.get('addr_phone', '').strip()
        addr_email       = kwargs.get('addr_email', '').strip()     # optional

        def _render_checkout_error(msg):
            return request.render('rms_website_menu.order_summary', {
                'order': order, 'error': msg, 'is_closed': False,
                'schedule_slots': _generate_schedule_slots(),
                'off_hours': not is_open, 'closed_msg': closed_msg,
                'prefill_pickup': False,
            })

        if delivery_type not in ('pickup', 'delivery'):
            return _render_checkout_error('Please select Pickup or Delivery.')
        if delivery_type == 'pickup' and not pickup_name:
            return _render_checkout_error('Please enter your name for pickup.')
        if delivery_type == 'pickup' and not pickup_phone:
            return _render_checkout_error('Please enter your phone number for pickup.')
        if delivery_type == 'delivery' and not addr_name:
            return _render_checkout_error('Please enter your name.')
        if delivery_type == 'delivery' and not addr_phone:
            return _render_checkout_error('Please enter your phone number.')
        if delivery_type == 'delivery' and not delivery_address:
            return _render_checkout_error('Please enter your delivery address.')

        # Distance check for delivery orders
        if delivery_type == 'delivery' and delivery_address:
            lat, lng = _geocode_address(delivery_address)
            if lat is not None:
                distance = _haversine_miles(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng)
                if distance > DELIVERY_RADIUS_MILES:
                    # Get customer name for the personalised message
                    partner = order.partner_id
                    name = (partner.name or '').split()[0] if partner and partner.name else 'there'
                    out_of_range_msg = (
                        f"Hi {name}, thanks for ordering with us! Unfortunately, your address "
                        f"falls outside our delivery range "
                        f"({distance:.1f} miles — we deliver within {DELIVERY_RADIUS_MILES} miles). "
                        f"We would still love to fulfil your order — would you be open to changing "
                        f"this to an in-store pickup so your items are kept fresh?"
                    )
                    is_open, closed_msg = _is_open_now()
                    return request.render('rms_website_menu.order_summary', {
                        'order':            order,
                        'error':            out_of_range_msg,
                        'is_closed':        False,
                        'off_hours':        not is_open,
                        'closed_msg':       closed_msg,
                        'schedule_slots':   _generate_schedule_slots(),
                        'prefill_pickup':   True,
                    })
        # Parse scheduled time from two separate fields: date + time (optional)
        scheduled_date = kwargs.get('scheduled_date', '').strip()
        scheduled_time = kwargs.get('scheduled_time', '').strip()
        scheduled_dt = False
        if scheduled_date and scheduled_time:
            try:
                naive_local = datetime.strptime(f"{scheduled_date} {scheduled_time}", '%Y-%m-%d %H:%M')
                local_dt = RESTAURANT_TZ.localize(naive_local)
                day_hours = _get_business_hours().get(local_dt.weekday())
                if day_hours:
                    oh, om, ch, cm = day_hours
                    open_dt  = RESTAURANT_TZ.localize(datetime(local_dt.year, local_dt.month, local_dt.day, oh, om))
                    close_dt = RESTAURANT_TZ.localize(datetime(local_dt.year, local_dt.month, local_dt.day, ch, cm))
                    if open_dt <= local_dt < close_dt:
                        scheduled_dt = local_dt.astimezone(pytz.utc).replace(tzinfo=None)
            except (ValueError, Exception):
                pass

        # During off-hours, ASAP orders are not allowed — must schedule
        if not is_open and not scheduled_dt:
            order = _get_cart()
            return request.render('rms_website_menu.order_summary', {
                'order':          order,
                'error':          "We're currently closed. Please schedule your order for a future time.",
                'is_closed':      False,
                'off_hours':      True,
                'closed_msg':     closed_msg,
                'schedule_slots': _generate_schedule_slots(),
                'prefill_pickup': False,
            })

        special_request = kwargs.get('special_request', '').strip()[:60]

        # Tips are calculated from the food subtotal before tax and delivery.
        # The dedicated Tip product has no sales tax, and replacing its line
        # makes checkout resubmissions idempotent.
        # The tip product is intentionally unpublished, so resolve it as
        # sudo before reading its variant in this public checkout route.
        tip_product = request.env.ref(
            'rms_website_menu.product_template_tip'
        ).sudo().product_variant_id
        tip_lines = order.order_line.filtered(
            lambda line: line.product_id == tip_product
        )
        food_subtotal = sum(
            order.order_line.filtered(
                lambda line: not line.is_delivery
                and line.product_id != tip_product
                and not line.display_type
            ).mapped('price_subtotal')
        )
        tip_choice = kwargs.get('tip_choice', '0').strip()
        tip_amount = 0.0
        try:
            if tip_choice in ('10', '15', '20'):
                tip_amount = food_subtotal * float(tip_choice) / 100.0
            elif tip_choice == 'custom':
                tip_amount = float(Decimal(kwargs.get('custom_tip', '0').strip() or '0'))
        except (InvalidOperation, TypeError, ValueError):
            tip_amount = 0.0
        if not math.isfinite(tip_amount):
            tip_amount = 0.0
        tip_amount = order.currency_id.round(max(0.0, min(tip_amount, 500.0)))
        tip_lines.sudo().unlink()
        if tip_amount:
            tip_line = request.env['sale.order.line'].sudo().create({
                'order_id': order.id,
                'product_id': tip_product.id,
                'name': 'Tip',
                'product_uom_qty': 1.0,
                'tax_ids': [(5, 0, 0)],
            })
            tip_line.write({'rms_tip_amount': tip_amount})

        order.sudo().write({
            'rms_delivery_type':    delivery_type,
            'rms_delivery_address': delivery_address if delivery_type == 'delivery' else False,
            'rms_scheduled_time':   scheduled_dt,
            'rms_special_request':  special_request or False,
            # Do NOT set rms_kitchen_status here — it must only be set after
            # payment confirmation (model write hook sets it when state→sale)
        })

        # Save phone/email on the partner for pickup orders, and set the
        # partner_shipping_id so Odoo never needs to redirect to /shop/address.
        partner = order.partner_id

        # For guest (public) users, create a real partner from the submitted
        # contact details so we don't write onto the shared public partner.
        is_public = request.website.is_public_user()
        if is_public:
            contact_name  = pickup_name if delivery_type == 'pickup' else addr_name
            contact_phone = pickup_phone if delivery_type == 'pickup' else addr_phone
            contact_email = pickup_email if delivery_type == 'pickup' else addr_email
            ca = request.env['res.country'].sudo().search([('code', '=', 'US')], limit=1)
            new_partner = request.env['res.partner'].sudo().create({
                'name':       contact_name or 'Guest',
                'phone':      contact_phone,
                'email':      contact_email,
                'country_id': ca.id if ca else False,
            })
            order.sudo().write({
                'partner_id':          new_partner.id,
                'partner_invoice_id':  new_partner.id,
                'partner_shipping_id': new_partner.id,
            })
            partner = new_partner
        if delivery_type == 'pickup':
            # Update phone/email on the customer partner
            partner_vals = {}
            if pickup_name:
                partner_vals['name'] = pickup_name
            if pickup_phone:
                partner_vals['phone'] = pickup_phone
            if pickup_email:
                partner_vals['email'] = pickup_email
            if partner_vals:
                partner.sudo().write(partner_vals)
            # Odoo 19's payment page validates that partner_shipping_id and
            # partner_invoice_id both have a street + city. For pickup we use
            # the restaurant address as the shipping address so the validation
            # passes without needing to redirect to /shop/address.
            ca = request.env['res.country'].sudo().search([('code', '=', 'US')], limit=1)
            ca_state = request.env['res.country.state'].sudo().search(
                [('code', '=', 'CA'), ('country_id', '=', ca.id)], limit=1
            ) if ca else False
            pickup_addr_vals = {
                'street': '1386 9th Ave',
                'city': 'San Francisco',
                'zip': '94122',
                'state_id': ca_state.id if ca_state else False,
                'country_id': ca.id if ca else False,
            }
            shipping_partner = order.partner_shipping_id
            update_vals = {}
            if shipping_partner and shipping_partner != partner.commercial_partner_id:
                shipping_partner.sudo().write(pickup_addr_vals)
            else:
                new_shipping = partner.sudo().copy({
                    'type': 'delivery',
                    'parent_id': partner.id,
                    **pickup_addr_vals,
                })
                # res.partner.copy() unconditionally appends " (copy)" to
                # name, overriding whatever we passed above — fix it back.
                new_shipping.sudo().write({
                    'name': pickup_name or partner.name,
                    'company_name': False,
                })
                update_vals['partner_shipping_id'] = new_shipping.id
            # Billing — set to main partner (ensure it has a street too)
            if not partner.street:
                partner.sudo().write(pickup_addr_vals)
            update_vals['partner_invoice_id'] = partner.id
            if update_vals:
                order.sudo().write(update_vals)

        # Use the address typed into our checkout form as the customer's
        # shipping address. This makes /shop/address a no-op step, so
        # the customer never has to fill in their address twice.
        if delivery_type == 'delivery':
            # Save name/phone/email on the main partner record
            delivery_partner_vals = {}
            if addr_name:
                delivery_partner_vals['name'] = addr_name
            if addr_phone:
                delivery_partner_vals['phone'] = addr_phone
            if addr_email:
                delivery_partner_vals['email'] = addr_email
            if delivery_partner_vals:
                partner.sudo().write(delivery_partner_vals)

            addr_street  = kwargs.get('addr_street', '').strip()
            addr_apt     = kwargs.get('addr_apt', '').strip()
            addr_city    = kwargs.get('addr_city', '').strip()
            addr_zip     = kwargs.get('addr_zip', '').strip()
            addr_state   = kwargs.get('addr_state', 'California').strip()
            addr_country = kwargs.get('addr_country', 'United States').strip()

            if addr_street and addr_city:
                state = request.env['res.country.state'].sudo().search(
                    [('name', '=', addr_state)], limit=1
                )
                country = request.env['res.country'].sudo().search(
                    [('name', '=', addr_country)], limit=1
                )
                street_line = f"{addr_street}, {addr_apt}" if addr_apt else addr_street

                shipping_partner = order.partner_shipping_id

                addr_vals = {
                    'name':     addr_name or partner.name,
                    'phone':    addr_phone or partner.phone,
                    'street':   street_line,
                    'city':     addr_city,
                    'zip':      addr_zip,
                    'state_id': state.id if state else False,
                    'country_id': country.id if country else False,
                }

                if shipping_partner and shipping_partner != partner.commercial_partner_id:
                    shipping_partner.sudo().write(addr_vals)
                else:
                    # No dedicated shipping partner yet — create one so we
                    # don't overwrite the customer's main/billing address
                    new_shipping = partner.sudo().copy({
                        'type': 'delivery',
                        'parent_id': partner.id,
                        **addr_vals,
                    })
                    # res.partner.copy() unconditionally appends " (copy)" to
                    # name, overriding whatever we passed above — fix it back.
                    new_shipping.sudo().write({
                        'name': addr_vals['name'],
                        'company_name': False,
                    })
                    order.sudo().write({'partner_shipping_id': new_shipping.id})
                # Always set billing to the main partner so Odoo's payment
                # page never redirects to /shop/address?address_type=billing
                if order.partner_invoice_id != partner:
                    order.sudo().write({'partner_invoice_id': partner.id})

        # Explicitly assign a shipping method based on pickup/delivery.
        # Our checkout skips /shop/address (which normally auto-assigns
        # a carrier), so without this the order reaches /shop/payment
        # with no carrier_id and Odoo blocks payment with
        # "No shipping method is selected."
        if delivery_type == 'pickup':
            # Prefer a carrier literally named for pickup; else cheapest published one
            carrier = request.env['delivery.carrier'].sudo().search(
                [('name', 'ilike', 'pickup'), ('website_published', '=', True)], limit=1
            )
        else:
            carrier = request.env['delivery.carrier'].sudo().search(
                [('name', 'ilike', 'delivery'), ('website_published', '=', True)], limit=1
            )
        if not carrier:
            # Fall back to any published carrier so payment isn't blocked
            carrier = request.env['delivery.carrier'].sudo().search(
                [('website_published', '=', True)], limit=1
            )
        if carrier:
            try:
                order.sudo().set_delivery_line(carrier, carrier.rate_shipment(order)['price'])
            except Exception as e:
                _logger.warning("RMS: failed to set delivery carrier %s: %s", carrier.name, e)

        # Go straight to payment — skips /shop/cart so the off-hours
        # cart override doesn't bounce the user back to /rms/checkout
        response = request.redirect('/shop/payment')
        # Same cookie as above — needed because Odoo's own payment flow
        # clears sale_order_id from session on success.
        response.set_cookie('rms_last_order_id', str(order.id), max_age=3600)
        return response

    @http.route('/rms/checkout/edit-address', type='http', auth='public', website=True, sitemap=False)
    def rms_edit_address(self, **kwargs):
        """
        Focused edit page shown when the customer clicks Edit on /shop/payment.
        Only shows the fields relevant to their chosen delivery type —
        name/phone/email for pickup, plus address fields for delivery.
        """
        order = _get_cart()
        if not order or not order.id or not order.rms_delivery_type:
            return request.redirect('/rms/checkout')
        partner = order.partner_id
        shipping = order.partner_shipping_id
        return request.render('rms_website_menu.edit_address', {
            'order': order,
            'partner': partner,
            'shipping': shipping,
            'delivery_type': order.rms_delivery_type,
        })

    @http.route('/rms/checkout/save-address', type='http', auth='public', website=True,
                methods=['POST'], csrf=False, sitemap=False)
    def rms_save_address(self, **kwargs):
        """
        Saves the edited contact/address info and redirects back to payment.
        Does not re-run the full checkout flow — only updates the relevant
        partner fields and shipping partner address.
        """
        order = _get_cart()
        if not order or not order.id:
            return request.redirect('/rms/checkout')

        partner = order.partner_id
        delivery_type = order.rms_delivery_type

        name  = kwargs.get('name', '').strip()
        phone = kwargs.get('phone', '').strip()
        email = kwargs.get('email', '').strip()

        # Update name/phone/email on the main partner
        partner_vals = {}
        if name:
            partner_vals['name'] = name
        if phone:
            partner_vals['phone'] = phone
        if email:
            partner_vals['email'] = email
        if partner_vals:
            partner.sudo().write(partner_vals)

        if delivery_type == 'delivery':
            addr_street  = kwargs.get('addr_street', '').strip()
            addr_apt     = kwargs.get('addr_apt', '').strip()
            addr_city    = kwargs.get('addr_city', '').strip()
            addr_zip     = kwargs.get('addr_zip', '').strip()
            addr_state   = kwargs.get('addr_state', 'California').strip()

            if addr_street and addr_city:
                state = request.env['res.country.state'].sudo().search(
                    [('name', '=', addr_state)], limit=1
                )
                country = request.env['res.country'].sudo().search(
                    [('code', '=', 'US')], limit=1
                )
                street_line = f"{addr_street}, {addr_apt}" if addr_apt else addr_street
                addr_vals = {
                    'name':       name or partner.name,
                    'phone':      phone or partner.phone,
                    'street':     street_line,
                    'city':       addr_city,
                    'zip':        addr_zip,
                    'state_id':   state.id if state else False,
                    'country_id': country.id if country else False,
                }
                shipping = order.partner_shipping_id
                if shipping and shipping != partner.commercial_partner_id:
                    shipping.sudo().write(addr_vals)
                else:
                    new_shipping = partner.sudo().copy({
                        'type': 'delivery',
                        'parent_id': partner.id,
                        **addr_vals,
                    })
                    # res.partner.copy() unconditionally appends " (copy)" to
                    # name, overriding whatever we passed above — fix it back.
                    new_shipping.sudo().write({
                        'name': addr_vals['name'],
                        'company_name': False,
                    })
                    order.sudo().write({'partner_shipping_id': new_shipping.id})

        return request.redirect('/shop/payment')

    def _rms_pop_last_order(self):
        """
        Find the order to show on the confirmation page. Tries the
        session cart first, then falls back to the rms_last_order_id
        cookie we set just before sending the customer to payment —
        needed because Odoo's own payment flow clears sale_order_id
        from the session once payment succeeds, so by the time the
        customer lands back on /shop or /shop/confirmation the normal
        session-based lookup is often already empty.
        Returns the order recordset (possibly empty) and a response
        object with the cookie cleared, or None if nothing to clear.
        """
        order = _get_cart()
        if order and order.id and order.state in ('sale', 'done'):
            return order
        cookie_id = request.httprequest.cookies.get('rms_last_order_id')
        if cookie_id:
            try:
                order = request.env['sale.order'].sudo().browse(int(cookie_id))
                if order.exists() and order.state in ('sale', 'done'):
                    return order
            except (ValueError, TypeError):
                pass
        return request.env['sale.order'].sudo().browse()

    @http.route('/shop/confirmation', type='http', auth='public', website=True, sitemap=False)
    def rms_redirect_shop_confirmation(self, **kwargs):
        """
        Odoo's native flow lands here right after a successful payment.
        We don't use Odoo's order-confirmation page — our own checkout
        already showed order details before payment. Instead, send the
        customer to our own /rms/order/<id> confirmation page so they
        can see proof their order was placed. No super() call — this
        fully replaces the route, so it can't crash on a renamed parent
        method.
        """
        order = self._rms_pop_last_order()
        if order and order.id:
            order.sudo()._portal_ensure_token()
            response = request.redirect(f'/rms/order/{order.id}?access_token={order.access_token}')
            response.set_cookie('rms_last_order_id', '', max_age=0)
            request.session['sale_order_id'] = None
            return response
        return request.redirect('/')

    @http.route('/shop', type='http', auth='public', website=True, sitemap=False)
    def rms_redirect_shop(self, **kwargs):
        """
        Odoo's payment 'Skip' link / auto-redirect lands here directly
        via the generic payment module's _get_shop_path() fallback.
        We don't use /shop as a real browsing page in this restaurant's
        flow — /menu and /catering are. If a just-paid order can be
        found (session or cookie), send the customer to its
        confirmation page; otherwise send them home. Full route
        replacement, no super().
        """
        order = self._rms_pop_last_order()
        if order and order.id:
            order.sudo()._portal_ensure_token()
            response = request.redirect(f'/rms/order/{order.id}?access_token={order.access_token}')
            response.set_cookie('rms_last_order_id', '', max_age=0)
            request.session['sale_order_id'] = None
            return response
        return request.redirect('/')

    def _order_tracking_access_ok(self, order, token=''):
        user = request.env.user
        is_owner_or_staff = (
            not user._is_public() and (
                user.partner_id.commercial_partner_id == order.partner_id.commercial_partner_id
                or user.has_group('base.group_system')
                or user.has_group('rms_website_menu.group_rms_kitchen_staff')
            )
        )
        token_ok = bool(token) and bool(order.access_token) and hmac.compare_digest(
            str(token), str(order.access_token)
        )
        return is_owner_or_staff or token_ok

    @staticmethod
    def _tracking_timestamp(value):
        return value.isoformat() + 'Z' if value else None

    def _order_tracking_payload(self, order):
        kitchen_status = order.rms_kitchen_status or 'new'
        if kitchen_status == 'done':
            state = 'completed'
        elif kitchen_status == 'ready':
            state = 'ready'
        elif kitchen_status == 'preparing':
            state = 'preparing'
        elif order.rms_accepted_at:
            state = 'accepted'
        else:
            state = 'received'

        state_rank = {
            'received': -1,
            'accepted': 0,
            'preparing': 1,
            'ready': 2,
            'completed': 3,
        }[state]
        messages = {
            'received': 'Order received. Waiting for the restaurant to accept it.',
            'accepted': 'The restaurant accepted your order.',
            'preparing': 'Your order is being prepared.',
            'ready': 'Your order is ready.',
            'completed': 'Your order is complete. Thank you!',
        }
        step_data = (
            ('accepted', 'Accepted', order.rms_accepted_at),
            ('preparing', 'Preparing', order.rms_preparing_at),
            ('ready', 'Ready', order.rms_ready_at),
            ('completed', 'Completed', order.rms_done_at),
        )
        steps = []
        for index, (key, label, timestamp) in enumerate(step_data):
            steps.append({
                'key': key,
                'label': label,
                'complete': state_rank >= index,
                'active': (state == 'received' and index == 0) or state == key,
                'timestamp': self._tracking_timestamp(timestamp),
            })
        return {
            'ok': True,
            'order': order.name,
            'state': state,
            'message': messages[state],
            'steps': steps,
            'updated_at': self._tracking_timestamp(order.write_date),
        }

    @http.route('/rms/order/<int:order_id>', type='http', auth='public', website=True, sitemap=False)
    def rms_order_confirmation(self, order_id, **kwargs):
        """
        Order confirmation / receipt page. Shown right after payment so
        the customer has proof their order went through, with the same
        details a checkout would show: items, total, fulfillment type,
        address (if delivery), and scheduled time (if not ASAP).

        Access control: requires a valid ?access_token=<uuid> matching
        the order's own token (the same mechanism Odoo's customer portal
        uses for guest order viewing). The order ID alone is NOT enough —
        it's sequential and guessable, but the token is a random UUID
        generated per-order, so there's nothing to brute-force in
        practice. Logged-in users who own the order, or staff/admins,
        can view it without the token too.
        """
        order = request.env['sale.order'].sudo().browse(order_id)
        if not order.exists() or order.state not in ('sale', 'done'):
            return request.redirect('/')

        token = kwargs.get('access_token', '')
        user = request.env.user
        if not self._order_tracking_access_ok(order, token):
            return request.redirect('/')

        order.sudo()._portal_ensure_token()
        token = order.access_token
        encoded_token = urllib.parse.quote(str(token), safe='')
        tracking_path = f'/rms/order/{order.id}?access_token={encoded_token}'
        status_url = f'/rms/order/{order.id}/status?access_token={encoded_token}'
        manifest_url = f'/rms/order/{order.id}/manifest.webmanifest?access_token={encoded_token}'
        tracking_payload = self._order_tracking_payload(order)

        scheduled_time_local = None
        if order.rms_scheduled_time:
            scheduled_time_local = pytz.utc.localize(order.rms_scheduled_time) \
                .astimezone(RESTAURANT_TZ).strftime('%A, %b %-d at %-I:%M %p')

        response = request.render('rms_website_menu.order_confirmation', {
            'order': order,
            'is_logged_in': not user._is_public(),
            'scheduled_time_local': scheduled_time_local,
            'tracking_url': tracking_path,
            'tracking_status_url': status_url,
            'tracking_manifest_url': manifest_url,
            'tracking_payload': tracking_payload,
        })
        response.headers['Cache-Control'] = 'private, no-store, max-age=0'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
        return response

    @http.route('/rms/order/<int:order_id>/status', type='http', auth='public',
                methods=['GET'], website=True, sitemap=False)
    def rms_order_tracking_status(self, order_id, **kwargs):
        order = request.env['sale.order'].sudo().browse(order_id)
        token = kwargs.get('access_token', '')
        if not order.exists() or order.state not in ('sale', 'done') or \
                not self._order_tracking_access_ok(order, token):
            return request.make_json_response({'error': 'not_found'}, status=404)
        response = request.make_json_response(self._order_tracking_payload(order))
        response.headers['Cache-Control'] = 'private, no-store, max-age=0'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive'
        return response

    @http.route('/rms/order/<int:order_id>/manifest.webmanifest', type='http', auth='public',
                methods=['GET'], website=True, sitemap=False)
    def rms_order_tracking_manifest(self, order_id, **kwargs):
        order = request.env['sale.order'].sudo().browse(order_id)
        token = kwargs.get('access_token', '')
        if not order.exists() or order.state not in ('sale', 'done') or \
                not self._order_tracking_access_ok(order, token):
            return request.make_response('Not found', status=404)
        encoded_token = urllib.parse.quote(str(order.access_token), safe='')
        start_url = f'/rms/order/{order.id}?access_token={encoded_token}'
        manifest = {
            'id': f'/rms/order/{order.id}',
            'name': f'Track Order {order.name}',
            'short_name': f'Order {order.name}',
            'description': 'Live restaurant order tracking',
            'start_url': start_url,
            'scope': '/rms/order/',
            'display': 'standalone',
            'background_color': '#f4f6f5',
            'theme_color': '#9d2525',
            'icons': [
                {
                    'src': '/rms_website_menu/static/src/img/order-tracking-192.png',
                    'sizes': '192x192',
                    'type': 'image/png',
                    'purpose': 'any maskable',
                },
                {
                    'src': '/rms_website_menu/static/src/img/order-tracking-512.png',
                    'sizes': '512x512',
                    'type': 'image/png',
                    'purpose': 'any maskable',
                },
            ],
        }
        response = request.make_response(json.dumps(manifest), headers=[
            ('Content-Type', 'application/manifest+json; charset=utf-8'),
            ('Cache-Control', 'private, no-store, max-age=0'),
            ('X-Robots-Tag', 'noindex, nofollow, noarchive'),
        ])
        return response

    @http.route('/rms/order-tracking-sw.js', type='http', auth='public',
                methods=['GET'], website=False, sitemap=False)
    def rms_order_tracking_service_worker(self, **kwargs):
        return request.make_response(ORDER_TRACKING_SERVICE_WORKER, headers=[
            ('Content-Type', 'application/javascript; charset=utf-8'),
            ('Cache-Control', 'no-cache'),
            ('Service-Worker-Allowed', '/rms/order/'),
        ])

    @http.route('/rms/my-orders', type='http', auth='user', website=True, sitemap=False)
    def rms_my_orders(self, **kwargs):
        """
        Order history for logged-in customers — the "profile" page.
        Unlike /rms/order/<id>, this needs no token: being logged in
        as the order's own customer is the access control. Lists their
        past restaurant orders newest first, each linking to its own
        /rms/order/<id> confirmation/receipt page (we generate a fresh
        token on the fly so the link still works the same way).
        """
        partner = request.env.user.partner_id.commercial_partner_id
        orders = request.env['sale.order'].sudo().search([
            ('partner_id', 'child_of', partner.id),
            ('state', 'in', ('sale', 'done')),
            ('website_id', '!=', False),
        ], order='date_order desc', limit=50)
        return request.render('rms_website_menu.my_orders_page', {
            'orders': orders,
        })

    # ------------------------------------------------------------------ #
    # Reservation                                                          #
    # ------------------------------------------------------------------ #

    @http.route('/reservation', type='http', auth='public', website=True, sitemap=True)
    def reservation_page(self, **kwargs):
        is_open, closed_msg = _is_open_now()
        return request.render('rms_website_menu.reservation_page', {
            'error':      kwargs.get('error', ''),
            'success':    kwargs.get('success', False),
            'is_open':    is_open,
            'closed_msg': closed_msg,
            'business_hours_json': _business_hours_json(),
        })

    @http.route('/reservation/submit', type='http', auth='public', website=True, methods=['POST'], csrf=False, sitemap=False)
    def reservation_submit(self, **kwargs):
        is_open, closed_msg = _is_open_now()
        if not is_open:
            return request.render('rms_website_menu.reservation_page', {
                'error': f"Reservations cannot be submitted right now. {closed_msg}",
                'is_open': False, 'closed_msg': closed_msg,
                'business_hours_json': _business_hours_json(),
            })

        name      = kwargs.get('name', '').strip()
        email     = kwargs.get('email', '').strip()
        phone     = kwargs.get('phone', '').strip()
        date_str  = kwargs.get('date', '').strip()
        time_str  = kwargs.get('time', '').strip()
        end_time_str = kwargs.get('end_time', '').strip()
        headcount = kwargs.get('headcount', '').strip()
        occasion  = kwargs.get('occasion', '').strip()
        details   = kwargs.get('details', '').strip()

        errors = []
        if not name:      errors.append('Name is required.')
        if not email:     errors.append('Email is required.')
        if not phone:     errors.append('Phone is required.')
        if not date_str:  errors.append('Date is required.')
        if not time_str:  errors.append('Time is required.')
        if not headcount: errors.append('Head count is required.')

        if errors:
            return request.render('rms_website_menu.reservation_page', {
                'error': ' '.join(errors), 'form': kwargs,
                'is_open': True, 'closed_msg': '',
                'business_hours_json': _business_hours_json(),
            })

        try:
            event_dt = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            event_end_dt = datetime.strptime(f"{date_str} {end_time_str}", "%Y-%m-%d %H:%M") if end_time_str else None
        except ValueError:
            return request.render('rms_website_menu.reservation_page', {
                'error': 'Invalid date or time format.', 'form': kwargs,
                'is_open': True, 'closed_msg': '',
                'business_hours_json': _business_hours_json(),
            })

        day_hours = _get_business_hours().get(event_dt.weekday())
        event_minutes = event_dt.hour * 60 + event_dt.minute
        if day_hours:
            open_minutes = day_hours[0] * 60 + day_hours[1]
            close_minutes = day_hours[2] * 60 + day_hours[3]
        if not day_hours or not (open_minutes <= event_minutes < close_minutes):
            return request.render('rms_website_menu.reservation_page', {
                'error': 'Please choose a reservation time during business hours.',
                'form': kwargs,
                'is_open': True,
                'closed_msg': '',
                'business_hours_json': _business_hours_json(),
            })
        if event_end_dt:
            end_minutes = event_end_dt.hour * 60 + event_end_dt.minute
            if end_minutes <= event_minutes:
                return request.render('rms_website_menu.reservation_page', {
                    'error': 'End time must be after the start time.',
                    'form': kwargs,
                    'is_open': True,
                    'closed_msg': '',
                    'business_hours_json': _business_hours_json(),
                })
            if end_minutes > close_minutes:
                return request.render('rms_website_menu.reservation_page', {
                    'error': 'End time must be during business hours.',
                    'form': kwargs,
                    'is_open': True,
                    'closed_msg': '',
                    'business_hours_json': _business_hours_json(),
                })

        Partner = request.env['res.partner'].sudo()
        partner = Partner.search([('email', '=', email)], limit=1)
        if not partner:
            partner = Partner.create({'name': name, 'email': email, 'phone': phone})

        occasion_labels = {
            'birthday':  'Birthday / Party',
            'corporate': 'Corporate Meeting',
            'seminar':   'Seminar / Conference',
            'private':   'Private Dining',
            'other':     'Other',
        }
        occasion_label = occasion_labels.get(occasion, occasion)
        event_local = RESTAURANT_TZ.localize(event_dt)
        event_stop_local = RESTAURANT_TZ.localize(event_end_dt) if event_end_dt else event_local + timedelta(minutes=15)
        event_start_utc = event_local.astimezone(pytz.utc).replace(tzinfo=None)
        event_stop_utc = event_stop_local.astimezone(pytz.utc).replace(tzinfo=None)

        description = (
            f"Occasion: {occasion_label}\n"
            f"Head count: {headcount}\n"
            f"Contact: {name} | {phone} | {email}\n"
            f"Time zone: {RESTAURANT_TZ.zone}"
        )
        if end_time_str:
            description += f"\nEnd time: {end_time_str}"
        if details:
            description += f"\nDetails: {details}"

        company = request.env.company
        request.env['calendar.event'].sudo().create({
            'name':        f"[Reservation] {occasion_label} — {name} ({headcount} guests)",
            'start':       event_start_utc,
            'stop':        event_stop_utc,
            'description': description,
            'partner_ids': [(4, partner.id)] + [(4, u.partner_id.id) for u in company.sudo().user_ids if u.partner_id],
            'location':    'Timur Indian Restaurant',
            'privacy':     'confidential',
        })

        return request.render('rms_website_menu.reservation_confirmed', {
            'name':           name,
            'date_str':       date_str,
            'time_str':       time_str,
            'end_time_str':   end_time_str,
            'headcount':      headcount,
            'occasion_label': occasion_label,
        })

    # ------------------------------------------------------------------ #
    # Stock admin                                                          #
    # ------------------------------------------------------------------ #

    def _stock_auth_ok(self):
        user = request.env.user
        return user.has_group('base.group_system') or \
               user.has_group('rms_website_menu.group_rms_stock_manager')

    def _stock_forbidden(self):
        return request.make_json_response({'error': 'forbidden'}, status=403)

    @http.route('/rms/admin/stock', type='http', auth='user', website=True, sitemap=False)
    def stock_admin(self, **kwargs):
        if not self._stock_auth_ok():
            return request.render('rms_website_menu.stock_access_denied')
        ProductTemplate = request.env['product.template'].sudo()
        cat_field  = ProductTemplate._fields['rms_menu_category']
        cat_labels = dict(cat_field.selection)
        products   = ProductTemplate.search(
            [('rms_is_menu_item', '=', True)],
            order='rms_menu_category, name',
        )
        return request.render('rms_website_menu.stock_admin_page', {
            'products':       products,
            'cat_labels':     cat_labels,
            'cat_options':    cat_field.selection,
        })

    @http.route('/rms/admin/stock/toggle', type='http', auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def stock_toggle(self, **kwargs):
        if not self._stock_auth_ok():
            return self._stock_forbidden()
        body       = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        product_id = int(body.get('product_id', 0))
        if not product_id:
            return request.make_json_response({'error': 'Missing product_id'}, status=400)
        product = request.env['product.template'].sudo().browse(product_id)
        if not product.exists() or not product.rms_is_menu_item:
            return request.make_json_response({'error': 'Not found'}, status=404)
        product.rms_is_available = not product.rms_is_available
        return request.make_json_response({
            'product_id': product_id,
            'available':  product.rms_is_available,
        })

    @http.route('/rms/admin/stock/update', type='http', auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def stock_update_item(self, **kwargs):
        """
        Single edit endpoint for a menu item — name, price, description,
        category, spice level, dietary flags, and (optionally) a new
        photo — all from one form on the stock page. Replaces the old
        separate price-only and image-only endpoints.
        """
        if not self._stock_auth_ok():
            return self._stock_forbidden()
        body       = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        product_id = int(body.get('product_id', 0))
        if not product_id:
            return request.make_json_response({'error': 'Missing product_id'}, status=400)

        product = request.env['product.template'].sudo().browse(product_id)
        if not product.exists() or not product.rms_is_menu_item:
            return request.make_json_response({'error': 'Not found'}, status=404)

        name = (body.get('name') or '').strip()
        if not name:
            return request.make_json_response({'error': 'Name is required'}, status=400)

        try:
            price = float(body.get('price', ''))
        except (ValueError, TypeError):
            return request.make_json_response({'error': 'Invalid price'}, status=400)
        if price < 0 or price > 10000:
            return request.make_json_response({'error': 'Price out of range'}, status=400)

        category = (body.get('category') or '').strip()
        valid_categories = dict(request.env['product.template']._fields['rms_menu_category'].selection)
        if category and category not in valid_categories:
            return request.make_json_response({'error': 'Invalid category'}, status=400)

        vals = {
            'name':                name,
            'list_price':          round(price, 2),
            'description_sale':    (body.get('description') or '').strip()[:300],
            'rms_menu_category':   category or False,
            'rms_is_vegan':        bool(body.get('is_vegan')),
            'rms_is_vegetarian':   bool(body.get('is_vegetarian')) or bool(body.get('is_vegan')),
            'rms_is_gluten_free':  bool(body.get('is_gluten_free')),
            'rms_contains_nuts':   bool(body.get('contains_nuts')),
        }

        image_b64 = (body.get('image_base64') or '').strip()
        if image_b64:
            if ',' in image_b64 and image_b64.startswith('data:'):
                image_b64 = image_b64.split(',', 1)[1]
            if len(image_b64) > 11_000_000:
                return request.make_json_response({'error': 'Image is too large (max ~8MB)'}, status=400)
            try:
                vals['image_1920'] = image_b64
            except Exception as e:
                _logger.warning("RMS: failed to set image for product %s: %s", product_id, e)
                return request.make_json_response({'error': 'Could not process that image file'}, status=400)

        product.write(vals)

        return request.make_json_response({
            'product_id':     product.id,
            'name':           product.name,
            'price':          product.list_price,
            'category':       product.rms_menu_category,
            'category_label': valid_categories.get(product.rms_menu_category, '—'),
            'image_url':      f'/web/image/product.template/{product.id}/image_128?unique={int(datetime.utcnow().timestamp())}',
        })

    @http.route('/rms/admin/stock/delete', type='http', auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def stock_delete_item(self, **kwargs):
        """
        Removes a menu item entirely. If the product has order history
        (can't be hard-deleted in Odoo without breaking those records),
        falls back to archiving it instead — it disappears from the
        menu and this stock list either way, so the effect looks the
        same to staff, but past orders/receipts referencing it stay intact.
        """
        if not self._stock_auth_ok():
            return self._stock_forbidden()
        body       = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        product_id = int(body.get('product_id', 0))
        if not product_id:
            return request.make_json_response({'error': 'Missing product_id'}, status=400)

        product = request.env['product.template'].sudo().browse(product_id)
        if not product.exists() or not product.rms_is_menu_item:
            return request.make_json_response({'error': 'Not found'}, status=404)

        try:
            product.unlink()
            mode = 'deleted'
        except Exception:
            # Likely referenced by existing sale order lines — archive
            # instead so old receipts/order history don't break.
            product.write({'active': False, 'rms_is_available': False})
            mode = 'archived'

        return request.make_json_response({
            'product_id': product_id,
            'mode':       mode,
        })

    @http.route('/rms/admin/stock/create', type='http', auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def stock_create_item(self, **kwargs):
        """
        Lets non-technical staff add a brand-new menu item from the
        stock page — name, price, category, description, dietary
        flags, spice level, and an optional image. Advanced fields
        (protein grouping, curry sub-type) are intentionally left out
        of this form; those are structural choices best made in the
        Odoo backend by someone setting up a multi-protein dish.
        """
        if not self._stock_auth_ok():
            return self._stock_forbidden()
        body = json.loads(request.httprequest.get_data(as_text=True) or '{}')

        name = (body.get('name') or '').strip()
        if not name:
            return request.make_json_response({'error': 'Name is required'}, status=400)

        try:
            price = float(body.get('price', 0))
        except (ValueError, TypeError):
            return request.make_json_response({'error': 'Invalid price'}, status=400)
        if price < 0 or price > 10000:
            return request.make_json_response({'error': 'Price out of range'}, status=400)

        category = (body.get('category') or '').strip()
        ProductTemplate = request.env['product.template'].sudo()
        valid_categories = dict(ProductTemplate._fields['rms_menu_category'].selection)
        if category and category not in valid_categories:
            return request.make_json_response({'error': 'Invalid category'}, status=400)

        vals = {
            'name':                 name,
            'list_price':           round(price, 2),
            'description_sale':     (body.get('description') or '').strip()[:300],
            'rms_is_menu_item':     True,
            'rms_is_available':     True,
            'rms_menu_category':    category or False,
            'rms_is_vegan':         bool(body.get('is_vegan')),
            'rms_is_vegetarian':    bool(body.get('is_vegetarian')) or bool(body.get('is_vegan')),
            'rms_is_gluten_free':   bool(body.get('is_gluten_free')),
            'rms_contains_nuts':    bool(body.get('contains_nuts')),
            'type':                 'consu',
        }

        image_b64 = body.get('image_base64')
        if image_b64:
            # Strip a data: URL prefix if the browser sent one
            if ',' in image_b64 and image_b64.strip().startswith('data:'):
                image_b64 = image_b64.split(',', 1)[1]
            vals['image_1920'] = image_b64

        product = ProductTemplate.create(vals)
        # Publish + assign to the matching website category, same as
        # the bulk setup helper used on install
        product._rms_setup_ecommerce()

        return request.make_json_response({
            'product_id':   product.id,
            'name':         product.name,
            'price':        product.list_price,
            'category':     product.rms_menu_category,
            'category_label': valid_categories.get(product.rms_menu_category, ''),
            'image_url':    f'/web/image/product.template/{product.id}/image_128',
        })

    # ------------------------------------------------------------------ #
    # Kitchen dashboard                                                    #
    # ------------------------------------------------------------------ #

    def _kitchen_auth_ok(self):
        """
        Kitchen access requires:
        1. A real logged-in Odoo user (not a public/portal visitor), AND
        2. Membership in the 'Kitchen Staff' group (or being an admin).
        Replaces the old shared-PIN system, which let anyone with the
        PIN see customer names/phones/emails from an incognito tab.
        """
        user = request.env.user
        if user._is_public():
            return False
        return user.has_group('rms_website_menu.group_rms_kitchen_staff') or \
               user.has_group('base.group_system')

    def _print_agent_device(self):
        authorization = request.httprequest.headers.get('Authorization', '')
        if not authorization.startswith('Bearer '):
            return request.env['rms.print.device']
        token = authorization[7:].strip()
        if not token:
            return request.env['rms.print.device']
        token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
        return request.env['rms.print.device'].sudo().search([
            ('token_hash', '=', token_hash),
            ('active', '=', True),
        ], limit=1)

    def _order_to_dict(self, o):
        items = []
        for l in o.order_line:
            if not l.product_id or getattr(l, 'is_delivery', False):
                continue
            note = ''
            if l.name:
                for line in l.name.splitlines():
                    if line.strip().lower().startswith('spice:'):
                        note = line.strip()
                        break
            items.append({
                'name': l.product_id.name,
                'qty':  int(l.product_uom_qty),
                'note': note,
            })
        if not items:
            return None

        delivery_type = o.rms_delivery_type
        if not delivery_type:
            note_lower = (o.note or '').lower()
            delivery_type = 'delivery' if 'delivery' in note_lower else 'pickup'

        delivery_address = o.rms_delivery_address or ''
        if not delivery_address and delivery_type == 'delivery' and o.note:
            for line in o.note.splitlines():
                if 'delivery to:' in line.lower():
                    delivery_address = line.split(':', 1)[-1].strip()
                    break

        partner = o.partner_id

        # Scheduled time — convert from UTC to restaurant TZ for display
        scheduled_time = None
        scheduled_ts   = None
        if o.rms_scheduled_time:
            sched_local = pytz.utc.localize(o.rms_scheduled_time).astimezone(RESTAURANT_TZ)
            scheduled_time = sched_local.strftime('%a %b %-d · %I:%M %p')
            scheduled_ts   = int(pytz.utc.localize(o.rms_scheduled_time).timestamp() * 1000)

        # Catering flag — true if any line item is a catering product
        is_catering = any(
            getattr(l.product_id.product_tmpl_id, 'rms_is_catering_item', False)
            for l in o.order_line if l.product_id
        )

        return {
            'id':               o.id,
            'name':             o.name,
            'status':           o.rms_kitchen_status or 'new',
            'delivery_type':    delivery_type,
            'delivery_address': delivery_address,
            'time':             pytz.utc.localize(o.create_date).astimezone(RESTAURANT_TZ).strftime('%I:%M %p'),
            'date':             pytz.utc.localize(o.create_date).astimezone(RESTAURANT_TZ).strftime('%b %d'),
            'scheduled_time':   scheduled_time,
            'scheduled_ts':     scheduled_ts,
            'is_catering':      is_catering,
            'items':            items,
            'special_request':  o.rms_special_request or '',
            'customer_name':    partner.name or '',
            'customer_phone':   partner.phone or '',
            'customer_email':   partner.email or '',
        }

    def _kitchen_orders_data(self, include_done=False, days=1):
        cutoff = datetime.utcnow() - timedelta(days=days)
        domain = [
            ('website_id', '!=', False),
            ('create_date', '>=', cutoff),
            # Only confirmed (paid) orders — state='sale' is set by Odoo
            # only after successful payment, never on cart add or checkout save
            ('state', '=', 'sale'),
            ('rms_delivery_type', 'in', ('pickup', 'delivery')),
            # Exclude future scheduled orders — they live in the Scheduled tab
            '|',
            ('rms_scheduled_time', '=', False),
            ('rms_scheduled_time', '<=', datetime.utcnow()),
        ]
        if not include_done:
            domain.append(('rms_kitchen_status', 'in', ('new', 'preparing', 'ready', False)))
        orders = request.env['sale.order'].sudo().search(domain, order='create_date asc')
        return [d for d in (self._order_to_dict(o) for o in orders) if d]

    def _kitchen_scheduled_data(self):
        """Scheduled orders: rms_scheduled_time set, in the future, not yet done.
        Once the scheduled time passes, the order belongs to the Live tab only —
        otherwise it lingers here too and promoteScheduledOrders() on the
        frontend keeps re-firing (re-alerting/re-printing) every poll."""
        domain = [
            ('website_id', '!=', False),
            ('rms_scheduled_time', '!=', False),
            ('rms_scheduled_time', '>', datetime.utcnow()),
            ('rms_delivery_type', 'in', ('pickup', 'delivery')),
            ('state', '=', 'sale'),
            ('rms_kitchen_status', 'not in', ('done',)),
        ]
        orders = request.env['sale.order'].sudo().search(domain, order='rms_scheduled_time asc')
        return [d for d in (self._order_to_dict(o) for o in orders) if d]

    def _reservation_description_lines(self, description):
        text = html.unescape(re.sub(r'<[^>]+>', '\n', description or ''))
        return [line.strip() for line in text.splitlines() if line.strip()]

    def _reservation_to_dict(self, event):
        lines = self._reservation_description_lines(event.description)
        details = {
            'occasion': '',
            'headcount': '',
            'contact_name': '',
            'contact_phone': '',
            'contact_email': '',
            'notes': '',
            'time_zone': '',
            'end_time': '',
        }
        for line in lines:
            label, sep, value = line.partition(':')
            if not sep:
                continue
            key = label.strip().lower()
            value = value.strip()
            if key == 'occasion':
                details['occasion'] = value
            elif key == 'head count':
                details['headcount'] = value
            elif key == 'contact':
                parts = [part.strip() for part in value.split('|')]
                details['contact_name'] = parts[0] if len(parts) > 0 else ''
                details['contact_phone'] = parts[1] if len(parts) > 1 else ''
                details['contact_email'] = parts[2] if len(parts) > 2 else ''
            elif key == 'details':
                details['notes'] = value
            elif key == 'time zone':
                details['time_zone'] = value
            elif key == 'end time':
                details['end_time'] = value

        customer_partner = event.partner_ids[:1]
        if details['time_zone']:
            start_utc = pytz.utc.localize(event.start)
            stop_utc = pytz.utc.localize(event.stop) if event.stop else None
            start_local = start_utc.astimezone(RESTAURANT_TZ)
            stop_local = stop_utc.astimezone(RESTAURANT_TZ) if stop_utc else None
        else:
            start_local = RESTAURANT_TZ.localize(event.start)
            stop_local = RESTAURANT_TZ.localize(event.stop) if event.stop else None
            start_utc = start_local.astimezone(pytz.utc)

        if not details['occasion']:
            name = event.name or ''
            if name.startswith('[Reservation]') and '—' in name:
                details['occasion'] = name.split(']', 1)[-1].split('—', 1)[0].strip()
        customer_name = details['contact_name'] or customer_partner.name or ''
        customer_phone = details['contact_phone'] or customer_partner.phone or customer_partner.mobile or ''
        customer_email = details['contact_email'] or customer_partner.email or ''

        now_local = datetime.now(tz=RESTAURANT_TZ)
        if start_local.date() == now_local.date():
            timing = 'today'
        elif start_local < now_local:
            timing = 'past'
        else:
            timing = 'upcoming'

        return {
            'id': event.id,
            'name': event.name or 'Reservation',
            'occasion': details['occasion'] or 'Reservation',
            'headcount': details['headcount'],
            'customer_name': customer_name,
            'customer_phone': customer_phone,
            'customer_email': customer_email,
            'details': details['notes'],
            'date': start_local.strftime('%a %b %-d'),
            'time': start_local.strftime('%I:%M %p'),
            'end_time': stop_local.strftime('%I:%M %p') if details['end_time'] and stop_local else '',
            'start_ts': int(start_utc.timestamp() * 1000),
            'timing': timing,
        }

    def _kitchen_reservations_data(self, days=30):
        today_local = datetime.now(tz=RESTAURANT_TZ).date()
        start_local = RESTAURANT_TZ.localize(
            datetime(today_local.year, today_local.month, today_local.day)
        ) - timedelta(days=1)
        end_local = start_local + timedelta(days=days + 1)
        events = request.env['calendar.event'].sudo().search([
            ('name', 'ilike', '[Reservation]'),
            ('start', '>=', start_local.astimezone(pytz.utc).replace(tzinfo=None)),
            ('start', '<=', end_local.astimezone(pytz.utc).replace(tzinfo=None)),
        ], order='start asc')
        return [self._reservation_to_dict(event) for event in events]

    def _kitchen_stats_data(self):
        """
        Summary numbers for the dashboard header. All derived from existing
        fields — no new model fields needed.
        'avg_wait_minutes' is time-since-placed for active orders, not true
        prep time (status transitions aren't timestamped), but it's an
        honest proxy with the data we have.
        """
        now_utc = datetime.utcnow()
        today_local = datetime.now(tz=RESTAURANT_TZ).date()
        midnight_local = RESTAURANT_TZ.localize(
            datetime(today_local.year, today_local.month, today_local.day)
        )
        midnight_utc = midnight_local.astimezone(pytz.utc).replace(tzinfo=None)

        SaleOrder = request.env['sale.order'].sudo()

        active_orders = SaleOrder.search([
            ('website_id', '!=', False),
            ('state', '=', 'sale'),
            ('create_date', '>=', midnight_utc),
            ('rms_kitchen_status', 'in', ('new', 'preparing', 'ready', False)),
        ])
        today_count = SaleOrder.search_count([
            ('website_id', '!=', False),
            # Only paid/confirmed orders count as "Orders Today" — 'draft'
            # is an unconfirmed cart (including abandoned checkouts), and
            # must not be counted here. Matches the state filter used by
            # the reports controller and everywhere else on this dashboard.
            ('state', 'in', ('sale', 'done')),
            ('create_date', '>=', midnight_utc),
        ])
        ready_count = len(active_orders.filtered(lambda o: o.rms_kitchen_status == 'ready'))

        if active_orders:
            total_minutes = sum(
                (now_utc - o.create_date).total_seconds() / 60.0 for o in active_orders
            )
            avg_wait = round(total_minutes / len(active_orders))
        else:
            avg_wait = 0

        return {
            'active_count':     len(active_orders),
            'today_count':      today_count,
            'avg_wait_minutes': avg_wait,
            'ready_count':      ready_count,
        }

    @http.route('/rms/kitchen', type='http', auth='user', website=True, sitemap=False)
    def kitchen_page(self, **kwargs):
        """
        auth='user' means Odoo's own login wall handles unauthenticated
        visitors automatically (redirect to /web/login?redirect=/rms/kitchen).
        Once logged in, we additionally check group membership so only
        staff explicitly added to 'Kitchen Staff' (or admins) get in.
        """
        if not self._kitchen_auth_ok():
            return request.render('rms_website_menu.kitchen_access_denied', {})
        return request.render('rms_website_menu.kitchen_dashboard', {
            'can_manage_hours': request.env.user.has_group('base.group_system'),
            'can_manage_print_agents': request.env.user.has_group('base.group_system'),
            'can_manage_stock': self._stock_auth_ok(),
            'can_view_reports': (
                request.env.user.has_group('base.group_system') or
                request.env.user.has_group('rms_website_menu.group_rms_reporting_manager')
            ),
        })

    @http.route('/rms/kitchen/logout', type='http', auth='user', website=True, sitemap=False)
    def kitchen_logout(self, **kwargs):
        return request.redirect('/web/session/logout?redirect=/rms/kitchen')

    @http.route('/rms/kitchen/orders', type='http', auth='user', website=True, sitemap=False)
    def kitchen_orders(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        include_done = kwargs.get('history') == '1'
        days = 7 if include_done else 1
        result = {'orders': self._kitchen_orders_data(include_done, days)}
        if not include_done:
            result['stats'] = self._kitchen_stats_data()
        return request.make_json_response(result)

    @http.route('/rms/kitchen/orders/scheduled', type='http', auth='user', website=True, sitemap=False)
    def kitchen_orders_scheduled(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        return request.make_json_response({'orders': self._kitchen_scheduled_data()})

    @http.route('/rms/kitchen/orders/catering', type='http', auth='user', website=True, sitemap=False)
    def kitchen_orders_catering(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        domain = [
            ('website_id', '!=', False),
            ('state', '=', 'sale'),
            ('rms_delivery_type', 'in', ('pickup', 'delivery')),
            ('rms_kitchen_status', 'not in', ('done',)),
            ('order_line.product_id.product_tmpl_id.rms_is_catering_item', '=', True),
        ]
        orders = request.env['sale.order'].sudo().search(domain, order='rms_scheduled_time asc, create_date asc')
        data = [d for d in (self._order_to_dict(o) for o in orders) if d]
        return request.make_json_response({'orders': data})

    @http.route('/rms/kitchen/reservations', type='http', auth='user', website=True, sitemap=False)
    def kitchen_reservations(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        return request.make_json_response({'reservations': self._kitchen_reservations_data()})

    @http.route('/rms/kitchen/ping', type='http', auth='user', website=True, sitemap=False)
    def kitchen_ping(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        return request.make_json_response({
            'ok': True,
            'service': 'odoo',
        })

    @http.route('/rms/kitchen/hours', type='http', auth='user', website=True, sitemap=False)
    def kitchen_hours(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        return request.make_json_response({
            'days': _business_hours_payload(),
            'timezone': str(RESTAURANT_TZ),
            'can_edit': request.env.user.has_group('base.group_system'),
        })

    @http.route('/rms/kitchen/hours/save', type='http', auth='user', website=True,
                methods=['POST'], csrf=False, sitemap=False)
    def kitchen_hours_save(self, **kwargs):
        if not request.env.user.has_group('base.group_system'):
            return request.make_json_response({'error': 'admin_required'}, status=403)

        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
            submitted = body.get('days')
            if not isinstance(submitted, list) or len(submitted) != 7:
                raise ValueError('All seven days are required')

            saved = {}
            seen = set()
            for day in submitted:
                weekday = int(day.get('weekday'))
                if weekday not in range(7) or weekday in seen:
                    raise ValueError('Invalid weekday')
                seen.add(weekday)
                enabled = bool(day.get('enabled'))
                entry = {'enabled': enabled}
                if enabled:
                    open_value = str(day.get('open') or '')
                    close_value = str(day.get('close') or '')
                    open_parts = _parse_hhmm(open_value)
                    close_parts = _parse_hhmm(close_value)
                    if close_parts <= open_parts:
                        raise ValueError(
                            f"{BUSINESS_DAY_NAMES[weekday]} closing time must be after opening time"
                        )
                    entry.update({'open': open_value, 'close': close_value})
                saved[str(weekday)] = entry
        except (AttributeError, TypeError, ValueError, json.JSONDecodeError) as exc:
            return request.make_json_response({'error': str(exc)}, status=400)

        request.env['ir.config_parameter'].sudo().set_param(
            BUSINESS_HOURS_PARAM, json.dumps(saved)
        )
        return request.make_json_response({
            'ok': True,
            'days': _business_hours_payload(),
            'timezone': str(RESTAURANT_TZ),
        })

    @http.route('/rms/kitchen/print-agent/pairing-code', type='http', auth='user',
                website=True, methods=['POST'], csrf=False, sitemap=False)
    def kitchen_print_agent_pairing_code(self, **kwargs):
        if not request.env.user.has_group('base.group_system'):
            return request.make_json_response({'error': 'admin_required'}, status=403)
        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        except json.JSONDecodeError:
            body = {}
        name = str(body.get('name') or 'Kitchen Printer').strip()[:80]
        code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(8))
        expires_at = datetime.utcnow() + timedelta(minutes=10)
        device = request.env['rms.print.device'].sudo().create({
            'name': name,
            'pairing_code_hash': hashlib.sha256(code.encode('utf-8')).hexdigest(),
            'pairing_expires_at': expires_at,
        })
        return request.make_json_response({
            'ok': True,
            'device_id': device.id,
            'name': device.name,
            'pairing_code': code,
            'expires_at': expires_at.isoformat() + 'Z',
        })

    @http.route('/rms/kitchen/print/jobs/manual', type='http', auth='user',
                website=True, methods=['POST'], csrf=False, sitemap=False)
    def kitchen_manual_print_job(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
            order_id = int(body.get('order_id'))
        except (TypeError, ValueError, json.JSONDecodeError):
            return request.make_json_response({'error': 'invalid_order_id'}, status=400)
        order = request.env['sale.order'].sudo().search([
            ('id', '=', order_id),
            ('website_id', '!=', False),
            ('state', 'in', ('sale', 'done')),
        ], limit=1)
        if not order:
            return request.make_json_response({'error': 'order_not_found'}, status=404)
        job = order._rms_enqueue_print_job(source='manual')
        if not job:
            return request.make_json_response({'error': 'job_not_created'}, status=400)
        return request.make_json_response({
            'ok': True,
            'job_id': job.id,
            'job_uuid': job.name,
            'state': job.state,
        })

    @http.route('/rms/kitchen/print/jobs/status', type='http', auth='user',
                website=True, sitemap=False)
    def kitchen_print_jobs_status(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        Job = request.env['rms.print.job'].sudo()
        Device = request.env['rms.print.device'].sudo()
        recent = Job.search([], order='create_date desc', limit=20)
        return request.make_json_response({
            'ok': True,
            'can_manage_devices': request.env.user.has_group('base.group_system'),
            'counts': {
                state: Job.search_count([('state', '=', state)])
                for state in ('pending', 'claimed', 'sent', 'failed')
            },
            'devices': [{
                'id': device.id,
                'name': device.name,
                'active': device.active,
                'paired': bool(device.token_hash),
                'last_seen_at': device.last_seen_at.isoformat() + 'Z' if device.last_seen_at else None,
                'last_error': device.last_error or '',
            } for device in Device.search([], order='create_date desc')],
            'jobs': [{
                'id': job.id,
                'uuid': job.name,
                'order_name': job.order_id.name,
                'source': job.source,
                'state': job.state,
                'attempts': job.attempts,
                'last_error': job.last_error or '',
                'available_at': job.available_at.isoformat() + 'Z' if job.available_at else None,
                'sent_at': job.sent_at.isoformat() + 'Z' if job.sent_at else None,
            } for job in recent],
        })

    @http.route('/rms/kitchen/print-agent/<int:device_id>/revoke', type='http',
                auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def kitchen_print_agent_revoke(self, device_id, **kwargs):
        if not request.env.user.has_group('base.group_system'):
            return request.make_json_response({'error': 'admin_required'}, status=403)
        device = request.env['rms.print.device'].sudo().browse(device_id)
        if not device.exists():
            return request.make_json_response({'error': 'device_not_found'}, status=404)
        now = fields.Datetime.now()
        request.env['rms.print.job'].sudo().search([
            ('state', '=', 'claimed'),
            ('claimed_by_id', '=', device.id),
        ]).write({
            'state': 'pending',
            'claimed_by_id': False,
            'claim_token': False,
            'claimed_until': False,
            'available_at': now,
        })
        device.write({
            'active': False,
            'token_hash': False,
            'pairing_code_hash': False,
            'pairing_expires_at': False,
        })
        return request.make_json_response({'ok': True})

    @http.route('/rms/print-agent/pair', type='http', auth='public',
                methods=['POST'], csrf=False, sitemap=False)
    def print_agent_pair(self, **kwargs):
        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
            code = str(body.get('pairing_code') or '').strip().upper()
        except json.JSONDecodeError:
            code = ''
        if not code:
            return request.make_json_response({'error': 'pairing_code_required'}, status=400)
        code_hash = hashlib.sha256(code.encode('utf-8')).hexdigest()
        device = request.env['rms.print.device'].sudo().search([
            ('pairing_code_hash', '=', code_hash),
            ('pairing_expires_at', '>', fields.Datetime.now()),
            ('active', '=', True),
        ], limit=1)
        if not device:
            return request.make_json_response({'error': 'invalid_or_expired_pairing_code'}, status=401)
        token = secrets.token_urlsafe(32)
        device.write({
            'token_hash': hashlib.sha256(token.encode('utf-8')).hexdigest(),
            'pairing_code_hash': False,
            'pairing_expires_at': False,
            'paired_at': fields.Datetime.now(),
            'last_seen_at': fields.Datetime.now(),
            'last_error': False,
        })
        return request.make_json_response({
            'ok': True,
            'device_id': device.id,
            'device_name': device.name,
            'device_token': token,
        })

    @http.route('/rms/print-agent/jobs/next', type='http', auth='public',
                methods=['POST'], csrf=False, sitemap=False)
    def print_agent_next_job(self, **kwargs):
        device = self._print_agent_device()
        if not device:
            return request.make_json_response({'error': 'invalid_device_token'}, status=401)
        now = fields.Datetime.now()
        Job = request.env['rms.print.job'].sudo()
        Job.search([
            ('state', '=', 'claimed'),
            ('claimed_until', '<', now),
        ]).write({
            'state': 'pending',
            'claimed_by_id': False,
            'claim_token': False,
            'claimed_until': False,
        })
        request.env.cr.execute("""
            SELECT id
              FROM rms_print_job
             WHERE state IN ('pending', 'failed')
               AND available_at <= %s
               AND attempts < max_attempts
             ORDER BY available_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
        """, [now])
        row = request.env.cr.fetchone()
        device.write({'last_seen_at': now})
        if not row:
            return request.make_json_response({'ok': True, 'job': None})
        job = Job.browse(row[0])
        claim_token = secrets.token_urlsafe(24)
        job.write({
            'state': 'claimed',
            'claimed_by_id': device.id,
            'claim_token': claim_token,
            'claimed_until': now + timedelta(seconds=90),
            'attempts': job.attempts + 1,
        })
        return request.make_json_response({
            'ok': True,
            'job': {
                'id': job.id,
                'uuid': job.name,
                'source': job.source,
                'order_id': job.order_id.id,
                'claim_token': claim_token,
                'payload': job.payload,
                'attempt': job.attempts,
                'max_attempts': job.max_attempts,
            },
        })

    @http.route('/rms/print-agent/jobs/<int:job_id>/result', type='http', auth='public',
                methods=['POST'], csrf=False, sitemap=False)
    def print_agent_job_result(self, job_id, **kwargs):
        device = self._print_agent_device()
        if not device:
            return request.make_json_response({'error': 'invalid_device_token'}, status=401)
        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        except json.JSONDecodeError:
            body = {}
        job = request.env['rms.print.job'].sudo().browse(job_id)
        if not job.exists() or job.state != 'claimed' or job.claimed_by_id != device:
            return request.make_json_response({'error': 'job_not_claimed_by_device'}, status=409)
        if not secrets.compare_digest(str(body.get('claim_token') or ''), job.claim_token or ''):
            return request.make_json_response({'error': 'invalid_claim_token'}, status=409)

        result = body.get('result')
        now = fields.Datetime.now()
        if result == 'sent':
            job.write({
                'state': 'sent',
                'sent_at': now,
                'last_error': False,
                'claim_token': False,
                'claimed_until': False,
            })
            device.write({'last_seen_at': now, 'last_error': False})
        elif result == 'failed':
            error = str(body.get('error') or 'Unknown printer error')[:2000]
            retry_delay = min(5 * (2 ** max(job.attempts - 1, 0)), 300)
            job.write({
                'state': 'failed',
                'available_at': now + timedelta(seconds=retry_delay),
                'last_error': error,
                'claim_token': False,
                'claimed_until': False,
            })
            device.write({'last_seen_at': now, 'last_error': error})
        else:
            return request.make_json_response({'error': 'invalid_result'}, status=400)
        return request.make_json_response({
            'ok': True,
            'job_id': job.id,
            'state': job.state,
            'attempts': job.attempts,
        })

    # -------------------------------------------------------------- #
    # Raw socket (port 9100) printing — server-side proxy            #
    # Browsers can't open raw TCP sockets, so the kitchen JS POSTs   #
    # the order to this route, and Odoo itself opens the socket to  #
    # the Epson on port 9100 and sends ESC/POS bytes directly.       #
    # -------------------------------------------------------------- #
    def _build_escpos_ticket(self, order):
        """Build raw ESC/POS byte sequence for an 80mm thermal ticket."""
        ESC = b'\x1b'
        GS  = b'\x1d'

        INIT          = ESC + b'@'
        ALIGN_CENTER  = ESC + b'a' + b'\x01'
        ALIGN_LEFT    = ESC + b'a' + b'\x00'
        BOLD_ON       = ESC + b'E' + b'\x01'
        BOLD_OFF      = ESC + b'E' + b'\x00'
        DOUBLE_ON     = GS  + b'!' + b'\x11'   # double width + height
        DOUBLE_OFF    = GS  + b'!' + b'\x00'
        FEED_3        = b'\n\n\n'
        CUT           = GS  + b'V' + b'\x42' + b'\x00'   # partial cut with feed

        def line(text=''):
            return (text + '\n').encode('utf-8', errors='replace')

        def money(value):
            try:
                return f"${float(value):.2f}"
            except (TypeError, ValueError):
                return None

        def wrap(text, width=32):
            words = str(text or '').strip().split()
            rows = []
            for word in words:
                if not rows or len(rows[-1] + ' ' + word) > width:
                    rows.append(word)
                else:
                    rows[-1] += ' ' + word
            return rows or ['']

        buf = bytearray()
        buf += INIT
        def restaurant_header():
            return (ALIGN_CENTER + DOUBLE_ON + BOLD_ON +
                    line('Timur Indian') + line('Cuisine') +
                    line('1386 9th Ave SF') + DOUBLE_OFF + BOLD_OFF)

        buf += restaurant_header()

        now_str = datetime.utcnow().replace(tzinfo=pytz.utc).astimezone(RESTAURANT_TZ).strftime('%b %d, %I:%M %p')
        buf += line(now_str)
        buf += line('-' * 32)

        buf += DOUBLE_ON + BOLD_ON
        buf += line(order.get('name', ''))
        buf += DOUBLE_OFF + BOLD_OFF

        is_delivery = order.get('delivery_type') == 'delivery'
        buf += BOLD_ON
        buf += line('DELIVERY' if is_delivery else 'PICKUP')
        buf += BOLD_OFF

        if order.get('is_catering'):
            buf += line('*** CATERING ORDER ***')
        if order.get('scheduled_time'):
            buf += line(f"SCHEDULED: {order['scheduled_time']}")

        buf += line('-' * 32)
        buf += ALIGN_LEFT
        buf += BOLD_ON
        buf += line('ORDER ITEMS')
        buf += BOLD_OFF

        for item in order.get('items', []):
            qty  = str(item.get('qty', 1))
            buf += DOUBLE_ON + BOLD_ON
            for row in wrap(f"{qty}x {item.get('name', '')}", 16):
                buf += line(row)
            buf += DOUBLE_OFF + BOLD_OFF
            if item.get('note'):
                buf += BOLD_ON
                for row in wrap(f"*** {item['note']}"):
                    buf += line(row)
                buf += BOLD_OFF
            buf += line()

        buf += line('-' * 32)
        buf += BOLD_ON
        buf += line('CUSTOMER')
        buf += BOLD_OFF
        if order.get('customer_name'):
            buf += line(f"Name:  {order['customer_name']}")
        if order.get('customer_phone'):
            buf += line(f"Phone: {order['customer_phone']}")
        if is_delivery and order.get('delivery_address'):
            buf += line(f"Addr:  {order['delivery_address']}")
        if order.get('special_request'):
            buf += line('-' * 32)
            buf += BOLD_ON
            buf += line('SPECIAL REQUEST')
            buf += BOLD_OFF
            buf += line(order['special_request'])

        buf += line('-' * 32)
        buf += ALIGN_CENTER
        buf += BOLD_ON
        buf += line('KITCHEN COPY')
        buf += BOLD_OFF
        buf += line(('DELIVERY' if is_delivery else 'PICKUP') + ' | ' +
                     ('CATERING' if order.get('is_catering') else 'REGULAR'))
        buf += FEED_3
        buf += CUT

        # Print a separately cut counter bill from the same queued job.
        # The preparation copy above intentionally contains no prices.
        buf += INIT
        buf += restaurant_header()
        buf += line('-' * 32)
        buf += DOUBLE_ON + BOLD_ON
        buf += line('COUNTER')
        buf += line('COPY')
        buf += DOUBLE_OFF + BOLD_OFF
        buf += line(now_str)
        buf += line('-' * 32)
        buf += DOUBLE_ON + BOLD_ON
        buf += line(order.get('name', ''))
        buf += DOUBLE_OFF + BOLD_OFF
        buf += line('DELIVERY' if is_delivery else 'PICKUP')
        buf += line('-' * 32)
        buf += ALIGN_LEFT

        for item in order.get('items', []):
            qty = str(item.get('qty', 1))
            buf += DOUBLE_ON + BOLD_ON
            for row in wrap(f"{qty}x {item.get('name', '')}", 16):
                buf += line(row)
            buf += DOUBLE_OFF + BOLD_OFF
            item_total = money(item.get('subtotal'))
            if item_total:
                unit_price = money(item.get('unit_price'))
                detail = f"{qty} @ {unit_price}" if float(qty) > 1 and unit_price else ''
                buf += line(f"{detail:<24}{item_total:>8}")
            buf += line()

        total = money(order.get('amount_total'))
        if total:
            buf += line('-' * 32)
            subtotal = money(order.get('amount_untaxed'))
            tax = money(order.get('amount_tax'))
            if subtotal:
                buf += line(f"{'SUBTOTAL':<24}{subtotal:>8}")
            if tax:
                buf += line(f"{'TAX':<24}{tax:>8}")
            buf += DOUBLE_ON + BOLD_ON
            buf += line(f"TOTAL {total}")
            buf += DOUBLE_OFF + BOLD_OFF
        else:
            buf += BOLD_ON
            buf += line('PRICE NOT AVAILABLE')
            buf += BOLD_OFF

        buf += line('-' * 32)
        if order.get('customer_name'):
            buf += line(f"Name:  {order['customer_name']}")
        if order.get('customer_phone'):
            buf += line(f"Phone: {order['customer_phone']}")
        buf += ALIGN_CENTER + BOLD_ON
        buf += line('COUNTER COPY')
        buf += BOLD_OFF + FEED_3 + CUT
        return bytes(buf)

    @http.route('/rms/kitchen/print', type='json', auth='user', methods=['POST'], csrf=False)
    def kitchen_print_raw(self, **kwargs):
        """
        Receives order data + printer IP from the kitchen JS, opens a
        raw TCP socket to the Epson on port 9100, and sends ESC/POS
        bytes directly. Bypasses ePOS XML entirely since the printer
        only has RAW(9100) printing enabled and reachable.
        """
        if not self._kitchen_auth_ok():
            return {'success': False, 'error': 'unauthorized'}

        printer_ip = kwargs.get('printer_ip', '').strip()
        order_data = kwargs.get('order', {})

        if not printer_ip:
            return {'success': False, 'error': 'no_printer_ip'}

        try:
            ticket_bytes = self._build_escpos_ticket(order_data)
            with socket.create_connection((printer_ip, 9100), timeout=5) as sock:
                sock.sendall(ticket_bytes)
            return {'success': True}
        except (socket.timeout, ConnectionRefusedError, OSError) as e:
            _logger.warning("Raw print to %s:9100 failed: %s", printer_ip, e)
            return {'success': False, 'error': str(e)}

    @http.route('/rms/kitchen/order/accept', type='http', auth='user', website=True,
                methods=['POST'], csrf=False, sitemap=False)
    def kitchen_order_accept(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        body = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        order_id = int(body.get('order_id', 0))
        if not order_id:
            return request.make_json_response({'error': 'invalid'}, status=400)
        order = request.env['sale.order'].sudo().browse(order_id)
        if not order.exists() or order.state not in ('sale', 'done'):
            return request.make_json_response({'error': 'not_found'}, status=404)
        if not order.rms_accepted_at:
            order.write({'rms_accepted_at': fields.Datetime.now()})
        return request.make_json_response({
            'ok': True,
            'order_id': order.id,
            'accepted_at': self._tracking_timestamp(order.rms_accepted_at),
        })

    @http.route('/rms/kitchen/order/status', type='http', auth='user', website=True, methods=['POST'], csrf=False, sitemap=False)
    def kitchen_order_status(self, **kwargs):
        if not self._kitchen_auth_ok():
            return request.make_json_response({'error': 'unauthorized'}, status=401)
        body     = json.loads(request.httprequest.get_data(as_text=True) or '{}')
        order_id = int(body.get('order_id', 0))
        status   = body.get('status', '')
        if not order_id or status not in ('new', 'preparing', 'ready', 'done'):
            return request.make_json_response({'error': 'invalid'}, status=400)
        order = request.env['sale.order'].sudo().browse(order_id)
        if not order.exists():
            return request.make_json_response({'error': 'not found'}, status=404)
        order.rms_kitchen_status = status
        return request.make_json_response({'ok': True, 'order_id': order_id, 'status': status})

    # ------------------------------------------------------------------ #
    # Catering                                                             #
    # ------------------------------------------------------------------ #

    @http.route('/catering', type='http', auth='public', website=True, sitemap=True)
    def catering_page(self, **kwargs):
        ProductTemplate = request.env['product.template'].sudo()
        products = ProductTemplate.search(
            [('rms_is_catering_item', '=', True)],
            order='rms_catering_category, name',
        )
        cat_field  = ProductTemplate._fields['rms_catering_category']
        cat_labels = dict(cat_field.selection)
        cat_map = {key: [] for key in CATERING_CATEGORY_ORDER}
        for p in products:
            key = p.rms_catering_category or 'starters'
            if key in cat_map:
                cat_map[key].append(p)
        grouped = [
            {'key': key, 'label': cat_labels.get(key, key), 'items': cat_map[key]}
            for key in CATERING_CATEGORY_ORDER if cat_map[key]
        ]
        is_open, closed_msg = _is_open_now()
        return request.render('rms_website_menu.catering_page', {
            'grouped_products': grouped,
            'spice_categories': {'tandoor', 'veg_mains', 'chicken', 'seafood'},
            'is_open':          is_open,
            'closed_msg':       closed_msg,
        })

# ------------------------------------------------------------------ #
# Native /shop/* routes are NOT overridden here.                     #
# All off-hours enforcement happens in rms_checkout_save above:       #
#   - ASAP orders blocked → must schedule                             #
#   - Scheduled orders redirect straight to /shop/payment             #
# The /rms/checkout page is the single gatekeeper.                   #
# ------------------------------------------------------------------ #