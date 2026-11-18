// Offline checks for the PayPrism XO template.
// 1. The template passes the XO schema.
// 2. The XO engine compiles it to the same prism address as the CashScript contract in the web app.
// 3. The payout the template describes is accepted by the BCH 2026 VM; tampered payouts are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  binToHex, hexToBin, hash160, secp256k1, generatePrivateKey, createCompilerBch, encodeTransaction,
  createVirtualMachineBch2026, bigIntToVmNumber, encodeLockingBytecodeP2pkh, cashAddressToLockingBytecode,
} from '@bitauth/libauth';
import { parseTemplate, compileCashAssemblyString } from '@xo-cash/utils';
import { compileLockingBytecodeFromTemplateLockingScriptIdentifier } from '@xo-cash/engine';
import { MockNetworkProvider } from 'cashscript';
import { template } from './build-template.mjs';
import { createPrism, encodeRecipients, maxFeePerInput, PUSD_CATEGORY } from '../src/prism.js';

const json = readFileSync(new URL('./payprism.xo-template.json', import.meta.url), 'utf8');
const parsed = parseTemplate(json);

const person = () => hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()));
const vmCategory = binToHex(hexToBin(PUSD_CATEGORY).reverse());

function prismFor(shares) {
  const recipients = shares.map((bps) => ({ pkh: person(), bps }));
  const variables = {
    recipients: binToHex(encodeRecipients(recipients)),
    tokenCategory: vmCategory,
    maxFeePerInput: maxFeePerInput(recipients.length),
  };
  recipients.forEach((r, i) => {
    variables[`recipient${i + 1}Hash`] = binToHex(r.pkh);
    variables[`share${i + 1}`] = BigInt(r.bps);
  });
  return { recipients, variables };
}

// Compile any template script the way the engine does (variables as raw bytecode data).
function compileScript(scriptId, variables) {
  const bytecode = {};
  for (const [k, v] of Object.entries(variables)) {
    bytecode[k] = typeof v === 'bigint' ? bigIntToVmNumber(v) : hexToBin(v);
  }
  const compiler = createCompilerBch({
    scripts: parsed.scripts,
    variables: Object.fromEntries(Object.keys(bytecode).map((k) => [k, { type: 'AddressData' }])),
  });
  const res = compiler.generateBytecode({ data: { bytecode }, scriptId });
  assert.ok(res.success, JSON.stringify(res.errors));
  return res.bytecode;
}

const valueOf = (outputId, variables) => compileCashAssemblyString({
  cashAssemblyText: parsed.outputs[outputId].valueSatoshis,
  variables,
  evaluationDecodeMode: 'bigint',
  templateVariables: parsed.variables,
  templateScripts: parsed.scripts,
});

// Build the payout the template describes and run it through the VM.
function runPayout(count, prism, prismSatoshis, tamper = (tx) => tx) {
  const variables = { ...prism.variables, prismSatoshis };
  const lockingBytecode = compileLockingBytecodeFromTemplateLockingScriptIdentifier(parsed, 'prism', variables);
  const outputs = Array.from({ length: count }, (_v, i) => ({
    lockingBytecode: compileScript(`recipient${i + 1}LockingBytecode`, variables),
    valueSatoshis: BigInt(valueOf(`recipient${i + 1}Output`, variables)),
  }));
  const tx = tamper({
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: hexToBin('11'.repeat(32)),
      outpointIndex: 0,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: compileScript('prismUnlockingBytecode', variables),
    }],
    outputs,
  });
  const vm = createVirtualMachineBch2026();
  const result = vm.verify({ transaction: tx, sourceOutputs: [{ lockingBytecode, valueSatoshis: prismSatoshis }] });
  return { result, tx, lockingBytecode };
}

test('template passes the XO schema and offers fund and payout actions', () => {
  assert.equal(parsed.name, 'PayPrism');
  assert.deepEqual(parsed.start.map((s) => s.action), ['fund', 'payout2', 'payout3']);
});

test('XO engine compiles the same prism address as the web app (2 and 3 recipients)', () => {
  for (const shares of [[5000, 5000], [5000, 3000, 2000]]) {
    const prism = prismFor(shares);
    const fromXo = compileLockingBytecodeFromTemplateLockingScriptIdentifier(parsed, 'prism', prism.variables);
    const contract = createPrism(prism.recipients, new MockNetworkProvider());
    const fromApp = cashAddressToLockingBytecode(contract.address);
    assert.equal(typeof fromApp, 'object', String(fromApp));
    assert.equal(binToHex(fromXo), binToHex(fromApp.bytecode), 'same covenant, same address');
  }
});

test('the template payout passes the BCH 2026 VM (2 recipients, 10000 sats like the mainnet run)', () => {
  const prism = prismFor([5000, 5000]);
  const { result, tx } = runPayout(2, prism, 10_000n);
  assert.equal(result, true, String(result));
  assert.deepEqual(tx.outputs.map((o) => o.valueSatoshis), [4725n, 4725n]);
});

test('the template payout passes the VM for 3 recipients', () => {
  const prism = prismFor([5000, 3000, 2000]);
  const { result, tx } = runPayout(3, prism, 1_000_000n);
  assert.equal(result, true, String(result));
  assert.equal(tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n), 1_000_000n - 650n);
});

test('the covenant still rejects tampered payouts built from the template', () => {
  const prism = prismFor([5000, 5000]);
  const stranger = encodeLockingBytecodeP2pkh(person());
  const swap = runPayout(2, prism, 10_000n, (tx) => ({ ...tx, outputs: [{ ...tx.outputs[0], lockingBytecode: stranger }, tx.outputs[1]] }));
  assert.notEqual(swap.result, true, 'paying a stranger must fail');
  const short = runPayout(2, prism, 10_000n, (tx) => ({ ...tx, outputs: [{ ...tx.outputs[0], valueSatoshis: 1000n }, tx.outputs[1]] }));
  assert.notEqual(short.result, true, 'short-changing must fail');
  const extra = runPayout(2, prism, 10_000n, (tx) => ({ ...tx, outputs: [...tx.outputs, { lockingBytecode: stranger, valueSatoshis: 546n }] }));
  assert.notEqual(extra.result, true, 'an extra output must fail');
  assert.ok(encodeTransaction(swap.tx).length > 0);
});
