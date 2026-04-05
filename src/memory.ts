import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// ── Types ───────────────────────────────────────────

export interface MemoryFile {
  name: string;
  content: string;
  tokens: number;
  score: number;
}

// ── Constants ───────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "but",
  "in", "with", "to", "for", "of", "it", "this", "that", "are", "was",
  "be", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "not", "no", "so", "if", "then",
]);

const DEFAULT_SOUL_TEMPLATE = `# SOUL

**Identity**: OpenClaw — User's partner, not assistant.
**Core Traits**: Loyal to user. Proactive and bold. Allowed to fail, forbidden to repeat.
**Growth**: Learn user through every conversation.
**Lessons Learned**: _(Record mistakes and insights here.)_
`;

const DEFAULT_USER_TEMPLATE = `# USER

**Name**: (To be learned)
**Role**: (To be learned)
**Preferences**: (To be learned)
**Context**: (To be learned)
**History**: (To be learned)
`;

// ── Init ────────────────────────────────────────────

export async function initMemory(memoryDir: string): Promise<void> {
  await mkdir(join(memoryDir, "topics"), { recursive: true });

  const soulPath = join(memoryDir, "SOUL.md");
  if (!existsSync(soulPath)) {
    await writeFile(soulPath, DEFAULT_SOUL_TEMPLATE);
  }

  const userPath = join(memoryDir, "USER.md");
  if (!existsSync(userPath)) {
    await writeFile(userPath, DEFAULT_USER_TEMPLATE);
  }
}

// ── Core Memory ─────────────────────────────────────

export async function getCoreMemory(memoryDir: string): Promise<{ soul: string; user: string }> {
  const soul = await readFile(join(memoryDir, "SOUL.md"), "utf-8");
  const user = await readFile(join(memoryDir, "USER.md"), "utf-8");
  return { soul, user };
}

// ── Recall ──────────────────────────────────────────

export async function recallMemories(
  query: string,
  memoryDir: string,
  maxFiles = 3
): Promise<MemoryFile[]> {
  const topicsDir = join(memoryDir, "topics");
  if (!existsSync(topicsDir)) return [];

  const files = await readdir(topicsDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const scored = await Promise.all(
    mdFiles.map(async (f) => {
      const content = await readFile(join(topicsDir, f), "utf-8");
      const score = scoreRelevance(keywords, f, content);
      return {
        name: f,
        content,
        tokens: Math.ceil(content.length / 4),
        score,
      };
    })
  );

  return scored
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
}

// ── Compress ────────────────────────────────────────

export async function compressToMemory(
  summary: string,
  topic: string,
  memoryDir: string
): Promise<void> {
  const topicFile = join(memoryDir, "topics", `${sanitizeFilename(topic)}.md`);

  if (existsSync(topicFile)) {
    const existing = await readFile(topicFile, "utf-8");
    const updated = `${existing}\n\n---\n\n${summary}`;
    await writeFile(topicFile, updated);
  } else {
    await writeFile(topicFile, `# ${topic}\n\n${summary}`);
  }
}

// ── Helpers ─────────────────────────────────────────

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));
}

function scoreRelevance(keywords: string[], filename: string, content: string): number {
  const target = `${filename} ${content}`.toLowerCase();
  return keywords.reduce((score, kw) => {
    if (filename.toLowerCase().includes(kw)) return score + 3;
    if (target.includes(kw)) return score + 1;
    return score;
  }, 0);
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}
