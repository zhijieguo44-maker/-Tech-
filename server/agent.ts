import type OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

type ModelMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ModelTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;
type ModelReply = OpenAI.Chat.Completions.ChatCompletionMessage;

interface Task {
  id: string;
  title: string;
  done: boolean;
}

export interface AgentDependencies {
  // 向模型发起一次请求，返回模型的回复（可能带有工具调用）。
  complete(messages: ModelMessage[], tools: ModelTool[]): Promise<ModelReply>;
  // 任务 API 的地址，例如 http://127.0.0.1:3000
  taskApiUrl: string;
}

// 只把最近的对话交给模型，避免长对话不断增加费用。清单本身每轮从任务 API 重新读取，不依赖历史。
const MAX_HISTORY = 30;
// 一轮回复里最多与模型往返的次数，防止工具调用陷入死循环。
const MAX_STEPS = 8;

const tools: ModelTool[] = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "读取最新的任务清单。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "add_task",
      description: "新增一条待办任务。一次只新增一条；用户一句话里说了多件事时，分别调用。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "任务标题，只保留事情本身，例如「买牛奶」。最长 200 个字符。",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "修改一条任务：标记为已完成、恢复为待办，或者修改标题。",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", description: "清单中的任务编号，例如 #2 就填 2。" },
          done: { type: "boolean", description: "true 表示已完成，false 表示恢复为待办。" },
          title: { type: "string", description: "新的任务标题。" },
        },
        required: ["number"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "从清单中删除一条任务。删除后无法恢复。",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", description: "清单中的任务编号，例如 #2 就填 2。" },
        },
        required: ["number"],
        additionalProperties: false,
      },
    },
  },
];

function systemPrompt(listText: string) {
  return `你是「小明」，一个帮用户管理待办清单的中文助手。用户用日常口语说话，你通过工具操作清单，然后用简短、自然的中文回复。

# 当前清单
${listText}

这是本轮对话开始时从数据库读到的最新清单。对话历史里你以前说过的清单可能已经过时，以这里和工具返回的结果为准。

# 怎么做
- 用户想记下一件事（「帮我记一下…」「提醒我…」「再记一条…」）：调用 add_task。标题只保留事情本身，去掉「帮我记一下」之类的话。
- 用户表示某件事做完了（「牛奶买好了」「快递取了」）：找到对应的任务，调用 update_task 把 done 设为 true。
- 用户想删除任务（「…删掉吧」「不用了」）：找到对应的任务，调用 delete_task。
- 用户想看清单（「我有哪些任务？」「看看清单」）：直接根据最新清单回答，不需要调用工具。
- 用户的说法和任务标题不必完全一致，按意思匹配，例如「牛奶买好了」对应「买牛奶」。
- 一句话里有多个操作时，逐个调用工具全部完成。

# 拿不准的时候
- 有多条任务都可能是用户指的那条：不要猜，列出候选让用户选。
- 清单里找不到用户指的任务：如实告诉用户没找到，不要因此新增任务，也不要改动别的任务。
- 用户要新增的事情，清单里已经有一条标题相同且未完成的：先告诉用户已经有了，问是否还要再加一条。
- 用户要一次删除多条或清空清单：先向用户确认，得到肯定答复后再删。
- 工具返回错误时，把原因如实告诉用户，不要假装成功。
- 只有工具返回成功，才可以说「已添加」「已完成」「已删除」。
- 与待办清单无关的闲聊可以简短回应，然后引导回待办。

# 回复格式
- 界面只显示纯文本，不要使用 Markdown（不要用 **、#、表格）。
- 展示清单时每条任务一行，先列待办再列已完成，待办用「⬜」开头，已完成用「✅」开头，例如：
⬜ 取快递
✅ 买牛奶
- 清单为空时直接说明现在没有任务。
- 不要向用户展示任务编号（#1 这样的编号只供你调用工具使用）和内部 id。`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text || "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // 模型偶尔会生成不完整的 JSON，交给调用方当作参数错误处理。
  }
  return undefined;
}

export function createAgent({ complete, taskApiUrl }: AgentDependencies) {
  async function callTaskApi(method: string, path: string, body?: unknown) {
    const response = await fetch(taskApiUrl + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const reason =
        typeof data === "object" && data !== null && "error" in data
          ? String(data.error)
          : `任务接口返回了 ${response.status}`;
      throw new Error(reason);
    }
    return data;
  }

  return async function reply(messages: ChatMessage[]): Promise<string> {
    // 任务编号 -> 任务 id。编号在一轮回复内保持不变：删除后不重排，新任务排在最后，
    // 这样模型连续操作多条任务时不会因为编号移位而改错任务。
    const ids: string[] = [];
    // 本轮已经成功执行的操作，模型中途出错时用来告诉用户哪些已经生效。
    const finished: string[] = [];

    async function readList() {
      const tasks = (await callTaskApi("GET", "/api/tasks")) as Task[];
      for (const task of tasks) if (!ids.includes(task.id)) ids.push(task.id);
      if (tasks.length === 0) return "（清单是空的）";
      return tasks
        .map(
          (task) => `#${ids.indexOf(task.id) + 1} [${task.done ? "已完成" : "待办"}] ${task.title}`,
        )
        .join("\n");
    }

    function findId(number: unknown) {
      const id = typeof number === "number" ? ids[number - 1] : undefined;
      if (!id) throw new Error(`没有编号为 ${String(number)} 的任务，请先核对清单。`);
      return id;
    }

    async function runTool(name: string, args: Record<string, unknown>) {
      if (name === "add_task") {
        const task = (await callTaskApi("POST", "/api/tasks", { title: args.title })) as Task;
        finished.push(`已添加「${task.title}」`);
      } else if (name === "update_task") {
        const changes: { title?: unknown; done?: unknown } = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.done !== undefined) changes.done = args.done;
        const task = (await callTaskApi(
          "PATCH",
          "/api/tasks/" + encodeURIComponent(findId(args.number)),
          changes,
        )) as Task;
        finished.push(`已把「${task.title}」更新为${task.done ? "已完成" : "待办"}`);
      } else if (name === "delete_task") {
        await callTaskApi("DELETE", "/api/tasks/" + encodeURIComponent(findId(args.number)));
        finished.push(`已删除第 ${String(args.number)} 条任务`);
      } else if (name !== "list_tasks") {
        throw new Error(`没有名为 ${name} 的工具。`);
      }
      return "操作成功。最新清单：\n" + (await readList());
    }

    function interrupted(reason: string) {
      if (finished.length === 0) return reason;
      return `${reason}\n在此之前${finished.join("，")}。可以说「看看清单」确认当前状态。`;
    }

    let listText: string;
    try {
      listText = await readList();
    } catch (error) {
      return `暂时读不到任务清单（${errorMessage(error)}），请稍后再试。`;
    }

    const conversation: ModelMessage[] = [
      { role: "system", content: systemPrompt(listText) },
      ...messages.slice(-MAX_HISTORY),
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
      let answer: ModelReply;
      try {
        answer = await complete(conversation, tools);
      } catch (error) {
        console.error(error);
        return interrupted(`小明暂时连不上模型服务（${errorMessage(error)}）。`);
      }

      const calls = answer.tool_calls ?? [];
      if (calls.length === 0) {
        return (
          answer.content?.trim() || interrupted("小明这次没有想好怎么回答，请换个说法再试一次。")
        );
      }

      conversation.push(answer);
      for (const call of calls) {
        let result: string;
        try {
          if (call.type !== "function") throw new Error("不支持这种工具调用。");
          const args = parseArguments(call.function.arguments);
          if (!args) throw new Error("工具参数不是有效的 JSON。");
          result = await runTool(call.function.name, args);
        } catch (error) {
          // 把失败原因交还给模型，由它向用户解释或换一种做法。
          result = "操作失败：" + errorMessage(error);
        }
        conversation.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    return interrupted("这个请求需要的步骤太多，小明先停在这里。");
  };
}

export const reply = createAgent({
  async complete(messages, tools) {
    const completion = await getModelClient().chat.completions.create({
      model,
      messages,
      tools,
      temperature: 0,
    });
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("模型没有返回内容");
    return message;
  },
  taskApiUrl: process.env.TASK_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
});
