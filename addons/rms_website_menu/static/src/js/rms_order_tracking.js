(function () {
    'use strict';

    const root = document.getElementById('rms-order-tracking');
    if (!root) return;

    const statusUrl = root.dataset.statusUrl;
    const trackingUrl = new URL(root.dataset.trackingUrl, window.location.origin).href;
    const heading = document.getElementById('rms-tracking-heading');
    const stateBadge = document.getElementById('rms-tracking-state');
    const updated = document.getElementById('rms-tracking-updated');
    const copyButton = document.getElementById('rms-copy-tracking');
    const shareButton = document.getElementById('rms-share-tracking');
    const installButton = document.getElementById('rms-install-tracking');
    const installHelp = document.getElementById('rms-install-help');
    const feedback = document.getElementById('rms-copy-feedback');
    let pollTimer = null;
    let deferredInstallPrompt = null;
    let currentState = root.dataset.initialState || 'received';

    function formatTimestamp(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat(undefined, {
            hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
        }).format(date);
    }

    function stateLabel(value) {
        return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
    }

    function applyStatus(payload) {
        currentState = payload.state;
        heading.textContent = payload.message;
        stateBadge.textContent = stateLabel(payload.state);
        stateBadge.className = `rms-tracking-state state-${payload.state}`;
        updated.textContent = `Updated ${new Date().toLocaleTimeString([], {
            hour: 'numeric', minute: '2-digit', second: '2-digit',
        })}`;

        payload.steps.forEach((step) => {
            const element = document.querySelector(`.rms-tracking-step[data-step="${step.key}"]`);
            if (!element) return;
            element.classList.toggle('complete', Boolean(step.complete));
            element.classList.toggle('active', Boolean(step.active));
            element.dataset.timestamp = step.timestamp || '';
            const time = element.querySelector('.rms-step-time');
            if (time) time.textContent = formatTimestamp(step.timestamp);
        });
    }

    async function refreshStatus() {
        clearTimeout(pollTimer);
        if (document.hidden || currentState === 'completed') return;
        try {
            const response = await fetch(statusUrl, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            applyStatus(await response.json());
        } catch (_) {
            updated.textContent = 'Reconnecting to live status...';
        } finally {
            if (currentState !== 'completed' && !document.hidden) {
                pollTimer = setTimeout(refreshStatus, 5000);
            }
        }
    }

    function showFeedback(message) {
        feedback.textContent = message;
        setTimeout(() => {
            if (feedback.textContent === message) feedback.textContent = '';
        }, 2500);
    }

    async function copyTrackingLink() {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(trackingUrl);
            } else {
                const input = document.createElement('textarea');
                input.value = trackingUrl;
                input.setAttribute('readonly', 'readonly');
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            showFeedback('Tracking link copied');
        } catch (_) {
            showFeedback('Could not copy the link');
        }
    }

    async function shareTrackingLink() {
        if (!navigator.share) return false;
        try {
            await navigator.share({
                title: 'Track my restaurant order',
                text: 'Follow the live status of this order.',
                url: trackingUrl,
            });
            return true;
        } catch (error) {
            if (error && error.name !== 'AbortError') showFeedback('Could not open sharing');
            return false;
        }
    }

    copyButton.addEventListener('click', copyTrackingLink);

    if (navigator.share) {
        shareButton.style.display = '';
        shareButton.addEventListener('click', shareTrackingLink);
    }

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
    if (isIos && !standalone) {
        installButton.style.display = '';
        installButton.addEventListener('click', async () => {
            installHelp.style.display = '';
            if (!await shareTrackingLink()) {
                showFeedback('Use Safari Share, then Add to Home Screen');
            }
        });
    }

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        installButton.style.display = '';
    });

    if (!isIos) {
        installButton.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            installButton.style.display = 'none';
        });
    }

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        installButton.style.display = 'none';
        showFeedback('Added to your device');
    });

    document.addEventListener('visibilitychange', () => {
        clearTimeout(pollTimer);
        if (!document.hidden && currentState !== 'completed') refreshStatus();
    });

    if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
        navigator.serviceWorker.register('/rms/order-tracking-sw.js', {
            scope: '/rms/order/',
        }).catch(() => {});
    }

    document.querySelectorAll('.rms-tracking-step').forEach((step) => {
        const time = step.querySelector('.rms-step-time');
        if (time) time.textContent = formatTimestamp(step.dataset.timestamp);
    });
    refreshStatus();
})();
