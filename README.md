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
Subject: Tracking ICE 145 — Amsterdam Centraal → Berlin Ostbahnhof

Tracking ICE 145, Amsterdam Centraal → Berlin Ostbahnhof.
Scheduled: dep 10:00, arr 16:02.
Departure platform: TBC    Arrival platform: TBC
Status: TBC
Updates by email starting T-30 at 09:30.

Stop tracking this train:
  mailto:stop@late.fyi?subject=STOP%20ICE145&body=STOP%20ICE145
```

`TBC` fills in close to departure: platforms are operator-assigned ~30 min before, and live status (delays, cancellations, route changes) follows real-time data once the train enters service. Then silence — until something actually changes.

If you set a `Trip:` tag or an `On:` date, the subject reflects them so multi-train trips and advance-planned trips group cleanly in your inbox: `Tracking ICE 1255 [austria] — Amsterdam Centraal → Stuttgart Hbf — 2026-05-06`.

## To stop

Click the `mailto:` link in any email. One tap and your mail client opens a fresh `STOP <TRAIN>` ready to send. Replying `STOP` to a confirmation also works on most clients.

---

Feedback: feedback@late.fyi · [Apache 2.0](LICENSE)
