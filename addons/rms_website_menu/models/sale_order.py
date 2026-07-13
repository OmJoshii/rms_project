from odoo import api, fields, models


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    rms_delivery_type = fields.Selection(
        [('pickup', 'Pickup'), ('delivery', 'Delivery')],
        string='Fulfillment Type',
        default=False,
    )
    rms_delivery_address = fields.Text(
        string='Delivery Address / Notes',
    )
    rms_kitchen_status = fields.Selection(
        [('new', 'New'), ('preparing', 'Preparing'), ('ready', 'Ready'), ('done', 'Done')],
        string='Kitchen Status',
        default=False,
        index=True,
    )
    rms_new_at = fields.Datetime(
        string='Entered Kitchen At', readonly=True, copy=False, index=True,
    )
    rms_accepted_at = fields.Datetime(
        string='Accepted At', readonly=True, copy=False, index=True,
    )
    rms_preparing_at = fields.Datetime(
        string='Preparation Started At', readonly=True, copy=False,
    )
    rms_ready_at = fields.Datetime(
        string='Ready At', readonly=True, copy=False,
    )
    rms_done_at = fields.Datetime(
        string='Completed At', readonly=True, copy=False, index=True,
    )

    def write(self, vals):
        status = vals.get('rms_kitchen_status')
        status_time = fields.Datetime.now()
        timestamp_field = {
            'new': 'rms_new_at',
            'preparing': 'rms_preparing_at',
            'ready': 'rms_ready_at',
            'done': 'rms_done_at',
        }.get(status)
        if timestamp_field:
            vals = dict(vals)
            vals[timestamp_field] = status_time
        result = super().write(vals)
        if status in ('preparing', 'ready', 'done'):
            missing_acceptance = self.filtered(lambda order: not order.rms_accepted_at)
            if missing_acceptance:
                super(SaleOrder, missing_acceptance).write({'rms_accepted_at': status_time})
        # Auto-mark website orders as 'new' when confirmed
        if vals.get('state') == 'sale':
            for order in self:
                if order.website_id and not order.rms_kitchen_status:
                    order.rms_kitchen_status = 'new'
            self._rms_enqueue_print_job(source='automatic')
        elif vals.get('state') == 'cancel':
            self.env['rms.print.job'].sudo().search([
                ('order_id', 'in', self.ids),
                ('state', 'in', ('pending', 'failed')),
            ]).write({'state': 'cancelled'})
        return result

    rms_scheduled_time = fields.Datetime(
        string='Scheduled Order Time',
        help='Customer-requested pickup/delivery time. Empty = ASAP.',
    )
    rms_special_request = fields.Text(
        string='Special Request',
        help='Customer notes for this order — allergies, dietary needs, '
             'spice/salt/sugar preferences, etc. Shown to kitchen staff.',
    )


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    # Odoo 19 recalculates sale-line prices from the product pricelist. Keep
    # the customer-selected gratuity as a first-class line value so that any
    # later cart, carrier, or tax recomputation cannot reset it to $0.
    rms_tip_amount = fields.Monetary(
        string='RMS Tip Amount',
        currency_field='currency_id',
        copy=False,
    )

    @api.depends('product_id', 'product_uom_id', 'product_uom_qty', 'rms_tip_amount')
    def _compute_price_unit(self):
        super()._compute_price_unit()
        for line in self.filtered('rms_tip_amount'):
            line.price_unit = line.rms_tip_amount
            line.technical_price_unit = line.rms_tip_amount
