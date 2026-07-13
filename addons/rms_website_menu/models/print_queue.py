import uuid
from datetime import datetime

import pytz

from odoo import fields, models


RESTAURANT_TZ = pytz.timezone('America/Los_Angeles')


class RmsPrintDevice(models.Model):
    _name = 'rms.print.device'
    _description = 'RMS Print Relay Device'
    _order = 'create_date desc'

    name = fields.Char(required=True)
    active = fields.Boolean(default=True)
    token_hash = fields.Char(index=True, copy=False)
    pairing_code_hash = fields.Char(index=True, copy=False)
    pairing_expires_at = fields.Datetime(copy=False)
    paired_at = fields.Datetime(copy=False)
    last_seen_at = fields.Datetime(copy=False)
    last_error = fields.Text(copy=False)


class RmsPrintJob(models.Model):
    _name = 'rms.print.job'
    _description = 'RMS Kitchen Print Job'
    _order = 'create_date desc'

    name = fields.Char(
        string='Job ID', required=True, copy=False, index=True,
        default=lambda self: str(uuid.uuid4()),
    )
    order_id = fields.Many2one(
        'sale.order', required=True, index=True, ondelete='cascade',
    )
    source = fields.Selection(
        [('automatic', 'Automatic'), ('manual', 'Manual')],
        required=True, default='automatic', index=True,
    )
    state = fields.Selection(
        [
            ('pending', 'Pending'),
            ('claimed', 'Claimed'),
            ('sent', 'Sent'),
            ('failed', 'Failed'),
            ('cancelled', 'Cancelled'),
        ],
        required=True, default='pending', index=True,
    )
    payload = fields.Json(required=True)
    available_at = fields.Datetime(required=True, default=fields.Datetime.now, index=True)
    claimed_by_id = fields.Many2one('rms.print.device', copy=False, ondelete='set null')
    claim_token = fields.Char(copy=False, index=True)
    claimed_until = fields.Datetime(copy=False, index=True)
    attempts = fields.Integer(default=0, copy=False)
    max_attempts = fields.Integer(default=5)
    last_error = fields.Text(copy=False)
    sent_at = fields.Datetime(copy=False)

    _job_id_unique = models.Constraint(
        'UNIQUE(name)',
        'Print job IDs must be unique.',
    )


class SaleOrderPrintQueue(models.Model):
    _inherit = 'sale.order'

    def _rms_print_payload(self):
        self.ensure_one()
        items = []
        for line in self.order_line:
            if not line.product_id or getattr(line, 'is_delivery', False):
                continue
            note = ''
            if line.name:
                for description_line in line.name.splitlines():
                    if description_line.strip().lower().startswith('spice:'):
                        note = description_line.strip()
                        break
            items.append({
                'name': line.product_id.name,
                'qty': int(line.product_uom_qty),
                'note': note,
                'unit_price': line.price_unit,
                'subtotal': line.price_subtotal,
            })

        delivery_type = self.rms_delivery_type
        if not delivery_type:
            delivery_type = 'delivery' if 'delivery' in (self.note or '').lower() else 'pickup'

        delivery_address = self.rms_delivery_address or ''
        if not delivery_address and delivery_type == 'delivery' and self.note:
            for note_line in self.note.splitlines():
                if 'delivery to:' in note_line.lower():
                    delivery_address = note_line.split(':', 1)[-1].strip()
                    break

        scheduled_time = None
        if self.rms_scheduled_time:
            scheduled_local = pytz.utc.localize(self.rms_scheduled_time).astimezone(RESTAURANT_TZ)
            scheduled_time = scheduled_local.strftime('%a %b %-d · %I:%M %p')

        created = self.create_date or datetime.utcnow()
        created_local = pytz.utc.localize(created).astimezone(RESTAURANT_TZ)
        partner = self.partner_id
        is_catering = any(
            getattr(line.product_id.product_tmpl_id, 'rms_is_catering_item', False)
            for line in self.order_line if line.product_id
        )

        return {
            'id': self.id,
            'name': self.name,
            'status': self.rms_kitchen_status or 'new',
            'delivery_type': delivery_type,
            'delivery_address': delivery_address,
            'time': created_local.strftime('%I:%M %p'),
            'date': created_local.strftime('%b %d'),
            'scheduled_time': scheduled_time,
            'is_catering': is_catering,
            'items': items,
            'special_request': self.rms_special_request or '',
            'customer_name': partner.name or '',
            'customer_phone': partner.phone or '',
            'customer_email': partner.email or '',
            'amount_untaxed': self.amount_untaxed,
            'amount_tax': self.amount_tax,
            'amount_total': self.amount_total,
        }

    def _rms_enqueue_print_job(self, source='automatic'):
        Job = self.env['rms.print.job'].sudo()
        jobs = self.env['rms.print.job']
        now = fields.Datetime.now()
        for order in self:
            allowed_states = ('sale',) if source == 'automatic' else ('sale', 'done')
            if not order.website_id or order.state not in allowed_states:
                continue
            if source == 'automatic' and Job.search_count([
                ('order_id', '=', order.id),
                ('source', '=', 'automatic'),
                ('state', '!=', 'cancelled'),
            ]):
                continue
            available_at = order.rms_scheduled_time if source == 'automatic' else now
            available_at = available_at or now
            if available_at < now:
                available_at = now
            jobs |= Job.create({
                'order_id': order.id,
                'source': source,
                'payload': order._rms_print_payload(),
                'available_at': available_at,
            })
        return jobs
