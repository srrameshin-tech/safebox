// ============ FIREBASE CONFIG ============
const firebaseConfig = {
  apiKey: "AIzaSyBVGVu59jDZybPFAX_pRisSrQRoXHQ0EWY",
  authDomain: "kmbsc-chit.firebaseapp.com",
  databaseURL: "https://kmbsc-chit-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kmbsc-chit"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
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

const STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024; // 1GB Spark free limit
const WARN_THRESHOLD = 0.75; // warn at 75%
const DANGER_THRESHOLD = 0.9;

const FOLDER_ICONS = ["📁","📄","🆔","🏠","💳","🩺","🚗","🎓","🧾","⚖️","🖼️","📜"];
const FOLDER_COLORS = ["#6c5ce7","#00b894","#e17055","#0984e3","#d63031","#fdcb6e","#a29bfe","#00cec9"];

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
function buildKeypad() {
  const keypad = document.getElementById("keypad");
  keypad.innerHTML = "";
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  keys.forEach(k => {
    const btn = document.createElement("button");
    btn.className = "key" + (k === "" ? " empty" : "");
    btn.textContent = k;
    if (k !== "") {
      btn.addEventListener("click", () => handleKeyPress(k));
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

function checkPin() {
  if (enteredPin === appState.pin) {
    document.getElementById("loginError").textContent = "";
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

// ============ DATA LOADING ============
function loadData(callback) {
  db.ref(ROOT).once("value").then(snap => {
    const val = snap.val();
    if (val) {
      appState.pin = val.pin || "1973";
      appState.folders = val.folders || {};
      appState.files = val.files || {};
      appState.shares = val.shares || {};
    } else {
      // First run - seed default folders
      seedDefaultFolders();
    }
    if (Object.keys(appState.folders).length === 0) {
      seedDefaultFolders();
    }
    callback && callback();
  }).catch(err => {
    console.error(err);
    toast("Connection error, retry பண்ணுங்க");
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
  document.getElementById("storageText").textContent = `${formatBytes(used)} / 1 GB`;
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
function openFolder(folderId) {
  currentFolderId = folderId;
  const f = appState.folders[folderId];
  document.getElementById("folderTitle").textContent = f.name;
  renderFolderFiles();
  showScreen("folderScreen");
}

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
    tile.innerHTML = `<img src="${f.data}" alt="${escapeHtml(f.name)}">`;
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
    body.innerHTML = `<img src="${f.data}" alt="${escapeHtml(f.name)}">`;
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
    delete appState.files[currentViewerFileId];
    saveFiles();
    renderFolderFiles();
    renderStorageMeter();
    renderFolderGrid();
    showScreen("folderScreen");
    toast("File delete ஆச்சு");
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

document.getElementById("vaShare").addEventListener("click", () => {
  const code = genCode();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const fileIdAtShareTime = currentViewerFileId;
  // Write directly to this share's path only (not the whole shares tree) to avoid clobbering other shares
  db.ref(ROOT + "/shares/" + code).set({ fileId: fileIdAtShareTime, expiresAt })
    .then(() => {
      appState.shares[code] = { fileId: fileIdAtShareTime, expiresAt };
      document.getElementById("shareCodeDisplay").textContent = code;
      document.getElementById("shareExpiryText").textContent = "24 மணி நேரத்துக்கு valid";
      document.getElementById("copyShareCodeBtn").dataset.code = code;
      document.getElementById("copyShareLinkBtn").dataset.code = code;
      openSheet("shareSheetOverlay");
    })
    .catch(err => {
      console.error("Share save failed:", err);
      toast("Share code create ஆகல, மறுபடி try பண்ணுங்க");
    });
});
document.getElementById("copyShareCodeBtn").addEventListener("click", e => {
  const code = e.target.dataset.code;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => toast("Code copy ஆச்சு")).catch(() => toast("Code: " + code));
  } else {
    toast("Code: " + code);
  }
});
document.getElementById("copyShareLinkBtn").addEventListener("click", e => {
  const code = e.target.dataset.code;
  const link = `${location.origin}${location.pathname}?share=${code}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => toast("Link copy ஆச்சு")).catch(() => toast("Link: " + link));
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

// ============ FOLDER MENU (rename/delete folder) ============
document.getElementById("folderMenuBtn").addEventListener("click", () => {
  document.getElementById("folderMenuTitle").textContent = appState.folders[currentFolderId].name;
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
    Object.keys(appState.files).forEach(fid => {
      if (appState.files[fid].folderId === currentFolderId) delete appState.files[fid];
    });
    delete appState.folders[currentFolderId];
    saveFolders();
    saveFiles();
    renderFolderGrid();
    renderStorageMeter();
    showScreen("homeScreen");
    toast("Folder delete ஆச்சு");
  };
  document.getElementById("deleteConfirmText").textContent = `இந்த folder-ஓட ${count} files-உம் delete ஆகிடும்.`;
  openSheet("deleteConfirmOverlay");
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
document.getElementById("pickDocRow").addEventListener("click", () => document.getElementById("fileDocInput").click());

document.getElementById("filePhotoInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) handlePhotoUpload(file);
  e.target.value = "";
});
document.getElementById("fileDocInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) handleDocUpload(file);
  e.target.value = "";
});

function showUploadProgress(text) {
  document.getElementById("uploadChooseStage").classList.add("hidden");
  document.getElementById("uploadProgressStage").classList.remove("hidden");
  document.getElementById("uploadProgressText").textContent = text;
}

function handlePhotoUpload(file) {
  showUploadProgress("Photo compress ஆகுது...");
  compressImage(file, 1280, 0.72, (dataUrl, sizeBytes) => {
    finalizeUpload(file.name, "image", dataUrl, sizeBytes);
  });
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
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      cb(dataUrl, estimateBase64Bytes(dataUrl));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function handleDocUpload(file) {
  const maxSize = 6 * 1024 * 1024; // 6MB cap for docs
  if (file.size > maxSize) {
    toast("File 6MB-க்கு மேல இருக்கு, compress பண்ணி try பண்ணுங்க");
    closeSheet("uploadSheetOverlay");
    return;
  }
  showUploadProgress("Document upload ஆகுது...");
  const isImage = file.type.startsWith("image/");
  const reader = new FileReader();
  reader.onload = e => {
    finalizeUpload(file.name, isImage ? "image" : "doc", e.target.result, estimateBase64Bytes(e.target.result));
  };
  reader.readAsDataURL(file);
}

function finalizeUpload(name, type, dataUrl, sizeBytes) {
  const used = computeUsedBytes();
  if (used + sizeBytes > STORAGE_LIMIT_BYTES) {
    toast("⚠️ Storage full! Files delete பண்ணி try பண்ணுங்க");
    closeSheet("uploadSheetOverlay");
    return;
  }
  const id = "file_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
  appState.files[id] = {
    name, type, data: dataUrl, size: sizeBytes,
    folderId: pendingUploadFolderId, createdAt: Date.now()
  };
  saveFiles();
  closeSheet("uploadSheetOverlay");
  renderStorageMeter();
  renderFolderGrid();
  if (currentFolderId) renderFolderFiles();
  toast("Upload ஆச்சு ✓");
}

// ============ SETTINGS ============
document.getElementById("settingsBtn").addEventListener("click", () => openSheet("settingsSheetOverlay"));
document.getElementById("closeSettingsRow").addEventListener("click", () => closeSheet("settingsSheetOverlay"));
document.getElementById("changePinRow").addEventListener("click", () => {
  closeSheet("settingsSheetOverlay");
  document.getElementById("newPinInput").value = "";
  openSheet("changePinSheetOverlay");
});
document.getElementById("savePinBtn").addEventListener("click", () => {
  const newPin = document.getElementById("newPinInput").value.trim();
  if (!/^\d{4}$/.test(newPin)) { toast("4-digit PIN கொடுங்க"); return; }
  appState.pin = newPin;
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

function checkIncomingShareLink() {
  const params = new URLSearchParams(location.search);
  const code = params.get("share");
  if (!code) return false;

  const share = appState.shares[code];
  if (!share || share.expiresAt < Date.now()) {
    // Show an expired/invalid message on the share-access screen itself
    showScreen("shareAccessScreen");
    document.getElementById("shareAccessSub").textContent = "இந்த link expire ஆகிடுச்சு அல்லது invalid";
    document.querySelectorAll("#shareAccessKeypad .key").forEach(b => b.style.visibility = "hidden");
    return true;
  }
  const f = appState.files[share.fileId];
  if (!f) {
    showScreen("shareAccessScreen");
    document.getElementById("shareAccessSub").textContent = "இந்த file கிடைக்கல";
    document.querySelectorAll("#shareAccessKeypad .key").forEach(b => b.style.visibility = "hidden");
    return true;
  }

  // Valid share - require the code to be typed before revealing
  pendingShareFile = f;
  pendingShareCode = code;
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
      btn.addEventListener("click", () => handleShareAccessKeyPress(k));
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
    revealSharedFile(pendingShareFile);
  } else {
    renderShareAccessDots(true);
    document.getElementById("shareAccessError").textContent = "தவறான code, மீண்டும் முயற்சி செய்யுங்க";
    setTimeout(() => {
      enteredShareCode = "";
      renderShareAccessDots();
    }, 500);
  }
}

function revealSharedFile(f) {
  document.getElementById("sharedViewerFname").textContent = f.name;
  const body = document.getElementById("sharedViewerBody");
  if (f.type === "image") {
    body.innerHTML = `<img src="${f.data}" alt="${escapeHtml(f.name)}">`;
  } else {
    body.innerHTML = `<div class="doc-preview"><div class="bigicon">📄</div><p>${escapeHtml(f.name)}</p></div>`;
  }
  showScreen("viewerScreenShared");
}


// ============ INIT ============
buildKeypad();
loadData(() => {
  if (!checkIncomingShareLink()) {
    // normal flow - wait at login screen
  }
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
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
