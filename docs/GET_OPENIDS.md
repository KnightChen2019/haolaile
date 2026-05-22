# 获取 openid

openid 是同一个微信小程序下，每个微信用户自己的唯一标识。获取一次后写入服务器 `.env` 的 `ALLOWED_OPENIDS` / `NOTIFY_OPENIDS`，后续可以长期复用；小程序正式界面不展示 openid 获取入口。

## 获取你的 openid

1. 后端使用本地地址启动：

```text
HOST=127.0.0.1
```

2. 重启后端。
3. 临时使用开发调试版本或后端接口换取 openid。
4. 记录 openid。
5. 写入服务器 `server/.env`：

```text
ALLOWED_OPENIDS=你的openid
NOTIFY_OPENIDS=你的openid
```

## 太太作为体验成员

当前不强制获取太太的 openid。你只需要：

1. 在微信公众平台把太太的微信加入开发者或体验成员。
2. 用微信开发者工具生成预览二维码。
3. 让太太用她自己的微信扫码打开小程序。

## 后续让太太也接收通知

如果后续需要太太也接收订阅消息，再获取她的 openid，并追加到服务器 `.env`：

1. 将后端监听地址改成局域网：

```text
HOST=0.0.0.0
```

2. 查出你电脑的局域网 IP，例如 `192.168.x.x`。
3. 将 `miniapp/app.js` 里的 API 地址临时改成：

```text
http://192.168.x.x:3000
```

4. 重启后端。
5. 用微信开发者工具生成预览二维码。
6. 让太太用她自己的微信扫码打开小程序。
7. 使用临时调试入口或后端接口记录她的 openid。

完成后，将她的 openid 追加写入 `server/.env`：

```text
ALLOWED_OPENIDS=你的openid,太太的openid
```

然后把 `HOST` 和 `miniapp/app.js` 按当前开发需要切回本地或继续使用局域网地址。
