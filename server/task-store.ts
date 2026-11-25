import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask);
type Task = z.infer<typeof storedTask>;
type TaskChanges = Partial<Pick<Task, "title" | "done">>;

export interface TaskStore {
  list(): Task[];
  create(title: string): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title) {
      const task = { id: randomUUID(), title, done: false };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id);
      if (remaining.length === tasks.length) return false;

      save(remaining);
      return true;
    },
  };
}
