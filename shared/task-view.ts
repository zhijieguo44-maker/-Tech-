import type { Effort, Priority, Task } from "./task.ts";

export const priorityLabels: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
export const effortLabels: Record<Effort, string> = { small: "小", medium: "中", large: "大" };

export interface TaskNode {
  task: Task;
  subtasks: Task[];
}

export function todayString(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function dayNumber(date: string) {
  return Date.parse(date + "T00:00:00Z") / 86_400_000;
}

export function daysUntil(dueDate: string, today: string): number {
  return Math.round(dayNumber(dueDate) - dayNumber(today));
}

export function dueLabel(task: Task, today: string): string | undefined {
  if (!task.dueDate || task.done) return undefined;
  const days = daysUntil(task.dueDate, today);
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  const [year, month, day] = task.dueDate.split("-").map(Number);
  const date = `${month}月${day}日`;
  return (task.dueDate.slice(0, 4) === today.slice(0, 4) ? date : `${year}年${date}`) + "到期";
}

export function needsAttention(task: Task, today: string): boolean {
  return !task.done && task.dueDate !== undefined && daysUntil(task.dueDate, today) <= 0;
}

const priorityRank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function arrangeTasks(tasks: Task[], today: string): TaskNode[] {
  const ids = new Set(tasks.map((task) => task.id));
  const isSubtask = (task: Task) => task.parentId !== undefined && ids.has(task.parentId);
  const order = new Map(tasks.map((task, index) => [task.id, index]));

  function compare(a: { task: Task; group: Task[] }, b: { task: Task; group: Task[] }) {
    if (a.task.done !== b.task.done) return a.task.done ? 1 : -1;
    if (!a.task.done) {
      const [dueA, dueB] = [urgency(a.group), urgency(b.group)];
      if (dueA !== dueB) return dueA < dueB ? -1 : 1;
      const priority = importance(a.group) - importance(b.group);
      if (priority !== 0) return priority;
    }
    return (order.get(a.task.id) ?? 0) - (order.get(b.task.id) ?? 0);
  }

  function urgency(group: Task[]) {
    const days = group
      .filter((task) => !task.done && task.dueDate)
      .map((task) => daysUntil(task.dueDate!, today));
    return days.length ? Math.min(...days) : Number.POSITIVE_INFINITY;
  }

  function importance(group: Task[]) {
    const ranks = group
      .filter((task) => !task.done && task.priority)
      .map((task) => priorityRank[task.priority!]);
    return ranks.length ? Math.min(...ranks) : 3;
  }

  return tasks
    .filter((task) => !isSubtask(task))
    .map((task) => {
      const subtasks = tasks
        .filter((item) => item.parentId === task.id)
        .map((item) => ({ task: item, group: [item] }))
        .sort(compare)
        .map((item) => item.task);
      return { task, group: [task, ...subtasks], subtasks };
    })
    .sort(compare)
    .map(({ task, subtasks }) => ({ task, subtasks }));
}
