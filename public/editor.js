/* Kiliw Cloud file editor: plain text, markdown (with preview) and
   simple Word documents (.docx — text, headings, b/i/u, bullet lists). */

const params = new URLSearchParams(location.search);
const path = params.get('p') || '';
const scope = params.get('scope') || '';
const name = path.split('/').pop() || '';
const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

const t = (key, vars) => KiliwUI.t(key, vars);
const scopeQ = scope ? `&scope=${encodeURIComponent(scope)}` : '';
const fileUrl = `/api/file?p=${encodeURIComponent(path)}&inline=1${scopeQ}`;

const MD_RE = /\.(md|markdown)$/i;
const DOCX_RE = /\.docx$/i;
const isMd = MD_RE.test(name);
const isDocx = DOCX_RE.test(name);

const textEl = document.getElementById('ed-text');
const richEl = document.getElementById('ed-rich');
const mdPreviewEl = document.getElementById('ed-md-preview');
const statusEl = document.getElementById('ed-status');
const loadingEl = document.getElementById('ed-loading');

document.getElementById('ed-name').textContent = name;
document.title = `${name} — Kiliw Cloud`;

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('ok', ok);
}

/* ---------- tiny markdown renderer (source is escaped first) ---------- */

function mdToHtml(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = esc(src).split('\n');
  const out = [];
  let list = null;
  let code = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      closeList();
      out.push(code ? '</code></pre>' : '<pre><code>');
      code = !code;
      continue;
    }
    if (code) { out.push(raw); continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(raw.trim())) { closeList(); out.push('<hr>'); continue; }
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    if (raw.match(/^&gt;\s?/)) { out.push(`<blockquote>${inline(raw.replace(/^&gt;\s?/, ''))}</blockquote>`); continue; }
    if (raw.trim() === '') continue;
    out.push(`<p>${inline(raw)}</p>`);
  }
  closeList();
  if (code) out.push('</code></pre>');
  return out.join('\n');
}

/* ---------- docx → HTML ---------- */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docxToHtml(buf) {
  const files = fflate.unzipSync(new Uint8Array(buf));
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('no document.xml');
  const xml = new TextDecoder().decode(docXml);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const out = [];
  let listOpen = false;
  const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');
  for (const p of paragraphs) {
    /* paragraph style: heading level / list item */
    let tag = 'p';
    let inList = false;
    const pPr = p.getElementsByTagNameNS(W_NS, 'pPr')[0];
    if (pPr) {
      const style = pPr.getElementsByTagNameNS(W_NS, 'pStyle')[0];
      const sv = style?.getAttributeNS(W_NS, 'val') || style?.getAttribute('w:val') || '';
      const hm = sv.match(/^Heading([1-6])$/i);
      if (hm) tag = `h${hm[1]}`;
      if (pPr.getElementsByTagNameNS(W_NS, 'numPr')[0]) inList = true;
    }

    /* runs → inline html (hyperlink runs included) */
    let inner = '';
    for (const r of p.getElementsByTagNameNS(W_NS, 'r')) {
      const rPr = r.getElementsByTagNameNS(W_NS, 'rPr')[0];
      let chunk = '';
      for (const node of r.childNodes) {
        if (node.localName === 't') chunk += escapeHtml(node.textContent);
        else if (node.localName === 'br') chunk += '<br>';
        else if (node.localName === 'tab') chunk += '&emsp;';
      }
      if (!chunk) continue;
      if (rPr) {
        if (rPr.getElementsByTagNameNS(W_NS, 'u')[0]) chunk = `<u>${chunk}</u>`;
        if (rPr.getElementsByTagNameNS(W_NS, 'i')[0]) chunk = `<em>${chunk}</em>`;
        if (rPr.getElementsByTagNameNS(W_NS, 'b')[0]) chunk = `<strong>${chunk}</strong>`;
      }
      inner += chunk;
    }

    if (inList) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inner || '<br>'}</li>`);
    } else {
      if (listOpen) { out.push('</ul>'); listOpen = false; }
      out.push(`<${tag}>${inner || '<br>'}</${tag}>`);
    }
  }
  if (listOpen) out.push('</ul>');
  return out.join('\n') || '<p><br></p>';
}

/* ---------- HTML → docx ---------- */

const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* flatten one block element into runs with inherited b/i/u */
function runsOf(node, fmt = {}) {
  let xml = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      if (!text) continue;
      let rPr = '';
      if (fmt.b) rPr += '<w:b/>';
      if (fmt.i) rPr += '<w:i/>';
      if (fmt.u) rPr += '<w:u w:val="single"/>';
      xml += `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { xml += '<w:r><w:br/></w:r>'; continue; }
      const next = { ...fmt };
      if (tag === 'b' || tag === 'strong') next.b = true;
      if (tag === 'i' || tag === 'em') next.i = true;
      if (tag === 'u') next.u = true;
      xml += runsOf(child, next);
    }
  }
  return xml;
}

function blockXml(el) {
  const tag = el.tagName.toLowerCase();
  const hm = tag.match(/^h([1-6])$/);
  if (hm) {
    return `<w:p><w:pPr><w:pStyle w:val="Heading${hm[1]}"/></w:pPr>${runsOf(el)}</w:p>`;
  }
  if (tag === 'ul' || tag === 'ol') {
    let xml = '';
    for (const li of el.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      xml += `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${runsOf(li)}</w:p>`;
    }
    return xml;
  }
  return `<w:p>${runsOf(el)}</w:p>`;
}

function htmlToDocx(root) {
  let body = '';
  for (const el of root.children) body += blockXml(el);
  if (!root.children.length && root.textContent.trim()) {
    body = `<w:p>${runsOf(root)}</w:p>`;
  }
  if (!body) body = '<w:p/>';

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

  const enc = (s) => fflate.strToU8(s);
  const zipped = fflate.zipSync({
    '[Content_Types].xml': enc(contentTypes),
    '_rels/.rels': enc(rels),
    'word/document.xml': enc(documentXml),
    'word/styles.xml': enc(stylesXml),
    'word/numbering.xml': enc(numberingXml),
    'word/_rels/document.xml.rels': enc(docRels),
  });
  return new Blob([zipped], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ---------- load ---------- */

async function load() {
  if (!path) {
    loadingEl.textContent = 'No file specified.';
    return;
  }
  const res = await fetch(fileUrl);
  if (res.status === 401) { location.href = '/'; return; }
  if (!res.ok) {
    loadingEl.textContent = t('editor.loadFail');
    return;
  }
  loadingEl.hidden = true;

  if (isDocx) {
    document.getElementById('ed-warn').hidden = false;
    document.getElementById('ed-tools').hidden = false;
    try {
      richEl.innerHTML = docxToHtml(await res.arrayBuffer());
    } catch {
      loadingEl.hidden = false;
      loadingEl.textContent = t('editor.docxFail');
      document.getElementById('ed-save').disabled = true;
      return;
    }
    richEl.hidden = false;
    richEl.focus();
  } else {
    textEl.value = await res.text();
    textEl.hidden = false;
    if (isMd) document.getElementById('ed-preview-toggle').hidden = false;
    textEl.focus();
  }
}

/* ---------- save ---------- */

let saving = false;
async function save() {
  if (saving) return;
  saving = true;
  setStatus(t('editor.saving'));
  let body;
  let type;
  if (isDocx) {
    body = htmlToDocx(richEl);
    type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else {
    body = textEl.value;
    type = isMd ? 'text/markdown' : 'text/plain';
  }
  const res = await fetch(`/api/files?name=${encodeURIComponent(name)}&path=${encodeURIComponent(dir)}${scopeQ}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.success;
  setStatus(ok ? t('editor.saved') : t('editor.fail'), ok);
  if (ok) dirty = false;
  saving = false;
}

document.getElementById('ed-save').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

/* markdown preview toggle */
document.getElementById('ed-preview-toggle').addEventListener('click', () => {
  const showPreview = mdPreviewEl.hidden;
  if (showPreview) mdPreviewEl.innerHTML = mdToHtml(textEl.value);
  mdPreviewEl.hidden = !showPreview;
  textEl.hidden = showPreview;
});

/* docx toolbar */
document.querySelectorAll('#ed-tools button').forEach((btn) => {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
  btn.addEventListener('click', () => {
    if (btn.dataset.cmd) document.execCommand(btn.dataset.cmd);
    else if (btn.dataset.block) document.execCommand('formatBlock', false, btn.dataset.block);
    richEl.focus();
  });
});

/* unsaved-changes hint */
let dirty = false;
textEl.addEventListener('input', () => { dirty = true; setStatus(''); });
richEl.addEventListener('input', () => { dirty = true; setStatus(''); });
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

load();
