import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = "/api";

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Sessions ────────────────────────────────────────

interface Session {
  id: string;
  thread_id: string;
  user_id: string;
  status: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}

interface Message {
  role: string;
  content: string;
  timestamp: number;
}

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => fetchJSON<Session[]>(`${BASE}/sessions`),
    refetchInterval: 5000,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["sessions", id],
    queryFn: () => fetchJSON<Session>(`${BASE}/sessions/${id}`),
  });
}

export function useSessionMessages(id: string) {
  return useQuery({
    queryKey: ["sessions", id, "messages"],
    queryFn: () => fetchJSON<Message[]>(`${BASE}/sessions/${id}/messages`),
    refetchInterval: 2000,
  });
}

// ── Tasks ───────────────────────────────────────────

interface Task {
  id: string;
  name: string;
  cron_expr: string | null;
  prompt: string;
  enabled: number;
  last_run: number | null;
  created_at: number;
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: () => fetchJSON<Task[]>(`${BASE}/tasks`),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Task>) =>
      fetch(`${BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetch(`${BASE}/tasks/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

// ── Logs ────────────────────────────────────────────

interface Log {
  id: number;
  level: string;
  source: string;
  message: string;
  metadata: string | null;
  created_at: number;
}

export function useLogs(limit = 100) {
  return useQuery({
    queryKey: ["logs", limit],
    queryFn: () => fetchJSON<Log[]>(`${BASE}/logs?limit=${limit}`),
    refetchInterval: 10000,
  });
}

// ── Memory ──────────────────────────────────────────

export function useMemory() {
  return useQuery({
    queryKey: ["memory"],
    queryFn: () => fetchJSON<{ soul: string; user: string }>(`${BASE}/memory`),
  });
}
