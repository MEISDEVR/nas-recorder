<p align="center"><img src="build/icon.png" width="96" alt=""></p>
<h1 align="center">NAS Recorder</h1>
<p align="center">录屏幕、系统声音和麦克风解说，录完直接保存到本机或 NAS。<br>专为录「网站操作教程」设计：开箱即用，界面干净，文件拿去就能剪。</p>


## 两种用法

| | 桌面版（Windows） | 网页版（NAS / Docker） |
|---|---|---|
| 安装 | 下载安装包，双击安装 | 在 NAS 上 `docker compose up -d` |
| 打开 | 开始菜单里的 NAS Recorder | 浏览器打开 `https://NAS的IP:8443` |
| 保存位置 | 本机任意文件夹，**也可以选 NAS 的共享文件夹** | NAS 上映射的目录 |
| 系统声音 | 整个系统的声音 | 取决于浏览器（Chrome / Edge） |

## 下载

到 [Releases](../../releases) 下载最新版：

- `NAS-Recorder-x.y.z-x64-nsis.exe`：安装版
- `NAS-Recorder-x.y.z-portable.exe`：绿色版，不用安装，双击就能运行

> 安装包没有做代码签名，第一次运行时 Windows 可能提示「已保护你的电脑」，点「更多信息 → 仍要运行」即可。

## 功能

- 录屏幕或单个窗口，支持 720p / 1080p / 1440p / 原始分辨率，30 / 60 fps
- 系统声音和麦克风混成一条音轨，可以单独调麦克风音量，录制中随时静音
- MP4（H.264）或 WebM 格式，剪映、Premiere、Final Cut 都能直接导入
- 录制对象可设为「自动：当前窗口」或「自动：整个屏幕」，不用每次手动选择
- 录制时屏幕右下角出现悬浮控制条（计时、静音、暂停、停止），它本身不会被录进视频（Windows 10 2004 及以上）
- 3 秒倒计时，暂停 / 继续，开始录制时自动最小化窗口
- 全局快捷键：`Ctrl+Shift+R` 开始 / 结束，`Ctrl+Shift+P` 暂停 / 继续
- 任务栏缩略图上带暂停和停止按钮
- 边录边写入磁盘（每 2 秒一段），程序意外退出也只丢最后几秒
- 录像库：封面、时长、搜索、播放、重命名、删除、在文件夹中显示
- 内置 ffmpeg：录完自动整理文件索引，保证进度条可以拖动

## 网页版部署（NAS / Docker）

见 [docs/nas-deploy.md](docs/nas-deploy.md)，内含通用 Docker 和铁威马 TOS 的步骤。

## 开发

```bash
npm install
npm start          # 运行桌面版
npm run server     # 只运行网页版服务（http://localhost:8080）
npm run dist       # 打包 Windows 安装包到 dist/（需要在 Windows 上执行）
```

项目结构：

```
server.js          零依赖 Node 服务：分片写入、录像库、Range 播放、自签 HTTPS
public/            界面（桌面版和网页版共用）
desktop/           Electron 主进程、preload、任务栏图标
build/             应用图标
.github/workflows/ 推送 v* 标签时自动在 Windows 上打包并发布 Release
```

发新版本：改 `package.json` 里的 `version`，然后

```bash
git tag v1.0.1 && git push origin v1.0.1
```

GitHub Actions 会自动构建安装包，并发布到 Releases。

## 许可证

[MIT](LICENSE)。桌面版附带的 ffmpeg 来自 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)，它遵循 GPL 许可证。
