// WizardConnect: pair a BCH wallet by QR code, read its addresses, ask it to sign.
// The wallet keeps its keys; this page only ever sees public keys and signed transactions.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { TransactionBuilder, placeholderP2PKHUnlocker } from 'cashscript';
import { hash160, stringify } from '@bitauth/libauth';
import { pkhToAddress } from './prism.js';

const PATHS = [['receive', 0], ['change', 1]];
const SCAN_DEPTH = 10; // addresses checked per path
const P2PKH_INPUT_BYTES = 141;

export class Wallet extends EventTarget {
  constructor() {
    super();
    this.state = 'idle'; // idle | connecting | connected
    this.manager = null;
    this.relay = null;
    this.uri = null;
    this.qrUri = null;
    this.walletName = null;
  }

  #set(state) {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }

  /** Start pairing (or resume a stored session). Returns false if already running. */
  connect(existingCredentials) {
    if (this.state !== 'idle') return false;
    const manager = new DappConnectionManager('PayPrism', `${location.origin}/icon.svg`);
    this.manager = manager;
    manager.on('walletready', () => {
      if (this.manager !== manager) return;
      this.walletName = manager.walletName || 'Wallet';
      this.#set('connected');
    });
    manager.on('disconnect', () => {
      if (this.manager !== manager) return;
      manager.clearStoredSession();
      this.#teardown();
    });
    try {
      this.relay = initiateDappRelay(
        (payload) => manager.updateConnection(payload.client, payload.status),
        existingCredentials ? { existingCredentials } : {},
      );
      if (!existingCredentials) {
        this.uri = this.relay.uri;
        this.qrUri = this.relay.qrUri;
      }
      manager.attachRelay(this.relay);
      this.#set('connecting');
      return true;
    } catch (e) {
      this.#teardown();
      throw e;
    }
  }

  /** Reconnect silently after a page reload if the wallet was paired before. */
  resume() {
    try {
      const probe = new DappConnectionManager('PayPrism');
      const stored = probe.loadStoredSession();
      void probe.destroy();
      if (stored?.walletPublicKey) {
        this.walletName = stored.walletName || null;
        this.connect({
          privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey,
        });
      }
    } catch { /* no stored session, or storage unavailable */ }
  }

  async disconnect() {
    const { manager } = this;
    if (manager) {
      await manager.sendDisconnect().catch(() => {});
      manager.clearStoredSession();
    }
    this.#teardown();
  }

  #teardown() {
    const { manager, relay } = this;
    this.manager = null;
    this.relay = null;
    this.uri = null;
    this.qrUri = null;
    this.walletName = null;
    if (manager) void manager.destroy().catch(() => {}).finally(() => relay?.cleanup());
    else relay?.cleanup();
    this.#set('idle');
  }

  /** The wallet's first addresses: [{ address, pathName, index }] */
  addresses(prefix) {
    const list = [];
    for (const [pathName, childIndex] of PATHS) {
      for (let i = 0; i < SCAN_DEPTH; i += 1) {
        const pubkey = this.manager?.getPubkey(childIndex, BigInt(i));
        if (pubkey) list.push({ address: pkhToAddress(hash160(pubkey), { prefix }), pathName, index: i });
      }
    }
    return list;
  }

  /** First receive address — what "use my wallet address" fills in. */
  receiveAddress(prefix) {
    return this.addresses(prefix).find((a) => a.pathName === 'receive')?.address ?? null;
  }

  /**
   * Pay `sats` to `toAddress`. The wallet shows the transaction and signs it;
   * this page then broadcasts it. Returns the transaction id.
   * Throws Error('wallet-empty') or Error('wallet-short', { cause: { have, need } }).
   */
  async pay(provider, prefix, toAddress, sats, userPrompt) {
    const owned = this.addresses(prefix);
    const coins = [];
    for (const entry of owned) {
      const utxos = await provider.getUtxos(entry.address);
      utxos.filter((u) => !u.token).forEach((u) => coins.push({ utxo: u, entry }));
    }
    if (coins.length === 0) throw new Error('wallet-empty');
    coins.sort((a, b) => (b.utxo.satoshis > a.utxo.satoshis ? 1 : -1));

    const picked = [];
    let have = 0n;
    let fee = 0n;
    for (const coin of coins) {
      picked.push(coin);
      have += coin.utxo.satoshis;
      // two outputs: the payment (P2SH32, 44 bytes) and change (P2PKH, 34 bytes)
      fee = BigInt(10 + P2PKH_INPUT_BYTES * picked.length + 44 + 34);
      if (have >= sats + fee) break;
    }
    if (have < sats + fee) throw new Error('wallet-short', { cause: { have, need: sats + fee } });

    const builder = new TransactionBuilder({ provider });
    picked.forEach(({ utxo, entry }) => builder.addInput(utxo, placeholderP2PKHUnlocker(entry.address)));
    builder.addOutput({ to: toAddress, amount: sats });
    const change = have - sats - fee;
    if (change >= 546n) builder.addOutput({ to: owned[0].address, amount: change });

    const wcObject = builder.generateWcTransactionObject({ broadcast: false, userPrompt });
    // The relay sends JSON; libauth's stringify keeps bigint and byte fields intact.
    const transaction = JSON.parse(stringify(wcObject));
    const inputPaths = picked.map(({ entry }, i) => [i, entry.pathName, entry.index]);

    const response = await this.manager.signTransaction({ transaction, inputPaths });
    if (response.error) throw new Error(response.error);
    return provider.sendRawTransaction(response.signedTransaction);
  }
}
