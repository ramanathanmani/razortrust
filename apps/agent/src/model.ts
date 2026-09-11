/**
 * Model selection.
 *
 *   bedrock  -> Amazon Bedrock (the production default; uses the AWS credentials
 *               in the environment and STEWARD_BEDROCK_MODEL / AWS_REGION)
 *   scripted -> the deterministic ScriptedModel; zero credits, used for demos,
 *               CI, and offline development
 *
 * The model orchestrates. It never decides whether money moves, so swapping
 * the brain cannot widen the agent's authority — that lives in the signed
 * mandate and RazorTrust's deterministic engine.
 */
import type { Model } from '@strands-agents/sdk';

import { ScriptedModel } from './scripted-model.js';

export type ModelMode = 'bedrock' | 'scripted';

export function selectMode(explicit?: string): ModelMode {
  if (explicit === 'bedrock' || explicit === 'scripted') return explicit;
  return process.env.STEWARD_MODEL === 'bedrock' ? 'bedrock' : 'scripted';
}

export async function createModel(mode: ModelMode = selectMode()): Promise<Model> {
  if (mode === 'scripted') return new ScriptedModel();

  const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
  return new BedrockModel({
    modelId: process.env.STEWARD_BEDROCK_MODEL ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    region: process.env.AWS_REGION ?? 'us-east-1',
  });
}
