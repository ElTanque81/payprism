# PayPrism

**One address in. Everyone paid out.**

PayPrism turns a list of people and shares into a single Bitcoin Cash address. Whatever is paid to that address can only leave one way: split between those people, in those proportions. There is no owner key, no account and no server holding funds. Anyone can press "Pay everyone out"; the contract makes sure the money can only go where the prism says.

Built for [BCH BLAZE 2026](https://dorahacks.io/hackathon/bchblaze2026) (Mainnet Track), during the hacking period that started on 14 November 2026.

## What you can do with it

- A band, a shop with partners, a hackathon team or a streamer with moderators shares **one** address or QR code. Every payment is divided automatically.
- It splits **BCH and PUSD** (ParyonUSD) in the same payout. BLAZE prizes are paid in PUSD, so a team can hand the organisers one PayPrism address and let the chain do the split.
- The whole prism lives in the link. No database, no sign-up. If this website disappeared, the funds would still be claimable by anyone who has the link.

Demo video (2 min): https://youtu.be/7e2a-L7ZM14

Presentation (BCH BLAZE "Widget Factory" template structure): [public/deck/payprism-deck.pdf](public/deck/payprism-deck.pdf) · live at https://payprism.netlify.app/deck/payprism-deck.pdf

Community vote (EMBER2026): `bitcoincash:zrmdr0k5628npf06wwk3tkkc5z8zdj2tgcnt40w7sh`

## Try it

| Mode | How | Needs |
| --- | --- | --- |
| Play money | Open the site and press **Try it with play money** (or add `?net=demo`) | Nothing. Payments are simulated, but every payout is validated by the real BCH VM running in the browser. |
| Mainnet | Create a prism, pay to its address, press **Pay everyone out** | A few thousand sats |
| Chipnet | Add `?net=chipnet` | Test coins |

## How the contract works

[`contracts/PayPrism.cash`](contracts/PayPrism.cash) is about 40 lines of CashScript 0.14. It has one function, `payout()`, and no signature check.

```
contract PayPrism(bytes recipients, bytes32 tokenCategory, int maxFeePerInput)
```

`recipients` is one byte string of 22-byte entries: a 20-byte public key hash followed by a 2-byte share in basis points. The contract uses the **loops added to the Bitcoin Cash VM in the May 2026 upgrade** to walk it, so the same contract serves 2 recipients or 20.

A payout transaction is only valid if:

1. every input comes from this same prism (first loop, which also adds up the BCH and the tokens),
2. output *k* pays recipient *k* at least `share × (total − fee allowance) / 10000` in BCH, and at least their share of the tokens (second loop),
3. there are no other outputs.

Consequences:

- **Nobody can redirect funds.** Not the creator, not this website, not whoever presses the button.
- **The address commits to the list.** It is the hash of the contract including the recipient list, so changing one share or one address produces a different address.
- **The miner fee is capped on-chain** at `350 + 100 × recipients` sats per spent coin. A real 3-way payout costs about 430 sats.
- **Only the configured token is ever spent.** UTXOs carrying any other token cannot be used as inputs, so the prism can never burn them. (They also cannot be recovered. The app shows a token address only for PUSD.)

### Limits worth knowing

- Recipients must be ordinary P2PKH wallet addresses; 2 to 20 per prism.
- Each recipient's part must be above the network's dust limit (546 sats, or 1000 sats for an output carrying PUSD). The app tells you how many sats are missing instead of building a transaction that would be rejected. PUSD payments therefore need a little BCH in the pot as well.
- One payout sweeps at most 40 incoming payments; the rest go out with the next press.
- Anyone can trigger a payout at any time, so many tiny payments mean many small fees. That is a cost, not a risk to the split.

## Tests

```
npm install
npm test
```

17 tests run the covenant against the real BCH VM (libauth, through CashScript's `MockNetworkProvider`). They cover the honest paths (BCH, PUSD, 20 recipients, 40 inputs, rounding) and the attacks: short-changing a recipient, paying a stranger, adding an extra output, swapping the order, taking an oversized fee, mixing in a foreign input, burning or pocketing tokens, and spending a foreign token. Each rejection test asserts the exact `require` that fired.

## Wallet connection

The app uses [WizardConnect](https://gitlab.com/riftenlabs/lib/wizardconnect) (`@wizardconnect/core`, `@wizardconnect/dapp`). Connecting a wallet lets you:

- drop your own address into the recipient list, and
- pay into a prism with one confirmation in the wallet.

Keys never leave the wallet. The payout itself needs no wallet at all.

## Run locally

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run compile    # recompile the contract after editing it
```

The site is fully static. Deploy `dist/` to any static host (Netlify, Vercel, GitHub Pages).

## Project layout

```
contracts/PayPrism.cash     the covenant
src/artifacts/PayPrism.json compiled artifact
src/prism.js                encoding, payout planning, share links (no browser needed)
src/wallet.js               WizardConnect pairing and signing
src/main.js, style.css      the web app
src/i18n.js                 English and German
test/prism.test.js          covenant tests
```

## Status

Live: https://payprism.netlify.app

Verified on mainnet (block 977,316):

- Pay-in signed by a Cashonize wallet over WizardConnect: [`d328499c…5063ac492`](https://blockchair.com/bitcoin-cash/transaction/d328499c06920754e14b74dbb083b4bd78834771ba0fe7fe4cb42ae5063ac492)
- Keyless payout by the covenant to two recipients, 367 sats fee: [`8088a6c8…eec89974`](https://blockchair.com/bitcoin-cash/transaction/8088a6c8c0248b983dcb1446380eb221d47c6bc108da33efd39cf304eec89974)

Also verified: covenant logic in the BCH VM (17 tests), full flow in play-money mode, production build.

## License

MIT
