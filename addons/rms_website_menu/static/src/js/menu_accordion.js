'use strict';

class RmsAccordion {
    constructor() {
        this._init();
    }

    toggle(toggle) {
        const targetId = toggle.dataset.target;
        const content = document.getElementById(targetId);
        if (!content) return;

        const isCollapsed = content.classList.contains('collapsed');
        content.classList.toggle('collapsed', !isCollapsed);
        toggle.classList.toggle('rms-collapsed', !isCollapsed);
    }

    _init() {
        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('.rms-accordion-toggle');
            if (!toggle) return;
            e.preventDefault();
            this.toggle(toggle);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.rmsAccordion = new RmsAccordion();
});
