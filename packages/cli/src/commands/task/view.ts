import { TaskStatus, TaskType, type Task } from "@soroban-keeper-network/sdk";

export function statusName(status: TaskStatus): string {
  return TaskStatus[status]?.toLowerCase() ?? `unknown(${status})`;
}

export function taskTypeName(type: TaskType): string {
  return TaskType[type] ?? `unknown(${type})`;
}

export interface TaskView {
  id: bigint;
  status: string;
  type: string;
  owner: string;
  reward: bigint;
  deadline: string;
  claimer: string | null;
  claimLedger: number | null;
  lockLedgers: number;
}

export function taskView(taskId: bigint, task: Task): TaskView {
  return {
    id: taskId,
    status: statusName(task.status),
    type: taskTypeName(task.taskType),
    owner: task.owner,
    reward: task.reward,
    deadline: new Date(Number(task.deadline) * 1000).toISOString(),
    claimer: task.claimer ?? null,
    claimLedger: task.claimLedger ?? null,
    lockLedgers: task.lockLedgers,
  };
}

/** The task's state as lines of text, printed after every task command. */
export function taskLines(view: TaskView): string[] {
  const lines = [
    `Task ${view.id}`,
    `  status:   ${view.status}`,
    `  type:     ${view.type}`,
    `  owner:    ${view.owner}`,
    `  reward:   ${view.reward}`,
    `  deadline: ${view.deadline}`,
  ];
  if (view.claimer !== null) {
    lines.push(
      `  claimer:  ${view.claimer} (claimed at ledger ${view.claimLedger}, lock ${view.lockLedgers} ledgers)`,
    );
  }
  return lines;
}
