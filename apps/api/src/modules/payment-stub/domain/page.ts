const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const money = (kopecks: number): string => `${Math.floor(kopecks / 100)},${String(kopecks % 100).padStart(2, '0')} UAH`;

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1b1b1f}h1{font-size:1.3rem}
button{display:block;width:100%;margin:.6rem 0;padding:.8rem;font-size:1rem;border-radius:.5rem;border:1px solid #888;cursor:pointer}
.ok{background:#1c7c3d;color:#fff}.bad{background:#b3261e;color:#fff}.skip{background:#fff}</style></head><body>${body}</body></html>`;

/** The hosted payment page of the stub provider: three buttons, like a bank page in a sandbox. */
export const paymentPage = (payment: { id: string; amount: number; orderRef: string; status: string }): string =>
  shell('Payment stub', `<h1>Payment stub</h1><p>Order <b>${escape(payment.orderRef)}</b><br>Amount <b>${money(payment.amount)}</b><br>Status <b data-testid="status">${escape(payment.status)}</b></p>
${payment.status === 'pending'
    ? `<form method="post" action="/stub/pay/${escape(payment.id)}/success"><button class="ok" type="submit">Success</button></form>
<form method="post" action="/stub/pay/${escape(payment.id)}/failure"><button class="bad" type="submit">Failure</button></form>
<form method="post" action="/stub/pay/${escape(payment.id)}/close"><button class="skip" type="submit">Close without answer</button></form>`
    : '<p>This payment is already final.</p>'}`);

export const closedPage = (): string => shell('Payment stub', '<h1>Window closed</h1><p>No answer was sent to the shop.</p>');
