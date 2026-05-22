# 接入医院官方小程序真实号源

目标是先拿到官方小程序“查询医生号源”的真实请求，再把请求配置到 `server/.env`，由后端复用你的合法登录态做低频调试。

## 1. 先明确限制

微信开发者工具不能直接打开和调试武汉同济医院官方小程序。它只能调试你自己有权限的项目，例如本项目的 `miniapp`。

武汉同济医院官方小程序需要在微信里打开：

- 手机微信
- 电脑微信
- 微信开发者工具不能直接导入或查看它的源码、Network 面板

所以真实接口分析需要通过你自己设备上的正常微信访问流量来观察，不能依赖微信开发者工具直接调试第三方小程序。

## 2. 推荐抓取方式

### 方式 A：电脑微信 + 抓包工具

1. 在电脑微信里打开武汉同济医院官方小程序。
2. 使用你的医院账号正常登录。
3. 用 Fiddler、Charles、Reqable 等抓包工具观察本机 HTTPS 请求。
4. 在官方小程序里进入目标医生挂号页。
5. 切换日期或刷新号源，让页面发起号源查询请求。
6. 在抓包工具里找到疑似接口，重点看 URL、Method、Request Headers、Request Payload、Response。

### 方式 B：手机微信 + 抓包工具

1. 手机和电脑连同一个 Wi-Fi。
2. 电脑运行 Fiddler、Charles、Reqable 等抓包工具。
3. 手机 Wi-Fi 代理指向电脑 IP 和抓包工具端口。
4. 手机微信打开武汉同济医院官方小程序。
5. 登录并进入目标医生挂号页。
6. 切换日期或刷新号源，观察抓包工具里的请求。

注意：如果 HTTPS 证书、系统代理或小程序安全策略导致抓不到明文内容，不要做绕过验证、破解证书校验等操作。我们可以改用页面可见信息、官方网页入口或人工辅助方式做 MVP。

通常可以通过这些线索判断是否是号源接口：

- 请求或响应里包含医生 ID、科室 ID、院区 ID、排班、号源、剩余、可预约等字段。
- 响应会随日期或医生变化。
- 返回内容能解释页面上“有号/无号/约满”的状态。

## 3. 不要直接发敏感信息到聊天

这些内容不要发到聊天里：

- 完整 token
- 完整 cookie
- 身份证
- 手机号
- 就诊卡号
- 患者姓名

可以发给我的内容：

- URL 的域名和路径，隐藏 token 参数。
- 请求 body 的字段名结构，敏感值用 `<hidden>` 替代。
- 响应 JSON 的字段结构，敏感值用 `<hidden>` 替代。

## 4. 配置 `.env`

把真实请求配置到 `server/.env`。示例：

```text
HOSPITAL_API_ENABLED=true
HOSPITAL_RESPONSE_FORMAT=tjh_reg_sources
HOSPITAL_AVAILABILITY_URL=https://www.tjhonline.com.cn/app-gateway/offline/regSource/getDoctorRegSourcesMap?businessType=offline_normal_new&isShowNone=true&startDate={{startDate}}&endDate={{endDate}}&doctorCode={{doctorCode}}
HOSPITAL_AVAILABILITY_METHOD=GET
HOSPITAL_AVAILABILITY_HEADERS_JSON={}
HOSPITAL_AVAILABILITY_BODY_JSON=
HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON={"lin-xingguang":{"doctorCode":"101573","hospitalId":"H0002","specCode":"020302"},"tu-wei-hankou":{"doctorCode":"REPLACE_HANKOU","hospitalId":"H0001","specCode":"010108"},"tu-wei-guanggu":{"doctorCode":"REPLACE_GUANGGU","hospitalId":"H0002","specCode":"010108"}}
```

`{{startDate}}` 和 `{{endDate}}` 会按 `MONITOR_WINDOW_DAYS` 自动生成；`{{doctorCode}}` 会从 `HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON` 里替换。
凃巍现在按院区拆成两条监控：`tu-wei-hankou` 对应汉口院区 `H0001`，`tu-wei-guanggu` 对应光谷院区 `H0002`。

当前已知：

- 林星光 doctorCode：`101573`
- 凃巍 doctorCode：待抓包确认
- 汉口院区 hospitalId：`H0001`
- 光谷院区 hospitalId：`H0002`
- 林星光产科 specCode：`020302`
- 凃巍风湿免疫内科 specCode：`010108`

同济接口字段含义：

- `outpDate`：就诊日期的毫秒时间戳，例如 `1778169600000` 是北京时间 `2026-05-08 00:00`。
- `durationCode` / `durationName`：时段，例如 `AM` / `上午`。
- `regTypeCode` / `regTypeName`：号源类型，例如 `3` / `专家`。
- `regPrice`：挂号费，例如 `20.5`。
- `availableStatus`：号源状态；目前观察 `1` 为可约，`2` 为约满，`3` 为停诊，`4` 为过期。
- `specCode` / `specName`：具体门诊专科。同一个医生可能出现多个专科条目，例如产科、产后康复门诊。
- 如果只关心某个院区/专科，可以在 `HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON` 里配置 `hospitalId`、`specCode` 或 `specName` 过滤。林星光配置 `hospitalId=H0002`、`specCode=020302`，只看光谷院区产科；凃巍汉口配置 `hospitalId=H0001`、`specCode=010108`，凃巍光谷配置 `hospitalId=H0002`、`specCode=010108`。

## 5. 调试真实接口

重启后端后访问：

```text
http://127.0.0.1:3000/api/hospital/debug-availability?id=lin-xingguang
http://127.0.0.1:3000/api/hospital/debug-availability?id=tu-wei-hankou
http://127.0.0.1:3000/api/hospital/debug-availability?id=tu-wei-guanggu
```

如果接口通了，返回里会有：

- `status`
- `latencyMs`
- `hasAvailability`
- `rawLength`

默认不会返回原始响应片段，避免误把 token、手机号、就诊卡等敏感内容打到调试输出。确实需要排查响应结构时，可以临时设置：

```text
DEBUG_RAW_HOSPITAL_RESPONSE=true
```

此时返回里的 `rawPreview` 会做基础脱敏，但仍然建议只在本地短时间开启。

`hasAvailability` 目前只是关键词粗判断。第一次接入后，我们需要根据真实响应字段，把它改成准确解析逻辑。

## 6. 再接入监控

真实接口调试通过后，使用下面的接口执行一次查询并更新缓存：

```text
POST http://127.0.0.1:3000/api/monitor/tick
```

`GET /api/monitors` 只读取缓存，不直接请求医院接口，也不会发送通知。确认解析准确后，再开启 16:50-17:10 的 5-10 秒轮询。
