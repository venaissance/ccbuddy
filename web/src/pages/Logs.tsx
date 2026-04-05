import { useState } from "react";
import { useLogs } from "../lib/api";

const LEVEL_COLORS: Record<string, string> = {
  info: "text-gray-400",
  warn: "text-yellow-400",
  error: "text-red-400",
};

const SOURCE_COLORS: Record<string, string> = {
  agent: "text-purple-400",
  cron: "text-orange-400",
  "feishu-ws": "text-blue-400",
  memory: "text-teal-400",
};

export function Logs() {
  const [limit, setLimit] = useState(100);
  const { data: logs, isLoading } = useLogs(limit);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Logs</h2>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="px-3 py-1.5 text-sm bg-gray-800 rounded-lg border border-gray-700 outline-none"
        >
          <option value={50}>50 entries</option>
          <option value={100}>100 entries</option>
          <option value={500}>500 entries</option>
        </select>
      </div>

      {isLoading && <p className="text-gray-500">Loading...</p>}

      <div className="font-mono text-xs space-y-0.5">
        {logs?.map((log) => (
          <div
            key={log.id}
            className="flex gap-2 py-1 px-2 rounded hover:bg-gray-900"
          >
            <span className="text-gray-600 w-20 shrink-0">
              {new Date(log.created_at).toLocaleTimeString()}
            </span>
            <span
              className={`w-12 shrink-0 uppercase font-bold ${
                LEVEL_COLORS[log.level] || "text-gray-400"
              }`}
            >
              {log.level}
            </span>
            <span
              className={`w-20 shrink-0 ${
                SOURCE_COLORS[log.source] || "text-gray-400"
              }`}
            >
              {log.source}
            </span>
            <span className="text-gray-300 flex-1">{log.message}</span>
            {log.metadata && (
              <span className="text-gray-600 truncate max-w-48">
                {log.metadata}
              </span>
            )}
          </div>
        ))}

        {logs?.length === 0 && (
          <p className="text-gray-500">No logs yet.</p>
        )}
      </div>

      {logs && logs.length >= limit && (
        <button
          onClick={() => setLimit((l) => l + 100)}
          className="mt-4 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg"
        >
          Load More
        </button>
      )}
    </div>
  );
}
