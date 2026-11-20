import type { CaseView } from '../domain/cases.ts';
import type { TimelineItem } from '../domain/console.ts';
import type { AccessGrant, RefundState } from '../domain/types.ts';

/**
 * Small server-rendered UI. No client framework is required for the pilot:
 * pages are semantic HTML, safe by construction, and readable at 320px.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function wantsHtml(headers: Record<string, unknown>, query: URLSearchParams): boolean {
  if (query.get('format') === 'html') return true;
  const accept = String(headers['accept'] ?? '');
  return accept.includes('text/html');
}

export function refundBadge(state: RefundState | string | null | undefined): { label: string; cls: string } {
  switch (state) {
    case 'proposed':
      return { label: 'Refund proposed', cls: 'badge proposed' };
    case 'authorized':
      return { label: 'Refund authorized', cls: 'badge authorized' };
    case 'dispatch_pending':
    case 'dispatched':
      return { label: 'Refund pending provider settlement', cls: 'badge pending' };
    case 'settlement_investigation':
      return { label: 'Pending investigation', cls: 'badge pending investigation' };
    case 'settled':
      return { label: 'Refund settled', cls: 'badge settled' };
    case 'declined':
      return { label: 'Refund declined', cls: 'badge neutral' };
    case 'failed':
      return { label: 'Refund failed', cls: 'badge danger' };
    default:
      return { label: 'No refund', cls: 'badge neutral' };
  }
}

function statusBadge(state: string): string {
  const cls = state === 'delivered' || state === 'refunded'
    ? 'badge settled'
    : state === 'manual_review' || state === 'refund_review'
      ? 'badge pending investigation'
      : state === 'available' || state === 'refund_pending'
        ? 'badge pending'
        : 'badge neutral';
  return `<span class="${cls}">${escapeHtml(state.replaceAll('_', ' '))}</span>`;
}

function money(amountMinor: number | null | undefined, asset: string | null | undefined): string {
  if (amountMinor == null) return '—';
  return `${amountMinor} ${escapeHtml(asset ?? '')}`;
}

const CSS = `
:root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f4ef; color: #1d252d; }
* { box-sizing: border-box; }
body { margin: 0; }
a { color: #075fb6; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #f2b84b; outline-offset: 3px; }
main { width: min(1120px, 100%); margin: 0 auto; padding: 24px clamp(14px, 3vw, 32px) 48px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px clamp(14px, 3vw, 32px); background: #152536; color: #fff; }
.topbar a { color: #fff; }
.topbar nav { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.topbar form { margin: 0; }
.nav-button { min-height: 34px; border: 1px solid #7f95a8; border-radius: 6px; background: transparent; color: #fff; font: inherit; padding: 5px 10px; }
.brand { font-weight: 750; letter-spacing: .02em; }
h1 { font-size: clamp(1.8rem, 4vw, 3.2rem); line-height: 1; margin: 16px 0 10px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
p { line-height: 1.55; }
.muted { color: #5c6873; }
.grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(280px, .7fr); gap: 20px; align-items: start; }
.card { background: #fff; border: 1px solid #d9d5cc; border-radius: 8px; padding: 18px; box-shadow: 0 1px 2px rgba(20,30,40,.04); }
.card + .card { margin-top: 16px; }
.queue { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.queue a { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 14px; border: 1px solid #d9d5cc; border-radius: 8px; background: #fff; text-decoration: none; color: inherit; }
.queue a:hover { transform: translateY(-1px); border-color: #8aa4b8; }
.badge { display: inline-flex; align-items: center; width: fit-content; min-height: 28px; padding: 3px 9px; border-radius: 999px; border: 1px solid #aab4bd; font-size: .83rem; font-weight: 700; }
.badge::before { content: ''; width: .55rem; height: .55rem; border-radius: 50%; margin-right: 7px; background: currentColor; }
.badge.neutral { color: #44515c; background: #eef1f3; }
.badge.proposed { color: #684700; background: #fff2ca; border-color: #c59b36; }
.badge.authorized { color: #075083; background: #e5f2ff; border-color: #61a7d9; }
.badge.pending { color: #6d4a00; background: #fff4d7; border-color: #caa14c; }
.badge.investigation { color: #7c2d12; background: #ffeadf; border-color: #d97c51; }
.badge.settled { color: #155e3d; background: #e3f5eb; border-color: #4e9d74; }
.badge.danger { color: #8a1f1f; background: #fde7e7; border-color: #d46a6a; }
.timeline { margin: 0; padding: 0; list-style: none; }
.timeline li { position: relative; padding: 0 0 18px 28px; border-left: 2px solid #cfd7dd; margin-left: 8px; }
.timeline li::before { content: ''; position: absolute; left: -7px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #075fb6; border: 2px solid #fff; }
.timeline time { display: block; font-size: .82rem; color: #5c6873; margin-bottom: 3px; }
.timeline .label { font-weight: 750; }
.timeline .detail { color: #4d5a65; font-size: .92rem; margin-top: 3px; }
dl.facts { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 8px 14px; margin: 0; }
dl.facts dt { color: #5c6873; }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 14px 0 18px; }
.filters a, .button { border: 1px solid #8495a3; background: #fff; color: #1d252d; border-radius: 6px; min-height: 38px; padding: 8px 12px; text-decoration: none; font: inherit; }
.filters a[aria-current='true'], .button:hover { background: #e9f1f7; border-color: #075fb6; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.actions form { margin: 0; }
.status-line { margin: 12px 0; }
@media (max-width: 720px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .grid { grid-template-columns: 1fr; }
  main { padding-top: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

export function page(title: string, body: string, opts: { area?: 'buyer' | 'console' } = {}): string {
  const nav = opts.area === 'console'
    ? '<a href="/console">Case queue</a><form method="post" action="/logout"><button class="nav-button" type="submit">Sign out</button></form>'
    : opts.area === 'buyer'
      ? '<a href="/buyer">Your cases</a><form method="post" action="/logout"><button class="nav-button" type="submit">Sign out</button></form>'
      : '';
  return `<!doctype html>
<html lang="en" data-type="software">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="page-type" content="software">
<meta name="site-kind" content="software">
<title>${escapeHtml(title)} · DeliveryDesk</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar"><div class="brand">DeliveryDesk</div><nav aria-label="Primary">${nav}</nav></header>
<main>${body}</main>
</body>
</html>`;
}

function timelineHtml(items: TimelineItem[]): string {
  return `<ol class="timeline">${items.map((item) => `<li>
    <time datetime="${escapeHtml(item.at)}">${escapeHtml(item.at)}</time>
    <div class="label">${escapeHtml(item.label)}</div>
    <div class="detail">${escapeHtml(item.detail)}${item.href ? ` · <a href="${escapeHtml(item.href)}">Provider receipt</a>` : ''}</div>
  </li>`).join('')}</ol>`;
}

export function renderCasePage(view: CaseView, timeline: TimelineItem[], opts: { audience: 'buyer' | 'operator'; providerReceiptHref?: string }): string {
  const rb = refundBadge(view.refund?.state);
  const title = `Order ${view.externalOrderId}`;
  const refresh = opts.audience === 'buyer' && !['delivered', 'refunded', 'closed'].includes(view.state)
    ? `<form method="post" action="/cases/${escapeHtml(view.id)}/refresh"><button class="button" type="submit">Refresh case</button></form>`
    : '';
  const recovery = opts.audience === 'buyer' && view.fulfillment?.state === 'ready' && !['delivered', 'refunded', 'closed'].includes(view.state)
    ? `<form method="post" action="/cases/${escapeHtml(view.id)}/redelivery"><button class="button" type="submit">Recover original export</button></form>`
    : '';
  const continueRetrieval = opts.audience === 'buyer' && view.retrieval && ['claimed', 'streaming', 'interrupted', 'awaiting_receipt'].includes(view.retrieval.state)
    ? `<a class="button" href="/cases/${escapeHtml(view.id)}/retrieve">Continue retrieval</a>`
    : '';
  const owner = opts.audience === 'operator'
    ? `<dt>Owner</dt><dd>${escapeHtml(view.ownerOperatorId ?? 'Unassigned')}</dd>`
    : '';
  const receipt = opts.providerReceiptHref
    ? `<dt>Receipt</dt><dd><a href="${escapeHtml(opts.providerReceiptHref)}">Provider receipt ${escapeHtml(view.payment?.transferRef ?? '')}</a></dd>`
    : '';
  return page(title, `
    <p class="muted">${opts.audience === 'operator' ? 'Support case record' : 'Your delivery case'} · persisted version ${escapeHtml(view.version)}</p>
    <h1>${escapeHtml(title)}</h1>
    <div class="status-line" role="status" aria-live="polite">${statusBadge(view.state)} ${view.refund ? `<span class="${rb.cls}">${escapeHtml(rb.label)}</span>` : ''}</div>
    <div class="grid">
      <section class="card" aria-labelledby="timeline-title">
        <h2 id="timeline-title">Timeline</h2>
        ${timelineHtml(timeline)}
      </section>
      <aside>
        <section class="card" aria-labelledby="case-facts">
          <h2 id="case-facts">Case facts</h2>
          <dl class="facts">
            <dt>Case</dt><dd>${escapeHtml(view.id)}</dd>
            <dt>Reason</dt><dd>${escapeHtml(view.reason)}</dd>
            ${owner}
            <dt>Payment</dt><dd>${escapeHtml(view.payment?.state ?? 'not confirmed')} · ${money(view.refund?.amountMinor ?? null, view.refund?.asset ?? null)}</dd>
            ${receipt}
            <dt>Fulfillment</dt><dd>${escapeHtml(view.fulfillment ? `revision ${view.fulfillment.revision} · ${view.fulfillment.state}` : 'not reported')}</dd>
            <dt>Retrieval</dt><dd>${escapeHtml(view.retrieval ? `${view.retrieval.state} · ${view.retrieval.bytesTransferred} bytes` : 'not started')}</dd>
            <dt>Evidence</dt><dd>${escapeHtml(view.evidenceNote ?? view.fulfillment?.evidenceNote ?? 'pending evidence')}</dd>
          </dl>
        </section>
        <section class="card" aria-labelledby="next-actions">
          <h2 id="next-actions">Next action</h2>
          <p>${escapeHtml(nextActionCopy(view))}</p>
          <div class="actions">${recovery}${continueRetrieval}${refresh}</div>
        </section>
      </aside>
    </div>`, { area: opts.audience === 'operator' ? 'console' : 'buyer' });
}

function nextActionCopy(view: CaseView): string {
  if (view.state === 'delivered') return 'Delivery is closed with authenticated receipt evidence.';
  if (view.state === 'refunded') return 'Refund is settled; the payment and refund references are preserved.';
  if (view.refund?.state === 'settlement_investigation') return 'The refund provider did not confirm the outcome. Keep this pending investigation until settlement evidence exists.';
  if (view.retrieval && ['claimed', 'streaming', 'interrupted', 'awaiting_receipt'].includes(view.retrieval.state)) {
    return 'A retrieval is in progress or ambiguous; reconcile it before a refund dispatch.';
  }
  if (view.state === 'available') return 'Recover the original export, then confirm receipt to close delivery.';
  return 'Wait for merchant fulfillment evidence or reconcile the connector status.';
}

export function renderConsoleQueue(items: { id: string; externalOrderId: string; state: string; reason: string; stale: boolean; owner: string | null; refundState: string | null }[], filters: { stale: boolean; mine: boolean }): string {
  const rows = items.map((item) => {
    const rb = item.refundState ? refundBadge(item.refundState) : null;
    return `<li><a href="/console/cases/${escapeHtml(item.id)}">
      <span><strong>${escapeHtml(item.externalOrderId)}</strong><br><span class="muted">${escapeHtml(item.reason)}${item.owner ? ` · owner ${escapeHtml(item.owner)}` : ''}</span></span>
      <span>${statusBadge(item.state)}${item.stale ? ' <span class="badge investigation">Stale</span>' : ''}${rb ? ` <span class="${rb.cls}">${escapeHtml(rb.label)}</span>` : ''}</span>
    </a></li>`;
  }).join('');
  return page('Support console', `
    <h1>Support console</h1>
    <p class="muted">Merchant case queue. Filter ownership and stale cases without leaving the record.</p>
    <nav class="filters" aria-label="Case filters">
      <a href="/console" ${!filters.stale && !filters.mine ? 'aria-current="true"' : ''}>All cases</a>
      <a href="/console?mine=1" ${filters.mine ? 'aria-current="true"' : ''}>My cases</a>
      <a href="/console?stale=1" ${filters.stale ? 'aria-current="true"' : ''}>Stale cases</a>
    </nav>
    ${items.length ? `<ul class="queue">${rows}</ul>` : '<section class="card"><p>No cases match this filter.</p></section>'}`, { area: 'console' });
}

export function renderLogin(error?: string): string {
  return page('Sign in', `
    <h1>Sign in</h1>
    <p class="muted">Use a buyer or operator token issued by the merchant pilot.</p>
    ${error ? `<p role="alert" class="badge danger">${escapeHtml(error)}</p>` : ''}
    <section class="card" style="max-width: 560px">
      <form method="post" action="/login">
        <p><label for="audience">Work area</label><br>
        <select id="audience" name="audience">
          <option value="buyer">Buyer</option>
          <option value="operator">Support console</option>
        </select></p>
        <p><label for="token">Access token</label><br>
        <input id="token" name="token" type="password" autocomplete="current-password" required style="width:100%;min-height:40px"></p>
        <button class="button" type="submit">Sign in</button>
      </form>
    </section>`);
}

export function renderRetrievalPage(view: CaseView, grant: AccessGrant | undefined): string {
  const digest = view.fulfillment?.artifactDigest ?? view.retrieval?.digest ?? '';
  const content = view.state === 'delivered'
    ? `<section class="card" aria-labelledby="download-export"><h2 id="download-export">Export delivered</h2><p>Authenticated delivery evidence is recorded on this case.</p></section>`
    : grant
      ? `<section class="card" aria-labelledby="download-export">
          <h2 id="download-export">Download the original export</h2>
          <p>The grant is bound to this buyer and expires at <time datetime="${escapeHtml(grant.expires_at)}">${escapeHtml(grant.expires_at)}</time>.</p>
          <dl class="facts">
            <dt>Order</dt><dd>${escapeHtml(view.externalOrderId)}</dd>
            <dt>Expected digest</dt><dd><code>${escapeHtml(digest)}</code></dd>
          </dl>
          <div class="actions">
            <a class="button" href="/grants/${escapeHtml(grant.id)}/artifact" download>Download original export</a>
            <form method="post" action="/cases/${escapeHtml(view.id)}/acknowledge"><button class="button" type="submit">Confirm export received</button></form>
          </div>
        </section>`
      : `<section class="card" aria-labelledby="download-export">
          <h2 id="download-export">No active download grant</h2>
          <p>Issue a short-lived grant to retrieve the original export for this order.</p>
          <form method="post" action="/cases/${escapeHtml(view.id)}/redelivery"><button class="button" type="submit">Issue download grant</button></form>
        </section>`;
  return page(`Retrieve ${view.externalOrderId}`, `
    <p class="muted">${escapeHtml(view.state === 'delivered' ? 'Delivery is closed' : 'Authorized redelivery')} · persisted version ${escapeHtml(view.version)}</p>
    <h1>Retrieve order ${escapeHtml(view.externalOrderId)}</h1>
    <div class="status-line" role="status" aria-live="polite">${statusBadge(view.state)}</div>
    ${content}
    <p><a href="/cases/${escapeHtml(view.id)}">Back to the delivery case</a></p>`, { area: 'buyer' });
}

export function renderErrorPage(status: number, message: string): string {
  const title = status === 401
    ? 'Sign in required'
    : status === 403
      ? 'Access denied'
      : status === 404
        ? 'Page not found'
        : 'Request could not be completed';
  return page(title, `
    <h1>${escapeHtml(title)}</h1>
    <section class="card" role="alert">
      <p>${escapeHtml(message)}</p>
      <p><a class="button" href="/login">Go to sign in</a></p>
    </section>`);
}

export function renderBuyerIndex(items: { id: string; externalOrderId: string; state: string; reason: string }[]): string {
  const rows = items.map((item) => `<li><a href="/cases/${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.externalOrderId)}</strong><br><span class="muted">${escapeHtml(item.reason)}</span></span><span>${statusBadge(item.state)}</span></a></li>`).join('');
  return page('Your cases', `
    <h1>Your cases</h1>
    <p class="muted">Delivery recovery cases for your orders.</p>
    <section class="card" aria-labelledby="open-case">
      <h2 id="open-case">Open a recovery case</h2>
      <form method="post" action="/cases/open-by-external">
        <p><label for="external-order-id">Order ID</label><br>
        <input id="external-order-id" name="external_id" autocomplete="off" required style="width:100%;min-height:40px"></p>
        <button class="button" type="submit">Open recovery case</button>
      </form>
    </section>
    ${items.length ? `<ul class="queue">${rows}</ul>` : '<section class="card"><p>No recovery cases are open.</p></section>'}`, { area: 'buyer' });
}
