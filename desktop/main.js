// NAS Recorder 桌面版（Electron 主进程）
// 内置 server.js 只监听 127.0.0.1，窗口加载 http://127.0.0.1:<port>（localhost 属于安全上下文，可直接录屏）
'use strict';
const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog, shell, globalShortcut, nativeImage, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ffmpeg-static 打包后位于 app.asar.unpacked
try {
  const ff = require('ffmpeg-static');
  if (ff) process.env.FFMPEG_PATH = ff.replace('app.asar', 'app.asar.unpacked');
} catch {}

const server = require('../server.js');

if (!app.requestSingleInstanceLock()) app.quit();

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const config = Object.assign(
  { saveDir: path.join(app.getPath('videos'), 'NAS Recorder'), minimizeOnRecord: true, captureMode: 'ask', floatingBar: true },
  (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } })(),
);
const saveConfig = () => { try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch {} };

let win = null;
let recState = 'idle';
const icon = name => nativeImage.createFromPath(path.join(__dirname, 'icons', name));

function applySaveDir(dir) {
  try { server.setDataDir(dir); return true; }
  catch (e) { dialog.showErrorBox('无法使用这个文件夹', `${dir}\n\n${e.message}`); return false; }
}

async function createWindow() {
  if (!applySaveDir(config.saveDir)) { config.saveDir = path.join(app.getPath('videos'), 'NAS Recorder'); applySaveDir(config.saveDir); saveConfig(); }
  const port = await server.startLocal(0);

  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 680,
    backgroundColor: '#0c0d0f', title: 'NAS Recorder', show: false,
    icon: path.join(__dirname, 'icons', 'app.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${port}/`);

  // 权限白名单：只允许本软件自己的页面使用 麦克风/屏幕录制/复制链接，其它一律拒绝
  const appOrigin = `http://127.0.0.1:${port}`;
  const ALLOWED = new Set(['media', 'display-capture', 'clipboard-sanitized-write']);
  const okOrigin = u => { try { return new URL(u).origin === appOrigin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(ALLOWED.has(perm) && okOrigin(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => ALLOWED.has(perm) && okOrigin(origin));

  // 不允许跳转到外部页面；外部链接交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => { if (!okOrigin(url)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });

  // 录制中关闭窗口要确认
  win.on('close', e => {
    if (recState === 'idle' || recState === 'countdown') return;
    const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['继续录制', '仍然退出'], defaultId: 0, cancelId: 0, message: '正在录制，退出会丢失最后几秒。', detail: '建议先点「结束并保存」。' });
    if (r === 0) e.preventDefault();
  });

  // getDisplayMedia → 弹出应用内的屏幕/窗口选择器
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const opts = { types: ['screen', 'window'], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true };
      let sources = await desktopCapturer.getSources(opts);
      // 偶发返回空列表（显卡驱动刚初始化等），稍等重试一次
      if (!sources.some(s => s.id.startsWith('screen'))) { await new Promise(r => setTimeout(r, 600)); sources = await desktopCapturer.getSources(opts); }
      const isOwn = s => s.name.startsWith('NAS Recorder');
      let chosen = null;
      if (config.captureMode === 'window') {
        // Windows 按 Z 序返回窗口：排除本软件后的第一个，就是你刚才在用的窗口
        chosen = sources.find(s => s.id.startsWith('window') && s.name.trim() && !isOwn(s));
      } else if (config.captureMode === 'screen') {
        const cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        chosen = sources.find(s => s.id.startsWith('screen') && s.display_id === String(cur.id)) || sources.find(s => s.id.startsWith('screen'));
      }
      if (chosen) {
        send('source-chosen', chosen.name, chosen.id.startsWith('screen') ? 'screen' : 'window');
      } else {
        const list = sources
          .filter(s => !isOwn(s))
          .map(s => ({ id: s.id, name: s.name, type: s.id.startsWith('screen') ? 'screen' : 'window', thumb: s.thumbnail.toDataURL(), appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }));
        if (win.isMinimized()) win.restore();
        win.focus();
        const id = await askRenderer('pick-source', list);
        chosen = sources.find(s => s.id === id);
        if (!chosen) return callback({});
      }
      captureDisplay = displayFor(chosen);
      // Windows 支持 loopback：录下整个系统的声音
      callback(request.audioRequested && process.platform === 'win32' ? { video: chosen, audio: 'loopback' } : { video: chosen });
      if (config.minimizeOnRecord) setTimeout(() => win && !win.isDestroyed() && win.minimize(), 150);
    } catch (e) {
      console.error(e); callback({});
    }
  });

  updateThumbar();
}

// 主进程 → 渲染进程请求，等待回复
let reqSeq = 0;
function askRenderer(channel, payload) {
  const id = ++reqSeq;
  return new Promise(resolve => {
    const onReply = (_e, rid, value) => { if (rid !== id) return; ipcMain.removeListener(channel + ':reply', onReply); resolve(value); };
    ipcMain.on(channel + ':reply', onReply);
    win.webContents.send(channel, id, payload);
  });
}

// 任务栏缩略图按钮（鼠标悬停任务栏图标时出现）+ 标题显示计时
function updateThumbar(elapsedText = '') {
  if (!win || win.isDestroyed()) return;
  const recording = recState === 'recording' || recState === 'paused';
  win.setTitle(recording ? `${recState === 'paused' ? '❚❚ 已暂停' : '● 录制中'} ${elapsedText} — NAS Recorder` : 'NAS Recorder');
  if (process.platform !== 'win32') return;
  try {
    win.setThumbarButtons(recording ? [
      { tooltip: recState === 'paused' ? '继续 (Ctrl+Shift+P)' : '暂停 (Ctrl+Shift+P)', icon: icon(recState === 'paused' ? 'thumb-play.png' : 'thumb-pause.png'), click: () => send('hotkey', 'pause') },
      { tooltip: '结束并保存 (Ctrl+Shift+R)', icon: icon('thumb-stop.png'), click: () => send('hotkey', 'toggle') },
    ] : []);
    win.setOverlayIcon(recording ? icon('overlay-rec.png') : null, recording ? '录制中' : '');
  } catch {}
}
const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);

// ---------- IPC ----------
ipcMain.handle('config:get', () => ({ ...config, ffmpeg: server.hasFfmpeg, version: app.getVersion() }));
ipcMain.handle('config:set', (_e, patch) => {
  if ('minimizeOnRecord' in patch) config.minimizeOnRecord = !!patch.minimizeOnRecord;
  if ('floatingBar' in patch) config.floatingBar = !!patch.floatingBar;
  if (['ask', 'window', 'screen'].includes(patch.captureMode)) config.captureMode = patch.captureMode;
  saveConfig();
  return config;
});
ipcMain.handle('dir:choose', async () => {
  if (server.isBusy()) { dialog.showErrorBox('正在录制', '录制结束后再更改保存位置。'); return null; }
  const r = await dialog.showOpenDialog(win, { title: '选择录像保存位置（可以选 NAS 的网络共享文件夹）', defaultPath: config.saveDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  if (!applySaveDir(r.filePaths[0])) return null;
  config.saveDir = r.filePaths[0]; saveConfig();
  return config.saveDir;
});
ipcMain.handle('dir:open', () => shell.openPath(config.saveDir));
ipcMain.handle('file:show', (_e, file) => {
  if (typeof file !== 'string' || /[\\/]/.test(file)) return;
  shell.showItemInFolder(path.join(config.saveDir, file));
});
ipcMain.on('rec:state', (_e, state, elapsedText, extra) => {
  const changed = state !== recState;
  recState = state;
  if (changed && state === 'idle' && win && win.isMinimized()) { win.restore(); win.focus(); }
  updateThumbar(elapsedText);
  updateBar(state, elapsedText, extra || {});
});
// 悬浮条上的按钮 → 交给主界面执行
ipcMain.on('bar:action', (_e, action) => {
  if (action === 'open') { if (win) { win.restore(); win.focus(); } return; }
  if (['toggle', 'pause', 'mic'].includes(action)) send('hotkey', action);
});

// ---------- 右下角悬浮控制条 ----------
let bar = null, captureDisplay = null;
const BAR_W = 304, BAR_H = 60, MARGIN = 20;
function displayFor(src) {
  if (src && src.display_id) { const d = screen.getAllDisplays().find(x => String(x.id) === src.display_id); if (d) return d; }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function ensureBar() {
  if (bar && !bar.isDestroyed()) return bar;
  bar = new BrowserWindow({
    width: BAR_W, height: BAR_H, frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false, hasShadow: false,
    title: 'NAS Recorder Bar', backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'bar-preload.js'), contextIsolation: true, sandbox: true },
  });
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true);
  // 不被录进视频（Windows 10 2004+ 会从画面里完全剔除）
  bar.setContentProtection(true);
  bar.loadFile(path.join(__dirname, 'bar.html'));
  bar.on('closed', () => { bar = null; });
  return bar;
}
function placeBar() {
  const wa = (captureDisplay || screen.getPrimaryDisplay()).workArea;
  bar.setBounds({ x: Math.round(wa.x + wa.width - BAR_W - MARGIN), y: Math.round(wa.y + wa.height - BAR_H - MARGIN), width: BAR_W, height: BAR_H });
}
function updateBar(state, text, extra) {
  const active = ['countdown', 'recording', 'paused', 'saving'].includes(state);
  if (!config.floatingBar || !active) {
    if (bar && !bar.isDestroyed() && bar.isVisible()) { bar.hide(); bar.webContents.send('bar:state', { state: 'idle' }); }
    if (state === 'idle') captureDisplay = null;
    return;
  }
  const b = ensureBar();
  const push = () => b.webContents.send('bar:state', { state, text, ...extra });
  if (!b.isVisible()) {
    placeBar();
    if (b.webContents.isLoading()) b.webContents.once('did-finish-load', () => { push(); b.showInactive(); });
    else { push(); b.showInactive(); }
  } else push();
}

// ---------- 生命周期 ----------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  await createWindow();
  // 全局快捷键：窗口最小化时也能控制
  globalShortcut.register('CommandOrControl+Shift+R', () => send('hotkey', 'toggle'));
  globalShortcut.register('CommandOrControl+Shift+P', () => send('hotkey', 'pause'));
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
