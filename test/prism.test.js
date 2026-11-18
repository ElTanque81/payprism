// Covenant tests. Every transaction here is evaluated by the real Bitcoin Cash VM
// (libauth, via CashScript's MockNetworkProvider) — no chain, no funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MockNetworkProvider, TransactionBuilder, SignatureTemplate, randomUtxo,
} from 'cashscript';
import { secp256k1, hash160, generatePrivateKey, hexToBin, binToHex } from '@bitauth/libauth';
import {
  createPrism, planPayout, buildPayout, pkhToAddress, maxFeePerInput, prismInputBytes,
  encodePrismLink, decodePrismLink, encodeRecipients, addressToPkh, PUSD_CATEGORY,
} from '../src/prism.js';

const PREFIX = 'bchtest';
const OTHER_CATEGORY = 'aa'.repeat(32);

function person() {
  const privateKey = generatePrivateKey();
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  return { privateKey, pkh: hash160(publicKey) };
}

function setup(shares) {
  const provider = new MockNetworkProvider();
  const people = shares.map(() => person());
  const recipients = people.map((p, i) => ({ pkh: p.pkh, bps: shares[i] }));
  const prism = createPrism(recipients, provider);
  return { provider, people, recipients, prism };
}

const fund = (ctx, satoshis, token) => {
  const utxo = randomUtxo({ satoshis, ...(token ? { token } : { token: undefined }) });
  return ctx.provider.addUtxo(ctx.prism.address, utxo);
};

const addr = (pkh, tokens = false) => pkhToAddress(pkh, { prefix: PREFIX, tokens });

async function payout(ctx) {
  const utxos = await ctx.prism.getUtxos();
  const plan = planPayout(ctx.recipients, utxos, prismInputBytes(ctx.prism));
  assert.equal(plan.ok, true, `plan failed: ${plan.reason}`);
  const builder = buildPayout(ctx.prism, plan, ctx.provider, PUSD_CATEGORY, PREFIX);
  await builder.send();
  return plan;
}

/** Build a hand-made (possibly dishonest) payout and return the builder. */
function custom(ctx, inputs, outputs) {
  const b = new TransactionBuilder({ provider: ctx.provider, allowImplicitFungibleTokenBurn: true });
  b.addInputs(inputs, ctx.prism.unlock.payout());
  b.addOutputs(outputs);
  return b;
}

const rejects = (builder, why) => assert.rejects(() => builder.send(), why);

test('splits BCH 50 / 30 / 20 and nobody needs a key', async () => {
  const ctx = setup([5000, 3000, 2000]);
  fund(ctx, 1_000_000n);
  const plan = await payout(ctx);
  const cap = maxFeePerInput(3);
  const distributable = 1_000_000n - cap;
  plan.outputs.forEach((o, i) => {
    assert.ok(o.sats >= (distributable * BigInt(ctx.recipients[i].bps)) / 10000n);
  });
  assert.equal(plan.outputs.reduce((s, o) => s + o.sats, 0n) + plan.fee, 1_000_000n);
  assert.ok(plan.fee <= cap, 'fee stays under the on-chain cap');
  assert.ok(plan.fee < 500n, 'a 3-way payout costs under 500 sats');
  assert.equal((await ctx.prism.getUtxos()).length, 0, 'pot is empty afterwards');
});

test('sweeps several incoming payments in one payout', async () => {
  const ctx = setup([7000, 3000]);
  fund(ctx, 40_000n); fund(ctx, 250_000n); fund(ctx, 12_345n);
  const plan = await payout(ctx);
  assert.equal(plan.inputs.length, 3);
  assert.equal(plan.outputs.reduce((s, o) => s + o.sats, 0n) + plan.fee, 302_345n);
});

test('works with the maximum of 20 recipients', async () => {
  const ctx = setup(Array(20).fill(500));
  fund(ctx, 2_000_000n);
  const plan = await payout(ctx);
  assert.equal(plan.outputs.length, 20);
});

test('sweeps 40 separate payments at once without hitting VM limits', async () => {
  for (const shares of [[5000, 5000], Array(20).fill(500)]) {
    const ctx = setup(shares);
    for (let i = 0; i < 45; i += 1) fund(ctx, 100_000n + BigInt(i));
    const plan = await payout(ctx);
    assert.equal(plan.inputs.length, 40, 'a payout takes at most 40 coins');
    assert.equal((await ctx.prism.getUtxos()).length, 5, 'the rest waits for the next payout');
  }
});

test('rejects a payout that short-changes one recipient', async () => {
  const ctx = setup([5000, 5000]);
  const u = fund(ctx, 100_000n);
  await rejects(custom(ctx, [u], [
    { to: addr(ctx.people[0].pkh), amount: 90_000n },
    { to: addr(ctx.people[1].pkh), amount: 9_000n },
  ]), /BCH share too small/);
});

test('rejects sending a share to somebody else', async () => {
  const ctx = setup([5000, 5000]);
  const u = fund(ctx, 100_000n);
  const thief = person();
  const half = (100_000n - maxFeePerInput(2)) / 2n;
  await rejects(custom(ctx, [u], [
    { to: addr(ctx.people[0].pkh), amount: half },
    { to: addr(thief.pkh), amount: half },
  ]), /wrong recipient/);
});

test('rejects any extra output, even a zero-value data output', async () => {
  const ctx = setup([5000, 5000]);
  const u = fund(ctx, 100_000n);
  const half = (100_000n - maxFeePerInput(2)) / 2n;
  const b = custom(ctx, [u], [
    { to: addr(ctx.people[0].pkh), amount: half },
    { to: addr(ctx.people[1].pkh), amount: half },
  ]);
  b.addOpReturnOutput(['hi']);
  await rejects(b, /one output per recipient/);
});

test('rejects recipients in the wrong order (shares would be swapped)', async () => {
  const ctx = setup([9000, 1000]);
  const u = fund(ctx, 100_000n);
  await rejects(custom(ctx, [u], [
    { to: addr(ctx.people[1].pkh), amount: 89_000n },
    { to: addr(ctx.people[0].pkh), amount: 10_000n },
  ]), /wrong recipient/);
});

test('rejects a miner fee above the cap', async () => {
  const ctx = setup([5000, 5000]);
  const u = fund(ctx, 100_000n);
  await rejects(custom(ctx, [u], [
    { to: addr(ctx.people[0].pkh), amount: 45_000n },
    { to: addr(ctx.people[1].pkh), amount: 45_000n },
  ]), /BCH share too small/);
});

test('rejects mixing in a coin that is not from the prism', async () => {
  const ctx = setup([5000, 5000]);
  const u = fund(ctx, 100_000n);
  const outsider = person();
  const foreign = randomUtxo({ satoshis: 50_000n, token: undefined });
  const foreignUtxo = ctx.provider.addUtxo(addr(outsider.pkh), foreign);
  const b = new TransactionBuilder({ provider: ctx.provider });
  b.addInput(u, ctx.prism.unlock.payout());
  b.addInput(foreignUtxo, new SignatureTemplate(outsider.privateKey).unlockP2PKH());
  b.addOutputs([
    { to: addr(ctx.people[0].pkh), amount: 74_000n },
    { to: addr(ctx.people[1].pkh), amount: 74_000n },
  ]);
  await rejects(b, /foreign input/);
});

test('splits PUSD together with BCH', async () => {
  const ctx = setup([6000, 2500, 1500]);
  fund(ctx, 1_000n, { category: PUSD_CATEGORY, amount: 350_000n }); // 3,500.00 PUSD
  fund(ctx, 20_000n); // fuel
  const plan = await payout(ctx);
  assert.deepEqual(plan.outputs.map((o) => o.tokens), [210_000n, 87_500n, 52_500n]);
  assert.equal(plan.outputs.reduce((s, o) => s + o.tokens, 0n), 350_000n, 'no token is lost');
});

test('token rounding: leftovers go to a recipient, a zero share gets no token output', async () => {
  const ctx = setup([9999, 1]);
  fund(ctx, 1_000n, { category: PUSD_CATEGORY, amount: 105n });
  fund(ctx, 6_000_000n); // a 0.01 % share only clears the dust limit in a large pot
  const plan = await payout(ctx);
  assert.deepEqual(plan.outputs.map((o) => o.tokens), [105n, 0n]);
});

test('rejects burning or pocketing the tokens', async () => {
  const ctx = setup([5000, 5000]);
  const t = fund(ctx, 1_000n, { category: PUSD_CATEGORY, amount: 1000n });
  const f = fund(ctx, 20_000n);
  const cap = maxFeePerInput(2);
  const half = (21_000n - 2n * cap) / 2n;
  // tokens simply left out
  await rejects(custom(ctx, [t, f], [
    { to: addr(ctx.people[0].pkh), amount: half },
    { to: addr(ctx.people[1].pkh), amount: half },
  ]), /wrong token/);
  // one recipient takes all of them
  await rejects(custom(ctx, [t, f], [
    { to: addr(ctx.people[0].pkh, true), amount: half, token: { category: PUSD_CATEGORY, amount: 1000n } },
    { to: addr(ctx.people[1].pkh), amount: half },
  ]), /wrong token/);
});

test('tokens of another category can never be spent (so never burned) by the prism', async () => {
  const ctx = setup([5000, 5000]);
  const stray = fund(ctx, 1_000n, { category: OTHER_CATEGORY, amount: 77n });
  const f = fund(ctx, 50_000n);
  const cap = maxFeePerInput(2);
  const half = (51_000n - 2n * cap) / 2n;
  await rejects(custom(ctx, [stray, f], [
    { to: addr(ctx.people[0].pkh), amount: half },
    { to: addr(ctx.people[1].pkh), amount: half },
  ]), /unsupported token/);
  // the planner leaves the stray token alone and pays out the rest
  const plan = await payout(ctx);
  assert.equal(plan.inputs.length, 1);
  assert.equal((await ctx.prism.getUtxos()).length, 1);
});

test('planner asks for fuel instead of building an unpayable transaction', async () => {
  const ctx = setup([5000, 5000]);
  fund(ctx, 1_000n, { category: PUSD_CATEGORY, amount: 5000n });
  const plan = planPayout(ctx.recipients, await ctx.prism.getUtxos(), prismInputBytes(ctx.prism));
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'needs-fuel');
  assert.ok(plan.missingSats > 0n);
  fund(ctx, plan.missingSats);
  await payout(ctx);
});

test('share link round-trips and the address commits to the recipient list', async () => {
  const a = setup([5000, 5000]);
  const link = encodePrismLink({ recipients: a.recipients, title: 'Band', names: ['Ana', 'Ben'] });
  const decoded = decodePrismLink(`#${link}`);
  assert.equal(decoded.title, 'Band');
  assert.deepEqual(decoded.names, ['Ana', 'Ben']);
  assert.equal(binToHex(encodeRecipients(decoded.recipients)), binToHex(encodeRecipients(a.recipients)));
  assert.equal(createPrism(decoded.recipients, a.provider).address, a.prism.address);

  const changed = [{ ...a.recipients[0], bps: 5001 }, { ...a.recipients[1], bps: 4999 }];
  assert.notEqual(createPrism(changed, a.provider).address, a.prism.address);
});

test('refuses recipient lists that could never pay out', () => {
  const p = [person(), person()];
  assert.throws(() => encodeRecipients([{ pkh: p[0].pkh, bps: 5000 }, { pkh: p[1].pkh, bps: 4000 }]), /sum/);
  assert.throws(() => encodeRecipients([{ pkh: p[0].pkh, bps: 10000 }]), /too-few/);
  assert.throws(() => encodeRecipients([{ pkh: p[0].pkh, bps: 5000 }, { pkh: p[0].pkh, bps: 5000 }]), /duplicate/);
  assert.throws(() => addressToPkh('bitcoincash:pwyn2qd5xqcwzetvk5zdgj2kmlmn2e2psvd7w7ah5aa76dq57cz0vr8hhs7tg'), /not-p2pkh|invalid-address/);
  assert.equal(hexToBin('00').length, 1);
});
