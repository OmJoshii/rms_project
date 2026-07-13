'use strict';

class RmsModal {
    constructor() {
        this._currentTemplateId = null;
        this._currentVariantId  = null;
        this._currentName = null;
        this._currentPrice = 0;
        this._qty = 1;
        this._init();
    }

    // ---------------------------------------------------------------- //
    // Public API                                                         //
    // ---------------------------------------------------------------- //

    open(card) {
        const id        = card.dataset.id;
        const variantId = card.dataset.variantId;
        const name      = card.dataset.name;
        const price     = parseFloat(card.dataset.price) || 0;
        const desc      = card.dataset.desc  || '';
        const veg       = card.dataset.veg   === '1';
        const vegan     = card.dataset.vegan === '1';
        const gf        = card.dataset.gf    === '1';
        const nuts      = card.dataset.nuts  === '1';
        const spice     = card.dataset.spice || 'none';

        this._currentTemplateId = id;
        this._currentVariantId  = variantId;
        this._currentName      = name;
        this._currentPrice     = price;
        this._qty = 1;

        document.getElementById('rms-modal-name').textContent  = name;
        document.getElementById('rms-modal-price').textContent = `$${price.toFixed(2)}`;
        document.getElementById('rms-modal-desc').textContent  = desc;
        document.getElementById('rms-modal-qty-val').textContent = '1';

        const img = document.getElementById('rms-modal-img');
        img.src = `/web/image/product.template/${id}/image_1920`;
        img.alt = name;

        document.getElementById('rms-modal-badges').innerHTML = this._buildBadges(vegan, veg, gf, nuts, spice);

        this._updateAddBtn();

        const overlay = document.getElementById('rms-modal-overlay');
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    close() {
        const overlay = document.getElementById('rms-modal-overlay');
        if (!overlay) return;
        overlay.style.display = 'none';
        document.body.style.overflow = '';
        this._currentTemplateId = null;
        this._currentVariantId  = null;
    }

    // ---------------------------------------------------------------- //
    // Private                                                            //
    // ---------------------------------------------------------------- //

    _buildBadges(vegan, veg, gf, nuts, spice) {
        const parts = [];
        if (vegan)  parts.push('<span class="rms-badge rms-badge-vg" title="Vegan">VG</span>');
        else if (veg) parts.push('<span class="rms-badge rms-badge-v" title="Vegetarian">V</span>');
        if (gf)     parts.push('<span class="rms-badge rms-badge-gf" title="Gluten-Free">GF</span>');
        if (nuts)   parts.push('<span class="rms-badge rms-badge-nut" title="Contains Nuts">⚠ Nuts</span>');
        const flames = { mild: '🌶', medium: '🌶🌶', hot: '🌶🌶🌶', extra_hot: '🌶🌶🌶🌶' };
        if (spice !== 'none' && flames[spice]) {
            parts.push(`<span class="rms-spice rms-badge">${flames[spice]}</span>`);
        }
        return parts.join('');
    }

    _updateAddBtn() {
        const btn = document.getElementById('rms-modal-add');
        if (btn) btn.textContent = `Add to Order — $${(this._currentPrice * this._qty).toFixed(2)}`;
    }

    async _addToCart() {
        if (!window.rmsCart || !this._currentVariantId) return;

        const templateId = parseInt(this._currentTemplateId);
        const variantId  = parseInt(this._currentVariantId);
        const qty        = this._qty;

        const btn = document.getElementById('rms-modal-add');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Adding…';
        }

        await window.rmsCart.addToCart(templateId, variantId, qty);

        if (btn) {
            btn.textContent = '✓ Added!';
            btn.classList.add('rms-added');
            setTimeout(() => {
                btn.disabled = false;
                btn.classList.remove('rms-added');
                this._updateAddBtn();
            }, 900);
        }
    }

    _init() {
        document.addEventListener('click', (e) => {
            // Open modal when card body is clicked (not the Add button)
            const card = e.target.closest('.rms-card');
            if (card && !e.target.closest('.rms-add-btn')) {
                this.open(card);
                return;
            }

            if (e.target.id === 'rms-modal-overlay') {
                this.close();
                return;
            }

            if (e.target.closest('.rms-modal-close')) {
                this.close();
                return;
            }

            if (e.target.id === 'rms-modal-dec') {
                if (this._qty > 1) {
                    this._qty--;
                    document.getElementById('rms-modal-qty-val').textContent = this._qty;
                    this._updateAddBtn();
                }
                return;
            }

            if (e.target.id === 'rms-modal-inc') {
                this._qty++;
                document.getElementById('rms-modal-qty-val').textContent = this._qty;
                this._updateAddBtn();
                return;
            }

            if (e.target.id === 'rms-modal-add') {
                this._addToCart();
                return;
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.rmsModal = new RmsModal();
});
