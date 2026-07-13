{
    'name': 'RMS Base - Timur Restaurant',
    'version': '19.0.1.0.0',
    'category': 'Restaurant',
    'summary': 'Base module for Timur Indian Restaurant digital ordering system',
    'description': """
        Foundation module for the Timur Restaurant Management System.
        Extends product.template with restaurant-specific fields and loads
        the complete Timur menu with categories, items, pricing, and dietary flags.
    """,
    'author': 'The AI Foundry',
    'website': 'https://theaifoundry.com',
    'license': 'LGPL-3',
    'depends': [
        'base',
        'product',
    ],
    'data': [
        'security/ir.model.access.csv',
        'data/product_data.xml',
        'views/rms_product_views.xml',
    ],
    'installable': True,
    'application': True,
    'auto_install': False,
}
