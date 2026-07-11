import { Database } from "bun:sqlite";

export interface KnowledgeSource {
  id: string;
  title: string;
  domain: 'philosophy' | 'mathematics' | 'computer-science' | 'dictionary';
  subdomain: string;
  url: string;
  quality: number;
  storedAt: number;
}

export interface DictionaryEntry {
  word: string;
  pronunciation?: string;
  partOfSpeech: string;
  definitions: string[];
  examples?: string[];
  synonyms?: string[];
  antonyms?: string[];
  etymology?: string;
}

export interface CollectOptions {
  domain: string;
  subdomain?: string;
  maxSources?: number;
  qualityThreshold?: number;
  force?: boolean;
}

export interface CollectResult {
  domain: string;
  subdomain: string;
  searched: number;
  collected: number;
  skipped: number;
  failed: number;
  durationMs: number;
  sources: KnowledgeSource[];
}
