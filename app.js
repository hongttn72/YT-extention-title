/* YT Hologram Extractor - Main Application Logic */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allRows = [];          // all fetched video data rows
let parsedFileRows = [];   // rows parsed from uploaded file

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const ytUrl       = () => document.getElementById('ytUrl');
const kenhInput   = () => document.getElementById('kenhInput');
const fetchBtn    = () => document.getElementById('fetchBtn');
const progress1   = () => document.getElementById('progress1');
const progress2   = () => document.getElementById('progress2');
const fetchAllBtn = () => document.getElementById('fetchAllBtn');
const fileInput   = () => document.getElementById('fileInput');
const fileNameEl  = () => document.getElementById('fileName');
const exportBtn   = () => document.getElementById('exportBtn');
const statusBar   = () => document.getElementById('statusBar');
const tableBody   = () => document.getElementById('tableBody');
const resultsEl   = () => document.getElementById('results');
const resultCount = () => document.getElementById('resultCount');

// ─── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(msg) {
  statusBar().textContent = msg;
}

function showToast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function showProgress(el, msg) {
  el.innerHTML = `<span class="spinner"></span>${msg}`;
  el.classList.remove('hidden');
}

function hideProgress(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ─── Video ID extractor (client-side mirror of background.js) ─────────────────
function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  let m = url.match(/youtu\.be\/([^?&#/]+)/);
  if (m) return m[1];
  m = url.match(/[?&]v=([^?&#/]+)/);
  if (m) return m[1];
  m = url.match(/\/shorts\/([^?&#/]+)/);
  if (m) return m[1];
  m = url.match(/\/live\/([^?&#/]+)/);
  if (m) return m[1];
  m = url.match(/\/embed\/([^?&#/]+)/);
  if (m) return m[1];
  return null;
}

// ─── Fetch single video via background message ─────────────────────────────────
function fetchSingleVideo(url, stt, kenh) {
  const videoId = extractVideoId(url);
  if (!videoId) return Promise.reject(new Error('Không tìm thấy video ID trong link: ' + url));

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'fetchVideoData', videoId, extraData: { stt, kenh } },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error((response && response.error) || 'Unknown error'));
        }
      }
    );
  });
}

// ─── Render table ──────────────────────────────────────────────────────────────
function renderTable(rows) {
  const tbody = tableBody();
  tbody.innerHTML = rows.map((r, i) => {
    const transcriptShort = escHtml((r.transcript || '').substring(0, 100));
    const hasMore = (r.transcript || '').length > 100;
    return `<tr>
      <td class="stt">${escHtml(String(r.stt || i + 1))}</td>
      <td>${escHtml(r.kenh || '')}</td>
      <td>${escHtml(r.channelName || '')}</td>
      <td class="link"><a href="${escHtml(r.link || '')}" target="_blank">▶ Link</a></td>
      <td>${escHtml(r.title || '')}</td>
      <td>${escHtml(r.titleVi || '')}</td>
      <td class="thumbnail">${r.thumbnailUrl ? `<img src="${escHtml(r.thumbnailUrl)}" alt="thumb" loading="lazy"/>` : ''}</td>
      <td class="transcript" title="${escHtml(r.transcript || '')}">${transcriptShort}${hasMore ? '...' : ''}</td>
      <td class="duration">${escHtml(r.duration || '')}</td>
      <td class="views">${escHtml(r.viewCount || '')}</td>
    </tr>`;
  }).join('');

  resultCount().textContent = `${rows.length} video`;
  resultsEl().classList.remove('hidden');
}

// ─── Export to XLSX ───────────────────────────────────────────────────────────
function exportToExcel(rows) {
  const headers = [
    'STT', 'Kênh', 'Tên kênh YouTube', 'Link video',
    'Tiêu đề', 'Tiêu đề (Tiếng Việt)', 'Link ảnh thumbnail',
    'Transcript', 'Thời lượng', 'Số view'
  ];
  const data = rows.map(r => [
    r.stt, r.kenh, r.channelName, r.link,
    r.title, r.titleVi, r.thumbnailUrl,
    r.transcript, r.duration, r.viewCount
  ]);
  const blob = generateXLSX([headers, ...data]);
  downloadBlob(blob, `yt_data_${Date.now()}.xlsx`);
}

// ─── CSV template download ─────────────────────────────────────────────────────
function downloadTemplate() {
  const csv = 'STT,Kênh,Link video\n1,,https://www.youtube.com/watch?v=\n2,,\n3,,\n';
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, 'template_yt.csv');
}

// ─── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  // Remove BOM
  text = text.replace(/^﻿/, '');
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  return lines.slice(1).map(line => {
    const parts = parseCSVLine(line);
    return {
      stt: (parts[0] || '').trim(),
      kenh: (parts[1] || '').trim(),
      link: (parts.slice(2).join(',') || '').trim()
    };
  }).filter(r => r.link && r.link.includes('youtube'));
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  result.push(cur);
  return result;
}

// ─── XLSX parser (via xlsx-min.js) ────────────────────────────────────────────
async function parseXLSX(arrayBuffer) {
  return readXLSX(arrayBuffer);
}

function xlsxRowsToVideoRows(rows) {
  if (!rows || rows.length < 2) return [];
  // Skip header row
  return rows.slice(1).map(cols => ({
    stt:  String(cols[0] || '').trim(),
    kenh: String(cols[1] || '').trim(),
    link: String(cols[2] || '').trim()
  })).filter(r => r.link && r.link.includes('youtube'));
}

// ─── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      document.getElementById('mode' + mode).classList.remove('hidden');
    });
  });
}

// ─── Mode 1: single fetch ──────────────────────────────────────────────────────
function initMode1() {
  fetchBtn().addEventListener('click', async () => {
    const url   = ytUrl().value.trim();
    const kenh  = kenhInput().value.trim();

    if (!url) { showToast('Vui lòng nhập link YouTube!', 'error'); return; }
    if (!extractVideoId(url)) { showToast('Link không hợp lệ!', 'error'); return; }

    fetchBtn().disabled = true;
    showProgress(progress1(), 'Đang lấy dữ liệu video...');
    setStatus('FETCHING VIDEO DATA...');

    try {
      const data = await fetchSingleVideo(url, allRows.length + 1, kenh);
      data.stt = allRows.length + 1;
      allRows.push(data);
      renderTable(allRows);
      showToast('Đã lấy dữ liệu thành công!', 'success');
      setStatus(`DONE — ${allRows.length} video loaded`);
      ytUrl().value = '';
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
      setStatus('ERROR: ' + err.message);
    } finally {
      fetchBtn().disabled = false;
      hideProgress(progress1());
    }
  });

  // Enter key on URL input
  ytUrl().addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchBtn().click();
  });
}

// ─── Mode 2: bulk fetch ────────────────────────────────────────────────────────
function initMode2() {
  document.getElementById('downloadTemplate').addEventListener('click', () => {
    downloadTemplate();
    showToast('Đã tải template CSV!', 'success');
  });

  fileInput().addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    fileNameEl().textContent = file.name;
    parsedFileRows = [];
    fetchAllBtn().disabled = true;

    try {
      if (file.name.toLowerCase().endsWith('.csv')) {
        const text = await file.text();
        parsedFileRows = parseCSV(text);
      } else if (file.name.toLowerCase().endsWith('.xlsx')) {
        const buf = await file.arrayBuffer();
        const xlsxRows = await parseXLSX(buf);
        parsedFileRows = xlsxRowsToVideoRows(xlsxRows);
      } else {
        showToast('Chỉ hỗ trợ .csv và .xlsx!', 'error');
        return;
      }

      if (parsedFileRows.length === 0) {
        showToast('Không tìm thấy link YouTube trong file!', 'error');
        return;
      }

      fetchAllBtn().disabled = false;
      showToast(`Đã đọc ${parsedFileRows.length} link từ file!`, 'success');
      setStatus(`FILE LOADED — ${parsedFileRows.length} links found`);
    } catch (err) {
      showToast('Lỗi đọc file: ' + err.message, 'error');
    }
  });

  fetchAllBtn().addEventListener('click', async () => {
    if (!parsedFileRows.length) return;

    fetchAllBtn().disabled = true;
    allRows = [];
    const prog = progress2();
    setStatus('AUTO FETCH ALL STARTING...');

    for (let i = 0; i < parsedFileRows.length; i++) {
      const row = parsedFileRows[i];
      const msg = `[${i + 1}/${parsedFileRows.length}] Đang fetch: ${row.link.substring(0, 60)}...`;
      showProgress(prog, msg);
      setStatus(msg);

      try {
        const data = await fetchSingleVideo(row.link, row.stt || (i + 1), row.kenh);
        data.stt = row.stt || (i + 1);
        data.kenh = row.kenh || data.kenh;
        allRows.push(data);
      } catch (err) {
        // Push error row so user can see which failed
        allRows.push({
          stt: row.stt || (i + 1),
          kenh: row.kenh,
          link: row.link,
          title: '[LỖI] ' + err.message,
          titleVi: '', channelName: '', viewCount: '', duration: '',
          thumbnailUrl: '', transcript: ''
        });
      }

      renderTable(allRows);

      // Small delay to avoid rate limiting
      if (i < parsedFileRows.length - 1) {
        await new Promise(res => setTimeout(res, 800));
      }
    }

    hideProgress(prog);
    fetchAllBtn().disabled = false;
    showToast(`Hoàn tất! Đã fetch ${allRows.length} video.`, 'success');
    setStatus(`COMPLETE — ${allRows.length} video fetched`);
  });
}

// ─── Export button ─────────────────────────────────────────────────────────────
function initExport() {
  exportBtn().addEventListener('click', () => {
    if (!allRows.length) {
      showToast('Chưa có dữ liệu để xuất!', 'error');
      return;
    }
    try {
      exportToExcel(allRows);
      showToast('Đã xuất file Excel!', 'success');
    } catch (err) {
      showToast('Lỗi xuất Excel: ' + err.message, 'error');
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initMode1();
  initMode2();
  initExport();
  setStatus('READY — YT HOLOGRAM EXTRACTOR v1.0');
});
