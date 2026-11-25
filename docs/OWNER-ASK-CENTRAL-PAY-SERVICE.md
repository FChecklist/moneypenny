# What the owner and IT Services need to supply for the central pay service

Written for the owner (Rajat Agarwal) and for whoever carries out the steps. Version: Moneypenny 0.2.16 (prepared, not deployed).

**Status in one line:** the Moneypenny side is built and tested against a stand-in for the central pay service, and it is switched off. No real call is made and no money moves until the items below are supplied and two flags are turned on.

## 1. What this is

IT Services keeps its own Razorpay account inside the central IT Services pay service (a Cloudflare Pages project with its own database; repository `itservices-site`, branch `feat/credit-order-moneypenny`, commit `7d3d0b0`). Moneypenny never holds that Razorpay secret. For a payee whose gateway is `itservices_central`, Moneypenny asks the central service to open each order and, after checkout, to confirm the payment. Credits are given only from the facts the central service answers (amount, currency, order, payment and the person who was named when the order was made), once, through the same code every other payment uses.

The payee name shown to people is always read from the payee record. It is never written into code.

## 2. Please confirm: what F10 to F13 mean

The design document `PAYEE-ACCOUNTS-DESIGN.md` was **not found** on this laptop (Downloads, the marketing ledger, all repositories, git history). The task said only: "F10 to F13: central IT Services pay service (adapter, routing, tests with a fake service, dark)". So the four chunks were split like this:

| Chunk | What it is | File |
|---|---|---|
| F10 | the gateway adapter for the central service | `src/gateways/itservices-central.js` |
| F11 | routing: an order of a central payee is opened at the central service | `src/payee-rail.js` (and two small lines in `src/gate.js`) |
| F12 | confirming a payment from the central service's facts | `src/central-confirm.js` |
| F13 | health of a central payee (owner only, no secret value) | `src/central-health.js` |

If the design document says something different, send it and the split can be corrected before anything is switched on.

## 3. What has to be supplied

| # | Item | Who | Detail |
|---|---|---|---|
| 1 | Address of the central service | Owner, from IT Services | Platform variable `MNP_CENTRAL_BASE_URL`. It is not a secret. It must be a plain https address of a public host: no path, no port, no login, not an IP address. |
| 2 | Site name | Owner | A platform secret that holds a public name: the name the central service knows Moneypenny by. In the central service's code this is `moneypenny.corporatetambola.com`. It goes in the payee's `key_id` secret name. |
| 3 | Site key | IT Services makes it, owner stores it | A platform secret. IT Services makes a long random key, keeps only its hash in its own database for the Moneypenny site row, and hands the key over once. The Moneypenny site row in the central service is shipped **inactive and without a key** today, so this must be done there first. It goes in the payee's `key_secret` secret name and is sent as the `x-site-key` header. |
| 4 | A third secret (not used) | Owner | The payee registry demands three different secret names for every gateway. This gateway reads only the first two. The third (`webhook_secret`) must still exist with any non-empty value. See question 5. |
| 5 | The three real secret names | Owner | Capital letters, digits and underscore, three different names, never reused once a payee that used them is retired. Example shape only: `MNP_PAYEE_ITS_KEY_ID`, `MNP_PAYEE_ITS_KEY_SECRET`, `MNP_PAYEE_ITS_WEBHOOK_SECRET`. The values go into the platform store, never into git, chat or any file. |
| 6 | Central service ready | IT Services | Its own Razorpay secrets set (otherwise it answers "payments are not configured"), the Moneypenny site row active, and the two Moneypenny routes `credit-order` and `credit-verify` deployed (they exist on the branch named above). |
| 7 | How the central service pushes a payment | Owner decides | The central service pushes to the path `/v1/game_pay/payment_confirmed`. This Moneypenny has no such path; the equivalent is `POST /v1/rail/confirm` (purchase key, same facts: order id, payment id, amount, currency). Either IT Services changes its push path, or a one-line alias is added here. The push is the safety net if the browser never reports. |
| 8 | A new payee record | Owner, in the owner screen | Gateway `itservices_central`, mode `test` first. A new payee is needed: the older payee already has orders, and its gateway can no longer be changed. Then activate it and set the route for the product. |
| 9 | Two flags | Owner | `MNP_PAYEE_ACCOUNTS=1` and `MNP_CENTRAL_PAY=1`. Both are off today. Turning the first on does not open payments; the second is the one that lets the central payee take orders. |
| 10 | Wiring | Developer | Three small steps, listed in `docs/PAYEE-CENTRAL-PAY-SERVICE.md` section 6. Not done in this change, so it does not collide with the parallel fixes to F1 to F9. |
| 11 | The Rs 1 test | Owner | The first real proof. Only then is the claim "it behaves like the stand-in" true. See section 4. |

## 4. The Rs 1 test, in plain words

1. Everything in section 3 is in place, the payee is in `test` mode and routed for one product.
2. The owner buys the smallest pack with a real Rs 1 payment from a personal account.
3. Check, in this order: the order shows as awaiting payment with a central order id; the payment shows as paid in the central service's ledger; credits arrive **once**; the same payment reported twice gives no second credit.
4. Check the owner health call for the payee: secrets present (true or false only), address accepted, service answering.
5. Refunds are not covered: the central service records refunds and disputes but never sends them to Moneypenny. A person makes a cash refund in the payment gateway and records it here.

## 5. Questions only the owner can answer

1. Is the split F10 to F13 in section 2 right? Where is `PAYEE-ACCOUNTS-DESIGN.md`?
2. Which address does the central service run on for real use?
3. Which three secret names should be used?
4. Push path: change the central service to call `/v1/rail/confirm`, or add an alias here (item 7)?
5. Should the registry let a gateway name its own secret set, so a gateway that needs only two secrets is not forced to hold a third unused one?
6. Is the fast path wanted (the browser reports the finished checkout and Moneypenny asks the central service), or only the push? Both are safe to run together: the same payment credits once.
