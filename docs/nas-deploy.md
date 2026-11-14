# NAS / Docker 网页版部署

部署在 NAS 上的网页录屏工具。电脑浏览器打开就能录 **屏幕 + 系统声音 + 麦克风解说**，边录边写进 NAS 文件夹，录完在页面里直接回看、下载、改名。

- 录制格式：MP4（H.264，剪映 / Premiere / Final Cut 直接能用）或 WebM
- 每 2 秒上传一段，浏览器崩了最多丢最后几秒；网络断了会自动重传
- 录完由容器里的 ffmpeg 无损整理一遍（修正时长、可拖进度条、生成封面），不转码，NAS 不吃 CPU

## 1. 部署（通用 Docker）

把整个 `nas-recorder` 文件夹拷到 NAS，例如 `/volume1/docker/nas-recorder`，然后在该目录下：

```bash
docker compose up -d --build
```

`docker-compose.yml` 里要改的只有一处：

```yaml
volumes:
  - /volume1/教程录屏:/recordings   # 左边换成你想存视频的 NAS 共享文件夹
```

可选项：

| 环境变量 | 作用 |
|---|---|
| `PASSWORD` | 设置后访问需要登录（用户名随便填） |
| `CERT_HOSTS` | NAS 的局域网 IP 或域名，写进证书，如 `192.168.1.10,nas.local` |
| `PUBLIC_HTTPS_PORT` | 宿主机映射的 HTTPS 端口，改了端口映射就同步改 |

改完重新 `docker compose up -d` 即可。证书改了 `CERT_HOSTS` 后要删掉 `./certs` 目录让它重新生成。

## 1.5 铁威马 TOS 部署

用 `docker-compose.tos.yml`，它直接拉官方 `node:22-alpine` 镜像，不需要在 NAS 上 build。

1. **装 Docker**：应用中心安装「Docker Manager」（TOS 5 / 6 都有）。
2. **建文件夹**：文件管理器里建 `docker/nas-recorder`，把压缩包里的文件全部传进去；再建一个存视频的共享文件夹，例如 `教程录屏`。
3. **改路径**：打开 `docker-compose.tos.yml`，确认里面的 `/Volume1/...` 和你 NAS 上的实际路径一致（铁威马是大写 V 的 `Volume1`），`CERT_HOSTS` 填 NAS 的局域网 IP。
4. **启动**，二选一：
   - **面板方式（TOS 6）**：Docker Manager →「项目 / Compose」→ 创建，粘贴 `docker-compose.tos.yml` 的内容，启动。
   - **SSH 方式（TOS 5 或面板没有 Compose 入口）**：控制面板 → 终端 → 启用 SSH，然后：
     ```bash
     ssh admin@NAS的IP
     cd /Volume1/docker/nas-recorder
     sudo docker compose -f docker-compose.tos.yml up -d
     # 老版本没有 compose 插件就用：sudo docker-compose -f docker-compose.tos.yml up -d
     ```
5. 浏览器打开 `https://NAS的IP:8443`。第一次启动要下载 ffmpeg，大约等 30 秒到 1 分钟。

**排错**：`sudo docker logs nas-recorder` 看日志。端口冲突就把 `8443:8443` 左边改成别的（如 `18443:8443`），同时把 `PUBLIC_HTTPS_PORT` 改成 18443。

**免证书警告**：TOS 控制面板里有「反向代理」，可以把你的域名指向 `http://127.0.0.1:8080`，再套上 TOS 申请的 Let's Encrypt 证书。

## 2. 打开方式（重要：必须 HTTPS）

浏览器规定 `getDisplayMedia`（屏幕录制）只能在 HTTPS 或 localhost 下用，所以要用：

```
https://NAS的IP:8443
```

首次打开会提示「证书不受信任」，点 **高级 → 继续访问** 即可，之后录屏功能正常。用 `http://...:8080` 打开页面会提示你跳到 HTTPS 地址。

不想每次看到证书警告，二选一：

- **用 NAS 自带的反向代理 + 正式证书（推荐长期用）**：群晖「控制面板 → 登录门户 → 高级 → 反向代理」，威联通「网络与文件服务 → 反向代理」，把 `https://rec.你的域名` 指向 `http://localhost:8080`，用 NAS 已有的 Let's Encrypt 证书。
- **信任自签证书**：把 `certs/cert.pem` 导入电脑的「受信任的根证书」（Windows：双击 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构；macOS：钥匙串访问 → 系统 → 拖入后设为「始终信任」）。

## 3. 录制小贴士

- 浏览器用 **桌面版 Chrome 或 Edge**。Safari 和 Firefox 录不了系统声音。
- **系统声音**：弹窗里要勾选「共享系统音频 / 共享标签页音频」。Windows 选「整个屏幕」能录全部声音；macOS 上选「Chrome 标签页」最稳。
- **录网站教程**最推荐选「标签页」：画面干净，不会录到桌面通知，声音也一定带上。
- 录制中可以随时 **暂停**、**静音麦克风**（比如咳嗽），停止共享或点「结束并保存」都会自动保存。
- 画质建议 1080p / 30fps，10 分钟大约 300–600 MB。需要鼠标动作很顺滑时再开 60fps。

## 4. 文件在哪

视频按 `日期_时间_标题.mp4` 存在你映射的文件夹里，可以直接用 NAS 文件管理器、SMB 共享拿去剪辑。隐藏目录 `.meta`（标题、时长）和 `.thumbs`（封面）是页面用的，可以不管。

## 5. 文件结构

```
nas-recorder/
├── docker-compose.yml
├── Dockerfile          # node:22-alpine + ffmpeg + openssl
├── server.js           # 零依赖 Node 服务：分片上传、录像库、Range 播放、自签 HTTPS
└── public/             # 前端页面
```

不用 Docker 也能跑：装好 Node 18+ 和 ffmpeg，`DATA_DIR=/你的目录 node server.js`。
