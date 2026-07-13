# RMS Print Relay

The desktop relay runs on the restaurant laptop and sends ESC/POS tickets to
the Epson TM-T20IV over raw TCP port 9100. Odoo owns the durable print queue;
the relay makes outbound HTTPS requests to claim jobs and report their result.

This design keeps printing independent of the KDS browser. The KDS may run on
a laptop, Android tablet, or iPad, and orders remain queued while the relay or
printer is offline.

## Pairing

1. Deploy and upgrade the `rms_website_menu` Odoo addon.
2. Sign in to `/rms/kitchen` as an administrator.
3. Open **Print Queue**, enter a relay name, and generate a pairing code.
4. Open the desktop relay and enter the Odoo URL and eight-character code.
5. Select **Pair with Odoo** within ten minutes.

The relay receives a dedicated revocable device token. It never stores an
Odoo administrator password.

## Printing flow

1. A paid website order creates an automatic Odoo print job.
2. Future scheduled orders use their scheduled time as `available_at`.
3. The relay claims due jobs and sends the ticket to the Epson.
4. The relay reports `sent` or `failed`; failed jobs retry with backoff.
5. Manual prints from KDS create separate auditable queue jobs.

The relay keeps a local journal of completed job UUIDs. If printing succeeds
but the Odoo acknowledgement is interrupted, a reclaimed job is acknowledged
without printing it a second time.

## Local development

Copy the configuration template:

```bash
cp config.example.json config.json
npm start
```

For validation without a physical Epson, set `printerMode` to `mock`. The app
starts a local simulated printer on `127.0.0.1:9100` and displays each queue,
rendering, and printer event in Live Debug.

The localhost HTTP endpoints remain available for diagnostics and migration:

- `GET /health`
- `GET /status`
- `GET /debug`
- `POST /print` (legacy direct-print path)

## Packaging

Universal macOS:

```bash
npm run dist
```

Windows x64:

```bash
npm run dist:win
```

The relay must run on the same local network as the Epson, and RAW port 9100
must be enabled on the printer.
