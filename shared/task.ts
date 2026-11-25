import { z } from "zod";

export const priorities = ["high", "medium", "low"] as const;
export const efforts = ["small", "medium", "large"] as const;
export type Priority = (typeof priorities)[number];
export type Effort = (typeof efforts)[number];

// 到期日只精确到天，写作 YYYY-MM-DD，并且必须是日历上真实存在的一天。
export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
export const prioritySchema = z.enum(priorities);
export const effortSchema = z.enum(efforts);

export interface Task {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: Priority;
  effort?: Effort;
  // 有值表示这是一条子任务，指向所属的任务。子任务不能再有子任务。
  parentId?: string;
}

interface StoredTask {
  id: string;
  title: string;
  done: boolean;
  [field: string]: unknown;
}

// 清单文件可能来自旧版本或被手工改过。不认识、不合法的扩展字段当作没有设置，
// 而不是让整份清单读不出来；文件里的原值保持不动。
export function toTask(stored: StoredTask): Task {
  const task: Task = { id: stored.id, title: stored.title, done: stored.done };
  const dueDate = dueDateSchema.safeParse(stored.dueDate);
  if (dueDate.success) task.dueDate = dueDate.data;
  const priority = prioritySchema.safeParse(stored.priority);
  if (priority.success) task.priority = priority.data;
  const effort = effortSchema.safeParse(stored.effort);
  if (effort.success) task.effort = effort.data;
  if (typeof stored.parentId === "string" && stored.parentId) task.parentId = stored.parentId;
  return task;
}
