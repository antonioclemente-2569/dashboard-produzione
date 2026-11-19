/* ============================================================
   SERVIZIO PRESTITI – richiesta: documenti, lettura OCR, verifica, invio
   Usa dal file principale: A, Q, vis, show, RECAP, eur, eur2, pct, esc,
   WEBHOOK_URL, LEAD_EMAIL.
   ============================================================ */
(function(){
"use strict";

const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const PDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* Documenti di reddito richiesti da ciascuna finanziaria.
   VALORI DA CONFERMARE con il manuale operativo Banca Sistema. */
const REDDITO_DOCS = {
  agos:    { dipendente: 2, pensionato: 1, autonomo: 1 },
  compass: { dipendente: 2, pensionato: 1, autonomo: 1 },
  conte:   { dipendente: 2, pensionato: 1, autonomo: 1 }
};

/* ---------------- stato ---------------- */
const S = { key: null, offer: null, slots: [], files: {}, status: {}, texts: {}, D: {}, src: {}, step: 1, sending: false };
const $ = id => document.getElementById(id);
const occType = () => A.occupazione === "pensionato" ? "pensionato" : A.occupazione === "autonomo" ? "autonomo" : "dipendente";

function slotsFor(key){
  const s = [
    { id: "id_front", label: "Documento d'identità – fronte", hint: "Carta d'identità, patente o passaporto", kind: "id", req: true },
    { id: "id_back", label: "Documento d'identità – retro", hint: "Non serve per il passaporto", kind: "id", req: false },
    { id: "ts", label: "Tessera sanitaria – fronte", hint: "Ci serve per il codice fiscale", kind: "ts", req: true }
  ];
  if (A.cittadinanza === "extra") s.push({ id: "permesso", label: "Permesso di soggiorno", hint: "Fronte e retro, anche in un unico PDF", kind: "permesso", req: true });
  const occ = occType();
  const n = (REDDITO_DOCS[key] || {})[occ] || 1;
  if (occ === "dipendente") for (let i = 1; i <= n; i++) s.push({ id: "busta_" + i, label: i === 1 ? "Ultima busta paga" : i === 2 ? "Penultima busta paga" : `Busta paga n. ${i}`, hint: "Foto leggibile o PDF", kind: "busta", req: true });
  if (occ === "pensionato") s.push({ id: "cedolino", label: "Ultimo cedolino della pensione", hint: "Scaricabile dal sito INPS", kind: "busta", req: true });
  if (occ === "autonomo") s.push({ id: "redditi", label: "Ultima dichiarazione dei redditi", hint: "Modello Redditi PF con la ricevuta di presentazione", kind: "redditi", req: true });
  return s;
}

/* ---------------- lettura file ---------------- */
function loadScript(src){
  return new Promise((res, rej) => {
    if ([...document.scripts].some(s => s.src === src)) return res();
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Libreria non raggiungibile: " + src));
    document.head.appendChild(s);
  });
}
let tess = null, onProgress = null;
async function ocr(canvas){
  await loadScript(TESS_URL);
  if (!tess) tess = await Tesseract.createWorker("ita", 1, { logger: m => { if (m.status === "recognizing text" && onProgress) onProgress(m.progress); } });
  const { data } = await tess.recognize(canvas);
  return data.text || "";
}
async function fileToCanvas(file){
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height)) * (Math.max(bmp.width, bmp.height) < 1200 ? 1.8 : 1);
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d"); g.filter = "grayscale(1) contrast(1.25)"; g.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}
function itemsToLines(items){
  const rows = [];
  items.forEach(it => {
    if (!it.str || !it.str.trim()) return;
    const y = it.transform[5], x = it.transform[4];
    let r = rows.find(r => Math.abs(r.y - y) < 3);
    if (!r){ r = { y, parts: [] }; rows.push(r); }
    r.parts.push({ x, s: it.str });
  });
  return rows.sort((a, b) => b.y - a.y).map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ")).join("\n");
}
async function fileToText(file){
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)){
    await loadScript(PDF_URL);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = Math.min(pdf.numPages, 3);
    let text = "";
    for (let p = 1; p <= pages; p++){ const page = await pdf.getPage(p); text += itemsToLines((await page.getTextContent()).items) + "\n"; }
    if (text.replace(/\s/g, "").length > 80) return text;           // PDF digitale: testo già presente
    text = "";
    for (let p = 1; p <= pages; p++){                                   // PDF scansionato: OCR delle pagine
      const page = await pdf.getPage(p); const vp = page.getViewport({ scale: 2.2 });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      text += await ocr(c) + "\n";
    }
    return text;
  }
  return ocr(await fileToCanvas(file));
}

/* ---------------- riconoscimento dati ---------------- */
const MESI_CF = "ABCDEHLMPRST", OMO = "LMNPQRSTUV";
const ODD = {0:1,1:0,2:5,3:7,4:9,5:13,6:15,7:17,8:19,9:21,A:1,B:0,C:5,D:7,E:9,F:13,G:15,H:17,I:19,J:21,K:2,L:4,M:18,N:20,O:11,P:3,Q:6,R:8,S:12,T:14,U:16,V:10,W:22,X:25,Y:24,Z:23};
function cfValid(cf){
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) return false;
  let s = 0;
  for (let i = 0; i < 15; i++){ const c = cf[i]; s += i % 2 === 0 ? ODD[c] : (/\d/.test(c) ? +c : c.charCodeAt(0) - 65); }
  return String.fromCharCode(65 + s % 26) === cf[15];
}
const LETTER_POS = [0,1,2,3,4,5,8,11,15], DIGIT_POS = [6,7,9,10,12,13,14];
function fixCF(c){
  const a = c.split("");
  LETTER_POS.forEach(i => { a[i] = ({ "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G", "4": "A" })[a[i]] || a[i]; });
  DIGIT_POS.forEach(i => { a[i] = ({ O: "0", D: "0", I: "1", B: "8", Z: "2", G: "6" })[a[i]] || a[i]; });
  return a.join("");
}
function findCF(text){
  const L = text.toUpperCase().split("\n");
  const toks = L.flatMap(l => l.split(/[^A-Z0-9]+/)).filter(t => t.length === 16);
  for (const t of toks) if (cfValid(t)) return t;                       // 1. parola intera, così com'è
  const wins = [];
  L.forEach(line => { const c = line.replace(/[^A-Z0-9]/g, ""); for (let i = 0; i + 16 <= c.length; i++) wins.push(c.slice(i, i + 16)); });
  for (const w of wins) if (cfValid(w)) return w;                       // 2. senza spazi (OCR che spezza le parole)
  for (const t of toks){ const f = fixCF(t); if (cfValid(f)) return f; } // 3. parola intera con correzione O/0, I/1…
  return "";
}
function deomo(ch){ const i = OMO.indexOf(ch); return i >= 0 ? String(i) : ch; }
function decodeCF(cf){
  const yy = +(deomo(cf[6]) + deomo(cf[7])), mm = MESI_CF.indexOf(cf[8]) + 1;
  let dd = +(deomo(cf[9]) + deomo(cf[10])); const sesso = dd > 40 ? "F" : "M"; if (dd > 40) dd -= 40;
  const nowY = new Date().getFullYear();
  const yyyy = 2000 + yy > nowY - 16 ? 1900 + yy : 2000 + yy;
  return { nascita: `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yyyy}`, sesso };
}
function cfPart(s, isName){
  s = (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
  const cons = s.replace(/[AEIOU]/g, ""), voc = s.replace(/[^AEIOU]/g, "");
  if (isName && cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + voc + "XXX").slice(0, 3);
}

const RE_DATE = "(\\d{2})\\s?[\\/.\\-]\\s?(\\d{2})\\s?[\\/.\\-]\\s?(\\d{4}|\\d{2})";
function normDate(d, m, y, futuro){ if (y.length === 2) y = (futuro ? "20" : (+y > 30 ? "19" : "20")) + y; return `${d}/${m}/${y}`; }
function dateAfter(T, labels, futuro){
  for (const l of labels){ const m = T.match(new RegExp(l + "[^0-9]{0,40}" + RE_DATE)); if (m) return normDate(m[1], m[2], m[3], futuro); }
  return "";
}
function lines(t){ return t.split("\n").map(x => x.trim()).filter(Boolean); }
const LABEL_WORDS = /^(SURNAME|NAME|GIVEN NAMES?|COGNOME|NOME|COGNOMI|NOMI)\b/;
function valueAfter(L, labels, re){
  re = re || /[A-ZÀ-Ý][A-ZÀ-Ý' ]*[A-ZÀ-Ý]/;
  for (const lab of labels){
    const lre = new RegExp("(^|[^A-Z])" + lab + "(?![A-Z])");
    for (let i = 0; i < L.length; i++){
      const up = L[i].toUpperCase(); const m0 = up.match(lre); if (!m0) continue;
      let rest = up.slice(m0.index + m0[0].length);
      if (/^\s*\/\s*[A-Z]/.test(rest)) rest = "";                   // etichetta bilingue "ITALIANO / ENGLISH"
      rest = rest.replace(/^[\s:\/.\-|]+/, "");
      for (let k = 0; k < 2; k++) rest = rest.replace(LABEL_WORDS, "").replace(/^[\s:\/.\-|]+/, "");
      let m = rest.match(re); if (m && m[0].trim().length >= 2) return m[0].trim();
      for (let j = i + 1; j < Math.min(i + 3, L.length); j++){ m = L[j].toUpperCase().replace(LABEL_WORDS, "").match(re); if (m && m[0].trim().length >= 2) return m[0].trim(); }
    }
  }
  return "";
}
function yymmdd(s, futuro){
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^\d{6}$/.test(s)) return "";
  const yy = +s.slice(0, 2), nowYY = new Date().getFullYear() % 100;
  const yyyy = futuro ? 2000 + yy : (yy > nowYY ? 1900 + yy : 2000 + yy);
  return `${s.slice(4, 6)}/${s.slice(2, 4)}/${yyyy}`;
}
function parseMRZ(text){
  const L = text.toUpperCase().split("\n").map(l => l.replace(/\s/g, "").replace(/[«‹]/g, "<")).filter(l => (l.match(/</g) || []).length >= 2 && l.length >= 20);
  if (!L.length) return null;
  const r = {};
  for (const l of L){
    const d = l.match(/([0-9OIL]{6})[0-9OIL<]([MF<])([0-9OIL]{6})/);
    if (d && !r.nascita){ r.nascita = yymmdd(d[1]); r.sesso = d[2] === "<" ? "" : d[2]; r.scadenza = yymmdd(d[3], true); }
    if (/^[CIA][A-Z<][A-Z]{3}/.test(l) && !r.numero) r.numero = l.slice(5, 14).replace(/</g, "");
    if (/^P[A-Z<][A-Z]{3}[A-Z]/.test(l)){ const n = l.slice(5).split("<<"); r.cognome = n[0].replace(/</g, " ").trim(); r.nome = (n[1] || "").replace(/</g, " ").trim(); }
    if (/^[A-Z0-9<]{9}\d[A-Z]{3}\d{6}/.test(l) && !r.numero) r.numero = l.slice(0, 9).replace(/</g, "");
    if (!r.cognome && /^[A-Z]+(<[A-Z]+)*<<[A-Z]/.test(l) && !/\d/.test(l)){ const n = l.split("<<"); r.cognome = n[0].replace(/</g, " ").trim(); r.nome = (n[1] || "").replace(/</g, " ").trim(); }
  }
  return r;
}
function docNumber(T){
  const t = T.replace(/[^A-Z0-9\n ]/g, " ");
  let m = t.match(/\b([A-Z]{2}\s?\d{5}\s?[A-Z]{2})\b/); if (m) return m[1].replace(/\s/g, "");
  m = t.match(/\b([A-Z]{2}\d{7}[A-Z])\b/); if (m) return m[1];
  m = t.match(/\b([A-Z]{2}\s?\d{7})\b/); if (m) return m[1].replace(/\s/g, "");
  return "";
}
function numLine(L, n){ const re = new RegExp("^" + n + "\\s*[.,)]\\s*(.+)$"); for (const l of L){ const m = l.toUpperCase().match(re); if (m) return m[1].trim(); } return ""; }
function parseID(text){
  const T = text.toUpperCase(), L = lines(text), r = {};
  r.tipo = /PATENTE|DRIVING/.test(T) ? "Patente di guida" : /PASSAPORTO|PASSPORT/.test(T) ? "Passaporto" : /CARTA|IDENTIT|IDENTITY/.test(T) ? "Carta d'identità" : "";
  if (r.tipo === "Patente di guida"){
    r.cognome = (numLine(L, "1").match(/[A-Z' ]+/) || [""])[0].trim();
    r.nome = (numLine(L, "2").match(/[A-Z' ]+/) || [""])[0].trim();
    const l3 = numLine(L, "3"); const d3 = l3.match(new RegExp(RE_DATE)); if (d3) r.nascita = normDate(d3[1], d3[2], d3[3]);
    const lp = l3.replace(new RegExp(RE_DATE), "").match(/[A-Z][A-Z' ]+(\s*\(\s*[A-Z]{2}\s*\))?/); if (lp) r.luogoNascita = lp[0].trim();
    const d4a = numLine(L, "4A").match(new RegExp(RE_DATE)); if (d4a) r.rilascio = normDate(d4a[1], d4a[2], d4a[3]);
    const d4b = numLine(L, "4B").match(new RegExp(RE_DATE)); if (d4b) r.scadenza = normDate(d4b[1], d4b[2], d4b[3], true);
    const n5 = numLine(L, "5").replace(/\s/g, ""); if (/^[A-Z0-9]{8,12}$/.test(n5)) r.numero = n5;
  } else {
    r.cognome = valueAfter(L, ["COGNOME", "SURNAME"]);
    r.nome = valueAfter(L, ["NOME", "NAME", "GIVEN NAMES"]);
    r.nascita = dateAfter(T, ["DATA DI NASCITA", "NASCITA", "BIRTH"]);
    r.luogoNascita = valueAfter(L, ["LUOGO E DATA DI NASCITA", "LUOGO DI NASCITA", "PLACE OF BIRTH"], /[A-Z][A-Z' ]*[A-Z](\s*\(\s*[A-Z]{2}\s*\))?/);
    r.rilascio = dateAfter(T, ["EMISSIONE", "RILASCIO", "ISSUING", "ISSUE"]);
    r.scadenza = dateAfter(T, ["SCADENZA", "EXPIRY", "VALIDA FINO"], true);
    r.indirizzo = valueAfter(L, ["INDIRIZZO DI RESIDENZA", "RESIDENZA", "ADDRESS"], /[A-Z0-9][A-Z0-9' ,./()]{4,}/);
  }
  if (!r.numero) r.numero = docNumber(T);
  const mrz = parseMRZ(text);
  if (mrz) ["cognome", "nome", "nascita", "scadenza", "numero", "sesso"].forEach(k => { if (mrz[k] && (!r[k] || k === "numero" || k === "nascita")) r[k] = mrz[k]; });
  const cf = findCF(text); if (cf) r.cf = cf;
  return r;
}
function toNum(s){ return +s.replace(/[.\s]/g, "").replace(",", "."); }
function amountAfter(T, labels, min, max){
  for (const l of labels){
    const re = new RegExp(l + "[^0-9\\n]{0,60}((?:\\d{1,3}(?:[.\\s]\\d{3})+|\\d+),\\d{2})", "g");
    let m, last = 0; while ((m = re.exec(T))){ const v = toNum(m[1]); if (v >= min && v <= max) last = v; }
    if (last) return last;
  }
  return 0;
}
function parseBusta(text){
  const T = text.toUpperCase(), L = lines(text), r = {};
  r.netto = amountAfter(T, ["NETTO IN BUSTA", "NETTO A PAGARE", "NETTO DEL MESE", "TOTALE NETTO", "NETTO PAGATO", "IMPORTO NETTO", "NETTO"], 200, 20000);
  r.datore = (occType() === "pensionato" && /\bINPS\b/.test(T)) ? "INPS" : valueAfter(L, ["RAGIONE SOCIALE", "DATORE DI LAVORO", "AZIENDA", "DITTA", "ENTE"], /[A-Z0-9][A-Z0-9&.,' \-]{2,}[A-Z0-9.]/);
  r.assunzione = dateAfter(T, ["DATA DI ASSUNZIONE", "DATA ASSUNZIONE", "ASSUNZIONE", "ASSUNTO IL", "DATA ASS"]);
  const ib = T.replace(/[\s\-]/g, "").match(/IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}/); if (ib) r.iban = ib[0];
  const per = T.match(/(GENNAIO|FEBBRAIO|MARZO|APRILE|MAGGIO|GIUGNO|LUGLIO|AGOSTO|SETTEMBRE|OTTOBRE|NOVEMBRE|DICEMBRE)\s*(20\d{2})/); if (per) r.periodo = per[1].charAt(0) + per[1].slice(1).toLowerCase() + " " + per[2];
  const cf = findCF(text); if (cf) r.cf = cf;
  return r;
}
function parseRedditi(text){
  const T = text.toUpperCase(), r = {};
  r.redditoAnnuo = amountAfter(T, ["REDDITO COMPLESSIVO", "REDDITO IMPONIBILE", "REDDITO"], 1000, 2000000);
  if (r.redditoAnnuo) r.netto = Math.round(r.redditoAnnuo / 12);
  const cf = findCF(text); if (cf) r.cf = cf;
  const ib = T.replace(/[\s\-]/g, "").match(/IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}/); if (ib) r.iban = ib[0];
  return r;
}
window.SP_parse = { parseID, parseBusta, parseRedditi, findCF, cfValid, decodeCF, parseMRZ };

/* ---------------- unione dei dati letti ---------------- */
function put(k, v, src, force){ if (v === undefined || v === null || v === "" || v === 0) return; if (S.D[k] && !force) return; S.D[k] = String(v); S.src[k] = src; }
function mergeAll(){
  S.D = {}; S.src = {};
  Object.keys(S).filter(k => k.startsWith("cfBusta")).forEach(k => delete S[k]);
  const byKind = k => S.slots.filter(s => s.kind === k && S.texts[s.id]);
  // tessera sanitaria: fonte più affidabile del codice fiscale
  byKind("ts").forEach(s => { const r = parseID(S.texts[s.id]); put("cf", r.cf, "tessera sanitaria"); put("cognome", r.cognome, "tessera sanitaria"); put("nome", r.nome, "tessera sanitaria"); });
  const idText = byKind("id").map(s => S.texts[s.id]).join("\n");
  if (idText){
    const r = parseID(idText);
    ["cognome", "nome"].forEach(k => put(k, r[k], "documento d'identità", true));
    ["tipo", "numero", "rilascio", "scadenza", "nascita", "luogoNascita", "sesso"].forEach(k => put(k, r[k], "documento d'identità"));
    const ind = (r.indirizzo || "").match(/^(.*\d+\s?[A-Z]?)\s+([A-Z][A-Z' ]*?)\s*\(\s*([A-Z]{2})\s*\)$/);
    if (ind){ put("indirizzo", ind[1], "documento d'identità"); put("comune", ind[2], "documento d'identità"); put("prov", ind[3], "documento d'identità"); }
    else put("indirizzo", r.indirizzo, "documento d'identità");
    put("cf", r.cf, "documento d'identità");
  }
  if (S.D.cf && cfValid(S.D.cf)){ const d = decodeCF(S.D.cf); put("nascita", d.nascita, "codice fiscale"); put("sesso", d.sesso, "codice fiscale"); }
  const buste = byKind("busta");
  buste.forEach((s, i) => {
    const r = parseBusta(S.texts[s.id]); const lab = occType() === "pensionato" ? "cedolino" : "busta paga";
    if (i === 0){ put("netto", r.netto ? r.netto.toFixed(2).replace(".", ",") : "", lab); put("periodo", r.periodo, lab); }
    put("datore", r.datore, lab); put("assunzione", r.assunzione, lab); put("iban", r.iban, lab);
    if (r.cf) S["cfBusta" + i] = r.cf;
  });
  byKind("redditi").forEach(s => { const r = parseRedditi(S.texts[s.id]); put("redditoAnnuo", r.redditoAnnuo ? eur(r.redditoAnnuo) : "", "dichiarazione dei redditi"); put("netto", r.netto ? r.netto.toFixed(2).replace(".", ",") : "", "dichiarazione dei redditi"); put("iban", r.iban, "dichiarazione dei redditi"); if (r.cf) S.cfBusta0 = r.cf; });
}

/* ---------------- controlli ---------------- */
function parseIt(d){ const m = (d || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
function checks(){
  const D = S.D, out = [];
  const cf = (D.cf || "").toUpperCase().replace(/\s/g, "");
  if (cf && !cfValid(cf)) out.push(["bad", "Il codice fiscale non è valido: controlla di averlo trascritto correttamente."]);
  if (cf && cfValid(cf)){
    if (D.cognome && cfPart(D.cognome) !== cf.slice(0, 3)) out.push(["warn", "Il cognome non corrisponde al codice fiscale: controllalo."]);
    if (D.nome && cfPart(D.nome, true) !== cf.slice(3, 6)) out.push(["warn", "Il nome non corrisponde al codice fiscale: controllalo."]);
    const dec = decodeCF(cf); if (D.nascita && dec.nascita !== D.nascita) out.push(["warn", `La data di nascita non corrisponde al codice fiscale (${dec.nascita}).`]);
    Object.keys(S).filter(k => k.startsWith("cfBusta")).forEach(k => { if (S[k] && S[k] !== cf) out.push(["warn", "Il codice fiscale sul documento di reddito è diverso da quello del richiedente: il documento è intestato a te?"]); });
  }
  const sc = parseIt(D.scadenza); if (sc && sc < new Date()) out.push(["bad", "Il documento d'identità risulta scaduto: carica un documento valido."]);
  const nas = parseIt(D.nascita);
  if (nas){ const eta = Math.floor((Date.now() - nas) / 31557600000); if (Math.abs(eta - (+A.eta || eta)) > 1) out.push(["warn", `Dai documenti risulti avere ${eta} anni, nel percorso avevi indicato ${A.eta}.`]); }
  const netto = toNum((D.netto || "0").replace(/[^\d,.]/g, "") || "0");
  if (netto && +A.reddito && Math.abs(netto - A.reddito) / A.reddito > 0.15) out.push(["warn", `Il netto letto (${eur(netto)}) è diverso da quello indicato nel percorso (${eur(+A.reddito)}): la valutazione userà quello del documento.`]);
  if (D.iban && !/^IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}$/.test(D.iban.replace(/\s/g, "").toUpperCase())) out.push(["warn", "L'IBAN non ha il formato italiano corretto (27 caratteri, inizia con IT)."]);
  return out;
}

/* ---------------- interfaccia ---------------- */
function root(){ return $("apply"); }
function stepsBar(){
  const st = ["Carica i documenti", "Controlla i dati", "Invia"];
  return `<div class="ap-steps">${st.map((t, i) => `<span class="sec ${i + 1 === S.step ? "on" : i + 1 < S.step ? "done" : ""}">${i + 1}. ${t}</span>`).join("")}</div>`;
}
function header(){
  const o = S.offer;
  return `<div class="ap-head"><div><h2>Richiesta di prestito ${esc(o.nome)}</h2>
    <span class="hint num">${eur(+A.importo)} in ${o.durata} mesi · rata stimata ${eur2(o.rata)}</span></div>
    <button type="button" class="btn ghost" id="apBack">Torna al risultato</button></div>${stepsBar()}`;
}
function render(){
  const R = root();
  if (S.step === 1) R.innerHTML = header() + step1();
  if (S.step === 2) R.innerHTML = header() + step2();
  if (S.step === 3) R.innerHTML = header() + step3();
  $("apBack").addEventListener("click", close);
  if (S.step === 1) wire1();
  if (S.step === 2) wire2();
  if (S.step === 3) wire3();
}
function step1(){
  const ready = S.slots.filter(s => s.req).every(s => S.files[s.id]);
  return `<div class="ap-body">
    <p class="help">Carica una foto ben leggibile o il PDF di ogni documento. I documenti vengono letti in automatico per compilare i tuoi dati: dopo potrai controllarli e correggerli.</p>
    <div class="slots">${S.slots.map(s => {
      const f = S.files[s.id], st = S.status[s.id] || "";
      return `<label class="slot ${f ? "has" : ""}" for="f_${s.id}">
        <input type="file" id="f_${s.id}" data-slot="${s.id}" accept="image/*,application/pdf">
        <span class="slot-t"><b>${esc(s.label)}</b>${s.req ? "" : ' <i class="opt">facoltativo</i>'}</span>
        <span class="slot-h">${f ? esc(f.name) : esc(s.hint || "")}</span>
        <span class="slot-s ${st.startsWith("Letto") ? "ok" : st.startsWith("Non") ? "ko" : ""}">${f ? (st || "Pronto da leggere") : "Scegli file o scatta una foto"}</span>
      </label>`;
    }).join("")}</div>
    <p class="err" id="apErr"></p>
    <div class="nav"><span class="hint">I documenti restano sul tuo dispositivo finché non invii la richiesta.</span>
      <button type="button" class="btn primary" id="apRead" ${ready && !S.reading ? "" : "disabled"}>${S.reading ? "Lettura in corso…" : "Leggi i documenti e compila i dati"}</button></div>
  </div>`;
}
function wire1(){
  root().querySelectorAll("input[type=file]").forEach(inp => inp.addEventListener("change", () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 15 * 1024 * 1024){ $("apErr").textContent = "Il file supera 15 MB: carica una foto o un PDF più leggero."; return; }
    S.files[inp.dataset.slot] = f; S.status[inp.dataset.slot] = ""; delete S.texts[inp.dataset.slot]; render();
  }));
  $("apRead").addEventListener("click", readAll);
}
async function readAll(){
  S.reading = true; render();
  const todo = S.slots.filter(s => S.files[s.id] && !S.texts[s.id]);
  let failed = 0;
  for (const s of todo){
    S.status[s.id] = "Lettura in corso…"; render();
    onProgress = p => { const el = root().querySelector(`label[for="f_${s.id}"] .slot-s`); if (el) el.textContent = `Lettura in corso… ${Math.round(p * 100)}%`; };
    try { S.texts[s.id] = await fileToText(S.files[s.id]); S.status[s.id] = S.texts[s.id].replace(/\s/g, "").length > 20 ? "Letto" : "Non leggibile: compila a mano"; }
    catch (e){ console.error(e); failed++; S.texts[s.id] = ""; S.status[s.id] = "Non leggibile: compila a mano"; }
  }
  onProgress = null; S.reading = false;
  mergeAll();
  S.ocrFailed = failed === todo.length && todo.length > 0;
  S.step = 2; render(); window.scrollTo({ top: 0, behavior: "smooth" });
}
function fieldDefs(){
  const occ = occType();
  const lav = [["datore", occ === "pensionato" ? "Ente che paga la pensione" : occ === "autonomo" ? "Attività" : "Datore di lavoro", false]];
  if (occ === "dipendente") lav.push(["assunzione", "Data di assunzione", false]);
  if (occ === "autonomo") lav.push(["redditoAnnuo", "Reddito annuo dichiarato", false]);
  lav.push(["netto", occ === "autonomo" ? "Reddito netto mensile medio (€)" : occ === "pensionato" ? "Pensione netta dall'ultimo cedolino (€)" : "Netto dall'ultima busta paga (€)", true]);
  lav.push(["iban", "IBAN per l'accredito del prestito", true]);
  return [
    ["Dati personali", [["nome", "Nome", true], ["cognome", "Cognome", true], ["cf", "Codice fiscale", true], ["sesso", "Sesso (M/F)", true], ["nascita", "Data di nascita (gg/mm/aaaa)", true], ["luogoNascita", "Luogo di nascita", true]]],
    ["Documento d'identità", [["tipo", "Tipo di documento", true], ["numero", "Numero del documento", true], ["rilascio", "Data di rilascio", false], ["scadenza", "Data di scadenza", true]]],
    ["Residenza", [["indirizzo", "Indirizzo", true], ["cap", "CAP", true], ["comune", "Comune", true], ["prov", "Provincia (sigla)", true]]],
    ["Lavoro e reddito", lav],
    ["Contatti", [["cell", "Cellulare", true], ["email", "Email", true]]]
  ];
}
function step2(){
  const letti = Object.keys(S.src).length;
  const intro = S.ocrFailed
    ? `<div class="alert warn">Non siamo riusciti a leggere i documenti in automatico. Compila i dati qui sotto: li confronteremo con i documenti caricati.</div>`
    : `<div class="alert good">Abbiamo letto ${letti} dati dai tuoi documenti. Controllali uno per uno, correggi quelli sbagliati e completa quelli mancanti.</div>`;
  return `<div class="ap-body">${intro}
    <form id="apForm" novalidate>
    ${fieldDefs().map(([g, fs]) => `<fieldset><legend>${g}</legend><div class="row2">${fs.map(([k, l, req]) => `
      <div class="field"><label for="d_${k}">${l}${req ? "" : ' <i class="opt">facoltativo</i>'}</label>
        <input type="text" id="d_${k}" data-k="${k}" value="${esc(S.D[k] || "")}" ${req ? "required" : ""} autocomplete="off">
        ${S.src[k] ? `<span class="src">Letto da: ${esc(S.src[k])}</span>` : (req ? `<span class="src miss">Da compilare</span>` : "")}
      </div>`).join("")}</div></fieldset>`).join("")}
    <div class="alerts" id="apChecks"></div>
    <label class="check"><input type="checkbox" id="apVer"> <span>Dichiaro che i dati sono veritieri e corrispondono ai documenti caricati.</span></label>
    <label class="check"><input type="checkbox" id="apPriv"> <span>Ho letto l'informativa privacy e acconsento al trattamento dei dati e dei documenti per la valutazione della richiesta di finanziamento (obbligatorio).</span></label>
    <label class="check"><input type="checkbox" id="apMkt"> <span>Acconsento a ricevere comunicazioni commerciali da Servizio Prestiti (facoltativo).</span></label>
    <p class="err" id="apErr"></p>
    <div class="nav"><button type="button" class="btn ghost" id="apDocs">Torna ai documenti</button>
      <button type="submit" class="btn primary">Invia la richiesta in valutazione</button></div>
    </form></div>`;
}
function renderChecks(){ const c = checks(); $("apChecks").innerHTML = c.map(([k, t]) => `<div class="alert ${k}">${esc(t)}</div>`).join(""); }
function wire2(){
  root().querySelectorAll("#apForm input[data-k]").forEach(i => i.addEventListener("input", () => {
    let v = i.value; if (["cf", "iban", "prov", "sesso"].includes(i.dataset.k)) { v = v.toUpperCase(); i.value = v; }
    S.D[i.dataset.k] = v; renderChecks();
  }));
  renderChecks();
  $("apDocs").addEventListener("click", () => { S.step = 1; render(); });
  $("apForm").addEventListener("submit", e => { e.preventDefault(); submit(); });
}
async function submit(){
  const err = $("apErr"); err.textContent = "";
  const miss = fieldDefs().flatMap(([, fs]) => fs).filter(([k, , req]) => req && !(S.D[k] || "").trim()).map(([, l]) => l);
  if (miss.length) return err.textContent = "Mancano: " + miss.join(", ") + ".";
  if (!cfValid((S.D.cf || "").toUpperCase().replace(/\s/g, ""))) return err.textContent = "Il codice fiscale non è valido.";
  if (!/^[+0-9\s]{8,16}$/.test(S.D.cell)) return err.textContent = "Inserisci un numero di cellulare valido.";
  if (!/^\S+@\S+\.\S+$/.test(S.D.email)) return err.textContent = "Inserisci un indirizzo email valido.";
  if (checks().some(([k]) => k === "bad")) return err.textContent = "Correggi gli errori segnalati in rosso prima di inviare.";
  if (!$("apVer").checked || !$("apPriv").checked) return err.textContent = "Per inviare servono la dichiarazione di veridicità e il consenso privacy.";
  const o = S.offer;
  const profilo = Object.fromEntries(RECAP.filter(([id]) => vis(Q.find(q => q.id === id))).map(([id, l]) => [l, show(id)]));
  const req = {
    data: new Date().toISOString(), fonte: "Servizio Prestiti – richiesta online",
    finanziaria: o.nome, importo: +A.importo, durata: o.durata, rata_stimata: +o.rata.toFixed(2), tan: o.tan, taeg_stimato: +o.taeg.toFixed(2),
    richiedente: S.D, fonti_dati: S.src, controlli: checks().map(c => c[1]), percorso: profilo,
    documenti: S.slots.filter(s => S.files[s.id]).map(s => ({ campo: s.id, tipo: s.label, file: S.files[s.id].name })),
    consenso_privacy: true, consenso_marketing: $("apMkt").checked, dichiarazione_veridicita: true
  };
  S.req = req; S.sent = false;
  if (WEBHOOK_URL){
    S.sending = true; err.textContent = "Invio in corso…";
    try {
      const fd = new FormData(); fd.append("dati", JSON.stringify(req));
      S.slots.forEach(s => { if (S.files[s.id]) fd.append(s.id, S.files[s.id], S.files[s.id].name); });
      const r = await fetch(WEBHOOK_URL, { method: "POST", body: fd }); S.sent = r.ok;
    } catch (_){ S.sent = false; }
    S.sending = false;
  }
  S.step = 3; render(); window.scrollTo({ top: 0, behavior: "smooth" });
}
function summaryText(){
  const r = S.req, D = r.richiedente;
  return `NUOVA RICHIESTA IN VALUTAZIONE – SERVIZIO PRESTITI
${r.finanziaria}: ${eur(r.importo)} in ${r.durata} mesi – rata stimata ${eur2(r.rata_stimata)} – TAN ${pct(r.tan)} – TAEG stimato ${pct(r.taeg_stimato)}

RICHIEDENTE
${fieldDefs().map(([g, fs]) => fs.map(([k, l]) => `${l}: ${D[k] || "-"}${r.fonti_dati[k] ? ` (letto da ${r.fonti_dati[k]})` : ""}`).join("\n")).join("\n")}

DOCUMENTI CARICATI
${r.documenti.map(d => `${d.tipo}: ${d.file}`).join("\n")}
${r.controlli.length ? "\nCONTROLLI\n" + r.controlli.join("\n") + "\n" : ""}
PERCORSO
${Object.entries(r.percorso).map(([k, v]) => `${k}: ${v}`).join("\n")}

Dichiarazione di veridicità: sì – Privacy: sì – Marketing: ${r.consenso_marketing ? "sì" : "no"}`;
}
function step3(){
  const nome = esc(S.D.nome || "");
  if (S.sent) return `<div class="ap-body"><div class="alert good"><b>Richiesta inviata.</b> Grazie ${nome}: la tua richiesta con i documenti è in valutazione. Un consulente di Servizio Prestiti ti contatterà al ${esc(S.D.cell)} per l'esito e per la firma online.</div>
    <div class="nav"><button type="button" class="btn ghost" id="apNew">Torna alla pagina iniziale</button></div></div>`;
  return `<div class="ap-body">
    <div class="alert ${WEBHOOK_URL ? "bad" : "warn"}">${WEBHOOK_URL ? "L'invio automatico non è riuscito. " : ""}Per completare, invia la richiesta via email e allega i documenti che hai caricato.</div>
    <pre class="summary" id="apSum">${esc(summaryText())}</pre>
    <div class="nav"><button type="button" class="btn ghost" id="apCopy">Copia riepilogo</button>
      <a class="btn primary" id="apMail" href="mailto:${LEAD_EMAIL}?subject=${encodeURIComponent(`Richiesta prestito ${S.offer.nome} – ${S.D.nome || ""} ${S.D.cognome || ""}`)}&body=${encodeURIComponent(summaryText())}">Invia via email</a></div>
    <p class="hint">Se il pulsante non apre la posta, copia il riepilogo e invialo a ${esc(LEAD_EMAIL)} con i documenti allegati.</p>
  </div>`;
}
function wire3(){
  const c = $("apCopy"); if (c) c.addEventListener("click", async () => { try { await navigator.clipboard.writeText(summaryText()); c.textContent = "Copiato"; } catch (_){ c.textContent = "Seleziona il testo e copialo"; } });
  const n = $("apNew"); if (n) n.addEventListener("click", () => { close(); });
}

/* ---------------- apertura e chiusura ---------------- */
function open(key, offer){
  if (S.key !== key){ S.files = {}; S.status = {}; S.texts = {}; S.D = {}; S.src = {}; }
  S.key = key; S.offer = offer; S.slots = slotsFor(key); S.step = Object.keys(S.D).length ? S.step : 1;
  if (S.step === 3) S.step = 2;
  document.querySelector(".side").hidden = true;
  document.querySelector('section[aria-label="Domande"]').hidden = true;
  root().hidden = false; render(); window.scrollTo({ top: 0, behavior: "smooth" });
}
function close(){
  root().hidden = true;
  document.querySelector(".side").hidden = false;
  document.querySelector('section[aria-label="Domande"]').hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
window.SP_startApply = open;
})();
