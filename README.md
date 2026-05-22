# 号来了

医院指定医生号源监控小程序。

当前架构：

- `miniapp/`：微信小程序前端。
- `server/`：Node.js 独立常驻后端服务。
- `docs/`：配置、部署和后续操作文档。

## 当前状态

- 已生成小程序前端骨架。
- 已生成 Node.js mock 后端，无需 npm 依赖即可运行。
- 已配置三条监控：林星光光谷院区、凃巍汉口院区、凃巍光谷院区。
- 已配置号源类型：专家号 · 副主任医师。
- 已增加微信登录换取 openid 的调试入口。

## 本地启动后端

```powershell
node .\server\src\server.js
```

默认监听：

```text
http://127.0.0.1:3000
```

可访问：

```text
GET http://127.0.0.1:3000/api/health
GET http://127.0.0.1:3000/api/monitors
POST http://127.0.0.1:3000/api/monitor/tick
POST http://127.0.0.1:3000/api/auth/wechat-login
POST http://127.0.0.1:3000/api/notify/test
GET http://127.0.0.1:3000/api/hospital/debug-availability?id=lin-xingguang
GET http://127.0.0.1:3000/api/hospital/debug-availability?id=tu-wei-hankou
GET http://127.0.0.1:3000/api/hospital/debug-availability?id=tu-wei-guanggu
```

`GET /api/monitors` 只读取最近一次缓存状态，不会触发医院查询或通知。需要手动执行一次真实查询时，调用 `POST /api/monitor/tick`。

自动轮询由 `MONITOR_AUTO_POLL_ENABLED=true` 开启。默认策略：

- 重点时段 `16:50-17:10`：随机 1-5 秒查询一次。
- 其他时段：随机 1-10 分钟查询一次。

测试订阅消息：

```powershell
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3000/api/notify/test"
```

调用前需要先在小程序医生详情页点击“订阅有号提醒”并接受授权。

## 接入真实数据

先按 [CAPTURE_HOSPITAL_API.md](</E:/codex_space/号来了/docs/CAPTURE_HOSPITAL_API.md>) 抓取医院官方小程序号源查询请求，再配置到 `server/.env`。


## 订阅消息模板

当前按“候补成功提醒”模板配置：

```text
候补成功时间 {{time1.DATA}}        -> {{availabilityTime}}
候补节点     {{short_thing2.DATA}} -> {{doctorName}}
温馨提示     {{thing3.DATA}}       -> {{alertTip}}
```

`.env` 示例：

```text
WECHAT_SUBSCRIBE_TEMPLATE_ID=你的模板ID
WECHAT_SUBSCRIBE_TEMPLATE_DATA_JSON={"time1":{"value":"{{availabilityTime}}"},"short_thing2":{"value":"{{doctorName}}"},"thing3":{"value":"{{alertTip}}"}}
```

## 获取 openid

openid 只需要获取一次。正式小程序界面不展示 openid 获取入口；拿到 openid 后写入 `server/.env`：

```text
ALLOWED_OPENIDS=你的openid
NOTIFY_OPENIDS=你的openid
```

## 打开小程序

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择本仓库下的 `miniapp`。
4. 开发阶段可在开发者工具中勾选“不校验合法域名”。
