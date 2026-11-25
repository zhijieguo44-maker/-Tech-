import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";

interface AppDependencies {
  reply(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
}

export function createApp({ reply, tasks }: AppDependencies) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    const answer = await reply(input.data.messages);
    res.json({ reply: answer });
  });

  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
