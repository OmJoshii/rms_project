from odoo import models, fields, api


class RmsProductTemplate(models.Model):
    _inherit = 'product.template'

    rms_is_menu_item = fields.Boolean(
        string='Menu Item',
        default=False,
    )
    rms_is_available = fields.Boolean(
        string='Available',
        default=True,
    )
    rms_is_featured = fields.Boolean(
        string='Featured',
        default=False,
    )
    rms_prep_time = fields.Integer(
        string='Prep Time (min)',
        default=15,
    )
    rms_spice_level = fields.Selection(
        selection=[
            ('none',      'No Spice'),
            ('mild',      'Mild'),
            ('medium',    'Medium'),
            ('hot',       'Hot'),
            ('extra_hot', 'Extra Hot'),
        ],
        string='Spice Level',
        default='medium',
    )
    rms_is_vegan = fields.Boolean(string='Vegan', default=False)
    rms_is_vegetarian = fields.Boolean(string='Vegetarian', default=False)
    rms_is_gluten_free = fields.Boolean(string='Gluten Free', default=False)
    rms_contains_nuts = fields.Boolean(string='Contains Nuts', default=False)

    # Groups multiple products into one card on the frontend
    # e.g. all Korma variants share rms_group_key = 'korma'
    # Solo items leave this empty
    rms_group_key = fields.Char(
        string='Group Key',
        help='Products sharing the same group key are shown as one card with protein buttons. '
             'Leave empty for solo items.',
        index=True,
    )

    # The label shown on the protein button e.g. "Chicken", "Lamb", "Vegetable"
    rms_protein_label = fields.Char(
        string='Protein Label',
        help='Button label for this variant e.g. Chicken, Lamb, Vegetable. '
             'Only needed when Group Key is set.',
    )

    # Sort order within a group — Vegetable first, then Paneer, Chicken, Lamb, Seafood
    rms_group_sort = fields.Integer(
        string='Group Sort',
        default=10,
        help='Controls the order of protein buttons within a group. Lower = first.',
    )

    rms_curry_type = fields.Selection(
        selection=[
            ('korma',         'Korma Curry'),
            ('kerala',        'Kerala Coconut Curry'),
            ('ginger_garlic', 'Ginger Garlic Curry'),
            ('tikka_masala',  'Tikka Masala Curry'),
            ('kashmiri',      'Kashmiri Style Curry'),
            ('vindaloo',      'Vindaloo Curry'),
            ('saag',          'Saag Curry'),
            ('kadai',         'Kadai Curry'),
            ('signature',     'Signature Dishes'),
        ],
        string='Curry Type',
        help='Subcategory within Main Entrees. Only set for main_entrees items.',
    )

    rms_menu_category = fields.Selection(
        selection=[
            ('small_plates',     'Small Plates'),
            ('soups_greens',     'Soups and Greens'),
            ('from_kathmandu',   'From Kathmandu'),
            ('from_south_india', 'From South of India'),
            ('tandoor',          'Tandoor Specials'),
            ('vegan_curry',      'Vegan Curry Selection'),
            ('main_entrees',     'Main Entrees'),
            ('bread',            'Bread Selection'),
            ('gluten_free_bread','Gluten-Free Breads'),
            ('rice',             'Rice Selection'),
            ('biryani',          'Biryani'),
            ('accompaniments',   'Accompaniments'),
            ('sweet_tooth',      'Sweet Tooth'),
            ('beverages',        'Beverages and Mocktails'),
            ('beer',             'Beer Selection'),
            ('white_wine',       'White Wine & Champagne'),
            ('red_wine',         'Red Wine'),
            ('sake',             'Local Sake'),
            ('cocktails',        'Classic Cocktails'),
        ],
        string='Menu Category',
    )

    @api.onchange('rms_is_vegan')
    def _onchange_rms_is_vegan(self):
        if self.rms_is_vegan:
            self.rms_is_vegetarian = True

    @api.model
    def _rms_setup_ecommerce(self):
        """
        Publishes products and assigns them to website categories.
        Called from website_categories.xml on install/upgrade.
        """
        products = self.search([('rms_is_menu_item', '=', True)])

        # Publish all menu items
        vals = {}
        if 'website_published' in self._fields:
            vals['website_published'] = True
        if 'is_published' in self._fields:
            vals['is_published'] = True
        if vals:
            products.write(vals)

        # Assign to public categories if the model exists
        if 'public_categ_ids' in self._fields:
            for product in products:
                if not product.rms_menu_category:
                    continue

                xml_id = f"rms_website_menu.pub_categ_{product.rms_menu_category}"
                category = self.env.ref(xml_id, raise_if_not_found=False)
                if category:
                    product.public_categ_ids = [(4, category.id)]