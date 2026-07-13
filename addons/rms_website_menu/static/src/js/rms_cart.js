"use strict";

class RmsCart {
  constructor() {
    this._init();
    this._loadCart();
  }

  async addToCart(templateId, variantId, qty = 1, spiceLevel = "") {
    const result = await this._rpc("/rms/cart/add", {
      product_id: parseInt(variantId),
      quantity: qty,
      spice_level: spiceLevel,
    });
    this._render(result || { items: [], total: 0, count: 0 });
    this._syncOdooHeaderCount((result || {}).count);
  }

  async setLineQty(lineId, qty) {
    const result = await this._rpc("/rms/cart/update", {
      line_id: parseInt(lineId),
      quantity: parseInt(qty),
    });
    this._render(result || { items: [], total: 0, count: 0 });
    this._syncOdooHeaderCount((result || {}).count);
  }

  async _loadCart() {
    const data = await this._rpc("/rms/cart", {});
    this._render(data || { items: [], total: 0, count: 0 });
    this._syncOdooHeaderCount((data || {}).count);
  }

  _syncOdooHeaderCount(count) {
    if (count == null) return;
    document.querySelectorAll(".my_cart_quantity").forEach((el) => {
      el.textContent = count;
      el.classList.toggle("d-none", count === 0);
    });
  }

  async _rpc(url, params) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params }),
      });
      const data = await resp.json();
      return data.result;
    } catch (err) {
      console.error("RMS cart RPC error:", err);
      return null;
    }
  }

  _itemHtml(item) {
    const noteHtml = item.note
      ? `<span class="rms-ci-note">${this._esc(item.note)}</span>`
      : "";
    return `
            <div class="rms-ci" data-line-id="${item.line_id}">
                <div class="rms-ci-info">
                    <span class="rms-ci-name">${this._esc(item.name)}</span>
                    ${noteHtml}
                    <span class="rms-ci-price">$${item.subtotal.toFixed(2)}</span>
                </div>
                <div class="rms-ci-controls">
                    <button class="rms-qty-btn rms-qty-dec"
                            data-line-id="${item.line_id}"
                            data-qty="${item.qty}">&#8722;</button>
                    <span class="rms-qty-val">${item.qty}</span>
                    <button class="rms-qty-btn rms-qty-inc"
                            data-line-id="${item.line_id}"
                            data-qty="${item.qty}">&#43;</button>
                    <button class="rms-remove-btn" data-line-id="${item.line_id}">&#10005;</button>
                </div>
            </div>`;
  }

  _render({ items, total, count }) {
    const isEmpty = items.length === 0;
    const totalFmt = `$${total.toFixed(2)}`;
    const html = isEmpty
      ? '<p class="rms-cart-empty">Your cart is empty.</p>'
      : items.map((i) => this._itemHtml(i)).join("");

    const set = (id, prop, val) => {
      const el = document.getElementById(id);
      if (el) el[prop] = val;
    };
    const setStyle = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.style.display = val;
    };

    set("rms-cart-items", "innerHTML", html);
    set("rms-cart-total", "textContent", totalFmt);
    set("rms-cart-count", "textContent", count);
    setStyle("rms-cart-footer", isEmpty ? "none" : "block");

    set("rms-drawer-items", "innerHTML", html);
    set("rms-drawer-total", "textContent", totalFmt);
    setStyle("rms-drawer-footer", isEmpty ? "none" : "block");

    const fab = document.getElementById("rms-fab");
    if (fab) fab.style.display = isEmpty ? "none" : "flex";
    set("rms-fab-count", "textContent", count);
    set("rms-fab-total", "textContent", totalFmt);
  }

  _flash(btn) {
    const orig = btn.textContent;
    btn.textContent = "✓ Added";
    btn.classList.add("rms-added");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("rms-added");
    }, 1200);
  }

  _esc(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------- //
  // Protein button selection                                           //
  // For grouped cards, user must pick a protein before adding to cart //
  // ---------------------------------------------------------------- //

  _getSelectedProtein(card) {
    // Returns { variantId, templateId, label } or null
    const active = card.querySelector(".rms-protein-btn.active");
    if (!active) return null;
    return {
      variantId: active.dataset.variantId,
      templateId: active.dataset.templateId,
      label: active.dataset.label,
    };
  }

  _init() {
    document.addEventListener("click", async (e) => {
      // Protein button toggle
      const proteinBtn = e.target.closest(".rms-protein-btn");
      if (proteinBtn) {
        const card = proteinBtn.closest(".rms-card");
        card
          .querySelectorAll(".rms-protein-btn")
          .forEach((b) => b.classList.remove("active"));
        proteinBtn.classList.add("active");

        // Update price
        const priceEl = card.querySelector(".rms-card-price");
        if (priceEl)
          priceEl.textContent = `$${parseFloat(proteinBtn.dataset.price).toFixed(2)}`;

        // Update add button
        const addBtn = card.querySelector(".rms-add-btn");
        if (addBtn) {
          addBtn.dataset.templateId = proteinBtn.dataset.templateId;
          addBtn.dataset.variantId = proteinBtn.dataset.variantId;
          addBtn.dataset.price = proteinBtn.dataset.price;
        }

        // Update badges for selected variant
        const badgesEl = card.querySelector(".rms-badges");
        if (badgesEl) {
          const isVegan = proteinBtn.dataset.vegan === "1";
          const isVeg = proteinBtn.dataset.veg === "1";
          const isGF = proteinBtn.dataset.gf === "1";
          const hasNuts = proteinBtn.dataset.nuts === "1";
          badgesEl.innerHTML = `
                    ${
                      isVegan
                        ? '<span class="rms-badge rms-badge-vg" title="Vegan">VG</span>'
                        : isVeg
                          ? '<span class="rms-badge rms-badge-v" title="Vegetarian">V</span>'
                          : ""
                    }
                    ${isGF ? '<span class="rms-badge rms-badge-gf" title="Gluten-Free">GF</span>' : ""}
                    ${hasNuts ? '<span class="rms-badge rms-badge-nut" title="Contains Nuts">⚠ Nuts</span>' : ""}
                `;
        }

        // Hide error
        const err = card.querySelector(".rms-protein-error");
        if (err) err.classList.add("d-none");
        return;
      }

      // Add to cart
      const addBtn = e.target.closest(".rms-add-btn");
      if (addBtn) {
        e.stopPropagation();
        const card = addBtn.closest(".rms-card");
        const requiresSpice = addBtn.dataset.requiresSpice === "1";
        const isGrouped = card.dataset.grouped === "1";

        // Grouped card — must have protein selected
        if (isGrouped) {
          const protein = this._getSelectedProtein(card);
          if (!protein) {
            const err = card.querySelector(".rms-protein-error");
            if (err) err.classList.remove("d-none");
            return;
          }
        }

        let spiceLevel = "";
        if (requiresSpice) {
          const picker = card.querySelector(".rms-spice-picker");
          const selected =
            picker && picker.querySelector("input[type=radio]:checked");
          const errMsg = picker && picker.querySelector(".rms-spice-error");
          if (!selected) {
            if (errMsg) errMsg.classList.remove("d-none");
            if (picker) picker.classList.add("rms-spice-error-state");
            picker &&
              picker.scrollIntoView({ behavior: "smooth", block: "nearest" });
            return;
          }
          if (errMsg) errMsg.classList.add("d-none");
          if (picker) picker.classList.remove("rms-spice-error-state");
          spiceLevel = selected.value;
        }

        const templateId = addBtn.dataset.templateId;
        const variantId = addBtn.dataset.variantId;
        await this.addToCart(templateId, variantId, 1, spiceLevel);
        this._flash(addBtn);
        return;
      }

      // Qty decrement
      const decBtn = e.target.closest(".rms-qty-dec");
      if (decBtn) {
        await this.setLineQty(
          parseInt(decBtn.dataset.lineId),
          parseInt(decBtn.dataset.qty) - 1,
        );
        return;
      }

      // Qty increment
      const incBtn = e.target.closest(".rms-qty-inc");
      if (incBtn) {
        await this.setLineQty(
          parseInt(incBtn.dataset.lineId),
          parseInt(incBtn.dataset.qty) + 1,
        );
        return;
      }

      // Remove line
      const removeBtn = e.target.closest(".rms-remove-btn");
      if (removeBtn) {
        await this.setLineQty(parseInt(removeBtn.dataset.lineId), 0);
        return;
      }

      if (e.target.closest("#rms-fab")) {
        this._openDrawer();
        return;
      }
      if (
        e.target.closest("#rms-drawer-close") ||
        e.target.closest("#rms-drawer-overlay")
      ) {
        this._closeDrawer();
        return;
      }
    });

    // Category pills — scroll only, never hide other sections
    // Category pills — scroll only, never hide other sections
document.addEventListener("click", (e) => {
    const pill = e.target.closest(".rms-cat-pill");
    if (!pill) return;
    e.preventDefault();
    document
        .querySelectorAll(".rms-cat-pill")
        .forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    const cat = pill.dataset.cat;

    document.querySelectorAll(".rms-section").forEach((s) => {
        s.style.display = "";
    });

    if (cat !== "all") {
        const target = document.getElementById(`cat-${cat}`);
        if (target) {
            const hdr = document.querySelector(
                "header#top, .o_header_standard, nav.navbar",
            );
            const catBar = document.querySelector(".rms-cat-mobile");
            const dietBar = document.querySelector(".rms-diet-bar");
            let offset = 0;
            if (hdr) offset += hdr.offsetHeight;
            if (catBar && getComputedStyle(catBar).position === "sticky")
                offset += catBar.offsetHeight;
            if (dietBar && getComputedStyle(dietBar).position === "sticky")
                offset += dietBar.offsetHeight;
            const top =
                target.getBoundingClientRect().top +
                window.pageYOffset -
                offset -
                8;
            window.scrollTo({ top, behavior: "smooth" });
        }
    }
});

// Category jump dropdown — registered once on page load, not nested
document.addEventListener("click", (e) => {
    const jumpBtn = e.target.closest(".rms-cat-jump-btn");
    if (jumpBtn) {
        const wrapper = jumpBtn.closest(".rms-cat-jump");
        const wasOpen = wrapper.classList.contains("open");
        document
            .querySelectorAll(".rms-cat-jump.open")
            .forEach((w) => w.classList.remove("open"));
        if (!wasOpen) wrapper.classList.add("open");
        return;
    }

    const jumpItem = e.target.closest(".rms-cat-jump-item");
    if (jumpItem) {
        e.preventDefault();
        document
            .querySelectorAll(".rms-cat-jump.open")
            .forEach((w) => w.classList.remove("open"));
        const cat = jumpItem.dataset.cat;
        const target = document.getElementById(`cat-${cat}`);
        if (target) {
            const hdr = document.querySelector(
                "header#top, .o_header_standard, nav.navbar",
            );
            const catBar = document.querySelector(".rms-cat-mobile");
            const dietBar = document.querySelector(".rms-diet-bar");
            let offset = 0;
            if (hdr) offset += hdr.offsetHeight;
            if (catBar && getComputedStyle(catBar).position === "sticky")
                offset += catBar.offsetHeight;
            if (dietBar && getComputedStyle(dietBar).position === "sticky")
                offset += dietBar.offsetHeight;
            const top =
                target.getBoundingClientRect().top +
                window.pageYOffset -
                offset -
                8;
            window.scrollTo({ top, behavior: "smooth" });
        }
        return;
    }

    if (!e.target.closest(".rms-cat-jump")) {
        document
            .querySelectorAll(".rms-cat-jump.open")
            .forEach((w) => w.classList.remove("open"));
    }
});

    // Fulfillment radio
    document.addEventListener("change", (e) => {
      const radio = e.target.closest(
        'input[name="rms_delivery"], input[name="rms_delivery_drawer"]',
      );
      if (!radio) return;
      const isSidebar = radio.name === "rms_delivery";
      const addrDiv = document.getElementById(
        isSidebar ? "rms-delivery-addr" : "rms-drawer-addr",
      );
      if (addrDiv)
        addrDiv.classList.toggle("d-none", radio.value !== "delivery");
    });

    // Dietary filters
    document.addEventListener("click", (e) => {
      const dietBtn = e.target.closest(".rms-diet-btn");
      if (!dietBtn) return;
      document
        .querySelectorAll(".rms-diet-btn")
        .forEach((b) => b.classList.remove("active"));
      dietBtn.classList.add("active");
      const filter = dietBtn.dataset.diet;

      const matches = (ds) => {
        if (filter === "all") return true;
        if (filter === "vegan") return ds.vegan === "1";
        if (filter === "vegetarian") return ds.veg === "1";
        if (filter === "gluten_free") return ds.gf === "1";
        return true;
      };
      document.querySelectorAll(".rms-card").forEach((card) => {
        if (card.classList.contains("rms-card-grouped")) {
          const buttons = card.querySelectorAll(".rms-protein-btn");
          let firstVisible = null;
          buttons.forEach((btn) => {
            const show = matches(btn.dataset);
            btn.style.display = show ? "" : "none";
            if (show && !firstVisible) firstVisible = btn;
          });

          if (!firstVisible) {
            card.style.display = "none";
            return;
          }
          card.style.display = "";

          const activeBtn = card.querySelector(".rms-protein-btn.active");
          if (!activeBtn || activeBtn.style.display === "none") {
            card
              .querySelectorAll(".rms-protein-btn")
              .forEach((b) => b.classList.remove("active"));
            firstVisible.classList.add("active");

            const priceEl = card.querySelector(".rms-card-price");
            if (priceEl)
              priceEl.textContent = `$${parseFloat(firstVisible.dataset.price).toFixed(2)}`;

            const addBtn = card.querySelector(".rms-add-btn");
            if (addBtn) {
              addBtn.dataset.templateId = firstVisible.dataset.templateId;
              addBtn.dataset.variantId = firstVisible.dataset.variantId;
              addBtn.dataset.price = firstVisible.dataset.price;
            }

            const badgesEl = card.querySelector(".rms-badges");
            if (badgesEl) {
              const isVegan = firstVisible.dataset.vegan === "1";
              const isVeg = firstVisible.dataset.veg === "1";
              const isGF = firstVisible.dataset.gf === "1";
              const hasNuts = firstVisible.dataset.nuts === "1";
              badgesEl.innerHTML = `
                            ${
                              isVegan
                                ? '<span class="rms-badge rms-badge-vg" title="Vegan">VG</span>'
                                : isVeg
                                  ? '<span class="rms-badge rms-badge-v" title="Vegetarian">V</span>'
                                  : ""
                            }
                            ${isGF ? '<span class="rms-badge rms-badge-gf" title="Gluten-Free">GF</span>' : ""}
                            ${hasNuts ? '<span class="rms-badge rms-badge-nut" title="Contains Nuts">⚠ Nuts</span>' : ""}
                            `;
            }
          }
        } else {
          card.style.display = matches(card.dataset) ? "" : "none";
        }
      });
      // Hide whole sections when no cards remain visible
      document.querySelectorAll(".rms-section").forEach((section) => {
        const visible = section.querySelectorAll(
          '.rms-card:not([style*="none"])',
        ).length;
        section.style.display = visible === 0 ? "none" : "";
      });
    });
  }

  async _saveDelivery(context) {
    const isSidebar = context === "sidebar";
    const radioName = isSidebar ? "rms_delivery" : "rms_delivery_drawer";
    const addrId = isSidebar ? "rms-addr-input" : "rms-drawer-addr-input";
    const errorId = isSidebar
      ? "rms-fulfillment-error"
      : "rms-drawer-fulfillment-error";
    const selected = document.querySelector(
      `input[name="${radioName}"]:checked`,
    );
    const errEl = document.getElementById(errorId);
    if (!selected) {
      if (errEl) errEl.classList.remove("d-none");
      return false;
    }
    if (errEl) errEl.classList.add("d-none");
    const deliveryType = selected.value;
    const addrEl = document.getElementById(addrId);
    const deliveryAddress =
      addrEl && deliveryType === "delivery" ? addrEl.value.trim() : "";
    await this._rpc("/rms/cart/set_delivery", {
      delivery_type: deliveryType,
      delivery_address: deliveryAddress,
    });
    return true;
  }

  _openDrawer() {
    document.getElementById("rms-drawer")?.classList.add("open");
    document.getElementById("rms-drawer-overlay")?.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  _closeDrawer() {
    document.getElementById("rms-drawer")?.classList.remove("open");
    document.getElementById("rms-drawer-overlay")?.classList.remove("open");
    document.body.style.overflow = "";
  }
}

function hideZeroDeliveryCharge() {
  // Odoo requires a carrier before payment, even for pickup. Its native
  // payment summary renders that required $0 carrier as "Delivery". Keep the
  // carrier for checkout validation, but remove the misleading zero row.
  if (window.location.pathname !== "/shop/payment") return;

  const isZeroDelivery = /^Delivery\s*(?:[$€£¥]\s*)?0(?:[.,]0+)?(?:\s*[$€£¥])?$/i;
  for (const element of document.querySelectorAll("#order_delivery, tr, div, li")) {
    const text = element.textContent.replace(/\s+/g, " ").trim();
    if (isZeroDelivery.test(text)) {
      element.classList.add("d-none");
      break;
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.rmsCart = new RmsCart();
    hideZeroDeliveryCharge();
  });
} else {
  window.rmsCart = new RmsCart();
  hideZeroDeliveryCharge();
}
