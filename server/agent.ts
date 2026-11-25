import type OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";
import { efforts, priorities, type Task } from "../shared/task.ts";
import {
  arrangeTasks,
  daysUntil,
  dueLabel,
  effortLabels,
  priorityLabels,
  todayString,
} from "../shared/task-view.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

type ModelMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ModelTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;
type ModelReply = OpenAI.Chat.Completions.ChatCompletionMessage;

export interface AgentDependencies {
  complete(messages: ModelMessage[], tools: ModelTool[]): Promise<ModelReply>;
  taskApiUrl: string;
  today?: () => string;
}

const MAX_HISTORY = 30;
const MAX_STEPS = 8;

const numberParameter = { type: "integer", description: "清单中的任务编号，例如 #2 就填 2。" };

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
      description:
        "新增一条待办任务或子任务。一次只新增一条；用户一句话里说了多件事时，分别调用。到期日、优先级、工作量只在用户提到时才填。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "任务标题，只保留事情本身，例如「买牛奶」。最长 200 个字符。",
          },
          due_date: { type: "string", description: "到期日，格式 YYYY-MM-DD。" },
          priority: { type: "string", enum: [...priorities], description: "优先级：高、中、低。" },
          effort: { type: "string", enum: [...efforts], description: "工作量：小、中、大。" },
          parent_number: {
            type: "integer",
            description: "新增子任务时填所属任务的编号；普通任务不要填。",
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
      description:
        "修改一条任务或子任务：标记完成、恢复为待办、改标题、设置或清除到期日、优先级、工作量。只填需要改的字段。",
      parameters: {
        type: "object",
        properties: {
          number: numberParameter,
          done: { type: "boolean", description: "true 表示已完成，false 表示恢复为待办。" },
          title: { type: "string", description: "新的任务标题。" },
          due_date: { type: "string", description: "新的到期日 YYYY-MM-DD；填 none 表示清除。" },
          priority: {
            type: "string",
            enum: [...priorities, "none"],
            description: "none 表示清除。",
          },
          effort: { type: "string", enum: [...efforts, "none"], description: "none 表示清除。" },
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
      description: "删除一条任务或子任务。删除任务会连同它的子任务一起删除，无法恢复。",
      parameters: {
        type: "object",
        properties: { number: numberParameter },
        required: ["number"],
        additionalProperties: false,
      },
    },
  },
];

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function calendar(today: string) {
  const start = Date.parse(today + "T00:00:00Z");
  return Array.from({ length: 15 }, (_, offset) => {
    const date = new Date(start + offset * 86_400_000);
    return `${date.toISOString().slice(0, 10)} ${weekdays[date.getUTCDay()]}`;
  });
}

function systemPrompt(listText: string, today: string) {
  const [first, ...rest] = calendar(today);
  return `你是「小明」，一个帮用户管理待办清单的中文助手。用户用日常口语说话，你通过工具操作清单，然后用简短、自然的中文回复。

# 今天
今天是 ${first}。之后两周：${rest.join("，")}。
用户说「明天」「周五」「下周一」时，对照上面的日历换算成具体日期。

# 当前清单
${listText}

这是本轮对话开始时从数据库读到的最新清单，已经按「最需要处理的在前」排好：逾期和快到期的在最前，已完成的在最后，子任务以「└」开头列在所属任务下面。对话历史里你以前说过的清单可能已经过时，以这里和工具返回的结果为准。

# 怎么做
- 用户想记下一件事（「帮我记一下…」「提醒我…」「再记一条…」）：调用 add_task。标题只保留事情本身，去掉「帮我记一下」「明天」「很重要」这类已经用其他字段表达的词。
- 用户表示某件事做完了（「牛奶买好了」「快递取了」）：找到对应的任务，调用 update_task 把 done 设为 true。
- 用户想删除任务（「…删掉吧」「不用了」）：找到对应的任务，调用 delete_task。
- 用户想看清单（「我有哪些任务？」「看看清单」）：直接根据最新清单回答，不需要调用工具。
- 用户的说法和任务标题不必完全一致，按意思匹配，例如「牛奶买好了」对应「买牛奶」。
- 一句话里有多个操作时，逐个调用工具全部完成。

# 到期日
- 用户提到期限（「明天交」「周五前」「30 号之前」）时填 due_date。到期日只精确到天；用户说了具体钟点时，把钟点留在标题里（例如「下午三点开会」）。
- 期限说不清是哪一天（「下周」「月底前后」「过几天」）时，先问清楚具体日期，不要自己挑一天。
- 用户给的日期已经过去时，先向用户确认是不是说错了。
- 用户问「今天有哪些任务到期？」：列出标着「今天到期」的未完成任务；如果还有已逾期的任务，另起一段提醒。两者都没有就直接说今天没有到期的任务。已完成的任务不算。
- 用户问「明天」「这周」到期的任务时同理，按清单里的到期日筛选。

# 优先级和工作量
- 优先级分高、中、低，工作量分小、中、大。用户明确表达时才设置（「很重要」「紧急」是高，「不着急」是低；「几分钟就好」是小，「得花一整天」是大），没提就不填，不要替用户猜。
- 用户问「先做哪个」「有什么能很快做完的」时，根据到期日、优先级和工作量给出建议并说明理由。

# 子任务
- 用户要把一件事拆开，或者说「给 X 加个子任务 Y」时，用 add_task 并填 parent_number。所属任务不存在时先建所属任务，再逐条建子任务。
- 子任务只有一层：不能给子任务再加子任务，遇到这种要求时向用户说明，并建议改成同一任务下的另一条子任务。
- 把任务标记为完成会连同它的子任务一起完成；把子任务恢复为待办会让所属任务也回到待办。发生这种连带变化时要告诉用户。
- 某条任务的子任务全部完成、它自己还是待办时，问用户要不要把它也标记为完成，不要自己决定。
- 删除带子任务的任务会把子任务一起删掉，删之前先向用户确认。

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
- 展示清单时照抄「当前清单」或工具返回的最新清单里的行：保持顺序、符号、括号里的说明和子任务的缩进，只去掉行首的编号。例如清单里是
#1 ⬜ 交电费（⚠️ 已逾期 2 天｜高优先级）
#2 ⬜ 准备搬家（子任务 1/2 完成）
    └ #3 ⬜ 订搬家公司
    └ #4 ✅ 打包
#5 ✅ 买牛奶
就回复
⬜ 交电费（⚠️ 已逾期 2 天｜高优先级）
⬜ 准备搬家（子任务 1/2 完成）
    └ ⬜ 订搬家公司
    └ ✅ 打包
✅ 买牛奶
- 每一行都必须以 ⬜ 或 ✅ 表示状态，子任务行也一样，不能省略。
- 用户只问一部分（今天到期的、还没做的、某条任务的子任务）时，只列相关的行。
- 清单里有逾期或今天到期的任务时，展示完清单用一句话提醒。
- 清单为空时直接说明现在没有任务。
- 不要向用户展示任务编号（#1 这样的编号只供你调用工具使用）和内部 id。`;
}

function describeTask(task: Task, number: number, subtasks: Task[], today: string) {
  const notes: string[] = [];
  if (!task.done) {
    const due = dueLabel(task, today);
    if (due) notes.push(task.dueDate && daysUntil(task.dueDate, today) < 0 ? "⚠️ " + due : due);
    if (task.priority) notes.push(priorityLabels[task.priority] + "优先级");
    if (task.effort) notes.push("工作量" + effortLabels[task.effort]);
  }
  if (subtasks.length > 0) {
    notes.push(`子任务 ${subtasks.filter((item) => item.done).length}/${subtasks.length} 完成`);
  }
  const suffix = notes.length ? `（${notes.join("｜")}）` : "";
  return `#${number} ${task.done ? "✅" : "⬜"} ${task.title}${suffix}`;
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
  } catch {}
  return undefined;
}

export function createAgent({ complete, taskApiUrl, today = todayString }: AgentDependencies) {
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
    const ids: string[] = [];
    const finished: string[] = [];

    const date = today();
    const titles = new Map<string, string>();

    async function readList() {
      const tasks = (await callTaskApi("GET", "/api/tasks")) as Task[];
      const arranged = arrangeTasks(tasks, date);
      for (const { task, subtasks } of arranged) {
        for (const item of [task, ...subtasks]) {
          if (!ids.includes(item.id)) ids.push(item.id);
          titles.set(item.id, item.title);
        }
      }
      if (tasks.length === 0) return "（清单是空的）";
      const number = (task: Task) => ids.indexOf(task.id) + 1;
      return arranged
        .flatMap(({ task, subtasks }) => [
          describeTask(task, number(task), subtasks, date),
          ...subtasks.map((item) => "    └ " + describeTask(item, number(item), [], date)),
        ])
        .join("\n");
    }

    function findId(number: unknown) {
      const id = typeof number === "number" ? ids[number - 1] : undefined;
      if (!id) throw new Error(`没有编号为 ${String(number)} 的任务，请先核对清单。`);
      return id;
    }

    const clearable = (value: unknown) => (value === "none" ? null : value);

    async function runTool(name: string, args: Record<string, unknown>) {
      if (name === "add_task") {
        const input: Record<string, unknown> = { title: args.title };
        if (args.due_date !== undefined) input.dueDate = args.due_date;
        if (args.priority !== undefined) input.priority = args.priority;
        if (args.effort !== undefined) input.effort = args.effort;
        if (args.parent_number !== undefined) input.parentId = findId(args.parent_number);
        const task = (await callTaskApi("POST", "/api/tasks", input)) as Task;
        finished.push(`已添加「${task.title}」`);
      } else if (name === "update_task") {
        const changes: Record<string, unknown> = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.done !== undefined) changes.done = args.done;
        if (args.due_date !== undefined) changes.dueDate = clearable(args.due_date);
        if (args.priority !== undefined) changes.priority = clearable(args.priority);
        if (args.effort !== undefined) changes.effort = clearable(args.effort);
        const path = "/api/tasks/" + encodeURIComponent(findId(args.number));
        const task = (await callTaskApi("PATCH", path, changes)) as Task;
        finished.push(`已更新「${task.title}」`);
      } else if (name === "delete_task") {
        const id = findId(args.number);
        await callTaskApi("DELETE", "/api/tasks/" + encodeURIComponent(id));
        finished.push(`已删除「${titles.get(id) ?? "任务"}」`);
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
      { role: "system", content: systemPrompt(listText, date) },
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
