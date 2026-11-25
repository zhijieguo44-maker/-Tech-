import type { Effort, Priority, Task } from "./task.ts";

// 这个文件只引用类型，浏览器端可以直接使用而不必打包校验库。
export const priorityLabels: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
export const effortLabels: Record<Effort, string> = { small: "小", medium: "中", large: "大" };

export interface TaskNode {
  task: Task;
  subtasks: Task[];
}

// 以运行环境的本地时区为准的「今天」，格式 YYYY-MM-DD。
export function todayString(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function dayNumber(date: string) {
  return Date.parse(date + "T00:00:00Z") / 86_400_000;
}

// 距离到期还有几天：0 是今天，负数表示已经逾期。
export function daysUntil(dueDate: string, today: string): number {
  return Math.round(dayNumber(dueDate) - dayNumber(today));
}

// 未完成任务的到期提示；没有到期日或已完成时不提示。
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

// 把清单整理成「最需要处理的排最前」的顺序：未完成在前；其中到期日越早越靠前（逾期自然排在最前），
// 没有到期日的排在有到期日的后面；再按优先级；最后保持创建顺序。子任务跟在所属任务下面。
export function arrangeTasks(tasks: Task[], today: string): TaskNode[] {
  const ids = new Set(tasks.map((task) => task.id));
  const isSubtask = (task: Task) => task.parentId !== undefined && ids.has(task.parentId);
  const order = new Map(tasks.map((task, index) => [task.id, index]));

  function compare(a: { task: Task; group: Task[] }, b: { task: Task; group: Task[] }) {
    if (a.task.done !== b.task.done) return a.task.done ? 1 : -1;
    if (!a.task.done) {
      // 不能直接相减：两边都没有到期日时是 Infinity - Infinity，得到 NaN。
      const [dueA, dueB] = [urgency(a.group), urgency(b.group)];
      if (dueA !== dueB) return dueA < dueB ? -1 : 1;
      const priority = importance(a.group) - importance(b.group);
      if (priority !== 0) return priority;
    }
    return (order.get(a.task.id) ?? 0) - (order.get(b.task.id) ?? 0);
  }

  // 一条任务的紧急程度要算上它未完成的子任务：子任务明天到期，整件事就得排在前面。
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
