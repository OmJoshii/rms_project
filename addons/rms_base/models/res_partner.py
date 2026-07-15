from odoo import models


class ResPartner(models.Model):
    _inherit = 'res.partner'

    def _get_complete_name(self):
        """Odoo's default complete_name/display_name for a non-company
        contact that has a parent always renders as
        "<parent name>, <own name>" (see res.partner._get_complete_name in
        core). That format is meant for genuine B2B sub-contacts (e.g.
        "Acme Corp, John Doe"), but our checkout addresses are one-off
        delivery/invoice/other addresses generated under the customer's own
        partner record purely so Odoo's portal ownership checks
        (child_of / _can_be_edited_by_current_customer) allow the customer
        to view and edit them. Since the "parent" here is the customer
        themselves, the default format shows the same name twice
        (e.g. "Om, Om"). For these address types we just show the plain
        name instead.
        """
        self.ensure_one()
        if self.type in ('delivery', 'invoice', 'other'):
            return (self.name or '').strip()
        return super()._get_complete_name()
