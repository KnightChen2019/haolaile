#!/usr/bin/env bash
# 抓包得到「查余号」请求后，把下面占位符换成真实值，在终端执行。
# 若返回 JSON 与小程序一致，再把各部分写入 server/.env 的 HOSPITAL_AVAILABILITY_*。

set -euo pipefail

BASE_URL="https://example-hospital-api.example.com/schedule/query"

curl -sS -X POST "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"deptId":"REPLACE","doctorId":"REPLACE","campusCode":"REPLACE"}'

echo ""
echo "调试后端单医生: GET http://127.0.0.1:3000/api/hospital/debug-availability?id=lin-xingguang"
