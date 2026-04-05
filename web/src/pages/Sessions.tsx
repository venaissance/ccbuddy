import { Link } from "@tanstack/react-router";
import { useSessions } from "../lib/api";

const STATUS_COLORS: Record<string, string> = {
  idle: "bg-blue-500",
  active: "bg-yellow-500",
  streaming: "bg-emerald-500 animate-pulse",
  completed: "bg-gray-500",
  error: "bg-red-500",
};

export function Sessions() {
  const { data: sessions, isLoading } = useSessions();

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Sessions</h2>

      {isLoading && <p className="text-gray-500">Loading...</p>}

      <div className="flex flex-col gap-2">
        {sessions?.map((s) => (
          <Link
            key={s.id}
            to="/sessions/$id"
            params={{ id: s.id }}
            className="flex items-center gap-3 p-4 rounded-lg bg-gray-900 hover:bg-gray-800 transition-colors border border-gray-800"
          >
            <span
              className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[s.status] || "bg-gray-500"}`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {s.thread_id}
              </div>
              <div className="text-xs text-gray-500">
                {s.user_id} · {s.message_count} messages
              </div>
            </div>
            <div className="text-xs text-gray-600">
              {formatTime(s.updated_at)}
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
              {s.status}
            </span>
          </Link>
        ))}

        {sessions?.length === 0 && (
          <p className="text-gray-500 text-sm">No sessions yet.</p>
        )}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;

  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}
