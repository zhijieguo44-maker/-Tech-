import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAgent, type AgentDependencies } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

type Complete = AgentDependencies["complete"];
type ModelReply = Awaited<ReturnType<Complete>>;

function say(content: string): ModelReply {
  return { role: "assistant", content, refusal: null };
}

function call(name: string, args: unknown, id = "call-1"): ModelReply {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

// 用真实的任务 API 和临时清单文件，只把模型替换成按剧本回答的假模型。
async function startAgent(t: TestContext, script: Array<ModelReply | Error | (() => ModelReply)>) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const app = createApp({ tasks, reply: async () => "" });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const requests: Parameters<Complete>[0][] = [];
  const reply = createAgent({
    taskApiUrl: `http://127.0.0.1:${port}`,
    async complete(messages) {
      requests.push(structuredClone(messages));
      const next = script.shift();
      if (!next) throw new Error("剧本已经用完");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
  });
  const ask = (content: string) => reply([{ role: "user", content }]);
  return { ask, tasks, requests };
}

test("新增任务并把最新清单交还给模型", async (t) => {
  const { ask, tasks, requests } = await startAgent(t, [
    call("add_task", { title: "买牛奶" }),
    say("记好了"),
  ]);
  assert.equal(await ask("帮我记一下买牛奶"), "记好了");
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: false }],
  );
  assert.match(String(requests[0]?.[0]?.content), /清单是空的/);
  assert.match(String(requests[1]?.at(-1)?.content), /#1 \[待办\] 买牛奶/);
});

test("每轮回复都把当前清单写进系统提示", async (t) => {
  const { ask, tasks, requests } = await startAgent(t, [say("有两条")]);
  tasks.create("买牛奶");
  tasks.update(tasks.create("取快递").id, { done: true });
  await ask("我有哪些任务？");
  const prompt = String(requests[0]?.[0]?.content);
  assert.match(prompt, /#1 \[待办\] 买牛奶\n#2 \[已完成\] 取快递/);
});

test("按编号标记完成和删除", async (t) => {
  const { ask, tasks } = await startAgent(t, [
    call("update_task", { number: 1, done: true }),
    say("好的"),
    call("delete_task", { number: 2 }),
    say("删掉了"),
  ]);
  tasks.create("买牛奶");
  tasks.create("取快递");
  await ask("牛奶买好了");
  await ask("取快递这条删掉吧");
  assert.deepEqual(
    tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: true }],
  );
});

test("同一轮里删除任务后，其余任务的编号不变", async (t) => {
  const { ask, tasks } = await startAgent(t, [
    call("delete_task", { number: 1 }),
    call("delete_task", { number: 2 }),
    say("都删了"),
  ]);
  tasks.create("买牛奶");
  tasks.create("取快递");
  tasks.create("交电费");
  await ask("把买牛奶和取快递删掉");
  assert.deepEqual(
    tasks.list().map((task) => task.title),
    ["交电费"],
  );
});

test("编号不存在或接口拒绝时把原因交还给模型，不改动清单", async (t) => {
  const { ask, tasks, requests } = await startAgent(t, [
    call("delete_task", { number: 5 }),
    call("add_task", { title: "长".repeat(201) }),
    call("no_such_tool", {}),
    {
      ...call("add_task", {}),
      tool_calls: [
        { id: "x", type: "function", function: { name: "add_task", arguments: "{坏的" } },
      ],
    },
    say("没有成功"),
  ]);
  tasks.create("买牛奶");
  assert.equal(await ask("乱来"), "没有成功");
  assert.equal(tasks.list().length, 1);
  const results = requests.slice(1).map((messages) => String(messages.at(-1)?.content));
  assert.match(results[0] ?? "", /操作失败：没有编号为 5 的任务/);
  assert.match(results[1] ?? "", /操作失败：请提供 1 至 200 个字符的任务标题/);
  assert.match(results[2] ?? "", /操作失败：没有名为 no_such_tool 的工具/);
  assert.match(results[3] ?? "", /操作失败：工具参数不是有效的 JSON/);
});

test("任务已被别处删除时不会假装成功", async (t) => {
  let removeElsewhere = () => {};
  const { ask, tasks, requests } = await startAgent(t, [
    // 本轮开始后、工具执行前，任务在另一个页面被删掉。
    () => {
      removeElsewhere();
      return call("update_task", { number: 1, done: true });
    },
    say("这条任务已经不在了"),
  ]);
  const task = tasks.create("买牛奶");
  removeElsewhere = () => tasks.remove(task.id);
  assert.equal(await ask("牛奶买好了"), "这条任务已经不在了");
  assert.match(String(requests.at(-1)?.at(-1)?.content), /操作失败：找不到这条任务/);
});

test("模型中途出错时说明哪些操作已经生效", async (t) => {
  const { ask, tasks } = await startAgent(t, [
    call("add_task", { title: "买牛奶" }),
    new Error("网络中断"),
  ]);
  const answer = await ask("帮我记一下买牛奶");
  assert.match(answer, /连不上模型服务（网络中断）/);
  assert.match(answer, /已添加「买牛奶」/);
  assert.equal(tasks.list().length, 1);
});

test("工具调用停不下来时在限定步数后结束", async (t) => {
  const script = Array.from({ length: 20 }, () => call("list_tasks", {}));
  const { ask, requests } = await startAgent(t, script);
  assert.match(await ask("看看清单"), /步骤太多/);
  assert.equal(requests.length, 8);
});

test("只把最近的对话交给模型", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = createApp({
    tasks: createJsonTaskStore(join(directory, "tasks.json")),
    reply: async () => "",
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  let received = 0;
  const reply = createAgent({
    taskApiUrl: `http://127.0.0.1:${port}`,
    async complete(messages) {
      received = messages.length;
      return say("好");
    },
  });
  const history = Array.from({ length: 101 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `第 ${index} 条`,
  }));
  await reply(history);
  assert.equal(received, 31);
});
