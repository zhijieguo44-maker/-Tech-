import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../shared/task.ts";

export async function requestReply(messages: ChatMessage[]): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null) {
    if (response.ok && "reply" in body && typeof body.reply === "string") return body.reply;
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}

export async function requestTasks(): Promise<Task[]> {
  const response = await fetch("/api/tasks");
  if (!response.ok) throw new Error("清单读取失败。");
  return (await response.json()) as Task[];
}
