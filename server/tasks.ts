import { Router } from "express";
import { z } from "zod";
import { dueDateSchema, effortSchema, prioritySchema, toTask } from "../shared/task.ts";
import type { TaskStore } from "./task-store.ts";

const title = z.string().trim().min(1).max(200);
const createTaskSchema = z.strictObject({
  title,
  dueDate: dueDateSchema.optional(),
  priority: prioritySchema.optional(),
  effort: effortSchema.optional(),
  parentId: z.string().min(1).optional(),
});
// dueDate、priority、effort 传 null 表示清除。子任务不能改挂到别的任务下，所以没有 parentId。
const updateTaskSchema = z
  .strictObject({
    title: title.optional(),
    done: z.boolean().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    priority: prioritySchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

const fieldErrors: Record<string, string> = {
  title: "请提供 1 至 200 个字符的任务标题。",
  done: "done 需要是 true 或 false。",
  dueDate: "到期日需要是 YYYY-MM-DD 格式的有效日期。",
  priority: "优先级只能是 high、medium 或 low。",
  effort: "工作量只能是 small、medium 或 large。",
  parentId: "parentId 需要是所属任务的 id。",
};

// 指出第一个有问题的字段，调用方（包括智能体）才知道该改什么。
function describe(error: z.ZodError, fallback: string) {
  const issue = error.issues[0];
  if (issue?.code === "unrecognized_keys") return `不支持的字段：${issue.keys.join("、")}。`;
  return fieldErrors[String(issue?.path[0])] ?? fallback;
}

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list().map(toTask));
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: describe(input.error, fieldErrors.title!) });
    }
    if (input.data.parentId !== undefined) {
      const parent = tasks.get(input.data.parentId);
      if (!parent) return res.status(404).json({ error: "找不到要添加子任务的那条任务。" });
      if (toTask(parent).parentId !== undefined) {
        return res.status(400).json({ error: "子任务下面不能再添加子任务。" });
      }
    }
    res.status(201).json(toTask(tasks.create(input.data)));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      const fallback = "请提供至少一个要修改的字段。";
      return res.status(400).json({ error: describe(input.error, fallback) });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(toTask(updated));
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
