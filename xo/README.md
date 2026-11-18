# PayPrism on XO

PayPrism is also an [XO](https://xo.cash) template (General Protocols' XO stack). Any XO wallet can use it to pay into a prism or to trigger its payout. The template embeds the compiled CashScript covenant from [`contracts/PayPrism.cash`](../contracts/PayPrism.cash) byte for byte, so XO and the PayPrism web app lock funds to the same prism address.

Template: [`payprism.xo-template.json`](payprism.xo-template.json) (also served at https://payprism.netlify.app/xo/payprism.xo-template.json)

## Actions

| Action | Role | What it does |
| --- | --- | --- |
| `fund` | payer | Pays `fundSatoshis` into the prism. The payer's wallet adds its own inputs and change. |
| `payout2` | trigger | Splits one prism coin between 2 recipients. No key and no funds needed. |
| `payout3` | trigger | Same for 3 recipients. |

Each output of a payout is `floor((prismSatoshis − maxFeePerInput) × share / 10000)`, the same arithmetic the covenant enforces, and the remainder (at least `maxFeePerInput`) is the miner fee. The covenant rejects any other split, any other recipient, and any extra output.

Variables come straight from a PayPrism link: the prism page in the web app has a "Use this prism with XO" section that lists them and copies them as JSON.

## Run on chipnet

Done with the XO debug tool at https://blaze.xo.cash on 18 Nov 2026, using `@xo-cash/engine` 0.1.x as bundled by the tool:

1. Imported the template. The engine accepted it as template `98578b91…a9c4df`.
2. `fund`: 300,000 sats into a 60 / 40 prism. The engine compiled the locking bytecode `aa205860…be89787`, identical to the address the web app derives for the same recipients.
   Transaction: [`116acfa1…9a24e93f`](https://chipnet.imaginary.cash/tx/116acfa1a2f026a01f5ea2dcd1ef7f2fff9722a29319b48c7815fe9f9a24e93f)
3. `payout2`: fetched the prism coin by its locking bytecode, the template resolved the outputs to 179,670 and 119,780 sats, fee 550 sats. Broadcast and accepted by chipnet.
   Transaction: [`8b6fe959…01d95398`](https://chipnet.imaginary.cash/tx/8b6fe959e41280ae29db6d2f2d387f76e47f64d8b4fae9460c68ece001d95398)

Note: before broadcasting, the debug tool marked the payout input as "would fail". The covenant uses loops from the May 2026 VM upgrade; the same transaction passes libauth's `createVirtualMachineBch2026` and was accepted by chipnet nodes, so the warning appears to come from the tool checking against an earlier VM version.

## Offline checks

```
cd xo
npm install
npm run build   # regenerates the template from the compiled contract
npm test
```

The tests check that the template passes the XO schema, that the XO engine's own compiler (`compileLockingBytecodeFromTemplateLockingScriptIdentifier`) produces the same prism address as the web app for 2 and 3 recipients, that the payout the template describes passes the BCH 2026 VM, and that tampered payouts (stranger, short share, extra output) fail.

## Limits

- The XO template splits BCH only. PUSD splitting stays in the web app for now.
- Payout actions exist for 2 and 3 recipients; larger prisms are paid out from the web app.
- One prism coin per payout.
