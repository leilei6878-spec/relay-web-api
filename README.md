# Relay · 网页转 API

多账号池把 ChatGPT / Gemini 网页能力转成统一 HTTP 网关。

- ChatGPT 对话：`POST /v1/chat/completions`
- Gemini 出图：`POST /v1/images/generations`
- 账号独立 Session、sticky 代理、失败摘除换号
- 任务队列 + 本机 Worker 拉任务（绑定登录 IP，避免封号）

## 本地运行

```bash
npm install
npm run dev
```

调度设置里查看 API Key。本机 Worker 从「网关试运行」下载，配合同一条代理节点运行。

## 安全

不要提交 `storage/` 下的 Session、API Key 和代理密钥。仓库默认已忽略。
