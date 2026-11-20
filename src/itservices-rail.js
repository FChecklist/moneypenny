// The rail adapter for IT SERVICES BY RAJAT AGARWAL (central payment service). Only Moneypenny calls it.
//   createOrder -> POST {base}/api/pay/credit-order   opens the Razorpay order and returns what the payment window needs
//   verify      -> POST {base}/api/pay/credit-verify  asks IT Services to check the payment with Razorpay and say who/what/how much
// The site key is a secret held by Moneypenny alone (a Worker secret). Nothing here runs unless the settings are present.
// `fetchImpl` is injectable so tests use a stand-in; no live call is made by any test.
export function itServicesRail({ baseUrl, site, siteKey, fetchImpl = fetch, name = 'IT Services by Rajat Agarwal' }) {
  if (!baseUrl || !site || !siteKey) throw new Error('itServicesRail needs baseUrl, site and siteKey');
  const call = async (path, body) => {
    const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-site-key': siteKey }, body: JSON.stringify({ site, ...body }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(String(data?.error ?? `status ${r.status}`).slice(0, 80));
      e.code = `its_${r.status}`;
      throw e;
    }
    return data;
  };
  return {
    name: 'it_services',
    // must be safe to call twice with the same order_id: IT Services returns the same Razorpay order for the same payment_ref
    async createOrder(o) {
      const d = await call('/api/pay/credit-order', { payment_ref: o.order_id, mp_order_ref: o.order_ref, credits: o.credits, amount_minor: o.amount_minor, currency: o.currency, payer_email: o.payer_email, game_id: o.game_ref ?? undefined });
      if (typeof d.orderId !== 'string' || typeof d.keyId !== 'string') throw new Error('its_bad_answer');
      return { rail_order_id: d.orderId, pay_url: null, payframe: { key: d.keyId, order_id: d.orderId, amount: d.amount_minor, currency: d.currency, name, description: 'Game payment', prefill: { email: o.payer_email ?? undefined } } };
    },
    async verify(v) {
      const d = await call('/api/pay/credit-verify', { razorpay_order_id: v.razorpay_order_id, razorpay_payment_id: v.razorpay_payment_id, razorpay_signature: v.razorpay_signature });
      // order_payer_email is the e-mail fixed when the order was made, never the one typed into the card window
      return { paid: d.paid === true, rail_order_id: d.razorpay_order_id, payment_ref: d.razorpay_payment_id, amount_minor: d.amount_minor, currency: d.currency, payer_email: d.order_payer_email, mp_order_id: d.payment_ref };
    },
    async health() {
      return { ok: true };
    },
    async instruct() {
      throw new Error('rail_cannot_instruct'); // payouts are not part of this rail
    },
  };
}
