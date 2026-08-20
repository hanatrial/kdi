/* ---------- Firestore helper ---------- */
const firebaseConfig = {
  apiKey: "AIzaSyDJfuwjFVNrONY4P4eVah9R5ij8jWngW00",
  authDomain: "dsbrdkdi.firebaseapp.com",
  projectId: "dsbrdkdi",
  storageBucket: "dsbrdkdi.firebasestorage.app",
  messagingSenderId: "912455569910",
  appId: "1:912455569910:web:1d1a68c917da4d0331b7d7"
};
let db;

function showFatalError(message){
  let banner = document.getElementById('fatalErrorBanner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'fatalErrorBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:#e0453d;color:#fff;padding:14px 20px;font-family:sans-serif;font-size:14px;text-align:center;';
    document.body.prepend(banner);
  }
  banner.textContent = message;
}

function openDB(){
  return new Promise((resolve, reject)=>{
    try{
      if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      resolve(db);
    } catch(err){ reject(err); }
  });
}

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

async function getAll(storeName){
  const snap = await db.collection(storeName).get();
  return snap.docs.map(d=>({id:d.id, ...d.data()}));
}
async function put(storeName, val){
  const id = val.id || uid();
  const rest = {...val};
  delete rest.id;
  await db.collection(storeName).doc(id).set(rest);
  return id;
}
async function del(storeName, id){
  await db.collection(storeName).doc(id).delete();
}
async function getByIndex(storeName, indexName, value){
  const snap = await db.collection(storeName).where(indexName, '==', value).get();
  return snap.docs.map(d=>({id:d.id, ...d.data()}));
}

/* ---------- App state ---------- */
let STORES = [];
let POS = [];
let ITEMS = [];
let ALIASES = []; // {id, barcode, distName} — remembers which distributor product name matches a barcode
let CARTON_SIZES = []; // {id, key, unitsPerCarton} — remembers units/carton per product (by barcode, or name if no barcode)
let newPoItemRowCount = 0;
let newPoFileData = []; // [{name, type, dataUrl}, ...]

async function loadAll(){
  STORES = await getAll('stores');
  POS = await getAll('pos');
  ITEMS = await getAll('items');
  ALIASES = await getAll('aliases');
  CARTON_SIZES = await getAll('cartonSizes');
}

function cartonSizeKey(item){
  return item.barcode ? ('bc:'+item.barcode) : ('nm:'+String(item.name||'').trim().toLowerCase());
}

function getRememberedCartonSize(item){
  const key = cartonSizeKey(item);
  const rec = CARTON_SIZES.find(c=>c.key===key);
  return rec ? rec.unitsPerCarton : null;
}

async function rememberCartonSize(item, unitsPerCarton){
  if(!unitsPerCarton || unitsPerCarton<=0) return;
  const key = cartonSizeKey(item);
  const existing = CARTON_SIZES.find(c=>c.key===key);
  if(existing && existing.unitsPerCarton===unitsPerCarton) return;
  const record = existing ? {...existing, unitsPerCarton} : {id: uid(), key, unitsPerCarton};
  await put('cartonSizes', record);
}

function getAliasDistName(barcode){
  if(!barcode) return null;
  const a = ALIASES.find(a=>a.barcode===barcode);
  return a ? a.distName : null;
}

async function saveAlias(barcode, distNameNormalized){
  if(!barcode || !distNameNormalized) return;
  const existing = ALIASES.find(a=>a.barcode===barcode);
  const record = existing ? {...existing, distName: distNameNormalized} : {id: uid(), barcode, distName: distNameNormalized};
  await put('aliases', record);
  await loadAll();
}

/* ---------- Utility: fulfillment calc ---------- */
function poItems(poId){ return ITEMS.filter(i=>i.poId===poId); }

function poFulfillment(poId){
  const items = poItems(poId);
  if(items.length===0) return {pct:0, status:'none', ordered:0, received:0};
  let ordered=0, received=0;
  items.forEach(i=>{
    ordered += Number(i.qtyOrdered)||0;
    received += Math.min(Number(i.qtyReceived)||0, Number(i.qtyOrdered)||0);
  });
  const pct = ordered===0 ? 0 : Math.round((received/ordered)*100);
  let status = 'none';
  if(pct>=100) status='complete';
  else if(pct>0) status='partial';
  return {pct, status, ordered, received};
}

function storeName(id){
  const s = STORES.find(s=>s.id===id);
  return s ? s.name : '(unknown store)';
}

/* ---------- Carton/pcs qty parsing ---------- */
// Guesses units-per-carton from a pack-size hint in the item name, e.g.
// "HI LO SCHOOL CHOCOLATE 12DX250G" -> 12 (12 x 250g per dus/carton),
// "HI LO ACTIVE BELGIAN CHOCOLATE 8GUSX10SX30G" -> 8, "...24TPKX200ML" -> 24.
function guessUnitsPerCarton(name){
  const m = String(name||'').match(/(\d+)\s*(DX|GUS|TPK)/i);
  return m ? Number(m[1]) : null;
}

// Parses a qty typed as plain pcs ("24") or as cartons ("1Q", "1 ctn", "1 dus", "1 box").
// Returns {pcs, cartons?} on success, or {error} if it can't be parsed / needs a carton size.
function parseQtyInput(raw, unitsPerCarton){
  const str = String(raw==null?'':raw).trim();
  if(str === '') return {pcs: 0};
  const cartonMatch = str.match(/^(\d+(?:[.,]\d+)?)\s*(q|ctn|dus|box)$/i);
  if(cartonMatch){
    if(!unitsPerCarton || unitsPerCarton<=0) return {error:'Set units/carton for this item first'};
    const cartons = parseFloat(cartonMatch[1].replace(',','.'));
    return {pcs: Math.round(cartons*unitsPerCarton), cartons};
  }
  const pcsMatch = str.match(/^(\d+(?:[.,]\d+)?)$/);
  if(pcsMatch){
    return {pcs: Math.round(parseFloat(pcsMatch[1].replace(',','.')))};
  }
  return {error:'Use pcs (e.g. 24) or cartons (e.g. 1Q / 1ctn)'};
}

/* ---------- Navigation ---------- */
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> switchView(btn.dataset.view));
});
function switchView(view){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  if(view==='dashboard') renderDashboard();
  if(view==='stores') renderStores();
  if(view==='newpo') renderNewPoForm();
  if(view==='pos') renderAllPos();
  if(view==='distcheck') renderDistCheck();
  if(view==='stockcheck') renderStockCheck();
}

/* ---------- Stores view ---------- */
async function addStore(name, loc){
  name = name.trim();
  if(!name) return null;
  const store = {id:uid(), name, loc:(loc||'').trim()};
  await put('stores', store);
  await loadAll();
  return store;
}

document.getElementById('storeForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = document.getElementById('storeName').value.trim();
  const loc = document.getElementById('storeLoc').value.trim();
  if(!name) return;
  await addStore(name, loc);
  document.getElementById('storeForm').reset();
  renderStores();
});

document.getElementById('bulkStoreImport').addEventListener('click', async ()=>{
  const textarea = document.getElementById('bulkStoreInput');
  const resultEl = document.getElementById('bulkStoreResult');
  const lines = textarea.value.split('\n').map(l=>l.trim()).filter(Boolean);
  if(lines.length===0){ resultEl.textContent = 'Paste at least one store name.'; return; }

  const existingNames = new Set(STORES.map(s=>s.name.toLowerCase()));
  let added = 0, skipped = 0;
  for(const line of lines){
    if(existingNames.has(line.toLowerCase())){ skipped++; continue; }
    await addStore(line, '');
    existingNames.add(line.toLowerCase());
    added++;
  }
  resultEl.textContent = `Added ${added} store(s)${skipped? `, skipped ${skipped} duplicate(s)`:''}.`;
  textarea.value = '';
  renderStores();
});

function renderStores(){
  const tbody = document.getElementById('storeTable');
  tbody.innerHTML = '';
  if(STORES.length===0){
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No stores yet. Add your first distributor above.</td></tr>';
    return;
  }
  STORES.forEach(s=>{
    const count = POS.filter(p=>p.storeId===s.id).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.loc||'')}</td><td>${count}</td>
      <td><button class="btn danger small" data-del-store="${s.id}">Delete</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-del-store]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.delStore;
      if(POS.some(p=>p.storeId===id)){
        alert('This store has purchase orders attached. Delete those POs first.');
        return;
      }
      if(!confirm('Delete this store?')) return;
      await del('stores', id);
      await loadAll();
      renderStores();
    });
  });
}

/* ---------- New PO view ---------- */
function renderNewPoForm(){
  const sel = document.getElementById('poStore');
  sel.innerHTML = STORES.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  if(STORES.length===0) sel.innerHTML = '<option value="">Add a store first</option>';
  document.getElementById('poDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('poRef').value = '';
  document.getElementById('itemRows').innerHTML = '';
  document.getElementById('poFilePreview').innerHTML = '';
  document.getElementById('poFile').value = '';
  document.getElementById('uploadHint').textContent = 'Click to choose one or more files (e.g. multiple PO pages)';
  document.getElementById('autoExtractRow').style.display = 'none';
  document.getElementById('autoExtractStatus').textContent = '';
  document.getElementById('pasteItemsInput').value = '';
  document.getElementById('pasteItemsStatus').textContent = '';
  newPoFileData = [];
  newPoItemRowCount = 0;
  addItemRow();
  document.getElementById('newStoreInline').style.display = 'none';
  document.getElementById('newStoreName').value = '';
  document.getElementById('newStoreLoc').value = '';
  onPoStoreChange();
}

document.getElementById('newStoreToggle').addEventListener('click', ()=>{
  const inline = document.getElementById('newStoreInline');
  inline.style.display = inline.style.display==='none' ? 'flex' : 'none';
  if(inline.style.display==='flex') document.getElementById('newStoreName').focus();
});
document.getElementById('newStoreCancel').addEventListener('click', ()=>{
  document.getElementById('newStoreInline').style.display = 'none';
  document.getElementById('newStoreName').value = '';
  document.getElementById('newStoreLoc').value = '';
});
document.getElementById('newStoreSave').addEventListener('click', async ()=>{
  const name = document.getElementById('newStoreName').value.trim();
  const loc = document.getElementById('newStoreLoc').value.trim();
  if(!name){ document.getElementById('newStoreName').focus(); return; }
  const store = await addStore(name, loc);
  const sel = document.getElementById('poStore');
  sel.innerHTML = STORES.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = store.id;
  document.getElementById('newStoreInline').style.display = 'none';
  document.getElementById('newStoreName').value = '';
  document.getElementById('newStoreLoc').value = '';
  onPoStoreChange();
});

/* ---------- Per-store item templates ---------- */
async function getStoreTemplate(storeId){
  if(!storeId) return null;
  const doc = await db.collection('templates').doc(storeId).get();
  return doc.exists ? doc.data().items : null;
}
async function saveStoreTemplate(storeId, items){
  await db.collection('templates').doc(storeId).set({items});
}

function fillItemRowsFrom(items){
  const tbody = document.getElementById('itemRows');
  tbody.innerHTML = '';
  newPoItemRowCount = 0;
  items.forEach(it=>{
    addItemRow();
    const tr = tbody.lastElementChild;
    tr.querySelector('.item-name').value = it.name || '';
    tr.querySelector('.item-barcode').value = it.barcode || '';
    if(it.qty!=null) tr.querySelector('.item-qty').value = it.qty;
  });
}

function currentItemRowsData(){
  return [...document.getElementById('itemRows').children].map(r=>({
    name: r.querySelector('.item-name').value.trim(),
    barcode: r.querySelector('.item-barcode').value.trim()
  })).filter(it=>it.name);
}

function renderTemplateRow(storeId, template){
  const el = document.getElementById('templateRow');
  if(!storeId){ el.innerHTML = ''; return; }
  const parts = [];
  if(template && template.length){
    parts.push(`<span>📋 Template loaded: ${template.length} item(s) for this store.</span>`);
    parts.push(`<button type="button" class="btn secondary small" id="reloadTemplateBtn">Reload template</button>`);
  } else {
    parts.push(`<span>No saved item template for this store yet.</span>`);
  }
  parts.push(`<button type="button" class="btn secondary small" id="saveTemplateBtn">Save current items as template</button>`);
  el.innerHTML = parts.join(' ');
  const reloadBtn = document.getElementById('reloadTemplateBtn');
  if(reloadBtn) reloadBtn.addEventListener('click', ()=>{
    if(template && template.length) fillItemRowsFrom(template);
  });
  document.getElementById('saveTemplateBtn').addEventListener('click', async ()=>{
    const items = currentItemRowsData();
    if(items.length===0){ alert('Add at least one item row before saving as a template.'); return; }
    await saveStoreTemplate(storeId, items);
    const t = await getStoreTemplate(storeId);
    renderTemplateRow(storeId, t);
    alert(`Saved ${items.length} item(s) as the template for this store.`);
  });
}

async function onPoStoreChange(){
  const storeId = document.getElementById('poStore').value;
  const template = await getStoreTemplate(storeId);
  renderTemplateRow(storeId, template);
  if(template && template.length){
    fillItemRowsFrom(template);
  }
}
document.getElementById('poStore').addEventListener('change', onPoStoreChange);

function addItemRow(){
  const tbody = document.getElementById('itemRows');
  const rowId = 'r'+(newPoItemRowCount++);
  const tr = document.createElement('tr');
  tr.dataset.rowId = rowId;
  tr.innerHTML = `
    <td><input type="text" class="item-name" placeholder="Item name" required></td>
    <td><input type="text" class="item-barcode" placeholder="Barcode (optional)"></td>
    <td><input type="number" class="item-qty" min="1" step="1" placeholder="Qty" required></td>
    <td><button type="button" class="btn danger small remove-row">✕</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector('.remove-row').addEventListener('click', ()=>{
    if(tbody.children.length>1) tr.remove();
  });
}
document.getElementById('addItemRow').addEventListener('click', addItemRow);

document.getElementById('pasteItemsParse').addEventListener('click', ()=>{
  const raw = document.getElementById('pasteItemsInput').value;
  const statusEl = document.getElementById('pasteItemsStatus');
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  const parsed = [];
  for(const line of lines){
    const parts = line.split('|').map(p=>p.trim());
    if(parts.length<2) continue;
    const name = parts[0];
    const barcode = parts.length>=3 ? parts[1] : '';
    const qtyRaw = parts.length>=3 ? parts[2] : parts[1];
    const qty = Number(String(qtyRaw).replace(',', '.'));
    if(!name || !qty || qty<=0) continue;
    parsed.push({name, barcode, qty});
  }
  if(parsed.length===0){
    statusEl.textContent = 'No valid lines found. Use: Item name | Barcode | Qty (one per line).';
    return;
  }
  const tbody = document.getElementById('itemRows');
  tbody.innerHTML = '';
  newPoItemRowCount = 0;
  parsed.forEach(it=>{
    addItemRow();
    const tr = tbody.lastElementChild;
    tr.querySelector('.item-name').value = it.name;
    tr.querySelector('.item-barcode').value = it.barcode;
    tr.querySelector('.item-qty').value = it.qty;
  });
  statusEl.textContent = `Filled ${parsed.length} item row(s) from the pasted list.`;
});

function readFileAsDataUrl(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(reader.error);
    reader.readAsDataURL(file);
  });
}

document.getElementById('poFile').addEventListener('change', async (e)=>{
  const files = [...e.target.files];
  const preview = document.getElementById('poFilePreview');
  const extractRow = document.getElementById('autoExtractRow');
  const extractStatus = document.getElementById('autoExtractStatus');
  const hint = document.getElementById('uploadHint');
  extractStatus.textContent = '';

  if(files.length===0){ preview.innerHTML=''; newPoFileData=[]; extractRow.style.display='none'; return; }

  const dataUrls = await Promise.all(files.map(f=>readFileAsDataUrl(f)));
  newPoFileData = files.map((f,i)=>({name:f.name, type:f.type, dataUrl:dataUrls[i]}));

  hint.textContent = files.length===1 ? ('✓ ' + files[0].name) : `✓ ${files.length} files selected`;
  preview.innerHTML = newPoFileData.map(f=>
    f.type.startsWith('image/')
      ? `<img class="thumb" src="${f.dataUrl}" style="max-width:140px;margin:4px;">`
      : `<span style="display:inline-block;margin:4px;">📄 ${escapeHtml(f.name)}</span>`
  ).join('');
  extractRow.style.display = 'flex';
});

/* ---------- Auto-extract items from uploaded PO file ---------- */
const loadedScripts = new Set();
function loadScript(src){
  if(loadedScripts.has(src)) return Promise.resolve();
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.onload = ()=>{ loadedScripts.add(src); resolve(); };
    s.onerror = ()=> reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
}

function dataUrlToUint8Array(dataUrl){
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function extractTextFromPdf(dataUrl){
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const bytes = dataUrlToUint8Array(dataUrl);
  const pdf = await pdfjsLib.getDocument({data: bytes}).promise;
  let fullText = '';
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // group text items into lines by y-position
    const lines = {};
    content.items.forEach(it=>{
      const y = Math.round(it.transform[5]/3)*3;
      if(!lines[y]) lines[y] = [];
      lines[y].push({x: it.transform[4], str: it.str});
    });
    const ys = Object.keys(lines).map(Number).sort((a,b)=>b-a);
    ys.forEach(y=>{
      const lineText = lines[y].sort((a,b)=>a.x-b.x).map(t=>t.str).join(' ');
      fullText += lineText + '\n';
    });
  }
  return fullText;
}

async function extractTextFromImage(dataUrl, onProgress){
  await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  const result = await Tesseract.recognize(dataUrl, 'eng', {
    logger: m=>{
      if(m.status==='recognizing text' && onProgress) onProgress(Math.round((m.progress||0)*100));
    }
  });
  return result.data.text;
}

/* "ORDER PEMBELIAN"-style PO template:
   line 1 (header row): <no> <SKU> <-|qty,x> <UNIT> <PRODUCT NAME> <H.BRUTO> <JUMLAH>
   line 2 (detail row):  <BARCODE> <qty,x> <UNIT> <disc> <disc> <disc> <PPN> <ISI> <TTL QTY> <H.NETTO-K>
   We only need: barcode (line 2, first token), TTL QTY (line 2, last comma-decimal number
   before the trailing currency figure), and the item name (line 1, stripped of SKU/qty/prices). */
function parseTemplateStyle(text){
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const items = [];
  for(let i=0;i<lines.length;i++){
    const header = lines[i].match(/^\d{1,3}\s+(\d{6,14})\s+(.*)$/);
    if(!header) continue;
    const next = lines[i+1] || '';
    const barcodeMatch = next.match(/^(\d{8,14})\b/);
    if(!barcodeMatch) continue;
    const barcode = barcodeMatch[1];

    const qtyTokens = next.split(/\s+/).filter(t=>/^\d+,\d+$/.test(t));
    if(qtyTokens.length===0) continue;
    const ttlQty = Math.round(parseFloat(qtyTokens[qtyTokens.length-1].replace(',','.')));
    if(!ttlQty || ttlQty<=0) continue;

    let name = header[2];
    name = name.replace(/^(-|\d+,\d+)\s+[A-Z]{2,5}\s+/, '');
    name = name.replace(/\s+[\d.]{3,}\s+[\d.]{3,}\s*$/, '');
    name = name.trim();
    if(name.length<2) continue;

    items.push({name, barcode, qty: ttlQty});
  }
  return items;
}

/* "Nama Barang" style photo list (e.g. PT. Matakar Kendari internal PO sheets):
   columns are  No# | <code>/<Nama Barang> | Unit | Quantity | Keterangan
   e.g. "013  0060065 /HILO ACTIVE COKLAT 750 GR   PCS   6,00"
   Only keeps rows whose product name starts with a target brand (HILO, TROPICANA,
   L-MEN, NUTRISARI, DIABETAMIL) per the user's request. For HILO/TROPICANA/L-MEN/
   NUTRISARI, converts the printed pack qty to individual pieces (LUSIN=12,
   DOS/KRT/CRT=24); Diabetamil and any other unit (e.g. PCS) is kept as printed. */
const NB_CONVERTIBLE_BRAND_RE = /^(HILO|TROPICANA|L-?MEN|NUTRI\s*SARI|NUTRISARI)\b/i;
const NB_TARGET_BRAND_RE = /^(HILO|TROPICANA|L-?MEN|NUTRI\s*SARI|NUTRISARI|DIABETAMIL)\b/i;
const NB_PACK_MULTIPLIER = { LUSIN:12, DOS:24, KRT:24, CRT:24 };

function parseNamaBarangStyle(text){
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const items = [];
  for(const line of lines){
    const m = line.match(/^\d{1,4}[.)]?\s+(\d{4,10})\s*[\/|]\s*(.+?)\s+([A-Z]{2,6})\s+([\d.,]+)\s*$/);
    if(!m) continue;
    const [, code, rawName, unit, qtyRaw] = m;
    const name = rawName.trim();
    if(!NB_TARGET_BRAND_RE.test(name)) continue;
    let qty = parseFloat(qtyRaw.replace(',', '.'));
    if(!qty || qty<=0) continue;
    if(NB_CONVERTIBLE_BRAND_RE.test(name)){
      qty = qty * (NB_PACK_MULTIPLIER[unit.toUpperCase()] || 1);
    }
    items.push({name, barcode: code, qty: Math.round(qty)});
  }
  return items;
}

function parseGenericStyle(text){
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const skipPattern = /^(no\.?|item|barcode|qty|quantity|jumlah|total|subtotal|tanggal|date|halaman|page|keterangan|catatan|alamat|npwp|nama|harga|price|discount|diskon)\b.{0,20}$/i;
  const items = [];
  for(const line of lines){
    if(line.length<3) continue;
    if(skipPattern.test(line)) continue;

    const barcodeMatch = line.match(/\b\d{8,14}\b/);
    const barcode = barcodeMatch ? barcodeMatch[0] : '';
    let rest = barcode ? (line.slice(0,barcodeMatch.index) + line.slice(barcodeMatch.index+barcode.length)) : line;

    let qty = null, qtyIndex = -1;
    const qtyMatch = rest.match(/(\d{1,5})\s*(pcs|pc|box|ctn|unit|dus|lsn|bh)?\s*$/i);
    if(qtyMatch){
      qty = parseInt(qtyMatch[1],10);
      qtyIndex = qtyMatch.index;
    } else {
      const anyNum = [...rest.matchAll(/\b\d{1,5}\b/g)];
      if(anyNum.length){
        const last = anyNum[anyNum.length-1];
        qty = parseInt(last[0],10);
        qtyIndex = last.index;
      }
    }
    if(qty===null || qty<=0 || qty>100000) continue;

    let name = qtyIndex>=0 ? rest.slice(0, qtyIndex) : rest;
    name = name.replace(/^[\d\.\)\-\s]+/,'').trim();
    name = name.replace(/[|:\-]+$/,'').trim();
    name = name.replace(/\s{2,}/g,' ');
    if(name.length<2) continue;

    items.push({name, barcode, qty});
  }
  return items;
}

function parseItemsFromText(text){
  const templateItems = parseTemplateStyle(text);
  if(templateItems.length>=2) return templateItems;
  const namaBarangItems = parseNamaBarangStyle(text);
  if(namaBarangItems.length>=2) return namaBarangItems;
  return parseGenericStyle(text);
}

document.getElementById('autoExtractBtn').addEventListener('click', async ()=>{
  if(!newPoFileData || newPoFileData.length===0){ return; }
  const statusEl = document.getElementById('autoExtractStatus');
  const btn = document.getElementById('autoExtractBtn');
  btn.disabled = true;
  try{
    const allItems = [];
    for(let i=0; i<newPoFileData.length; i++){
      const f = newPoFileData[i];
      const filePrefix = newPoFileData.length>1 ? `File ${i+1}/${newPoFileData.length}: ` : '';
      let text;
      if(f.type === 'application/pdf'){
        statusEl.textContent = filePrefix + 'Reading PDF…';
        text = await extractTextFromPdf(f.dataUrl);
      } else {
        statusEl.textContent = filePrefix + 'Running OCR on photo… this can take a while';
        text = await extractTextFromImage(f.dataUrl, pct=>{
          statusEl.textContent = `${filePrefix}Running OCR on photo… ${pct}%`;
        });
      }
      allItems.push(...parseItemsFromText(text));
    }
    if(allItems.length===0){
      statusEl.textContent = 'Could not detect item rows automatically — please add them manually below.';
    } else {
      const tbody = document.getElementById('itemRows');
      tbody.innerHTML = '';
      newPoItemRowCount = 0;
      allItems.forEach(it=>{
        addItemRow();
        const tr = tbody.lastElementChild;
        tr.querySelector('.item-name').value = it.name;
        tr.querySelector('.item-barcode').value = it.barcode;
        tr.querySelector('.item-qty').value = it.qty;
      });
      const fileNote = newPoFileData.length>1 ? ` across ${newPoFileData.length} files` : '';
      statusEl.textContent = `Extracted ${allItems.length} item(s)${fileNote} — please double-check names, barcodes and quantities before saving.`;
    }
  } catch(err){
    console.error(err);
    statusEl.textContent = 'Auto-extract failed (' + err.message + '). Please add items manually.';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('poForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const storeId = document.getElementById('poStore').value;
  if(!storeId){ alert('Please add and select a store first.'); return; }
  const orderDate = document.getElementById('poDate').value;
  const ref = document.getElementById('poRef').value.trim();

  const rows = [...document.getElementById('itemRows').children];
  const items = rows.map(r=>({
    name: r.querySelector('.item-name').value.trim(),
    barcode: r.querySelector('.item-barcode').value.trim(),
    qty: Number(r.querySelector('.item-qty').value)
  })).filter(i=>i.name && i.qty>0);

  if(items.length===0){ alert('Add at least one item with a quantity.'); return; }

  // Firestore documents cap out at 1MB; base64-encoded photos (especially more than one)
  // blow past that easily and would otherwise fail the save silently.
  const totalFileBytes = (newPoFileData||[]).reduce((sum,f)=>sum + (f.dataUrl?.length||0), 0);
  const FIRESTORE_SAFE_BYTES = 700000;
  let fileToSave = newPoFileData;
  if(totalFileBytes > FIRESTORE_SAFE_BYTES){
    fileToSave = [];
    alert(`The attached file(s) are too large to store (${Math.round(totalFileBytes/1024)}KB, limit ~${Math.round(FIRESTORE_SAFE_BYTES/1024)}KB) — saving the PO and its items without the attached photo(s)/PDF. The extracted items are unaffected.`);
  }

  const poId = uid();
  await put('pos', {
    id: poId,
    storeId,
    orderDate,
    ref,
    file: fileToSave,
    deliveredDate: '',
    createdAt: Date.now()
  });

  for(const it of items){
    await put('items', {
      id: uid(),
      poId,
      name: it.name,
      barcode: it.barcode,
      qtyOrdered: it.qty,
      qtyReceived: it.qty,
      arrived: true,
      distSalesQty: null,
      distStockQty: null
    });
  }

  await loadAll();
  alert('PO saved.');
  switchView('dashboard');
});

/* ---------- Dashboard ---------- */
function renderDashboard(){
  renderStatRow();
  const filterStoreSel = document.getElementById('filterStore');
  filterStoreSel.innerHTML = '<option value="">All stores</option>' + STORES.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  renderPoList('poList', true);
}
document.getElementById('filterStore').addEventListener('change', ()=>renderPoList('poList', true));
document.getElementById('filterStatus').addEventListener('change', ()=>renderPoList('poList', true));

function renderStatRow(){
  const row = document.getElementById('statRow');
  const totalPos = POS.length;
  let complete=0, partial=0, none=0, totalOrdered=0, totalReceived=0;
  POS.forEach(p=>{
    const f = poFulfillment(p.id);
    if(f.status==='complete') complete++;
    else if(f.status==='partial') partial++;
    else none++;
    totalOrdered += f.ordered;
    totalReceived += f.received;
  });
  const overallPct = totalOrdered===0 ? 0 : Math.round((totalReceived/totalOrdered)*100);

  let mismatches=0, oosItems=0;
  ITEMS.forEach(it=>{
    if(it.distSalesQty!==null && it.distSalesQty!==undefined && Number(it.distSalesQty)!==Number(it.qtyReceived)) mismatches++;
    if(it.distStockQty!==null && it.distStockQty!==undefined && Number(it.distStockQty)<=0) oosItems++;
  });

  row.innerHTML = `
    <div class="stat-card"><div class="num">${totalPos}</div><div class="label">Total POs</div></div>
    <div class="stat-card accent-green"><div class="num">${complete}</div><div class="label">Fulfilled 100%</div></div>
    <div class="stat-card accent-amber"><div class="num">${partial}</div><div class="label">Partial</div></div>
    <div class="stat-card accent-red"><div class="num">${none}</div><div class="label">Not started</div></div>
    <div class="stat-card accent-primary"><div class="num">${overallPct}%</div><div class="label">Overall fulfillment</div></div>
    <div class="stat-card accent-red"><div class="num">${mismatches}</div><div class="label">Sales mismatches</div></div>
    <div class="stat-card accent-amber"><div class="num">${oosItems}</div><div class="label">OOS items at distributor</div></div>
  `;
}

function renderPoList(containerId, filtered){
  const container = document.getElementById(containerId);
  let list = [...POS].sort((a,b)=>b.createdAt-a.createdAt);
  if(filtered){
    const storeF = document.getElementById('filterStore').value;
    const statusF = document.getElementById('filterStatus').value;
    if(storeF) list = list.filter(p=>p.storeId===storeF);
    if(statusF) list = list.filter(p=>poFulfillment(p.id).status===statusF);
  }
  if(list.length===0){
    container.innerHTML = '<div class="empty">No purchase orders found.</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(p=>{
    const f = poFulfillment(p.id);
    const card = document.createElement('div');
    card.className = 'po-card';
    card.innerHTML = `
      <div class="po-main">
        <div class="store">${escapeHtml(storeName(p.storeId))} ${p.ref?('· '+escapeHtml(p.ref)):''}</div>
        <div class="meta">Ordered ${p.orderDate}${p.deliveredDate?(' · Delivered '+p.deliveredDate):''} · ${poItems(p.id).length} item(s) · ${f.received}/${f.ordered} units received</div>
      </div>
      <div class="po-progress">
        <span class="badge ${f.status}">${f.status==='complete'?'Fulfilled':f.status==='partial'?'Partial':'Not started'}</span>
        <div class="bar"><div class="bar-fill ${f.status!=='complete'?f.status:''}" style="width:${f.pct}%"></div></div>
        <div class="pct">${f.pct}%</div>
      </div>
    `;
    card.addEventListener('click', ()=>openPoModal(p.id));
    container.appendChild(card);
  });
}

function renderAllPos(){
  renderPoList('poListFull', false);
}

/* ---------- PO Detail / Validation Modal ---------- */
const poModal = document.getElementById('poModal');
document.getElementById('poModalClose').addEventListener('click', closePoModal);
poModal.addEventListener('click', (e)=>{ if(e.target===poModal) closePoModal(); });
function closePoModal(){ poModal.classList.remove('active'); }

function openPoModal(poId){
  const po = POS.find(p=>p.id===poId);
  if(!po) return;
  const items = poItems(poId);
  const f = poFulfillment(poId);
  const body = document.getElementById('poModalBody');

  let fileHtml = '';
  // po.file may be an array (current) or a single object (older POs saved before multi-file support).
  const poFiles = Array.isArray(po.file) ? po.file : (po.file ? [po.file] : []);
  if(poFiles.length>0){
    fileHtml = poFiles.map(f=>
      (f.type && f.type.startsWith('image/'))
        ? `<a href="${f.dataUrl}" target="_blank"><img class="thumb" src="${f.dataUrl}" style="max-width:160px;margin:4px;"></a>`
        : `<a href="${f.dataUrl}" download="${escapeHtml(f.name)}" style="display:inline-block;margin:4px;">📄 ${escapeHtml(f.name)} (open/download)</a>`
    ).join('');
  }

  body.innerHTML = `
    <h2 style="margin-top:0">${escapeHtml(storeName(po.storeId))} ${po.ref?('· '+escapeHtml(po.ref)):''}</h2>
    <div style="color:var(--text-dim);font-size:0.9rem;margin-bottom:10px;">Order date: ${po.orderDate}</div>
    <div style="margin-bottom:14px;">
      <span class="badge ${f.status}">${f.pct}% fulfilled — ${f.received}/${f.ordered} units</span>
    </div>
    ${fileHtml}
    <h3>Validate Items (arrival at store)</h3>
    <label class="delivered-date-field">Delivery date (one delivery for this whole PO)
      <input type="date" id="poDeliveredDate" value="${po.deliveredDate||''}">
    </label>
    <div style="margin-bottom:10px;">
      <button type="button" class="btn secondary small" id="fillAllOrdered">Fill all as ordered</button>
    </div>
    <p class="step-hint">Received accepts pcs (e.g. <code>24</code>) or cartons (e.g. <code>1Q</code> / <code>1ctn</code>) — cartons convert using "Units/ctn" for that item. Fill it in once per product and it's remembered automatically next time (matched by barcode, or name if there's no barcode).</p>
    <div class="table-scroll">
    <table class="data-table">
      <thead><tr><th>Item</th><th>Barcode</th><th>Ordered</th><th>Units/ctn</th><th>Received</th><th>= pcs</th><th>Arrived</th></tr></thead>
      <tbody id="validateRows"></tbody>
    </table>
    </div>
    <p class="step-hint">Distributor sales cross-check and stock (OOS) check are done via Excel import on the <strong>Distributor Check</strong> tab.</p>

    <div class="form-actions">
      <button class="btn primary" id="saveValidation">Save changes</button>
      <button class="btn danger" id="deletePo" style="margin-left:8px;">Delete PO</button>
    </div>
  `;

  const tbody = body.querySelector('#validateRows');

  items.forEach(it=>{
    const upc = it.unitsPerCarton || getRememberedCartonSize(it) || guessUnitsPerCarton(it.name) || '';
    const tr = document.createElement('tr');
    tr.className = 'validate-row';
    tr.dataset.itemId = it.id;
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.barcode||'—')}</td>
      <td>${it.qtyOrdered}</td>
      <td><input type="number" class="qty-input v-upc" min="0" step="1" style="width:70px;" value="${upc}"></td>
      <td><input type="text" class="qty-input v-qty" style="width:90px;" placeholder="e.g. 24 or 1Q" value="${it.qtyReceivedRaw!=null ? it.qtyReceivedRaw : (it.qtyReceived||'')}"></td>
      <td class="v-pcs-out step-hint" style="margin:0;">${it.qtyReceived||0} pcs</td>
      <td><input type="checkbox" class="v-arrived" ${it.arrived?'checked':''}></td>
    `;
    tbody.appendChild(tr);

    const qtyInput = tr.querySelector('.v-qty');
    const upcInput = tr.querySelector('.v-upc');
    const pcsOut = tr.querySelector('.v-pcs-out');
    const arrivedBox = tr.querySelector('.v-arrived');

    function recompute(){
      const parsed = parseQtyInput(qtyInput.value, Number(upcInput.value)||0);
      if(parsed.error){
        pcsOut.textContent = parsed.error;
        pcsOut.style.color = 'var(--danger, #e0453d)';
        return null;
      }
      pcsOut.style.color = '';
      pcsOut.textContent = parsed.cartons!=null
        ? `${parsed.pcs} pcs (${parsed.cartons} ctn × ${upcInput.value})`
        : `${parsed.pcs} pcs`;
      if(parsed.pcs >= it.qtyOrdered && parsed.pcs > 0) arrivedBox.checked = true;
      return parsed.pcs;
    }
    qtyInput.addEventListener('input', recompute);
    upcInput.addEventListener('input', recompute);
    recompute();
  });

  body.querySelector('#fillAllOrdered').addEventListener('click', ()=>{
    [...tbody.children].forEach(tr=>{
      const itemId = tr.dataset.itemId;
      const it = items.find(i=>i.id===itemId);
      tr.querySelector('.v-qty').value = it.qtyOrdered;
      tr.querySelector('.v-qty').dispatchEvent(new Event('input'));
      tr.querySelector('.v-arrived').checked = true;
    });
  });

  body.querySelector('#saveValidation').addEventListener('click', async ()=>{
    po.deliveredDate = body.querySelector('#poDeliveredDate').value;
    await put('pos', po);

    const rows = [...tbody.children];
    const errors = [];
    for(const tr of rows){
      const itemId = tr.dataset.itemId;
      const item = ITEMS.find(i=>i.id===itemId);
      if(!item) continue;
      const upc = Number(tr.querySelector('.v-upc').value)||0;
      const rawQty = tr.querySelector('.v-qty').value;
      const parsed = parseQtyInput(rawQty, upc);
      if(parsed.error){ errors.push(`${item.name}: ${parsed.error}`); continue; }
      item.unitsPerCarton = upc || null;
      item.qtyReceivedRaw = rawQty;
      item.qtyReceived = parsed.pcs;
      await rememberCartonSize(item, upc);
      item.arrived = tr.querySelector('.v-arrived').checked;
      await put('items', item);
    }
    if(errors.length){
      alert('Some rows could not be saved:\n' + errors.join('\n'));
    }
    await loadAll();
    renderDashboard();
    renderAllPos();
    openPoModal(poId); // refresh modal with new totals
  });

  body.querySelector('#deletePo').addEventListener('click', async ()=>{
    if(!confirm('Delete this PO and all its items? This cannot be undone.')) return;
    for(const it of items) await del('items', it.id);
    await del('pos', poId);
    await loadAll();
    closePoModal();
    renderDashboard();
    renderAllPos();
  });

  poModal.classList.add('active');
}

/* ---------- Distributor Check (Excel import for Steps 2 & 3) ---------- */
function poLabel(p){
  return `${storeName(p.storeId)} · ${p.orderDate}${p.ref? (' · '+p.ref) : ''}`;
}

function populatePoSelect(selectId){
  const sel = document.getElementById(selectId);
  const sorted = [...POS].sort((a,b)=>b.createdAt-a.createdAt);
  sel.innerHTML = sorted.map(p=>`<option value="${p.id}">${escapeHtml(poLabel(p))}</option>`).join('');
  if(sorted.length===0) sel.innerHTML = '<option value="">No purchase orders yet</option>';
}

function renderDistCheck(){
  populatePoSelect('dcPoSelect');
  renderSalesTable();
  document.getElementById('dcPoSelect').onchange = renderSalesTable;
}

function renderStockCheck(){
  populatePoSelect('scPoSelect');
  renderStockTable();
  document.getElementById('scPoSelect').onchange = renderStockTable;
}

// Holds auto-guessed (not-yet-saved) matches per field, keyed by itemId, so the table can
// flag them and "Save table" can decide whether to remember the alias.
let pendingGuesses = {
  distSalesQty: { poId: null, map: new Map() },
  distStockQty: { poId: null, map: new Map() }
};

// Full distributor product list from the last import, so unmatched rows can offer a manual
// picker instead of being left blank when no fuzzy guess cleared the confidence threshold.
let lastImportEntries = { distSalesQty: null, distStockQty: null };

function manualPickCellHtml(field, poId){
  const cache = lastImportEntries[field];
  if(!cache || cache.poId!==poId || cache.distEntries.length===0) return '';
  const options = cache.distEntries
    .slice().sort((a,b)=>a.rawName.localeCompare(b.rawName))
    .map((d,i)=>`<option value="${i}">${escapeHtml(d.rawName)} — qty ${d.value}</option>`).join('');
  return `<select class="manual-pick"><option value="-1">🔗 Pick from distributor list…</option>${options}</select>`;
}

function renderSalesTable(){
  const poId = document.getElementById('dcPoSelect').value;
  const salesBody = document.getElementById('dcSalesRows');
  document.getElementById('dcSalesStatus').textContent = '';

  if(pendingGuesses.distSalesQty.poId!==poId) pendingGuesses.distSalesQty = { poId, map: new Map() };

  if(!poId){ salesBody.innerHTML = '<tr><td colspan="6" class="empty">No PO selected.</td></tr>'; return; }
  const items = poItems(poId);
  if(items.length===0){ salesBody.innerHTML = '<tr><td colspan="6" class="empty">This PO has no items.</td></tr>'; return; }

  salesBody.innerHTML = '';
  items.forEach(it=>{
    const guess = pendingGuesses.distSalesQty.map.get(it.id);
    const tr = document.createElement('tr');
    tr.dataset.itemId = it.id;
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.barcode||'—')}</td>
      <td>${it.qtyOrdered}</td>
      <td>${it.qtyReceived}</td>
      <td><input type="number" class="qty-input dc-sales" min="0" value="${it.distSalesQty ?? ''}" placeholder="—"></td>
      <td class="dc-match"></td>
    `;
    if(guess) tr.classList.add('guessed-row');
    salesBody.appendChild(tr);
    const input = tr.querySelector('.dc-sales');
    const matchCell = tr.querySelector('.dc-match');
    const updateBadge = ()=>{
      const guessNow = pendingGuesses.distSalesQty.map.get(it.id);
      const guessTag = (guessNow && Number(input.value)===guessNow.value)
        ? `<span class="badge guess" title="Guessed from: ${escapeHtml(guessNow.rawName)}">🔍 ${guessNow.score>=1?'Picked':'Guessed ~'+Math.round(guessNow.score*100)+'%'} — verify</span>` : '';
      const pickerHtml = (input.value==='') ? manualPickCellHtml('distSalesQty', poId) : '';
      if(input.value===''){ matchCell.innerHTML = `<span class="badge" style="background:var(--bg);color:var(--text-dim)">Not entered</span> ${guessTag}<br>${pickerHtml}`; }
      else{
        const match = Number(input.value)===it.qtyReceived;
        matchCell.innerHTML = (match ? '<span class="badge complete">Matches</span>' : '<span class="badge none">Mismatch</span>') + ' ' + guessTag;
      }
      const picker = matchCell.querySelector('.manual-pick');
      if(picker){
        picker.addEventListener('change', ()=>{
          const idx = Number(picker.value);
          if(idx===-1) return;
          const chosen = lastImportEntries.distSalesQty.distEntries.slice().sort((a,b)=>a.rawName.localeCompare(b.rawName))[idx];
          input.value = chosen.value;
          pendingGuesses.distSalesQty.map.set(it.id, {...chosen, score: 1});
          tr.classList.add('guessed-row');
          updateBadge();
        });
      }
    };
    input.addEventListener('input', updateBadge);
    updateBadge();
  });
}

function renderStockTable(){
  const poId = document.getElementById('scPoSelect').value;
  const stockBody = document.getElementById('scStockRows');
  document.getElementById('scStockStatus').textContent = '';

  if(pendingGuesses.distStockQty.poId!==poId) pendingGuesses.distStockQty = { poId, map: new Map() };

  if(!poId){ stockBody.innerHTML = '<tr><td colspan="5" class="empty">No PO selected.</td></tr>'; return; }
  const items = poItems(poId);
  if(items.length===0){ stockBody.innerHTML = '<tr><td colspan="5" class="empty">This PO has no items.</td></tr>'; return; }

  stockBody.innerHTML = '';
  items.forEach(it=>{
    const guess = pendingGuesses.distStockQty.map.get(it.id);
    const tr = document.createElement('tr');
    tr.dataset.itemId = it.id;
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}</td>
      <td>${escapeHtml(it.barcode||'—')}</td>
      <td>${it.qtyOrdered}</td>
      <td><input type="number" class="qty-input sc-stock" min="0" value="${it.distStockQty ?? ''}" placeholder="—"></td>
      <td class="sc-status"></td>
    `;
    if(guess) tr.classList.add('guessed-row');
    stockBody.appendChild(tr);
    const input = tr.querySelector('.sc-stock');
    const statusCell = tr.querySelector('.sc-status');
    const updateBadge = ()=>{
      const guessNow = pendingGuesses.distStockQty.map.get(it.id);
      const guessTag = (guessNow && Number(input.value)===guessNow.value)
        ? `<span class="badge guess" title="Guessed from: ${escapeHtml(guessNow.rawName)}">🔍 ${guessNow.score>=1?'Picked':'Guessed ~'+Math.round(guessNow.score*100)+'%'} — verify</span>` : '';
      const pickerHtml = (input.value==='') ? manualPickCellHtml('distStockQty', poId) : '';
      if(input.value===''){ statusCell.innerHTML = `<span class="badge" style="background:var(--bg);color:var(--text-dim)">Not entered</span> ${guessTag}<br>${pickerHtml}`; }
      else{
        const n = Number(input.value);
        statusCell.innerHTML = (n<=0 ? '<span class="badge none">Out of stock</span>' : '<span class="badge complete">In stock</span>') + ' ' + guessTag;
      }
      const picker = statusCell.querySelector('.manual-pick');
      if(picker){
        picker.addEventListener('change', ()=>{
          const idx = Number(picker.value);
          if(idx===-1) return;
          const chosen = lastImportEntries.distStockQty.distEntries.slice().sort((a,b)=>a.rawName.localeCompare(b.rawName))[idx];
          input.value = chosen.value;
          pendingGuesses.distStockQty.map.set(it.id, {...chosen, score: 1});
          tr.classList.add('guessed-row');
          updateBadge();
        });
      }
    };
    input.addEventListener('input', updateBadge);
    updateBadge();
  });
}

async function saveDcTable(bodyId, field){
  const guesses = pendingGuesses[field].map;
  const rows = [...document.getElementById(bodyId).children];
  for(const tr of rows){
    const itemId = tr.dataset.itemId;
    if(!itemId) continue;
    const item = ITEMS.find(i=>i.id===itemId);
    if(!item) continue;
    const input = tr.querySelector('input[type=number]');
    const val = input.value;
    item[field] = val===''? null : Number(val);
    await put('items', item);

    // If the user left an auto-guessed value unchanged, treat it as confirmed and remember it.
    const guess = guesses.get(itemId);
    if(guess && val!=='' && Number(val)===guess.value && item.barcode){
      await saveAlias(item.barcode, guess.normName);
    }
  }
  guesses.clear();
  await loadAll();
  renderDashboard();
}

document.getElementById('dcSalesSave').addEventListener('click', async ()=>{
  await saveDcTable('dcSalesRows', 'distSalesQty');
  document.getElementById('dcSalesStatus').textContent = 'Saved.';
  renderSalesTable();
});
document.getElementById('scStockSave').addEventListener('click', async ()=>{
  await saveDcTable('scStockRows', 'distStockQty');
  document.getElementById('scStockStatus').textContent = 'Saved.';
  renderStockTable();
});

async function readExcelRows(file){
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
}

function normalizeName(s){
  return String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
}

/* Builds two lookup maps (by barcode, by normalized product name) from an imported sheet.
   Supports two shapes:
   1. Simple reference sheet: columns for Barcode + a value (qty/stock).
   2. Raw distributor sales journal (e.g. NAMACUSTOMER/KODEBARANG/NAMA/QUANTITY2...): filtered
      down to the rows for the selected store, then summed per product name. */
function buildValueMaps(rows, valueHeaderRegex, storeName){
  const header = (rows[0]||[]).map(h=>String(h).trim());
  const findCol = (re)=> header.findIndex(h=>re.test(h));

  const barcodeCol = findCol(/barcode|kode\s*batang/i);
  const nameCol = findCol(/^nama$|nama\s*produk|nama\s*barang|product\s*name|item\s*name|^name$/i);
  const custCol = findCol(/nama\s*customer|customer\s*name|^customer$|nama\s*toko|store\s*name/i);
  let valueCol = findCol(valueHeaderRegex);

  const hasHeader = barcodeCol!==-1 || nameCol!==-1 || custCol!==-1 || valueCol!==-1;
  let startRow = hasHeader ? 1 : 0;
  if(valueCol===-1) valueCol = hasHeader ? (nameCol!==-1 ? nameCol+1 : 1) : 1;
  const effBarcodeCol = barcodeCol!==-1 ? barcodeCol : (hasHeader ? -1 : 0);

  let dataRows = rows.slice(startRow);
  let storeFilterApplied = false, storeMatchedRows = 0;
  const customersSeen = new Set();

  if(custCol!==-1 && storeName){
    storeFilterApplied = true;
    const target = normalizeName(storeName);
    dataRows.forEach(r=>{ if(r[custCol]) customersSeen.add(String(r[custCol]).trim()); });
    let filtered = dataRows.filter(r=> normalizeName(r[custCol])===target);
    if(filtered.length===0){
      filtered = dataRows.filter(r=>{
        const n = normalizeName(r[custCol]);
        return n && (n.includes(target) || target.includes(n));
      });
    }
    dataRows = filtered;
    storeMatchedRows = filtered.length;
  }

  const byBarcode = new Map();
  const byName = new Map();     // normalized name -> summed value
  const rawNameOf = new Map();  // normalized name -> original display name
  dataRows.forEach(row=>{
    if(!row) return;
    const rawVal = row[valueCol];
    const value = Number(String(rawVal??'').replace(',', '.'));
    if(isNaN(value)) return;

    if(effBarcodeCol!==-1){
      const bc = String(row[effBarcodeCol]??'').trim();
      if(bc) byBarcode.set(bc, (byBarcode.get(bc)||0) + value);
    }
    if(nameCol!==-1){
      const raw = String(row[nameCol]??'').trim();
      const key = normalizeName(raw);
      if(key){
        byName.set(key, (byName.get(key)||0) + value);
        if(!rawNameOf.has(key)) rawNameOf.set(key, raw);
      }
    }
  });

  return {byBarcode, byName, rawNameOf, storeFilterApplied, storeMatchedRows, customersSeen};
}

function tokenize(s){ return normalizeName(s).split(' ').filter(Boolean); }

/* Jaccard similarity on word tokens — used to suggest likely matches when
   distributor naming doesn't line up exactly with the PO's item names. */
function fuzzyScore(nameA, nameB){
  const a = new Set(tokenize(nameA));
  const b = new Set(tokenize(nameB));
  if(a.size===0 || b.size===0) return 0;
  let common = 0;
  a.forEach(t=>{ if(b.has(t)) common++; });
  const union = new Set([...a, ...b]).size;
  return common/union;
}

async function importDcFile(fileInputId, valueHeaderRegex, field, statusId, poSelectId){
  const fileInput = document.getElementById(fileInputId);
  const statusEl = document.getElementById(statusId);
  const poId = document.getElementById(poSelectId).value;
  if(!poId){ statusEl.textContent = 'Select a PO first.'; return; }
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = 'Choose a file first.'; return; }

  const po = POS.find(p=>p.id===poId);

  statusEl.textContent = 'Reading file…';
  try{
    const rows = await readExcelRows(file);
    const {byBarcode, byName, rawNameOf, storeFilterApplied, storeMatchedRows, customersSeen} =
      buildValueMaps(rows, valueHeaderRegex, storeName(po.storeId));

    if(storeFilterApplied && storeMatchedRows===0){
      const sample = [...customersSeen].slice(0,4).join('; ');
      statusEl.textContent = `Found a customer column, but no rows matched "${storeName(po.storeId)}". Customer names in file include: ${sample}${customersSeen.size>4?'…':''}`;
      return;
    }
    if(byBarcode.size===0 && byName.size===0){
      statusEl.textContent = 'No usable barcode/name + quantity rows found in the file.';
      return;
    }

    const items = poItems(poId);
    const distEntries = [...byName.entries()].map(([normName, value])=>({normName, rawName: rawNameOf.get(normName), value}));
    lastImportEntries[field] = { poId, distEntries };
    const guesses = new Map();
    let matchedBarcode = 0, matchedAlias = 0, guessed = 0, noMatch = 0;

    for(const it of items){
      let val = null;
      const aliasName = getAliasDistName(it.barcode);
      if(it.barcode && byBarcode.has(it.barcode)){
        val = byBarcode.get(it.barcode); matchedBarcode++;
      } else if(aliasName && byName.has(aliasName)){
        val = byName.get(aliasName); matchedAlias++;
      } else if(byName.has(normalizeName(it.name))){
        val = byName.get(normalizeName(it.name)); matchedAlias++;
      } else {
        // No confident match — auto-fill the closest guess (by token overlap) so the user
        // only has to eyeball/correct it, rather than typing every unmatched row by hand.
        const best = distEntries
          .map(d=>({...d, score: fuzzyScore(it.name, d.rawName)}))
          .sort((a,b)=>b.score-a.score)[0];
        if(best && best.score>0.15){
          val = best.value;
          guesses.set(it.id, best);
          guessed++;
        } else {
          noMatch++;
        }
      }
      if(val!==null){ it[field] = val; }
    }

    pendingGuesses[field] = { poId, map: guesses };
    if(field==='distSalesQty') renderSalesTable(); else renderStockTable();
    renderDashboard();

    const parts = [];
    if(matchedBarcode) parts.push(`${matchedBarcode} by barcode`);
    if(matchedAlias) parts.push(`${matchedAlias} by name`);
    if(guessed) parts.push(`${guessed} auto-guessed (🔍 marked — check these)`);
    const matchedSummary = parts.length? parts.join(', ') : '0';
    const filterNote = storeFilterApplied ? ` (filtered to ${storeMatchedRows} row(s) for this store)` : '';
    statusEl.textContent = `Matched ${matchedSummary}${filterNote}${noMatch? `, ${noMatch} item(s) had no plausible match — fill manually`:''}. Review the table below, then click Save table.`;
  } catch(err){
    console.error(err);
    statusEl.textContent = 'Import failed (' + err.message + ').';
  }
  fileInput.value = '';
}

document.getElementById('dcSalesImport').addEventListener('click', ()=>{
  importDcFile('dcSalesFile', /qty|quantity|sales|jual|terjual|sold|shipped/i, 'distSalesQty', 'dcSalesStatus', 'dcPoSelect');
});
document.getElementById('scStockImport').addEventListener('click', ()=>{
  importDcFile('scStockFile', /stock|stok|on\s*hand|inventory|inventori/i, 'distStockQty', 'scStockStatus', 'scPoSelect');
});

/* ---------- Helpers ---------- */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Auth gate (Google sign-in) ---------- */
const APP_PASSCODE = 'NFI2026';
const PASSCODE_SESSION_KEY = 'kdi-passcode-ok';

function requirePasscode(){
  return new Promise((resolve)=>{
    if(sessionStorage.getItem(PASSCODE_SESSION_KEY) === '1'){ resolve(); return; }
    const overlay = document.createElement('div');
    overlay.id = 'passcodeOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
    overlay.innerHTML = `
      <form id="passcodeForm" style="background:#fff;padding:28px 32px;border-radius:10px;min-width:280px;box-shadow:0 10px 30px rgba(0,0,0,.3);">
        <div style="font-size:16px;font-weight:600;margin-bottom:12px;">Enter access code</div>
        <input id="passcodeInput" type="password" autocomplete="off" style="width:100%;padding:10px;font-size:14px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;" />
        <div id="passcodeError" style="color:#e0453d;font-size:13px;margin-top:8px;min-height:18px;"></div>
        <button type="submit" style="margin-top:10px;width:100%;padding:10px;font-size:14px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;">Enter</button>
      </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('#passcodeForm');
    const input = overlay.querySelector('#passcodeInput');
    const errorEl = overlay.querySelector('#passcodeError');
    input.focus();
    form.addEventListener('submit', (e)=>{
      e.preventDefault();
      if(input.value === APP_PASSCODE){
        sessionStorage.setItem(PASSCODE_SESSION_KEY, '1');
        overlay.remove();
        resolve();
      } else {
        errorEl.textContent = 'Incorrect code, try again.';
        input.value = '';
        input.focus();
      }
    });
  });
}

/* ---------- Init ---------- */
(async function init(){
  try{
    await requirePasscode();
    await openDB();
    await loadAll();
    renderDashboard();
  } catch(err){
    console.error('App failed to start:', err);
    showFatalError('⚠️ The app failed to start (' + err.message + '). Try closing other tabs of this app and reloading.');
  }
})();

window.addEventListener('error', (e)=>{
  console.error('Unhandled error:', e.error || e.message);
  showFatalError('⚠️ Something went wrong: ' + (e.error?.message || e.message) + '. Try a hard refresh (Ctrl+Shift+R).');
});
