import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { arrangeTasks, dueLabel, todayString } from "../shared/task-view.ts";
import type { Task } from "../shared/task.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const app = createApp({ tasks: createJsonTaskStore(filename), reply: async () => "" });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  async function create(body: Record<string, unknown>): Promise<Task> {
    const created = await request("POST", "/api/tasks", body);
    assert.equal(created.status, 201);
    return created.body;
  }

  const list = async (): Promise<Task[]> => (await request("GET", "/api/tasks")).body;
  return { request, create, list, filename };
}

test("任务可以带到期日、优先级和工作量，传 null 可以清除", async (t) => {
  const { request, create } = await startTestApp(t);
  const task = await create({
    title: "交报告",
    dueDate: "2026-11-28",
    priority: "high",
    effort: "large",
  });
  assert.deepEqual(task, {
    id: task.id,
    title: "交报告",
    done: false,
    dueDate: "2026-11-28",
    priority: "high",
    effort: "large",
  });

  const cleared = await request("PATCH", "/api/tasks/" + task.id, {
    dueDate: null,
    priority: "low",
    effort: null,
  });
  assert.deepEqual(cleared.body, { id: task.id, title: "交报告", done: false, priority: "low" });
});

test("拒绝不存在的日期、不认识的取值和多余字段，并指出是哪个字段", async (t) => {
  const { request, create, list } = await startTestApp(t);
  const post = (body: unknown) => request("POST", "/api/tasks", body);
  for (const dueDate of ["2026-02-30", "2026-13-01", "明天", "2026-1-5", 20261125]) {
    const rejected = await post({ title: "交报告", dueDate });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /到期日/);
  }
  assert.match((await post({ title: "交报告", priority: "紧急" })).body.error, /优先级/);
  assert.match((await post({ title: "交报告", effort: "huge" })).body.error, /工作量/);
  assert.match((await post({ title: "交报告", done: true })).body.error, /不支持的字段：done/);
  assert.deepEqual(await list(), []);

  const task = await create({ title: "交报告" });
  const patch = (body: unknown) => request("PATCH", "/api/tasks/" + task.id, body);
  assert.equal((await patch({ parentId: "x" })).status, 400);
  assert.equal((await patch({ dueDate: "2026-02-30" })).status, 400);
  assert.equal((await patch({ title: null })).status, 400);
  assert.deepEqual(await list(), [task]);
});

test("子任务只能挂在存在的普通任务下", async (t) => {
  const { request, create } = await startTestApp(t);
  const parent = await create({ title: "准备搬家" });
  const child = await create({ title: "打包", parentId: parent.id });
  assert.equal(child.parentId, parent.id);

  const missing = await request("POST", "/api/tasks", { title: "打包", parentId: "missing" });
  assert.equal(missing.status, 404);
  const nested = await request("POST", "/api/tasks", { title: "买纸箱", parentId: child.id });
  assert.equal(nested.status, 400);
  assert.match(nested.body.error, /子任务下面不能再添加子任务/);
});

test("完成任务会连带完成子任务，子任务变回待办会让所属任务也变回待办", async (t) => {
  const { request, create, list } = await startTestApp(t);
  const parent = await create({ title: "准备搬家" });
  const first = await create({ title: "打包", parentId: parent.id });
  const second = await create({ title: "订车", parentId: parent.id });
  const other = await create({ title: "买牛奶" });
  const states = async () => (await list()).map((task) => task.done);

  // 子任务全部完成不会自动完成所属任务：它本身可能还有没列出来的事。
  await request("PATCH", "/api/tasks/" + first.id, { done: true });
  await request("PATCH", "/api/tasks/" + second.id, { done: true });
  assert.deepEqual(await states(), [false, true, true, false]);

  await request("PATCH", "/api/tasks/" + second.id, { done: false });
  await request("PATCH", "/api/tasks/" + parent.id, { done: true });
  assert.deepEqual(await states(), [true, true, true, false]);

  await request("PATCH", "/api/tasks/" + first.id, { done: false });
  assert.deepEqual(await states(), [false, false, true, false]);

  await request("PATCH", "/api/tasks/" + parent.id, { done: true });
  await create({ title: "退押金", parentId: parent.id });
  assert.deepEqual(await states(), [false, true, true, false, false]);
  assert.equal(other.done, false);
});

test("删除任务会连同子任务一起删除，删除子任务不影响其他任务", async (t) => {
  const { request, create, list } = await startTestApp(t);
  const parent = await create({ title: "准备搬家" });
  const first = await create({ title: "打包", parentId: parent.id });
  await create({ title: "订车", parentId: parent.id });
  const other = await create({ title: "买牛奶" });

  assert.equal((await request("DELETE", "/api/tasks/" + first.id)).status, 204);
  assert.deepEqual(
    (await list()).map((task) => task.title),
    ["准备搬家", "订车", "买牛奶"],
  );
  assert.equal((await request("DELETE", "/api/tasks/" + parent.id)).status, 204);
  assert.deepEqual(await list(), [other]);
});

test("清单文件里不合法的扩展字段不会让接口出错，也不会被改写", async (t) => {
  const { request, list, filename } = await startTestApp(t);
  const legacy = { id: "a", title: "买牛奶", done: false, priority: 1, dueDate: "尽快", note: "x" };
  await writeFile(filename, JSON.stringify([legacy]));

  assert.deepEqual(await list(), [{ id: "a", title: "买牛奶", done: false }]);
  await request("PATCH", "/api/tasks/a", { done: true });
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), [{ ...legacy, done: true }]);
});

test("展示顺序：逾期和快到期的在前，其次看优先级，已完成的在最后", () => {
  const today = "2026-11-25";
  const tasks: Task[] = [
    { id: "done", title: "买牛奶", done: true, dueDate: "2026-11-01", priority: "high" },
    { id: "plain", title: "读书", done: false },
    { id: "low", title: "订机票", done: false, priority: "low" },
    { id: "parent", title: "准备搬家", done: false },
    { id: "child-done", title: "订车", done: true, parentId: "parent" },
    { id: "child", title: "打包", done: false, parentId: "parent", dueDate: "2026-11-26" },
    { id: "today", title: "交报告", done: false, dueDate: "2026-11-25" },
    { id: "overdue", title: "交电费", done: false, dueDate: "2026-11-23" },
    { id: "high", title: "续签", done: false, priority: "high" },
    { id: "orphan", title: "孤儿", done: false, parentId: "gone" },
  ];
  const arranged = arrangeTasks(tasks, today);
  assert.deepEqual(
    arranged.map(({ task }) => task.id),
    ["overdue", "today", "parent", "high", "low", "plain", "orphan", "done"],
  );
  assert.deepEqual(
    arranged[2]?.subtasks.map((task) => task.id),
    ["child", "child-done"],
  );
});

test("到期提示按距离今天的天数给出", () => {
  const label = (dueDate: string, done = false) =>
    dueLabel({ id: "a", title: "x", done, dueDate }, "2026-12-30");
  assert.equal(label("2026-12-28"), "已逾期 2 天");
  assert.equal(label("2026-12-30"), "今天到期");
  assert.equal(label("2026-12-31"), "明天到期");
  assert.equal(label("2026-12-05"), "已逾期 25 天");
  assert.equal(label("2027-01-03"), "2027年1月3日到期");
  assert.equal(label("2026-12-28", true), undefined);
  assert.equal(todayString(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
