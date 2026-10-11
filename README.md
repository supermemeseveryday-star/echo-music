# Echo

开源的音乐播放器（MIT 协议），界面参考 Spotify。纯前端 PWA，**不需要服务器、不需要账号、没有数据库**：

- **本机音乐**：从手机或电脑导入音乐文件，保存在浏览器里，断网也能听
- **NAS**：连接你自己的 Subsonic 兼容服务器（[Navidrome](https://www.navidrome.org/)、Gonic、Airsonic 等），读取 NAS 上的歌和歌单，边下边播
- **免费曲库**：直接播放 Internet Archive 的公版 / CC 授权音乐

歌单、收藏、播放记录都只存在用户自己的设备上。

## 在手机上使用（iOS / Android）

部署好之后，用手机浏览器打开网址就能用，也能装到桌面像原生 app 一样全屏运行：

- **iPhone / iPad**：用 Safari 打开网址 → 底部「分享」→「添加到主屏幕」
- **Android**：用 Chrome 打开网址 → 设置页里点「安装到手机桌面」，或 Chrome 菜单 →「安装应用」

锁屏和通知栏可以控制播放（上一首 / 下一首 / 暂停 / 拖动进度）。装到桌面后，浏览器不会自动清理导入的音乐。

## 部署

整个 app 就是 `public/` 里的静态文件，放到任何静态网站托管都能用（必须是 **HTTPS**，PWA 和 NAS 连接都需要）。

### Vercel

1. Fork 这个仓库
2. 在 [Vercel](https://vercel.com/new) 导入你 fork 的仓库，不用改任何设置（`vercel.json` 已经指定了 `public/`），点 Deploy
3. 打开分配给你的网址就能用了

### 其他平台

- **Netlify / Cloudflare Pages**：发布目录填 `public`，没有构建命令
- **GitHub Pages**：把 `public/` 里的文件发布出去即可
- **NAS 自己托管**：用任何 Web 服务器（Nginx、Caddy、群晖 Web Station）指向 `public/`

### 本地测试

```
npm run dev
```

然后打开 http://localhost:4321

## 连接 NAS

1. 在 NAS 上装 [Navidrome](https://www.navidrome.org/docs/installation/)（群晖、威联通、Unraid 都能用 Docker 装），让它扫描你的音乐文件夹
2. NAS 必须能用 **https://** 地址访问（浏览器不允许 https 网页连接 http 地址）。常见做法：
   - 群晖 DDNS + Let's Encrypt 证书 + 反向代理
   - [Tailscale](https://tailscale.com/) 的 HTTPS（`tailscale serve` / `tailscale funnel`）
   - Cloudflare Tunnel
3. 打开 Echo → 设置 → NAS，填地址、用户名、密码，点连接

Echo 只在设备上保存一个登录令牌（`md5(密码 + 随机盐)`），不保存密码。每次打开 app 会自动同步 NAS 上新加的歌和歌单。

Navidrome 默认允许跨域访问（CORS）。如果用的是其他 Subsonic 服务器连不上，检查它是否允许浏览器跨域请求。

## 结构

- `public/index.html`、`style.css`：界面
- `public/app.js`：界面逻辑和播放器
- `public/store.js`：数据层。本机音乐存在 IndexedDB；NAS 走 Subsonic API；免费曲库调用 Internet Archive
- `public/id3.js`：读取 MP3 / M4A / FLAC 的歌名、歌手、专辑、封面
- `public/sw.js`：Service Worker，让 app 秒开、断网也能打开界面

没有构建步骤，没有依赖，改完文件刷新就能看到效果。
