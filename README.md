# late.fyi

Email a train number. Get told when something changes.

European trains only. No app. No account. No noise on time.

## Send this

```
To:      ICE145@late.fyi
Subject: From: Amsterdam Centraal, To: Berlin Ostbahnhof
```

(Picking someone up? Just `To: <station>`, no `From:`.)

Travelling later? Add `On: 2026-05-04` (or `5 May 2026`) to the subject. We'll wake up on the day.

## You'll get back (in seconds)

```
From:    latefyi <ICE145@late.fyi>
Subject: Tracking ICE 145 — Amsterdam Centraal → Berlin Ostbahnhof — Monday, 2026-05-04

Tracking ICE 145, Amsterdam Centraal → Berlin Ostbahnhof.
Scheduled: dep Monday, 2026-05-04 10:00 Amsterdam Centraal, arr Monday, 2026-05-04 16:02 Berlin Ostbahnhof.
Departure platform: TBC    Arrival platform: TBC
Status: TBC
Updates by email starting T-30 at 09:30.

Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20ICE145&body=STOP%20ICE145

— late.fyi
list@late.fyi (your active trains) | feedback@late.fyi | we don't store your email past notifications or STOP
```

`TBC` fills in close to departure: platforms are operator-assigned ~30 min before, and live status (delays, cancellations, route changes) follows real-time data once the train enters service. Then silence — until something actually changes.

Subject always carries a `Day, YYYY-MM-DD` suffix so it stays unambiguous when read the following day. If you set a `Trip:` tag the subject carries it too: `Tracking ICE 1255 [austria] — Amsterdam Centraal → Stuttgart Hbf — Monday, 2026-05-04`.

## To stop

Click the `mailto:` link in any email. One tap and your mail client opens a fresh `STOP <TRAIN>` ready to send. Replying `STOP` to a confirmation also works on most clients.

---

feedback@late.fyi · [Apache 2.0](LICENSE)
