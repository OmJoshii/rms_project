from odoo import models


class ResPartnerFooter(models.Model):
    _inherit = 'res.partner'

    def action_add_my_orders_menu(self):
        """
        Called from the 'Add My Orders Nav Link' server action in the
        Timur Restaurant backend menu. Adds a 'My Orders' item to the
        top navigation on every website, pointing to /rms/my-orders.
        Safe to run more than once — skips websites that already have it.
        """
        WebsiteMenu = self.env['website.menu'].sudo()
        added = []
        for website in self.env['website'].sudo().search([]):
            if WebsiteMenu.search([
                ('url', '=', '/rms/my-orders'),
                ('website_id', '=', website.id),
            ], limit=1):
                continue
            root_menu = WebsiteMenu.search([
                ('parent_id', '=', False),
                ('website_id', '=', website.id),
            ], limit=1)
            if not root_menu:
                continue
            WebsiteMenu.create({
                'name': 'My Orders',
                'url': '/rms/my-orders',
                'parent_id': root_menu.id,
                'website_id': website.id,
                'sequence': 95,
            })
            added.append(website.name)

        if added:
            message = f"Added 'My Orders' menu to: {', '.join(added)}"
            msg_type = 'success'
        else:
            message = "Every website already has the 'My Orders' menu — nothing to add."
            msg_type = 'warning'

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'My Orders Menu',
                'message': message,
                'type': msg_type,
                'sticky': False,
            },
        }

    def action_add_menu_link(self):
        """
        Called from the 'Add Menu Nav Link' server action in the
        Timur Restaurant backend menu. Ensures every website has a
        standalone 'Menu' nav item pointing to /menu/all (the flat,
        no-categories browse-everything page) — distinct from
        'Order Online', which points to /menu (the full category view).
        Identified by name. If a 'Menu' link already exists (e.g. from
        an earlier version of this action that pointed it at /menu),
        its URL is corrected to /menu/all rather than skipped.
        Safe to run more than once.
        """
        WebsiteMenu = self.env['website.menu'].sudo()
        added   = []
        fixed   = []
        for website in self.env['website'].sudo().search([]):
            existing = WebsiteMenu.search([
                ('name', '=', 'Menu'),
                ('website_id', '=', website.id),
            ], limit=1)
            if existing:
                if existing.url != '/menu/all':
                    existing.write({'url': '/menu/all'})
                    fixed.append(website.name)
                continue
            root_menu = WebsiteMenu.search([
                ('parent_id', '=', False),
                ('website_id', '=', website.id),
            ], limit=1)
            if not root_menu:
                continue
            WebsiteMenu.create({
                'name': 'Menu',
                'url': '/menu/all',
                'parent_id': root_menu.id,
                'website_id': website.id,
                'sequence': 51,
            })
            added.append(website.name)

        parts = []
        if added: parts.append(f"Added to: {', '.join(added)}")
        if fixed: parts.append(f"Fixed URL on: {', '.join(fixed)}")
        if parts:
            message = " · ".join(parts)
            msg_type = 'success'
        else:
            message = "Every website already has a correct 'Menu' link — nothing to do."
            msg_type = 'warning'

        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'Menu Nav Link',
                'message': message,
                'type': msg_type,
                'sticky': False,
            },
        }