
A JavaScript "flow" library, and a flash card website that works offline.

##

TODO: delete cards
TODO: search for cards

## Syncing

Locally, every row has two dates: the date it was locally created, and the date the server learned about it.

```
export interface Card {
  card_id: string;
  deck_id: string;
  front: string;
  back: string;
  date_created: number;  // Time the user made this.
  remote_date: integer;   // Counter when the server learned about this (0 if the sever doesn't know about it).
}
```

When a local client syncs with the server, it grabs all rows where "remote_date = 0" and sends them to the server, as well as the last remote_date it received from the server.

The server then returns all rows it received since that remote date.

```
return fetch("/api/sync", {
  method: "POST",
  body: JSON.stringify({
    operations: unsyncedLocalOperations,
    last_sync: largestRemoteDate,
  }),
  headers: {
    "Content-Type": "application/json",
  },
});
```

There are other ways to do syncing -- maybe the most obvious is to have a table of operations that can be run forward and backward. Syncing is then just a matter of reverting local operations to the earliest remote operation, and playing all operations forward.

Unfortunately, if you're syncing for the first time to a very old database, you're going to have to play *every single operation* before the website is ready. This is a non-starter.

A more complicated approach that manages multiple checkpoints and picks a nice one could work, but seems unnecessarily complex given our use case (99% of our operations are inserts). (To see the complexity, consider that if a local client syncs, it may have to re-perform operation that it has already synced, and that, on the server side, checkpoints can become invalidated at any time).

## Algorithm

TL;DR: Mostly Super Memo 2

[https://research.duolingo.com/papers/settles.acl16.pdf](Duolingo assumes) P(recall) = exp(-∆t / halflife) and that half life increases exponentially (they claim this is common in the literature).

Super Memo 2, on the other hand, models "repetition interval" as f(t + 1) = t(f) * card_easiness (note: f(t) is expoential, just like half life), where "card_easiness" is adaptive, but defaults to around 2.5.

What's not clear (unfortunately) is the relationship between half life and optimal repetition interval, though we'll assume they're proportional (since they both increase exponentially, although in different papers).

More unfortunately, nobody has much to say about the effects of premature reviewing -- evidentally reviewing the same card 3 times in a minute is less helpful than twice in a minute and then once 10 minutes later. And by the same reasoning, all pre-mature reviews should be less effective at increasing halflife (λ).

I'm forced to conjecture (since I can't find literature that attempts to deal with premature study) that *longer* spacing is only less effective if you *actually get terms wrong* -- i.e. there's nothing wrong with not reviewing a term you're already confident with. It also seems likely that you don't get much benefit from reviewing a card immediately after correctly reviewing it. From these two assumptions, we take the SM2 algorithm:

```
class Response {
  perfect:                         5,
  correct_after_hesitation:        4,
  correct_with_serious_difficulty: 3,
  incorrect_but_easy_to_recall:    2,
  incorrect:                       1,
  complete_blackout:               0,
}

function modify_card(card, response: number) {
  card.easiness_factor += 0.1 - (5 - response) * (0.08 + (5 - response) * 0.02);
  if (card.easiness_factor < 1.3) card.easiness_factor = 1.3;
  card.repetition_interval = card.repetition_interval * card.easiness_factor
  if (response <= Response.incorrect_but_easy_to_recall) {
    card.repetition_interval = 1;  // Reset to 1 day
  }
}
```

And apply a linear interpolation for prematurely reviewed cards:

```
function modify_card(card, response, time_since_last_seen) {
  ...
  const t = Math.min(1, time_since_last_seen / card.repetition_interval);
  const lambda = card.easiness_factor * t + 1 * (1 - t);
  card.repetition_interval = card.repetition_interval * lambda;
  ...
}
```

Note: We also ignore the SM2's weird boost from 1 day to 6 days after your first correct review.

Note: Since lambda relies on knowing the last time a card was seen, repetition intervals can be inaccurate if you're using two un-synced devices. The most common use-case is a single offline-device, that re-syncs before any other devices start reviewing, this shouldn't be a huge deal.

## Building / Running locally.

```
$ npm run build
$ python server.py
```

## Running tests:

```
$ npx jest
```

## Real server:

```
ssh -i ~/Downloads/flash.ssh.pem ec2-user@18.218.221.127
cd /home/ec2-user/flash-cards
sudo ./.venv/bin/python -m gunicorn server:app -b '0.0.0.0:443' \
--certfile /etc/letsencrypt/live/flashcards.morganredding.com/cert.pem \
--keyfile /etc/letsencrypt/live/flashcards.morganredding.com/privkey.pem
```