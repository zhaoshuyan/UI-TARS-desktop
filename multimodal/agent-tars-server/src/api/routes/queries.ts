/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import * as queriesController from '../controllers/queries';

/**
 * Register query execution routes
 * @param app Express application
 */
export function registerQueryRoutes(app: express.Application): void {
  // Send a query (non-streaming)
  app.post('/api/sessions/query', queriesController.executeQuery);

  // Send a streaming query
  app.post('/api/sessions/query/stream', queriesController.executeStreamingQuery);

  // Abort a running query
  app.post('/api/sessions/abort', queriesController.abortQuery);
}
