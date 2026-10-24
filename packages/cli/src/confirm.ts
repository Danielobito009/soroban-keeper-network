import { createInterface } from "node:readline/promises";

/** Asks the user to confirm an operation before submitting a transaction. */
export type ConfirmFn = (question: string) => Promise<boolean>;

/**
 * Interactive confirmation prompt on `process.stdin` / `process.stderr` when
 * stdin is a terminal.
 */
export function terminalConfirm(): ConfirmFn | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(question)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}
