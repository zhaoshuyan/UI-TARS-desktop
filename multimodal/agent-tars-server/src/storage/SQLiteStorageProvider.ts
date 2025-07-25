/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { AgentEventStream } from '@agent-tars/core';
import { StorageProvider, SessionMetadata } from './types';

// Define row types for better type safety
interface SessionRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  name: string | null;
  workingDirectory: string;
  tags: string | null;
}

interface EventRow {
  id: number;
  sessionId: string;
  timestamp: number;
  eventData: string;
}

interface ExistsResult {
  existsFlag: number;
}

/**
 * SQLite-based storage provider using Node.js native SQLite
 * Provides high-performance, file-based storage using the built-in SQLite module
 * Optimized for handling large amounts of event data
 */
export class SQLiteStorageProvider implements StorageProvider {
  private db: DatabaseSync;
  private initialized = false;
  public readonly dbPath: string;

  constructor(storagePath?: string) {
    // Default to the user's home directory
    const defaultPath = process.env.HOME || process.env.USERPROFILE || '.';
    const baseDir = storagePath || path.join(defaultPath, '.agent-tars');

    // Create the directory if it doesn't exist
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    this.dbPath = path.join(baseDir, 'agent-tars.db');
    this.db = new DatabaseSync(this.dbPath, { open: false });
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      try {
        // Open the database
        this.db.open();

        // Enable WAL mode for better concurrent performance
        this.db.exec('PRAGMA journal_mode = WAL');

        // Create sessions table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL,
            name TEXT,
            workingDirectory TEXT NOT NULL,
            tags TEXT
          )
        `);

        // Create events table with foreign key to sessions
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sessionId TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            eventData TEXT NOT NULL,
            FOREIGN KEY (sessionId) REFERENCES sessions (id) ON DELETE CASCADE
          )
        `);

        // Create index on sessionId for faster queries
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events (sessionId)
        `);

        // Enable foreign keys
        this.db.exec('PRAGMA foreign_keys = ON');

        this.initialized = true;
      } catch (error) {
        console.error('Failed to initialize SQLite database:', error);
        throw error;
      }
    }
  }

  async createSession(metadata: SessionMetadata): Promise<SessionMetadata> {
    await this.ensureInitialized();

    const sessionData = {
      ...metadata,
      createdAt: metadata.createdAt || Date.now(),
      updatedAt: metadata.updatedAt || Date.now(),
    };

    const tagsJson = sessionData.tags ? JSON.stringify(sessionData.tags) : null;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (id, createdAt, updatedAt, name, workingDirectory, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        sessionData.id,
        sessionData.createdAt,
        sessionData.updatedAt,
        sessionData.name || null,
        sessionData.workingDirectory,
        tagsJson,
      );
      return sessionData;
    } catch (error) {
      console.error(`Failed to create session ${sessionData.id}:`, error);
      throw new Error(
        `Failed to create session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async updateSessionMetadata(
    sessionId: string,
    metadata: Partial<Omit<SessionMetadata, 'id'>>,
  ): Promise<SessionMetadata> {
    await this.ensureInitialized();

    // First, get the current session data
    const session = await this.getSessionMetadata(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const updatedSession = {
      ...session,
      ...metadata,
      updatedAt: Date.now(),
    };

    try {
      const params: Array<string | number | null> = [];
      const setClauses: string[] = [];

      if (metadata.name !== undefined) {
        setClauses.push('name = ?');
        params.push(metadata.name || null);
      }

      if (metadata.workingDirectory !== undefined) {
        setClauses.push('workingDirectory = ?');
        params.push(metadata.workingDirectory);
      }

      if (metadata.tags !== undefined) {
        setClauses.push('tags = ?');
        params.push(metadata.tags ? JSON.stringify(metadata.tags) : null);
      }

      // Always update the timestamp
      setClauses.push('updatedAt = ?');
      params.push(updatedSession.updatedAt);

      // Add the session ID for the WHERE clause
      params.push(sessionId);

      if (setClauses.length === 0) {
        return updatedSession; // Nothing to update
      }

      const updateQuery = `
        UPDATE sessions
        SET ${setClauses.join(', ')}
        WHERE id = ?
      `;

      const updateStmt = this.db.prepare(updateQuery);
      updateStmt.run(...params);

      return updatedSession;
    } catch (error) {
      console.error(`Failed to update session ${sessionId}:`, error);
      throw new Error(
        `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    await this.ensureInitialized();

    try {
      const stmt = this.db.prepare(`
        SELECT id, createdAt, updatedAt, name, workingDirectory, tags
        FROM sessions
        WHERE id = ?
      `);

      const row = stmt.get(sessionId) as SessionRow | undefined;

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        name: row.name || undefined,
        workingDirectory: row.workingDirectory,
        tags: row.tags ? JSON.parse(row.tags) : undefined,
      };
    } catch (error) {
      console.error(`Failed to get session ${sessionId}:`, error);
      throw new Error(
        `Failed to get session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getAllSessions(): Promise<SessionMetadata[]> {
    await this.ensureInitialized();

    try {
      const stmt = this.db.prepare(`
        SELECT id, createdAt, updatedAt, name, workingDirectory, tags
        FROM sessions
        ORDER BY updatedAt DESC
      `);

      const rows = stmt.all() as unknown as SessionRow[];

      return rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        name: row.name || undefined,
        workingDirectory: row.workingDirectory,
        tags: row.tags ? JSON.parse(row.tags) : undefined,
      }));
    } catch (error) {
      console.error('Failed to get all sessions:', error);
      throw new Error(
        `Failed to get all sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();

    try {
      // Delete events first (though the foreign key would handle this)
      const deleteEventsStmt = this.db.prepare('DELETE FROM events WHERE sessionId = ?');
      deleteEventsStmt.run(sessionId);

      // Delete the session
      const deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      const result = deleteSessionStmt.run(sessionId);

      return result.changes > 0;
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
      throw new Error(
        `Failed to delete session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async saveEvent(sessionId: string, event: AgentEventStream.Event): Promise<void> {
    await this.ensureInitialized();

    try {
      // Check if session exists
      const sessionExistsStmt = this.db.prepare(`
        SELECT 1 as existsFlag FROM sessions WHERE id = ?
      `);

      const sessionExists = sessionExistsStmt.get(sessionId) as ExistsResult | undefined;
      if (!sessionExists || !sessionExists.existsFlag) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const timestamp = Date.now();
      const eventData = JSON.stringify(event);

      // Insert the event
      const insertEventStmt = this.db.prepare(`
        INSERT INTO events (sessionId, timestamp, eventData)
        VALUES (?, ?, ?)
      `);

      insertEventStmt.run(sessionId, timestamp, eventData);

      // Update session's updatedAt timestamp
      const updateSessionStmt = this.db.prepare(`
        UPDATE sessions SET updatedAt = ? WHERE id = ?
      `);

      updateSessionStmt.run(timestamp, sessionId);
    } catch (error) {
      console.error(`Failed to save event for session ${sessionId}:`, error);
      throw new Error(
        `Failed to save event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getSessionEvents(sessionId: string): Promise<AgentEventStream.Event[]> {
    await this.ensureInitialized();

    try {
      const sessionExistsStmt = this.db.prepare(`
        SELECT 1 as existsFlag FROM sessions WHERE id = ?
      `);

      const sessionExists = sessionExistsStmt.get(sessionId) as ExistsResult | undefined;
      if (!sessionExists || !sessionExists.existsFlag) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const stmt = this.db.prepare(`
        SELECT eventData
        FROM events
        WHERE sessionId = ?
        ORDER BY timestamp ASC, id ASC
      `);

      const rows = stmt.all(sessionId) as unknown as { eventData: string }[];

      return rows.map((row) => {
        try {
          return JSON.parse(row.eventData) as AgentEventStream.Event;
        } catch (error) {
          console.error(`Failed to parse event data: ${row.eventData}`);
          return {
            type: 'system',
            message: 'Failed to parse event data',
            timestamp: Date.now(),
          } as AgentEventStream.Event;
        }
      });
    } catch (error) {
      console.error(`Failed to get events for session ${sessionId}:`, error);
      throw new Error(
        `Failed to get session events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.db && this.db.isOpen) {
      this.db.close();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}