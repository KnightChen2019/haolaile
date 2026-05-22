# Docker 部署后端

目标架构：

```text
微信小程序
  -> https://mini-p.caicaiai.cn
  -> Nginx
  -> 127.0.0.1:3001
  -> Docker 容器内 Node 后端 3000
```

## 1. 服务器目录

建议放到：

```bash
/opt/haolaile
```

目录结构：

```text
/opt/haolaile/
  server/
    Dockerfile
    package.json
    src/server.js
    .env
    data/
  deploy/
    docker-compose.yml
```

## 2. 上传文件

本地 PowerShell 示例：

```powershell
scp -r E:\codex_space\号来了\server root@你的服务器IP:/opt/haolaile/
scp -r E:\codex_space\号来了\deploy root@你的服务器IP:/opt/haolaile/
```

也可以用 WinSCP 上传。

注意：`server/.env` 包含 AppSecret、openid 等敏感信息，只上传到服务器，不要提交到 Git。

## 3. 配置服务器 `.env`

服务器上编辑：

```bash
cd /opt/haolaile
nano server/.env
```

关键配置建议：

```text
HOST=0.0.0.0
PORT=3000
HOSPITAL_API_ENABLED=true
MONITOR_AUTO_POLL_ENABLED=true
WECHAT_SUBSCRIBE_MINIPROGRAM_STATE=trial
```

说明：

- 容器内部监听 `0.0.0.0:3000`。
- `docker-compose.yml` 会把宿主机 `127.0.0.1:3001` 转发到容器 `3000`。
- Nginx 再把 `mini-p.caicaiai.cn` 转发到 `127.0.0.1:3001`。

## 4. 启动容器

服务器上：

```bash
cd /opt/haolaile/deploy
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker logs -f haolaile-server
```

本机测试：

```bash
curl http://127.0.0.1:3001/api/health
```

公网测试：

```bash
curl https://mini-p.caicaiai.cn/api/health
```

## 5. Nginx 配置

`mini-p.caicaiai.cn` 的 Nginx 反代应指向宿主机本地端口：

```nginx
server {
    listen 80;
    server_name mini-p.caicaiai.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name mini-p.caicaiai.cn;

    ssl_certificate /etc/nginx/ssl/mini-p/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/mini-p/cert.key;

    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_redirect off;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 6. 更新部署

以后本地改了后端代码，重新上传 `server/src/server.js` 后执行：

```bash
cd /opt/haolaile/deploy
docker compose up -d --build
```

如果只改了 `.env`：

```bash
cd /opt/haolaile/deploy
docker compose up -d
```

## 7. 小程序前端

小程序前端不部署到服务器，而是上传到微信平台。

本地修改 `miniapp/app.js`：

```js
App({
  globalData: {
    apiBaseUrl: "https://mini-p.caicaiai.cn"
  }
});
```

然后在微信开发者工具里上传体验版。
