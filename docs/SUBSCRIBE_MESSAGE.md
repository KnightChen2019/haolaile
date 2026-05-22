# 微信订阅消息配置

当前使用“候补成功提醒”模板。

## 模板字段

```text
候补成功时间 {{time1.DATA}}
候补节点     {{short_thing2.DATA}}
温馨提示     {{thing3.DATA}}
```

## 推荐映射

```text
time1        -> availabilityTime
short_thing2 -> doctorName
thing3       -> alertTip
```

`.env` 配置：

```text
WECHAT_SUBSCRIBE_TEMPLATE_ID=你的模板ID
WECHAT_SUBSCRIBE_TEMPLATE_DATA_JSON={"time1":{"value":"{{availabilityTime}}"},"short_thing2":{"value":"{{doctorName}}"},"thing3":{"value":"{{alertTip}}"}}
```

## 变量含义

- `availabilityTime`：医生有号的日期和时段，例如 `2026-05-08 上午`。
- `doctorName`：医生姓名，例如 `林星光`。
- `alertTip`：提示文案，例如 `林星光2026-05-08 周五 上午有号，挂号费20.5元，请速看。`

## 测试步骤

1. 在微信公众平台复制模板 ID。
2. 写入 `server/.env` 的 `WECHAT_SUBSCRIBE_TEMPLATE_ID`。
3. 重启后端。
4. 打开医生详情页，点击“订阅有号提醒”。
5. 用户接受授权后，后端会注册 openid。
6. 当自动轮询发现 `无号 -> 有号` 变化时发送订阅消息。
