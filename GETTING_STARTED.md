# 本地开发指南

## 启动

安装 Node.js 24.12 或更高版本（含 npm）。在终端执行以下命令。

```sh
git clone https://github.com/TokeNow/todo-agent.git
cd todo-agent
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000>。前后端共用这个地址，修改服务端代码后服务会自动重启。修改聊天界面的 TSX 后，在另一个终端运行 `npm run build` 并刷新页面。若 3000 端口已占用，可以用 `PORT=3001 npm run dev` 指定其他端口（macOS / Linux）。

## 接入 DeepSeek

1. 在项目根目录将 `.env.example` 复制为 `.env`。
2. 在 `.env` 中填写 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API Key。可通过 `DEEPSEEK_MODEL` 更换模型。
3. 重启开发服务。在服务端使用 [server/model.ts](server/model.ts) 导出的 `getModelClient()` 获取客户端，使用 `model` 读取配置的模型名称。只有发起模型请求才会产生调用费用。

## 代码入口

| 文件                                         | 用途                                       |
| -------------------------------------------- | ------------------------------------------ |
| [src/App.tsx](src/App.tsx)                   | 聊天界面，发送当前页面的对话历史并显示回复 |
| [server/index.ts](server/index.ts)           | 接入智能体与任务存储，启动服务             |
| [server/agent.ts](server/agent.ts)           | 候选人实现入口，接收消息数组，返回回复文本 |
| [server/model.ts](server/model.ts)           | 服务端 DeepSeek 客户端与模型配置           |
| [server/tasks.ts](server/tasks.ts)           | 任务 API 的输入校验和 HTTP 响应            |
| [server/app.ts](server/app.ts)               | 接收对话历史，调用智能体并挂载任务 API     |
| [server/task-store.ts](server/task-store.ts) | 读写本地 JSON 任务清单                     |
| [server/openapi.yaml](server/openapi.yaml)   | 任务请求和响应的完整定义                   |

## 手动验证接口

启动服务后，在另一个终端发送聊天消息。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

初始响应为 `{"reply":"你好，欢迎使用小明智能体"}`。后续请求可在 `messages` 中按顺序传入之前的用户消息和小明的回复，再追加最新的用户消息。

创建一条任务，然后检查列表。

```sh
curl -sS http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"买牛奶"}'
curl -sS http://127.0.0.1:3000/api/tasks
```

首次创建任务时，服务会在项目根目录创建 `data/tasks.json`。这些任务会保留到下次启动，浏览器中的聊天记录则会在刷新后清空。

## 本地检查

```sh
npm test
npm run typecheck
npm run lint
npm run fmt:check
npm run build
```

测试使用独立的临时目录。要预览构建产物，先停止开发服务，再运行 `npm start` 并打开同一地址。
