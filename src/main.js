import QRCode from 'qrcode';
import { ElectrumNetworkProvider, MockNetworkProvider, randomUtxo } from 'cashscript';
import { hash160, generatePrivateKey, secp256k1 } from '@bitauth/libauth';
import {
  createPrism, planPayout, buildPayout, prismInputBytes, addressToPkh, pkhToAddress,
  encodePrismLink, decodePrismLink, validateRecipients, maxFeePerInput,
  PUSD_CATEGORY, PUSD_DECIMALS, MAX_RECIPIENTS,
} from './prism.js';
import { Wallet } from './wallet.js';
import { t, getLang, setLang, fmtNumber } from './i18n.js';
import contractSource from '../contracts/PayPrism.cash?raw';
import './style.css';

// ---------- network ----------

const query = new URLSearchParams(location.search);
const NET = ['chipnet', 'demo'].includes(query.get('net')) ? query.get('net') : 'mainnet';
const DEMO = NET === 'demo'; // play money: a local copy of the BCH VM, no network, no funds
const PREFIX = NET === 'mainnet' ? 'bitcoincash' : 'bchtest';
const withTimeout = (promise, ms = 9000) => Promise.race([
  promise, new Promise((_r, reject) => { setTimeout(() => reject(new Error('timeout')), ms); }),
]);
const explorerTx = (txid) => (NET === 'mainnet'
  ? `https://blockchair.com/bitcoin-cash/transaction/${txid}`
  : `https://chipnet.imaginary.cash/tx/${txid}`);

let providerInstance = null;
const provider = () => {
  if (!providerInstance) {
    providerInstance = DEMO ? new MockNetworkProvider({ updateUtxoSet: true }) : new ElectrumNetworkProvider(NET);
  }
  return providerInstance;
};

const wallet = new Wallet();
const app = document.getElementById('app');
const COLORS = ['#2f6bff', '#00a88f', '#f4a300', '#ef5b4c', '#8b5cf6', '#e0489b', '#3fa7d6', '#7cb518'];
const color = (i) => COLORS[i % COLORS.length];

// ---------- small helpers ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const satsToBch = (sats) => fmtNumber(Number(sats) / 1e8, 8);
const tokensToPusd = (units) => fmtNumber(Number(units) / 10 ** PUSD_DECIMALS, PUSD_DECIMALS);
const pct = (bps) => fmtNumber(bps / 100, 2);
const short = (address) => {
  const bare = address.split(':')[1] || address;
  return `${bare.slice(0, 8)}…${bare.slice(-6)}`;
};

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const label = button.textContent;
  button.textContent = t('copied');
  setTimeout(() => { button.textContent = label; }, 1500);
}

function splitBar(rows, { labels = true } = {}) {
  const total = rows.reduce((s, r) => s + r.bps, 0) || 1;
  return `<div class="bar" role="img" aria-label="${esc(rows.map((r) => `${r.label} ${pct(r.bps)} %`).join(', '))}">
    ${rows.map((r, i) => `<div class="seg" style="flex-grow:${Math.max(r.bps, 1) / total};background:${color(i)}">
      ${labels && r.bps / total > 0.09 ? `<span>${esc(pct(r.bps))} %</span>` : ''}</div>`).join('')}
  </div>`;
}

// ---------- header ----------

// BCH BLAZE 2026 banner: presentation, code and the community-vote address.
const VOTE_ADDRESS = 'bitcoincash:zrmdr0k5628npf06wwk3tkkc5z8zdj2tgcnt40w7sh';
const DECK_URL = 'deck/payprism-deck.pdf';
const REPO_URL = 'https://github.com/ElTanque81/payprism';

function blazeBanner() {
  return `<aside class="blaze" aria-label="BCH BLAZE 2026">
    <span><strong>${t('blazeEntry')}</strong></span>
    <span><a href="${DECK_URL}" target="_blank" rel="noopener">${t('blazeDeck')}</a>
      <a href="${REPO_URL}" target="_blank" rel="noopener">${t('blazeCode')}</a>
      <a href="https://youtu.be/7e2a-L7ZM14" target="_blank" rel="noopener">${t('blazeVideo')}</a></span>
    <span class="vote">${t('blazeVote')}
      <code title="${VOTE_ADDRESS}"><span class="full">${VOTE_ADDRESS}</span><span class="short">zrmdr0…40w7sh</span></code>
      <button class="link" data-act="copy-vote">${t('copy')}</button></span>
  </aside>`;
}

function header() {
  const lang = getLang();
  let walletUi = DEMO ? '' : `<button class="btn ghost" data-act="connect">${t('connect')}</button>`;
  if (wallet.state === 'connecting') walletUi = `<button class="btn ghost" data-act="show-qr">${t('connecting')}</button>`;
  if (wallet.state === 'connected') {
    walletUi = `<span class="wallet-on">${esc(t('connected', { wallet: wallet.walletName }))}</span>
      <button class="btn ghost" data-act="disconnect">${t('disconnect')}</button>`;
  }
  return `<header class="top">
    <a class="mark" href="${location.pathname}${location.search}" aria-label="PayPrism">
      <svg viewBox="0 0 40 24" width="40" height="24" aria-hidden="true">
        <rect x="0" y="9" width="14" height="6" rx="3" fill="currentColor"/>
        <rect x="18" y="1" width="22" height="6" rx="3" fill="${COLORS[0]}"/>
        <rect x="18" y="9" width="16" height="6" rx="3" fill="${COLORS[1]}"/>
        <rect x="18" y="17" width="10" height="6" rx="3" fill="${COLORS[2]}"/>
      </svg><span>PayPrism</span></a>
    <div class="top-right">
      ${walletUi}
      <div class="lang" role="group" aria-label="Language">
        <button data-act="lang" data-lang="en" aria-pressed="${lang === 'en'}">EN</button>
        <button data-act="lang" data-lang="de" aria-pressed="${lang === 'de'}">DE</button>
      </div>
    </div>
  </header>`;
}

function footer() {
  const other = NET === 'mainnet' ? '?net=chipnet' : location.pathname;
  const keepHash = DEMO ? '' : location.hash;
  return `<footer class="foot">
    <span>${t('made')}</span>
    <span>${t('network')}: <strong>${t(NET)}</strong>
      <a href="${other}${keepHash}">${t(NET === 'mainnet' ? 'chipnet' : 'mainnet')}</a></span>
  </footer>`;
}

// ---------- create view ----------

const draft = {
  title: '',
  rows: [{ name: '', address: '', share: '50' }, { name: '', address: '', share: '50' }],
  error: '',
};

const parseShare = (text) => Math.round(parseFloat(String(text).replace(',', '.')) * 100);

function draftBarRows() {
  return draft.rows.map((r, i) => {
    const bps = parseShare(r.share);
    return { bps: Number.isFinite(bps) && bps > 0 ? bps : 0, label: r.name || t('recipientN', { n: i + 1 }) };
  });
}

function createView() {
  const sum = draftBarRows().reduce((s, r) => s + r.bps, 0);
  return `<main class="create">
    <h1>${t('tagline')}</h1>
    <p class="lead">${t('lead')}</p>
    ${DEMO ? '' : `<p><a class="btn" href="?net=demo" data-act="try-demo">${t('tryDemo')}</a></p>`}
    <section class="panel">
      <h2>${t('newPrism')}</h2>
      <div id="draft-bar">${splitBar(draftBarRows())}</div>
      <label class="field"><span>${t('titleLabel')}</span>
        <input id="title" maxlength="60" value="${esc(draft.title)}" placeholder="${esc(t('titlePlaceholder'))}"></label>
      <h3>${t('recipients')}</h3>
      <div class="rows">
        ${draft.rows.map((r, i) => `<div class="row" data-row="${i}">
          <span class="dot" style="background:${color(i)}"></span>
          <input class="in-name" aria-label="${esc(t('name'))}" maxlength="30" value="${esc(r.name)}" placeholder="${esc(t('namePlaceholder'))}">
          <input class="in-address mono" aria-label="${esc(t('address'))}" value="${esc(r.address)}" placeholder="${esc(t('addressPlaceholder'))}" spellcheck="false" autocomplete="off">
          <label class="pctbox"><input class="in-share" aria-label="${esc(t('share'))}" inputmode="decimal" value="${esc(r.share)}"><span>%</span></label>
          <button class="icon" data-act="remove-row" aria-label="${esc(t('remove'))}" ${draft.rows.length <= 2 ? 'disabled' : ''}>×</button>
        </div>`).join('')}
      </div>
      <div class="row-actions">
        <button class="btn ghost" data-act="add-row" ${draft.rows.length >= MAX_RECIPIENTS ? 'disabled' : ''}>${t('addRecipient')}</button>
        <button class="btn ghost" data-act="even">${t('splitEvenly')}</button>
        ${wallet.state === 'connected' ? `<button class="btn ghost" data-act="use-wallet">${t('useWallet')}</button>` : ''}
        <span class="sum ${sum === 10000 ? 'ok' : ''}" id="sum">${t('total')}: ${pct(sum)} %</span>
      </div>
      <p class="error" id="draft-error" role="alert">${esc(draft.error)}</p>
      <button class="btn primary big" data-act="create">${t('create')}</button>
    </section>
    ${howSection()}
  </main>`;
}

function howSection() {
  return `<section class="how">
    <h2>${t('howTitle')}</h2>
    <ul>
      <li>${t('how1')}</li><li>${t('how2')}</li><li>${t('how3')}</li>
    </ul>
    <details><summary>${t('contractSource')}</summary><pre class="mono">${esc(contractSource)}</pre></details>
  </section>`;
}

function readDraft() {
  if (draft.rows.length < 2) throw new Error(t('errFew'));
  if (draft.rows.length > MAX_RECIPIENTS) throw new Error(t('errMany'));
  const recipients = draft.rows.map((r, i) => {
    const row = i + 1;
    let pkh;
    try { pkh = addressToPkh(r.address.includes(':') ? r.address : `${PREFIX}:${r.address}`); } catch (e) {
      throw new Error(t(e.message === 'not-p2pkh' ? 'errP2pkh' : 'errAddress', { row }));
    }
    const bps = parseShare(r.share);
    if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error(t('errShare', { row }));
    return { pkh, bps };
  });
  const sum = recipients.reduce((s, r) => s + r.bps, 0);
  if (sum !== 10000) throw new Error(t('errSum', { sum: pct(sum) }));
  try { validateRecipients(recipients); } catch (e) {
    if (e.message === 'duplicate') {
      const seen = new Set();
      const row = recipients.findIndex((r) => {
        const k = r.pkh.join(',');
        if (seen.has(k)) return true;
        seen.add(k);
        return false;
      }) + 1;
      throw new Error(t('errDuplicate', { row }));
    }
    throw e;
  }
  return { recipients, title: draft.title.trim(), names: draft.rows.map((r) => r.name.trim()) };
}

// ---------- prism view ----------

const live = {
  prism: null, // { recipients, title, names, contract, address, tokenAddress }
  utxos: null,
  history: [],
  offline: false,
  busy: false,
  notice: '',
  noticeTx: '',
  error: '',
  showToken: false,
  timer: null,
};

function openPrism(decoded) {
  const contract = createPrism(decoded.recipients, provider());
  live.prism = { ...decoded, contract, address: contract.address, tokenAddress: contract.tokenAddress };
  live.utxos = null;
  live.history = [];
  live.notice = '';
  live.noticeTx = '';
  live.error = '';
  clearInterval(live.timer);
  refreshPot();
  live.timer = setInterval(refreshPot, 6000);
}

async function refreshPot() {
  if (!live.prism || live.busy) return;
  const { address } = live.prism;
  try {
    const utxos = await withTimeout(provider().getUtxos(address));
    if (live.prism?.address !== address) return;
    const before = JSON.stringify(live.utxos?.map((u) => u.txid + u.vout).sort());
    const after = JSON.stringify(utxos.map((u) => u.txid + u.vout).sort());
    const wasOffline = live.offline;
    live.offline = false;
    live.utxos = utxos;
    if (before !== after || wasOffline) {
      loadHistory(address);
      renderPot();
    }
  } catch {
    if (!live.offline) { live.offline = true; renderPot(); }
  }
}

async function loadHistory(address) {
  if (DEMO) return;
  try {
    const entries = await provider().performRequest('blockchain.address.get_history', address);
    if (live.prism?.address !== address || !Array.isArray(entries)) return;
    live.history = entries.slice().reverse().slice(0, 6).map((e) => e.tx_hash);
    renderPot();
  } catch { /* history is a nicety; the pot works without it */ }
}

function currentPlan() {
  const { recipients, contract } = live.prism;
  return planPayout(recipients, live.utxos || [], prismInputBytes(contract));
}

function potHtml() {
  const { recipients, names } = live.prism;
  if (live.offline) return `<p class="error" role="alert">${t('offline')}</p>`;
  if (live.utxos === null) return '<p class="muted">…</p>';

  const totalSats = live.utxos.reduce((s, u) => s + u.satoshis, 0n);
  const totalPusd = live.utxos.reduce((s, u) => s + (u.token?.category === PUSD_CATEGORY ? u.token.amount : 0n), 0n);
  const plan = currentPlan();
  const done = live.notice ? `<p class="notice" role="status">${esc(live.notice)}
    ${live.noticeTx && !DEMO ? `<a href="${explorerTx(live.noticeTx)}" target="_blank" rel="noopener">${t('viewTx')}</a>` : ''}</p>` : '';
  const err = live.error ? `<p class="error" role="alert">${esc(live.error)}</p>` : '';

  let body;
  if (live.utxos.length === 0) {
    body = `<p class="muted">${t('nothingYet')}</p>`;
  } else {
    const amounts = `<p class="pot-amount">${satsToBch(totalSats)} <small>BCH</small>
      ${totalPusd > 0n ? `<span class="plus">+ ${tokensToPusd(totalPusd)} <small>PUSD</small></span>` : ''}</p>
      <p class="muted">${t('payments', { n: live.utxos.length })}</p>`;
    if (plan.ok) {
      body = `${amounts}
        <ul class="gets">${plan.outputs.map((o, i) => `<li>
          <span class="dot" style="background:${color(i)}"></span>
          <span class="who">${esc(names[i] || short(pkhToAddress(recipients[i].pkh, { prefix: PREFIX })))}</span>
          <span class="what">${satsToBch(o.sats)} BCH${o.tokens > 0n ? ` + ${tokensToPusd(o.tokens)} PUSD` : ''}</span>
        </li>`).join('')}</ul>
        <button class="btn primary big" data-act="payout" ${live.busy ? 'disabled' : ''}>${live.busy ? t('payoutBusy') : t('payout')}</button>
        <p class="muted small">${t('payoutHint', { fee: plan.fee.toString() })}</p>`;
    } else {
      const key = totalPusd > 0n ? 'needsFuelTokens' : 'needsFuel';
      body = `${amounts}<p class="hint" role="status">${t(key, { sats: plan.missingSats.toString() })}</p>`;
    }
  }
  const history = live.history.length ? `<h3>${t('history')}</h3><ul class="history">
    ${live.history.map((txid) => `<li><a class="mono" href="${explorerTx(txid)}" target="_blank" rel="noopener">${txid.slice(0, 16)}…${txid.slice(-8)}</a></li>`).join('')}</ul>` : '';
  const demo = DEMO ? `<div class="row-actions demo-actions">
      <button class="btn" data-act="demo-bch">${t('demoBch')}</button>
      <button class="btn" data-act="demo-pusd">${t('demoPusd')}</button>
    </div>` : '';
  return `${done}${err}${body}${demo}${history}`;
}

function renderPot() {
  const el = document.getElementById('pot');
  if (el) el.innerHTML = potHtml();
}

function prismView() {
  const { recipients, names, title, address, tokenAddress } = live.prism;
  const shown = live.showToken ? tokenAddress : address;
  const rows = recipients.map((r, i) => ({ bps: r.bps, label: names[i] || t('recipientN', { n: i + 1 }) }));
  const payIn = wallet.state === 'connected' ? `<form class="payin" data-form="payin">
      <label class="field"><span>${t('payFromWallet')}</span>
        <span class="inline"><input id="pay-amount" inputmode="decimal" placeholder="${esc(t('amount'))}" aria-label="${esc(t('amount'))}">
        <button class="btn" type="submit">${t('send')}</button></span></label>
      <p class="muted small" id="payin-status" role="status"></p>
    </form>` : `<p class="muted small"><button class="link" data-act="connect">${t('connect')}</button> ${t('toPayFromWallet')}</p>`;
  const payInShown = DEMO ? '' : payIn;

  return `<main class="prism">
    ${DEMO ? `<p class="hint demo-note">${t('demoNote')} <a href="${location.pathname}">${t('demoLeave')}</a></p>` : ''}
    <h1>${esc(title || t('untitled'))}</h1>
    ${splitBar(rows)}
    <ul class="legend">${recipients.map((r, i) => `<li>
      <span class="dot" style="background:${color(i)}"></span>
      <span class="who">${esc(names[i] || t('recipientN', { n: i + 1 }))}</span>
      <span class="mono addr" title="${esc(pkhToAddress(r.pkh, { prefix: PREFIX }))}">${esc(short(pkhToAddress(r.pkh, { prefix: PREFIX })))}</span>
      <span class="what">${t('shareOfTotal', { pct: pct(r.bps) })}</span></li>`).join('')}</ul>
    <div class="cols">
      <section class="panel">
        <h2>${t('payTo')}</h2>
        <div class="tabs" role="group">
          <button data-act="addr-bch" aria-pressed="${!live.showToken}">${t('bchAddress')}</button>
          <button data-act="addr-token" aria-pressed="${live.showToken}">${t('tokenAddress')}</button>
        </div>
        <canvas id="qr" width="220" height="220" aria-label="QR"></canvas>
        <p class="mono address" id="address">${esc(shown)}</p>
        ${live.showToken ? `<p class="muted small">${t('tokenHint')}</p>` : ''}
        <div class="row-actions">
          <button class="btn" data-act="copy-address">${t('copy')}</button>
          <button class="btn ghost" data-act="copy-link">${t('copyLink')}</button>
        </div>
        ${payInShown}
      </section>
      <section class="panel">
        <h2>${t('inPot')}</h2>
        <div id="pot">${potHtml()}</div>
      </section>
    </div>
    ${howSection()}
  </main>`;
}

// ---------- wallet dialog ----------

function qrDialog() {
  if (wallet.state !== 'connecting' || !wallet.qrUri || !ui.showQr) return '';
  return `<div class="backdrop" data-act="hide-qr"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(t('scanTitle'))}">
    <h2>${t('scanTitle')}</h2>
    <p class="muted">${t('scanHint')}</p>
    <canvas id="wiz-qr" width="260" height="260"></canvas>
    <div class="row-actions center">
      <button class="btn" data-act="copy-wiz">${t('copy')}</button>
      <a class="btn ghost" href="${esc(wallet.uri)}">${t('openInWallet')}</a>
      <button class="btn ghost" data-act="hide-qr-btn">${t('close')}</button>
    </div>
  </div></div>`;
}

const ui = { showQr: false };

// ---------- render ----------

function render() {
  document.documentElement.lang = getLang();
  document.title = live.prism ? `${live.prism.title || t('untitled')} · PayPrism` : 'PayPrism';
  let view;
  if (ui.linkError) view = `<main class="create"><h1>PayPrism</h1><p class="error" role="alert">${t('errLink')}</p><a class="btn" href="${location.pathname}${location.search}">${t('newPrism')}</a></main>`;
  else view = live.prism ? prismView() : createView();
  app.innerHTML = `${blazeBanner()}${header()}${view}${footer()}${qrDialog()}`;

  const qr = document.getElementById('qr');
  if (qr && live.prism) {
    QRCode.toCanvas(qr, live.showToken ? live.prism.tokenAddress : live.prism.address, { width: 220, margin: 1 }).catch(() => {});
  }
  const wiz = document.getElementById('wiz-qr');
  if (wiz && wallet.qrUri) QRCode.toCanvas(wiz, wallet.qrUri, { width: 260, margin: 1, errorCorrectionLevel: 'M' }).catch(() => {});
}

function route() {
  ui.linkError = false;
  clearInterval(live.timer);
  live.prism = null;
  if (location.hash.length > 1) {
    try {
      const decoded = decodePrismLink(location.hash);
      if (decoded) openPrism(decoded);
    } catch { ui.linkError = true; }
  } else if (DEMO) {
    const someone = () => hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()));
    openPrism({
      recipients: [{ pkh: someone(), bps: 5000 }, { pkh: someone(), bps: 3000 }, { pkh: someone(), bps: 2000 }],
      title: t('demoTitle'),
      names: ['Ana', 'Ben', 'Chris'],
    });
  }
  render();
}

// ---------- events ----------

function syncDraftFromDom() {
  const title = document.getElementById('title');
  if (title) draft.title = title.value;
  document.querySelectorAll('.row[data-row]').forEach((el) => {
    const r = draft.rows[Number(el.dataset.row)];
    if (!r) return;
    r.name = el.querySelector('.in-name').value;
    r.address = el.querySelector('.in-address').value.trim();
    r.share = el.querySelector('.in-share').value;
  });
}

app.addEventListener('input', (e) => {
  if (!e.target.closest('.create')) return;
  syncDraftFromDom();
  const bar = document.getElementById('draft-bar');
  if (bar) bar.innerHTML = splitBar(draftBarRows());
  const sum = draftBarRows().reduce((s, r) => s + r.bps, 0);
  const sumEl = document.getElementById('sum');
  if (sumEl) { sumEl.textContent = `${t('total')}: ${pct(sum)} %`; sumEl.classList.toggle('ok', sum === 10000); }
});

app.addEventListener('submit', async (e) => {
  if (e.target.dataset.form !== 'payin') return;
  e.preventDefault();
  const status = document.getElementById('payin-status');
  const sats = BigInt(Math.round(parseFloat(document.getElementById('pay-amount').value.replace(',', '.')) * 1e8) || 0);
  if (sats < 1000n) { status.textContent = t('amountBad'); return; }
  status.textContent = t('sending');
  try {
    const prompt = `PayPrism: ${live.prism.title || t('untitled')}`;
    await wallet.pay(provider(), PREFIX, live.prism.address, sats, prompt);
    status.textContent = t('sent');
    document.getElementById('pay-amount').value = '';
    refreshPot();
  } catch (err) {
    if (err.message === 'wallet-empty') status.textContent = t('walletEmpty');
    else if (err.message === 'wallet-short') status.textContent = t('walletShort', { have: err.cause.have.toString(), need: err.cause.need.toString() });
    else status.textContent = t('errGeneric', { msg: err.message });
  }
});

app.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  if (act === 'hide-qr' && e.target !== target) return; // clicks inside the dialog

  if (live.prism === null && !ui.linkError) syncDraftFromDom();

  switch (act) {
    case 'lang': setLang(target.dataset.lang); render(); break;
    case 'connect':
      try { wallet.connect(); ui.showQr = true; } catch (err) { draft.error = t('errGeneric', { msg: err.message }); }
      render(); break;
    case 'show-qr': ui.showQr = true; render(); break;
    case 'hide-qr': case 'hide-qr-btn': ui.showQr = false; render(); break;
    case 'copy-wiz': copyText(wallet.uri, target); break;
    case 'disconnect': await wallet.disconnect(); break;
    case 'add-row': draft.rows.push({ name: '', address: '', share: '' }); render(); break;
    case 'remove-row': draft.rows.splice(Number(target.closest('.row').dataset.row), 1); render(); break;
    case 'even': {
      const n = draft.rows.length;
      const base = Math.floor(10000 / n);
      draft.rows.forEach((r, i) => { r.share = String((base + (i === 0 ? 10000 - base * n : 0)) / 100); });
      render(); break;
    }
    case 'use-wallet': {
      const address = wallet.receiveAddress(PREFIX);
      const empty = draft.rows.find((r) => !r.address) || draft.rows[0];
      if (address) empty.address = address;
      render(); break;
    }
    case 'create':
      try {
        const data = readDraft();
        draft.error = '';
        location.hash = encodePrismLink(data);
      } catch (err) { draft.error = err.message; render(); }
      break;
    case 'addr-bch': live.showToken = false; render(); break;
    case 'addr-token': live.showToken = true; render(); break;
    case 'copy-address': copyText(live.showToken ? live.prism.tokenAddress : live.prism.address, target); break;
    case 'copy-link': copyText(location.href, target); break;
    case 'copy-vote': copyText(VOTE_ADDRESS, target); break;
    case 'payout': await doPayout(); break;
    case 'demo-bch':
      provider().addUtxo(live.prism.address, randomUtxo({ satoshis: 1_000_000n, token: undefined }));
      live.notice = ''; refreshPot(); break;
    case 'demo-pusd':
      provider().addUtxo(live.prism.address, randomUtxo({ satoshis: 1000n, token: { category: PUSD_CATEGORY, amount: 2500n } }));
      live.notice = ''; refreshPot(); break;
    default:
  }
});

async function doPayout() {
  if (live.busy) return;
  live.busy = true;
  live.error = '';
  live.notice = '';
  renderPot();
  try {
    live.utxos = await provider().getUtxos(live.prism.address);
    const plan = currentPlan();
    if (!plan.ok) throw new Error(t('needsFuel', { sats: plan.missingSats.toString() }));
    const builder = buildPayout(live.prism.contract, plan, provider(), PUSD_CATEGORY, PREFIX);
    // Play-money mode runs the transaction through the VM in this browser; otherwise it goes to the network.
    const txid = DEMO ? (await builder.send()).txid : await provider().sendRawTransaction(builder.build());
    live.notice = t('payoutDone');
    live.noticeTx = txid;
    live.utxos = live.utxos.filter((u) => !plan.inputs.includes(u));
  } catch (err) {
    live.error = t('errGeneric', { msg: String(err.message).split('\n')[0] });
  }
  live.busy = false;
  renderPot();
  setTimeout(refreshPot, 1500);
}

wallet.addEventListener('change', () => {
  if (wallet.state === 'connected') ui.showQr = false;
  if (live.prism === null && !ui.linkError) syncDraftFromDom();
  render();
});

window.addEventListener('hashchange', route);
if (!DEMO) wallet.resume();
route();

// exposed for the fee note in the README and for debugging in the console
window.payprism = { maxFeePerInput, NET };
