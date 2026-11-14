// NAS Recorder — 零依赖 Node.js 服务
// 静态页面 + 分片上传 + 录像库 + Range 播放 + 自签 HTTPS
// 既能 `node server.js` 独立运行（NAS / Docker），也被桌面版 desktop/main.js 当模块引入
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

let DATA_DIR = path.resolve(process.env.DATA_DIR || './recordings');
const CERT_DIR = path.resolve(process.env.CERT_DIR || path.join(DATA_DIR, '.certs'));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const HTTP_PORT = +process.env.HTTP_PORT || 8080;
const HTTPS_PORT = +process.env.HTTPS_PORT || 8443;
const PASSWORD = process.env.PASSWORD || '';
const CERT_HOSTS = (process.env.CERT_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CHUNK = 256 * 1024 * 1024;

const hasFfmpeg = (() => { try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg',
};
const VIDEO_EXT = new Set(['.mp4', '.webm']);

// 进行中的录制：id -> { file, ext, nextSeq, name }
const sessions = new Map();

// ---------- 工具 ----------
const send = (res, code, body, headers = {}) => {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const isSafeFile = f => f && !f.includes('/') && !f.includes('\\') && !f.startsWith('.') && VIDEO_EXT.has(path.extname(f).toLowerCase());
const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const metaPath = file => path.join(DATA_DIR, '.meta', file + '.json');
async function readMeta(file) { try { return JSON.parse(await fsp.readFile(metaPath(file), 'utf8')); } catch { return {}; } }
async function writeMeta(file, m) { await fsp.mkdir(path.join(DATA_DIR, '.meta'), { recursive: true }); await fsp.writeFile(metaPath(file), JSON.stringify(m)); }
async function readJson(req, limit = 64 * 1024) {
  let size = 0; const bufs = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); bufs.push(c); }
  return bufs.length ? JSON.parse(Buffer.concat(bufs).toString('utf8')) : {};
}
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { maxBuffer: 1 << 20 }, (e, so, se) => e ? fail(new Error(se || e.message)) : ok(so)));

// 录完后用 ffmpeg 无损 remux：补全时长/索引，让进度条可拖动；同时抽一帧封面
async function finalize(file, durationMs) {
  const full = path.join(DATA_DIR, file);
  if (hasFfmpeg) {
    const ext = path.extname(file);
    const tmp = path.join(DATA_DIR, '.tmp_' + file);
    try {
      const args = ['-y', '-v', 'error', '-i', full, '-c', 'copy'];
      if (ext === '.mp4') args.push('-movflags', '+faststart');
      args.push(tmp);
      await run(FFMPEG, args);
      await fsp.rename(tmp, full);
    } catch (e) { console.warn('[remux] 跳过:', e.message.trim()); fsp.rm(tmp, { force: true }).catch(() => {}); }
    try {
      await fsp.mkdir(path.join(DATA_DIR, '.thumbs'), { recursive: true });
      const at = Math.min(1, Math.max(0, (durationMs || 0) / 2000)).toFixed(2);
      await run(FFMPEG, ['-y', '-v', 'error', '-ss', at, '-i', full, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(DATA_DIR, '.thumbs', file + '.jpg')]);
    } catch (e) { console.warn('[thumb] 跳过:', e.message.trim()); }
  }
}

// ---------- 自签证书 ----------
function ensureCert() {
  const key = path.join(CERT_DIR, 'key.pem'), crt = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(key) && fs.existsSync(crt)) return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const ips = ['127.0.0.1'], dns = ['localhost'];
  for (const h of CERT_HOSTS) (/^[\d.]+$|:/.test(h) ? ips : dns).push(h);
  for (const list of Object.values(require('os').networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  const san = [...new Set(dns)].map(d => 'DNS:' + d).concat([...new Set(ips)].map(i => 'IP:' + i)).join(',');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', key, '-out', crt, '-subj', '/CN=NAS Recorder', '-addext', 'subjectAltName=' + san], { stdio: 'ignore' });
    console.log('[https] 已生成自签证书，SAN =', san);
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  } catch (e) { console.warn('[https] 生成证书失败，仅启用 HTTP:', e.message); return null; }
}

// ---------- 路由 ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (PASSWORD) {
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return send(res, 401, '需要登录', { 'WWW-Authenticate': 'Basic realm="NAS Recorder", charset="UTF-8"' });
  }

  try {
    // 列表
    if (req.method === 'GET' && p === '/api/recordings') {
      const files = (await fsp.readdir(DATA_DIR)).filter(isSafeFile);
      const busy = new Set([...sessions.values()].map(s => s.file));
      const items = await Promise.all(files.map(async f => {
        const st = await fsp.stat(path.join(DATA_DIR, f));
        const m = await readMeta(f);
        return {
          file: f, title: m.title || f.replace(/\.[^.]+$/, ''), size: st.size, createdAt: m.createdAt || st.mtimeMs,
          duration: m.duration || 0, width: m.width, height: m.height, recording: busy.has(f),
          thumb: fs.existsSync(path.join(DATA_DIR, '.thumbs', f + '.jpg')) ? `/thumbs/${encodeURIComponent(f)}.jpg` : null,
        };
      }));
      items.sort((a, b) => b.createdAt - a.createdAt);
      return send(res, 200, { items, ffmpeg: hasFfmpeg, httpsPort: +process.env.PUBLIC_HTTPS_PORT || HTTPS_PORT });
    }

    // 新建录制
    if (req.method === 'POST' && p === '/api/recordings') {
      const body = await readJson(req);
      const ext = body.ext === 'mp4' ? '.mp4' : '.webm';
      const title = safeName(body.title) || '录屏';
      let file = `${stamp()}_${title}${ext}`;
      for (let i = 2; fs.existsSync(path.join(DATA_DIR, file)); i++) file = `${stamp()}_${title}-${i}${ext}`;
      await fsp.writeFile(path.join(DATA_DIR, file), '');
      const id = crypto.randomUUID();
      sessions.set(id, { file, nextSeq: 0, title, touched: Date.now() });
      await writeMeta(file, { title, createdAt: Date.now(), width: body.width, height: body.height, mime: body.mime });
      return send(res, 201, { id, file });
    }

    let m;
    // 追加分片（按 seq 顺序；重复的 seq 直接视为成功，便于客户端重试）
    if (req.method === 'PUT' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/chunks\/(\d+)$/))) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { error: 'session not found' });
      const seq = +m[2];
      if (seq < s.nextSeq) { req.resume(); return send(res, 200, { ok: true, dup: true }); }
      if (seq > s.nextSeq) { req.resume(); return send(res, 409, { error: 'out of order', expected: s.nextSeq }); }
      const bufs = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > MAX_CHUNK) return send(res, 413, { error: 'chunk too large' }); bufs.push(c); }
      await fsp.appendFile(path.join(DATA_DIR, s.file), Buffer.concat(bufs));
      s.nextSeq++; s.touched = Date.now();
      return send(res, 200, { ok: true, next: s.nextSeq });
    }

    // 客户端上传封面（没有 ffmpeg 时也有封面；有 ffmpeg 时结束后会被更清晰的覆盖）
    if (req.method === 'PUT' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/thumb$/))) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { error: 'session not found' });
      const bufs = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 4 << 20) return send(res, 413, { error: 'too large' }); bufs.push(c); }
      await fsp.mkdir(path.join(DATA_DIR, '.thumbs'), { recursive: true });
      await fsp.writeFile(path.join(DATA_DIR, '.thumbs', s.file + '.jpg'), Buffer.concat(bufs));
      return send(res, 200, { ok: true });
    }

    // 结束录制
    if (req.method === 'POST' && (m = p.match(/^\/api\/sessions\/([\w-]+)\/finish$/))) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { error: 'session not found' });
      const body = await readJson(req);
      sessions.delete(m[1]);
      const meta = await readMeta(s.file);
      meta.duration = +body.duration || 0;
      await writeMeta(s.file, meta);
      await finalize(s.file, meta.duration);
      return send(res, 200, { ok: true, file: s.file });
    }

    // 重命名 / 删除
    if ((m = p.match(/^\/api\/recordings\/([^/]+)$/)) && isSafeFile(m[1])) {
      const file = m[1], full = path.join(DATA_DIR, file);
      if (!fs.existsSync(full)) return send(res, 404, { error: 'not found' });
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const meta = await readMeta(file); meta.title = safeName(body.title) || meta.title; await writeMeta(file, meta);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await fsp.rm(full, { force: true });
        await fsp.rm(metaPath(file), { force: true });
        await fsp.rm(path.join(DATA_DIR, '.thumbs', file + '.jpg'), { force: true });
        return send(res, 200, { ok: true });
      }
    }

    // 视频（支持 Range，可拖动播放）
    if (req.method === 'GET' && (m = p.match(/^\/media\/([^/]+)$/)) && isSafeFile(m[1])) {
      return serveFile(req, res, path.join(DATA_DIR, m[1]), url.searchParams.has('download') ? m[1] : null);
    }
    if (req.method === 'GET' && (m = p.match(/^\/thumbs\/([^/]+\.jpg)$/)) && isSafeFile(m[1].slice(0, -4))) {
      return serveFile(req, res, path.join(DATA_DIR, '.thumbs', m[1]));
    }

    // 静态资源
    if (req.method === 'GET') {
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const full = path.join(PUBLIC_DIR, rel);
      if (full.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) return serveFile(req, res, full);
    }
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
}

async function serveFile(req, res, full, downloadName) {
  let st; try { st = await fsp.stat(full); } catch { return send(res, 404, 'Not found'); }
  const headers = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (full.startsWith(PUBLIC_DIR)) headers['Cache-Control'] = 'no-cache';
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && st.size) {
    let start = range[1] ? +range[1] : st.size - +range[2];
    let end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (start >= st.size || start > end) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(full).pipe(res);
}

// 清理 6 小时无动静的会话（浏览器崩溃等），已写入的部分照样保留可播放
setInterval(() => {
  for (const [id, s] of sessions) if (Date.now() - s.touched > 6 * 3600e3) { sessions.delete(id); finalize(s.file); }
}, 600e3).unref();

function setDataDir(dir) {
  DATA_DIR = path.resolve(dir);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const getDataDir = () => DATA_DIR;
const isBusy = () => sessions.size > 0;

// 只监听本机（桌面版用），port=0 表示随机空闲端口
function startLocal(port = 0) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return new Promise((ok, fail) => {
    const srv = http.createServer(handle);
    srv.once('error', fail);
    srv.listen(port, '127.0.0.1', () => ok(srv.address().port));
  });
}

module.exports = { startLocal, setDataDir, getDataDir, isBusy, hasFfmpeg };

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  http.createServer(handle).listen(HTTP_PORT, () => console.log(`[http]  http://0.0.0.0:${HTTP_PORT}`));
  const tls = ensureCert();
  if (tls) https.createServer(tls, handle).listen(HTTPS_PORT, () => console.log(`[https] https://0.0.0.0:${HTTPS_PORT}  (录屏请用这个地址)`));
  console.log(`[data]  ${DATA_DIR}  ffmpeg=${hasFfmpeg ? 'yes' : 'no'}`);
}
