// =====================================================================
// SMART INCUBATOR - Frontend Logic
// Dual-mode: lokal (WebSocket ke server.js Raspi) & remote (Firebase RTDB)
// =====================================================================

// ---------------------------------------------------------------------
// KONFIGURASI
// ---------------------------------------------------------------------
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC-kO_uf16Il4-ZmVcttJNgVfqbOh4ab34",
  authDomain: "smart-incubator-c61a1.firebaseapp.com",
  databaseURL: "https://smart-incubator-c61a1-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "smart-incubator-c61a1",
  storageBucket: "smart-incubator-c61a1.firebasestorage.app",
  messagingSenderId: "123564284016",
  appId: "1:123564284016:web:bee978c47ba06bb5b8bcb5"
};

const MAX_CHART_POINTS = 30;
const ACCESS_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------
// DEVICE ID (persisten per-browser, untuk sistem hak akses)
// ---------------------------------------------------------------------
function getDeviceId() {
  let id = sessionStorage.getItem('incubator_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('incubator_device_id', id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
let appState = {
  sensor: { suhu: 0, rh: 0, suhuKulit: 0, pwmKipas: 0, pwmHeater: 0, alarm: false, running: false, timestamp: 0 },
  control: { mode: 'air', setpointSuhu: 34.0, setpointKulit: 36.0, running: false },
  access: { owner: null, token: null, expiresAt: 0 },
  connection: { online: false, lastChange: Date.now() },
};

let connectionMode = 'connecting'; // 'local' | 'remote' | 'connecting'
let ws = null;
let firebaseApp = null;
let fbDb = null;
let charts = {};

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initCharts();
  initControlHandlers();
  connectLocal();
  loadHistory();
  loadLog();
});

// ---------------------------------------------------------------------
// NAVIGASI ANTAR HALAMAN
// ---------------------------------------------------------------------
function initNavigation() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active-page'));

      btn.classList.add('active');
      document.getElementById(btn.dataset.page).classList.add('active-page');
    });
  });
}

// =====================================================================
// KONEKSI: LOCAL (WebSocket ke server.js) -> fallback REMOTE (Firebase)
// =====================================================================

function connectLocal() {
  const wsUrl = `ws://${window.location.hostname}:3000`;
  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Terhubung ke server lokal.');
      setConnectionMode('local');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleLocalMessage(msg);
      } catch (e) {
        console.error('Pesan WS tidak valid', e);
      }
    };

    ws.onclose = () => {
      console.warn('[WS] Putus dari server lokal. Mencoba ulang & beralih ke remote...');
      setConnectionMode('remote');
      setTimeout(connectLocal, 5000); // coba reconnect lokal tiap 5s
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (e) {
    console.warn('[WS] Gagal membuat koneksi lokal, beralih ke remote.');
    setConnectionMode('remote');
    setTimeout(connectLocal, 5000);
  }
}

function setConnectionMode(mode) {
  if (connectionMode === mode) return;
  connectionMode = mode;

  if (mode === 'remote') {
    initFirebaseListener();
  }
  updateConnPill();
}

// ---------------------------------------------------------------------
// HANDLE PESAN DARI SERVER LOKAL
// ---------------------------------------------------------------------
function handleLocalMessage(msg) {
  switch (msg.type) {
    case 'init':
      appState = msg.payload;
      renderAll();
      break;
    case 'sensor':
      appState.sensor = msg.payload;
      renderSensor();
      pushChartData();
      break;
    case 'control':
      appState.control = msg.payload;
      renderControl();
      break;
    case 'access':
      appState.access = msg.payload;
      renderAccess();
      break;
    case 'connection':
      appState.connection = msg.payload;
      updateConnPill();
      break;
    case 'accessGranted':
      showToast('Hak akses kontrol berhasil diambil.', 'success');
      break;
    case 'accessDenied':
      showToast('Hak akses sedang digunakan perangkat lain.', 'warning');
      break;
    case 'controlRejected':
      showToast('Aksi gagal: Anda belum memiliki hak akses.', 'danger');
      break;
  }
}

// =====================================================================
// FIREBASE (REMOTE MODE)
// =====================================================================
function initFirebaseListener() {
  if (firebaseApp) return; // sudah init sebelumnya

  try {
    firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    fbDb = firebase.database();

    fbDb.ref('incubator/sensor').on('value', (snap) => {
      const val = snap.val();
      if (!val) return;
      appState.sensor = val;
      renderSensor();
      pushChartData();
    });

    fbDb.ref('incubator/control').on('value', (snap) => {
      const val = snap.val();
      if (!val) return;
      appState.control = val;
      renderControl();
    });

    fbDb.ref('incubator/access').on('value', (snap) => {
      const val = snap.val();
      if (!val) return;
      appState.access = val;
      renderAccess();
    });

    fbDb.ref('incubator/log').limitToLast(20).on('value', (snap) => {
      const val = snap.val() || {};
      renderLogList(Object.values(val));
    });

    fbDb.ref('incubator/history').limitToLast(100).on('value', (snap) => {
      const val = snap.val() || {};
      renderHistoryTable(Object.values(val));
    });

    // status koneksi yang ditampilkan = status RTDB connection itu sendiri
    fbDb.ref('.info/connected').on('value', (snap) => {
      appState.connection.online = snap.val() === true;
      updateConnPill();
    });

  } catch (e) {
    console.error('[Firebase] Inisialisasi gagal:', e);
  }
}

// =====================================================================
// RENDER
// =====================================================================
function renderAll() {
  renderSensor();
  renderControl();
  renderAccess();
  updateConnPill();
}

function renderSensor() {
  const s = appState.sensor;
  document.getElementById('valSuhu').textContent = fmt(s.suhu);
  document.getElementById('valRh').textContent = fmt(s.rh);
  document.getElementById('valSuhuKulit').textContent = fmt(s.suhuKulit);

  const alarmEl = document.getElementById('valAlarm');
  alarmEl.textContent = s.alarm ? 'AKTIF' : 'Normal';
  alarmEl.classList.toggle('alarm-on', !!s.alarm);
  alarmEl.classList.toggle('alarm-off', !s.alarm);

  document.getElementById('alarmBanner').classList.toggle('d-none', !s.alarm);

  document.getElementById('valPwmKipas').textContent = s.pwmKipas ?? 0;
  document.getElementById('valPwmHeater').textContent = s.pwmHeater ?? 0;
  document.getElementById('barKipas').style.width = pct(s.pwmKipas) + '%';
  document.getElementById('barHeater').style.width = pct(s.pwmHeater) + '%';

  const runEl = document.getElementById('valRunning');
  runEl.textContent = s.running ? 'Berjalan' : 'Berhenti';
  runEl.classList.toggle('running', !!s.running);
  runEl.classList.toggle('stopped', !s.running);

  // Sinkronkan tombol start/stop dengan status aktual
  document.getElementById('btnStart').disabled = !!s.running;
  document.getElementById('btnStop').disabled = !s.running;
}

function renderControl() {
  const c = appState.control;

  // Mode buttons
  document.getElementById('btnAirMode').classList.toggle('active', c.mode === 'air');
  document.getElementById('btnSkinMode').classList.toggle('active', c.mode === 'skin');

  document.getElementById('setpointAirGroup').classList.toggle('d-none', c.mode !== 'air');
  document.getElementById('setpointSkinGroup').classList.toggle('d-none', c.mode !== 'skin');

  // Setpoint values (jangan timpa jika user sedang fokus mengetik)
  const spSuhu = document.getElementById('setpointSuhu');
  const spKulit = document.getElementById('setpointKulit');
  if (document.activeElement !== spSuhu) spSuhu.value = c.setpointSuhu;
  if (document.activeElement !== spKulit) spKulit.value = c.setpointKulit;
}

function renderAccess() {
  const a = appState.access;
  const now = Date.now();
  const isActive = a.owner && a.expiresAt > now;
  const isMine = isActive && a.owner === DEVICE_ID;

  const accessEl = document.getElementById('valAccess');
  const btnAccess = document.getElementById('btnAccess');

  if (!isActive) {
    accessEl.textContent = 'Tersedia';
    accessEl.className = 'access-status';
    btnAccess.innerHTML = '<i class="bi bi-key"></i> Ambil Hak Akses';
    btnAccess.classList.remove('active-access');
  } else if (isMine) {
    accessEl.textContent = 'Anda';
    accessEl.className = 'access-status mine';
    btnAccess.innerHTML = '<i class="bi bi-key-fill"></i> Lepas Hak Akses';
    btnAccess.classList.add('active-access');
  } else {
    accessEl.textContent = 'Perangkat Lain';
    accessEl.className = 'access-status taken';
    btnAccess.innerHTML = '<i class="bi bi-lock"></i> Sedang Digunakan';
    btnAccess.classList.remove('active-access');
  }

  // Kontrol input hanya aktif untuk pemegang akses
  const controlsEnabled = isMine;
  document.querySelectorAll('.mode-btn, .btn-step, .setpoint-input, #btnStart, #btnStop')
    .forEach((el) => {
      if (el.id === 'btnStart' || el.id === 'btnStop') return; // diatur oleh renderSensor juga
      el.disabled = !controlsEnabled;
    });

  if (controlsEnabled) {
    document.getElementById('btnStart').disabled = !!appState.sensor.running;
    document.getElementById('btnStop').disabled = !appState.sensor.running;
  } else {
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnStop').disabled = true;
  }
}

function updateConnPill() {
  const dot = document.getElementById('connDot');
  const text = document.getElementById('connText');
  const online = appState.connection.online;

  if (connectionMode === 'local') {
    if (online) {
      dot.className = 'dot online';
      text.textContent = 'Online (Lokal + Remote)';
    } else {
      dot.className = 'dot offline';
      text.textContent = 'Offline (Lokal)';
    }
  } else if (connectionMode === 'remote') {
    dot.className = online ? 'dot online' : 'dot offline';
    text.textContent = online ? 'Online (Remote)' : 'Menghubungkan...';
  } else {
    dot.className = 'dot';
    text.textContent = 'Menghubungkan...';
  }
}

// =====================================================================
// CHARTS
// =====================================================================
function initCharts() {
  const baseOptions = {
    responsive: true,
    animation: false,
    scales: {
      x: { display: false },
      y: { beginAtZero: false }
    },
    plugins: { legend: { display: false } },
    elements: { point: { radius: 0 }, line: { tension: 0.35 } }
  };

  charts.suhu = new Chart(document.getElementById('chartSuhu'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#4FB3BF', borderWidth: 2, fill: true, backgroundColor: 'rgba(79,179,191,0.1)' }] },
    options: baseOptions
  });

  charts.rh = new Chart(document.getElementById('chartRh'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#2E8B9C', borderWidth: 2, fill: true, backgroundColor: 'rgba(46,139,156,0.1)' }] },
    options: baseOptions
  });

  charts.skin = new Chart(document.getElementById('chartSkin'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#FF8C61', borderWidth: 2, fill: true, backgroundColor: 'rgba(255,140,97,0.1)' }] },
    options: baseOptions
  });
}

function pushChartData() {
  const time = new Date(appState.sensor.timestamp || Date.now()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  addPoint(charts.suhu, time, appState.sensor.suhu);
  addPoint(charts.rh, time, appState.sensor.rh);
  addPoint(charts.skin, time, appState.sensor.suhuKulit);
}

function addPoint(chart, label, value) {
  chart.data.labels.push(label);
  chart.data.datasets[0].data.push(value);

  if (chart.data.labels.length > MAX_CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update('none');
}

// =====================================================================
// CONTROL HANDLERS
// =====================================================================
function initControlHandlers() {
  // Mode switch
  document.getElementById('btnAirMode').addEventListener('click', () => sendControl({ mode: 'air' }));
  document.getElementById('btnSkinMode').addEventListener('click', () => sendControl({ mode: 'skin' }));

  // Step buttons
  document.querySelectorAll('.btn-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const step = parseFloat(btn.dataset.step);
      const input = document.getElementById(target);
      let val = parseFloat(input.value) + step;
      val = Math.round(val * 10) / 10;
      input.value = val;
      sendControl({ [target]: val });
    });
  });

  // Manual input setpoint (on change)
  document.getElementById('setpointSuhu').addEventListener('change', (e) => {
    sendControl({ setpointSuhu: parseFloat(e.target.value) });
  });
  document.getElementById('setpointKulit').addEventListener('change', (e) => {
    sendControl({ setpointKulit: parseFloat(e.target.value) });
  });

  // Start / Stop
  document.getElementById('btnStart').addEventListener('click', () => sendStartStop(true));
  document.getElementById('btnStop').addEventListener('click', () => sendStartStop(false));

  // Access button
  document.getElementById('btnAccess').addEventListener('click', toggleAccess);

  // History buttons
  document.getElementById('btnDeleteHistory').addEventListener('click', deleteHistory);
  document.getElementById('btnExport').addEventListener('click', exportHistoryCSV);
}

function sendControl(payload) {
  const msg = { type: 'setControl', deviceId: DEVICE_ID, payload };

  if (connectionMode === 'local' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (connectionMode === 'remote' && fbDb) {
    if (!hasAccessLocally()) {
      showToast('Anda belum memiliki hak akses kontrol.', 'danger');
      return;
    }
    fbDb.ref('incubator/control').update(payload);
  }
}

function sendStartStop(running) {
  const msg = { type: 'startStop', deviceId: DEVICE_ID, payload: { running } };

  if (connectionMode === 'local' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (connectionMode === 'remote' && fbDb) {
    if (!hasAccessLocally()) {
      showToast('Anda belum memiliki hak akses kontrol.', 'danger');
      return;
    }
    fbDb.ref('incubator/control').update({ running });
  }
}

function hasAccessLocally() {
  const a = appState.access;
  return a.owner === DEVICE_ID && a.expiresAt > Date.now();
}

function toggleAccess() {
  const isMine = hasAccessLocally();
  const type = isMine ? 'releaseAccess' : 'requestAccess';
  const msg = { type, deviceId: DEVICE_ID };

  if (connectionMode === 'local' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (connectionMode === 'remote' && fbDb) {
    const now = Date.now();
    const a = appState.access;
    const expired = a.owner && a.expiresAt < now;

    if (isMine) {
      fbDb.ref('incubator/access').set({ owner: null, token: null, expiresAt: 0 });
    } else if (!a.owner || expired) {
      fbDb.ref('incubator/access').set({
        owner: DEVICE_ID,
        token: Math.random().toString(36).slice(2),
        expiresAt: now + ACCESS_TTL_MS,
      });
      showToast('Hak akses kontrol berhasil diambil.', 'success');
    } else {
      showToast('Hak akses sedang digunakan perangkat lain.', 'warning');
    }
  }
}

// =====================================================================
// LOG SISTEM
// =====================================================================
function loadLog() {
  fetch('/api/log')
    .then((res) => res.json())
    .then((data) => renderLogList(data))
    .catch(() => {});
}

function renderLogList(logs) {
  const box = document.getElementById('logBox');
  if (!logs || logs.length === 0) {
    box.innerHTML = '<div class="log-empty">Belum ada log konektivitas.</div>';
    return;
  }

  const sorted = [...logs].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);

  box.innerHTML = sorted.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleString('id-ID');
    const cls = entry.event === 'ONLINE' ? 'online' : 'offline';
    return `<div class="log-entry">
              <span class="log-event ${cls}">${entry.event}</span>
              <span class="log-time">${time}</span>
            </div>`;
  }).join('');
}

// =====================================================================
// HISTORY
// =====================================================================
function loadHistory() {
  fetch('/api/history')
    .then((res) => res.json())
    .then((data) => renderHistoryTable(data))
    .catch(() => {});
}

let lastHistoryData = [];

function renderHistoryTable(data) {
  lastHistoryData = [...data].sort((a, b) => b.timestamp - a.timestamp);
  const tbody = document.getElementById('historyTableBody');

  if (lastHistoryData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Belum ada data riwayat.</td></tr>';
    return;
  }

  tbody.innerHTML = lastHistoryData.slice(0, 200).map((row) => {
    const time = new Date(row.timestamp).toLocaleString('id-ID');
    return `<tr>
              <td>${time}</td>
              <td>${fmt(row.suhu)}</td>
              <td>${fmt(row.rh)}</td>
              <td>${fmt(row.suhuKulit)}</td>
            </tr>`;
  }).join('');
}

function deleteHistory() {
  if (!confirm('Hapus seluruh riwayat data? Tindakan ini tidak dapat dibatalkan.')) return;

  fetch('/api/history', { method: 'DELETE' })
    .then(() => {
      lastHistoryData = [];
      renderHistoryTable([]);
      showToast('Riwayat data berhasil dihapus.', 'success');
    })
    .catch(() => showToast('Gagal menghapus riwayat data.', 'danger'));
}

function exportHistoryCSV() {
  if (lastHistoryData.length === 0) {
    showToast('Tidak ada data untuk diekspor.', 'warning');
    return;
  }

  let csv = 'Waktu,Suhu Udara (C),Kelembaban (%),Suhu Kulit (C)\n';
  lastHistoryData.forEach((row) => {
    const time = new Date(row.timestamp).toLocaleString('id-ID');
    csv += `${time},${row.suhu},${row.rh},${row.suhuKulit}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `history_incubator_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// =====================================================================
// UTIL
// =====================================================================
function fmt(num) {
  if (num === undefined || num === null || isNaN(num)) return '--';
  return Number(num).toFixed(1);
}

function pct(val) {
  const v = Math.max(0, Math.min(255, val || 0));
  return Math.round((v / 255) * 100);
}

function showToast(message, type = 'info') {
  const colors = { success: 'success', danger: 'danger', warning: 'warning', info: 'primary' };
  const toastEl = document.createElement('div');
  toastEl.className = `toast align-items-center text-bg-${colors[type] || 'primary'} border-0`;
  toastEl.setAttribute('role', 'alert');
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  document.getElementById('toastContainer').appendChild(toastEl);

  const toast = new bootstrap.Toast(toastEl, { delay: 3000 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}