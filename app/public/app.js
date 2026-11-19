const $ = (id) => document.getElementById(id);
let currentState = null;
let review = null;
let replayIndex = 0;
let replayTimer = null;
let requestInFlight = false;
let refreshInFlight = false;
let updateEpoch = 0;
let activeAction = '';
let pollTimer = null;
let noticeTimer = null;
let lastRenderKey = '';
const recoveryOpen = new Set();
const recoveryDrafts = new Map();
const detailOpen = new Set();
const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

function node(tag, attrs = {}, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'disabled' || key === 'checked' || key === 'hidden') element[key] = Boolean(value);
    else element.setAttribute(key, String(value));
  }
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? numberFormat.format(n) : '...'; }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function words(value) { return String(value ?? '').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()); }
function shortId(value, leading = 9, trailing = 5) { const str = String(value ?? ''); return str.length > leading + trailing + 3 ? `${str.slice(0, leading)}...${str.slice(-trailing)}` : str; }
function chainName(value) { return value === 'base' || Number(value) === 84532 ? 'Base' : value === 'unichain' || Number(value) === 1301 ? 'Unichain' : value === 'reactive' || Number(value) === 5318007 ? 'Reactive' : words(value || 'Local chain'); }
function busy() { return requestInFlight || Boolean(currentState?.busy); }
function modelAvailable() { return Boolean(currentState?.model?.available || currentState?.model?.ready); }
function modelName() { return currentState?.model?.model || 'Model not connected'; }
function knownArray(value) { return Array.isArray(value) ? value : []; }
function offerFor(id) { return knownArray(currentState?.offers).find((offer) => offer.id === id); }

function announce(message, error = false) {
  window.clearTimeout(noticeTimer);
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  if (!error) noticeTimer = window.setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function setConnection(message, error = false) {
  const panel = $('connection-panel');
  panel.hidden = false;
  panel.classList.toggle('error', error);
  panel.querySelector('span:not(.spinner)').textContent = message;
  panel.querySelector('.spinner').hidden = error;
  $('reconnect-button').hidden = !error;
}
function preserveFocus(run) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;
  run();
  if (key) {
    const replacement = [...document.querySelectorAll('[data-focus-key]')].find((item) => item.dataset.focusKey === key);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      if (typeof replacement.setSelectionRange === 'function' && Number.isInteger(start)) replacement.setSelectionRange(start, end);
    }
  }
}
function appendEmpty(container, title, description, glyph = '▤') {
  const wrapper = node('div', { className: 'empty-state' });
  const icon = node('span', { className: 'empty-glyph', 'aria-hidden': 'true' }, glyph);
  const copy = node('div');
  copy.append(node('h3', {}, title), node('p', {}, description));
  wrapper.append(icon, copy);
  container.replaceChildren(wrapper);
}

function renderBudget() {
  const budget = currentState.budget || {};
  const cap = finite(budget.cap);
  const available = finite(budget.available);
  const reserved = finite(budget.reserved);
  const spent = finite(budget.spent);
  for (const [name, value] of Object.entries({ cap, available, reserved, spent })) $(`${name}-value`).textContent = number(value);
  for (const [name, value] of Object.entries({ available, reserved, spent })) $(`${name}-segment`).style.width = `${cap > 0 ? Math.max(0, Math.min(100, value / cap * 100)) : 0}%`;
  $('budget-track').setAttribute('aria-label', `${number(available)} available, ${number(reserved)} reserved, ${number(spent)} spent, out of a ${number(cap)} unit cap`);
  const valid = cap > 0 && available >= 0 && reserved >= 0 && spent >= 0 && spent + reserved <= cap && available + reserved + spent === cap;
  $('invariant-status').textContent = valid ? 'Intact' : 'Check failed';
  $('invariant-status').parentElement.classList.toggle('violation', !valid);
}

function renderModel() {
  $('model-name').textContent = modelName();
  const status = currentState?.model?.status;
  let label = 'Readiness unconfirmed';
  if (review) label = currentState.aiInference ? 'Inference recorded' : 'Recorded state';
  else if (busy() && ['plan', 'recover', 'scenario'].includes(activeAction)) label = 'Working';
  else if (modelAvailable()) label = 'Ready';
  else if (status === 'ready-to-load') label = 'Loads on request';
  else if (status === 'setup-required') label = 'Setup required';
  $('model-status').textContent = label;
  $('model-status').classList.toggle('unavailable', !review && status === 'setup-required');
  $('model-status').classList.toggle('running', !review && label === 'Working');
}

function renderPlans() {
  const plans = knownArray(currentState.plans);
  $('plan-count').textContent = String(plans.length);
  const list = $('plans-list');
  if (!plans.length) {
    appendEmpty(list, 'A proposal starts with your goal.', review ? 'No proposal exists at this checkpoint. Advance the recorded run to inspect the agent decision.' : 'The selected offer and explanation will appear here. No purchase happens during planning.', '⌘');
    return;
  }
  const cards = plans.slice().reverse().map((plan, reverseIndex) => {
    const proposal = plan.proposal || {};
    const auth = plan.authorization || {};
    const offer = offerFor(proposal.offerId);
    const card = node('article', { className: 'plan-card' });
    const header = node('div', { className: 'plan-header' });
    const actionLabels = { purchase: 'Purchase proposal', replace: 'Replacement proposal', wait: 'Wait recommendation', escalate: 'Review required' };
    header.append(node('span', { className: `small-tag ${plan.inference?.performed ? 'neural' : ''}` }, plan.inference?.performed ? 'Neural proposal' : 'Proposal'), node('span', { className: 'plan-sequence' }, `PLAN ${String(plans.length - reverseIndex).padStart(2, '0')}`));
    card.append(header, node('h3', {}, offer?.name || actionLabels[proposal.action] || 'Agent proposal'));
    const meta = node('div', { className: 'plan-offer-meta' });
    if (offer) {
      meta.append(node('strong', {}, `${number(offer.amount)} units`), node('span', { className: 'meta-divider' }, '/'), node('span', {}, chainName(offer.chain)), node('span', { className: 'meta-divider' }, '/'), node('span', {}, `${number(offer.etaSeconds)}s delivery`));
    } else meta.append(node('span', {}, actionLabels[proposal.action] || words(proposal.action)));
    card.append(meta, node('p', { className: 'field-note' }, 'Unverified model explanation. Review the service and terms before execution.'), node('p', { className: 'plan-reason' }, proposal.reason || 'No explanation was recorded.'));
    if (plan.inference) {
      const inferenceText = plan.inference.performed
        ? `${plan.inference.model || 'Recorded model'} · ${number(finite(plan.inference.durationMs) / 1000)}s inference`
        : 'No neural inference is claimed for this proposal.';
      card.append(node('p', { className: 'plan-model-line' }, inferenceText));
    }
    if (plan.goal) {
      const details = node('details', { dataset: { detailKey: `goal-${plan.id}` } });
      details.open = detailOpen.has(`goal-${plan.id}`);
      details.append(node('summary', {}, 'Original goal'), node('p', { className: 'plan-goal' }, plan.goal));
      details.addEventListener('toggle', () => updateDetail(`goal-${plan.id}`, details.open));
      card.append(details);
    }
    const footer = node('div', { className: 'plan-footer' });
    let note = 'Policy permits this proposal.';
    if (plan.operationId) note = 'This proposal already has a commitment.';
    else if (auth.requiresClosure) note = 'Close and finalize the prior commitment before spending again.';
    else if (!auth.executable) note = auth.blockedReason ? words(auth.blockedReason) : 'No execution is authorized.';
    else if (review) note = 'Recorded authorization at this checkpoint.';
    footer.append(node('p', { className: `authorization-note ${!auth.executable && !plan.operationId ? 'blocked' : ''}` }, note));
    if (!review && ['purchase', 'replace'].includes(proposal.action)) {
      const button = node('button', { type: 'button', className: 'button button-small button-primary', disabled: busy() || !auth.executable || Boolean(plan.operationId), dataset: { action: 'execute', planId: plan.id, mutation: 'true' } }, plan.operationId ? 'Committed' : 'Execute proposal');
      button.addEventListener('click', () => mutate('execute', { planId: plan.id, fault: $('fault-mode').value }));
      footer.append(button);
    } else footer.append(node('span', { className: `small-tag ${!auth.executable ? 'blocked' : ''}` }, plan.operationId ? 'Committed' : auth.executable ? 'Allowed' : 'Held'));
    card.append(footer);
    return card;
  });
  list.replaceChildren(...cards);
}

function updateDetail(key, open) { if (open) detailOpen.add(key); else detailOpen.delete(key); }
function operationStatus(operation) {
  const raw = String(operation.status || 'pending');
  if (operation.closureFinalized) return { label: 'Closure finalized', tone: 'success', note: finite(operation.consumed) > 0 ? 'Consumption remains spent' : 'Unused authority released' };
  if (operation.closureObserved) return { label: 'Awaiting finalization', tone: 'pending', note: 'Reservation is still held' };
  if (operation.receiptMissing) return { label: 'Receipt missing', tone: 'pending', note: finite(operation.consumed) > 0 ? 'Payment needs reconciliation' : 'Closure needs reconciliation' };
  if (/rejected|blocked|failed/.test(raw)) return { label: words(raw), tone: 'danger', note: 'No additional authority granted' };
  if (/paid|settled|completed/.test(raw) || finite(operation.consumed) > 0) return { label: words(raw), tone: 'success', note: 'Payment recorded at destination' };
  if (operation.grantDelayed) return { label: 'Grant delayed', tone: 'pending', note: 'Reservation remains active' };
  return { label: words(raw), tone: 'pending', note: 'Follow the receipt trail' };
}
function availableActions(operation) {
  if (Array.isArray(operation.actions)) return operation.actions;
  const actions = [];
  if (operation.receiptMissing) actions.push('retry');
  if (operation.grantDelayed) actions.push('late-grant');
  if (operation.closureObserved && !operation.closureFinalized) actions.push('finalize');
  if (!operation.closureObserved && !operation.closureFinalized && finite(operation.consumed) === 0 && !/rejected|closed|cancelled/.test(String(operation.status))) actions.push('cancel', 'recover');
  return actions;
}
function renderReceipts(operation) {
  const receipts = knownArray(operation.transactions);
  const details = node('details', { className: 'receipt-details', dataset: { detailKey: `receipt-${operation.id}` } });
  details.open = detailOpen.has(`receipt-${operation.id}`);
  details.append(node('summary', {}, `${receipts.length} local receipt${receipts.length === 1 ? '' : 's'} · ${shortId(operation.id, 12, 6)}`));
  details.addEventListener('toggle', () => updateDetail(`receipt-${operation.id}`, details.open));
  if (receipts.length) {
    const table = node('table');
    const head = node('thead'); const headRow = node('tr');
    for (const label of ['Chain', 'Transaction', 'Block']) headRow.append(node('th', { scope: 'col' }, label));
    head.append(headRow); table.append(head);
    const body = node('tbody');
    for (const receipt of receipts) {
      const row = node('tr');
      const transactionCell = node('td');
      const hash = String(receipt.transactionHash || receipt.hash || '');
      const hashLine = node('div', { className: 'receipt-hash' });
      hashLine.append(node('code', {}, hash));
      if (hash) hashLine.append(copyButton(hash));
      transactionCell.append(hashLine);
      row.append(node('td', {}, chainName(receipt.chain || receipt.chainId)), transactionCell, node('td', { className: 'mono' }, receipt.blockNumber ?? ''));
      body.append(row);
    }
    table.append(body); details.append(table);
  }
  details.append(node('p', { className: 'receipt-note' }, 'These receipts belong to local EVMs. They are not public explorer transactions.'));
  return details;
}
function copyButton(value) {
  const button = node('button', { type: 'button', className: 'copy-button', 'aria-label': 'Copy transaction hash' }, 'Copy');
  button.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
      window.setTimeout(() => { if (button.isConnected) button.textContent = 'Copy'; }, 1800);
    } catch { announce('Clipboard access is unavailable. Select the transaction hash to copy it.', true); }
  });
  return button;
}
function renderOperations() {
  const operations = knownArray(currentState.operations);
  $('operation-count').textContent = String(operations.length);
  const list = $('operations-list');
  if (!operations.length) {
    appendEmpty(list, 'No spending authority committed.', review ? 'This checkpoint precedes the first commitment. Advance the recorded run to continue.' : 'Execute an approved proposal to create a commitment. Reservations and payments appear here.');
    return;
  }
  const cards = operations.slice().reverse().map((operation) => {
    const card = node('article', { className: 'commitment-card' });
    const top = node('div', { className: 'commitment-top' });
    const offer = offerFor(operation.offerId);
    const copy = node('div'); const title = node('div', { className: 'operation-title' });
    title.append(node('h3', {}, operation.offerName || offer?.name || 'Commitment'));
    const meta = node('div', { className: 'operation-meta' });
    const agentLabel = operation.agentIndex ? `Agent ${operation.agentIndex}` : /^0x[0-9a-f]{40}$/i.test(operation.agent || '') ? `Agent ${shortId(operation.agent, 5, 3)}` : operation.agent || 'Authorized agent';
    meta.append(node('span', {}, chainName(operation.chain)), node('span', { className: 'meta-divider' }, '/'), node('span', { title: operation.agent || '' }, agentLabel), node('code', {}, shortId(operation.id)));
    copy.append(title, meta);
    const amount = node('div', { className: 'operation-amount' });
    amount.append(node('strong', {}, number(operation.amount)), node('span', {}, 'units requested'));
    const state = operationStatus(operation); const status = node('div', { className: 'operation-state' });
    status.append(node('span', { className: `status-pill ${state.tone}` }, state.label), node('small', {}, state.note));
    top.append(copy, amount, status); card.append(top);
    const bottom = node('div', { className: 'operation-bottom' });
    const actions = node('div', { className: 'operation-actions' });
    if (!review) {
      const labels = { cancel: 'Request cancellation', retry: 'Retry receipt', 'late-grant': 'Deliver delayed grant', finalize: 'Confirm local closure', recover: 'Find replacement' };
      for (const action of availableActions(operation)) {
        if (!labels[action]) continue;
        const confirmsSupplierReady = action === 'retry' && operation.retryRequiresReadinessConfirmation === true;
        const button = node('button', { type: 'button', className: `button button-small ${action === 'finalize' ? 'button-primary' : action === 'cancel' ? 'button-danger' : 'button-secondary'}`, disabled: busy(), dataset: { mutation: 'true' } }, confirmsSupplierReady ? 'Supplier ready, retry' : labels[action]);
        if (action === 'recover') {
          button.setAttribute('aria-expanded', String(recoveryOpen.has(operation.id)));
          button.addEventListener('click', () => {
            if (recoveryOpen.has(operation.id)) recoveryOpen.delete(operation.id); else recoveryOpen.add(operation.id);
            renderOperations();
            if (recoveryOpen.has(operation.id)) document.querySelector(`[data-focus-key="recovery-${CSS.escape(operation.id)}"]`)?.focus({ preventScroll: true });
          });
        } else button.addEventListener('click', () => mutate(action, { operationId: operation.id, ...(confirmsSupplierReady ? { confirmSupplierReady: true } : {}) }));
        actions.append(button);
      }
    } else actions.append(node('span', { className: 'read-only-caption' }, 'Recorded commitment. Transactions cannot be sent from this view.'));
    if (actions.childElementCount) bottom.append(actions);
    if (!review && operation.retryRequiresReadinessConfirmation === true && availableActions(operation).includes('retry')) {
      bottom.append(node('p', { className: 'read-only-caption' }, 'Use this retry only after you have confirmed the supplier can accept the request.'));
    }
    bottom.append(renderReceipts(operation)); card.append(bottom);
    if (!review && recoveryOpen.has(operation.id)) card.append(renderRecoveryForm(operation));
    return card;
  });
  list.replaceChildren(...cards);
}
function renderRecoveryForm(operation) {
  const form = node('form', { className: 'recovery-form' });
  const fieldId = `recovery-${operation.id}`;
  const label = node('label', { for: fieldId }, 'What did the supplier report?');
  const textarea = node('textarea', { id: fieldId, rows: '3', maxlength: '2400', required: '', placeholder: 'For example: Our private processing pool is unavailable today. We cannot accept your invoice batch.', disabled: busy(), dataset: { focusKey: fieldId } });
  textarea.value = recoveryDrafts.get(operation.id) || '';
  textarea.addEventListener('input', () => recoveryDrafts.set(operation.id, textarea.value));
  const footer = node('div', { className: 'recovery-form-footer' });
  footer.append(node('p', {}, 'The agent can propose a replacement. Existing authority must close and finalize before it can spend again.'), node('button', { type: 'submit', className: 'button button-small button-primary', disabled: busy(), dataset: { mutation: 'true' } }, 'Ask for recovery plan'));
  form.append(label, textarea, footer);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = textarea.value.trim();
    if (!value) return;
    await mutate('recover', { operationId: operation.id, failureMessage: value });
  });
  return form;
}

function timestamp(value) {
  if (!value) return '';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function renderEvents() {
  const events = knownArray(currentState.events);
  $('event-count').textContent = String(events.length);
  const list = $('events-list');
  if (!events.length) { list.replaceChildren(node('li', { className: 'timeline-empty' }, 'Waiting for the first event.')); return; }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 35;
  const oldTop = list.scrollTop;
  const rows = events.map((event) => {
    const tone = /model|plan|proposal|agent/.test(event.type || '') ? 'model' : /reject|delay|missing|cancel|wait|fail|blocked/.test(event.type || '') ? 'warning' : /paid|settle|final|complete|recover/.test(event.type || '') ? 'success' : '';
    const row = node('li', { className: `timeline-event ${tone}` });
    row.append(node('span', { className: 'timeline-marker', 'aria-hidden': 'true' }));
    const body = node('div'); const header = node('div', { className: 'timeline-event-header' });
    header.append(node('h3', {}, event.title || words(event.type || 'Event')), node('time', { className: 'timeline-time', title: String(event.time || '') }, timestamp(event.time)));
    body.append(header);
    if (event.detail) body.append(node('p', {}, typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail)));
    if (event.budget) {
      const ledger = node('div', { className: 'timeline-budget' });
      ledger.append(node('span', {}, `AVAILABLE ${number(event.budget.available)}`), node('span', {}, `RESERVED ${number(event.budget.reserved)}`), node('span', {}, `SPENT ${number(event.budget.spent)}`));
      body.append(ledger);
    }
    const tx = event.transaction;
    if (tx?.transactionHash || tx?.hash) {
      const hash = tx.transactionHash || tx.hash;
      const receipt = node('div', { className: 'timeline-receipt' });
      receipt.append(node('code', { title: hash }, `${chainName(tx.chain || tx.chainId)} · ${shortId(hash, 14, 8)}`), copyButton(hash));
      body.append(receipt);
    }
    row.append(body); return row;
  });
  list.replaceChildren(...rows);
  list.scrollTop = atBottom ? list.scrollHeight : oldTop;
}
function renderOffers() {
  const offers = knownArray(currentState.offers);
  $('offer-count').textContent = String(offers.length);
  const rows = offers.map((offer) => {
    const row = node('article', { className: `offer-item ${offer.available === false ? 'unavailable' : ''}` });
    const top = node('div', { className: 'offer-top' });
    const price = node('div', { className: 'offer-price' }, number(offer.amount)); price.append(node('span', {}, 'units'));
    top.append(node('h3', {}, offer.name || offer.id), price);
    row.append(top, node('p', { className: 'offer-description' }, offer.description || words(offer.service)));
    const tags = node('div', { className: 'offer-tags' });
    for (const label of [chainName(offer.chain), `${number(offer.etaSeconds)}s`, offer.privacy === 'private' ? 'Private' : 'Shared']) tags.append(node('span', {}, label));
    if (offer.available === false) tags.append(node('span', { className: 'unavailable' }, 'Unavailable'));
    row.append(tags); return row;
  });
  $('offers-list').replaceChildren(...rows);
}

function renderControls() {
  const disabled = !currentState || Boolean(review) || busy();
  $('plan-button').disabled = disabled;
  $('scenario-button').disabled = disabled;
  $('reset-button').disabled = disabled;
  $('export-button').disabled = !currentState;
  for (const id of ['goal', 'required-service', 'deadline', 'require-private', 'fault-mode']) $(id).disabled = disabled;
  $('require-private').checked = true;
  $('require-private').disabled = true;
  if (currentState?.policy?.maxEtaSeconds) $('deadline').max = String(currentState.policy.maxEtaSeconds);
  if (review) {
    $('scenario-button').hidden = true;
    $('scenario-note').textContent = 'Inspect the recorded run below.';
    $('reset-button').hidden = true;
    $('recorded-plan-note').hidden = false;
    $('planning-hint').textContent = 'This view contains recorded decisions. It does not call a model or send transactions.';
  } else {
    $('scenario-button').hidden = false;
    $('scenario-note').textContent = 'Uses a fresh local ledger.';
    $('reset-button').hidden = false;
    $('recorded-plan-note').hidden = true;
    $('planning-hint').textContent = busy() ? 'The runtime is working. The ledger and execution trail continue to update.'
      : modelAvailable() ? 'The model interprets your request. Code selects approved terms. Review the proposal before execution.'
      : currentState?.model?.status === 'ready-to-load' ? 'The first planning request loads the local model. Planning itself does not spend budget.'
      : currentState?.model?.status === 'setup-required' ? 'Local model setup is required. A planning request will report the missing setup without spending budget.'
      : 'Model readiness is unconfirmed. A planning request will check the connection and report any failure.';
  }
  $('activity-bar').hidden = !busy() || Boolean(review);
  const labels = { plan: 'Agent is evaluating approved offers', recover: 'Agent is interpreting the supplier response', scenario: 'Running the recovery demonstration', execute: 'Executing the bounded proposal', cancel: 'Closing the destination permit', retry: 'Recovering a missing receipt', 'late-grant': 'Delivering the delayed grant', finalize: 'Checking and finalizing local closure', reset: 'Creating a fresh local ledger' };
  $('activity-text').textContent = labels[activeAction] || 'Local runtime is working';
}
function applyState(state, { force = false } = {}) {
  if (!state || typeof state !== 'object' || !state.sessionId || !state.budget) throw new Error('The runtime returned an invalid state snapshot.');
  const previousSession = currentState?.sessionId;
  currentState = state;
  if (previousSession && previousSession !== state.sessionId) {
    recoveryOpen.clear(); recoveryDrafts.clear(); detailOpen.clear(); lastRenderKey = '';
  }
  $('connection-panel').hidden = true;
  $('environment-label').textContent = review ? 'Recorded review' : 'Local EVM';
  $('session-label').textContent = `SESSION ${String(state.sessionId).replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase()}`;
  document.body.classList.toggle('recorded-mode', Boolean(review));
  if (review) {
    const recordedPlan = knownArray(state.plans).at(-1);
    if (recordedPlan?.goal) $('goal').value = recordedPlan.goal;
    if (recordedPlan?.policySettings?.requiredService) $('required-service').value = recordedPlan.policySettings.requiredService;
    if (recordedPlan?.policySettings?.maxEtaSeconds) $('deadline').value = String(recordedPlan.policySettings.maxEtaSeconds);
  }
  const key = JSON.stringify([state.budget, state.plans, state.operations, state.events, state.offers, state.model, state.aiInference, busy(), Boolean(review)]);
  if (force || key !== lastRenderKey) {
    preserveFocus(() => { renderBudget(); renderModel(); renderPlans(); renderOperations(); renderEvents(); renderOffers(); });
    lastRenderKey = key;
  }
  renderControls();
}

async function jsonResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server did not return a JSON response.'); }
  if (!response.ok) {
    const message = data?.error?.message || words(data?.error?.code) || `Request failed with status ${response.status}.`;
    const error = new Error(message); error.code = data?.error?.code; throw error;
  }
  return data;
}
async function refresh() {
  if (review || refreshInFlight) return;
  refreshInFlight = true;
  const epoch = updateEpoch;
  try {
    const response = await fetch('/api/state', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const state = await jsonResponse(response);
    if (epoch === updateEpoch) applyState(state);
  } catch (error) {
    if (!requestInFlight) setConnection(`The local runtime is unavailable. ${error.message}`, true);
  } finally { refreshInFlight = false; }
}
async function mutate(action, body = {}) {
  if (review || busy() || !currentState) return;
  requestInFlight = true; activeAction = action; updateEpoch++;
  applyState(currentState, { force: true });
  try {
    const response = await fetch(`/api/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sessionId: currentState.sessionId, ...body }),
      signal: AbortSignal.timeout(action === 'scenario' ? 240000 : 100000),
    });
    const result = await jsonResponse(response);
    updateEpoch++;
    if (result.state) applyState(result.state, { force: true });
    if (action === 'recover' && body.operationId) recoveryOpen.delete(body.operationId);
    const labels = { plan: 'Proposal recorded. Review the offer and policy result before execution.', recover: 'Recovery proposal recorded. Existing authority stays reserved until closure is finalized.', scenario: 'Recovery demonstration completed. Inspect the commitments and execution trail.', reset: 'A fresh local ledger is ready.', finalize: 'Local closure check completed. The ledger shows the resulting authority.', execute: 'Commitment processed. Its current state is shown below.', cancel: 'Cancellation processed. Budget release still requires finalization.', retry: 'Receipt retry processed. The ledger shows the observed result.', 'late-grant': 'Delayed grant delivered. Inspect whether the destination accepted it.' };
    announce(labels[action] || 'State updated.');
  } catch (error) {
    announce(error.name === 'TimeoutError' ? 'The request is taking longer than expected. Check the current state before retrying; the runtime may still be working.' : error.message, true);
  } finally {
    requestInFlight = false; activeAction = ''; updateEpoch++;
    if (currentState) applyState(currentState, { force: true });
    await refresh();
  }
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = node('a', { href: url, download: filename });
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportEvidence() {
  try {
    const evidence = review || await jsonResponse(await fetch('/api/evidence', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) }));
    downloadJson(evidence, `commitbook-evidence-${String(currentState?.sessionId || 'review').replace(/[^a-z0-9]/gi, '').slice(0, 12)}.json`);
    announce('Evidence downloaded. Local and public execution are labelled separately.');
  } catch (error) { announce(error.message, true); }
}
function stopReplay() { if (replayTimer) window.clearInterval(replayTimer); replayTimer = null; $('replay-play').textContent = 'Play recorded run'; }
function checkpoints() { return knownArray(review?.checkpoints).length ? review.checkpoints : [{ label: 'Final recorded state', state: review.state }]; }
function showCheckpoint(index) {
  const points = checkpoints(); replayIndex = Math.max(0, Math.min(points.length - 1, index));
  const point = points[replayIndex];
  applyState(point.state, { force: true });
  $('replay-position').max = String(points.length - 1); $('replay-position').value = String(replayIndex);
  $('replay-count').textContent = `${replayIndex + 1} / ${points.length}`;
  $('replay-label').textContent = point.label || `Checkpoint ${replayIndex + 1}`;
  $('replay-previous').disabled = replayIndex === 0;
  $('replay-next').disabled = replayIndex === points.length - 1;
  $('replay-play').disabled = points.length < 2;
  $('replay-position').disabled = points.length < 2;
}
function playReplay() {
  if (replayTimer) { stopReplay(); return; }
  if (replayIndex === checkpoints().length - 1) showCheckpoint(0);
  $('replay-play').textContent = 'Pause playback';
  replayTimer = window.setInterval(() => {
    if (replayIndex >= checkpoints().length - 1) { stopReplay(); return; }
    showCheckpoint(replayIndex + 1);
  }, 2400);
}
function renderEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return;
  $('evaluation-panel').hidden = false;
  const container = $('evaluation-content'); container.replaceChildren();
  const summary = evaluation.summary || evaluation.metrics || {};
  const values = [
    ['Cases evaluated', summary.totalCases ?? summary.cases ?? evaluation.totalCases ?? (Array.isArray(evaluation.cases) ? evaluation.cases.length : undefined)],
    ['Model choices correct', summary.modelCorrect ?? summary.neuralCorrect],
    ['Baseline choices correct', summary.baselineCorrect ?? summary.rulesCorrect],
    ['Unsafe executions', summary.unsafeExecutions],
  ].filter(([, value]) => typeof value === 'number');
  if (values.length) {
    const stats = node('div', { className: 'evaluation-stats' });
    for (const [label, value] of values) { const stat = node('div', { className: 'evaluation-stat' }); stat.append(node('strong', {}, number(value)), node('span', {}, label)); stats.append(stat); }
    container.append(stats);
  }
  const description = evaluation.conclusion || evaluation.note || summary.conclusion || 'These are the recorded evaluation results. Model interpretation, deterministic policy checks, and transaction execution are separate checks.';
  container.append(node('p', { className: 'evaluation-description' }, typeof description === 'string' ? description : JSON.stringify(description)));
  const details = node('details'); details.append(node('summary', {}, 'Inspect evaluation data'), node('pre', { className: 'evaluation-json' }, JSON.stringify(evaluation, null, 2))); container.append(details);
}
async function loadReview() {
  const response = await fetch('./review.json', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  const payload = await jsonResponse(response);
  if (payload.recorded !== true || !payload.state?.sessionId) throw new Error('No recorded review is available.');
  review = payload;
  // A review may link only to a ZIP inside this same site's relative path tree.
  // Reject schemes, absolute paths, traversal segments, queries and encoded paths.
  const sourcePath = typeof payload.sourceUrl === 'string' ? payload.sourceUrl : '';
  const safeSourcePath = /^(?:\.\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.zip$/i.test(sourcePath);
  const sourceUrl = safeSourcePath ? new URL(sourcePath, window.location.href) : null;
  if (sourceUrl && sourceUrl.origin === window.location.origin) {
    $('source-link').href = sourceUrl.href;
    $('source-link').hidden = false;
  } else {
    $('source-link').removeAttribute('href');
    $('source-link').hidden = true;
  }
  $('review-panel').hidden = false;
  $('review-title').textContent = payload.title || 'Inspect the run, step by step.';
  const summary = typeof payload.summary === 'string' ? payload.summary : 'A recorded local EVM run. The checkpoint player reveals the proposals, receipts, and budget changes.';
  $('review-summary').textContent = `${summary} Playback does not send transactions or run the model.`;
  $('evidence-boundary').textContent = 'Recorded local execution. Model calls and simulated transport are identified in the evidence. Public testnet deployment remains unverified.';
  renderEvaluation(payload.evaluation);
  showCheckpoint(0);
}
async function boot() {
  if (document.documentElement.dataset.mode === 'recorded') {
    setConnection('Loading the recorded review...');
    try { await loadReview(); }
    catch (error) { setConnection(`The recorded review could not load. ${error.message}`, true); $('environment-label').textContent = 'Not connected'; }
    return;
  }
  setConnection('Connecting to the local runtime...');
  try {
    const response = await fetch('/api/state', { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (response.status === 404 || response.status === 405 || !response.headers.get('content-type')?.includes('json')) { await loadReview(); return; }
    applyState(await jsonResponse(response));
    if (!pollTimer) pollTimer = window.setInterval(refresh, 1200);
  } catch (error) {
    try { await loadReview(); }
    catch { setConnection(`No local runtime or recorded review is available. ${error.message}`, true); $('environment-label').textContent = 'Not connected'; }
  }
}

$('plan-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const goal = $('goal').value.trim();
  if (!goal) return;
  mutate('plan', { goal, policy: { requiredService: $('required-service').value, requirePrivate: $('require-private').checked, maxEtaSeconds: Number($('deadline').value) } });
});
$('scenario-button').addEventListener('click', () => mutate('scenario'));
$('reset-button').addEventListener('click', () => mutate('reset'));
$('export-button').addEventListener('click', exportEvidence);
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('reconnect-button').addEventListener('click', () => { if (currentState && !review) refresh(); else boot(); });
$('replay-previous').addEventListener('click', () => { stopReplay(); showCheckpoint(replayIndex - 1); });
$('replay-next').addEventListener('click', () => { stopReplay(); showCheckpoint(replayIndex + 1); });
$('replay-play').addEventListener('click', playReplay);
$('replay-position').addEventListener('input', () => { stopReplay(); showCheckpoint(Number($('replay-position').value)); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentState && !review) refresh(); });
window.addEventListener('pagehide', () => { stopReplay(); if (pollTimer) window.clearInterval(pollTimer); });

await boot();
