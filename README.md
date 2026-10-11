# Echo

开源的个人音乐播放器（MIT 协议），界面参考 Spotify。歌曲和歌单存在 Cloudflare R2，也能播 Internet Archive 的免费曲库。

网址：https://echo-music-beta.vercel.app

## 结构

- `public/`：网页 app（PWA，可以加到手机主屏幕）
  - `store.js`：数据层。读 R2 里的歌，歌单/收藏/播放记录同步到 R2 的 `echo/data.json`
  - `id3.js`：读取 MP3 / M4A / FLAC 的歌名、歌手、专辑、封面
  - `app.js`：界面和播放器
- `api/`：Vercel 函数
  - `auth/login.js`、`auth/logout.js`：密码登录（`APP_PASSWORD`），登录后记住 400 天；改密码会让所有设备重新登录
  - `me.js`：是否已登录
  - `library.js`：列出 R2 里 `music/` 下的歌
  - `sign.js`：给浏览器发短期签名链接（读歌 12 小时，上传 15 分钟）。R2 密钥只在服务器上
  - `migrate.js`：一次性把旧 Vercel Blob 里的歌复制到 R2
- `lib/session.js`：登录 cookie（加密）；`lib/r2.js`：R2 的 S3 API
- `public/sw.js`：Service Worker，让 app 秒开、断网也能打开界面，Android 可以直接「安装应用」

## 在手机上使用（iOS / Android）

Echo 是一个 PWA，不用上架 App Store / Google Play，手机浏览器打开网址就能用，也能装到桌面像原生 app 一样全屏运行：

- **iPhone / iPad**：用 Safari 打开网址 → 底部「分享」→「添加到主屏幕」
- **Android**：用 Chrome 打开网址 → 设置页里点「安装到手机桌面」，或 Chrome 菜单 →「安装应用」

锁屏和通知栏可以控制播放（上一首 / 下一首 / 暂停 / 拖动进度）。

## 自己部署一份

1. Fork 这个仓库
2. 在 Cloudflare 建一个 R2 存储桶，创建 API 令牌（S3 凭据），按下面设置 CORS
3. 在 Vercel 导入这个仓库，按下表填好环境变量（参考 `.env.example`）
4. 部署完成后打开网址，用 `APP_PASSWORD` 登录

本地测试：`npm install`，把环境变量写进 `.env.local`，然后 `npm run dev`（需要 [Vercel CLI](https://vercel.com/docs/cli)）。

## R2 里的文件

```
music/                 歌曲。music/<文件夹>/<歌>.mp3 —— 每个文件夹自动变成同名歌单
echo/data.json        歌单、收藏、播放记录、歌曲信息缓存
```

## Vercel 环境变量

| 变量 | 内容 |
| --- | --- |
| `APP_PASSWORD` | 登录密码 |
| `SESSION_SECRET` | 随机字符串，加密登录 cookie |
| `R2_ACCOUNT_ID` | Cloudflare 账户 ID |
| `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | R2 API 令牌（S3 凭据） |
| `R2_BUCKET` | 存储桶名字 |
| `BLOB_STORE_ID`（或 `BLOB_READ_WRITE_TOKEN`） | Vercel Blob 连接，只在搬歌时需要 |

本地测试时把这些写进 `.env.local`。

## R2 存储桶的 CORS 设置

浏览器直接从 R2 读歌、上传，所以存储桶要允许这个网站：

```json
[
  {
    "AllowedOrigins": ["https://你的网址.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

## 部署

```
vercel deploy --prod
```
