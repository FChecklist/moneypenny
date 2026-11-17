// Balance widget (stub). One number, one optional "can convert" line, skinnable.
// It only DISPLAYS what the server sent (get_balance().display). It never decides money.
// Original look only: plain shapes and our own words.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_THEME = { name: 'plain', accent: '#0b6b57' };

/** Returns an HTML string. `display` is the `display` object from the balance call. */
export function renderBalance(display, { theme } = {}) {
  const t = display.theme || theme || DEFAULT_THEME;
  const accent = /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : DEFAULT_THEME.accent;
  const themed = display.theme ? ` data-theme="${esc(t.name)}"` : '';
  const line = display.convert_line ? `<div class="mnp-line">${esc(display.convert_line)}</div>` : '';
  const settling = display.settling_line ? `<div class="mnp-line mnp-soft">${esc(display.settling_line)}</div>` : '';
  return (
    `<div class="mnp-balance"${themed} style="--mnp-accent:${accent}">` +
    `<div class="mnp-label">${esc(display.label)}</div>` +
    `<div class="mnp-amount">${esc(display.amount)}</div>${line}${settling}</div>`
  );
}

export const STYLE = `
.mnp-balance{font:15px/1.4 system-ui,sans-serif;display:inline-block;padding:10px 14px;border-radius:12px;border:2px solid var(--mnp-accent,#0b6b57);background:#fff;color:#1c1c1c}
.mnp-balance[data-theme="office"]{border-radius:4px 14px 4px 14px;box-shadow:3px 3px 0 var(--mnp-accent,#0b6b57)}
.mnp-label{font-size:12px;letter-spacing:.04em;color:var(--mnp-accent,#0b6b57)}
.mnp-amount{font-size:26px;font-weight:700}
.mnp-line{font-size:13px;margin-top:2px}.mnp-soft{opacity:.7}
@media (prefers-color-scheme:dark){.mnp-balance{background:#1b1b1b;color:#eee}}`;

/** <mnp-balance> element for browsers. Set .data = display object. */
export function defineElement(name = 'mnp-balance') {
  if (typeof customElements === 'undefined' || customElements.get(name)) return;
  customElements.define(
    name,
    class extends HTMLElement {
      set data(d) {
        this.attachShadow?.({ mode: 'open' });
        const root = this.shadowRoot || this;
        root.innerHTML = `<style>${STYLE}</style>${renderBalance(d)}`;
      }
    },
  );
}
