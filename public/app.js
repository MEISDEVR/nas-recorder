'use strict';
const $ = s => document.querySelector(s);
const ui = {
  stage: $('#stage'), preview: $('#preview'), startBtn: $('#startBtn'), stopBtn: $('#stopBtn'),
  pauseBtn: $('#pauseBtn'), micBtn: $('#micBtn'), timer: $('#timer'), recState: $('#recState'),
  countdown: $('#countdown span'), sync: $('#sync'), syncText: $('#syncText'),
  meterSys: $('#meterSys'), meterMic: $('#meterMic'), meterMicPre: $('#meterMicPre'),
  title: $('#title'), quality: $('#quality'), fps: $('#fps'), format: $('#format'),
  sysAudio: $('#sysAudio'), micOn: $('#micOn'), micSelect: $('#micSelect'), micDetail: $('#micDetail'),
  micGain: $('#micGain'), micGainVal: $('#micGainVal'), countOn: $('#countOn'),
  grid: $('#grid'), libEmpty: $('#libEmpty'), libCount: $('#libCount'), search: $('#search'),
  banner: $('#banner'), pill: $('#serverPill'),
  player: $('#player'), playerVideo: $('#playerVideo'), playerTitle: $('#playerTitle'), playerDl: $('#playerDl'),
};

// ---------- 偏好（只存本机浏览器） ----------
const PREF_KEYS = ['quality', 'fps', 'format', 'sysAudio', 'micOn', 'micSelect', 'micGain', 'countOn'];
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('nasrec.prefs') || '{}');
    for (const k of PREF_KEYS) if (k in p && ui[k]) ui[k].type === 'checkbox' ? (ui[k].checked = p[k]) : (ui[k].value = p[k]);
  } catch {}
}
function savePrefs() {
  try {
    const p = {}; for (const k of PREF_KEYS) p[k] = ui[k].type === 'checkbox' ? ui[k].checked : ui[k].value;
    localStorage.setItem('nasrec.prefs', JSON.stringify(p));
  } catch {}
}

// ---------- 格式探测 ----------
const FORMATS = [
  { ext: 'mp4', label: 'MP4 · H.264（推荐，剪辑软件通用）', types: ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4'] },
  { ext: 'webm', label: 'WebM · VP9（体积更小）', types: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] },
];
const supported = FORMATS.map(f => ({ ...f, mime: window.MediaRecorder && f.types.find(t => MediaRecorder.isTypeSupported(t)) })).filter(f => f.mime);
for (const f of supported) ui.format.add(new Option(f.label, f.ext));

// ---------- 小工具 ----------
const fmtTime = ms => { const s = Math.floor(ms / 1000); return [s / 3600, (s % 3600) / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':'); };
const fmtDur = ms => { const s = Math.round(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0'); };
const fmtSize = b => b < 1 << 20 ? (b / 1024).toFixed(0) + ' KB' : b < 1 << 30 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtDate = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT;
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', 2600); }
async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || r.statusText), { status: r.status });
  return r.json();
}
function setState(s, label) {
  ui.stage.dataset.state = s;
  ui.recState.textContent = label;
  document.body.classList.toggle('is-rec', s === 'recording' || s === 'paused');
  document.body.classList.toggle('is-busy', s !== 'idle');
  window.desktop?.setRecState(s, ui.timer.textContent, deskExtra());
}
const deskExtra = () => ({ hasMic: !!rec?.micGainNode, micMuted: ui.micBtn.classList.contains('toggled') });

// ---------- 音量表 ----------
function meterLoop(analyser, el) {
  const buf = new Float32Array(analyser.fftSize);
  let alive = true;
  (function tick() {
    if (!alive) { el.style.width = '0'; return; }
    analyser.getFloatTimeDomainData(buf);
    let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
    const db = 20 * Math.log10(peak || 1e-6);
    el.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    requestAnimationFrame(tick);
  })();
  return () => { alive = false; };
}

// ---------- 麦克风预览 ----------
let micPreview = null;
async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const cur = ui.micSelect.value;
    ui.micSelect.innerHTML = '<option value="">默认麦克风</option>' + devs.filter(d => d.deviceId && d.deviceId !== 'default')
      .map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || '麦克风')}</option>`).join('');
    ui.micSelect.value = [...ui.micSelect.options].some(o => o.value === cur) ? cur : '';
  } catch {}
}
function micConstraints() {
  return { audio: { deviceId: ui.micSelect.value ? { exact: ui.micSelect.value } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
}
async function startMicPreview() {
  stopMicPreview();
  if (!ui.micOn.checked || rec) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
    if (rec || micPreview) { stream.getTracks().forEach(t => t.stop()); return; }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    const g = ctx.createGain(); g.gain.value = ui.micGain.value / 100;
    ctx.createMediaStreamSource(stream).connect(g).connect(an);
    micPreview = { stream, ctx, g, stop: meterLoop(an, ui.meterMicPre) };
    $('#micHint').textContent = '录入你的讲解';
    listMics();
  } catch (e) {
    $('#micHint').textContent = '无法访问麦克风，请检查浏览器权限';
  }
}
function stopMicPreview() {
  if (!micPreview) return;
  micPreview.stop(); micPreview.stream.getTracks().forEach(t => t.stop()); micPreview.ctx.close();
  micPreview = null;
}

// ---------- 录制 ----------
let rec = null; // 当前录制会话

async function startRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('当前页面无法录屏：请用 HTTPS 地址打开', true);
  const fmt = supported.find(f => f.ext === ui.format.value) || supported[0];
  if (!fmt) return toast('浏览器不支持 MediaRecorder，请换 Chrome / Edge', true);
  savePrefs();

  const h = +ui.quality.value, fps = +ui.fps.value;
  const video = { frameRate: { ideal: fps, max: fps }, cursor: 'always' };
  if (h) { video.height = { ideal: h, max: h }; video.width = { ideal: Math.round(h * 16 / 9), max: Math.round(h * 16 / 9) }; }

  let display, mic;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video, audio: ui.sysAudio.checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } : false,
      systemAudio: ui.sysAudio.checked ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('无法开始录屏：' + e.message, true);
    return;
  }
  stopMicPreview();
  if (ui.micOn.checked) {
    try { mic = await navigator.mediaDevices.getUserMedia(micConstraints()); }
    catch { toast('麦克风不可用，本次只录屏幕声音', true); }
  }
  const vTrack = display.getVideoTracks()[0];
  const sysTrack = display.getAudioTracks()[0];
  if (ui.sysAudio.checked && !sysTrack) toast('没有拿到系统声音：选择共享时请勾选「共享音频」', true);

  // 混音：系统声音 + 麦克风 → 一条音轨
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const stops = [];
  let micGainNode = null;
  if (sysTrack) {
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(new MediaStream([sysTrack])).connect(an).connect(dest);
    stops.push(meterLoop(an, ui.meterSys));
  }
  if (mic) {
    micGainNode = ctx.createGain(); micGainNode.gain.value = ui.micGain.value / 100;
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(mic).connect(micGainNode).connect(an).connect(dest);
    stops.push(meterLoop(an, ui.meterMic));
  }
  const tracks = [vTrack, ...(sysTrack || mic ? dest.stream.getAudioTracks() : [])];
  const stream = new MediaStream(tracks);

  ui.preview.srcObject = display; ui.preview.play().catch(() => {});
  const settings = vTrack.getSettings();
  const pixels = (settings.width || 1920) * (settings.height || 1080);
  const vbps = Math.round(Math.min(24e6, Math.max(3e6, pixels * (settings.frameRate || fps) * 0.12)));

  rec = {
    display, mic, ctx, stops, micGainNode, stream, fmt,
    session: null, queue: [], uploading: false, seq: 0, sent: 0, failed: false,
    started: 0, pausedAt: 0, pausedTotal: 0, timerId: 0, ended: false,
  };
  vTrack.addEventListener('ended', () => stopRecording());

  try {
    rec.session = await api('/api/recordings', { method: 'POST', body: JSON.stringify({ title: ui.title.value, ext: fmt.ext, mime: fmt.mime, width: settings.width, height: settings.height }) });
  } catch (e) { cleanup(); setState('idle', '待机'); return toast('连接 NAS 失败：' + e.message, true); }

  if (ui.countOn.checked) {
    setState('countdown', '准备');
    for (let i = 3; i > 0; i--) {
      if (!rec || rec.ended) return;
      ui.countdown.textContent = i; window.desktop?.setRecState('countdown', String(i), deskExtra()); ui.countdown.classList.remove('tick'); void ui.countdown.offsetWidth; ui.countdown.classList.add('tick');
      await sleep(1000);
    }
    if (!rec || rec.ended) return;
  }

  const mr = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 192000, videoKeyFrameIntervalDuration: 2000 });
  rec.mr = mr;
  mr.ondataavailable = e => { if (e.data && e.data.size) { rec.queue.push(e.data); pump(); } };
  mr.onstop = () => finish();
  mr.start(2000); // 每 2 秒切一段，边录边传，浏览器崩了也只丢最后两秒
  rec.started = performance.now();
  rec.timerId = setInterval(updateTimer, 250);
  setState('recording', '录制中');
  ui.stopBtn.disabled = ui.pauseBtn.disabled = false;
  ui.micBtn.disabled = !mic;
  setTimeout(() => uploadThumb(rec), 1200);
  ui.pauseBtn.classList.remove('toggled'); ui.micBtn.classList.remove('toggled');
  updateSync();
}

// 从预览画面截一帧做封面（没有 ffmpeg 时也有封面）
async function uploadThumb(r) {
  try {
    const v = ui.preview;
    if (!r || r.ended || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = 640; c.height = Math.round(640 * v.videoHeight / v.videoWidth);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82));
    if (blob) await fetch(`/api/sessions/${r.session.id}/thumb`, { method: 'PUT', body: blob });
  } catch {}
}

function elapsed() {
  if (!rec || !rec.started) return 0;
  const now = rec.pausedAt || performance.now();
  return now - rec.started - rec.pausedTotal;
}
let lastTitleSec = -1;
function updateTimer() {
  ui.timer.textContent = fmtTime(elapsed());
  const sec = Math.floor(elapsed() / 1000);
  if (window.desktop && sec !== lastTitleSec) { lastTitleSec = sec; window.desktop.setRecState(ui.stage.dataset.state, ui.timer.textContent, deskExtra()); }
}

function togglePause() {
  if (!rec?.mr) return;
  if (rec.mr.state === 'recording') {
    rec.mr.pause(); rec.pausedAt = performance.now();
    ui.pauseBtn.classList.add('toggled'); setState('paused', '已暂停');
  } else if (rec.mr.state === 'paused') {
    rec.pausedTotal += performance.now() - rec.pausedAt; rec.pausedAt = 0;
    rec.mr.resume(); ui.pauseBtn.classList.remove('toggled'); setState('recording', '录制中');
  }
}
function toggleMic() {
  if (!rec?.micGainNode) return;
  const muted = ui.micBtn.classList.toggle('toggled');
  rec.micGainNode.gain.setTargetAtTime(muted ? 0 : ui.micGain.value / 100, rec.ctx.currentTime, 0.02);
  toast(muted ? '麦克风已静音' : '麦克风已开启');
  window.desktop?.setRecState(ui.stage.dataset.state, ui.timer.textContent, deskExtra());
}

function stopRecording() {
  if (!rec || rec.ended) return;
  rec.ended = true;
  if (rec.pausedAt) { rec.pausedTotal += performance.now() - rec.pausedAt; rec.pausedAt = 0; }
  rec.duration = elapsed();
  ui.stopBtn.disabled = ui.pauseBtn.disabled = ui.micBtn.disabled = true;
  if (rec.mr && rec.mr.state !== 'inactive') { setState('saving', '保存中'); rec.mr.stop(); }
  else { // 还在倒计时就停了：丢弃
    const s = rec.session; cleanup(); setState('idle', '待机');
    if (s) api(`/api/sessions/${s.id}/finish`, { method: 'POST', body: '{}' }).then(() => api(`/api/recordings/${encodeURIComponent(s.file)}`, { method: 'DELETE' })).catch(() => {});
  }
}

async function pump() {
  if (!rec || rec.uploading) return;
  rec.uploading = true;
  const r = rec;
  while (r.queue.length) {
    const blob = r.queue[0];
    let delay = 1000;
    for (;;) {
      try {
        const res = await fetch(`/api/sessions/${r.session.id}/chunks/${r.seq}`, { method: 'PUT', body: blob });
        if (res.ok) break;
        if (res.status === 409) { const j = await res.json(); r.seq = j.expected; continue; }
        throw new Error(res.status);
      } catch {
        r.failed = true; updateSync();
        await sleep(delay); delay = Math.min(delay * 2, 10000);
      }
    }
    r.failed = false; r.queue.shift(); r.seq++; r.sent += blob.size; updateSync();
  }
  r.uploading = false;
  if (r.onDrained) r.onDrained();
}
function updateSync() {
  if (!rec) { ui.sync.className = 'sync'; ui.syncText.textContent = '—'; return; }
  const pending = rec.queue.length;
  ui.sync.className = 'sync ' + (rec.failed ? 'warn' : 'ok');
  ui.syncText.textContent = rec.failed ? `网络中断，待重传 ${pending} 段` : fmtSize(rec.sent) + (pending > 1 ? ` · 队列 ${pending}` : '');
}

async function finish() {
  const r = rec;
  if (r.queue.length || r.uploading) await new Promise(ok => { r.onDrained = ok; pump(); });
  try {
    await api(`/api/sessions/${r.session.id}/finish`, { method: 'POST', body: JSON.stringify({ duration: Math.round(r.duration) }) });
    toast(window.desktop ? '已保存' : '已保存到 NAS');
  } catch (e) { toast('保存失败：' + e.message, true); }
  cleanup(); setState('idle', '待机'); ui.title.value = '';
  loadLibrary();
}

function cleanup() {
  if (!rec) return;
  clearInterval(rec.timerId);
  rec.stops.forEach(f => f());
  rec.display.getTracks().forEach(t => t.stop());
  rec.mic?.getTracks().forEach(t => t.stop());
  rec.ctx.close().catch(() => {});
  ui.preview.srcObject = null;
  rec = null;
  ui.timer.textContent = '00:00:00';
  updateSync();
  startMicPreview();
}

// ---------- 录像库 ----------
let items = [];
async function loadLibrary() {
  try {
    const j = await api('/api/recordings');
    items = j.items;
    ui.pill.className = 'pill ok'; ui.pill.lastElementChild.textContent = window.desktop ? '就绪' : 'NAS 已连接';
    if (!window.desktop && (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia)) {
      const url = `https://${location.hostname}:${j.httpsPort}`;
      ui.banner.hidden = false;
      ui.banner.innerHTML = window.isSecureContext
        ? '当前浏览器不支持屏幕录制，请使用桌面版 Chrome 或 Edge。'
        : `浏览器只允许在 HTTPS 下录屏。请改用 <a href="${url}">${url}</a> 打开（首次会提示证书不受信任，点「高级 → 继续访问」即可）。`;
      ui.startBtn.disabled = true;
    }
    renderLibrary();
  } catch (e) {
    ui.pill.className = 'pill err'; ui.pill.lastElementChild.textContent = '无法连接 NAS';
  }
}
const ICON = {
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};
function renderLibrary() {
  const q = ui.search.value.trim().toLowerCase();
  const list = items.filter(i => !q || i.title.toLowerCase().includes(q));
  ui.libCount.textContent = items.length || '';
  ui.libEmpty.hidden = items.length > 0;
  ui.grid.innerHTML = list.map(i => {
    const src = `/media/${encodeURIComponent(i.file)}`;
    const media = i.thumb ? `<img src="${i.thumb}" loading="lazy" alt="">` : `<video src="${src}#t=0.5" preload="metadata" muted></video>`;
    return `<article class="card" data-file="${esc(i.file)}">
      <div class="thumb" data-act="play">${media}
        ${i.recording ? '<span class="live">REC</span>' : ''}
        ${i.duration ? `<span class="dur">${fmtDur(i.duration)}</span>` : ''}
        <span class="play">${ICON.play}</span>
      </div>
      <div class="card-body">
        <div class="card-info">
          <div class="card-title" title="${esc(i.title)}">${esc(i.title)}</div>
          <div class="card-meta">${fmtDate(i.createdAt)} · ${fmtSize(i.size)}${i.width ? ` · ${i.height}p` : ''}</div>
        </div>
        <div class="card-acts">
          <a href="${src}?download" title="下载" download>${ICON.dl}</a>
          ${window.desktop ? `<button data-act="reveal" title="在文件夹中显示">${ICON.folder}</button>` : ''}
          <button data-act="rename" title="重命名">${ICON.edit}</button>
          <button data-act="del" class="danger" title="删除">${ICON.del}</button>
        </div>
      </div>
    </article>`;
  }).join('');
}
ui.grid.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const file = btn.closest('.card').dataset.file;
  const item = items.find(i => i.file === file);
  const act = btn.dataset.act;
  if (act === 'play') openPlayer(item);
  if (act === 'reveal') window.desktop?.showFile(file);
  if (act === 'rename') {
    const t = prompt('新标题', item.title);
    if (t && t.trim()) { await api(`/api/recordings/${encodeURIComponent(file)}`, { method: 'PATCH', body: JSON.stringify({ title: t }) }); loadLibrary(); }
  }
  if (act === 'del' && confirm(`删除「${item.title}」？\n文件会从 NAS 上移除，无法恢复。`)) {
    await api(`/api/recordings/${encodeURIComponent(file)}`, { method: 'DELETE' }); toast('已删除'); loadLibrary();
  }
});

let playing = null;
function openPlayer(item) {
  playing = item;
  const src = `/media/${encodeURIComponent(item.file)}`;
  ui.playerTitle.value = item.title;
  ui.playerDl.href = src + '?download';
  ui.playerVideo.src = src;
  ui.player.showModal();
  ui.playerVideo.play().catch(() => {});
}
ui.player.addEventListener('close', () => { ui.playerVideo.pause(); ui.playerVideo.removeAttribute('src'); ui.playerVideo.load(); });
$('#playerClose').onclick = () => ui.player.close();
ui.player.addEventListener('click', e => { if (e.target === ui.player) ui.player.close(); });
$('#playerCopy').onclick = async () => {
  const url = location.origin + `/media/${encodeURIComponent(playing.file)}`;
  try { await navigator.clipboard.writeText(url); toast('链接已复制'); } catch { prompt('复制链接', url); }
};
ui.playerTitle.addEventListener('change', async () => {
  if (!ui.playerTitle.value.trim()) return;
  await api(`/api/recordings/${encodeURIComponent(playing.file)}`, { method: 'PATCH', body: JSON.stringify({ title: ui.playerTitle.value }) });
  toast('已重命名'); loadLibrary();
});

// ---------- 绑定 ----------
ui.startBtn.onclick = startRecording;
ui.stopBtn.onclick = stopRecording;
ui.pauseBtn.onclick = togglePause;
ui.micBtn.onclick = toggleMic;
ui.search.oninput = renderLibrary;
ui.micOn.onchange = () => { ui.micDetail.hidden = !ui.micOn.checked; savePrefs(); startMicPreview(); };
ui.micSelect.onchange = () => { savePrefs(); startMicPreview(); };
ui.micGain.oninput = () => {
  ui.micGainVal.textContent = ui.micGain.value + '%';
  if (micPreview) micPreview.g.gain.value = ui.micGain.value / 100;
  if (rec?.micGainNode && !ui.micBtn.classList.contains('toggled')) rec.micGainNode.gain.value = ui.micGain.value / 100;
};
ui.micGain.onchange = savePrefs;
for (const k of ['quality', 'fps', 'format', 'sysAudio', 'countOn']) ui[k].onchange = savePrefs;
navigator.mediaDevices?.addEventListener?.('devicechange', listMics);
window.addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });

loadPrefs();
if (!supported.some(f => f.ext === ui.format.value) && supported[0]) ui.format.value = supported[0].ext;
ui.micDetail.hidden = !ui.micOn.checked;
ui.micGainVal.textContent = ui.micGain.value + '%';
setState('idle', '待机');
if (window.desktop) initDesktop();
loadLibrary();
setInterval(() => { if (!rec) loadLibrary(); }, 15000);
// 麦克风预览需要用户手势后的 AudioContext；首次点击页面时启动
document.addEventListener('pointerdown', function once() { document.removeEventListener('pointerdown', once); startMicPreview(); });

// ---------- 桌面版（Electron） ----------
async function initDesktop() {
  const d = window.desktop;
  document.body.classList.add('is-desktop');
  const cfg = await d.getConfig();
  $('#deskSettings').hidden = false;
  $('.brand-sub').textContent = '桌面版 · v' + cfg.version;
  const dirPath = $('#dirPath'), minOn = $('#minOn');
  const showDir = p => { dirPath.textContent = p.length > 30 ? '…' + p.slice(-29) : p; dirPath.title = p + '\n点击打开文件夹'; };
  showDir(cfg.saveDir);
  minOn.checked = cfg.minimizeOnRecord;
  minOn.onchange = () => d.setConfig({ minimizeOnRecord: minOn.checked });
  const capMode = $('#capMode'), barOn = $('#barOn');
  capMode.value = cfg.captureMode || 'ask';
  barOn.checked = cfg.floatingBar !== false;
  $('#title').closest('.field').after(capMode.closest('.field'));
  const capHint = () => {
    $('#capHint').textContent = { ask: '每次弹出选择框', window: '自动录你最后使用的窗口（例如浏览器）', screen: '自动录鼠标所在的屏幕' }[capMode.value];
    $('.stage-hint').innerHTML = {
      ask: '点击后选择要录制的 <b>屏幕</b> 或 <b>窗口</b>，也可以按 <b>Ctrl + Shift + R</b>',
      window: '会自动录制你 <b>最后使用的窗口</b>。在浏览器里按 <b>Ctrl + Shift + R</b> 最方便',
      screen: '会自动录制 <b>鼠标所在的屏幕</b>，也可以按 <b>Ctrl + Shift + R</b>',
    }[capMode.value];
  };
  capHint();
  capMode.onchange = () => { capHint(); d.setConfig({ captureMode: capMode.value }); };
  barOn.onchange = () => d.setConfig({ floatingBar: barOn.checked });
  d.onSourceChosen((name, type) => toast(type === 'screen' ? '录制整个屏幕' : '录制窗口：' + (name.length > 28 ? name.slice(0, 28) + '…' : name)));
  dirPath.onclick = () => d.openDir();
  $('#dirChange').onclick = async () => { const p = await d.chooseDir(); if (p) { showDir(p); toast('保存位置已更改'); loadLibrary(); } };
  $('#sysNote').textContent = d.platform === 'win32'
    ? '系统声音会录下电脑正在播放的所有声音。录网页教程时建议关掉音乐等其他声音。'
    : 'macOS 上桌面版暂不支持录制系统声音。';

  // 录制源选择器
  const picker = $('#picker'), grid = $('#pickerGrid'), okBtn = $('#pickerOk');
  let sources = [], type = 'screen', chosen = null, resolveFn = null;
  const render = () => {
    const list = sources.filter(s => s.type === type);
    grid.innerHTML = list.length ? list.map(s => `
      <button class="src${s.id === chosen ? ' on' : ''}" data-id="${esc(s.id)}">
        <img class="shot" src="${s.thumb}" alt="">
        <div class="src-name">${s.appIcon ? `<img src="${s.appIcon}" alt="">` : ''}<span>${esc(s.name)}</span></div>
      </button>`).join('') : '<div class="picker-empty">没有可录制的' + (type === 'screen' ? '屏幕' : '窗口') + '</div>';
    okBtn.disabled = !chosen;
    for (const b of $('#pickerTabs').children) b.classList.toggle('on', b.dataset.type === type);
  };
  const done = v => { if (!resolveFn) return; const f = resolveFn; resolveFn = null; picker.close(); f(v); };
  $('#pickerTabs').onclick = e => { const b = e.target.closest('button'); if (b) { type = b.dataset.type; render(); } };
  grid.onclick = e => { const b = e.target.closest('.src'); if (b) { chosen = b.dataset.id; render(); } };
  grid.ondblclick = e => { const b = e.target.closest('.src'); if (b) done(b.dataset.id); };
  okBtn.onclick = () => done(chosen);
  $('#pickerCancel').onclick = $('#pickerClose').onclick = () => done(null);
  picker.addEventListener('cancel', e => { e.preventDefault(); done(null); });
  d.onPickSource(list => new Promise(resolve => {
    sources = list; type = 'screen';
    const screens = list.filter(s => s.type === 'screen');
    chosen = screens.length === 1 ? screens[0].id : null;
    $('#pickerNote').textContent = ui.sysAudio.checked && d.platform === 'win32' ? '系统声音会一起录制（可在右侧设置里关闭）' : '本次不录制系统声音';
    resolveFn = resolve; render(); picker.showModal();
  }));

  // 全局快捷键 / 任务栏按钮
  d.onHotkey(k => {
    if (k === 'toggle') { if (!rec) startRecording(); else stopRecording(); }
    if (k === 'pause') togglePause();
    if (k === 'mic') toggleMic();
  });
}
