// ── ACQUISITION PIPELINE ──
// The 16-step buy → on-sell flow. Each lead sits at exactly one stage.

export const STAGES = [
  { key: 'new',               step: 1,  label: 'Ingested' },
  { key: 'needs_valuation',   step: 2,  label: 'Needs valuation' },
  { key: 'draft',             step: 3,  label: 'Awaiting approval' },
  { key: 'contacted',         step: 3,  label: 'Intro sent' },
  { key: 'negotiating',       step: 4,  label: 'Negotiating' },
  { key: 'agreed',            step: 5,  label: 'Price agreed' },
  { key: 'agreement_sent',    step: 6,  label: 'Purchase agreement sent' },
  { key: 'inspection',        step: 7,  label: 'Inspection' },
  { key: 'documents',         step: 8,  label: 'Collecting documents' },
  { key: 'dms_loaded',        step: 9,  label: 'Loaded into Easy Cars' },
  { key: 'selling',           step: 10, label: 'On-selling to dealers' },
  { key: 'seller_paid',       step: 11, label: 'Seller paid' },
  { key: 'in_stock',          step: 12, label: 'In dealership stock' },
  { key: 'invoiced',          step: 13, label: 'Invoiced to buying dealer' },
  { key: 'transport',         step: 14, label: 'Transport arranged' },
  { key: 'payment_received',  step: 15, label: 'Dealer payment received' },
  { key: 'delivered',         step: 16, label: 'Disposed to buying dealer' },
  // Off-ramps
  { key: 'rejected',          step: 0,  label: 'Rejected' },
  { key: 'lost',              step: 0,  label: 'Lost / seller declined' },
  { key: 'opted_out',         step: 0,  label: 'Opted out' },
];

export const STAGE_KEYS = STAGES.map(s => s.key);
const order = key => STAGE_KEYS.indexOf(key);

export const DEALER_PAYMENT_HOURS = 72;
export const PAYOUT_VALID_DAYS = 14;

// Step 8 — what we need before we can transact
export function documentChecklist(lead) {
  const d = lead.documents || {};
  const deal = lead.deal || {};
  const items = [
    { key: 'registration', label: 'Registration papers', done: !!d.registration },
    { key: 'licence', label: 'Seller licence copy', done: !!d.licence },
    { key: 'bankDetails', label: 'Seller bank details', done: !!d.bankDetails },
  ];

  if (d.companyOwned) {
    items.push({ key: 'taxInvoice', label: 'Company tax invoice incl. GST (ABN)', done: !!d.taxInvoice });
  }

  if (d.financeOwing) {
    const item = { key: 'payoutLetter', label: `Finance payout letter (valid ${PAYOUT_VALID_DAYS} days from sale date)`, done: false };
    if (d.payoutLetter && d.payoutValidUntil) {
      const saleDate = deal.agreedDate ? new Date(deal.agreedDate) : new Date();
      const needed = new Date(saleDate.getTime() + PAYOUT_VALID_DAYS * 86400000);
      item.done = new Date(d.payoutValidUntil) >= needed;
      if (!item.done) item.problem = `Payout letter expires ${d.payoutValidUntil}; needs to be valid until ${needed.toISOString().slice(0, 10)}`;
    } else if (d.payoutLetter) {
      item.problem = 'Enter the payout letter expiry date';
    }
    items.push(item);
  }

  return { items, complete: items.every(i => i.done) };
}

// Things that need attention on a lead (shown as warnings in the dashboard)
export function alerts(lead, now = new Date()) {
  const out = [];
  const deal = lead.deal || {};
  if (lead.stage === 'invoiced' || lead.stage === 'transport') {
    if (deal.invoicedAt) {
      const due = new Date(new Date(deal.invoicedAt).getTime() + DEALER_PAYMENT_HOURS * 3600000);
      if (now > due) out.push(`Dealer payment overdue (due ${due.toISOString().slice(0, 16).replace('T', ' ')})`);
    }
  }
  if (order(lead.stage) >= order('documents') && order(lead.stage) <= order('delivered')) {
    for (const i of documentChecklist(lead).items) if (i.problem) out.push(i.problem);
  }
  return out;
}

// Validate a stage move. Returns an error string, or null if allowed.
export function checkStageMove(lead, to) {
  if (!STAGE_KEYS.includes(to)) return `Unknown stage: ${to}`;
  if (lead.stage === 'opted_out' && to !== 'opted_out') return 'Seller opted out — cannot re-open';
  if (order(to) >= order('agreed') && order(to) <= order('delivered') && !lead.deal?.agreedPrice) {
    return 'Record the agreed price first';
  }
  // Don't pay a seller (step 11) until paperwork is in
  if (order(to) > order('documents') && order(to) <= order('delivered') && !documentChecklist(lead).complete) {
    return 'Document checklist incomplete';
  }
  if (order(to) >= order('seller_paid') && order(to) <= order('delivered') && !lead.deal?.buyingDealer) {
    return 'Record the buying dealer first';
  }
  return null;
}

export function moveStage(lead, to, note) {
  const now = new Date().toISOString();
  lead.history = lead.history || [];
  lead.history.push({ at: now, from: lead.stage, to, note: note || null });
  lead.stage = to;
  lead.deal = lead.deal || {};
  // Timestamps the 72h payment window and reporting rely on
  const stamp = { agreed: 'agreedDate', invoiced: 'invoicedAt', seller_paid: 'sellerPaidAt', payment_received: 'paymentReceivedAt', delivered: 'deliveredAt' }[to];
  if (stamp && !lead.deal[stamp]) lead.deal[stamp] = now;
  return lead;
}
