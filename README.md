# latefyi

> Email a train number, get notified when something changes. Email-driven European rail tracker.

Send one email when you book a train. Get a confirmation reply within seconds. Then silence — until something changes that affects you (platform announced, delay, cancellation, terminating short, arrival). All by email, no app to install. Optional ntfy push if you want it.

## How to use it

### Boarding a train (Mode B)

You're catching ICE 145 at Amsterdam Centraal, going to Berlin Ostbahnhof. Send:

```
To:      ICE145@late.fyi
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
```

Reply, threaded, in seconds:

```
Tracking ICE 145, Amsterdam Centraal → Berlin Ostbahnhof.
Scheduled: dep 10:00, arr 16:02.
Updates by email starting T-30 at 09:30.
```

From then on you only hear from it when something matters: platform assigned, delay > 2 min, cancellation, etc. After arrival the conversation closes itself.

### Picking someone up (Mode A)

Your sister is on EUR 9316 arriving at Amsterdam Centraal. Send:

```
To:      EUR9316@late.fyi
Subject: To: Amsterdam Centraal
```

Same rhythm: a confirmation, then quiet until the arrival platform is announced or anything changes.

### Optional fields

| Header | What it does |
|---|---|
| `From: <station>` | Anchor mode: boarding from this station. Required for boarding mode. |
| `To: <station>` | Where you're going (boarding) or meeting the train (pickup). |
| `Trip: <name>` | Group multiple trains under a free-text label. Lets you teardown the chain in one reply (`STOP TRIP <name>`). |
| `Channels: email \| ntfy \| both` | One-shot delivery override for this train only. |

Headers go in the **Subject** (preferred) or in the first non-empty line of the **body**. Header names are case-insensitive.

### Stopping tracking

Reply to any update with one of:

| Reply | Effect |
|---|---|
| `STOP` | Stops the train you're replying to (uses email threading) |
| `STOP <TRAINNUM>` | Stops a specific train, no need to be threaded |
| `STOP TRIP <name>` | Stops every active train you tagged with `Trip: <name>` |
| `STOP ALL` | Stops everything you're currently tracking |

Or send any of those directly to `stop@late.fyi`.

### Switching between email and ntfy

Email anything to `config@late.fyi`:

| Subject | What happens |
|---|---|
| `CHANNELS ntfy` | First time: you get a one-shot reply with a QR code + your private ntfy topic URL. Scan it on your phone (ntfy app). All future trains push there. |
| `CHANNELS both` | Email + ntfy in parallel. |
| `CHANNELS email` | Back to email-only (default). Your ntfy topic is preserved if you switch back later. |

## What gets pushed

Quiet by default. You only hear from it for one of:

- **Tracking start** — confirmation reply (instant) + a "tracking is live" ping at T-30.
- **Pre-anchor (T-30 → departure or arrival)** — platform assigned, platform changed, delay ≥2 min, cancellation, replacement service.
- **In-transit / approach** — arrival platform announced, arrival platform changed, delay propagating to your destination ≥5 min, train terminating before your stop, rerouting.
- **Tracking end** — arrival, or "tracking lost" if the data feed dies for too long.

Cancellation and route disruptions always go to every channel you have configured, regardless of preference. Safety beats preference.

## Why "latefyi"

European trains run late more often than not. Naming the service after its loudest, most-needed message is honest branding: `late.fyi` = "your train is late, FYI." On-time confirmations are quiet by design.

## Coverage

ÖBB's HAFAS endpoint serves as the primary data source. It returns live data for stations across NL, DE, FR, AT, IT, BE, CH, UK, LU. Every product family — TER (SNCF regional), TGV, EUR (Eurostar), ICE, IC, RJ/RJX, FR (Frecciarossa), regional/suburban — is supported. PKP serves as the fallback. (POC notes in [docs/01-product/latefyi-prd.md §8](docs/01-product/latefyi-prd.md#8-data-sources--endpoint-strategy).)

## Limitations

- **One train per email.** Multi-leg journeys = multiple emails. The first train is what matters; if it slips, the rest is moot anyway. Use `Trip: <name>` to group, then `STOP TRIP <name>` to tear down a chain quickly.
- **Allowlist, not public.** This is a single-instance personal/friends tool, not a SaaS. The operator decides who can email it (`ALLOWED_SENDERS` env var).
- **Bare emails always trigger a "missing context" reply.** No auto-picking `From:`/`To:` from the train route, even when unambiguous. The headers are required.

## For developers

- **Architecture, modules, decisions:** [docs/01-product/latefyi-prd.md](docs/01-product/latefyi-prd.md)
- **Phase-by-phase build history:** [CHANGELOG.md](CHANGELOG.md)
- **Cloudflare + VPS deployment runbook:** [docs/cloudflare-setup.md](docs/cloudflare-setup.md)
- **Tests:** `npm test` — currently 196 / 196 passing in ~600 ms, no network needed.

## License

[Apache License 2.0](LICENSE)
