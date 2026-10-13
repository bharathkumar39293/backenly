/**
 * A mutation is not a verified turn merely because the model writes a final
 * sentence. These tests use runBrain (rather than runAgentLoop) so routing,
 * dispatch, and the loop's public result contract are exercised together.
 */

jest.mock('@/lib/ai/llm', () => ({
  aiAvailability: jest.fn(() => ({ available: true, provider: 'scripted' })),
  effectiveTokensOf: jest.fn(() => 0),
  generate: jest.fn(),
  AiError: class AiError extends Error {},
}))

jest.mock('@/lib/ai/brain/classifier', () => ({
  classify: jest.fn(async () => ({ intent: 'MODIFY', confidence: 1, reasoning: 'test' })),
}))

jest.mock('@/lib/ai/brain/memory', () => ({
  loadBrainMemory: jest.fn(async () => ({
    summary: '',
    history: [],
    understanding: { proof: { tables: ['accounts'], nothingBuilt: false } },
  })),
  formatUnderstanding: jest.fn(() => ''),
  formatRecentHistory: jest.fn(() => []),
  saveTurn: jest.fn(async () => {}),
}))

jest.mock('@/lib/ai/proof-system', () => ({
  collectProof: jest.fn(),
  formatProof: jest.fn(() => ''),
}))

jest.mock('@/lib/ai/brain/tools', () => ({
  BRAIN_MODEL_TOOLS: [],
  dispatchTool: jest.fn(),
  isDestructiveTool: jest.fn(() => false),
  isReadOnlyTool: jest.fn((name: string) => name === 'read_backend_state'),
  humanTitle: jest.fn((name: string) => name),
}))

jest.mock('@/lib/ai/blueprints', () => ({
  getBlueprintForPrompt: jest.fn(),
  isExplicitSpec: jest.fn(() => false),
}))

jest.mock('@/lib/ai/brain/build-signals', () => ({ looksLikeBuildDescription: jest.fn(() => false) }))
jest.mock('@/lib/ai/brain/resume-routing', () => ({ findOriginalBuildPrompt: jest.fn(() => null) }))
jest.mock('@/lib/ai/blueprints/store', () => ({
  savePendingPlan: jest.fn(), loadPendingPlan: jest.fn(async () => null), clearPendingPlan: jest.fn(),
  saveResumeQueue: jest.fn(), loadResumeQueue: jest.fn(async () => null), clearResumeQueue: jest.fn(),
}))
jest.mock('@/lib/ai/proposals/store', () => ({ getActiveProposal: jest.fn(async () => null) }))
jest.mock('@/lib/operational-memory/ledger', () => ({ recordToolExecutionMemory: jest.fn(async () => {}) }))
jest.mock('@/lib/mcp/domains', () => ({ needsApproval: jest.fn(() => false) }))

import { runBrain } from '@/lib/ai/brain/agent'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { generate } from '@/lib/ai/llm'

const mockDispatchTool = dispatchTool as jest.Mock
const mockGenerate = generate as jest.Mock

function reply(content: Array<Record<string, unknown>>, stop_reason: 'tool_use' | 'end_turn' = 'tool_use') {
  return { model: 'test-model', usage: {}, message: { content, stop_reason } } as any
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  return reply([{ type: 'tool_use', id, name, input: args }])
}

const input = { projectId: 'project-1', userId: 'user-1', message: 'Add an email column' }
const emit = jest.fn()

beforeEach(() => {
  mockGenerate.mockReset()
  mockDispatchTool.mockReset()
  emit.mockReset()
})

describe('post-mutation verification in the public brain loop', () => {
  it('does not accept plain text as success after a mutation before verification', async () => {
    mockGenerate
      .mockResolvedValueOnce(toolCall('mutation', 'add_column', { table: 'accounts', column: 'email' }))
      .mockResolvedValueOnce(reply([{ type: 'text', text: 'The column has been added.' }], 'end_turn'))
      .mockResolvedValueOnce(toolCall('verify', 'read_backend_state'))
      .mockResolvedValueOnce(toolCall('finish', 'finish', { summary: 'Verified: email column added.' }))
    mockDispatchTool.mockImplementation(async (name: string) => {
      if (name === 'add_column') return { ok: true, summary: 'Column added.' }
      if (name === 'read_backend_state') return { ok: true, summary: 'Column exists.' }
      return { ok: true, summary: 'Verified: email column added.', terminal: true }
    })

    const result = await runBrain(input, emit)

    expect(result.success).toBe(true)
    expect(result.summary).toBe('Verified: email column added.')
    expect(result.toolsRun).toEqual(['add_column', 'read_backend_state', 'finish'])
    expect(mockDispatchTool).toHaveBeenCalledTimes(3)
    expect(mockDispatchTool.mock.calls.filter(([name]) => name === 'add_column')).toHaveLength(1)
    expect(mockGenerate).toHaveBeenCalledTimes(4)
  })

  it('does not treat a failed verification read as proof after a mutation', async () => {
    mockGenerate
      .mockResolvedValueOnce(toolCall('mutation', 'add_column', { table: 'accounts', column: 'email' }))
      .mockResolvedValueOnce(reply([
          { type: 'tool_use', id: 'verify', name: 'read_backend_state', input: {} },
          // A later call in the same model batch must not replay the mutation
          // once the readback has failed.
          { type: 'tool_use', id: 'replay', name: 'add_column', input: { table: 'accounts', column: 'email' } },
        ]))
    mockDispatchTool.mockImplementation(async (name: string) => {
      if (name === 'add_column') return { ok: true, summary: 'Column added.' }
      if (name === 'read_backend_state') return { ok: false, summary: 'catalog connection reset' }
      return { ok: true, summary: 'Done.', terminal: true }
    })

    const result = await runBrain(input, emit)

    expect(result.success).toBe(false)
    expect(result.failureCode).toBe('UNVERIFIED')
    expect(result.retryable).toBe(false)
    expect(result.summary).toMatch(/could not verify the resulting state/i)
    expect(result.summary).not.toContain('catalog connection reset')
    expect(result.toolsRun).toEqual(['add_column', 'read_backend_state'])
    expect(mockDispatchTool.mock.calls.filter(([name]) => name === 'add_column')).toHaveLength(1)
    expect(mockGenerate).toHaveBeenCalledTimes(2)
  })
})
