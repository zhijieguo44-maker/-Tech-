import { useEffect, useState } from "react";
import type { Task } from "../shared/task.ts";
import {
  arrangeTasks,
  daysUntil,
  dueLabel,
  effortLabels,
  needsAttention,
  priorityLabels,
  todayString,
  type TaskNode,
} from "../shared/task-view.ts";
import { requestTasks } from "./chat-client.ts";

interface TaskPanelProps {
  // 值变化时重新读取清单。
  refreshKey: number;
}

function TaskRow({ task, today, progress }: { task: Task; today: string; progress?: string }) {
  const due = dueLabel(task, today);
  const overdue = due !== undefined && daysUntil(task.dueDate!, today) < 0;
  return (
    <div className={task.done ? "task done" : "task"}>
      <span className="box" aria-hidden="true">
        {task.done ? "✓" : ""}
      </span>
      <span className="title">
        <span className="state">{task.done ? "已完成：" : "待办："}</span>
        {task.title}
      </span>
      {!task.done && (
        <span className="tags">
          {due && (
            <em className={overdue ? "overdue" : needsAttention(task, today) ? "today" : ""}>
              {due}
            </em>
          )}
          {task.priority && (
            <em className={task.priority === "high" ? "high" : ""}>
              {priorityLabels[task.priority]}优先级
            </em>
          )}
          {task.effort && <em>工作量{effortLabels[task.effort]}</em>}
          {progress && <em>{progress}</em>}
        </span>
      )}
    </div>
  );
}

function TaskGroup({ title, nodes, today }: { title: string; nodes: TaskNode[]; today: string }) {
  if (nodes.length === 0) return null;
  return (
    <section>
      <h2>
        {title}
        <span>{nodes.length}</span>
      </h2>
      <ul>
        {nodes.map(({ task, subtasks }) => (
          <li key={task.id}>
            <TaskRow
              task={task}
              today={today}
              progress={
                subtasks.length > 0
                  ? `子任务 ${subtasks.filter((item) => item.done).length}/${subtasks.length}`
                  : undefined
              }
            />
            {subtasks.length > 0 && (
              <ul>
                {subtasks.map((item) => (
                  <li key={item.id}>
                    <TaskRow task={item} today={today} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TaskPanel({ refreshKey }: TaskPanelProps) {
  const [tasks, setTasks] = useState<Task[]>();
  const [failed, setFailed] = useState(false);
  // 窄屏上默认收起，不挤占聊天区域。
  const [open, setOpen] = useState(() => window.matchMedia("(min-width: 900px)").matches);

  useEffect(() => {
    let current = true;
    const load = () =>
      requestTasks().then(
        (list) => {
          if (!current) return;
          setTasks(list);
          setFailed(false);
        },
        () => current && setFailed(true),
      );
    void load();
    // 清单也可能在别的页面被修改，回到这个页面时重新读取。
    window.addEventListener("focus", load);
    return () => {
      current = false;
      window.removeEventListener("focus", load);
    };
  }, [refreshKey]);

  const today = todayString();
  const nodes = arrangeTasks(tasks ?? [], today);
  const urgent = nodes.filter(({ task, subtasks }) =>
    [task, ...subtasks].some((item) => needsAttention(item, today)),
  );
  const todo = nodes.filter((node) => !node.task.done && !urgent.includes(node));
  const done = nodes.filter((node) => node.task.done && !urgent.includes(node));
  const remaining = urgent.length + todo.length;

  let summary = "正在读取…";
  if (failed && !tasks) summary = "读取失败";
  else if (tasks) {
    summary = remaining === 0 ? "没有待办" : `${remaining} 件待办`;
    if (urgent.length > 0) summary += `，${urgent.length} 件需要尽快处理`;
  }

  return (
    <aside className={open ? "panel open" : "panel"} aria-label="任务清单">
      <button className="panel-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <strong>我的清单</strong>
        <span className={urgent.length > 0 ? "alert" : ""}>{summary}</span>
        <i aria-hidden="true">{open ? "收起" : "展开"}</i>
      </button>
      {open && (
        <div className="panel-body">
          {failed && <p className="error">清单读取失败，回复下一条消息后会重试。</p>}
          {tasks?.length === 0 && (
            <p className="empty">清单是空的。对小明说「帮我记一下买牛奶」试试。</p>
          )}
          <TaskGroup title="需要尽快处理" nodes={urgent} today={today} />
          <TaskGroup title="待办" nodes={todo} today={today} />
          <TaskGroup title="已完成" nodes={done} today={today} />
        </div>
      )}
    </aside>
  );
}
