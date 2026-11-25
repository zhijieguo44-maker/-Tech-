import { z } from "zod";

export const priorities = ["high", "medium", "low"] as const;
export const efforts = ["small", "medium", "large"] as const;
export type Priority = (typeof priorities)[number];
export type Effort = (typeof efforts)[number];

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
  parentId?: string;
}

interface StoredTask {
  id: string;
  title: string;
  done: boolean;
  [field: string]: unknown;
}

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
