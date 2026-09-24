import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleAssistantReply } from '../src/response.ts'

test('delivery reply excludes provider thinking blocks and keeps final report', () => {
  assert.equal(visibleAssistantReply('<think>private</think>\n\nFinal report'), 'Final report')
  assert.equal(visibleAssistantReply('<think>one</think><think>two</think>Answer'), 'Answer')
  assert.equal(visibleAssistantReply('<analysis>partial'), '')
})
