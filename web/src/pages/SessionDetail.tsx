import { useParams, Link } from "@tanstack/react-router";
import { useSession, useSessionMessages } from "../lib/api";

export function SessionDetail() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: session } = useSession(id);
  const { data: messages, isLoading } = useSessionMessages(id);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-gray-500 hover:text-gray-300 text-sm">
          ← Back
        </Link>
        <h2 className="text-xl font-semibold">Session {id?.slice(0, 16)}</h2>
        {session && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
            {session.status}
          </span>
        )}
      </div>

      {isLoading && <p className="text-gray-500">Loading messages...</p>}

      <div className="flex flex-col gap-3 max-w-3xl">
        {messages?.map((msg, i) => (
          <div
            key={i}
            className={`p-3 rounded-lg text-sm leading-relaxed ${
              msg.role === "user"
                ? "bg-blue-950 border border-blue-800 ml-12"
                : msg.role === "assistant"
                ? "bg-gray-900 border border-gray-800 mr-12"
                : "bg-emerald-950 border border-emerald-800 text-xs"
            }`}
          >
            <div className="text-xs text-gray-500 mb-1 font-medium uppercase">
              {msg.role}
            </div>
            <div className="whitespace-pre-wrap">{msg.content}</div>
            <div className="text-xs text-gray-600 mt-1">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}

        {messages?.length === 0 && (
          <p className="text-gray-500 text-sm">No messages in this session.</p>
        )}
      </div>
    </div>
  );
}
