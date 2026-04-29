# late.fyi

Email a train number. Get told when something changes.

No app. No account. No noise on time.

## Send this

```
To:      ICE145@late.fyi
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
```

(Picking someone up? Just `To: <station>`, no `From:`.)

## You'll get back (in seconds)

```
Tracking ICE 145, Amsterdam Centraal → Berlin Ostbahnhof.
Scheduled: dep 10:00, arr 16:02.
Updates by email starting T-30 at 09:30.
```

Then silence — until the platform is announced, the train is delayed, cancelled, or arrives.

## Multi-leg trip?

Tag each train with the same `Trip:` name and stop them all in one go.

```
To:      ICE145@late.fyi
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
         Trip: berlin-weekend
```

Reply `STOP TRIP berlin-weekend` to cancel the whole chain.

## To stop one train

Reply `STOP` to any update.

---

[How it works](docs/01-product/latefyi-prd.md) · [Apache 2.0](LICENSE)
