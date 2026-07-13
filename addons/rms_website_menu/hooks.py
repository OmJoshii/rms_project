SAN_FRANCISCO_SALES_TAX_NAME = 'San Francisco Sales Tax 8.625%'
SAN_FRANCISCO_SALES_TAX_RATE = 8.625


def configure_menu_sales_tax(env):
    """Create the restaurant sales tax and apply it to taxable menu items."""
    companies = env['res.company'].search([])
    menu_items = env['product.template'].with_context(active_test=False).search([
        ('rms_is_menu_item', '=', True),
    ])

    for company in companies:
        tax = env['account.tax'].search([
            ('name', '=', SAN_FRANCISCO_SALES_TAX_NAME),
            ('type_tax_use', '=', 'sale'),
            ('company_id', '=', company.id),
        ], limit=1)
        if not tax:
            tax = env['account.tax'].create({
                'name': SAN_FRANCISCO_SALES_TAX_NAME,
                'description': 'SF Sales Tax 8.625%',
                'type_tax_use': 'sale',
                'amount_type': 'percent',
                'amount': SAN_FRANCISCO_SALES_TAX_RATE,
                # Odoo 19 computes ``price_include`` from this override.
                'price_include_override': 'tax_excluded',
                'company_id': company.id,
                'active': True,
            })

        company_items = menu_items.with_company(company).filtered(
            lambda product: not product.taxes_id.filtered(
                lambda product_tax: product_tax.type_tax_use == 'sale'
            )
        )
        company_items.write({'taxes_id': [(4, tax.id)]})

        # Product taxes are copied to the sale line when it is added to the
        # cart. Refresh tax-less, unpaid cart lines as well, so carts created
        # before this configuration change immediately show the correct tax.
        open_lines = env['sale.order.line'].search([
            ('company_id', '=', company.id),
            ('order_id.state', 'in', ('draft', 'sent')),
            ('product_template_id', 'in', company_items.ids),
            ('tax_ids', '=', False),
            ('display_type', '=', False),
        ])
        open_lines.write({'tax_ids': [(6, 0, [tax.id])]})


def post_init_hook(env):
    """Publish all available menu items and add nav items ('Order Online' → /menu, 'Menu' → /menu/all, 'My Orders' → /rms/my-orders)."""
    ## Publish every available menu item so ecommerce can add them to cart
    menu_items = env['product.template'].search([
        ('rms_is_menu_item', '=', True),
        ('rms_is_available', '=', True),
    ])
    menu_items.write({'is_published': True})
    configure_menu_sales_tax(env)

    WebsiteMenu = env['website.menu']
    for website in env['website'].search([]):
        root_menu = WebsiteMenu.search(
            [('parent_id', '=', False), ('website_id', '=', website.id)],
            limit=1,
        )
        if not root_menu:
            continue

        if not WebsiteMenu.search([('url', '=', '/menu'), ('website_id', '=', website.id)], limit=1):
            WebsiteMenu.create({
                'name': 'Order Online',
                'url': '/menu',
                'parent_id': root_menu.id,
                'website_id': website.id,
                'sequence': 50,
            })

        # Separate 'Menu' link — points to the flat, no-categories
        # browse-everything page, distinct from 'Order Online' (/menu).
        if not WebsiteMenu.search([('name', '=', 'Menu'), ('website_id', '=', website.id)], limit=1):
            WebsiteMenu.create({
                'name': 'Menu',
                'url': '/menu/all',
                'parent_id': root_menu.id,
                'website_id': website.id,
                'sequence': 51,
            })

        if not WebsiteMenu.search([('url', '=', '/rms/my-orders'), ('website_id', '=', website.id)], limit=1):
            WebsiteMenu.create({
                'name': 'My Orders',
                'url': '/rms/my-orders',
                'parent_id': root_menu.id,
                'website_id': website.id,
                'sequence': 95,
            })
