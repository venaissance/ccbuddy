import { useState } from "react";
import { useTasks, useCreateTask, useDeleteTask } from "../lib/api";

export function Scheduler() {
  const { data: tasks, isLoading } = useTasks();
  const createTask = useCreateTask();
  const deleteTask = useDeleteTask();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState("");
  const [prompt, setPrompt] = useState("");

  function handleCreate() {
    if (!name || !prompt) return;
    createTask.mutate({
      id: `task_${Date.now()}`,
      name,
      cron_expr: cronExpr || null,
      prompt,
      enabled: 1,
    });
    setName("");
    setCronExpr("");
    setPrompt("");
    setShowForm(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Scheduler</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
        >
          + New Task
        </button>
      </div>

      {showForm && (
        <div className="mb-4 p-4 bg-gray-900 rounded-lg border border-gray-800 space-y-3">
          <input
            placeholder="Task name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm border border-gray-700 focus:border-emerald-500 outline-none"
          />
          <input
            placeholder="Cron expression (e.g. */30 * * * *)"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.target.value)}
            className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm border border-gray-700 focus:border-emerald-500 outline-none"
          />
          <textarea
            placeholder="Prompt to send to Agent"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 bg-gray-800 rounded-lg text-sm border border-gray-700 focus:border-emerald-500 outline-none resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 rounded-lg"
            >
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 rounded-lg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && <p className="text-gray-500">Loading...</p>}

      <div className="flex flex-col gap-2">
        {tasks?.map((task) => (
          <div
            key={task.id}
            className="flex items-center gap-3 p-4 rounded-lg bg-gray-900 border border-gray-800"
          >
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                task.enabled ? "bg-emerald-500" : "bg-gray-600"
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{task.name}</div>
              <div className="text-xs text-gray-500 font-mono">
                {task.cron_expr || "manual"}
              </div>
            </div>
            <div className="text-xs text-gray-600">
              {task.last_run
                ? `Last: ${new Date(task.last_run).toLocaleString()}`
                : "Never run"}
            </div>
            <button
              onClick={() => deleteTask.mutate(task.id)}
              className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
            >
              Delete
            </button>
          </div>
        ))}

        {tasks?.length === 0 && (
          <p className="text-gray-500 text-sm">No scheduled tasks.</p>
        )}
      </div>
    </div>
  );
}
