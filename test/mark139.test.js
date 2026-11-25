import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CSS = '.mark139{position:absolute;top:0;left:0;right:0;margin:0;padding:1px 0 0;text-align:center;line-height:1;pointer-events:none;user-select:none;z-index:2147483647;font-family:"Noto Sans Devanagari","Mukta","Nirmala UI","Mangal","Kohinoor Devanagari","Devanagari Sangam MN",sans-serif;font-size:6px;font-weight:700;color:#0B2A6B}\n.mark139 span{display:inline-block;border-bottom:.5px solid #7A1010;padding-bottom:.5px}';
const MARKUP = '<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>';

// Every page this product produces: static *.html files plus HTML strings built in code.
function staticHtml(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) staticHtml(p, out); else if (n.endsWith('.html')) out.push(p);
  }
  return out;
}

async function pages() {
  const list = staticHtml('.').map((p) => [p, readFileSync(p, 'utf8')]);
  const { adminPage } = await import('../src/admin-page.js');
  list.push(['src/admin-page.js (adminPage)', adminPage()]);
  return list;
}

test('mark 139: every page has exactly one mark, with the approved CSS and numerals', async () => {
  for (const [name, html] of await pages()) {
    assert.equal(html.split('class="mark139"').length - 1, 1, name + ': exactly one mark');
    assert.ok(html.includes(MARKUP), name + ': approved markup');
    assert.ok(html.includes(CSS), name + ': approved CSS');
    assert.ok(html.indexOf('mark139"') < html.indexOf('<h1'), name + ': mark comes first');
    for (const t of ['#0B2A6B', '#7A1010', '6px', '700', '.5px']) assert.ok(html.includes(t), name + ': ' + t);
    assert.ok(html.includes('१३९'), name + ': numerals');
  }
});
