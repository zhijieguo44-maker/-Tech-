import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Task } from "../shared/task.ts";

// 只要求 id、title、done 三个字段合法，其余字段原样保留，旧清单和手工添加的字段都不会丢。
const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);
type StoredTask = z.infer<typeof storedTask>;

export type NewTask = Pick<Task, "title"> &
  Partial<Pick<Task, "dueDate" | "priority" | "effort" | "parentId">>;
// null 表示清除这个字段。
export type TaskChanges = Partial<Pick<Task, "title" | "done">> & {
  [Field in "dueDate" | "priority" | "effort"]?: Task[Field] | null;
};

export interface TaskStore {
  list(): StoredTask[];
  get(id: string): StoredTask | undefined;
  create(input: NewTask): StoredTask;
  update(id: string, changes: TaskChanges): StoredTask | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): StoredTask[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: StoredTask[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    get(id) {
      return list().find((task) => task.id === id);
    },

    create(input) {
      const tasks = list();
      const task: StoredTask = { id: randomUUID(), title: input.title, done: false };
      for (const field of ["dueDate", "priority", "effort", "parentId"] as const) {
        if (input[field] !== undefined) task[field] = input[field];
      }
      // 已完成的任务多了一条没做的子任务，它就不再算完成。
      const parent = tasks.find((item) => item.id === input.parentId);
      if (parent) parent.done = false;
      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      for (const [field, value] of Object.entries(changes)) {
        if (value === null) delete task[field];
        else if (value !== undefined) task[field] = value;
      }
      if (changes.done === true) {
        // 整件事做完了，它的子任务也一并算完成。
        for (const item of tasks) if (item.parentId === id) item.done = true;
      }
      if (changes.done === false) {
        // 子任务重新变成待办，所属任务也不能算完成。
        const parent = tasks.find((item) => item.id === task.parentId);
        if (parent) parent.done = false;
      }
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      if (!tasks.some((task) => task.id === id)) return false;
      // 删除任务时连同它的子任务一起删除，不留下找不到归属的子任务。
      save(tasks.filter((task) => task.id !== id && task.parentId !== id));
      return true;
    },
  };
}
