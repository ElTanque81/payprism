// PayPrism core: everything about a prism that does not need a browser.
// Used by the web app and by the test suite.
import { Contract, TransactionBuilder } from 'cashscript';
import {
  binToHex, hexToBin, decodeCashAddress, encodeCashAddress,
  bigIntToVmNumber, vmNumberToBigInt,
} from '@bitauth/libauth';
import artifact from './artifacts/PayPrism.json' with { type: 'json' };

export { artifact };

/** ParyonUSD (PUSD) on Bitcoin Cash mainnet. 2 decimals. */
export const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
export const PUSD_DECIMALS = 2;

export const MIN_RECIPIENTS = 2;
export const MAX_RECIPIENTS = 20;
export const TOTAL_BPS = 10000;
/** BCH that every token-carrying output needs so it is not dust. */
export const TOKEN_OUTPUT_SATS = 1000n;
export const DUST_SATS = 546n;

/** Most prism coins one payout spends; keeps every input far inside the VM's operation budget. */
export const MAX_INPUTS = 40;

const ENTRY_BYTES = 22;

/** Fee ceiling per spent prism UTXO, fixed by the number of recipients. */
export function maxFeePerInput(recipientCount) {
  return BigInt(350 + 100 * recipientCount);
}

/** Decode a cash address into its 20-byte public key hash. P2PKH only. */
export function addressToPkh(address) {
  const withPrefix = address.includes(':') ? address : `bitcoincash:${address}`;
  const decoded = decodeCashAddress(withPrefix.trim().toLowerCase());
  if (typeof decoded === 'string') throw new Error('invalid-address');
  const isP2pkh = decoded.type === 'p2pkh' || decoded.type === 'p2pkhWithTokens';
  if (!isP2pkh || decoded.payload.length !== 20) throw new Error('not-p2pkh');
  return decoded.payload;
}

export function pkhToAddress(pkh, { prefix = 'bitcoincash', tokens = false } = {}) {
  const res = encodeCashAddress({ prefix, type: tokens ? 'p2pkhWithTokens' : 'p2pkh', payload: pkh });
  return res.address;
}

function encodeShare(bps) {
  const num = bigIntToVmNumber(BigInt(bps));
  const out = new Uint8Array(2);
  out.set(num);
  return out;
}

/**
 * recipients: [{ pkh: Uint8Array(20), bps: number }]
 * Throws with a short code if the list could never be paid out.
 */
export function validateRecipients(recipients) {
  if (recipients.length < MIN_RECIPIENTS) throw new Error('too-few');
  if (recipients.length > MAX_RECIPIENTS) throw new Error('too-many');
  let sum = 0;
  const seen = new Set();
  for (const r of recipients) {
    if (!(r.pkh instanceof Uint8Array) || r.pkh.length !== 20) throw new Error('invalid-address');
    if (!Number.isInteger(r.bps) || r.bps < 1 || r.bps > TOTAL_BPS) throw new Error('bad-share');
    const key = binToHex(r.pkh);
    if (seen.has(key)) throw new Error('duplicate');
    seen.add(key);
    sum += r.bps;
  }
  if (sum !== TOTAL_BPS) throw new Error('sum');
}

export function encodeRecipients(recipients) {
  validateRecipients(recipients);
  const out = new Uint8Array(recipients.length * ENTRY_BYTES);
  recipients.forEach((r, i) => {
    out.set(r.pkh, i * ENTRY_BYTES);
    out.set(encodeShare(r.bps), i * ENTRY_BYTES + 20);
  });
  return out;
}

export function decodeRecipients(bytes) {
  if (bytes.length === 0 || bytes.length % ENTRY_BYTES !== 0) throw new Error('bad-link');
  const recipients = [];
  for (let i = 0; i < bytes.length; i += ENTRY_BYTES) {
    const share = vmNumberToBigInt(bytes.slice(i + 20, i + 22), { requireMinimalEncoding: false });
    if (typeof share === 'string') throw new Error('bad-link');
    recipients.push({ pkh: bytes.slice(i, i + 20), bps: Number(share) });
  }
  validateRecipients(recipients);
  return recipients;
}

/** Token categories are byte-reversed inside the VM compared to how explorers show them. */
function categoryForVm(categoryHex) {
  return hexToBin(categoryHex).reverse();
}

/** Build the contract object for a recipient list. The address commits to the whole list. */
export function createPrism(recipients, provider, tokenCategory = PUSD_CATEGORY) {
  const encoded = encodeRecipients(recipients);
  const contract = new Contract(
    artifact,
    [encoded, categoryForVm(tokenCategory), maxFeePerInput(recipients.length)],
    { provider, addressType: 'p2sh32' },
  );
  return contract;
}

/** floor(amount * bps / 10000) — the exact arithmetic the contract uses. */
function shareOf(amount, bps) {
  return (amount * BigInt(bps)) / BigInt(TOTAL_BPS);
}

/** Bytes one prism input adds to a transaction (outpoint, sequence, redeem script push). */
export function prismInputBytes(contract) {
  const redeemLen = contract.bytesize;
  const pushLen = redeemLen < 76 ? 1 : redeemLen < 256 ? 2 : 3;
  const scriptLen = pushLen + redeemLen;
  return 40 + (scriptLen < 253 ? 1 : 3) + scriptLen;
}

/**
 * Work out a payout for the given prism UTXOs.
 * Returns { ok, reason?, inputs, outputs, fee, totalValue, totalTokens, missingSats }.
 * `outputs` is one entry per recipient: { pkh, bps, sats, tokens }.
 * `missingSats` is how much BCH one extra payment must bring before a payout is possible.
 */
export function planPayout(recipients, utxos, inputBytes, tokenCategory = PUSD_CATEGORY, feeRate = 1.0) {
  const n = recipients.length;
  const feeCap = maxFeePerInput(n);

  // Skip anything the contract refuses to spend, and coins too small to pay for themselves.
  const usable = utxos.filter((u) => {
    if (u.token) return u.token.category === tokenCategory && !u.token.nft && u.token.amount > 0n;
    return u.satoshis > feeCap;
  });
  const empty = {
    ok: false, inputs: [], outputs: [], fee: 0n, totalValue: 0n, totalTokens: 0n, missingSats: 0n,
  };
  if (usable.length === 0) return { ...empty, reason: 'empty' };
  // Tokens first, then the largest coins; anything beyond the limit waits for the next payout.
  usable.sort((a, b) => (Number(Boolean(b.token)) - Number(Boolean(a.token))) || (b.satoshis > a.satoshis ? 1 : -1));
  usable.length = Math.min(usable.length, MAX_INPUTS);

  const totalValue = usable.reduce((s, u) => s + u.satoshis, 0n);
  const totalTokens = usable.reduce((s, u) => s + (u.token ? u.token.amount : 0n), 0n);

  const tokenShares = recipients.map((r) => shareOf(totalTokens, r.bps));
  // Tokens left over from rounding go to the recipient with the largest share.
  const biggest = recipients.reduce((best, r, i) => (r.bps > recipients[best].bps ? i : best), 0);
  if (totalTokens > 0n) tokenShares[biggest] += totalTokens - tokenShares.reduce((s, t) => s + t, 0n);

  const outputBytes = tokenShares.reduce((s, t) => s + (t > 0n ? 77 : 34), 0);

  // For a given pot size and input count: the least each output must carry, and the fee.
  const requirement = (value, inputCount) => {
    const distributable = value - feeCap * BigInt(inputCount);
    const fee = BigInt(Math.ceil((10 + inputBytes * inputCount + outputBytes) * feeRate));
    const floors = recipients.map((r, i) => {
      const contractMin = distributable > 0n ? shareOf(distributable, r.bps) : 0n;
      const dustMin = tokenShares[i] > 0n ? TOKEN_OUTPUT_SATS : DUST_SATS;
      return contractMin > dustMin ? contractMin : dustMin;
    });
    const needed = floors.reduce((s, f) => s + f, 0n) + fee;
    return { floors, fee, feasible: distributable > 0n && needed <= value };
  };

  const now = requirement(totalValue, usable.length);
  if (!now.feasible) {
    // Smallest single top-up that makes the payout possible (it arrives as one more input).
    let lo = 1n;
    let hi = 1n;
    while (!requirement(totalValue + hi, usable.length + 1).feasible && hi < 10n ** 12n) hi *= 2n;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (requirement(totalValue + mid, usable.length + 1).feasible) hi = mid; else lo = mid + 1n;
    }
    const missingSats = hi > feeCap ? hi : feeCap + 1n;
    return {
      ...empty, reason: 'needs-fuel', inputs: usable, totalValue, totalTokens, missingSats,
    };
  }

  // Hand out what is left above the floors, again by share; rounding dust goes to the biggest share.
  const { floors, fee } = now;
  const spare = totalValue - fee - floors.reduce((s, f) => s + f, 0n);
  const sats = floors.map((f, i) => f + shareOf(spare, recipients[i].bps));
  sats[biggest] += totalValue - fee - sats.reduce((s, v) => s + v, 0n);

  const outputs = recipients.map((r, i) => ({
    pkh: r.pkh, bps: r.bps, sats: sats[i], tokens: tokenShares[i],
  }));
  return { ok: true, inputs: usable, outputs, fee, totalValue, totalTokens, missingSats: 0n };
}

/** Turn a plan into a ready-to-send transaction builder. No key is needed. */
export function buildPayout(contract, plan, provider, tokenCategory = PUSD_CATEGORY, prefix = 'bitcoincash') {
  if (!plan.ok) throw new Error(plan.reason || 'not-payable');
  const builder = new TransactionBuilder({ provider, maximumFeeSatoshis: plan.fee });
  builder.addInputs(plan.inputs, contract.unlock.payout());
  for (const out of plan.outputs) {
    const hasTokens = out.tokens > 0n;
    builder.addOutput({
      to: pkhToAddress(out.pkh, { prefix, tokens: hasTokens }),
      amount: out.sats,
      ...(hasTokens ? { token: { category: tokenCategory, amount: out.tokens } } : {}),
    });
  }
  return builder;
}

// ---------- share links ----------

function toBase64Url(bytes) {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** The link carries everything: recipients, shares, and optional display names. */
export function encodePrismLink({ recipients, title = '', names = [] }) {
  const params = new URLSearchParams();
  params.set('p', toBase64Url(encodeRecipients(recipients)));
  if (title) params.set('t', title);
  if (names.some((x) => x)) params.set('n', names.map((x) => (x || '').replaceAll('|', ' ')).join('|'));
  return params.toString();
}

export function decodePrismLink(fragment) {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const p = params.get('p');
  if (!p) return null;
  let bytes;
  try { bytes = fromBase64Url(p); } catch { throw new Error('bad-link'); }
  const recipients = decodeRecipients(bytes);
  const names = (params.get('n') || '').split('|');
  return {
    recipients,
    title: (params.get('t') || '').slice(0, 60),
    names: recipients.map((_r, i) => (names[i] || '').slice(0, 30)),
  };
}

export { binToHex, hexToBin };
