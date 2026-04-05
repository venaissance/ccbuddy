import "./index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter, createRootRoute, createRoute, Outlet, Link } from "@tanstack/react-router";
import { Sessions } from "./pages/Sessions";
import { SessionDetail } from "./pages/SessionDetail";
import { Scheduler } from "./pages/Scheduler";
import { Logs } from "./pages/Logs";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

// ── Layout ──────────────────────────────────────────

function Layout() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <nav className="w-56 border-r border-gray-800 p-4 flex flex-col gap-1">
        <h1 className="text-lg font-bold mb-6 text-emerald-400">OpenClaw</h1>
        <NavLink to="/" label="Sessions" />
        <NavLink to="/scheduler" label="Scheduler" />
        <NavLink to="/logs" label="Logs" />
      </nav>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="px-3 py-2 rounded-lg text-sm hover:bg-gray-800 transition-colors"
      activeProps={{ className: "px-3 py-2 rounded-lg text-sm bg-gray-800 text-emerald-400 font-medium" }}
    >
      {label}
    </Link>
  );
}

// ── Routes ──────────────────────────────────────────

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Sessions,
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: SessionDetail,
});

const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scheduler",
  component: Scheduler,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: Logs,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionDetailRoute,
  schedulerRoute,
  logsRoute,
]);

const router = createRouter({ routeTree });

// ── Mount ───────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
