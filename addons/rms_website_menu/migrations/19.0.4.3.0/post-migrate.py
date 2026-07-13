from odoo.addons.rms_website_menu.hooks import configure_menu_sales_tax


def migrate(cr, version):
    from odoo import api, SUPERUSER_ID

    configure_menu_sales_tax(api.Environment(cr, SUPERUSER_ID, {}))
