import type { ChatMessage } from "../shared/chat.ts";

export type { ChatMessage } from "../shared/chat.ts";

// 从这里开始实现智能体。messages 包含本轮对话历史，最后一条是最新的用户消息。
export async function reply(_messages: ChatMessage[]): Promise<string> {
  return "你好，欢迎使用小明智能体";
}
