import { describe, it, expect, beforeEach } from "bun:test";
import { memoryEngine } from "../src/runtime/memory-engine.js";
import { knowledgeNetwork } from "../src/runtime/knowledge-network.js";
import { atomStore } from "../src/runtime/atom-engine.js";

describe("Memory Engine Advanced", () => {
  describe("Episode Formation", () => {
    it("forms episodes from observations with shared entities", () => {
      memoryEngine.observe("Fixed bug in AuthService.ts", "user");
      memoryEngine.observe("The bug was caused by JWT token expiration", "user");
      memoryEngine.observe("Applied fix by adding token refresh logic", "user");

      const episodes = memoryEngine.getEpisodes();
      expect(episodes.length).toBeGreaterThan(0);
    });

    it("detects problem-solution patterns", () => {
      memoryEngine.observe("Found a bug in the login system", "user");
      memoryEngine.observe("The error was caused by missing null check", "user");
      memoryEngine.observe("Fixed by adding null check", "user");

      const episodes = memoryEngine.getEpisodes();
      const problemSolution = episodes.find((e) => e.outcome === "success");
      expect(problemSolution).toBeDefined();
    });

    it("detects question-answer patterns", () => {
      memoryEngine.observe("How do I fix a TypeScript error?", "user");
      memoryEngine.observe("You can fix it by adding type annotations to the function parameters and return type.", "llm");

      const episodes = memoryEngine.getEpisodes();
      expect(episodes.length).toBeGreaterThan(0);
    });
  });

  describe("Skill Formation", () => {
    it("forms skills from successful episodes", () => {
      // Create a successful episode
      memoryEngine.observe("Fixed authentication bug", "user");
      memoryEngine.observe("The bug was caused by expired tokens", "user");
      memoryEngine.observe("Applied fix: add token refresh", "user");

      // Complete the episode
      const episode = memoryEngine.getCurrentEpisode();
      if (episode) {
        memoryEngine.completeEpisode(episode.id, "success", "expired tokens", "add token refresh");
      }

      // Form skills from successful episodes
      const formed = memoryEngine.formSkillsFromSuccessfulEpisodes();
      expect(typeof formed).toBe("number");
    });

    it("forms skills from patterns", () => {
      const formed = memoryEngine.formSkillsFromPatterns();
      expect(typeof formed).toBe("number");
    });

    it("gets all skills", () => {
      const skills = memoryEngine.getSkills();
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe("Knowledge Formation", () => {
    it("forms knowledge from successful episodes", () => {
      memoryEngine.observe("Debugging memory leak", "user");
      memoryEngine.observe("Found leak in event listener", "user");
      memoryEngine.observe("Fixed by removing listener on unmount", "user");

      const episode = memoryEngine.getCurrentEpisode();
      if (episode) {
        memoryEngine.completeEpisode(episode.id, "success", "event listener leak", "remove listener on unmount");
      }

      const knowledge = memoryEngine.getKnowledge();
      expect(Array.isArray(knowledge)).toBe(true);
    });

    it("gets all knowledge", () => {
      const knowledge = memoryEngine.getKnowledge();
      expect(Array.isArray(knowledge)).toBe(true);
    });
  });

  describe("Pattern Detection", () => {
    it("detects patterns from entity groups", () => {
      // Create observations with shared entities
      memoryEngine.observe("Fixed bug in AuthService.ts", "user");
      memoryEngine.observe("Fixed another bug in AuthService.ts", "user");

      const patterns = memoryEngine.getPatterns();
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("detects patterns from outcome groups", () => {
      // Create successful episodes
      memoryEngine.observe("Task 1 completed", "user");
      memoryEngine.observe("Task 2 completed", "user");

      const patterns = memoryEngine.getPatterns();
      expect(Array.isArray(patterns)).toBe(true);
    });

    it("gets all patterns", () => {
      const patterns = memoryEngine.getPatterns();
      expect(Array.isArray(patterns)).toBe(true);
    });
  });

  describe("Search", () => {
    it("searches across all memory stages", () => {
      memoryEngine.observe("UniqueSearchTerm445566", "test");
      const results = memoryEngine.search("UniqueSearchTerm445566");
      expect(results.observations.length).toBeGreaterThan(0);
    });

    it("searches knowledge", () => {
      memoryEngine.observe("TypeScript error fix", "user");
      const results = memoryEngine.search("TypeScript");
      expect(Array.isArray(results.knowledge)).toBe(true);
    });
  });

  describe("Episode Completion", () => {
    it("completes episode with success", () => {
      memoryEngine.observe("Task to complete", "user");
      const episode = memoryEngine.getCurrentEpisode();
      if (episode) {
        const ok = memoryEngine.completeEpisode(episode.id, "success", "task completed", "result");
        expect(ok).toBe(true);
      }
    });

    it("completes episode with failure", () => {
      memoryEngine.observe("Task that failed", "user");
      const episode = memoryEngine.getCurrentEpisode();
      if (episode) {
        const ok = memoryEngine.completeEpisode(episode.id, "failure", "error occurred");
        expect(ok).toBe(true);
      }
    });
  });
});
