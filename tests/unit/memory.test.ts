import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_MEMORY_DIR = join(import.meta.dir, "../.test-data/memory");

describe("memory", () => {
  beforeEach(() => {
    if (existsSync(join(import.meta.dir, "../.test-data"))) {
      rmSync(join(import.meta.dir, "../.test-data"), { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(join(import.meta.dir, "../.test-data"))) {
      rmSync(join(import.meta.dir, "../.test-data"), { recursive: true });
    }
  });

  describe("initMemory", () => {
    test("creates memory directory structure", async () => {
      const { initMemory } = await import("../../src/memory");
      await initMemory(TEST_MEMORY_DIR);

      expect(existsSync(TEST_MEMORY_DIR)).toBe(true);
      expect(existsSync(join(TEST_MEMORY_DIR, "topics"))).toBe(true);
    });

    test("creates default SOUL.md if not exists", async () => {
      const { initMemory } = await import("../../src/memory");
      await initMemory(TEST_MEMORY_DIR);

      const soulPath = join(TEST_MEMORY_DIR, "SOUL.md");
      expect(existsSync(soulPath)).toBe(true);

      const content = readFileSync(soulPath, "utf-8");
      expect(content).toContain("Identity");
      expect(content).toContain("Core Traits");
    });

    test("creates default USER.md if not exists", async () => {
      const { initMemory } = await import("../../src/memory");
      await initMemory(TEST_MEMORY_DIR);

      const userPath = join(TEST_MEMORY_DIR, "USER.md");
      expect(existsSync(userPath)).toBe(true);

      const content = readFileSync(userPath, "utf-8");
      expect(content).toContain("Name");
      expect(content).toContain("Role");
    });

    test("does not overwrite existing SOUL.md", async () => {
      mkdirSync(TEST_MEMORY_DIR, { recursive: true });
      writeFileSync(join(TEST_MEMORY_DIR, "SOUL.md"), "custom soul");

      const { initMemory } = await import("../../src/memory");
      await initMemory(TEST_MEMORY_DIR);

      const content = readFileSync(join(TEST_MEMORY_DIR, "SOUL.md"), "utf-8");
      expect(content).toBe("custom soul");
    });
  });

  describe("getCoreMemory", () => {
    test("returns soul and user content", async () => {
      mkdirSync(TEST_MEMORY_DIR, { recursive: true });
      writeFileSync(join(TEST_MEMORY_DIR, "SOUL.md"), "I am OpenClaw");
      writeFileSync(join(TEST_MEMORY_DIR, "USER.md"), "User is Alice");

      const { getCoreMemory } = await import("../../src/memory");
      const { soul, user } = await getCoreMemory(TEST_MEMORY_DIR);

      expect(soul).toBe("I am OpenClaw");
      expect(user).toBe("User is Alice");
    });
  });

  describe("recallMemories", () => {
    test("returns empty array when no topics exist", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("hello", TEST_MEMORY_DIR);

      expect(result).toEqual([]);
    });

    test("finds topic by filename keyword match", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/calendar.md"),
        "# Calendar\nMeeting at 3pm"
      );
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/project-alpha.md"),
        "# Project Alpha\nDeadline next week"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("calendar events", TEST_MEMORY_DIR);

      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].name).toBe("calendar.md");
    });

    test("filename match has higher weight than content match", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/calendar.md"),
        "# Calendar\nNothing relevant"
      );
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/notes.md"),
        "# Notes\nThe calendar event was rescheduled"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("calendar", TEST_MEMORY_DIR);

      // calendar.md should rank higher (filename match = 3 pts vs content match = 1 pt)
      expect(result[0].name).toBe("calendar.md");
    });

    test("respects maxFiles limit", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      for (let i = 0; i < 10; i++) {
        writeFileSync(
          join(TEST_MEMORY_DIR, `topics/topic-${i}.md`),
          `# Topic ${i}\nContent about topic`
        );
      }

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("topic content", TEST_MEMORY_DIR, 3);

      expect(result.length).toBeLessThanOrEqual(3);
    });

    test("returns token estimate for each file", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      const content = "a".repeat(400); // ~100 tokens
      writeFileSync(join(TEST_MEMORY_DIR, "topics/test.md"), content);

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("test", TEST_MEMORY_DIR);

      expect(result[0].tokens).toBe(Math.ceil(400 / 4));
    });
  });

  describe("compressToMemory", () => {
    test("creates new topic file", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });

      const { compressToMemory } = await import("../../src/memory");
      await compressToMemory("User prefers morning notifications", "preferences", TEST_MEMORY_DIR);

      const path = join(TEST_MEMORY_DIR, "topics/preferences.md");
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("preferences");
      expect(content).toContain("morning notifications");
    });

    test("appends to existing topic file", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/preferences.md"),
        "# preferences\n\nLikes dark mode"
      );

      const { compressToMemory } = await import("../../src/memory");
      await compressToMemory("Also prefers concise answers", "preferences", TEST_MEMORY_DIR);

      const content = readFileSync(
        join(TEST_MEMORY_DIR, "topics/preferences.md"),
        "utf-8"
      );
      expect(content).toContain("dark mode");
      expect(content).toContain("concise answers");
      expect(content).toContain("---"); // separator
    });

    test("sanitizes topic name for filename", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });

      const { compressToMemory } = await import("../../src/memory");
      await compressToMemory("summary", "Project Alpha (v2)", TEST_MEMORY_DIR);

      const path = join(TEST_MEMORY_DIR, "topics/project-alpha-v2-.md");
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("extractKeywords", () => {
    test("filters stop words and short words", async () => {
      const { extractKeywords } = await import("../../src/memory");
      const keywords = extractKeywords("the quick brown fox is on a hill");

      expect(keywords).toContain("quick");
      expect(keywords).toContain("brown");
      expect(keywords).toContain("fox");
      expect(keywords).toContain("hill");
      expect(keywords).not.toContain("the");
      expect(keywords).not.toContain("is");
      expect(keywords).not.toContain("on");
      expect(keywords).not.toContain("a");
    });

    test("filters words shorter than 3 characters", async () => {
      const { extractKeywords } = await import("../../src/memory");
      const keywords = extractKeywords("go to me an ox by up we do hi");

      // "go", "to", "me", "an", "ox", "by", "up", "we", "do", "hi" are all <= 2 chars
      expect(keywords).toEqual([]);
    });

    test("handles empty string", async () => {
      const { extractKeywords } = await import("../../src/memory");
      const keywords = extractKeywords("");

      expect(keywords).toEqual([]);
    });

    test("lowercases all words (mixed case input)", async () => {
      const { extractKeywords } = await import("../../src/memory");
      const keywords = extractKeywords("Calendar MEETING Project");

      expect(keywords).toContain("calendar");
      expect(keywords).toContain("meeting");
      expect(keywords).toContain("project");
      // Must not contain uppercase variants
      expect(keywords).not.toContain("Calendar");
      expect(keywords).not.toContain("MEETING");
    });

    test("handles special characters and punctuation", async () => {
      const { extractKeywords } = await import("../../src/memory");
      // Punctuation attached to words — split only on whitespace
      const keywords = extractKeywords("hello, world! foo-bar (test)");

      // "hello," "world!" "foo-bar" "(test)" are kept as-is after lowercasing
      // (all > 2 chars, none are stop words)
      expect(keywords.length).toBeGreaterThan(0);
      // Should contain the tokens as split by whitespace
      expect(keywords).toContain("hello,");
      expect(keywords).toContain("world!");
      expect(keywords).toContain("foo-bar");
      expect(keywords).toContain("(test)");
    });

    test("filters all stop words correctly", async () => {
      const { extractKeywords } = await import("../../src/memory");
      const stopOnly = "the and but with for this that are was has had does did will would could should may might can not then";
      const keywords = extractKeywords(stopOnly);

      expect(keywords).toEqual([]);
    });
  });

  describe("scoreRelevance (via recallMemories)", () => {
    test("filename match gives 3x weight", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/calendar.md"),
        "some text"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("calendar", TEST_MEMORY_DIR);

      // "calendar" matches filename → score = 3
      expect(result.length).toBe(1);
      expect(result[0].name).toBe("calendar.md");
      expect(result[0].score).toBe(3);
    });

    test("content-only match gives 1x weight", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/notes.md"),
        "discussed the calendar event"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("calendar", TEST_MEMORY_DIR);

      // "calendar" matches content only → score = 1
      expect(result.length).toBe(1);
      expect(result[0].name).toBe("notes.md");
      expect(result[0].score).toBe(1);
    });

    test("no match gives score 0 and file is excluded", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/recipes.md"),
        "chocolate cake instructions"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("calendar", TEST_MEMORY_DIR);

      // No keyword match → score = 0, filtered out
      expect(result).toEqual([]);
    });

    test("multiple keyword matches accumulate scores", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/project.md"),
        "the deadline sprint is approaching"
      );

      const { recallMemories } = await import("../../src/memory");
      // "project" matches filename (3), "deadline" matches content (1), "sprint" matches content (1)
      const result = await recallMemories("project deadline sprint", TEST_MEMORY_DIR);

      expect(result.length).toBe(1);
      expect(result[0].name).toBe("project.md");
      expect(result[0].score).toBe(5); // 3 + 1 + 1
    });

    test("case insensitive matching", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/Meeting.md"),
        "WEEKLY STANDUP notes"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("meeting standup", TEST_MEMORY_DIR);

      // "meeting" matches filename (case insensitive) → 3
      // "standup" matches content (case insensitive) → 1
      expect(result.length).toBe(1);
      expect(result[0].score).toBe(4);
    });
  });

  describe("getCoreMemory error handling", () => {
    test("throws when SOUL.md does not exist", async () => {
      mkdirSync(TEST_MEMORY_DIR, { recursive: true });
      // Only create USER.md, no SOUL.md
      writeFileSync(join(TEST_MEMORY_DIR, "USER.md"), "User data");

      const { getCoreMemory } = await import("../../src/memory");
      await expect(getCoreMemory(TEST_MEMORY_DIR)).rejects.toThrow();
    });

    test("throws when USER.md does not exist", async () => {
      mkdirSync(TEST_MEMORY_DIR, { recursive: true });
      // Only create SOUL.md, no USER.md
      writeFileSync(join(TEST_MEMORY_DIR, "SOUL.md"), "Soul data");

      const { getCoreMemory } = await import("../../src/memory");
      await expect(getCoreMemory(TEST_MEMORY_DIR)).rejects.toThrow();
    });
  });

  describe("recallMemories edge cases", () => {
    test("returns empty when topics directory does not exist", async () => {
      // Don't create any directory at all
      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("anything", TEST_MEMORY_DIR);

      expect(result).toEqual([]);
    });

    test("returns empty when topics directory has no .md files", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(join(TEST_MEMORY_DIR, "topics/readme.txt"), "not a markdown file");

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("readme", TEST_MEMORY_DIR);

      expect(result).toEqual([]);
    });

    test("returns empty array when maxFiles is 0", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/topic.md"),
        "some content about topic"
      );

      const { recallMemories } = await import("../../src/memory");
      const result = await recallMemories("topic content", TEST_MEMORY_DIR, 0);

      expect(result).toEqual([]);
    });

    test("returns empty when query has no matching keywords (all stop words)", async () => {
      mkdirSync(join(TEST_MEMORY_DIR, "topics"), { recursive: true });
      writeFileSync(
        join(TEST_MEMORY_DIR, "topics/data.md"),
        "important information here"
      );

      const { recallMemories } = await import("../../src/memory");
      // All words are stop words or <= 2 chars → no keywords extracted → early return []
      const result = await recallMemories("the is a on it", TEST_MEMORY_DIR);

      expect(result).toEqual([]);
    });
  });
});
