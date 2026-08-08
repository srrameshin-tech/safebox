// ============ FIREBASE CONFIG ============
const firebaseConfig = {
  apiKey: "AIzaSyBVGVu59jDZybPFAX_pRisSrQRoXHQ0EWY",
  authDomain: "kmbsc-chit.firebaseapp.com",
  databaseURL: "https://kmbsc-chit-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kmbsc-chit"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
// ---------------- AUTO CHECK: background error/crash logger ----------------
let errorLogQueue = [];
let errorLogFlushTimer = null;
function logAppError(type, message, extra){
  try{
    const entry = { type:type, message:String(message||'').slice(0,500), extra:extra?String(extra).slice(0,800):'', time:Date.now(), ua:navigator.userAgent.slice(0,200), page:location.pathname };
    errorLogQueue.push(entry);
    if(errorLogFlushTimer) clearTimeout(errorLogFlushTimer);
    errorLogFlushTimer = setTimeout(flushErrorLogQueue, 1500);
  }catch(e){}
}
function flushErrorLogQueue(){
  if(!errorLogQueue.length) return;
  const batch = errorLogQueue.splice(0, errorLogQueue.length);
  batch.forEach(function(entry){ try{ db.ref('errorLogs').push(entry); }catch(e){} });
}
window.addEventListener('error', function(e){ logAppError('JS Error', e.message, (e.filename||'')+':'+(e.lineno||'')+' '+(e.error&&e.error.stack?e.error.stack.slice(0,400):'')); });
window.addEventListener('unhandledrejection', function(e){ const r=e.reason; logAppError('Unhandled Promise', r&&r.message?r.message:String(r), r&&r.stack?r.stack.slice(0,400):''); });
document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='hidden') flushErrorLogQueue(); });

const AUTO_CHECK_INTERVAL_MS = 3*24*60*60*1000;
function runAutoCheckDigest(){
  try{
    const lastCheck = Number(localStorage.getItem('autoCheck_lastReview')||0);
    if(Date.now()-lastCheck < AUTO_CHECK_INTERVAL_MS) return;
    db.ref('errorLogs').once('value').then(function(snap){
      const all = snap.val()||{};
      const unresolved = Object.entries(all).filter(function(x){ return !x[1].seen; });
      localStorage.setItem('autoCheck_lastReview', String(Date.now()));
      if(unresolved.length===0) return;
      showAutoCheckPopup(unresolved);
    }).catch(function(){});
  }catch(e){}
}
function showAutoCheckPopup(entries){
  const groups={};
  entries.forEach(function(x){
    const id=x[0], e=x[1];
    const key=(e.type||'Error')+': '+(e.message||'');
    if(!groups[key]) groups[key]={count:0,first:e.time,last:e.time,extra:e.extra,ids:[]};
    groups[key].count++; groups[key].first=Math.min(groups[key].first,e.time); groups[key].last=Math.max(groups[key].last,e.time); groups[key].ids.push(id);
  });
  const lines=Object.entries(groups).map(function(kv){
    const key=kv[0], g=kv[1];
    return '• '+key+'\n   ('+g.count+'x, last: '+new Date(g.last).toLocaleString()+')'+(g.extra?'\n   ↳ '+g.extra:'');
  });
  const fullText = 'Auto Check — '+entries.length+' issue(s) found in last 3 days:\n\n'+lines.join('\n\n');
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
  overlay.innerHTML='<div style="background:#1a1a1a;color:#fff;border-radius:16px;padding:20px;max-width:480px;width:100%;max-height:80vh;display:flex;flex-direction:column;font-family:sans-serif;">'+
    '<h3 style="margin:0 0 12px;color:#FF5C5C;">⚠️ Auto Check — '+entries.length+' issue(s) found</h3>'+
    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;background:#000;padding:12px;border-radius:10px;overflow-y:auto;flex:1;margin:0 0 14px;">'+fullText.replace(/</g,'&lt;')+'</pre>'+
    '<div style="display:flex;gap:10px;">'+
    '<button id="acCopyBtn" style="flex:1;padding:12px;border:none;border-radius:10px;background:#FFC800;color:#000;font-weight:700;">📋 Copy</button>'+
    '<button id="acCloseBtn" style="flex:1;padding:12px;border:none;border-radius:10px;background:#333;color:#fff;font-weight:700;">Mark reviewed & close</button>'+
    '</div></div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#acCopyBtn').addEventListener('click', function(){
    const btn=this;
    navigator.clipboard.writeText(fullText).then(function(){ btn.textContent='Copied ✓'; }).catch(function(){ btn.textContent='Copy failed'; });
  });
  overlay.querySelector('#acCloseBtn').addEventListener('click', function(){
    const allIds=[]; Object.values(groups).forEach(function(g){ g.ids.forEach(function(id){ allIds.push(id); }); });
    allIds.forEach(function(id){ try{ db.ref('errorLogs/'+id).update({seen:true}); }catch(e){} });
    overlay.remove();
  });
}
setTimeout(runAutoCheckDigest, 2500);

const ROOT = "safebox"; // separate namespace from other apps in same project

// ============ STATE ============
let appState = {
  pin: "1973",
  folders: {},   // folderId -> {name, icon, color, createdAt}
  files: {},     // fileId -> {name, folderId, type, data(base64), mime, size, createdAt}
  shares: {}     // code -> {fileId, expiresAt}
};
let enteredPin = "";
let currentFolderId = null;
let currentViewerFileId = null;
let pendingUploadFolderId = null;
let pendingDeleteAction = null;

const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10GB R2 free tier
const WARN_THRESHOLD = 0.75; // warn at 75%
const DANGER_THRESHOLD = 0.9;

const FOLDER_ICONS = ["📁","📄","🆔","🏠","💳","🩺","🚗","🎓","🧾","⚖️","🖼️","📜"];
const FOLDER_COLORS = ["#6c5ce7","#00b894","#e17055","#0984e3","#d63031","#fdcb6e","#a29bfe","#00cec9"];
// The PIN is a convenience lock on top of the Firebase login, not the real gate.
// Recovery now re-checks the Firebase account instead of a code kept in source.

// ============ R2 STORAGE (via Cloudflare Worker) ============
const R2_WORKER_URL = "https://safebox-worker.srrameshin.workers.dev";

// The worker verifies a Firebase ID token, so there is no secret to hide here.
// Tokens last an hour; getIdToken(true) forces a fresh one after a rejection.
async function r2AuthHeader(forceRefresh) {
  const user = firebase.auth().currentUser;
  if (!user) throw new Error("not signed in");
  const token = await user.getIdToken(!!forceRefresh);
  return "Bearer " + token;
}

// One silent retry with a fresh token, then give up. Nothing alarming shown.
async function r2Request(key, init, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let auth;
    try {
      auth = await r2AuthHeader(attempt === 1);
    } catch (e) {
      console.warn("[r2] no session for " + label, e.message);
      throw new Error(label + " failed");
    }
    const opts = Object.assign({}, init);
    opts.headers = Object.assign({}, init.headers || {}, { Authorization: auth });

    let res;
    try {
      res = await fetch(R2_WORKER_URL + "/" + encodeURIComponent(key), opts);
    } catch (netErr) {
      console.warn("[r2] " + label + " network error", netErr);
      if (attempt === 1) throw new Error(label + " failed");
      continue;
    }
    if (res.ok) return res;
    console.warn("[r2] " + label + " -> HTTP " + res.status);
    if (res.status === 401 && attempt === 0) continue;
    const err = new Error(label + " failed");
    err.status = res.status;
    throw err;
  }
  throw new Error(label + " failed");
}
const blobUrlCache = {}; // r2Key -> local blob URL, so we don't re-fetch the same file repeatedly

async function r2Upload(key, blob, contentType) {
  const res = await r2Request(key, {
    method: "PUT",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body: blob,
  }, "Upload");
  return res.json();
}

async function r2Fetch(key) {
  if (blobUrlCache[key]) return blobUrlCache[key];
  const res = await r2Request(key, { method: "GET" }, "Fetch");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobUrlCache[key] = url;
  return url;
}

async function r2Delete(key) {
  const res = await r2Request(key, { method: "DELETE" }, "Delete");
  delete blobUrlCache[key];
  return res.json();
}

function genR2Key() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 24; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// ============ UTILITIES ============
function toast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function openSheet(id) { document.getElementById(id).classList.add("active"); }
function closeSheet(id) { document.getElementById(id).classList.remove("active"); }

function genCode(len = 4) {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function estimateBase64Bytes(str) {
  // rough byte size of a base64 string
  return Math.floor(str.length * 0.75);
}

// ============ LOGIN / PIN ============
// Attach both touchend (instant, no mobile tap-delay) and click (fallback for
// mouse/desktop), guarding against the click firing a second time after touch.
// PIN hashing (SHA-256) — auto-migrates legacy plaintext PINs on next successful use
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function isHashFormat(str) { return typeof str === "string" && /^[a-f0-9]{64}$/i.test(str); }
async function verifyPin(entered, stored) {
  if (!stored) return false;
  if (isHashFormat(stored)) return (await sha256Hex(entered)) === stored;
  return entered === stored; // legacy plaintext fallback
}

function attachKeyTap(btn, handler) {
  let touched = false;
  btn.addEventListener("touchend", (e) => {
    touched = true;
    e.preventDefault();
    handler();
    setTimeout(() => { touched = false; }, 400);
  });
  btn.addEventListener("click", () => {
    if (touched) return;
    handler();
  });
}
function buildKeypad() {
  const keypad = document.getElementById("keypad");
  keypad.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  keys.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "key" + (k === "" ? " empty" : "");
    btn.textContent = k;
    if (k !== "") {
      attachKeyTap(btn, () => handleKeyPress(k));
    }
    keypad.appendChild(btn);
  });
}

function handleKeyPress(k) {
  if (k === "⌫") {
    enteredPin = enteredPin.slice(0, -1);
  } else if (enteredPin.length < 4) {
    enteredPin += k;
  }
  renderPinDots();
  if (enteredPin.length === 4) {
    setTimeout(checkPin, 150);
  }
}

function renderPinDots(errorState = false) {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((d, i) => {
    d.classList.remove("filled", "error");
    if (errorState) d.classList.add("error");
    else if (i < enteredPin.length) d.classList.add("filled");
  });
}

async function checkPin() {
  const ok = await verifyPin(enteredPin, appState.pin);
  if (ok) {
    document.getElementById("loginError").textContent = "";
    if (!isHashFormat(appState.pin)) {
      appState.pin = await sha256Hex(enteredPin); // auto-migrate legacy plaintext to hash
      savePin();
    }
    enteredPin = "";
    showScreen("homeScreen");
    renderHome();
  } else {
    renderPinDots(true);
    document.getElementById("loginError").textContent = "தவறான PIN, மீண்டும் முயற்சி செய்யுங்க";
    setTimeout(() => {
      enteredPin = "";
      renderPinDots();
    }, 500);
  }
}

// ============ FORGOT MASTER PIN (recovery code flow) ============
document.getElementById("forgotPinLink").addEventListener("click", () => {
  document.getElementById("recoveryCodeInput").value = "";
  document.getElementById("recoveryNewPinInput").value = "";
  document.getElementById("recoveryError").textContent = "";
  openSheet("forgotPinSheetOverlay");
});
document.getElementById("cancelRecoveryBtn").addEventListener("click", () => {
  closeSheet("forgotPinSheetOverlay");
});
document.getElementById("confirmRecoveryBtn").addEventListener("click", async () => {
  const pass = document.getElementById("recoveryCodeInput").value;
  const newPin = document.getElementById("recoveryNewPinInput").value.trim();
  const errEl = document.getElementById("recoveryError");
  const btn = document.getElementById("confirmRecoveryBtn");

  if (!/^\d{4}$/.test(newPin)) {
    errEl.textContent = "4-digit PIN கொடுங்க";
    return;
  }

  const user = firebase.auth().currentUser;
  if (!user || !user.email) {
    errEl.textContent = "முதல்ல login பண்ணுங்க";
    return;
  }
  if (!pass) {
    errEl.textContent = "உங்க account password கொடுங்க";
    return;
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "...";
  try {
    // Proving the account password is what authorises a PIN reset.
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, pass);
    await user.reauthenticateWithCredential(cred);
  } catch (e) {
    console.warn("[safebox] reauth failed", e && e.code);
    errEl.textContent = "Password சரியில்ல";
    btn.disabled = false;
    btn.textContent = label;
    return;
  }

  appState.pin = await sha256Hex(newPin);
  savePin();
  document.getElementById("recoveryCodeInput").value = "";
  closeSheet("forgotPinSheetOverlay");
  toast("PIN reset ஆச்சு, புது PIN-ஐ போடுங்க");
  enteredPin = "";
  renderPinDots();
  btn.disabled = false;
  btn.textContent = label;
});

// ============ DATA LOADING ============
let dataLoadedOk = false;

function loadData(callback) {
  db.ref(ROOT).once("value").then(snap => {
    const val = snap.val();
    dataLoadedOk = true;
    if (val) {
      appState.pin = val.pin || "1973";
      appState.folders = val.folders || {};
      appState.files = val.files || {};
      appState.shares = val.shares || {};
      // Node exists but has no folders: leave it alone. Seeding here would
      // overwrite whatever else is already stored under it.
      if (Object.keys(appState.folders).length === 0 && !val.files && !val.shares) {
        seedDefaultFolders();
      }
    } else {
      // Genuinely empty, confirmed by a successful read - safe to seed.
      seedDefaultFolders();
    }
    callback && callback();
  }).catch(err => {
    // Never seed or save after a failed read. The data is still on the server.
    dataLoadedOk = false;
    console.error("[safebox] load failed", err);
    try { logAppError("SafeBox load fail", err && err.message ? err.message : String(err)); } catch (e) {}
    const denied = String((err && (err.code || err.message)) || "").toLowerCase().indexOf("permission") >= 0;
    if (denied) {
      showAdminLogin();
    } else {
      toast("\u0b87\u0ba3\u0bc8\u0baa\u0bcd\u0baa\u0bc1 \u0b95\u0bbf\u0b9f\u0bc8\u0b95\u0bcd\u0b95\u0bb5\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8, \u0bae\u0bc0\u0ba3\u0bcd\u0b9f\u0bc1\u0bae\u0bcd \u0bae\u0bc1\u0baf\u0bb1\u0bcd\u0b9a\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd");
    }
    callback && callback();
  });
}

function seedDefaultFolders() {
  const defaults = [
    { name: "Photos", icon: "🖼️", color: "#6c5ce7" },
    { name: "Documents", icon: "📄", color: "#0984e3" },
    { name: "ID Cards", icon: "🆔", color: "#e17055" }
  ];
  defaults.forEach(f => {
    const id = "f_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    appState.folders[id] = { ...f, createdAt: Date.now() };
  });
  saveFolders();
  savePin();
}

function saveFolders() { db.ref(ROOT + "/folders").set(appState.folders); }
function saveFiles() { db.ref(ROOT + "/files").set(appState.files); }
function saveShares() { db.ref(ROOT + "/shares").set(appState.shares); }
function savePin() { db.ref(ROOT + "/pin").set(appState.pin); }

// ============ STORAGE METER ============
function computeUsedBytes() {
  let total = 0;
  Object.values(appState.files).forEach(f => {
    total += f.size || (f.data ? estimateBase64Bytes(f.data) : 0);
  });
  return total;
}

function renderStorageMeter() {
  const used = computeUsedBytes();
  const pct = Math.min(100, (used / STORAGE_LIMIT_BYTES) * 100);
  document.getElementById("storageText").textContent = `${formatBytes(used)} / 10 GB`;
  const fill = document.getElementById("storageBarFill");
  fill.style.width = pct + "%";
  const warn = document.getElementById("storageWarning");
  const ratio = used / STORAGE_LIMIT_BYTES;
  if (ratio >= DANGER_THRESHOLD) {
    warn.textContent = "⚠️ Storage almost full! தேவை இல்லாத files-ஐ உடனே delete பண்ணுங்க.";
    warn.classList.add("show", "danger");
    fill.style.background = "#e74c3c";
  } else if (ratio >= WARN_THRESHOLD) {
    warn.textContent = "⚠️ Free limit கிட்ட வருது — தேவை இல்லாத files-ஐ delete பண்ணுங்க.";
    warn.classList.add("show");
    warn.classList.remove("danger");
    fill.style.background = "";
  } else {
    warn.classList.remove("show", "danger");
    fill.style.background = "";
  }
  return ratio;
}

// ============ HOME / FOLDERS RENDER ============
function renderHome() {
  renderStorageMeter();
  renderFolderGrid();
}

function fileCountInFolder(folderId) {
  return Object.values(appState.files).filter(f => f.folderId === folderId).length;
}

function renderFolderGrid() {
  const grid = document.getElementById("folderGrid");
  grid.innerHTML = "";
  Object.entries(appState.folders).forEach(([id, f]) => {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.innerHTML = `
      <div class="fcolor" style="background:${f.color}"></div>
      ${f.pin ? '<div class="flock-badge">🔒</div>' : ''}
      <div class="ficon">${f.icon}</div>
      <div class="fname">${escapeHtml(f.name)}</div>
      <div class="fcount">${fileCountInFolder(id)} files</div>
    `;
    card.addEventListener("click", () => openFolder(id));
    grid.appendChild(card);
  });
  const addCard = document.createElement("div");
  addCard.className = "add-folder-card";
  addCard.innerHTML = `<span style="font-size:22px;">+</span><span>புது Folder</span>`;
  addCard.addEventListener("click", openNewFolderSheet);
  grid.appendChild(addCard);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ============ FOLDER DETAIL ============
let pendingOpenFolderId = null;

function openFolder(folderId) {
  const f = appState.folders[folderId];
  if (f.pin) {
    // Locked folder - require PIN entry first
    pendingOpenFolderId = folderId;
    enteredFolderPin = "";
    document.getElementById("folderPinTitle").textContent = f.name;
    document.getElementById("folderPinError").textContent = "";
    buildFolderPinKeypad();
    renderFolderPinDots();
    showScreen("folderPinScreen");
    return;
  }
  currentFolderId = folderId;
  document.getElementById("folderTitle").textContent = f.name;
  renderFolderFiles();
  showScreen("folderScreen");
}

let enteredFolderPin = "";
function buildFolderPinKeypad() {
  const keypad = document.getElementById("folderPinKeypad");
  keypad.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  keys.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "key" + (k === "" ? " empty" : "");
    btn.textContent = k;
    if (k !== "") attachKeyTap(btn, () => handleFolderPinKeyPress(k));
    keypad.appendChild(btn);
  });
}
function handleFolderPinKeyPress(k) {
  if (k === "⌫") {
    enteredFolderPin = enteredFolderPin.slice(0, -1);
  } else if (enteredFolderPin.length < 4) {
    enteredFolderPin += k;
  }
  renderFolderPinDots();
  if (enteredFolderPin.length === 4) {
    setTimeout(checkFolderPin, 150);
  }
}
function renderFolderPinDots(errorState = false) {
  const dots = document.querySelectorAll("#folderPinDots .pin-dot");
  dots.forEach((d, i) => {
    d.classList.remove("filled", "error");
    if (errorState) d.classList.add("error");
    else if (i < enteredFolderPin.length) d.classList.add("filled");
  });
}
async function checkFolderPin() {
  const f = appState.folders[pendingOpenFolderId];
  const ok = await verifyPin(enteredFolderPin, f.pin);
  if (ok) {
    if (!isHashFormat(f.pin)) {
      f.pin = await sha256Hex(enteredFolderPin); // auto-migrate legacy plaintext to hash
      saveFolders();
    }
    enteredFolderPin = "";
    currentFolderId = pendingOpenFolderId;
    pendingOpenFolderId = null;
    document.getElementById("folderTitle").textContent = f.name;
    renderFolderFiles();
    showScreen("folderScreen");
  } else {
    renderFolderPinDots(true);
    document.getElementById("folderPinError").textContent = "தவறான PIN";
    setTimeout(() => {
      enteredFolderPin = "";
      renderFolderPinDots();
    }, 500);
  }
}
document.getElementById("folderPinBackBtn").addEventListener("click", () => {
  pendingOpenFolderId = null;
  enteredFolderPin = "";
  showScreen("homeScreen");
});

document.getElementById("folderPinForgotLink").addEventListener("click", () => {
  document.getElementById("masterPinForFolderInput").value = "";
  document.getElementById("masterPinForFolderError").textContent = "";
  openSheet("folderPinForgotSheetOverlay");
});
document.getElementById("cancelMasterPinForFolderBtn").addEventListener("click", () => {
  closeSheet("folderPinForgotSheetOverlay");
});
document.getElementById("confirmMasterPinForFolderBtn").addEventListener("click", async () => {
  const entered = document.getElementById("masterPinForFolderInput").value.trim();
  const ok = await verifyPin(entered, appState.pin);
  if (!ok) {
    document.getElementById("masterPinForFolderError").textContent = "தவறான Master PIN";
    return;
  }
  const f = appState.folders[pendingOpenFolderId];
  closeSheet("folderPinForgotSheetOverlay");
  enteredFolderPin = "";
  currentFolderId = pendingOpenFolderId;
  pendingOpenFolderId = null;
  document.getElementById("folderTitle").textContent = f.name;
  renderFolderFiles();
  showScreen("folderScreen");
  toast("Master PIN-ஓட folder open ஆச்சு");
});

function renderFolderFiles() {
  const grid = document.getElementById("folderFileGrid");
  grid.innerHTML = "";
  const files = Object.entries(appState.files).filter(([id, f]) => f.folderId === currentFolderId);
  if (files.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state"><div class="eicon">📂</div><p>இந்த folder-ல files இல்ல.<br>+ button click பண்ணி upload பண்ணுங்க.</p></div>`;
    return;
  }
  files.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  files.forEach(([id, f]) => grid.appendChild(buildFileTile(id, f)));
}

function buildFileTile(id, f) {
  const tile = document.createElement("div");
  if (f.type === "image") {
    tile.className = "file-tile";
    tile.innerHTML = `<div class="thumb-loading">⏳</div>`;
    const keyToFetch = f.r2thumbkey || f.r2key;
    if (keyToFetch) {
      r2Fetch(keyToFetch).then(url => {
        tile.innerHTML = `<img src="${url}" alt="${escapeHtml(f.name)}">`;
      }).catch(() => {
        tile.innerHTML = `<div class="dicon">⚠️</div>`;
      });
    }
  } else if (f.type === "video") {
    tile.className = "file-tile doc-tile";
    tile.innerHTML = `<div class="dicon">🎥</div><div class="dname">${escapeHtml(f.name)}</div>`;
  } else {
    tile.className = "file-tile doc-tile";
    tile.innerHTML = `<div class="dicon">📄</div><div class="dname">${escapeHtml(f.name)}</div>`;
  }
  tile.addEventListener("click", () => openViewer(id));
  return tile;
}

// ============ SEARCH ============
document.getElementById("searchInput").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  const wrap = document.getElementById("searchResultsWrap");
  const folderWrap = document.getElementById("folderViewWrap");
  if (!q) {
    wrap.classList.add("hidden");
    folderWrap.classList.remove("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  folderWrap.classList.add("hidden");
  const grid = document.getElementById("searchResultsGrid");
  grid.innerHTML = "";
  const results = Object.entries(appState.files).filter(([id, f]) => {
    const folderName = (appState.folders[f.folderId]?.name || "").toLowerCase();
    return f.name.toLowerCase().includes(q) || folderName.includes(q);
  });
  if (results.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state"><div class="eicon">🔍</div><p>எதுவும் கிடைக்கல</p></div>`;
    return;
  }
  results.forEach(([id, f]) => grid.appendChild(buildFileTile(id, f)));
});

// ============ VIEWER ============
function openViewer(fileId) {
  currentViewerFileId = fileId;
  const f = appState.files[fileId];
  document.getElementById("viewerFname").textContent = f.name;
  const body = document.getElementById("viewerBody");
  if (f.type === "image") {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">⏳</div></div>`;
    if (f.r2key) {
      r2Fetch(f.r2key).then(url => {
        body.innerHTML = `<img src="${url}" alt="${escapeHtml(f.name)}">`;
      }).catch(() => {
        body.innerHTML = `<div class="doc-preview"><div class="bigicon">⚠️</div><p>Load ஆகல, மறுபடி try பண்ணுங்க</p></div>`;
      });
    }
  } else if (f.type === "video") {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">⏳</div></div>`;
    if (f.r2key) {
      r2Fetch(f.r2key).then(url => {
        body.innerHTML = `<video src="${url}" controls playsinline style="max-width:100%;max-height:100%;"></video>`;
      }).catch(() => {
        body.innerHTML = `<div class="doc-preview"><div class="bigicon">⚠️</div><p>Load ஆகல, மறுபடி try பண்ணுங்க</p></div>`;
      });
    }
  } else {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">📄</div><p>${escapeHtml(f.name)}</p><p style="font-size:12px;color:#888;margin-top:8px;">${formatBytes(f.size||0)}</p></div>`;
  }
  showScreen("viewerScreen");
}

document.getElementById("viewerBackBtn").addEventListener("click", () => {
  showScreen(currentFolderId ? "folderScreen" : "homeScreen");
});

// ---- Viewer actions ----
document.getElementById("vaDelete").addEventListener("click", () => {
  pendingDeleteAction = () => {
    const f = appState.files[currentViewerFileId];
    const r2key = f && f.r2key;
    const r2thumbkey = f && f.r2thumbkey;
    delete appState.files[currentViewerFileId];
    saveFiles();
    renderFolderFiles();
    renderStorageMeter();
    renderFolderGrid();
    showScreen("folderScreen");
    toast("File delete ஆச்சு");
    if (r2key) r2Delete(r2key).catch(err => console.error("R2 delete failed:", err));
    if (r2thumbkey) r2Delete(r2thumbkey).catch(err => console.error("R2 thumb delete failed:", err));
  };
  document.getElementById("deleteConfirmText").textContent = "இந்த file நிரந்தரமா delete ஆகிடும்.";
  openSheet("deleteConfirmOverlay");
});

document.getElementById("vaRename").addEventListener("click", () => {
  document.getElementById("renameInput").value = appState.files[currentViewerFileId].name;
  openSheet("renameSheetOverlay");
});
document.getElementById("confirmRenameBtn").addEventListener("click", () => {
  const newName = document.getElementById("renameInput").value.trim();
  if (!newName) { toast("பெயர் கொடுங்க"); return; }
  appState.files[currentViewerFileId].name = newName;
  saveFiles();
  document.getElementById("viewerFname").textContent = newName;
  closeSheet("renameSheetOverlay");
  renderFolderFiles();
  toast("பெயர் மாறிடுச்சு");
});

document.getElementById("vaMove").addEventListener("click", () => {
  const list = document.getElementById("moveFolderList");
  list.innerHTML = "";
  Object.entries(appState.folders).forEach(([id, f]) => {
    const row = document.createElement("div");
    row.className = "sheet-row";
    row.innerHTML = `<span class="sricon">${f.icon}</span><span>${escapeHtml(f.name)}</span>`;
    row.addEventListener("click", () => {
      appState.files[currentViewerFileId].folderId = id;
      saveFiles();
      closeSheet("moveSheetOverlay");
      renderFolderFiles();
      renderFolderGrid();
      toast(`"${f.name}"-க்கு move ஆச்சு`);
      showScreen("folderScreen");
    });
    list.appendChild(row);
  });
  openSheet("moveSheetOverlay");
});

let pendingShareMode = "file"; // "file" or "folder"
let pendingShareFolderId = null;

document.getElementById("vaShare").addEventListener("click", () => {
  pendingShareMode = "file";
  openSheet("shareExpirySheetOverlay");
});

document.querySelectorAll("#shareExpirySheetOverlay .sheet-row").forEach(row => {
  row.addEventListener("click", () => {
    const hours = parseInt(row.dataset.hours, 10);
    closeSheet("shareExpirySheetOverlay");
    if (pendingShareMode === "folder") {
      createFolderShareWithExpiry(hours);
    } else {
      createShareWithExpiry(hours);
    }
  });
});

function createShareWithExpiry(hours) {
  const code = genCode();
  const linkToken = genLinkToken();
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const fileIdAtShareTime = currentViewerFileId;
  db.ref(ROOT + "/shares/" + linkToken).set({ type: "file", fileId: fileIdAtShareTime, code, expiresAt })
    .then(() => {
      appState.shares[linkToken] = { type: "file", fileId: fileIdAtShareTime, code, expiresAt };
      document.getElementById("shareCodeDisplay").textContent = code;
      document.getElementById("shareExpiryText").textContent = formatExpiryLabel(hours) + "க்கு valid";
      document.getElementById("copyShareCodeBtn").dataset.code = code;
      document.getElementById("copyShareLinkBtn").dataset.token = linkToken;
      openSheet("shareSheetOverlay");
    })
    .catch(err => {
      console.error("Share save failed:", err);
      toast("Share code create ஆகல, மறுபடி try பண்ணுங்க");
    });
}

function createFolderShareWithExpiry(hours) {
  const code = genCode();
  const linkToken = genLinkToken();
  const expiresAt = Date.now() + hours * 60 * 60 * 1000;
  const folderId = pendingShareFolderId;
  db.ref(ROOT + "/shares/" + linkToken).set({ type: "folder", folderId, code, expiresAt })
    .then(() => {
      appState.shares[linkToken] = { type: "folder", folderId, code, expiresAt };
      document.getElementById("shareCodeDisplay").textContent = code;
      document.getElementById("shareExpiryText").textContent = formatExpiryLabel(hours) + "க்கு valid";
      document.getElementById("copyShareCodeBtn").dataset.code = code;
      document.getElementById("copyShareLinkBtn").dataset.token = linkToken;
      openSheet("shareSheetOverlay");
    })
    .catch(err => {
      console.error("Folder share save failed:", err);
      toast("Share code create ஆகல, மறுபடி try பண்ணுங்க");
    });
}

function formatExpiryLabel(hours) {
  if (hours === 1) return "1 மணி நேரம்";
  if (hours === 6) return "6 மணி நேரம்";
  if (hours === 24) return "24 மணி நேரம்";
  if (hours === 168) return "7 நாட்கள்";
  return hours + " மணி நேரம்";
}

function genLinkToken() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l ambiguity
  let t = "";
  for (let i = 0; i < 8; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}
document.getElementById("copyShareCodeBtn").addEventListener("click", e => {
  const code = e.target.dataset.code;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => toast("Code copy ஆச்சு")).catch(() => toast("Code: " + code));
  } else {
    toast("Code: " + code);
  }
});
document.getElementById("copyShareLinkBtn").addEventListener("click", e => {
  const token = e.target.dataset.token;
  const link = `${location.origin}${location.pathname}?s=${token}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => toast("Link copy ஆச்சு (code தனியா சொல்லுங்க)")).catch(() => toast("Link: " + link));
  } else {
    toast("Link: " + link);
  }
});
document.getElementById("closeShareSheetBtn").addEventListener("click", () => closeSheet("shareSheetOverlay"));

// ============ NEW FOLDER ============
let pickedIcon = FOLDER_ICONS[0];
let pickedColor = FOLDER_COLORS[0];

function openNewFolderSheet() {
  document.getElementById("newFolderName").value = "";
  const iconRow = document.getElementById("iconPickRow");
  iconRow.innerHTML = "";
  FOLDER_ICONS.forEach(ic => {
    const el = document.createElement("div");
    el.className = "icon-pick" + (ic === pickedIcon ? " selected" : "");
    el.textContent = ic;
    el.addEventListener("click", () => {
      pickedIcon = ic;
      iconRow.querySelectorAll(".icon-pick").forEach(x => x.classList.remove("selected"));
      el.classList.add("selected");
    });
    iconRow.appendChild(el);
  });
  const colorRow = document.getElementById("colorPickRow");
  colorRow.innerHTML = "";
  FOLDER_COLORS.forEach(c => {
    const el = document.createElement("div");
    el.className = "color-dot" + (c === pickedColor ? " selected" : "");
    el.style.background = c;
    el.addEventListener("click", () => {
      pickedColor = c;
      colorRow.querySelectorAll(".color-dot").forEach(x => x.classList.remove("selected"));
      el.classList.add("selected");
    });
    colorRow.appendChild(el);
  });
  openSheet("newFolderSheetOverlay");
}

document.getElementById("createFolderBtn").addEventListener("click", () => {
  const name = document.getElementById("newFolderName").value.trim();
  if (!name) { toast("Folder பெயர் கொடுங்க"); return; }
  const id = "f_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  appState.folders[id] = { name, icon: pickedIcon, color: pickedColor, createdAt: Date.now() };
  saveFolders();
  closeSheet("newFolderSheetOverlay");
  renderFolderGrid();
  toast("Folder create ஆச்சு");
});

// ============ FOLDER MENU (rename/delete/lock/share folder) ============
document.getElementById("folderMenuBtn").addEventListener("click", () => {
  const f = appState.folders[currentFolderId];
  document.getElementById("folderMenuTitle").textContent = f.name;
  document.getElementById("lockFolderLabel").textContent = f.pin ? "Folder PIN-ஐ நீக்கு" : "Folder-க்கு PIN வை";
  openSheet("folderMenuSheetOverlay");
});
document.getElementById("renameFolderRow").addEventListener("click", () => {
  closeSheet("folderMenuSheetOverlay");
  document.getElementById("renameInput").value = appState.folders[currentFolderId].name;
  openSheet("renameSheetOverlay");
  // temporarily repurpose rename sheet for folder
  document.getElementById("confirmRenameBtn").dataset.mode = "folder";
});
document.getElementById("deleteFolderRow").addEventListener("click", () => {
  closeSheet("folderMenuSheetOverlay");
  const count = fileCountInFolder(currentFolderId);
  pendingDeleteAction = () => {
    const r2keysToDelete = [];
    Object.keys(appState.files).forEach(fid => {
      if (appState.files[fid].folderId === currentFolderId) {
        if (appState.files[fid].r2key) r2keysToDelete.push(appState.files[fid].r2key);
        if (appState.files[fid].r2thumbkey) r2keysToDelete.push(appState.files[fid].r2thumbkey);
        delete appState.files[fid];
      }
    });
    delete appState.folders[currentFolderId];
    saveFolders();
    saveFiles();
    renderFolderGrid();
    renderStorageMeter();
    showScreen("homeScreen");
    toast("Folder delete ஆச்சு");
    r2keysToDelete.forEach(key => r2Delete(key).catch(err => console.error("R2 delete failed:", err)));
  };
  document.getElementById("deleteConfirmText").textContent = `இந்த folder-ஓட ${count} files-உம் delete ஆகிடும்.`;
  openSheet("deleteConfirmOverlay");
});

document.getElementById("lockFolderRow").addEventListener("click", () => {
  closeSheet("folderMenuSheetOverlay");
  const f = appState.folders[currentFolderId];
  if (f.pin) {
    // Remove existing PIN directly
    delete appState.folders[currentFolderId].pin;
    saveFolders();
    renderFolderGrid();
    toast("Folder PIN நீக்கப்பட்டது");
  } else {
    document.getElementById("setFolderPinInput").value = "";
    openSheet("setFolderPinSheetOverlay");
  }
});
document.getElementById("saveFolderPinBtn").addEventListener("click", async () => {
  const pin = document.getElementById("setFolderPinInput").value.trim();
  if (!/^\d{4}$/.test(pin)) { toast("4-digit PIN கொடுங்க"); return; }
  appState.folders[currentFolderId].pin = await sha256Hex(pin);
  saveFolders();
  closeSheet("setFolderPinSheetOverlay");
  renderFolderGrid();
  toast("Folder PIN வைக்கப்பட்டது");
});

document.getElementById("shareFolderRow").addEventListener("click", () => {
  closeSheet("folderMenuSheetOverlay");
  pendingShareMode = "folder";
  pendingShareFolderId = currentFolderId;
  openSheet("shareExpirySheetOverlay");
});



// Patch rename confirm to handle folder-mode too
const originalRenameHandler = document.getElementById("confirmRenameBtn");
originalRenameHandler.addEventListener("click", () => {
  if (originalRenameHandler.dataset.mode === "folder") {
    const newName = document.getElementById("renameInput").value.trim();
    if (!newName) { toast("பெயர் கொடுங்க"); return; }
    appState.folders[currentFolderId].name = newName;
    saveFolders();
    document.getElementById("folderTitle").textContent = newName;
    renderFolderGrid();
    closeSheet("renameSheetOverlay");
    toast("Folder பெயர் மாறிடுச்சு");
    originalRenameHandler.dataset.mode = "";
  }
});

// ============ DELETE CONFIRM (generic) ============
document.getElementById("confirmDeleteBtn").addEventListener("click", () => {
  if (pendingDeleteAction) pendingDeleteAction();
  pendingDeleteAction = null;
  closeSheet("deleteConfirmOverlay");
});
document.getElementById("cancelDeleteBtn").addEventListener("click", () => {
  pendingDeleteAction = null;
  closeSheet("deleteConfirmOverlay");
});

// ============ UPLOAD ============
function openUploadSheet(folderId) {
  pendingUploadFolderId = folderId || currentFolderId || Object.keys(appState.folders)[0];
  document.getElementById("chooseFolderLabel").textContent = "Folder: " + (appState.folders[pendingUploadFolderId]?.name || "Photos");
  document.getElementById("uploadChooseStage").classList.remove("hidden");
  document.getElementById("uploadProgressStage").classList.add("hidden");
  openSheet("uploadSheetOverlay");
}

document.getElementById("fabUpload").addEventListener("click", () => openUploadSheet(Object.keys(appState.folders)[0]));
document.getElementById("fabUploadInFolder").addEventListener("click", () => openUploadSheet(currentFolderId));

document.getElementById("chooseFolderRow").addEventListener("click", () => {
  closeSheet("uploadSheetOverlay");
  const list = document.getElementById("moveFolderList");
  list.innerHTML = "";
  Object.entries(appState.folders).forEach(([id, f]) => {
    const row = document.createElement("div");
    row.className = "sheet-row";
    row.innerHTML = `<span class="sricon">${f.icon}</span><span>${escapeHtml(f.name)}</span>`;
    row.addEventListener("click", () => {
      pendingUploadFolderId = id;
      closeSheet("moveSheetOverlay");
      openUploadSheet(id);
    });
    list.appendChild(row);
  });
  openSheet("moveSheetOverlay");
});

document.getElementById("pickPhotoRow").addEventListener("click", () => document.getElementById("filePhotoInput").click());
document.getElementById("pickVideoRow").addEventListener("click", () => document.getElementById("fileVideoInput").click());
document.getElementById("pickDocRow").addEventListener("click", () => document.getElementById("fileDocInput").click());

document.getElementById("filePhotoInput").addEventListener("change", e => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length === 0) return;
  if (files.length === 1) {
    handlePhotoUpload(files[0]);
  } else {
    handleMultiplePhotoUpload(files);
  }
});
document.getElementById("fileVideoInput").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) handleVideoUpload(file);
});
document.getElementById("fileDocInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) handleDocUpload(file);
  e.target.value = "";
});

function showUploadProgress(text, countText) {
  document.getElementById("uploadChooseStage").classList.add("hidden");
  document.getElementById("uploadProgressStage").classList.remove("hidden");
  document.getElementById("uploadProgressText").textContent = text;
  document.getElementById("uploadProgressCount").textContent = countText || "";
}

function handlePhotoUpload(file) {
  showUploadProgress("Photo compress ஆகுது...");
  compressImageBoth(file, (mainBlob, mainSize, thumbBlob) => {
    finalizeUpload(file.name, "image", mainBlob, mainSize, "image/jpeg", thumbBlob);
  });
}

// Compresses once for the main viewer image (1280px) and once for a small thumbnail (320px),
// reusing the same loaded <img> so we only decode the source file once.
function compressImageBoth(file, cb) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const mainCanvas = resizeToCanvas(img, 1280);
      const thumbCanvas = resizeToCanvas(img, 320);
      mainCanvas.toBlob(mainBlob => {
        thumbCanvas.toBlob(thumbBlob => {
          cb(mainBlob, mainBlob.size, thumbBlob);
        }, "image/jpeg", 0.6);
      }, "image/jpeg", 0.72);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function resizeToCanvas(img, maxDim) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
    else { width = Math.round(width * maxDim / height); height = maxDim; }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return canvas;
}

async function handleMultiplePhotoUpload(files) {
  showUploadProgress("Photos upload ஆகுது...", `0 / ${files.length}`);
  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    document.getElementById("uploadProgressCount").textContent = `${i + 1} / ${files.length}`;
    try {
      const { mainBlob, sizeBytes, thumbBlob } = await new Promise((resolve, reject) => {
        compressImageBoth(file, (mb, s, tb) => resolve({ mainBlob: mb, sizeBytes: s, thumbBlob: tb }));
      });
      const used = computeUsedBytes();
      if (used + sizeBytes > STORAGE_LIMIT_BYTES) {
        failCount++;
        continue; // storage full, skip remaining accounting but keep trying smaller ones is unnecessary; just count as failed
      }
      const r2key = genR2Key();
      const r2thumbkey = genR2Key();
      await r2Upload(r2key, mainBlob, "image/jpeg");
      await r2Upload(r2thumbkey, thumbBlob, "image/jpeg");
      const id = "file_" + Date.now() + "_" + Math.floor(Math.random() * 10000) + "_" + i;
      appState.files[id] = {
        name: file.name, type: "image", r2key, r2thumbkey, size: sizeBytes,
        folderId: pendingUploadFolderId, createdAt: Date.now()
      };
      successCount++;
    } catch (err) {
      console.error("Multi-upload item failed:", err);
      failCount++;
    }
  }
  saveFiles();
  closeSheet("uploadSheetOverlay");
  renderStorageMeter();
  renderFolderGrid();
  if (currentFolderId) renderFolderFiles();
  if (failCount === 0) {
    toast(`${successCount} photos upload ஆச்சு ✓`);
  } else {
    toast(`${successCount} upload ஆச்சு, ${failCount} fail ஆச்சு`);
  }
}

function handleVideoUpload(file) {
  const maxSize = 50 * 1024 * 1024; // 50MB cap for videos
  if (file.size > maxSize) {
    toast("Video 50MB-க்கு மேல இருக்கு, கம்மி duration video try பண்ணுங்க");
    closeSheet("uploadSheetOverlay");
    return;
  }
  showUploadProgress("Video upload ஆகுது...");
  finalizeUpload(file.name, "video", file, file.size, file.type || "video/mp4");
}

function compressImage(file, maxDim, quality, cb) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        cb(blob, blob.size);
      }, "image/jpeg", quality);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handleDocUpload(file) {
  const maxSize = 6 * 1024 * 1024; // 6MB hard cap for docs
  const warnSize = 2 * 1024 * 1024; // 2MB - suggest compressing above this
  if (file.size > maxSize) {
    toast("File 6MB-க்கு மேல இருக்கு, compress பண்ணி try பண்ணுங்க");
    closeSheet("uploadSheetOverlay");
    return;
  }
  if (file.size > warnSize) {
    pendingLargeDocFile = file;
    document.getElementById("largeDocSizeText").textContent =
      `இந்த file ${formatBytes(file.size)} இருக்கு. பெரிய files storage-ஐ வேகமா consume பண்ணும். Compress பண்ணி upload பண்ணுவது நல்லது (free online tools: smallpdf.com, ilovepdf.com).`;
    closeSheet("uploadSheetOverlay");
    openSheet("largeDocWarnOverlay");
    return;
  }
  proceedDocUpload(file);
}

let pendingLargeDocFile = null;
function proceedDocUpload(file) {
  showUploadProgress("Document upload ஆகுது...");
  const isImage = file.type.startsWith("image/");
  finalizeUpload(file.name, isImage ? "image" : "doc", file, file.size, file.type || "application/octet-stream");
}
document.getElementById("uploadAnywayBtn").addEventListener("click", () => {
  closeSheet("largeDocWarnOverlay");
  if (pendingLargeDocFile) {
    openSheet("uploadSheetOverlay"); // briefly reopen to show progress stage cleanly
    proceedDocUpload(pendingLargeDocFile);
    pendingLargeDocFile = null;
  }
});
document.getElementById("cancelLargeDocBtn").addEventListener("click", () => {
  closeSheet("largeDocWarnOverlay");
  pendingLargeDocFile = null;
});

function finalizeUpload(name, type, blob, sizeBytes, contentType, thumbBlob) {
  const used = computeUsedBytes();
  if (used + sizeBytes > STORAGE_LIMIT_BYTES) {
    toast("⚠️ Storage full! Files delete பண்ணி try பண்ணுங்க");
    closeSheet("uploadSheetOverlay");
    return;
  }
  showUploadProgress("R2-க்கு upload ஆகுது...");
  const r2key = genR2Key();
  const r2thumbkey = thumbBlob ? genR2Key() : null;
  const uploads = [r2Upload(r2key, blob, contentType)];
  if (thumbBlob) uploads.push(r2Upload(r2thumbkey, thumbBlob, "image/jpeg"));
  Promise.all(uploads)
    .then(() => {
      const id = "file_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
      appState.files[id] = {
        name, type, r2key, size: sizeBytes,
        folderId: pendingUploadFolderId, createdAt: Date.now()
      };
      if (r2thumbkey) appState.files[id].r2thumbkey = r2thumbkey;
      saveFiles();
      closeSheet("uploadSheetOverlay");
      renderStorageMeter();
      renderFolderGrid();
      if (currentFolderId) renderFolderFiles();
      toast("Upload ஆச்சு ✓");
    })
    .catch(err => {
      console.error("R2 upload failed:", err);
      toast("Upload ஆகல, network check பண்ணி மறுபடி try பண்ணுங்க");
      closeSheet("uploadSheetOverlay");
    });
}

// ============ SETTINGS ============
document.getElementById("settingsBtn").addEventListener("click", () => openSheet("settingsSheetOverlay"));
document.getElementById("closeSettingsRow").addEventListener("click", () => closeSheet("settingsSheetOverlay"));
document.getElementById("changePinRow").addEventListener("click", () => {
  closeSheet("settingsSheetOverlay");
  document.getElementById("newPinInput").value = "";
  openSheet("changePinSheetOverlay");
});
document.getElementById("savePinBtn").addEventListener("click", async () => {
  const newPin = document.getElementById("newPinInput").value.trim();
  if (!/^\d{4}$/.test(newPin)) { toast("4-digit PIN கொடுங்க"); return; }
  appState.pin = await sha256Hex(newPin);
  savePin();
  closeSheet("changePinSheetOverlay");
  toast("PIN மாறிடுச்சு");
});
document.getElementById("exportBackupRow").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "safebox-backup-" + new Date().toISOString().slice(0,10) + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("Backup download ஆச்சு");
});

let pendingRestoreData = null;
document.getElementById("restoreBackupRow").addEventListener("click", () => {
  closeSheet("settingsSheetOverlay");
  document.getElementById("restoreFileInput").click();
});
document.getElementById("restoreFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data || typeof data !== "object") throw new Error("invalid");
      pendingRestoreData = data;
      const folderCount = data.folders ? Object.keys(data.folders).length : 0;
      const fileCount = data.files ? Object.keys(data.files).length : 0;
      document.getElementById("restoreConfirmText").textContent =
        `இந்த backup-ல ${folderCount} folders, ${fileCount} files இருக்கு. இப்போ இருக்கும் டேட்டா எல்லாம் இதனால replace ஆகிடும்.`;
      openSheet("restoreConfirmOverlay");
    } catch (err) {
      toast("இந்த file சரியான SafeBox backup இல்ல");
    }
  };
  reader.readAsText(file);
});
document.getElementById("confirmRestoreBtn").addEventListener("click", () => {
  if (!pendingRestoreData) { closeSheet("restoreConfirmOverlay"); return; }
  const data = pendingRestoreData;
  const newState = {
    pin: data.pin || appState.pin,
    folders: data.folders || {},
    files: data.files || {},
    shares: data.shares || {}
  };
  db.ref(ROOT).set(newState)
    .then(() => {
      appState = newState;
      closeSheet("restoreConfirmOverlay");
      pendingRestoreData = null;
      showScreen("homeScreen");
      renderHome();
      toast("Restore ஆச்சு ✓");
    })
    .catch(err => {
      console.error(err);
      toast("Restore ஆகல, மறுபடி try பண்ணுங்க");
    });
});
document.getElementById("cancelRestoreBtn").addEventListener("click", () => {
  pendingRestoreData = null;
  closeSheet("restoreConfirmOverlay");
});

document.getElementById("lockBtn").addEventListener("click", () => {
  showScreen("loginScreen");
  enteredPin = "";
  renderPinDots();
});

document.getElementById("folderBackBtn").addEventListener("click", () => {
  currentFolderId = null;
  showScreen("homeScreen");
  renderHome();
});

// ============ SHARE LINK HANDLING (incoming) ============
let pendingShareFile = null; // file object waiting to be revealed after correct code entry
let pendingShareCode = "";  // the correct code for this share
let enteredShareCode = "";

let pendingShareData = null; // either a file object or {type:'folder', folder, files}

function checkIncomingShareLink() {
  const params = new URLSearchParams(location.search);
  const token = params.get("s") || params.get("share"); // support old links too during transition
  if (!token) return false;

  const share = appState.shares[token];
  if (!share || share.expiresAt < Date.now()) {
    showScreen("shareAccessScreen");
    document.getElementById("shareAccessSub").textContent = "இந்த link expire ஆகிடுச்சு அல்லது invalid";
    document.querySelectorAll("#shareAccessKeypad .key").forEach(b => b.style.visibility = "hidden");
    return true;
  }

  if (share.type === "folder") {
    const folder = appState.folders[share.folderId];
    if (!folder) {
      showScreen("shareAccessScreen");
      document.getElementById("shareAccessSub").textContent = "இந்த folder கிடைக்கல";
      document.querySelectorAll("#shareAccessKeypad .key").forEach(b => b.style.visibility = "hidden");
      return true;
    }
    const filesInFolder = Object.entries(appState.files).filter(([id, f]) => f.folderId === share.folderId);
    pendingShareData = { type: "folder", folder, files: filesInFolder };
  } else {
    const f = appState.files[share.fileId];
    if (!f) {
      showScreen("shareAccessScreen");
      document.getElementById("shareAccessSub").textContent = "இந்த file கிடைக்கல";
      document.querySelectorAll("#shareAccessKeypad .key").forEach(b => b.style.visibility = "hidden");
      return true;
    }
    pendingShareData = { type: "file", file: f };
  }

  pendingShareCode = share.code || token;
  enteredShareCode = "";
  buildShareAccessKeypad();
  renderShareAccessDots();
  showScreen("shareAccessScreen");
  return true;
}

function buildShareAccessKeypad() {
  const keypad = document.getElementById("shareAccessKeypad");
  keypad.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  keys.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "key" + (k === "" ? " empty" : "");
    btn.textContent = k;
    if (k !== "") {
      attachKeyTap(btn, () => handleShareAccessKeyPress(k));
    }
    keypad.appendChild(btn);
  });
}

function handleShareAccessKeyPress(k) {
  if (k === "⌫") {
    enteredShareCode = enteredShareCode.slice(0, -1);
  } else if (enteredShareCode.length < 4) {
    enteredShareCode += k;
  }
  renderShareAccessDots();
  if (enteredShareCode.length === 4) {
    setTimeout(checkShareAccessCode, 150);
  }
}

function renderShareAccessDots(errorState = false) {
  const dots = document.querySelectorAll("#shareAccessDots .pin-dot");
  dots.forEach((d, i) => {
    d.classList.remove("filled", "error");
    if (errorState) d.classList.add("error");
    else if (i < enteredShareCode.length) d.classList.add("filled");
  });
}

function checkShareAccessCode() {
  if (enteredShareCode === pendingShareCode) {
    document.getElementById("shareAccessError").textContent = "";
    if (pendingShareData.type === "folder") {
      revealSharedFolder(pendingShareData.folder, pendingShareData.files);
    } else {
      revealSharedFile(pendingShareData.file);
    }
  } else {
    renderShareAccessDots(true);
    document.getElementById("shareAccessError").textContent = "தவறான code, மீண்டும் முயற்சி செய்யுங்க";
    setTimeout(() => {
      enteredShareCode = "";
      renderShareAccessDots();
    }, 500);
  }
}

function digitFromKeyEvent(e){
  if (e.code && /^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.code && /^Numpad[0-9]$/.test(e.code)) return e.code.slice(6);
  if (e.key >= '0' && e.key <= '9') return e.key;
  return null;
}
document.addEventListener('keydown', (e) => {
  const d = digitFromKeyEvent(e);
  const isBackspace = e.key === 'Backspace' || e.code === 'Backspace';
  if (d === null && !isBackspace) return;
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const k = d !== null ? d : '⌫';
  if (active.id === 'loginScreen') {
    handleKeyPress(k);
  } else if (active.id === 'folderPinScreen') {
    handleFolderPinKeyPress(k);
  } else if (active.id === 'shareAccessScreen') {
    handleShareAccessKeyPress(k);
  }
});

function revealSharedFile(f) {
  document.getElementById("sharedViewerFname").textContent = f.name;
  const body = document.getElementById("sharedViewerBody");
  if (f.type === "image") {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">⏳</div></div>`;
    if (f.r2key) {
      r2Fetch(f.r2key).then(url => {
        body.innerHTML = `<img src="${url}" alt="${escapeHtml(f.name)}">`;
      }).catch(() => {
        body.innerHTML = `<div class="doc-preview"><div class="bigicon">⚠️</div><p>Load ஆகல</p></div>`;
      });
    }
  } else if (f.type === "video") {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">⏳</div></div>`;
    if (f.r2key) {
      r2Fetch(f.r2key).then(url => {
        body.innerHTML = `<video src="${url}" controls playsinline style="max-width:100%;max-height:100%;"></video>`;
      }).catch(() => {
        body.innerHTML = `<div class="doc-preview"><div class="bigicon">⚠️</div><p>Load ஆகல</p></div>`;
      });
    }
  } else {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">📄</div><p>${escapeHtml(f.name)}</p></div>`;
  }
  const backBtn = document.getElementById("sharedViewerBackBtn");
  if (pendingShareData && pendingShareData.type === "folder") {
    backBtn.style.display = "flex";
  } else {
    backBtn.style.display = "none";
  }
  showScreen("viewerScreenShared");
}
document.getElementById("sharedViewerBackBtn").addEventListener("click", () => {
  if (pendingShareData && pendingShareData.type === "folder") {
    showScreen("sharedFolderScreen");
  }
});

function revealSharedFolder(folder, filesEntries) {
  document.getElementById("sharedFolderTitle").textContent = folder.name;
  const grid = document.getElementById("sharedFolderGrid");
  grid.innerHTML = "";
  if (filesEntries.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;" class="empty-state"><div class="eicon">📂</div><p>இந்த folder-ல files இல்ல.</p></div>`;
  } else {
    filesEntries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    filesEntries.forEach(([id, f]) => {
      const tile = document.createElement("div");
      if (f.type === "image") {
        tile.className = "file-tile";
        tile.innerHTML = `<div class="thumb-loading">⏳</div>`;
        const keyToFetch = f.r2thumbkey || f.r2key;
        if (keyToFetch) {
          r2Fetch(keyToFetch).then(url => {
            tile.innerHTML = `<img src="${url}" alt="${escapeHtml(f.name)}">`;
          }).catch(() => {
            tile.innerHTML = `<div class="dicon">⚠️</div>`;
          });
        }
      } else if (f.type === "video") {
        tile.className = "file-tile doc-tile";
        tile.innerHTML = `<div class="dicon">🎥</div><div class="dname">${escapeHtml(f.name)}</div>`;
      } else {
        tile.className = "file-tile doc-tile";
        tile.innerHTML = `<div class="dicon">📄</div><div class="dname">${escapeHtml(f.name)}</div>`;
      }
      tile.addEventListener("click", () => revealSharedFile(f));
      grid.appendChild(tile);
    });
  }
  showScreen("sharedFolderScreen");
}


// ============ ADMIN AUTH ============
// Firebase rules now allow /safebox only for the owner account, so the app
// must sign in before it can read anything. The session persists on device.
function sbAuthMsg(kind, text) {
  const el = document.getElementById("sbAuthMsg");
  if (!el) return;
  const c = kind === "err"
    ? ["rgba(255,68,68,.1)", "rgba(255,68,68,.3)", "#ff8080"]
    : ["rgba(162,155,254,.1)", "rgba(162,155,254,.3)", "#a29bfe"];
  el.style.display = "block";
  el.style.background = c[0];
  el.style.border = "1px solid " + c[1];
  el.style.color = c[2];
  el.textContent = text;
}

function showAdminLogin() {
  const ov = document.getElementById("sbAuthOv");
  if (ov) ov.style.display = "flex";
}
function hideAdminLogin() {
  const ov = document.getElementById("sbAuthOv");
  if (ov) ov.style.display = "none";
}

function sbAuthErrorText(code) {
  switch (code) {
    case "auth/invalid-email":          return "\u0bae\u0bbf\u0ba9\u0bcd\u0ba9\u0b9e\u0bcd\u0b9a\u0bb2\u0bcd \u0bae\u0bc1\u0b95\u0bb5\u0bb0\u0bbf \u0b9a\u0bb0\u0bbf\u0baf\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":     return "\u0bae\u0bbf\u0ba9\u0bcd\u0ba9\u0b9e\u0bcd\u0b9a\u0bb2\u0bcd \u0b85\u0bb2\u0bcd\u0bb2\u0ba4\u0bc1 \u0b95\u0b9f\u0bb5\u0bc1\u0b9a\u0bcd\u0b9a\u0bca\u0bb2\u0bcd \u0b9a\u0bb0\u0bbf\u0baf\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8.";
    case "auth/too-many-requests":      return "\u0baa\u0bb2 \u0bae\u0bc1\u0bb1\u0bc8 \u0ba4\u0bb5\u0bb1\u0bbe\u0b95 \u0bae\u0bc1\u0baf\u0ba9\u0bcd\u0bb1\u0bc1\u0bb5\u0bbf\u0b9f\u0bcd\u0b9f\u0bc0\u0bb0\u0bcd\u0b95\u0bb3\u0bcd. \u0b9a\u0bbf\u0bb1\u0bbf\u0ba4\u0bc1 \u0ba8\u0bc7\u0bb0\u0bae\u0bcd \u0b95\u0bb4\u0bbf\u0ba4\u0bcd\u0ba4\u0bc1 \u0bae\u0bc1\u0baf\u0bb1\u0bcd\u0b9a\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd.";
    case "auth/network-request-failed": return "\u0b87\u0ba3\u0bc8\u0baa\u0bcd\u0baa\u0bc1 \u0b95\u0bbf\u0b9f\u0bc8\u0b95\u0bcd\u0b95\u0bb5\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8. \u0bae\u0bc0\u0ba3\u0bcd\u0b9f\u0bc1\u0bae\u0bcd \u0bae\u0bc1\u0baf\u0bb1\u0bcd\u0b9a\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd.";
    default:                            return "\u0b87\u0baa\u0bcd\u0baa\u0bcb\u0ba4\u0bc1 \u0b89\u0bb3\u0bcd\u0ba8\u0bc1\u0bb4\u0bc8\u0baf \u0bae\u0bc1\u0b9f\u0bbf\u0baf\u0bb5\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8. \u0b9a\u0bbf\u0bb1\u0bbf\u0ba4\u0bc1 \u0ba8\u0bc7\u0bb0\u0bae\u0bcd \u0b95\u0bb4\u0bbf\u0ba4\u0bcd\u0ba4\u0bc1 \u0bae\u0bc1\u0baf\u0bb1\u0bcd\u0b9a\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd.";
  }
}

let sbBooted = false;
function sbBoot() {
  if (sbBooted) return;
  sbBooted = true;
  loadData(() => { checkIncomingShareLink(); });
}

async function sbDoLogin() {
  const btn = document.getElementById("sbAuthGo");
  const email = (document.getElementById("sbAuthEmail").value || "").trim();
  const pass = document.getElementById("sbAuthPass").value || "";
  if (email.indexOf("@") < 1) { sbAuthMsg("err", sbAuthErrorText("auth/invalid-email")); return; }
  if (pass.length < 6) { sbAuthMsg("err", sbAuthErrorText("auth/wrong-password")); return; }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "...";
  try {
    await firebase.auth().signInWithEmailAndPassword(email, pass);
    document.getElementById("sbAuthPass").value = "";
    hideAdminLogin();
    sbBooted = false;
    sbBoot();
  } catch (e) {
    console.warn("[safebox] sign-in failed", e && e.code);
    sbAuthMsg("err", sbAuthErrorText(e && e.code));
  }
  btn.disabled = false;
  btn.textContent = label;
}

// ============ INIT ============
// Show the real build stamp, read straight from the meta tag, so the label on
// screen can never drift from what is actually deployed.
(function showBuild() {
  try {
    const m = document.querySelector('meta[name="app-build"]');
    const el = document.getElementById("buildLabel");
    if (m && el) el.textContent = "v" + m.getAttribute("content");
  } catch (e) { console.warn("[safebox] build label failed", e); }
})();

buildKeypad();

document.getElementById("sbAuthGo").addEventListener("click", sbDoLogin);
document.getElementById("sbAuthPass").addEventListener("keydown", function (e) {
  if (e.key === "Enter") sbDoLogin();
});

firebase.auth().onAuthStateChanged(function (user) {
  if (user && user.isAnonymous === false && user.email) {
    hideAdminLogin();
    sbBoot();
  } else {
    showAdminLogin();
  }
}, function (err) {
  console.warn("[safebox] auth listener failed", err);
  showAdminLogin();
});

// Sheet overlay click-outside-to-close
document.querySelectorAll(".sheet-overlay").forEach(ov => {
  ov.addEventListener("click", e => {
    if (e.target === ov) ov.classList.remove("active");
  });
});

// Register service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      // If a new SW takes control, reload once to get fresh assets
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!window._swReloaded) {
          window._swReloaded = true;
          location.reload();
        }
      });
      reg.update();
    }).catch(() => {});
  });
}
