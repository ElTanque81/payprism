// Builds the PayPrism XO template from the compiled CashScript contract.
// The contract bytecode is embedded verbatim, so the XO template and the web app
// lock funds to exactly the same covenant (checked in verify-template.test.mjs).
import { writeFileSync } from 'node:fs';
import { asmToBytecode } from '@cashscript/utils';
import { binToHex } from '@bitauth/libauth';
import artifact from '../src/artifacts/PayPrism.json' with { type: 'json' };

export const contractHex = binToHex(asmToBytecode(artifact.bytecode));

const zero = { satoshis: '<bigint: 0n>', fungibleTokens: '<bigint: 0n>', nonfungibleTokens: 0 };
const notOurs = { selectable: false, balance: zero };

// floor((prism coin - fee allowance) * share / 10000): the same arithmetic the covenant enforces.
const shareExpr = (n) => `$(<prismSatoshis> <maxFeePerInput> OP_SUB <share${n}> OP_MUL <10000> OP_DIV)`;

const recipientParts = (n) => ({
  variables: {
    [`recipient${n}Hash`]: { name: `Recipient ${n}`, description: `Public key hash (20 bytes) of recipient ${n}, in the order of the recipient list.`, type: 'bytes' },
    [`share${n}`]: { name: `Share ${n}`, description: `Share of recipient ${n} in basis points (5000 = 50 %).`, type: 'integer' },
  },
  lockingScripts: {
    [`recipient${n}Wallet`]: {
      name: `Recipient ${n}`, description: `The wallet of recipient ${n}.`, icon: 'recipient',
      lockingType: 'p2s', lockingBytecode: `recipient${n}LockingBytecode`, ...notOurs,
    },
  },
  outputs: {
    [`recipient${n}Output`]: {
      name: `Share of recipient ${n}`, description: `$(<share${n}>) basis points of the prism coin, after the fee allowance.`, icon: 'recipient',
      lockingScript: `recipient${n}Wallet`, valueSatoshis: shareExpr(n), token: null,
    },
  },
  scripts: {
    [`recipient${n}LockingBytecode`]: `OP_DUP OP_HASH160 <recipient${n}Hash> OP_EQUALVERIFY OP_CHECKSIG`,
  },
});
const r = [1, 2, 3].map(recipientParts);
const merge = (key) => Object.assign({}, ...r.map((p) => p[key]));

const payoutAction = (count) => ({
  name: `Pay out ${count} recipients`,
  description: `Splits one prism coin between ${count} recipients. Anyone can trigger it; no key is involved.`,
  icon: 'prism',
  roles: {
    trigger: {
      requirements: {
        variables: ['recipients', 'tokenCategory', 'maxFeePerInput', 'prismSatoshis',
          ...Array.from({ length: count }, (_v, i) => [`recipient${i + 1}Hash`, `share${i + 1}`]).flat()],
      },
    },
  },
  requirements: { participants: [{ role: 'trigger', slots: { min: 1, max: 1 } }] },
  transaction: `payout${count}Transaction`,
});

const payoutTransaction = (count) => ({
  name: 'Prism paid out',
  description: `$(<prismSatoshis>) satoshis split between ${count} recipients.`,
  icon: 'prism',
  inputs: [{ input: 'prismInput', inputIndex: 0 }],
  outputs: Array.from({ length: count }, (_v, i) => ({ output: `recipient${i + 1}Output`, outputIndex: i })),
});

export const template = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
  name: 'PayPrism',
  description: 'One Bitcoin Cash address that splits every payment between a fixed list of people. Keyless covenant.',
  icon: 'prism',
  version: '1',
  supported: ['BCH_2026_05'],
  resources: [
    { name: 'PayPrism', description: 'The PayPrism web app and its documentation.', url: 'https://payprism.netlify.app' },
    { name: 'Source code', description: 'CashScript covenant, web app and this template.', url: 'https://github.com/ElTanque81/payprism' },
  ],
  roles: {
    payer: { name: 'Payer', description: 'Pays into a prism.', icon: 'payer' },
    trigger: { name: 'Trigger', description: 'Anyone who starts a payout. Needs no key and no funds.', icon: 'prism' },
  },
  start: [{ action: 'fund' }, { action: 'payout2' }, { action: 'payout3' }],
  actions: {
    fund: {
      name: 'Pay into a prism',
      description: 'Sends satoshis to a prism address. They can only leave split between its recipients.',
      icon: 'payer',
      roles: { payer: { requirements: { variables: ['recipients', 'tokenCategory', 'maxFeePerInput', 'fundSatoshis'] } } },
      requirements: { participants: [{ role: 'payer', slots: { min: 1, max: 1 } }] },
      transaction: 'fundTransaction',
    },
    payout2: payoutAction(2),
    payout3: payoutAction(3),
  },
  transactions: {
    fundTransaction: {
      name: 'Paid into prism',
      description: '$(<fundSatoshis>) satoshis paid into a prism.',
      icon: 'payer',
      inputs: [],
      outputs: [{ output: 'prismOutput' }],
      composable: true,
    },
    payout2Transaction: payoutTransaction(2),
    payout3Transaction: payoutTransaction(3),
  },
  inputs: {
    prismInput: {
      name: 'Prism coin', description: 'The prism coin being paid out.', icon: 'prism',
      valueSatoshis: '$(<prismSatoshis>)', token: null, unlockingScript: 'prismUnlockingBytecode',
    },
  },
  outputs: {
    prismOutput: {
      name: 'Prism coin', description: 'Satoshis locked in the prism until the next payout.', icon: 'prism',
      lockingScript: 'prism', valueSatoshis: '$(<fundSatoshis>)', token: null,
    },
    ...merge('outputs'),
  },
  lockingScripts: {
    prism: {
      name: 'PayPrism covenant',
      description: 'Pays out only to the recipient list, in its shares, with a capped fee and no other outputs.',
      icon: 'prism',
      lockingType: 'p2s',
      lockingBytecode: 'prismLockingBytecode',
      state: { variables: ['recipients', 'tokenCategory', 'maxFeePerInput'] },
      ...notOurs,
    },
    ...merge('lockingScripts'),
  },
  scripts: {
    // Constructor arguments are pushed in reverse order, followed by the compiled CashScript contract.
    prismRedeemBytecode: `<maxFeePerInput> <tokenCategory> <recipients> 0x${contractHex}`,
    prismLockingBytecode: 'OP_HASH256 <$(<prismRedeemBytecode> OP_HASH256)> OP_EQUAL',
    prismUnlockingBytecode: '<prismRedeemBytecode>',
    ...merge('scripts'),
  },
  constants: {},
  variables: {
    recipients: {
      name: 'Recipient list',
      description: 'Encoded list: per recipient a 20-byte public key hash and a 2-byte little-endian share in basis points. The p= value of a PayPrism link, decoded.',
      type: 'bytes',
    },
    tokenCategory: {
      name: 'Token category',
      description: 'The one CashToken category the prism also splits, in VM byte order. PUSD by default.',
      type: 'bytes',
    },
    maxFeePerInput: {
      name: 'Fee allowance per coin',
      description: 'Satoshis the payout may leave as miner fee per prism coin: 350 + 100 x recipients.',
      type: 'integer',
    },
    fundSatoshis: { name: 'Amount', description: 'Satoshis to pay into the prism.', type: 'satoshis' },
    prismSatoshis: { name: 'Prism coin value', description: 'Satoshis held by the prism coin being paid out.', type: 'satoshis' },
    ...merge('variables'),
  },
  icons: ['prism', 'payer', 'recipient'].map((name) => ({ name, hash: '0000000000000000000000' })),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = JSON.stringify(template, null, 2);
  writeFileSync(new URL('./payprism.xo-template.json', import.meta.url), `${json}\n`);
  // The web app serves the same file, so the prism page can offer it for download.
  writeFileSync(new URL('../public/xo/payprism.xo-template.json', import.meta.url), `${json}\n`);
  console.log(`wrote payprism.xo-template.json (${json.length} bytes, contract ${contractHex.length / 2} bytes)`);
}
