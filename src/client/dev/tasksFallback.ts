/**
 * Offline placeholder — not the live TASKS.yaml roadmap.
 * Live tasks load from GitHub. Client version is package.json only.
 */
import type { TasksRegistry } from './tasksRegistry'

export const TASKS_FALLBACK: TasksRegistry = {
  schema_version: 1,
  tasks: []
}
