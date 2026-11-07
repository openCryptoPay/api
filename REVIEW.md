# Review

## Payment times

Reject the change when any of these is true:

- A public response, page, or export includes a concrete payment time. That includes `lastTransactionAt`, `occurredAt`, and any other instant of a shop payment.
- `GET /map/places`, with or without `flag=completeList`, or `GET /map/places/{npub}` returns such an instant.
- The public `activity` value is a date or a clock time instead of `daily`, `within7Days`, `within30Days`, `olderThan30Days`, or `none`.

A signed admin response may include `lastTransactionAt`. Keeping the instant in the database is allowed.
