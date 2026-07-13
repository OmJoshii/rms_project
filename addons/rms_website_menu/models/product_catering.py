from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    rms_is_catering_item = fields.Boolean(
        string='Is Catering Item',
        default=False,
        index=True,
    )
    rms_catering_category = fields.Selection([
        ('starters',    'Starters & Snacks'),
        ('tandoor',     'Tandoor Specials'),
        ('veg_mains',   'Vegetarian Mains'),
        ('chicken',     'Chicken Mains'),
        ('seafood',     'Seafood'),
        ('rice_noodles','Rice & Noodles'),
        ('breads',      'Breads'),
        ('desserts',    'Desserts'),
    ], string='Catering Category')
