import csv
import io
from collections import defaultdict
from datetime import datetime, timedelta

import pytz

from odoo import http
from odoo.http import request


REPORT_GROUP = 'rms_website_menu.group_rms_reporting_manager'
MAX_REPORT_DAYS = 366


def _can_view_reports():
    user = request.env.user
    return user.has_group('base.group_system') or user.has_group(REPORT_GROUP)


def _restaurant_timezone():
    company = request.website.company_id or request.env.company
    tz_name = company.partner_id.tz or 'America/Los_Angeles'
    try:
        return pytz.timezone(tz_name)
    except pytz.UnknownTimeZoneError:
        return pytz.UTC


def _parse_period(start_value=None, end_value=None):
    timezone = _restaurant_timezone()
    today = datetime.now(timezone).date()
    try:
        end_date = datetime.strptime(end_value, '%Y-%m-%d').date() if end_value else today
        start_date = (
            datetime.strptime(start_value, '%Y-%m-%d').date()
            if start_value else end_date - timedelta(days=29)
        )
    except (TypeError, ValueError) as exc:
        raise ValueError('Dates must use YYYY-MM-DD format') from exc
    if start_date > end_date:
        raise ValueError('Start date must be on or before end date')
    day_count = (end_date - start_date).days + 1
    if day_count > MAX_REPORT_DAYS:
        raise ValueError(f'Report range cannot exceed {MAX_REPORT_DAYS} days')

    start_local = timezone.localize(datetime.combine(start_date, datetime.min.time()))
    end_local = timezone.localize(
        datetime.combine(end_date + timedelta(days=1), datetime.min.time())
    )
    return {
        'start': start_date,
        'end': end_date,
        'days': day_count,
        'timezone': timezone,
        'start_utc': start_local.astimezone(pytz.UTC).replace(tzinfo=None),
        'end_utc': end_local.astimezone(pytz.UTC).replace(tzinfo=None),
    }


def _order_domain(period, states=('sale', 'done')):
    return [
        ('website_id', '=', request.website.id),
        ('state', 'in', states),
        ('date_order', '>=', period['start_utc']),
        ('date_order', '<', period['end_utc']),
    ]


def _local_datetime(value, timezone):
    if not value:
        return None
    return pytz.UTC.localize(value).astimezone(timezone)


def _menu_lines(order):
    lines = []
    for line in order.order_line:
        if line.display_type or getattr(line, 'is_delivery', False):
            continue
        template = line.product_id.product_tmpl_id
        if template.rms_is_menu_item or getattr(template, 'rms_is_catering_item', False):
            lines.append(line)
    return lines


def _is_catering(order):
    return any(
        getattr(line.product_id.product_tmpl_id, 'rms_is_catering_item', False)
        for line in _menu_lines(order)
    )


def _percent_change(current, previous):
    if not previous:
        return None if not current else 100.0
    return round(((current - previous) / previous) * 100, 1)


def _summarize_orders(orders):
    gross = sum(orders.mapped('amount_total'))
    net = sum(orders.mapped('amount_untaxed'))
    tax = sum(orders.mapped('amount_tax'))
    item_count = sum(
        sum(float(line.product_uom_qty) for line in _menu_lines(order))
        for order in orders
    )
    order_count = len(orders)
    return {
        'gross_sales': round(gross, 2),
        'net_sales': round(net, 2),
        'tax': round(tax, 2),
        'orders': order_count,
        'average_order_value': round(gross / order_count, 2) if order_count else 0,
        'items': round(item_count, 2),
        'items_per_order': round(item_count / order_count, 1) if order_count else 0,
    }


class RmsReportsController(http.Controller):

    @http.route('/rms/admin/reports', type='http', auth='user', website=True, sitemap=False)
    def reports_page(self, **kwargs):
        if not _can_view_reports():
            return request.render('rms_website_menu.reports_access_denied')
        return request.render('rms_website_menu.online_sales_reports', {
            'can_view_kitchen': (
                request.env.user.has_group('base.group_system') or
                request.env.user.has_group('rms_website_menu.group_rms_kitchen_staff')
            ),
        })

    @http.route('/rms/admin/reports/data', type='http', auth='user', methods=['GET'],
                website=True, sitemap=False)
    def reports_data(self, start=None, end=None, **kwargs):
        if not _can_view_reports():
            return request.make_json_response({'error': 'forbidden'}, status=403)
        try:
            period = _parse_period(start, end)
        except ValueError as exc:
            return request.make_json_response({'error': str(exc)}, status=400)

        SaleOrder = request.env['sale.order'].sudo()
        orders = SaleOrder.search(_order_domain(period), order='date_order asc')
        current = _summarize_orders(orders)

        previous_end = period['start'] - timedelta(days=1)
        previous_start = previous_end - timedelta(days=period['days'] - 1)
        previous_period = _parse_period(
            previous_start.isoformat(), previous_end.isoformat()
        )
        previous = _summarize_orders(
            SaleOrder.search(_order_domain(previous_period), order='date_order asc')
        )
        current['comparison'] = {
            'gross_sales': _percent_change(current['gross_sales'], previous['gross_sales']),
            'orders': _percent_change(current['orders'], previous['orders']),
            'average_order_value': _percent_change(
                current['average_order_value'], previous['average_order_value']
            ),
        }

        trend = {}
        cursor = period['start']
        while cursor <= period['end']:
            trend[cursor.isoformat()] = {'sales': 0, 'orders': 0}
            cursor += timedelta(days=1)
        hourly = [{'hour': hour, 'sales': 0, 'orders': 0} for hour in range(24)]
        fulfillment = {
            'pickup': {'orders': 0, 'sales': 0},
            'delivery': {'orders': 0, 'sales': 0},
            'other': {'orders': 0, 'sales': 0},
        }
        order_types = {
            'regular': {'orders': 0, 'sales': 0},
            'catering': {'orders': 0, 'sales': 0},
            'scheduled': {'orders': 0, 'sales': 0},
        }
        status_counts = {'new': 0, 'preparing': 0, 'ready': 0, 'done': 0}
        product_totals = defaultdict(lambda: {'name': '', 'quantity': 0, 'revenue': 0})
        category_totals = defaultdict(lambda: {'quantity': 0, 'revenue': 0})
        customer_totals = defaultdict(lambda: {'name': '', 'orders': 0, 'revenue': 0})
        prep_minutes = []
        completion_minutes = []

        ProductTemplate = request.env['product.template']
        menu_categories = dict(ProductTemplate._fields['rms_menu_category'].selection)
        catering_categories = dict(ProductTemplate._fields['rms_catering_category'].selection)

        for order in orders:
            local_order_time = _local_datetime(order.date_order, period['timezone'])
            day_key = local_order_time.date().isoformat()
            trend[day_key]['sales'] += order.amount_total
            trend[day_key]['orders'] += 1
            hourly[local_order_time.hour]['sales'] += order.amount_total
            hourly[local_order_time.hour]['orders'] += 1

            fulfillment_key = order.rms_delivery_type or 'other'
            if fulfillment_key not in fulfillment:
                fulfillment_key = 'other'
            fulfillment[fulfillment_key]['orders'] += 1
            fulfillment[fulfillment_key]['sales'] += order.amount_total

            catering = _is_catering(order)
            type_key = 'catering' if catering else 'regular'
            order_types[type_key]['orders'] += 1
            order_types[type_key]['sales'] += order.amount_total
            if order.rms_scheduled_time:
                order_types['scheduled']['orders'] += 1
                order_types['scheduled']['sales'] += order.amount_total

            status_counts[order.rms_kitchen_status or 'new'] += 1
            if order.rms_preparing_at and order.rms_ready_at:
                minutes = (order.rms_ready_at - order.rms_preparing_at).total_seconds() / 60
                if minutes >= 0:
                    prep_minutes.append(minutes)
            if order.rms_new_at and order.rms_done_at:
                minutes = (order.rms_done_at - order.rms_new_at).total_seconds() / 60
                if minutes >= 0:
                    completion_minutes.append(minutes)

            commercial_partner = order.partner_id.commercial_partner_id
            customer = customer_totals[commercial_partner.id]
            customer['name'] = commercial_partner.name or 'Guest'
            customer['orders'] += 1
            customer['revenue'] += order.amount_total

            for line in _menu_lines(order):
                template = line.product_id.product_tmpl_id
                product = product_totals[template.id]
                product['name'] = template.name
                if template.rms_protein_label:
                    product['name'] = f'{template.name} - {template.rms_protein_label}'
                product['quantity'] += float(line.product_uom_qty)
                product['revenue'] += line.price_subtotal

                category_key = template.rms_menu_category or template.rms_catering_category or 'other'
                category_label = (
                    menu_categories.get(category_key) or
                    catering_categories.get(category_key) or
                    'Other'
                )
                category = category_totals[category_label]
                category['quantity'] += float(line.product_uom_qty)
                category['revenue'] += line.price_subtotal

        customer_ids = list(customer_totals)
        lifetime_counts = defaultdict(int)
        first_order_at = {}
        if customer_ids:
            historical_orders = SaleOrder.search([
                ('website_id', '=', request.website.id),
                ('state', 'in', ('sale', 'done')),
                ('partner_id', 'child_of', customer_ids),
                ('date_order', '<', period['end_utc']),
            ], order='date_order asc')
            for order in historical_orders:
                customer_id = order.partner_id.commercial_partner_id.id
                if customer_id not in customer_totals:
                    continue
                lifetime_counts[customer_id] += 1
                first_order_at.setdefault(customer_id, order.date_order)

        new_customers = 0
        repeat_customers = 0
        for customer_id in customer_ids:
            first_at = first_order_at.get(customer_id)
            if first_at and period['start_utc'] <= first_at < period['end_utc']:
                new_customers += 1
            if lifetime_counts[customer_id] > 1:
                repeat_customers += 1

        cancelled_count = SaleOrder.search_count(_order_domain(period, states=('cancel',)))
        print_jobs = request.env['rms.print.job'].sudo().search([('order_id', 'in', orders.ids)])
        print_total = len(print_jobs)
        print_sent = len(print_jobs.filtered(lambda job: job.state == 'sent'))
        print_failed = len(print_jobs.filtered(lambda job: job.state == 'failed'))

        def rounded_rows(values, sort_key='revenue', reverse=True, limit=10):
            rows = list(values)
            rows.sort(key=lambda row: row[sort_key], reverse=reverse)
            return [{
                **row,
                'quantity': round(row.get('quantity', 0), 2),
                'revenue': round(row.get('revenue', 0), 2),
            } for row in rows[:limit]]

        top_customers = sorted(
            customer_totals.values(), key=lambda customer: customer['revenue'], reverse=True
        )[:10]
        currency = request.website.company_id.currency_id
        response = {
            'period': {
                'start': period['start'].isoformat(),
                'end': period['end'].isoformat(),
                'days': period['days'],
                'timezone': str(period['timezone']),
            },
            'currency': {
                'code': currency.name,
                'symbol': currency.symbol,
                'position': currency.position,
            },
            'kpis': current,
            'trend': [{
                'date': day,
                'sales': round(values['sales'], 2),
                'orders': values['orders'],
            } for day, values in trend.items()],
            'hourly': [{
                **row,
                'sales': round(row['sales'], 2),
            } for row in hourly],
            'fulfillment': [{
                'key': key,
                'label': key.title(),
                'orders': values['orders'],
                'sales': round(values['sales'], 2),
            } for key, values in fulfillment.items()],
            'order_types': [{
                'key': key,
                'label': key.title(),
                'orders': values['orders'],
                'sales': round(values['sales'], 2),
            } for key, values in order_types.items()],
            'products': {
                'top': rounded_rows(product_totals.values()),
                'lowest': rounded_rows(product_totals.values(), reverse=False),
                'categories': rounded_rows([
                    {'name': name, **values} for name, values in category_totals.items()
                ]),
            },
            'customers': {
                'unique': len(customer_ids),
                'new': new_customers,
                'repeat': repeat_customers,
                'repeat_rate': round(repeat_customers / len(customer_ids) * 100, 1)
                if customer_ids else 0,
                'top': [{
                    **customer,
                    'revenue': round(customer['revenue'], 2),
                } for customer in top_customers],
            },
            'operations': {
                'statuses': status_counts,
                'scheduled_orders': order_types['scheduled']['orders'],
                'cancelled_orders': cancelled_count,
                'average_prep_minutes': round(sum(prep_minutes) / len(prep_minutes), 1)
                if prep_minutes else None,
                'average_completion_minutes': round(
                    sum(completion_minutes) / len(completion_minutes), 1
                ) if completion_minutes else None,
                'timed_orders': len(prep_minutes),
                'print_jobs': print_total,
                'print_sent': print_sent,
                'print_failed': print_failed,
            },
        }
        return request.make_json_response(response)

    @http.route('/rms/admin/reports/orders', type='http', auth='user', methods=['GET'],
                website=True, sitemap=False)
    def reports_orders(self, start=None, end=None, page='1', search='', fulfillment='',
                       kitchen_status='', **kwargs):
        if not _can_view_reports():
            return request.make_json_response({'error': 'forbidden'}, status=403)
        try:
            period = _parse_period(start, end)
            page_number = max(1, int(page))
        except (TypeError, ValueError) as exc:
            return request.make_json_response({'error': str(exc)}, status=400)

        domain = _order_domain(period)
        if search:
            domain += ['|', ('name', 'ilike', search.strip()),
                       ('partner_id.name', 'ilike', search.strip())]
        if fulfillment in ('pickup', 'delivery'):
            domain.append(('rms_delivery_type', '=', fulfillment))
        if kitchen_status == 'new':
            domain.append(('rms_kitchen_status', 'in', ('new', False)))
        elif kitchen_status in ('preparing', 'ready', 'done'):
            domain.append(('rms_kitchen_status', '=', kitchen_status))

        SaleOrder = request.env['sale.order'].sudo()
        page_size = 25
        total = SaleOrder.search_count(domain)
        orders = SaleOrder.search(
            domain, order='date_order desc',
            offset=(page_number - 1) * page_size, limit=page_size,
        )
        rows = []
        for order in orders:
            local_time = _local_datetime(order.date_order, period['timezone'])
            lines = _menu_lines(order)
            rows.append({
                'id': order.id,
                'name': order.name,
                'date': local_time.isoformat(),
                'customer': order.partner_id.commercial_partner_id.name or 'Guest',
                'fulfillment': order.rms_delivery_type or 'other',
                'kitchen_status': order.rms_kitchen_status or 'new',
                'scheduled': bool(order.rms_scheduled_time),
                'catering': _is_catering(order),
                'items': round(sum(float(line.product_uom_qty) for line in lines), 2),
                'total': round(order.amount_total, 2),
            })
        return request.make_json_response({
            'orders': rows,
            'page': page_number,
            'page_size': page_size,
            'total': total,
            'pages': max(1, (total + page_size - 1) // page_size),
        })

    @http.route('/rms/admin/reports/export.csv', type='http', auth='user', methods=['GET'],
                website=True, sitemap=False)
    def reports_export(self, start=None, end=None, **kwargs):
        if not _can_view_reports():
            return request.make_response('Forbidden', status=403)
        try:
            period = _parse_period(start, end)
        except ValueError as exc:
            return request.make_response(str(exc), status=400)

        orders = request.env['sale.order'].sudo().search(
            _order_domain(period), order='date_order asc'
        )
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            'Order', 'Date', 'Customer', 'Fulfillment', 'Kitchen Status',
            'Scheduled', 'Catering', 'Items', 'Sales Before Tax', 'Tax', 'Total',
        ])

        def csv_text(value):
            text = str(value or '')
            return f"'{text}" if text[:1] in ('=', '+', '-', '@') else text

        for order in orders:
            local_time = _local_datetime(order.date_order, period['timezone'])
            lines = _menu_lines(order)
            writer.writerow([
                csv_text(order.name),
                local_time.strftime('%Y-%m-%d %H:%M:%S'),
                csv_text(order.partner_id.commercial_partner_id.name or 'Guest'),
                order.rms_delivery_type or 'other',
                order.rms_kitchen_status or 'new',
                'Yes' if order.rms_scheduled_time else 'No',
                'Yes' if _is_catering(order) else 'No',
                round(sum(float(line.product_uom_qty) for line in lines), 2),
                order.amount_untaxed,
                order.amount_tax,
                order.amount_total,
            ])
        filename = f"online-sales-{period['start']}-{period['end']}.csv"
        return request.make_response(output.getvalue(), headers=[
            ('Content-Type', 'text/csv; charset=utf-8'),
            ('Content-Disposition', f'attachment; filename="{filename}"'),
        ])
